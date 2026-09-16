// 视觉通道（YOLO 等检测模型）接口层
//
// 关键区别：YOLO 是"图像检测模型"，不是对话模型 —— 它没有 /v1/chat/completions。
// 所以它接的是我们的「视觉通道」（阶段一的火焰/烟雾证据），而不是「AI 指挥」的对话端点。
//
// 约定的服务接口（tools/yolo-service 里有可直接跑的模板）：
//   GET  {base}/health   → { ok: true, model: "yolov8n.pt" }
//   POST {base}/detect   → body { image: "data:image/jpeg;base64,...", conf?: 0.25 }
//                          返回 { flame?: 0-1, smoke?: 0-1, detections?: [{ label, confidence, box }] }
//
// 为了"什么 YOLO 服务都能接"，normalizeYoloResult 兼容了几种常见返回形状
// （Ultralytics 的 results 数组、{detections:[...]}、以及自定义的 {flame, smoke}）。

export const FLAME_LABELS = ['fire', 'flame', 'flames', 'burning', 'combustion', '火焰', '明火', '火']
export const SMOKE_LABELS = ['smoke', 'smog', 'fume', 'haze', '烟雾', '烟']

function matchLabel(label, candidates) {
  const text = String(label ?? '').trim().toLowerCase()
  if (!text) return false
  return candidates.some((item) => text === item || text.includes(item))
}

function collectDetections(payload) {
  if (!payload) return []
  const direct = Array.isArray(payload) ? payload
    : Array.isArray(payload.detections) ? payload.detections
      : Array.isArray(payload.results) ? payload.results
        : Array.isArray(payload.predictions) ? payload.predictions
          : []
  return direct
    .map((item) => {
      // Ultralytics 的 JSON 里既有 {name, confidence} 也有 {class, conf}
      const label = item?.label ?? item?.name ?? item?.class_name ?? item?.class ?? item?.cls ?? ''
      const confidence = Number(item?.confidence ?? item?.conf ?? item?.score ?? 0)
      return { label: String(label), confidence: Number.isFinite(confidence) ? confidence : 0 }
    })
    .filter((item) => item.label)
}

// 纯函数：把各种 YOLO 返回统一成 { flame, smoke, detections }
export function normalizeYoloResult(payload) {
  if (!payload || typeof payload !== 'object') return { flame: null, smoke: null, detections: [], source: 'yolo' }

  // 服务直接给了置信度（我们推荐的契约）
  const directFlame = payload.flame ?? payload.fire
  const directSmoke = payload.smoke
  const detections = collectDetections(payload)

  const fromDetections = (matcher) => {
    const hits = detections.filter((item) => matcher(item.label))
    if (!hits.length) return null
    return Math.max(...hits.map((item) => item.confidence))
  }

  const flame = Number.isFinite(Number(directFlame)) ? Number(directFlame) : fromDetections((label) => matchLabel(label, FLAME_LABELS))
  const smoke = Number.isFinite(Number(directSmoke)) ? Number(directSmoke) : fromDetections((label) => matchLabel(label, SMOKE_LABELS))

  const clamp = (value) => (value === null || value === undefined ? null : Math.max(0, Math.min(1, Number(value))))
  return {
    flame: clamp(flame),
    smoke: clamp(smoke),
    detections,
    model: payload.model ?? null,
    source: 'yolo',
  }
}

export function buildVisionPromptSummary(result, context = {}) {
  if (!result) return '视觉通道没有返回结果'
  const parts = []
  if (result.flame !== null) parts.push(`火焰 ${Math.round(result.flame * 100)}%`)
  if (result.smoke !== null) parts.push(`烟雾 ${Math.round(result.smoke * 100)}%`)
  if (result.detections?.length) parts.push(`${result.detections.length} 个检测框`)
  return parts.join(' · ') || `视觉通道已连接（${context.model ?? '未报模型名'}）`
}

// 真实调用：失败不抛异常，交给上层回落
export async function detectWithVision(image, settings = {}) {
  const base = String(settings.visionUrl ?? '').replace(/\/$/, '')
  if (!base || !image) return { ok: false, reason: 'vision-not-configured' }
  const body = {
    image,
    ...(settings.visionModel ? { model: settings.visionModel } : {}),
    ...(Number.isFinite(Number(settings.visionConf)) ? { conf: Number(settings.visionConf) } : {}),
  }
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = setTimeout(() => controller?.abort(), Number(settings.visionTimeoutMs) || 8000)
  try {
    const response = await fetch(`${base}/detect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(settings.visionKey ? { Authorization: `Bearer ${settings.visionKey}` } : {}) },
      body: JSON.stringify(body),
      signal: controller?.signal,
    })
    if (!response.ok) return { ok: false, reason: `vision-http-${response.status}` }
    const payload = await response.json().catch(() => null)
    const normalized = normalizeYoloResult(payload)
    return { ok: true, ...normalized, note: buildVisionPromptSummary(normalized, { model: normalized.model }) }
  } catch (error) {
    return { ok: false, reason: `vision-${String(error?.message ?? error).slice(0, 60)}` }
  } finally {
    clearTimeout(timer)
  }
}

export async function probeVision(settings = {}) {
  const base = String(settings.visionUrl ?? '').replace(/\/$/, '')
  if (!base) return { ok: false, reason: 'vision-not-configured' }
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = setTimeout(() => controller?.abort(), 3000)
  try {
    const response = await fetch(`${base}/health`, { signal: controller?.signal, cache: 'no-store' })
    if (!response.ok) return { ok: false, reason: `vision-health-${response.status}` }
    const payload = await response.json().catch(() => ({}))
    return { ok: true, model: payload?.model ?? null, raw: payload }
  } catch (error) {
    return { ok: false, reason: `vision-${String(error?.message ?? error).slice(0, 60)}` }
  } finally {
    clearTimeout(timer)
  }
}
