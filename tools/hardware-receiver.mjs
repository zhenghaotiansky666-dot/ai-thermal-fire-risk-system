// 硬件接收端（ESP32-S3 火警探测器 → 电脑）端口 5000
//
// 对应硬件队友固件 src/main.cpp 里的两个上传点：
//   1) POST /upload          可见光 JPEG（Content-Type: image/jpeg，body 是原始 JPEG 字节）
//                            固件用 HTTPClient.getString() 比对返回文本，必须**恰好**是 "YES" 才确认火灾
//   2) POST /upload_thermal  热像数据（Content-Type: application/json）
//                            body: {"max_temp": 78.3, "sensor_data": [768 个浮点数]}
//
// 本服务做四件事：
//   · 收下两路数据并保存（内存 + 磁盘，便于写报告/复盘）
//   · 对可见光照片给出 YES / NO 终审（优先 YOLO 视觉服务；没有就用热像阈值兜底；都没有则保守返回 NO 并记日志）
//   · 把 32×24 温度矩阵渲染成 PNG 热像图，页面/系统端可以直接显示
//   · 提供 /latest、/latest.jpg、/thermal.png、/health、/log 给前端和调试用
//
// 用法：
//   node tools/hardware-receiver.mjs                    # 默认 0.0.0.0:5000
//   node tools/hardware-receiver.mjs --port 5000 --vision-url http://127.0.0.1:8000 --yes-temp 70

import { createServer } from 'node:http'
import { createServer as createProbeServer } from 'node:net'
import { mkdir, appendFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { deflateSync } from 'node:zlib'

const args = process.argv.slice(2)
const readArg = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const hasFlag = (name) => args.includes(name)

const port = Number(readArg('--port', '5000'))
const host = readArg('--host', '0.0.0.0')
const strictPort = hasFlag('--strict-port')
const visionUrl = String(readArg('--vision-url', process.env.TG_VISION_URL || '')).replace(/\/$/, '')
const visionConf = Number(readArg('--vision-conf', '0.5'))
const yesTemp = Number(readArg('--yes-temp', '70'))
const outDir = resolve(readArg('--out', 'output/hardware'))
const alwaysYes = hasFlag('--always-yes')
const keepFrames = Number(readArg('--keep', '20'))

const store = {
  visible: [],   // { at, bytes, contentType, jpeg: Buffer, decision, source }
  thermal: [],   // { at, maxTemp, matrix, png }
  log: [],       // 决策日志
}

// ---------------------------------------------------------------- 工具：PNG 编码（把温度矩阵画成热像图）
const crcTable = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])))
  return Buffer.concat([length, typeBuffer, data, crc])
}

export function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// 温度 → 颜色（与前端 thermal.js 的配色一致，视觉统一）
export function temperatureColor(value, min, max) {
  const t = Math.max(0, Math.min(1, (Number(value) - min) / Math.max(max - min, 0.001)))
  const stops = [
    [0, [7, 13, 30]],
    [0.24, [32, 28, 93]],
    [0.44, [125, 23, 84]],
    [0.62, [220, 38, 50]],
    [0.78, [249, 115, 22]],
    [0.9, [250, 204, 21]],
    [1, [255, 251, 220]],
  ]
  let left = stops[0]
  let right = stops[stops.length - 1]
  for (let index = 1; index < stops.length; index += 1) {
    if (t <= stops[index][0]) {
      left = stops[index - 1]
      right = stops[index]
      break
    }
  }
  const span = Math.max(right[0] - left[0], 0.001)
  const p = (t - left[0]) / span
  return left[1].map((channel, i) => Math.round(channel + (right[1][i] - channel) * p))
}

// 32×24 矩阵 → 放大 10 倍的 PNG（每个温度点一个方块）
export function renderThermalPng(matrix, width = 32, height = 24, scale = 10) {
  const values = matrix.map(Number).filter(Number.isFinite)
  if (values.length !== width * height) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const outW = width * scale
  const outH = height * scale
  const rgba = Buffer.alloc(outW * outH * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = temperatureColor(values[y * width + x], min, max)
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const index = ((y * scale + dy) * outW + (x * scale + dx)) * 4
          rgba[index] = r
          rgba[index + 1] = g
          rgba[index + 2] = b
          rgba[index + 3] = 255
        }
      }
    }
  }
  return encodePng(outW, outH, rgba)
}

// ---------------------------------------------------------------- 请求体解析（兼容固件与常见调试工具）
export function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '')
  const boundary = match?.[1] ?? match?.[2]
  if (!boundary) return null
  const delimiter = Buffer.from(`--${boundary}`)
  const parts = []
  let index = buffer.indexOf(delimiter)
  while (index >= 0) {
    const start = index + delimiter.length
    const next = buffer.indexOf(delimiter, start)
    if (next < 0) break
    const section = buffer.subarray(start, next)
    const headerEnd = section.indexOf('\r\n\r\n')
    if (headerEnd > 0) {
      const headers = section.subarray(0, headerEnd).toString('utf8')
      const body = section.subarray(headerEnd + 4, section.length - 2) // 去掉结尾 CRLF
      const name = /name="([^"]+)"/i.exec(headers)?.[1] ?? ''
      const type = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() ?? ''
      parts.push({ name, type, body })
    }
    index = next
  }
  return parts
}

export function extractImage(buffer, contentType) {
  const type = String(contentType ?? '').toLowerCase()
  if (type.includes('multipart/form-data')) {
    const parts = parseMultipart(buffer, contentType) ?? []
    const file = parts.find((part) => /image/i.test(part.type)) ?? parts.find((part) => part.name === 'file' || part.name === 'image') ?? parts[0]
    if (!file?.body?.length) return { ok: false, reason: 'multipart-no-file' }
    return { ok: true, jpeg: file.body, contentType: file.type || 'image/jpeg' }
  }
  if (type.includes('application/json')) {
    try {
      const parsed = JSON.parse(buffer.toString('utf8'))
      const dataUrl = String(parsed.image ?? parsed.jpeg ?? parsed.photo ?? '')
      const base64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl
      if (!base64) return { ok: false, reason: 'json-no-image' }
      return { ok: true, jpeg: Buffer.from(base64, 'base64'), contentType: 'image/jpeg' }
    } catch {
      return { ok: false, reason: 'json-parse-failed' }
    }
  }
  // 固件就是这条路径：Content-Type: image/jpeg + 原始字节
  if (buffer.length < 100) return { ok: false, reason: 'body-too-small' }
  const looksJpeg = buffer[0] === 0xff && buffer[1] === 0xd8
  return { ok: true, jpeg: buffer, contentType: looksJpeg ? 'image/jpeg' : (type || 'application/octet-stream') }
}

export function parseThermalPayload(buffer, contentType) {
  const text = buffer.toString('utf8')
  const type = String(contentType ?? '').toLowerCase()
  if (type.includes('multipart/form-data')) {
    const parts = parseMultipart(buffer, contentType) ?? []
    const jsonPart = parts.find((part) => /json/i.test(part.type) || part.name === 'data' || part.name === 'thermal')
    if (!jsonPart) return { ok: false, reason: 'multipart-no-json' }
    return parseThermalPayload(jsonPart.body, jsonPart.type || 'application/json')
  }
  try {
    const parsed = JSON.parse(text)
    const matrix = parsed.sensor_data ?? parsed.matrix ?? parsed.temperatures ?? parsed.data
    if (!Array.isArray(matrix)) return { ok: false, reason: 'no-matrix' }
    if (matrix.length !== 768 && matrix.length !== 32 * 24) {
      return { ok: false, reason: `matrix-size-${matrix.length}` }
    }
    const numbers = matrix.map(Number)
    if (numbers.some((value) => !Number.isFinite(value))) return { ok: false, reason: 'matrix-not-numeric' }
    const maxTemp = Number.isFinite(Number(parsed.max_temp)) ? Number(parsed.max_temp) : Math.max(...numbers)
    return { ok: true, matrix: numbers, maxTemp }
  } catch {
    return { ok: false, reason: 'json-parse-failed' }
  }
}

// ---------------------------------------------------------------- 终审决策
// 返回 "YES" / "NO"，同时给出依据，写进日志
export async function decideFire({ jpegBuffer, thermal }) {
  if (alwaysYes) return { answer: 'YES', source: 'force', reason: '启动时指定了 --always-yes（演示用）' }

  if (visionUrl && jpegBuffer) {
    try {
      const response = await fetch(`${visionUrl}/detect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`, conf: visionConf }),
        signal: AbortSignal.timeout(6000),
      })
      if (response.ok) {
        const payload = await response.json().catch(() => ({}))
        const flame = Number(payload.flame ?? payload.fire ?? 0)
        const smoke = Number(payload.smoke ?? 0)
        const hit = flame >= visionConf || (flame >= 0.6 && smoke >= 0.5)
        return {
          answer: hit ? 'YES' : 'NO',
          source: 'yolo',
          reason: `视觉：火焰 ${(flame * 100).toFixed(0)}% · 烟雾 ${(smoke * 100).toFixed(0)}%（阈值 ${(visionConf * 100).toFixed(0)}%）`,
        }
      }
    } catch (error) {
      // 视觉服务不可用时继续往下走热像兜底，不抛错
    }
  }

  if (thermal && Date.now() - thermal.at < 30000) {
    const hit = thermal.maxTemp >= yesTemp
    return {
      answer: hit ? 'YES' : 'NO',
      source: 'thermal',
      reason: `热像最高温 ${thermal.maxTemp.toFixed(1)}°C（阈值 ${yesTemp}°C）`,
    }
  }

  return {
    answer: 'NO',
    source: 'fallback',
    reason: visionUrl ? '视觉服务不可用且没有新的热像数据，保守返回 NO，请人工确认' : '未配置视觉服务且没有热像数据，保守返回 NO；可加 --vision-url 或 --yes-temp',
  }
}

// ---------------------------------------------------------------- HTTP 服务
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
}

const json = (response, status, body) => {
  response.writeHead(status, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(body))
}

const text = (response, status, body, type = 'text/plain; charset=utf-8') => {
  response.writeHead(status, { ...cors, 'Content-Type': type, 'Cache-Control': 'no-store' })
  response.end(body)
}

function pushLog(entry) {
  store.log.unshift(entry)
  if (store.log.length > 60) store.log.length = 60
  appendFile(resolve(outDir, 'decisions.jsonl'), `${JSON.stringify(entry)}\n`).catch(() => {})
}

async function readBody(request, limitBytes = 8 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limitBytes) throw new Error('body-too-large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" /><title>硬件接收端 · 热感哨兵</title>
<style>body{margin:0;background:#06101f;color:#f3f8ff;font:14px/1.7 -apple-system,"PingFang SC",sans-serif}
main{width:min(900px,calc(100% - 32px));margin:0 auto;padding:28px 0 60px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media(max-width:680px){.grid{grid-template-columns:1fr}}
.card{padding:16px;border:1px solid rgba(96,165,250,.22);border-radius:16px;background:linear-gradient(145deg,rgba(21,38,64,.9),rgba(7,16,31,.92))}
img{width:100%;border-radius:12px;background:#000;display:block}
h1{font-size:22px;margin:0 0 6px}p{color:#8ea5c2;font-size:13px}
code{color:#9ad6ff}ul{list-style:none;padding:0;margin:10px 0 0;display:flex;flex-direction:column;gap:6px}
li{padding:9px 11px;border-radius:10px;background:rgba(4,13,27,.6);border:1px solid rgba(96,165,250,.16);font-size:12px}
.yes{color:#8fe8b3}.no{color:#ffb4a8}</style></head><body><main>
<h1>硬件接收端（端口 5000）</h1>
<p>ESP32-S3 通过 Wi-Fi 把可见光照片发到 <code>POST /upload</code>、把 768 点温度矩阵发到 <code>POST /upload_thermal</code>。</p>
<div class="grid">
  <section class="card"><strong>可见光（/upload）</strong><img id="vis" alt="等待照片" />
  <p id="visMeta">等待数据…</p></section>
  <section class="card"><strong>热像（/upload_thermal）</strong><img id="th" alt="等待热像" />
  <p id="thMeta">等待数据…</p></section>
</div>
<section class="card" style="margin-top:14px"><strong>终审记录</strong><ul id="log"></ul></section>
<script>
async function tick(){
  try{
    const r = await fetch('./latest', { cache:'no-store' }); const data = await r.json();
    if(data.visible){ document.getElementById('vis').src = './latest.jpg?t=' + data.visible.at; document.getElementById('visMeta').textContent =
      new Date(data.visible.at).toLocaleTimeString('zh-CN') + ' · ' + Math.round(data.visible.bytes/1024) + ' KB · 终审 ' + data.visible.decision + '（' + data.visible.source + '）'; }
    if(data.thermal){ document.getElementById('th').src = './thermal.png?t=' + data.thermal.at; document.getElementById('thMeta').textContent =
      new Date(data.thermal.at).toLocaleTimeString('zh-CN') + ' · 最高 ' + data.thermal.maxTemp.toFixed(1) + '°C'; }
    const log = document.getElementById('log'); log.innerHTML = (data.log||[]).slice(0,8).map(e =>
      '<li><span class="' + (e.answer==='YES'?'yes':'no') + '">' + e.answer + '</span> · ' + new Date(e.at).toLocaleTimeString('zh-CN') + ' · ' + e.source + ' · ' + e.reason + '</li>').join('');
  }catch(e){}
}
tick(); setInterval(tick, 2000);
</script></main></body></html>`

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`)
  if (request.method === 'OPTIONS') {
    response.writeHead(204, cors)
    response.end()
    return
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    text(response, 200, PAGE, 'text/html; charset=utf-8')
    return
  }

  if (url.pathname === '/health') {
    json(response, 200, {
      ok: true,
      port: activePort,
      routes: ['POST /upload', 'POST /upload_thermal', 'GET /latest', 'GET /latest.jpg', 'GET /thermal.png', 'GET /log'],
      visionUrl: visionUrl || null,
      yesTemp,
      frames: { visible: store.visible.length, thermal: store.thermal.length },
    })
    return
  }

  // 固件的可见光上传：原始 JPEG 字节，返回必须恰好是 YES / NO
  if (url.pathname === '/upload' && request.method === 'POST') {
    try {
      const body = await readBody(request)
      const parsed = extractImage(body, request.headers['content-type'])
      if (!parsed.ok) {
        pushLog({ at: Date.now(), answer: 'NO', source: 'error', reason: parsed.reason })
        text(response, 400, 'NO')
        return
      }
      const latestThermal = store.thermal[0] ?? null
      const decision = await decideFire({ jpegBuffer: parsed.jpeg, thermal: latestThermal })
      const record = {
        at: Date.now(),
        bytes: parsed.jpeg.length,
        contentType: parsed.contentType,
        decision: decision.answer,
        source: decision.source,
        reason: decision.reason,
      }
      store.visible.unshift({ ...record, jpeg: parsed.jpeg })
      if (store.visible.length > keepFrames) store.visible.length = keepFrames
      await writeFile(resolve(outDir, 'latest.jpg'), parsed.jpeg).catch(() => {})
      pushLog(record)
      console.log(`[upload] ${(parsed.jpeg.length / 1024).toFixed(1)} KB → ${decision.answer}（${decision.source}：${decision.reason}）`)
      // 固件用 HTTPClient.getString() 和 "YES" 做字符串比较，所以这里必须返回恰好这两个字母
      text(response, 200, decision.answer)
      return
    } catch (error) {
      text(response, 500, 'NO')
      console.error('[upload] 处理失败：', error.message)
      return
    }
  }

  // 固件的热像上传：JSON {max_temp, sensor_data:[768]}
  if (url.pathname === '/upload_thermal' && request.method === 'POST') {
    try {
      const body = await readBody(request)
      const parsed = parseThermalPayload(body, request.headers['content-type'])
      if (!parsed.ok) {
        json(response, 400, { ok: false, error: parsed.reason })
        return
      }
      const png = renderThermalPng(parsed.matrix)
      const record = { at: Date.now(), maxTemp: parsed.maxTemp, matrix: parsed.matrix, png }
      store.thermal.unshift(record)
      if (store.thermal.length > keepFrames) store.thermal.length = keepFrames
      await writeFile(resolve(outDir, 'latest-thermal.json'), JSON.stringify({ at: record.at, max_temp: parsed.maxTemp, sensor_data: parsed.matrix })).catch(() => {})
      if (png) await writeFile(resolve(outDir, 'latest-thermal.png'), png).catch(() => {})
      pushLog({ at: record.at, answer: 'DATA', source: 'thermal-upload', reason: `最高温 ${parsed.maxTemp.toFixed(1)}°C，${parsed.matrix.length} 个温度点` })
      console.log(`[upload_thermal] 最高温 ${parsed.maxTemp.toFixed(1)}°C，矩阵 ${parsed.matrix.length} 点`)
      json(response, 200, { ok: true, max_temp: parsed.maxTemp, points: parsed.matrix.length })
      return
    } catch (error) {
      json(response, 500, { ok: false, error: String(error.message) })
      return
    }
  }

  if (url.pathname === '/latest') {
    const visible = store.visible[0]
    const thermal = store.thermal[0]
    json(response, 200, {
      ok: true,
      visible: visible ? { at: visible.at, bytes: visible.bytes, decision: visible.decision, source: visible.source, reason: visible.reason } : null,
      thermal: thermal ? { at: thermal.at, maxTemp: thermal.maxTemp, points: thermal.matrix.length } : null,
      log: store.log.slice(0, 12),
      visionUrl: visionUrl || null,
      yesTemp,
    })
    return
  }

  if (url.pathname === '/latest.jpg') {
    const visible = store.visible[0]
    if (!visible) {
      text(response, 404, 'no-frame')
      return
    }
    response.writeHead(200, { ...cors, 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' })
    response.end(visible.jpeg)
    return
  }

  if (url.pathname === '/thermal.png') {
    const thermal = store.thermal[0]
    if (!thermal?.png) {
      text(response, 404, 'no-frame')
      return
    }
    response.writeHead(200, { ...cors, 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
    response.end(thermal.png)
    return
  }

  if (url.pathname === '/thermal.json') {
    const thermal = store.thermal[0]
    if (!thermal) {
      json(response, 404, { ok: false, error: 'no-frame' })
      return
    }
    json(response, 200, { ok: true, at: thermal.at, max_temp: thermal.maxTemp, sensor_data: thermal.matrix })
    return
  }

  if (url.pathname === '/log') {
    json(response, 200, { ok: true, log: store.log })
    return
  }

  json(response, 404, { ok: false, error: 'not-found', routes: ['POST /upload', 'POST /upload_thermal', 'GET /latest'] })
})

await mkdir(outDir, { recursive: true }).catch(() => {})

// macOS 的 AirPlay 接收器默认占用 5000，这里自动避让并说清楚怎么处理
let activePort = port

function isPortFree(candidate) {
  return new Promise((done) => {
    const probe = createProbeServer()
    probe.once('error', () => done(false))
    probe.once('listening', () => probe.close(() => done(true)))
    probe.listen(candidate, host)
  })
}

async function pickPort(start) {
  if (await isPortFree(start)) return start
  if (strictPort) return start
  if (start === 5000 && process.platform === 'darwin') {
    console.warn('⚠️ 端口 5000 被占用（macOS 上通常是系统的「隔空播放接收器」）。')
    console.warn('   两种做法：① 系统设置 → 通用 → 隔空投送与接力 → 关闭「隔空播放接收器」，再重启本服务；')
    console.warn('            ② 用下面的端口，并把固件里 serverUrl / thermalServerUrl 的端口一起改掉。')
  } else {
    console.warn(`⚠️ 端口 ${start} 被占用，自动往后找空闲端口…`)
  }
  for (let candidate = start + 1; candidate <= start + 8; candidate += 1) {
    if (await isPortFree(candidate)) return candidate
  }
  return start
}

function printBanner() {
  console.log(`硬件接收端已启动：http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${activePort}`)
  console.log(`  可见光上传：POST http://<本机IP>:${activePort}/upload        （固件 serverUrl）`)
  console.log(`  热像上传：  POST http://<本机IP>:${activePort}/upload_thermal （固件 thermalServerUrl）`)
  console.log(`  观察页面：  http://127.0.0.1:${activePort}/`)
  console.log(`  终审策略：  ${visionUrl ? `YOLO 视觉服务 ${visionUrl}（阈值 ${visionConf}）` : `热像阈值 ${yesTemp}°C`}${alwaysYes ? ' · 强制 YES（演示）' : ''}`)
  console.log(`  落盘目录：  ${outDir}`)
  if (activePort !== port) {
    console.log('')
    console.log(`⚠️ 实际端口是 ${activePort}（不是 ${port}）：固件里 serverUrl / thermalServerUrl 的端口要一并改成 ${activePort}`)
    console.log(`   例如：const char* serverUrl = "http://<电脑IP>:${activePort}/upload";`)
    console.log(`         const char* thermalServerUrl = "http://<电脑IP>:${activePort}/upload_thermal";`)
  }
}

// 只有直接运行本文件时才启动服务；被测试/其它脚本 import 时不占端口
const isCli = process.argv[1] && process.argv[1].endsWith('hardware-receiver.mjs')
if (isCli) {
  activePort = await pickPort(port)
  server.on('error', (error) => {
    console.error(`端口 ${activePort} 无法监听：${error.message}`)
    process.exit(1)
  })
  server.listen(activePort, host, printBanner)
}
