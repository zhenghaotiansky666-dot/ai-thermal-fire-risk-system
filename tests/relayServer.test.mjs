// 自建中继（tools/relay-server.mjs）的端到端测试：
// 真起一个进程、真发 HTTP 请求，确认发布 / 增量拉取 / 分组隔离 / 在线设备统计都能工作。

import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`)
  else { failures += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

const port = 8900 + Math.floor(Math.random() * 90)
const base = `http://127.0.0.1:${port}`
const server = spawn(process.execPath, ['tools/relay-server.mjs', '--port', String(port)], { stdio: 'ignore' })

async function waitReady() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${base}/health`)
      if (response.ok) return true
    } catch {}
    await delay(150)
  }
  return false
}

const json = async (path, options) => {
  const response = await fetch(`${base}${path}`, options)
  return { status: response.status, body: await response.json().catch(() => null) }
}

try {
  const ready = await waitReady()
  check('中继能启动并响应健康检查', ready)

  if (ready) {
    console.log('[1] 发布与增量拉取')
    {
      const event = { v: 1, id: 'e-fire-1', kind: 'fire', at: Date.now(), from: 'system', payload: { nodeId: 'C4', floor: 4 } }
      const published = await json('/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) })
      check('发布成功并返回游标', published.status === 200 && published.body.ok === true && published.body.cursor === '1')

      const all = await json('/events?since=0')
      check('能取回事件', all.body.events.length === 1 && all.body.events[0].id === 'e-fire-1')

      const delta = await json('/events?since=1')
      check('游标之后为空（增量语义正确）', delta.body.events.length === 0)

      const duplicate = await json('/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) })
      check('同 id 不重复入库', duplicate.body.ok === true && (await json('/events?since=0')).body.events.length === 1)
    }

    console.log('[2] 分组隔离与在线设备统计')
    {
      await json('/events?topic=building-x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, id: 'e-x-1', kind: 'fire', at: Date.now() }) })
      const defaultTopic = await json('/events?since=0')
      const otherTopic = await json('/events?since=0&topic=building-x')
      check('不同分组互不串消息', defaultTopic.body.events.every((item) => item.id !== 'e-x-1') && otherTopic.body.events.length === 1)

      const health = await json('/health?topic=building-x')
      check('健康检查按分组统计', health.body.topic === 'building-x' && health.body.events === 1)
      check('在线设备数被统计（本次请求来自 127.0.0.1）', health.body.clients >= 1, String(health.body.clients))
    }

    console.log('[3] 异常输入')
    {
      const badJson = await json('/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' })
      check('非法 JSON 返回 400', badJson.status === 400 && badJson.body.error === 'bad-json')
      const noId = await json('/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'fire' }) })
      check('缺少 id 返回 400', noId.status === 400 && noId.body.error === 'missing-id')
    }
  }
} finally {
  server.kill('SIGKILL')
}

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
