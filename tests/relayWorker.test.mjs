// Cloudflare Worker 中继的逻辑测试：用假 KV 直接驱动 fetch 处理器，
// 这样在没注册 Cloudflare 账号之前，也能确认部署上去行为是对的。

import worker from '../tools/relay-worker.mjs'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`)
  else { failures += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

// 极简 KV 替身：只实现 get/put
function createFakeKv() {
  const store = new Map()
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null
    },
    async put(key, value) {
      store.set(key, value)
    },
    _size: () => store.size,
  }
}

const env = { TG_EVENTS: createFakeKv() }
const base = 'https://relay.example.workers.dev'

const call = async (path, options = {}) => {
  const response = await worker.fetch(new Request(`${base}${path}`, options), env)
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: response.status, json, headers: response.headers, text }
}

console.log('[1] 健康检查与 CORS')
{
  const health = await call('/health')
  check('健康检查返回 200 与 ok', health.status === 200 && health.json.ok === true)
  check('默认分组为 default', health.json.topic === 'default')
  check('带 CORS 头（浏览器可跨域调用）', health.headers.get('access-control-allow-origin') === '*')

  const preflight = await worker.fetch(new Request(`${base}/events`, { method: 'OPTIONS' }), env)
  check('预检请求返回 204', preflight.status === 204)
}

console.log('[2] 发布与拉取')
{
  const event = { v: 1, id: 'fire-1', kind: 'fire', at: Date.now(), from: 'system', payload: { nodeId: 'A4', floor: 4 } }
  const published = await call('/events', { method: 'POST', body: JSON.stringify(event) })
  check('发布返回 ok 与游标', published.status === 200 && published.json.ok === true && published.json.cursor === '1')

  const listed = await call('/events?since=0')
  check('能取回刚发布的事件', listed.json.events.length === 1 && listed.json.events[0].id === 'fire-1')
  check('游标指向最新', listed.json.cursor === '1')

  const afterCursor = await call('/events?since=1')
  check('游标之后的增量查询为空', afterCursor.json.events.length === 0)
}

console.log('[3] 去重与分组隔离')
{
  const duplicate = await call('/events', { method: 'POST', body: JSON.stringify({ v: 1, id: 'fire-1', kind: 'fire', at: Date.now() }) })
  check('同 id 重复发布被识别', duplicate.json.duplicate === true)
  const listed = await call('/events?since=0')
  check('重复消息不会入库两次', listed.json.events.length === 1)

  await call('/events?topic=building-b', { method: 'POST', body: JSON.stringify({ v: 1, id: 'fire-b1', kind: 'fire', at: Date.now() }) })
  const a = await call('/events?since=0&topic=default')
  const b = await call('/events?since=0&topic=building-b')
  check('默认分组看不到 building-b 的消息', a.json.events.every((item) => item.id !== 'fire-b1'))
  check('building-b 只看到自己的消息', b.json.events.length === 1 && b.json.events[0].id === 'fire-b1')
}

console.log('[4] 异常输入')
{
  const badJson = await call('/events', { method: 'POST', body: '{不是 json' })
  check('非法 JSON 返回 400', badJson.status === 400 && badJson.json.error === 'bad-json')

  const noId = await call('/events', { method: 'POST', body: JSON.stringify({ kind: 'fire' }) })
  check('缺少 id 返回 400', noId.status === 400 && noId.json.error === 'missing-id')

  const notFound = await call('/nope')
  check('未知路径返回 404 并给出提示', notFound.status === 404 && String(notFound.json.hint).includes('/events'))
}

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
