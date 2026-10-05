// AI 指挥 · 大模型免 Key 代理（Cloudflare Worker）
//
// 为什么需要它：线上站点（GitHub Pages）是纯静态的，把大模型 API Key 写进前端等于公开泄露。
// 把 Key 存在 Worker 的环境变量里，前端只填代理地址，用户全程看不到 Key。
//
// 两个入口：
//   POST /chat/completions  —— 与 OpenAI 完全同构，直接把本仓库的 AI 指挥 baseUrl 指到这里即可
//   POST /chat              —— 简化版，body {messages|message}，返回 {reply}
//   GET  /health

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-proxy-token',
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, 'Content-Type': 'application/json' },
})

function readToken(request) {
  const direct = request.headers.get('x-proxy-token')
  if (direct) return direct
  const auth = request.headers.get('Authorization') || ''
  return auth.startsWith('Bearer ') ? auth.slice(7) : ''
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
    const url = new URL(request.url)

    if (url.pathname === '/health') {
      return json({ ok: true, configured: Boolean(env.LLM_API_KEY), model: env.LLM_MODEL || '' })
    }
    if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405)
    if (!['/chat', '/chat/completions'].includes(url.pathname)) return json({ error: 'not-found' }, 404)

    // 可选共享令牌：防止别人拿你的 Key 刷量。前端把它填在"访问密钥"里即可。
    if (env.PROXY_TOKEN && readToken(request) !== env.PROXY_TOKEN) {
      return json({ error: 'unauthorized' }, 401)
    }

    let body = {}
    try { body = await request.json() } catch {}
    const messages = Array.isArray(body.messages) && body.messages.length
      ? body.messages
      : [{ role: 'user', content: String(body.message || '你好') }]

    const base = (env.LLM_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '')
    const model = body.model || env.LLM_MODEL || 'doubao-1-5-pro-32k-250115'
    const apiKey = env.LLM_API_KEY || ''
    if (!apiKey) return json({ error: 'LLM_API_KEY not configured on server' }, 500)

    try {
      const upstream = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages,
          temperature: typeof body.temperature === 'number' ? body.temperature : 0.4,
        }),
      })
      const data = await upstream.json().catch(() => ({}))
      if (!upstream.ok) {
        return json({ error: data?.error?.message || `upstream ${upstream.status}` }, upstream.status)
      }
      // 简化入口给一个 {reply}；OpenAI 入口把上游响应原样透传，前端不用改代码
      if (url.pathname === '/chat') {
        const reply = data.choices?.[0]?.message?.content || data.choices?.[0]?.text || ''
        return json({ reply })
      }
      return json(data)
    } catch (error) {
      return json({ error: error?.message || 'upstream-error' }, 502)
    }
  },
}
