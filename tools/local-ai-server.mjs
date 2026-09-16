// 现场本地部署用的静态服务器 + 本地大模型代理
//
// 为什么需要它：
//   GitHub Pages 是 HTTPS，浏览器会拦截页面里对 http://127.0.0.1:11434 的请求（混合内容）。
//   现场想要「断网也能用 AI 指挥」，就用这个脚本在本机把两个东西挂在同一个 http 源上：
//     · 站点本身（dist 目录）        → http://127.0.0.1:4173/user-app.html
//     · 本地大模型的反向代理 /ai/*   → 转发到 Ollama / LM Studio / vLLM 的 OpenAI 兼容端点
//   于是用户端与系统端都可以把「端点地址」填成相对路径 /ai/v1，不存在跨域与混合内容问题。
//
// 用法：
//   node tools/local-ai-server.mjs                 # 默认转发到 http://127.0.0.1:11434/v1（Ollama）
//   node tools/local-ai-server.mjs --upstream http://127.0.0.1:1234/v1 --port 4173
//
// 同时它还是「局域网事件中继」：手机/电脑只要连现场热点并打开这个站点，
// 用户端与系统端就能通过 /sync/* 交换火情与求助事件 —— **不需要互联网**。
//    POST /sync/publish          发布一条事件
//    GET  /sync/events?since=N   取第 N 条之后的事件（长轮询，最多等 wait 毫秒）
//    GET  /sync/health           中继状态（前端用它判断"局域网链路是否可用"）

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { extname, join, normalize, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { runDoctor, formatReport } from './ai-doctor.mjs'

const args = process.argv.slice(2)
const readArg = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const port = Number(readArg('--port', '4173'))
const upstream = readArg('--upstream', 'http://127.0.0.1:11434/v1').replace(/\/$/, '')
const dist = resolve(readArg('--dist', 'dist'))
// 默认监听所有网卡：手机连现场热点后要能直接打开这个站点（断网也能用中继）
const host = readArg('--host', '0.0.0.0')

function lanAddresses() {
  const result = []
  const interfaces = networkInterfaces()
  Object.values(interfaces).forEach((list) => {
    (list ?? []).forEach((item) => {
      if (item.family === 'IPv4' && !item.internal) result.push(item.address)
    })
  })
  return result
}

// 演示时最常用的地址：优先取第一个局域网 IPv4
function primaryLanAddress() {
  return lanAddresses()[0] ?? '127.0.0.1'
}

// 终端里直接打印二维码，比赛现场扫一下就进用户端（评委不用输网址）
async function printJoinQr(url) {
  try {
    const require = createRequire(import.meta.url)
    const QRCode = require('qrcode')
    const ascii = await QRCode.toString(url, { type: 'terminal', small: true, margin: 1 })
    console.log(ascii)
  } catch {
    console.log(`（未安装 qrcode 包，跳过二维码打印；直接访问 ${url} 也可以）`)
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

async function serveStatic(request, response, pathname) {
  const relative = pathname === '/' ? '/mobile-app.html' : pathname
  const target = join(dist, normalize(decodeURIComponent(relative)).replace(/^(\.\.[/\\])+/, ''))
  try {
    const info = await stat(target)
    if (info.isDirectory()) throw new Error('is-directory')
    const body = await readFile(target)
    response.writeHead(200, { 'Content-Type': MIME[extname(target)] ?? 'application/octet-stream' })
    response.end(body)
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('404 · 没找到这个文件。先跑一次 npm run build / pnpm build 生成 dist 目录。')
  }
}

async function proxyAi(request, response) {
  const suffix = request.url.replace(/^\/ai/, '')
  const target = `${upstream}${suffix}`
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  try {
    const upstreamResponse = await fetch(target, {
      method: request.method,
      headers: {
        'Content-Type': request.headers['content-type'] ?? 'application/json',
        ...(request.headers.authorization ? { Authorization: request.headers.authorization } : {}),
      },
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : Buffer.concat(chunks),
    })
    const body = Buffer.from(await upstreamResponse.arrayBuffer())
    response.writeHead(upstreamResponse.status, {
      'Content-Type': upstreamResponse.headers.get('content-type') ?? 'application/json',
      'Access-Control-Allow-Origin': '*',
    })
    response.end(body)
  } catch (error) {
    response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({
      error: 'local-model-unreachable',
      upstream,
      detail: String(error?.message ?? error),
      hint: '确认本地模型已经启动：ollama serve（默认 11434）或 LM Studio 的 Local Server（默认 1234）。',
    }))
  }
}

// ---------------------------------------------------------------- 局域网事件中继
// 目的：火场里可能没有互联网；只要手机和指挥端连在同一个现场热点上，就能互通。
const relay = { events: [], waiters: new Set(), presence: new Map() }

// 在线设备统计：按"最近 60 秒还在轮询/操作"的来源计数，演示时能直接报出"几台设备在线"
const PRESENCE_TTL_MS = 60 * 1000

function touchClient(request) {
  const forwarded = String(request.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
  const key = forwarded || request.socket?.remoteAddress || 'unknown'
  relay.presence.set(key, Date.now())
}

function clientCount() {
  const cutoff = Date.now() - PRESENCE_TTL_MS
  relay.presence.forEach((seenAt, key) => {
    if (seenAt < cutoff) relay.presence.delete(key)
  })
  return relay.presence.size
}

function pushEvent(event) {
  if (!event || !event.id) return null
  if (relay.events.some((item) => item.event?.id === event.id)) {
    return relay.events.find((item) => item.event?.id === event.id)
  }
  const record = { seq: relay.events.length + 1, at: Date.now(), event }
  relay.events.push(record)
  if (relay.events.length > 200) relay.events.splice(0, relay.events.length - 200)
  let seq = record.seq - 1
  relay.waiters.forEach((waiter) => {
    if (waiter.since >= seq) return
    clearTimeout(waiter.timer)
    relay.waiters.delete(waiter)
    waiter.reply()
  })
  console.log(`[relay] 事件 ${event.kind} id=${event.id} 已广播（在线设备 ${clientCount()} 台，等待者 ${relay.waiters.size}）`)
  return record
}

async function handleRelay(request, response, url) {
  const corsHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
  if (url.pathname === '/sync/health') {
    response.writeHead(200, corsHeaders)
    response.end(JSON.stringify({ ok: true, clients: clientCount(), events: relay.events.length, seq: relay.events.length, uptimeSec: Math.round(process.uptime()) }))
    return
  }
  if (url.pathname === '/sync/publish' && request.method === 'POST') {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    let event = null
    try {
      event = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      response.writeHead(400, corsHeaders)
      response.end(JSON.stringify({ ok: false, error: 'bad-json' }))
      return
    }
    const record = pushEvent(event)
    response.writeHead(200, corsHeaders)
    response.end(JSON.stringify({ ok: Boolean(record), seq: record?.seq ?? relay.events.length }))
    return
  }
  if (url.pathname === '/sync/events' && request.method === 'GET') {
    touchClient(request)
    const since = Number(url.searchParams.get('since')) || 0
    const wait = Math.max(0, Math.min(25000, Number(url.searchParams.get('wait')) || 0))
    const reply = () => {
      const events = relay.events.filter((item) => item.seq > since).map((item) => item.event)
      response.writeHead(200, corsHeaders)
      response.end(JSON.stringify({ ok: true, seq: relay.events.length, clients: clientCount(), events }))
    }
    if (relay.events.length > since || wait === 0) {
      reply()
      return
    }
    const waiter = { since, reply, timer: setTimeout(() => { relay.waiters.delete(waiter); reply() }, wait) }
    relay.waiters.add(waiter)
    request.on('close', () => {
      clearTimeout(waiter.timer)
      relay.waiters.delete(waiter)
    })
    return
  }
  response.writeHead(404, corsHeaders)
  response.end(JSON.stringify({ ok: false, error: 'unknown-sync-endpoint' }))
}

// 比赛演示用的「扫码加入」页：二维码指向本机的局域网地址，评委手机扫一下就进用户端
async function serveJoinPage(response, port) {
  const lanHost = primaryLanAddress()
  const userUrl = `http://${lanHost}:${port}/user-app.html`
  const systemUrl = `http://${lanHost}:${port}/mobile-app.html`
  let userQr = ''
  let systemQr = ''
  try {
    const require = createRequire(import.meta.url)
    const QRCode = require('qrcode')
    userQr = await QRCode.toString(userUrl, { type: 'svg', margin: 1, width: 260 })
    systemQr = await QRCode.toString(systemUrl, { type: 'svg', margin: 1, width: 260 })
  } catch {
    userQr = '<p>未安装 qrcode 包，无法生成二维码</p>'
  }
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>扫码加入 · 热感哨兵现场演示</title>
  <style>
    body{margin:0;min-height:100vh;background:#06101f;color:#f3f8ff;font-family:-apple-system,"PingFang SC",sans-serif;display:flex;align-items:center;justify-content:center;padding:24px}
    main{width:min(760px,100%);display:grid;gap:18px}
    h1{font-size:26px;margin:0}
    p{color:#8ea5c2;line-height:1.75;margin:0;font-size:13px}
    .cards{display:grid;grid-template-columns:1fr 1fr;gap:14px}
    @media(max-width:620px){.cards{grid-template-columns:1fr}}
    .card{padding:18px;border:1px solid rgba(96,165,250,.2);border-radius:18px;background:linear-gradient(145deg,rgba(21,38,64,.9),rgba(7,16,31,.92))}
    .card strong{display:block;margin-bottom:8px;font-size:15px}
    .qr{width:100%;max-width:260px;background:#fff;border-radius:12px;padding:8px;display:block;margin:10px auto}
    code{color:#93c5fd;word-break:break-all;font-size:12px}
    .steps{margin:0;padding-left:18px;color:#8ea5c2;font-size:12px;line-height:1.8}
  </style></head><body><main>
    <h1>热感哨兵 · 现场演示入口</h1>
    <p>本页由演示电脑（本机）提供，手机连同一个 Wi-Fi/热点后扫码即可进入。<strong>不需要互联网，也不需要装任何 App。</strong></p>
    <div class="cards">
      <section class="card">
        <strong>① 评委手机扫这个（用户端）</strong>
        ${userQr}
        <p><code>${userUrl}</code></p>
      </section>
      <section class="card">
        <strong>② 指挥端/物业端扫这个（系统端）</strong>
        ${systemQr}
        <p><code>${systemUrl}</code></p>
      </section>
    </div>
    <section class="card">
      <strong>演示流程（约 60 秒）</strong>
      <ol class="steps">
        <li>手机扫码进入用户端 → 页面显示「当前无火警」，底部有表盘与「更多」。</li>
        <li>演示电脑打开系统端 →「预警 → 报警设置 → 开始演练」（或直接点顶栏的演示流程）。</li>
        <li>手机立刻进入火警态：表盘转向、距离与楼层更新、顶部出现「火警通报 · 来自系统端 … 发生火情」。</li>
        <li>手机点「更多 → 离线联通 → 一键上报看到火」→ 系统端弹出「疑似火情（用户上报）」横幅，可一键拉响警报。</li>
        <li>系统顶点「链路」可以看到当前通道与在线设备数（现场通常显示 2–3 台）。</li>
      </ol>
      <p style="margin-top:10px">通道说明：同一网络下自动走本机中继（<code>/sync</code>），不消耗流量、不需要账号；若要演示"住户在自家网络收到"，改用云端通道（<code>ntfy:…</code> 或自建中继域名）。</p>
    </section>
  </main></body></html>`
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(html)
}

createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`)
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' })
    response.end()
    return
  }
  if (url.pathname.startsWith('/sync/')) {
    await handleRelay(request, response, url)
    return
  }
  if (url.pathname === '/join' || url.pathname === '/join.html') {
    await serveJoinPage(response, port)
    return
  }
  // 浏览器的「一键诊断」：服务端替页面去探模型端口，绕开跨域与私网限制
  if (url.pathname === '/ai/diagnose') {
    const report = await runDoctor({
      upstream,
      model: url.searchParams.get('model') || undefined,
      siteBase: `http://127.0.0.1:${port}`,
    })
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify({ ...report, text: formatReport(report) }))
    return
  }
  if (url.pathname === '/ai' || url.pathname.startsWith('/ai/')) {
    await proxyAi(request, response)
    return
  }
  await serveStatic(request, response, url.pathname)
}).listen(port, host, () => {
  console.log(`热感哨兵本地站点：http://127.0.0.1:${port}/user-app.html （系统端 .../mobile-app.html）`)
  lanAddresses().forEach((address) => {
    console.log(`  手机端可访问：http://${address}:${port}/user-app.html`)
  })
  console.log(`本地大模型代理：/ai/*  →  ${upstream}`)
  console.log(`局域网事件中继：/sync/*  （手机连现场热点后打开 http://<本机局域网IP>:${port}/ 即可互通，不需要互联网）`)
  console.log(`扫码加入页（评委手机扫码进用户端）：http://127.0.0.1:${port}/join`)
  console.log('在页面「AI 指挥」里把端点填成 /ai/v1 即可，断网也能用。')
  console.log('')
  console.log('现场演示：手机扫下面这个二维码即可进入用户端（需与演示电脑在同一网络）')
  printJoinQr(`http://${primaryLanAddress()}:${port}/user-app.html`)
})
