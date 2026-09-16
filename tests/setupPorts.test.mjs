// 一键配置的端口处理单测：占用检测与自动换端口（"把端口搞好一点"这条要求）

import { createServer } from 'node:net'
import { findFreePort, isPortBusy } from '../tools/setup-local-ai.mjs'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`)
  else { failures += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

async function occupy(port) {
  return new Promise((done) => {
    const server = createServer()
    server.listen(port, '127.0.0.1', () => done(server))
  })
}

console.log('[1] 端口占用检测')
{
  const port = 8800 + Math.floor(Math.random() * 100)
  check('空闲端口 → 不忙', (await isPortBusy(port)) === false)
  const server = await occupy(port)
  check('被占用 → 检测为忙', (await isPortBusy(port)) === true)
  server.close()
  await new Promise((done) => setTimeout(done, 120))
}

console.log('[2] 自动换端口')
{
  const base = 8900 + Math.floor(Math.random() * 60)
  const server = await occupy(base)
  const picked = await findFreePort(base)
  check('首选端口被占 → 自动换到下一个空闲端口', picked !== base && picked > base, `base=${base} picked=${picked}`)
  check('换到的端口确实空闲', (await isPortBusy(picked)) === false)
  server.close()
  await new Promise((done) => setTimeout(done, 120))

  const free = await findFreePort(base + 20)
  check('首选端口空闲 → 原样使用（不折腾）', free === base + 20)
}

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
