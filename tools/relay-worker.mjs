// 热感哨兵 · Cloudflare Worker 版事件中继（免费额度即可跑）
//
// 部署（约 3 分钟）：
//   1) npm i -g wrangler && wrangler login
//   2) 建一个 KV 命名空间：wrangler kv namespace create TG_EVENTS
//      把返回的 id 填到下面的 KV 绑定里（或在 wrangler.toml 里配置）
//   3) wrangler deploy tools/relay-worker.mjs --name thermal-guard-relay
//   4) 前端「云端通道」填 https://thermal-guard-relay.<你的账号>.workers.dev
//
// 协议与 tools/relay-server.mjs 完全一致：
//   GET  /health?topic=<分组>
//   POST /events?topic=<分组>                body = 事件 JSON
//   GET  /events?since=<cursor>&topic=<分组>
//
// 分组（topic）区分小区/楼栋：前端「云端通道」写 https://xxx.workers.dev#building-a 即可。
//
// 说明：这里用 KV 存最近 500 条事件，足够做"火警广播"这类低频消息；
// 如果要毫秒级推送，把它换成 Durable Object 或你们自己的 WebSocket/MQTT 服务即可。

const MAX_EVENTS = 500
const keyFor = (topic) => `events:${topic || 'default'}`

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

async function readStore(env, topic) {
  const raw = await env.TG_EVENTS.get(keyFor(topic))
  if (!raw) return { seq: 0, events: [] }
  try {
    const parsed = JSON.parse(raw)
    return { seq: Number(parsed.seq) || 0, events: Array.isArray(parsed.events) ? parsed.events : [] }
  } catch {
    return { seq: 0, events: [] }
  }
}

async function writeStore(env, topic, store) {
  await env.TG_EVENTS.put(keyFor(topic), JSON.stringify(store))
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })

    if (url.pathname === '/health') {
      const topic = url.searchParams.get('topic') || 'default'
      const store = await readStore(env, topic)
      return json({ ok: true, topic, events: store.events.length, seq: store.seq })
    }

    if (url.pathname === '/events' && request.method === 'POST') {
      let event = null
      try {
        event = await request.json()
      } catch {
        return json({ ok: false, error: 'bad-json' }, 400)
      }
      if (!event?.id) return json({ ok: false, error: 'missing-id' }, 400)
      const topic = url.searchParams.get('topic') || event.topic || 'default'
      const store = await readStore(env, topic)
      if (store.events.some((item) => item.event?.id === event.id)) {
        return json({ ok: true, topic, cursor: String(store.seq), duplicate: true })
      }
      store.seq += 1
      store.events.push({ seq: store.seq, at: Date.now(), event })
      if (store.events.length > MAX_EVENTS) store.events.splice(0, store.events.length - MAX_EVENTS)
      await writeStore(env, topic, store)
      return json({ ok: true, topic, cursor: String(store.seq) })
    }

    if (url.pathname === '/events' && request.method === 'GET') {
      const topic = url.searchParams.get('topic') || 'default'
      const since = Number(url.searchParams.get('since')) || 0
      const store = await readStore(env, topic)
      return json({
        ok: true,
        topic,
        cursor: String(store.seq),
        events: store.events.filter((item) => item.seq > since).map((item) => item.event),
      })
    }

    return json({ ok: false, error: 'not-found', hint: 'GET /health、POST /events、GET /events?since=' }, 404)
  },
}
