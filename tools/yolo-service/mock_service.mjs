// 不装 YOLO 也能联调的「假视觉服务」：接口与 app.py 完全一致，返回可预期的置信度。
//
//   node tools/yolo-service/mock_service.mjs 8000            # 固定返回火焰 0.82 / 烟雾 0.35
//   node tools/yolo-service/mock_service.mjs 8000 --flame 0.9 --smoke 0.1
//   node tools/yolo-service/mock_service.mjs 8000 --random    # 每次随机（演示"动态变化"用）

import { createServer } from 'node:http'

const args = process.argv.slice(2)
const port = Number(args[0]) || 8000
const readArg = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? Number(args[index + 1]) : fallback
}
const randomize = args.includes('--random')
let flame = readArg('--flame', 0.82)
let smoke = readArg('--smoke', 0.35)

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
}

createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, cors)
    response.end()
    return
  }
  if (request.url.startsWith('/health')) {
    response.writeHead(200, cors)
    response.end(JSON.stringify({ ok: true, model: 'mock-yolo.pt', conf: 0.25 }))
    return
  }
  if (request.url.startsWith('/detect') && request.method === 'POST') {
    let size = 0
    for await (const chunk of request) size += chunk.length
    if (randomize) {
      flame = Math.round(Math.random() * 100) / 100
      smoke = Math.round(Math.random() * 100) / 100
    }
    console.log(`[mock-yolo] 收到图片 ${size} 字节 → 火焰 ${flame} / 烟雾 ${smoke}`)
    response.writeHead(200, cors)
    response.end(JSON.stringify({
      ok: true,
      model: 'mock-yolo.pt',
      flame,
      smoke,
      detections: [
        ...(flame > 0.3 ? [{ label: 'fire', confidence: flame, box: [10, 12, 60, 58] }] : []),
        ...(smoke > 0.3 ? [{ label: 'smoke', confidence: smoke, box: [70, 20, 120, 70] }] : []),
      ],
    }))
    return
  }
  response.writeHead(404, cors)
  response.end(JSON.stringify({ ok: false, error: 'not-found' }))
}).listen(port, '0.0.0.0', () => {
  console.log(`假视觉服务已启动：http://0.0.0.0:${port}（接口与 YOLO 模板一致）`)
})
