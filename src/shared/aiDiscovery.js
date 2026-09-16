// 本地 AI 自动发现：让"每一个系统端"打开就自带 AI，而不是只有配过的那台能看到。
//
// 背景：现场部署时是"值守那台机器"跑模型（Ollama / LM Studio / YOLO）。
// 如果 AI 只存在那台机器的 localStorage 里，别的系统端（比如指导老师的电脑）
// 打开就只会看到"未接入"。这里做两件事：
//   1. 打开页面时自动在常见端口上找一找本机/本站的模型服务，找到就直接接上；
//   2. 给出一个统一的状态描述（谁在决策、谁在感知、是不是演示假服务），
//      让系统端顶部随时能显示"AI 现在是什么状态"。
//
// 这个文件里的纯函数（normalizeModelIds / isMockModel / describeAiStatus）都有单测。

// 按优先级排列：先同源代理（本地服务器 /ai/*），再常见本地推理服务
export const CHAT_CANDIDATES = [
  { baseUrl: '/ai/v1', label: '本站内置代理（tools/local-ai-server.mjs）' },
  { baseUrl: 'http://127.0.0.1:11434/v1', label: 'Ollama 本机' },
  { baseUrl: 'http://127.0.0.1:1234/v1', label: 'LM Studio 本机' },
  { baseUrl: 'http://127.0.0.1:8001/v1', label: 'vLLM 本机' },
]

export const VISION_CANDIDATES = [
  { baseUrl: 'http://127.0.0.1:8000', label: 'YOLO 视觉服务（本机 8000）' },
  { baseUrl: 'http://127.0.0.1:8080', label: 'YOLO 视觉服务（本机 8080）' },
]

// 兼容 OpenAI 的 {data:[{id}]}、Ollama 的 {models:[{name}]}、以及裸数组
export function normalizeModelIds(payload) {
  if (!payload) return []
  const list = Array.isArray(payload) ? payload
    : Array.isArray(payload.data) ? payload.data
      : Array.isArray(payload.models) ? payload.models
        : []
  return list
    .map((item) => (typeof item === 'string' ? item : item?.id ?? item?.name ?? item?.model ?? ''))
    .map((id) => String(id).trim())
    .filter(Boolean)
}

export function pickModelId(payload) {
  const ids = normalizeModelIds(payload)
  if (!ids.length) return ''
  // 优先挑通用对话模型，避免误选 embedding 之类的辅助模型
  const preferred = ids.find((id) => !/embed|rerank|whisper|tts/i.test(id))
  return preferred || ids[0]
}

// 演示用的假 YOLO（tools/yolo-service/mock_service.mjs）会返回 mock-yolo.pt 这样的名字。
// 答辩前如果还挂着它，我们看到的是"固定置信度"，必须提醒出来。
export function isMockModel(name) {
  return /mock|fake|dummy|stub|演示|模拟/i.test(String(name || ''))
}

function shortModel(name) {
  const text = String(name || '').trim()
  if (!text) return '本地模型'
  return text.length > 22 ? `${text.slice(0, 20)}…` : text
}

// 统一的 AI 状态描述，供系统端顶部状态条与「AI 指挥」面板共用
export function describeAiStatus({ settings = {}, vision = null, discovered = null } = {}) {
  const provider = settings.provider ?? 'offline'
  // 自动发现到的对话模型也算"就绪"：autoDiscoverAi 会把它接进配置，
  // 这样"每个系统端打开就带 AI"这件事在状态条上也是真的。
  const chatReady = (Boolean(settings.baseUrl) && provider !== 'offline') || Boolean(discovered?.chat?.baseUrl)
  const model = settings.model || discovered?.chat?.model || ''
  const visionUrl = settings.visionUrl || vision?.baseUrl || ''
  // 优先显示"实时探测到的名字"（那才是现场真正在跑的权重），配置里的名字只作兜底
  const visionModel = vision?.model || settings.visionModel || ''
  // 假服务判定要同时看"探测到的实时名字"和"配置里存的名字"：
  // 配置可能很久以前填的（例如 yolov8n.pt），而现场其实挂着 mock 服务，
  // 只看配置就会把演示假服务显示成"YOLO 已就绪"。
  const visionMock = isMockModel(vision?.model) || isMockModel(visionModel)

  if (chatReady && visionUrl) {
    return {
      tone: visionMock ? 'warn' : 'full',
      chatReady: true,
      visionReady: true,
      chip: visionMock ? 'AI · 假 YOLO' : 'AI 已就绪',
      label: `AI 就绪 · ${shortModel(model)} + ${visionMock ? '演示假服务' : 'YOLO'}`,
      detail: visionMock
        ? `视觉通道连的是演示用假服务（${visionModel}），只返回固定置信度；答辩前请换成真模型`
        : '感知用 YOLO + 热像，决策用本地对话模型，两端都在这台机器上',
      source: discovered?.chat?.source || 'config',
    }
  }
  if (chatReady) {
    return {
      tone: 'chat',
      chatReady: true,
      visionReady: false,
      chip: 'AI 决策已接入',
      label: `AI 决策 · ${shortModel(model)}`,
      detail: '决策由本地对话模型给出；火焰/烟雾识别暂时用热像与演示数据',
      source: discovered?.chat?.source || 'config',
    }
  }
  if (visionUrl) {
    return {
      tone: 'vision',
      chatReady: false,
      visionReady: true,
      chip: visionMock ? 'AI · 假 YOLO' : 'AI 感知已接入',
      label: `AI 感知 · ${visionMock ? '演示假服务' : 'YOLO'}`,
      detail: visionMock
        ? `视觉通道连的是演示用假服务（${visionModel}）；决策走本机规则引擎`
        : '火焰/烟雾由 YOLO 提供，报警与疏散由本机规则引擎给出',
      source: 'vision-only',
    }
  }
  if (discovered?.vision?.baseUrl) {
    return {
      tone: 'vision',
      chatReady: false,
      visionReady: true,
      chip: discovered.vision.mock ? 'AI · 假 YOLO' : 'AI 感知已接入',
      label: `AI 感知 · ${discovered.vision.mock ? '演示假服务' : 'YOLO'}`,
      detail: discovered.vision.mock
        ? `自动发现的视觉通道是演示用假服务（${discovered.vision.model || 'mock'}）；决策走本机规则引擎`
        : '火焰/烟雾由自动发现的 YOLO 提供，报警与疏散由本机规则引擎给出',
      source: 'vision-only',
    }
  }
  return {
    tone: 'rules',
    chatReady: false,
    visionReady: false,
    chip: 'AI 规则兜底',
    label: 'AI 兜底 · 本机规则引擎',
    detail: '没检测到本地模型：决策自动回落到本机规则引擎，仍然能给出报警、路线与疏散指令（断网也有指令）',
    source: 'rules',
  }
}

// ---------------------------------------------------------------- 探测

async function fetchJson(url, timeoutMs) {
  if (typeof fetch !== 'function') return { ok: false, reason: 'no-fetch' }
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = setTimeout(() => controller?.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller?.signal, cache: 'no-store' })
    if (!response.ok) return { ok: false, reason: `http-${response.status}` }
    return { ok: true, payload: await response.json().catch(() => null) }
  } catch (error) {
    return { ok: false, reason: String(error?.name === 'AbortError' ? 'timeout' : error?.message || error) }
  } finally {
    clearTimeout(timer)
  }
}

export async function probeChatEndpoint(baseUrl, { timeoutMs = 1200 } = {}) {
  const root = String(baseUrl || '').replace(/\/$/, '')
  if (!root) return { ok: false, reason: 'empty' }
  const result = await fetchJson(`${root}/models`, timeoutMs)
  if (!result.ok) return { ok: false, baseUrl: root, reason: result.reason }
  const model = pickModelId(result.payload)
  return { ok: true, baseUrl: root, model, models: normalizeModelIds(result.payload) }
}

export async function probeVisionEndpoint(baseUrl, { timeoutMs = 1200 } = {}) {
  const root = String(baseUrl || '').replace(/\/$/, '')
  if (!root) return { ok: false, reason: 'empty' }
  const health = await fetchJson(`${root}/health`, timeoutMs)
  if (!health.ok) return { ok: false, baseUrl: root, reason: health.reason }
  const model = String(health.payload?.model ?? health.payload?.name ?? '').trim()
  return { ok: true, baseUrl: root, model, mock: isMockModel(model) }
}

// 并行探测：谁先答应用谁，不阻塞页面渲染（调用方不要 await 在首屏路径上）
export async function discoverAiEndpoints({ timeoutMs = 1200, visionTimeoutMs = 900 } = {}) {
  const chat = await firstHit(CHAT_CANDIDATES, (candidate) => probeChatEndpoint(candidate.baseUrl, { timeoutMs }))
  const vision = await firstHit(VISION_CANDIDATES, (candidate) => probeVisionEndpoint(candidate.baseUrl, { timeoutMs: visionTimeoutMs }))
  return {
    chat: chat ? { ...chat, label: CHAT_CANDIDATES.find((item) => item.baseUrl === chat.baseUrl)?.label || '' } : null,
    vision: vision ? { ...vision, label: VISION_CANDIDATES.find((item) => item.baseUrl === vision.baseUrl)?.label || '' } : null,
    probedAt: Date.now(),
  }
}

async function firstHit(candidates, probe) {
  return new Promise((resolve) => {
    let pending = candidates.length
    let settled = false
    if (!pending) {
      resolve(null)
      return
    }
    candidates.forEach((candidate) => {
      probe(candidate).then((result) => {
        if (settled) return
        if (result?.ok) {
          settled = true
          resolve(result)
          return
        }
        pending -= 1
        if (pending === 0) resolve(null)
      }).catch(() => {
        pending -= 1
        if (!settled && pending === 0) resolve(null)
      })
    })
  })
}
