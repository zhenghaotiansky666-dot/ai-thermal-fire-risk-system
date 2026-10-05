// 零依赖 WebSocket 服务端的纯逻辑单测：握手 accept 值、帧编解码、以及端到端推送。
// 目的：队友那台机器不用装 npm 包也能跑 AI 网关（gateway/ai-gateway.mjs）。

import { createServer } from 'node:http'
import { acceptKey, createWebSocketServer, decodeFrames, encodeTextFrame } from '../gateway/mini-ws.mjs'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`)
  else { failures += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('[1] 握手 accept 值（RFC 6455 官方示例）')
{
  check('示例 key 得到官方期望值', acceptKey('dGhlIHNhbXBsZSBub25jZQ==') === 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=', acceptKey('dGhlIHNhbXBsZSBub25jZQ=='))
  check('两端空白会被裁掉', acceptKey('  dGhlIHNhbXBsZSBub25jZQ==  ') === 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  check('空 key 不抛异常', typeof acceptKey('') === 'string')
}

console.log('[2] 文本帧编码：三种长度分支都要对')
{
  const short = encodeTextFrame('hi')
  check('短帧头是 0x81 + 长度', short[0] === 0x81 && short[1] === 2)
  check('短帧负载正确', short.subarray(2).toString('utf8') === 'hi')

  const medium = encodeTextFrame('x'.repeat(300))
  check('126–65535 用 16 位长度', medium[1] === 126 && medium.readUInt16BE(2) === 300)
  check('中等帧总长 = 头 4 + 负载', medium.length === 304)

  const large = encodeTextFrame('y'.repeat(70000))
  check('超过 65535 用 64 位长度', large[1] === 127 && Number(large.readBigUInt64BE(2)) === 70000)
  check('中文按 UTF-8 计算长度', encodeTextFrame('火焰').readUInt8(1) === Buffer.from('火焰', 'utf8').length)
}

console.log('[3] 解帧：浏览器发来的掩码帧 + ping')
{
  // 手工构造一帧带掩码的 "ping" 文本帧（opcode 1, fin, mask）
  const payload = Buffer.from('{"type":"ping"}', 'utf8')
  const mask = Buffer.from([0x01, 0x02, 0x03, 0x04])
  const masked = Buffer.from(payload)
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4]
  const header = Buffer.from([0x81, 0x80 | payload.length])
  const frame = Buffer.concat([header, mask, masked])

  const { frames, rest } = decodeFrames(frame)
  check('解出一帧', frames.length === 1)
  check('opcode 是文本', frames[0].opcode === 0x1)
  check('去掩码后内容正确', frames[0].payload.toString('utf8') === '{"type":"ping"}')
  check('没有残留字节', rest.length === 0)

  const partial = decodeFrames(frame.subarray(0, frame.length - 3))
  check('半个包不报错且不产出帧', partial.frames.length === 0 && partial.rest.length > 0)
}

console.log('[4] 端到端：真起一个服务，握手并推一条 JSON')
{
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ok: true }))
  })
  const wss = createWebSocketServer({ server, path: '/ws/detections' })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()

  const received = []
  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ risk: 'high', detections: [{ class: 'flame', confidence: 0.9 }] }))
  })

  const client = new WebSocket(`ws://127.0.0.1:${port}/ws/detections`)
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('连接超时')), 3000)
    client.addEventListener('message', (event) => {
      received.push(String(event.data))
      clearTimeout(timer)
      done()
    })
    client.addEventListener('error', () => {
      clearTimeout(timer)
      fail(new Error('连接失败'))
    })
  }).catch((error) => check('客户端连上服务端', false, String(error.message)))

  check('浏览器端收到了推送', received.length === 1, JSON.stringify(received))
  check('推送内容是可解析的 JSON', (() => {
    try {
      return JSON.parse(received[0]).detections[0].class === 'flame'
    } catch {
      return false
    }
  })())
  check('服务端记录了在线客户端', wss.clients.size === 1)

  client.close()
  wss.close()
  await new Promise((done) => server.close(done))
}

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
