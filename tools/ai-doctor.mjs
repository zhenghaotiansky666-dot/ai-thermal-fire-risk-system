// 本地 AI 接入自检（"队友接不进去"时先跑这个）
//
// 检查顺序完全按真实链路来：
//   1. 本机 Ollama 端口通不通（默认 127.0.0.1:11434）
//   2. 局域网地址能不能访问（队友/手机要从另一台设备连进来）
//   3. CORS 头有没有（浏览器跨源访问必须要有，Ollama 默认只允许自己）
//   4. 目标模型在不在（没 pull 过就永远连不上）
//   5. 真正发一次 chat/completions（前面都过，这一步不过就是模型侧问题）
//   6. 我们的本地站点与 /ai 代理通不通（浏览器实际走的是这条同源路径）
//
// 用法：
//   node tools/ai-doctor.mjs                      # 默认检查 Ollama + 本地站点
//   node tools/ai-doctor.mjs --upstream http://127.0.0.1:1234/v1 --model qwen2.5-7b-instruct

import { networkInterfaces } from 'node:os'

export const DEFAULT_MODEL = 'qwen2.5:7b'

export function lanAddresses() {
  const out = []
  const interfaces = networkInterfaces()
  Object.values(interfaces).forEach((list) => {
    (list ?? []).forEach((item) => {
      if (item.family === 'IPv4' && !item.internal) out.push(item.address)
    })
  })
  return out
}

// ---------------------------------------------------------------- 纯函数：判定
export function classifyPortCheck({ ok, status, error, label }) {
  if (ok) return { level: 'pass', title: `${label} 端口可达`, remedy: '' }
  if (status === 403 || status === 401) {
    return { level: 'fail', title: `${label} 端口可达但被拒绝（${status}）`, remedy: '检查密钥是否正确；本地 Ollama 一般不需要密钥，把「访问密钥」留空' }
  }
  return {
    level: 'fail',
    title: `${label} 连不上${error ? `（${error}）` : ''}`,
    remedy: label.includes('局域网')
      ? '在跑模型的电脑上用这个命令启动：OLLAMA_HOST=0.0.0.0:11434 ollama serve（Windows：set OLLAMA_HOST=0.0.0.0:11434 后再 ollama serve），并允许防火墙放行 11434'
      : '先确认模型服务在跑：ollama serve；若端口不是 11434，请把实际端口填进「端点地址」',
  }
}

export function classifyCors(headers) {
  const allow = headers?.['access-control-allow-origin'] ?? headers?.get?.('access-control-allow-origin') ?? null
  if (allow === '*' || (typeof allow === 'string' && allow.length > 0)) {
    return { level: 'pass', title: `CORS 已放开（Access-Control-Allow-Origin: ${allow}）`, remedy: '' }
  }
  return {
    level: 'fail',
    title: 'CORS 未放开：浏览器会拦掉跨源请求',
    remedy: '启动模型时加上 OLLAMA_ORIGINS=*（Windows：set OLLAMA_ORIGINS=*），或改用我们的本地站点 + /ai 代理（一键配置脚本已经这么做了）',
  }
}

export function classifyModels(models, wanted = DEFAULT_MODEL) {
  const list = Array.isArray(models) ? models.map((item) => (typeof item === 'string' ? item : item?.name ?? item?.id ?? '')).filter(Boolean) : []
  if (!list.length) {
    return { level: 'fail', title: '模型列表为空：一个模型都还没拉下来', models: [], remedy: `执行 ollama pull ${wanted}` }
  }
  const hit = list.find((name) => name === wanted)
    ?? list.find((name) => name.split(':')[0] === String(wanted).split(':')[0])
  if (hit) return { level: 'pass', title: `找到模型 ${hit}`, models: list, matched: hit, remedy: '' }
  return {
    level: 'warn',
    title: `没有找到 ${wanted}，但本机有 ${list.length} 个模型`,
    models: list,
    matched: list[0],
    remedy: `要么执行 ollama pull ${wanted}，要么把「模型名」改成已有的 ${list[0]}`,
  }
}

export function classifyChat({ ok, status, content, error }) {
  if (ok && content) return { level: 'pass', title: `模型可用（返回 ${String(content).slice(0, 24)}…）`, remedy: '' }
  if (status === 404) return { level: 'fail', title: '模型不存在（404）', remedy: '把「模型名」改成 ollama list 里真实存在的名字' }
  if (status === 400) return { level: 'fail', title: '请求被拒（400）：通常是模型名或消息格式不对', remedy: '确认模型名与端点前缀（Ollama 的 OpenAI 兼容路径是 /v1）' }
  return { level: 'fail', title: `对话请求失败${error ? `（${error}）` : status ? `（HTTP ${status}）` : ''}`, remedy: '看模型服务控制台的报错；显存不足时换更小的模型（如 qwen2.5:3b）' }
}

export function summarize(checks) {
  const fails = checks.filter((item) => item.level === 'fail')
  const warns = checks.filter((item) => item.level === 'warn')
  return {
    ok: fails.length === 0,
    fails: fails.length,
    warns: warns.length,
    headline: fails.length
      ? `有 ${fails.length} 项没通过，按下面的"怎么修"逐条处理`
      : warns.length
        ? `基本可用，但有 ${warns.length} 项需要注意`
        : '全部通过，队友可以直接连进来',
  }
}

// ---------------------------------------------------------------- 运行时检查
async function fetchJson(url, options = {}, timeoutMs = 6000) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = setTimeout(() => controller?.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...options, signal: controller?.signal })
    const text = await response.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {}
    return { ok: response.ok, status: response.status, headers: response.headers, json, text }
  } catch (error) {
    return { ok: false, status: 0, headers: null, json: null, text: '', error: String(error?.message ?? error) }
  } finally {
    clearTimeout(timer)
  }
}

export async function runDoctor(options = {}) {
  const upstream = String(options.upstream ?? 'http://127.0.0.1:11434/v1').replace(/\/$/, '')
  const model = options.model ?? DEFAULT_MODEL
  const siteBase = String(options.siteBase ?? 'http://127.0.0.1:4173').replace(/\/$/, '')
  const origin = options.origin ?? 'https://zhenghaotiansky666-dot.github.io'
  const checks = []

  const push = (id, title, result, detail = '') => {
    checks.push({ id, title, detail, ...result })
  }

  // 1) 本机端口
  const local = await fetchJson(`${upstream}/models`)
  push('local-port', '本机模型端口', classifyPortCheck({ ok: local.ok, status: local.status, error: local.error, label: '本机模型' }), upstream)

  // 2) 局域网端口（队友要从另一台电脑连）
  const lan = lanAddresses()[0]
  if (lan) {
    const lanUrl = upstream.replace('127.0.0.1', lan)
    const lanResult = await fetchJson(`${lanUrl}/models`)
    push('lan-port', '局域网访问', classifyPortCheck({ ok: lanResult.ok, status: lanResult.status, error: lanResult.error, label: `局域网 ${lan}` }), lanUrl)
  } else {
    push('lan-port', '局域网访问', { level: 'warn', title: '没有检测到局域网 IP（可能没连网）', remedy: '连上 Wi-Fi/网线后重跑本脚本' })
  }

  // 3) CORS（浏览器跨源）
  const corsProbe = await fetchJson(`${upstream}/models`, { headers: { Origin: origin } })
  push('cors', '浏览器跨源（CORS）', classifyCors(corsProbe.headers))

  // 4) 模型
  const tagsPath = upstream.includes('/v1') ? `${upstream}/models` : `${upstream}/api/tags`
  const tags = await fetchJson(tagsPath)
  const models = tags.json?.data ?? tags.json?.models ?? []
  const modelCheck = classifyModels(models.map((item) => item?.id ?? item?.name ?? item), model)
  push('models', '模型是否就位', modelCheck, `期望 ${model}`)

  // 5) 真正对话一次
  if (modelCheck.matched) {
    const chat = await fetchJson(`${upstream}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelCheck.matched, messages: [{ role: 'user', content: '只回复两个字：可用' }], max_tokens: 16, stream: false }),
    }, 20000)
    push('chat', '实际对话测试', classifyChat({
      ok: chat.ok,
      status: chat.status,
      content: chat.json?.choices?.[0]?.message?.content,
      error: chat.error,
    }), modelCheck.matched)
  } else {
    push('chat', '实际对话测试', { level: 'fail', title: '跳过：没有可用模型', remedy: `先执行 ollama pull ${model}` })
  }

  // 6) 我们的本地站点与同源代理
  const site = await fetchJson(`${siteBase}/`, {}, 4000)
  push('site', '本地站点', site.ok
    ? { level: 'pass', title: '本地站点在线', remedy: '' }
    : { level: 'warn', title: '本地站点没起来', remedy: '运行 node tools/setup-local-ai.mjs（会同时起站点与 /ai 代理）' }, siteBase)

  const proxy = await fetchJson(`${siteBase}/ai/v1/models`, {}, 6000)
  push('proxy', '同源 /ai 代理', proxy.ok
    ? { level: 'pass', title: '代理可用（浏览器就填 /ai/v1）', remedy: '' }
    : { level: 'warn', title: '代理不可用', remedy: '确认用了 node tools/local-ai-server.mjs 打开站点，而不是直接开 dist 里的文件' }, `${siteBase}/ai/v1`)

  const summary = summarize(checks)
  return {
    ok: summary.ok,
    summary,
    checks,
    hints: {
      upstream,
      model,
      siteBase,
      endpointForBrowser: '/ai/v1',
      lanSite: lan ? `http://${lan}:${new URL(siteBase).port || 4173}/mobile-app.html` : null,
    },
  }
}

// ---------------------------------------------------------------- CLI
function icon(level) {
  return level === 'pass' ? '✅' : level === 'warn' ? '⚠️' : '❌'
}

export function formatReport(report) {
  const lines = []
  report.checks.forEach((check) => {
    lines.push(`${icon(check.level)} ${check.title}${check.detail ? `  ·  ${check.detail}` : ''}`)
    if (check.remedy) lines.push(`     怎么修：${check.remedy}`)
  })
  lines.push('')
  lines.push(`${report.ok ? '结论' : '结论'}：${report.summary.headline}`)
  if (report.hints.lanSite) lines.push(`队友/手机请打开：${report.hints.lanSite}，端点填 ${report.hints.endpointForBrowser}`)
  return lines.join('\n')
}

const isCli = process.argv[1] && process.argv[1].endsWith('ai-doctor.mjs')
if (isCli) {
  const args = process.argv.slice(2)
  const readArg = (name, fallback) => {
    const index = args.indexOf(name)
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback
  }
  const report = await runDoctor({
    upstream: readArg('--upstream', 'http://127.0.0.1:11434/v1'),
    model: readArg('--model', DEFAULT_MODEL),
    siteBase: readArg('--site', 'http://127.0.0.1:4173'),
  })
  console.log(formatReport(report))
  process.exit(report.ok ? 0 : 1)
}
