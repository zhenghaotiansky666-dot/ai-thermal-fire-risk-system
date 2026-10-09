// 硬件接收端（ESP32-S3 火警探测器 → 电脑）
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
//   node tools/hardware-receiver.mjs                    # 默认 0.0.0.0:8787
//   node tools/hardware-receiver.mjs --port 8787 --vision-url http://127.0.0.1:8000 --yes-temp 70

import { createServer } from 'node:http'
import { createServer as createProbeServer } from 'node:net'
import { mkdir, appendFile, writeFile, readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { networkInterfaces } from 'node:os'

// 所有非回环 IPv4，带上网卡名（网线接入时要挑"有线那张网卡"的地址给固件）
// 169.254.x.x 是自己编的地址（没拿到 DHCP），不能写进固件，这里排除掉
function lanInterfaces() {
  const out = []
  const interfaces = networkInterfaces()
  for (const [name, list] of Object.entries(interfaces)) {
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.')) {
        out.push({ name, address: item.address })
      }
    }
  }
  return out
}

// 连 169.254 也带上：用来判断"网线插了、但对面没给 IP"
function physicalInterfaces() {
  const out = []
  const interfaces = networkInterfaces()
  for (const [name, list] of Object.entries(interfaces)) {
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && !item.internal) out.push({ name, address: item.address })
    }
  }
  return out
}

// 纯函数：解析 macOS `ifconfig <网卡>` 的载波状态
//   status: active + media 不是 (none) 才算真的插好并连通
export function parseCarrier(text = '') {
  const status = /status:\s*(\w+)/.exec(String(text))?.[1] ?? ''
  const media = /media:\s*([^\n]+)/.exec(String(text))?.[1]?.trim() ?? ''
  return {
    status,
    media,
    // 只有 active 且不是 (none) 才算有载波；这种才是"网线真的通"
    carrier: status === 'active' && media !== '' && media !== 'none' && !/\(none\)/.test(media),
  }
}

// 纯函数：把网卡列表收拾成前端能显示的样子
export function describeLinks(entries = [], portKinds = {}, probe = () => '') {
  return entries.map((entry) => {
    const known = portKinds[entry.name]
    const kind = known === 'wired' || known === 'wireless' ? known
      : /^eth|^enx|^usb/i.test(entry.name) ? 'wired'
        : /^wl/i.test(entry.name) ? 'wireless' : 'unknown'
    const carrier = parseCarrier(probe(entry.name))
    const linkLocal = /^169\.254\./.test(String(entry.address ?? ''))
    // 169.254 是自己编的地址：网线插了但对面没给 IP，一样不能用来通信
    const usable = carrier.carrier && !linkLocal
    return { name: entry.name, address: entry.address, kind, ...carrier, usable }
  })
}

function readLinkText(name) {
  try {
    return execFileSync('ifconfig', [name], { encoding: 'utf8', timeout: 2000 })
  } catch {
    return ''
  }
}

// 把"这台电脑现在有几条链路、通没通"整成一份给界面看的快照。
// 连没有 IP 的网卡也列出来（网线插了但对面没给地址的情况），前端才能说清"为什么没通"。
// 每次都要跑 ifconfig，加个 3 秒缓存，页面轮询不会把 CPU 拖起来。
let linkCache = { at: 0, value: null }
function linkStatus() {
  const now = Date.now()
  if (linkCache.value && now - linkCache.at < 3000) return linkCache.value
  const kinds = hardwarePortKinds()
  const links = describeLinks(physicalInterfaces(), kinds, readLinkText)
  for (const [name, kind] of Object.entries(kinds)) {
    if (links.some((item) => item.name === name)) continue
    const carrier = parseCarrier(readLinkText(name))
    if (!carrier.status && !carrier.media) continue // 这张网卡不存在
    links.push({ name, address: null, kind, ...carrier, usable: false })
  }
  const value = {
    links,
    wired: links.find((item) => item.kind === 'wired') ?? null,
    wireless: links.find((item) => item.kind === 'wireless') ?? null,
  }
  linkCache = { at: now, value }
  return value
}

function lanAddresses() {
  return lanInterfaces().map((item) => item.address)
}

// macOS 上用 networksetup 拿到"网卡名 → 硬件端口类型"的权威映射；
// 其它平台拿不到就退回按名字猜。这个映射只用于"打印给固件的地址选哪一个"。
export function hardwarePortKinds() {
  if (process.platform !== 'darwin') return {}
  try {
    const text = execFileSync('networksetup', ['-listallhardwareports'], { encoding: 'utf8', timeout: 3000 })
    const kinds = {}
    const blocks = text.split(/\n(?=Hardware Port:)/)
    for (const block of blocks) {
      const port = /Hardware Port:\s*(.+)/.exec(block)?.[1]?.trim() ?? ''
      const device = /Device:\s*(\S+)/.exec(block)?.[1]?.trim() ?? ''
      if (!device) continue
      if (/wi-?fi|airport|无线/i.test(port)) kinds[device] = 'wireless'
      // 有线：除了常见叫法，还要认 USB 网卡芯片名（扩展坞里常见 AX88179A / RTL8153 / ASIX 等）
      else if (/ethernet|雷雳|thunderbolt|usb|lan|ax88|asix|rtl81|realtek/i.test(port)) kinds[device] = 'wired'
      else kinds[device] = 'other'
    }
    return kinds
  } catch {
    return {}
  }
}

// 纯函数：把 {name,address} 列表分类成 wired / wireless / unknown（便于单测）
export function classifyLanInterfaces(entries = [], portKinds = {}) {
  return entries.map((entry) => {
    const known = portKinds[entry.name]
    let kind = 'unknown'
    if (known === 'wired') kind = 'wired'
    else if (known === 'wireless') kind = 'wireless'
    else if (/^eth|^enx|^usb/i.test(entry.name)) kind = 'wired'
    else if (/^wl/i.test(entry.name)) kind = 'wireless'
    return { ...entry, kind }
  })
}

// 纯函数：挑选要写进固件的地址
//   优先级：--interface 指定 > --medium 指定（ethernet/wifi）> 有线的第一张 > 未知的第一张 > 第一张
export function pickInterface(entries = [], { prefer = '', medium = '' } = {}) {
  if (!entries.length) return null
  if (prefer) {
    const exact = entries.find((item) => item.name === prefer)
    if (exact) return exact
  }
  if (medium === 'ethernet' || medium === 'wired') {
    return entries.find((item) => item.kind === 'wired') ?? entries[0]
  }
  if (medium === 'wifi' || medium === 'wireless') {
    return entries.find((item) => item.kind === 'wireless') ?? entries[0]
  }
  return entries.find((item) => item.kind === 'wired')
    ?? entries.find((item) => item.kind === 'unknown')
    ?? entries[0]
}

const args = process.argv.slice(2)
const readArg = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const hasFlag = (name) => args.includes(name)

// 全平台统一 8787：macOS 的 5000 被系统「隔空播放接收器」占用，Windows 用 8787 也不冲突，
// 团队只记一个端口，固件两行地址也跟着是 8787。
export const DEFAULT_HARDWARE_PORT = 8787

// 端口优先级：--port 参数 > 环境变量 TG_HARDWARE_PORT > ai-config.json 的 hardwarePort > 平台默认
// 这样"演示电脑用哪个端口"可以在配置文件里统一，固件那边只改一次。
function portFromConfig() {
  for (const candidate of ['public/ai-config.json', 'ai-config.json']) {
    try {
      const config = JSON.parse(readFileSync(candidate, 'utf8'))
      if (Number.isFinite(Number(config.hardwarePort))) return Number(config.hardwarePort)
    } catch {}
  }
  return null
}
// --port 支持逗号列表（例如 --port 8787,5011）：固件可能被烧成别的端口，
// 同时听几个端口就不用为了换个端口去重烧固件。
function parsePorts(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0 && item < 65536)
}
const portsFromArgs = args.includes('--port') ? parsePorts(readArg('--port', String(DEFAULT_HARDWARE_PORT))) : []
const portFromArgs = portsFromArgs[0] ?? null
const extraPorts = portsFromArgs.slice(1)
const port = portFromArgs
  ?? (Number.isFinite(Number(process.env.TG_HARDWARE_PORT)) ? Number(process.env.TG_HARDWARE_PORT) : null)
  ?? portFromConfig()
  ?? DEFAULT_HARDWARE_PORT
const host = readArg('--host', '0.0.0.0')
const strictPort = hasFlag('--strict-port')
const visionUrl = String(readArg('--vision-url', process.env.TG_VISION_URL || '')).replace(/\/$/, '')
const visionConf = Number(readArg('--vision-conf', '0.5'))
// 终审阈值优先级：--yes-temp 参数 > 环境变量 TG_YES_TEMP > ai-config.json 的 yesTemp > 70
// 注意：这和固件里的"发送触发阈值"（烟雾>200 或 温度>32）是两回事——
// 固件那个决定"什么时候发数据"，这个决定"收到之后回 YES 还是 NO"。
function yesTempFromConfig() {
  for (const candidate of ['public/ai-config.json', 'ai-config.json']) {
    try {
      const config = JSON.parse(readFileSync(candidate, 'utf8'))
      if (Number.isFinite(Number(config.yesTemp))) return Number(config.yesTemp)
    } catch {}
  }
  return null
}
const yesTemp = Number(readArg('--yes-temp',
  Number.isFinite(Number(process.env.TG_YES_TEMP)) ? process.env.TG_YES_TEMP
    : (yesTempFromConfig() ?? 70)))
// 导出实际生效的终审阈值：测试和被其它脚本引用时不用再猜
export const YES_TEMP = yesTemp
const outDir = resolve(readArg('--out', 'output/hardware'))
const alwaysYes = hasFlag('--always-yes')
const keepFrames = Number(readArg('--keep', '20'))
const printFirmware = hasFlag('--print-firmware')
// 诊断用：把每一条 TCP 连接的原始字节数打出来（分清"连上了但没发数据"和"发了但服务没解析"）
const logConnections = hasFlag('--log-connections')
// 网线接入：指定用哪张网卡的地址写进固件（不指定就自动挑有线那张）
const preferInterface = readArg('--interface', '')
const medium = readArg('--medium', '')
// 确认火情后把事件广播出去，让用户端一起反应
const publishUrl = readArg('--publish-url', process.env.TG_PUBLISH_URL || 'http://127.0.0.1:4173/sync/publish')
const publishChannel = readArg('--publish-channel', process.env.TG_PUBLISH_CHANNEL || '')
const nodeId = readArg('--node', process.env.TG_NODE_ID || 'C4')
const nodeFloor = Number(readArg('--floor', process.env.TG_NODE_FLOOR || '4'))
// 现场"路过的人也能知道"：确认火灾后用这台电脑的扬声器播报（零安装、不需要网络）
const speak = !hasFlag('--no-speak')
const speakRepeatSec = Number(readArg('--speak-repeat', '20'))
const speakCommandOverride = readArg('--speak-cmd', '')

// ---------------------------------------------------------------- 语音播报（把电脑扬声器当现场广播）
export function pickTtsCommand(platform, text, override = '') {
  if (override) return { cmd: override, args: [text] }
  if (platform === 'darwin') return { cmd: 'say', args: ['-v', 'Ting-Ting', text] }
  if (platform === 'win32') {
    return {
      cmd: 'powershell',
      args: ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${text.replace(/'/g, "''")}')`],
    }
  }
  return { cmd: 'espeak', args: [text] }
}

export function buildAlertPhrase({ maxTemp, smoke, repeat = false } = {}) {
  const where = Number.isFinite(Number(maxTemp)) ? `最高温度 ${Math.round(maxTemp)} 度` : '检测到异常热源'
  if (repeat) return `这里仍然有火情，${where}，请尽快离开。`
  return `注意，这里发生火灾，${where}，请立即沿安全出口撤离，不要乘坐电梯。`
}

// 硬件火情事件（结构与系统端一致，两端都能直接消费）
export function buildHardwareFireEvent({ nodeId: id = 'C4', floor = 4, maxTemp, smoke, at = Date.now(), source = '硬件节点' } = {}) {
  // 注意 null 会被 Number() 变成 0，必须显式排除，否则会报"最高温度 0 度"
  const numeric = (value) => (value === null || value === undefined || value === '' ? null : (Number.isFinite(Number(value)) ? Number(value) : null))
  const temp = numeric(maxTemp)
  const smokeValue = numeric(smoke)
  return {
    v: 1,
    id: `fire-hw-${at.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    kind: 'fire',
    at,
    ttl: 30 * 60 * 1000,
    from: 'hardware',
    payload: {
      nodeId: id,
      floor: Number(floor) || null,
      startedAt: at,
      mode: 'live',
      maxTemp: temp,
      smoke: smokeValue,
      notice: `${source}确认火情${temp ? `，最高温度 ${Math.round(temp)} 度` : ''}，请立即沿安全出口撤离`,
    },
  }
}

async function publishFireEvent({ maxTemp, smoke }) {
  const event = buildHardwareFireEvent({ nodeId, floor: nodeFloor, maxTemp, smoke })
  const tasks = []
  if (publishUrl) {
    tasks.push(fetch(publishUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    }).then((response) => response.ok).catch(() => false))
  }
  if (publishChannel) {
    const topic = publishChannel.startsWith('ntfy:') ? publishChannel.slice(5) : publishChannel
    tasks.push(fetch(`https://ntfy.sh/${topic}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    }).then((response) => response.ok).catch(() => false))
  }
  const results = await Promise.all(tasks)
  const ok = results.some(Boolean)
  console.log(`[publish] 硬件火情事件广播：${ok ? '成功' : '失败'}（${ok ? '' : '检查 --publish-url / --publish-channel'}）`)
  return ok
}

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

  // 视觉终审（队友训练的 YOLOv8 best.pt）：火焰/烟雾置信度
  let vision = null
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
        vision = {
          hit,
          reason: `视觉：火焰 ${(flame * 100).toFixed(0)}% · 烟雾 ${(smoke * 100).toFixed(0)}%（阈值 ${(visionConf * 100).toFixed(0)}%）`,
        }
      }
    } catch (error) {
      // 视觉服务不可用时继续走热像兜底，不抛错
    }
  }

  // 两路独立证据，**任一命中即报警**（安全优先）：
  //   · 视觉看到明火/浓烟 → YES（火源离热像节点远、面积小时也不会漏）
  //   · 热像超过阈值       → YES（镜头被浓烟挡住、或火在盲区时也不会漏）
  // 这样任一路失效都还有另一路兜底，而"两路都没命中"才返回 NO。
  if (vision?.hit) {
    return { answer: 'YES', source: 'yolo', reason: vision.reason }
  }

  const freshThermal = thermal && Date.now() - thermal.at < 30000
  if (freshThermal && thermal.maxTemp >= yesTemp) {
    return {
      answer: 'YES',
      source: 'thermal',
      reason: `热像最高温 ${thermal.maxTemp.toFixed(1)}°C（阈值 ${yesTemp}°C）${vision ? '；视觉本轮未发现明火' : ''}`,
    }
  }

  if (vision) {
    return { answer: 'NO', source: 'yolo', reason: `${vision.reason}；热像未超阈值，判定无火情` }
  }
  if (freshThermal) {
    return { answer: 'NO', source: 'thermal', reason: `热像最高温 ${thermal.maxTemp.toFixed(1)}°C（阈值 ${yesTemp}°C）` }
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

// 播报节流：第一次立刻播，之后每 speakRepeatSec 秒重复一次（火灾持续期间持续提醒）
let lastSpokenAt = 0
let spokenCount = 0
export function shouldSpeak(now, lastAt, repeatMs) {
  if (!lastAt) return true
  return now - lastAt >= repeatMs
}

function speakAlert({ maxTemp, smoke }) {
  if (!speak) return
  const now = Date.now()
  if (!shouldSpeak(now, lastSpokenAt, speakRepeatSec * 1000)) return
  const repeat = spokenCount > 0
  const phrase = buildAlertPhrase({ maxTemp, smoke, repeat })
  const { cmd, args } = pickTtsCommand(process.platform, phrase, speakCommandOverride)
  lastSpokenAt = now
  spokenCount += 1
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
    console.log(`[alert-speak] 现场播报：${phrase}`)
  } catch (error) {
    console.warn(`[alert-speak] 播报失败：${error.message}`)
  }
}

// 上传方的地址：用于判断这一帧是走 Wi-Fi 还是走网线进来的（有线网段一眼能看出来）
export function clientAddress(request) {
  const raw = String(request?.socket?.remoteAddress ?? '').trim()
  if (!raw) return 'unknown'
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw
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
<meta name="viewport" content="width=device-width,initial-scale=1" /><title>硬件接收端 · FireAegis</title>
<style>body{margin:0;background:#06101f;color:#f3f8ff;font:14px/1.7 -apple-system,"PingFang SC",sans-serif}
main{width:min(900px,calc(100% - 32px));margin:0 auto;padding:28px 0 60px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media(max-width:680px){.grid{grid-template-columns:1fr}}
.card{padding:16px;border:1px solid rgba(96,165,250,.22);border-radius:16px;background:linear-gradient(145deg,rgba(21,38,64,.9),rgba(7,16,31,.92))}
img{width:100%;border-radius:12px;background:#000;display:block}
h1{font-size:22px;margin:0 0 6px}p{color:#8ea5c2;font-size:13px}
code{color:#9ad6ff}ul{list-style:none;padding:0;margin:10px 0 0;display:flex;flex-direction:column;gap:6px}
li{padding:9px 11px;border-radius:10px;background:rgba(4,13,27,.6);border:1px solid rgba(96,165,250,.16);font-size:12px}
.yes{color:#8fe8b3}.no{color:#ffb4a8}</style></head><body><main>
<h1>硬件接收端（端口 <span id="port">—</span>）</h1>
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
    document.getElementById('port').textContent = location.port || (location.protocol === 'https:' ? '443' : '80');
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

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`)
  // 每一条进来的请求都打一行：板子有没有连上、连到哪个端口、发的什么，一眼可见
  const from = clientAddress(request)
  if (request.method !== 'OPTIONS' && url.pathname !== '/') {
    console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${request.method} ${url.pathname} ← ${from}`)
  }
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
      // 给界面用：这台电脑有哪几条链路、网线插没插好、地址是多少
      ...linkStatus(),
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
        // 记下这张图是从哪个地址来的：网线接入时这里会显示有线网段的 IP
        from: clientAddress(request),
      }
      store.visible.unshift({ ...record, jpeg: parsed.jpeg })
      if (store.visible.length > keepFrames) store.visible.length = keepFrames
      await writeFile(resolve(outDir, 'latest.jpg'), parsed.jpeg).catch(() => {})
      // 日志条目统一成 {answer, source, reason}，前端直接渲染
      pushLog({
        at: record.at,
        answer: decision.answer,
        source: decision.source,
        reason: decision.reason,
        bytes: record.bytes,
        from: record.from,
      })
      console.log(`[upload] ${(parsed.jpeg.length / 1024).toFixed(1)} KB → ${decision.answer}（${decision.source}：${decision.reason}）`)
      // 确认火灾就现场播报（路过的人也能听到），并写进日志
      if (decision.answer === 'YES') {
        speakAlert({ maxTemp: latestThermal?.maxTemp, smoke: null })
        pushLog({ at: Date.now(), answer: 'SPEAK', source: 'alert-speak', reason: buildAlertPhrase({ maxTemp: latestThermal?.maxTemp, repeat: spokenCount > 1 }) })
        // 广播给用户端：楼道里的旧手机也会响
        await publishFireEvent({ maxTemp: latestThermal?.maxTemp, smoke: null })
      }
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
      const record = { at: Date.now(), maxTemp: parsed.maxTemp, matrix: parsed.matrix, png, from: clientAddress(request) }
      store.thermal.unshift(record)
      if (store.thermal.length > keepFrames) store.thermal.length = keepFrames
      await writeFile(resolve(outDir, 'latest-thermal.json'), JSON.stringify({ at: record.at, max_temp: parsed.maxTemp, sensor_data: parsed.matrix })).catch(() => {})
      if (png) await writeFile(resolve(outDir, 'latest-thermal.png'), png).catch(() => {})
      pushLog({ at: record.at, answer: 'DATA', source: 'thermal-upload', reason: `最高温 ${parsed.maxTemp.toFixed(1)}°C，${parsed.matrix.length} 个温度点`, from: record.from })
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
      visible: visible ? { at: visible.at, bytes: visible.bytes, decision: visible.decision, source: visible.source, reason: visible.reason, from: visible.from } : null,
      thermal: thermal ? { at: thermal.at, maxTemp: thermal.maxTemp, points: thermal.matrix.length, from: thermal.from } : null,
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
}

// 主端口 + 额外端口共用同一个请求处理函数（同一份内存与落盘数据）
const server = createServer(handleRequest)
const extraServers = []

// 原始连接日志：只看每条第 4 层连接收了多少字节、活了多久
function watchConnection(socket) {
  if (!logConnections) return
  const from = clientAddress({ socket })
  const startedAt = Date.now()
  let bytes = 0
  // 只留开头一段：用来核对板子声明的 Content-Length 和实际发出的字节数
  let head = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    bytes += chunk.length
    if (head.length < 400) head = Buffer.concat([head, chunk.subarray(0, 400 - head.length)])
  })
  socket.on('close', () => {
    console.log(`【原始连接】${from} 关闭：共收到 ${bytes} 字节，存活 ${Date.now() - startedAt} ms`)
    if (from !== '127.0.0.1' && head.length) {
      const text = head.toString('utf8').replace(/\r/g, '').split('\n').slice(0, 8).join(' | ')
      console.log(`【请求头】${from}：${text.slice(0, 300)}`)
    }
  })
  console.log(`【原始连接】${from} 已建立`)
}
server.on('connection', watchConnection)

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
  const entries = classifyLanInterfaces(lanInterfaces(), hardwarePortKinds())
  if (entries.length) {
    console.log('  本机网卡：')
    entries.forEach((item) => {
      const label = item.kind === 'wired' ? '有线' : item.kind === 'wireless' ? '无线' : '未知'
      console.log(`    ${item.name.padEnd(8)} ${item.address.padEnd(16)} ${label}`)
    })
    console.log('  （网线接入时把"有线"那条的地址写进固件；也可以直接跑 --print-firmware 自动生成）')
  }
  console.log(`  可见光上传：POST http://<本机IP>:${activePort}/upload        （固件 serverUrl）`)
  console.log(`  热像上传：  POST http://<本机IP>:${activePort}/upload_thermal （固件 thermalServerUrl）`)
  if (extraPorts.length) console.log(`  同时监听：  ${extraPorts.join('、')}（固件烧成这些端口也能直接连；被占用的会自动跳过）`)
  console.log(`  观察页面：  http://127.0.0.1:${activePort}/`)
  console.log(`  终审策略：  ${visionUrl ? `YOLO 视觉服务 ${visionUrl}（阈值 ${visionConf}）` : `热像阈值 ${yesTemp}°C`}${alwaysYes ? ' · 强制 YES（演示）' : ''}`)
  console.log(`  落盘目录：  ${outDir}`)
  console.log(`  现场播报：  ${speak ? `开启（每 ${speakRepeatSec} 秒重复，可用 --no-speak 关闭）` : '已关闭'}`)
  console.log(`  事件广播：  ${publishUrl || '未配置'}${publishChannel ? ` + 云端 ${publishChannel}` : ''}（确认火情后通知用户端）`)
  if (activePort !== port) {
    console.log('')
    console.log(`⚠️ 实际端口是 ${activePort}（不是 ${port}）：固件里 serverUrl / thermalServerUrl 的端口要一并改成 ${activePort}`)
    console.log(`   例如：const char* serverUrl = "http://<电脑IP>:${activePort}/upload";`)
    console.log(`         const char* thermalServerUrl = "http://<电脑IP>:${activePort}/upload_thermal";`)
  }
  if (printFirmware) {
    const entries = classifyLanInterfaces(lanInterfaces(), hardwarePortKinds())
    const picked = pickInterface(entries, { prefer: preferInterface, medium })
    const lan = picked?.address ?? '127.0.0.1'
    console.log('')
    console.log(`== 复制到 ESP32 固件的两行（用的是 ${picked ? `${picked.name}（${picked.kind === 'wired' ? '有线' : picked.kind === 'wireless' ? '无线' : '未知类型'}）` : '本机地址'}）==`)
    console.log(`const char* serverUrl        = "http://${lan}:${activePort}/upload";`)
    console.log(`const char* thermalServerUrl = "http://${lan}:${activePort}/upload_thermal";`)
    console.log('（原来的 thermalServerUrl 是 "http://10.240.250"，少了端口与路径，必须替换）')
    console.log('')
    console.log('== 这台电脑上的网卡（网线接入时看这一行）==')
    entries.forEach((item) => {
      const label = item.kind === 'wired' ? '有线' : item.kind === 'wireless' ? '无线' : '未知'
      console.log(`   ${item.name.padEnd(8)} ${item.address.padEnd(16)} ${label}${item.address === lan ? '   ← 上面两行用的是这个' : ''}`)
    })
    if (picked?.kind === 'wired' || medium === 'ethernet' || medium === 'wired') {
      const wired = entries.find((item) => item.kind === 'wired')
      if (!wired) {
        console.log('')
        console.log('⚠️ 没有检测到有线网卡：插上 USB/雷雳网线适配器（或确认系统设置里已拿到 IP）后重新运行本命令，会自动填好地址。')
        console.log('   下面片段里的地址先用占位符，等你插上网线再替换成"有线"那条。')
      }
      console.log('')
      console.log('== 网线（W5500 以太网）远程接口 · 固件侧需要补的片段 ==')
      console.log('   // W5500 走 SPI，注意与相机/热像模块的引脚错开（详见 docs/网线接入（W5500）-远程接口.md）')
      console.log('   #include <SPI.h>')
      console.log('   #include <Ethernet.h>')
      console.log('   byte mac[] = { 0xDE, 0xAD, 0xBE, 0xEF, 0xFE, 0xED };')
      console.log('   Ethernet.begin(mac);                       // 插上网线后自动 DHCP 拿地址')
      console.log('   IPAddress host;')
      console.log(`   host.fromString("${wired ? wired.address : '192.168.1.20'}");                 // 这台电脑${wired ? `有线网卡 ${wired.name} ` : '有线网卡（占位，插上网线后替换）'}的地址`)
      console.log(`   EthernetClient client;  client.connect(host, ${activePort});   // 之后复用现有 POST /upload 逻辑`)
      console.log(`   // 自检：在这台电脑上执行  curl http://${wired ? wired.address : '<有线网卡IP>'}:${activePort}/health`)
    }
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
  server.listen(activePort, host, () => {
    printBanner()
    // 额外端口：固件里可能烧的是 5011 / 5000 等别的端口，这里一起听上。
    // 被占用的（例如 macOS 的 5000 被隔空播放占着）就跳过并说明，不影响主端口。
    extraPorts.forEach((extra) => {
      if (extra === activePort) return
      const probe = createProbeServer()
      probe.once('error', () => {
        console.log(`ℹ️ 额外端口 ${extra} 被占用或不可用，已跳过（主端口 ${activePort} 正常）`)
      })
      probe.once('listening', () => {
        probe.close(() => {
          const extraServer = createServer(handleRequest)
          extraServer.on('connection', watchConnection)
          extraServer.once('error', (error) => {
            console.log(`ℹ️ 额外端口 ${extra} 监听失败：${error.message}`)
          })
          extraServer.listen(extra, host, () => {
            extraServers.push(extraServer)
            console.log(`同时监听端口 ${extra}（固件烧的是这个端口也能直接连上）`)
          })
        })
      })
      probe.listen(extra, host)
    })
  })
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      extraServers.forEach((item) => { try { item.close() } catch {} })
      server.close(() => process.exit(0))
    })
  }
}
