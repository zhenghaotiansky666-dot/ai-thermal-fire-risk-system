// 热感哨兵 · 云端事件中继（自建最小实现）
//
// 用途：把「用户端 → 系统端」的消息放到公网服务器上，住户手机用 4G/5G 就能收到，
// 不依赖任何局域网、热点或蓝牙。这一版是单文件实现，方便直接扔到 Vercel / Render /
// Railway / 一台云主机上跑；生产环境建议换成你们自己的后端 + 数据库。
//
// 协议（两端都用同一套，见 src/shared/eventBus.js 的 rest 模式）：
//   GET  /health?topic=<分组>                  → { ok: true, events: n }
//   POST /events?topic=<分组>                  → 发布一条事件（JSON），返回 { ok, cursor }
//   GET  /events?since=<cursor>&topic=<分组>   → 取该游标之后的事件 { ok, cursor, events: [...] }
//
// 分组（topic）用来区分小区/楼栋：前端「云端通道」写成 https://你的域名#building-a 即可。
// 不写分组就是默认分组 default。
//
// 启动：node tools/relay-server.mjs --port 8899
// 前端把「云端通道」填成：http(s)://<你的域名>（不带路径）

import { createServer } from 'node:http'

const args = process.argv.slice(2)
const readArg = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const port = Number(readArg('--port', '8899'))
const maxEvents = Number(readArg('--max', '500'))
const TTL_MS = Number(readArg('--ttl-minutes', '60')) * 60 * 1000

const stores = new Map() // topic -> { events, seq }
const waiters = new Set() // { topic, since, reply, timer }
const presence = new Map() // 来源 -> 最近活跃时间（用于"几台设备在线"）
const PRESENCE_TTL_MS = 60 * 1000

function touchClient(request) {
  const forwarded = String(request.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
  const key = forwarded || request.socket?.remoteAddress || 'unknown'
  presence.set(key, Date.now())
}

function clientCount() {
  const cutoff = Date.now() - PRESENCE_TTL_MS
  presence.forEach((seenAt, key) => {
    if (seenAt < cutoff) presence.delete(key)
  })
  return presence.size
}

function storeFor(topic) {
  const key = topic || 'default'
  if (!stores.has(key)) stores.set(key, { events: [], seq: 0 })
  return stores.get(key)
}

function prune(store) {
  const cutoff = Date.now() - TTL_MS
  store.events = store.events.filter((item) => item.at >= cutoff)
}

function publish(topic, event) {
  if (!event?.id) return null
  const store = storeFor(topic)
  const existing = store.events.find((item) => item.event?.id === event.id)
  if (existing) return existing
  store.seq += 1
  const record = { seq: store.seq, at: Date.now(), event }
  store.events.push(record)
  prune(store)
  if (store.events.length > maxEvents) store.events.splice(0, store.events.length - maxEvents)
  waiters.forEach((waiter) => {
    if (waiter.topic !== (topic || 'default') || waiter.since >= record.seq) return
    clearTimeout(waiter.timer)
    waiters.delete(waiter)
    waiter.reply()
  })
  return record
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
}

createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`)
  const json = (status, body) => {
    response.writeHead(status, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify(body))
  }

  if (request.method === 'OPTIONS') {
    response.writeHead(204, cors)
    response.end()
    return
  }

  if (url.pathname === '/health') {
    touchClient(request)
    const topic = url.searchParams.get('topic') || 'default'
    const store = storeFor(topic)
    json(200, { ok: true, topic, events: store.events.length, seq: store.seq, topics: stores.size, clients: clientCount(), uptimeSec: Math.round(process.uptime()) })
    return
  }

  if (url.pathname === '/events' && request.method === 'POST') {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    let event = null
    try {
      event = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      json(400, { ok: false, error: 'bad-json' })
      return
    }
    const topic = url.searchParams.get('topic') || event.topic || 'default'
    const record = publish(topic, event)
    if (!record) {
      json(400, { ok: false, error: 'missing-id' })
      return
    }
    console.log(`[relay] ${topic} · ${record.event.kind} id=${record.event.id} 来自 ${record.event.from ?? '?'}（游标 ${record.seq}）`)
    json(200, { ok: true, topic, cursor: String(record.seq) })
    return
  }

  if (url.pathname === '/events' && request.method === 'GET') {
    touchClient(request)
    const topic = url.searchParams.get('topic') || 'default'
    const store = storeFor(topic)
    const since = Number(url.searchParams.get('since')) || 0
    const wait = Math.max(0, Math.min(25000, Number(url.searchParams.get('wait')) || 0))
    const reply = () => json(200, {
      ok: true,
      topic,
      cursor: String(store.seq),
      clients: clientCount(),
      events: store.events.filter((item) => item.seq > since).map((item) => item.event),
    })
    if (store.seq > since || wait === 0) {
      reply()
      return
    }
    const waiter = { topic, since, reply, timer: setTimeout(() => { waiters.delete(waiter); reply() }, wait) }
    waiters.add(waiter)
    request.on('close', () => {
      clearTimeout(waiter.timer)
      waiters.delete(waiter)
    })
    return
  }

  json(404, { ok: false, error: 'not-found', hint: '可用端点：GET /health、POST /events、GET /events?since=' })
}).listen(port, '0.0.0.0', () => {
  console.log(`热感哨兵云端中继已启动：http://127.0.0.1:${port}`)
  console.log('前端「云端通道」填这个地址（不带路径）。生产部署请套 HTTPS 反向代理。')
})
