#!/usr/bin/env node
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFile, stat } from 'node:fs/promises'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import os from 'node:os'
// 零依赖 WebSocket 服务端（本地实现，队友那台机器不用 npm install）
import { WebSocket, createWebSocketServer as WebSocketServer } from './mini-ws.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DIST = join(ROOT, 'dist')
const args = process.argv.slice(2)

function lanAddresses() {
  const result = []
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.')) result.push(entry.address)
    }
  }
  return result
}

function valueOf(name, fallback) {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const config = {
  mode: valueOf('mode', 'simulator'),
  source: valueOf('source', ''),
  model: valueOf('model', ''),
  cameraId: valueOf('camera-id', 'laptop-ai-camera'),
  host: valueOf('host', '0.0.0.0'),
  port: Number(valueOf('port', '8787')),
  cert: valueOf('tls-cert', ''),
  key: valueOf('tls-key', ''),
  python: valueOf('python', 'python3'),
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.step': 'model/step',
  '.stl': 'model/stl',
}

let latest = {
  camera_id: config.cameraId,
  source: 'laptop-ai-gateway',
  risk: 'low',
  max_temp: 31,
  detections: [],
  hotspots: [],
  timestamp: new Date().toISOString(),
}

function simulate(index) {
  const high = index % 20 >= 8 && index % 20 < 17
  const moving = (Math.sin(index * 0.17) + 1) / 2
  const detections = high
    ? [
        { class: 'smoke', confidence: 0.84 + moving * 0.1, bbox: [0.22 + moving * 0.04, 0.2, 0.22, 0.2] },
        { class: 'flame', confidence: 0.78 + moving * 0.12, bbox: [0.57, 0.35 + moving * 0.03, 0.13, 0.17] },
      ]
    : index % 20 >= 5 && index % 20 < 8
      ? [{ class: 'person', confidence: 0.9, bbox: [0.62, 0.34, 0.12, 0.34] }]
      : []
  return {
    camera_id: config.cameraId,
    source: 'laptop-ai-gateway-simulator',
    risk: high ? 'high' : detections.length ? 'medium' : 'low',
    max_temp: high ? 78 + moving * 10 : 32 + moving * 5,
    detections,
    hotspots: high ? [{ x: 0.62 + moving * 0.03, y: 0.36, width: 0.14, height: 0.18, temp: 79 + moving * 9, confidence: 0.93 }] : [],
    timestamp: new Date().toISOString(),
  }
}

function serveFile(req, res) {
  const rawPath = decodeURIComponent((req.url || '/').split('?')[0])
  let path = normalize(join(DIST, rawPath === '/' ? 'index.html' : rawPath))
  if (!path.startsWith(DIST)) {
    res.writeHead(403).end('Forbidden')
    return
  }
  if (!existsSync(path)) {
    const fallback = join(DIST, 'mobile-app.html')
    if (existsSync(fallback)) path = fallback
    else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found. Run pnpm build first.')
      return
    }
  }
  stat(path).then((info) => {
    res.writeHead(200, {
      'Content-Type': MIME[extname(path)] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
    })
    createReadStream(path).pipe(res)
  }).catch(() => res.writeHead(500).end('Server error'))
}

const handler = (req, res) => {
  if (req.url?.startsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, mode: config.mode, source: config.source || 'simulator', cameraId: config.cameraId }))
    return
  }
  if (req.url?.startsWith('/api/status')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(latest))
    return
  }
  serveFile(req, res)
}

const server = config.cert && config.key
  ? createHttpsServer({ cert: readFileSync(config.cert), key: readFileSync(config.key) }, handler)
  : createHttpServer(handler)
const wss = new WebSocketServer({ server, path: '/ws/detections' })

function broadcast(payload) {
  latest = payload
  const text = JSON.stringify(payload)
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(text)
  }
}

wss.on('connection', (socket) => {
  socket.send(JSON.stringify(latest))
  socket.on('message', (message) => {
    try {
      const request = JSON.parse(message.toString())
      if (request.type === 'ping') socket.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }))
    } catch {}
  })
})

let timer
let detector
if (config.mode === 'detector') {
  if (!config.source) {
    console.error('Detector mode requires --source <rtsp-url-or-video-path>')
    process.exit(2)
  }
  const detectorArgs = [
    join(ROOT, 'gateway', 'detector.py'),
    '--source', config.source,
    '--camera-id', config.cameraId,
    '--fps', valueOf('fps', '3'),
  ]
  if (config.model) detectorArgs.push('--model', config.model)
  detector = spawn(config.python, detectorArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
  readline.createInterface({ input: detector.stdout }).on('line', (line) => {
    try { broadcast(JSON.parse(line)) } catch (error) { console.error('Invalid detector JSON:', line) }
  })
  detector.stderr.on('data', (chunk) => process.stderr.write(chunk))
  detector.on('exit', (code) => console.log(`Detector exited with code ${code}`))
} else {
  let index = 0
  timer = setInterval(() => broadcast(simulate(index++)), 500)
}

server.listen(config.port, config.host, () => {
  const protocol = config.cert && config.key ? 'https/wss' : 'http/ws'
  console.log(`AI gateway running (${protocol})`)
  console.log(`Local app:  http://127.0.0.1:${config.port}/mobile-app.html`)
  const addresses = lanAddresses()
  const firstAddress = addresses[0] || '<laptop-ip>'
  console.log(`LAN app:    http://${firstAddress}:${config.port}/mobile-app.html`)
  console.log(`WebSocket:  ${config.cert && config.key ? 'wss' : 'ws'}://${firstAddress}:${config.port}/ws/detections`)
  for (const address of addresses.slice(1)) console.log(`LAN alias:  http://${address}:${config.port}/mobile-app.html`)
  console.log(`Health:     http://127.0.0.1:${config.port}/health`)
})

function shutdown() {
  clearInterval(timer)
  detector?.kill('SIGTERM')
  wss.close()
  server.close(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
