// AI 网关（笔记本端连续视频流）接入层
//
// 队友的交付是 gateway/ai-gateway.mjs + gateway/detector.py：
// 笔记本接摄像头 → YOLOv8（或 OpenCV 兜底、或模拟器）→ 通过 WebSocket
// `/ws/detections` 持续推送检测结果，消息形如：
//   { camera_id, source, risk: 'low|medium|high', max_temp,
//     detections: [{ class: 'flame|smoke|person', confidence, bbox }],
//     hotspots: [...], timestamp }
//
// 他们只把这条流"显示"在面板上（目标数）。我们这里多做一步：
// 把 flame / smoke 置信度注册进「视觉通道」，于是它会直接进入
// 阶段一的三路证据融合与报警判定（见 aiHooks.runVisionDetector 与 aiPhases.fusePreventionSignals）。
//
// 纯函数（normalizeGatewayPayload / isFresh / toVisionEvidence）都有单测。

import { registerVisionDetector } from './aiHooks.js'
import { installVisionBridgeFromSettings } from './aiClient.js'
import { FLAME_LABELS, SMOKE_LABELS } from './visionClient.js'

export const GATEWAY_URL_KEY = 'thermalGuardAIGateway'
// 默认 8899：8787 留给硬件接收端（ESP32-S3 上传可见光/热像），两者可在同一台电脑上并存
export const DEFAULT_GATEWAY_URL = 'ws://127.0.0.1:8899/ws/detections'
export const GATEWAY_FRESH_MS = 8000

function clamp01(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return Math.max(0, Math.min(1, number))
}

function matchLabel(label, candidates) {
  const text = String(label ?? '').trim().toLowerCase()
  if (!text) return false
  return candidates.some((item) => text === item || text.includes(item))
}

// 把网关的原始消息归一成我们内部用的证据结构（纯函数）
export function normalizeGatewayPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { flame: null, smoke: null, risk: 'low', maxTemp: null, detections: [], hotspots: [], cameraId: '', source: '', at: null }
  }
  const detections = Array.isArray(payload.detections)
    ? payload.detections
        .map((item) => ({
          label: String(item?.class ?? item?.label ?? item?.name ?? '').trim(),
          confidence: clamp01(item?.confidence ?? item?.conf ?? 0) ?? 0,
        }))
        .filter((item) => item.label)
    : []

  let flame = null
  let smoke = null
  for (const item of detections) {
    if (matchLabel(item.label, FLAME_LABELS)) flame = flame === null ? item.confidence : Math.max(flame, item.confidence)
    else if (matchLabel(item.label, SMOKE_LABELS)) smoke = smoke === null ? item.confidence : Math.max(smoke, item.confidence)
  }

  const maxTemp = Number(payload.max_temp ?? payload.maxTemp)
  const at = Date.parse(payload.timestamp ?? '') || null

  return {
    flame,
    smoke,
    // 网关自己给的分级（low/medium/high）——只作为参考，最终判定仍走我们的融合逻辑
    risk: ['low', 'medium', 'high'].includes(String(payload.risk)) ? String(payload.risk) : 'low',
    maxTemp: Number.isFinite(maxTemp) ? maxTemp : null,
    detections,
    hotspots: Array.isArray(payload.hotspots) ? payload.hotspots : [],
    cameraId: String(payload.camera_id ?? ''),
    source: String(payload.source ?? ''),
    at,
  }
}

export function isFresh(at, now = Date.now(), ttlMs = GATEWAY_FRESH_MS) {
  if (!Number.isFinite(Number(at))) return false
  return now - Number(at) <= ttlMs
}

// 给 runVisionDetector 用的返回值：过期的数据一律返回 null（宁可不判，也不拿旧帧当证据）
export function toVisionEvidence(payload, { now = Date.now(), ttlMs = GATEWAY_FRESH_MS, connected = true } = {}) {
  const normalized = normalizeGatewayPayload(payload)
  if (!connected) return { flame: null, smoke: null, note: 'AI 网关未连接' }
  if (!isFresh(normalized.at, now, ttlMs)) {
    return { flame: null, smoke: null, note: normalized.at ? 'AI 网关数据超时（超过 8 秒没有新帧）' : 'AI 网关暂无数据' }
  }
  const parts = []
  if (normalized.flame !== null) parts.push(`火焰 ${Math.round(normalized.flame * 100)}%`)
  if (normalized.smoke !== null) parts.push(`烟雾 ${Math.round(normalized.smoke * 100)}%`)
  const note = parts.length ? `AI 网关视频流：${parts.join(' · ')}` : 'AI 网关视频流：未识别到火焰或烟雾'
  return { flame: normalized.flame, smoke: normalized.smoke, note }
}

// ---------------------------------------------------------------- 连接与状态

const listeners = new Set()

const state = {
  url: '',
  socket: null,
  status: 'idle', // idle | connecting | connected | failed
  payload: null,
  normalized: null,
  error: '',
  received: 0,
}

function emit() {
  const snapshot = gatewayStatus()
  listeners.forEach((listener) => {
    try {
      listener(snapshot)
    } catch {
      /* 单个订阅者出错不影响其它人 */
    }
  })
}

export function readGatewayUrl() {
  try {
    return localStorage.getItem(GATEWAY_URL_KEY) || DEFAULT_GATEWAY_URL
  } catch {
    return DEFAULT_GATEWAY_URL
  }
}

// 只有"用户手动连过一次"才自动重连：公网演示站上不该自己去连 127.0.0.1
export function hasSavedGatewayUrl() {
  try {
    return Boolean(localStorage.getItem(GATEWAY_URL_KEY))
  } catch {
    return false
  }
}

export function saveGatewayUrl(url) {
  const value = String(url ?? '').trim()
  try {
    if (value) localStorage.setItem(GATEWAY_URL_KEY, value)
    else localStorage.removeItem(GATEWAY_URL_KEY)
  } catch {
    /* 隐私模式忽略 */
  }
  return value
}

export function gatewayStatus() {
  return {
    url: state.url || readGatewayUrl(),
    status: state.status,
    error: state.error,
    received: state.received,
    payload: state.payload,
    normalized: state.normalized,
    fresh: Boolean(state.normalized && isFresh(state.normalized.at)),
  }
}

export function subscribeGateway(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function connectGateway(url = readGatewayUrl()) {
  disconnectGateway({ silent: true })
  if (typeof WebSocket === 'undefined') {
    state.status = 'failed'
    state.error = '当前浏览器不支持 WebSocket'
    emit()
    return false
  }
  const target = saveGatewayUrl(url)
  state.url = target
  state.status = 'connecting'
  state.error = ''
  emit()

  try {
    const socket = new WebSocket(target)
    state.socket = socket

    socket.onopen = () => {
      state.status = 'connected'
      state.error = ''
      // 关键：把网关的火焰/烟雾置信度接进「视觉通道」→ 三路证据融合 → 报警判定
      registerVisionDetector(async () => toVisionEvidence(state.payload, { connected: true }))
      emit()
    }
    socket.onmessage = (event) => {
      let payload = null
      try {
        payload = JSON.parse(typeof event.data === 'string' ? event.data : '')
      } catch {
        return
      }
      if (!payload || payload.type === 'pong') return
      state.payload = payload
      state.normalized = normalizeGatewayPayload(payload)
      state.received += 1
      emit()
    }
    socket.onerror = () => {
      state.status = state.status === 'connected' ? 'connected' : 'failed'
      state.error = '连接出错（检查网关是否在跑、地址与端口是否正确）'
      emit()
    }
    socket.onclose = () => {
      if (state.socket !== socket) return
      state.socket = null
      state.status = 'idle'
      // 断开后把视觉通道还给"设置里的 YOLO 服务"，避免留下一个永远返回空证据的通道
      registerVisionDetector(null)
      installVisionBridgeFromSettings()
      emit()
    }
    return true
  } catch (error) {
    state.status = 'failed'
    state.error = String(error?.message ?? error)
    emit()
    return false
  }
}

export function disconnectGateway({ silent = false } = {}) {
  const socket = state.socket
  state.socket = null
  state.status = 'idle'
  if (socket) {
    try {
      socket.close()
    } catch {
      /* 忽略 */
    }
  }
  if (!silent) {
    registerVisionDetector(null)
    installVisionBridgeFromSettings()
  }
  emit()
}

// 页面打开时：如果之前配过地址且没手动断开，就自动重连一次
export function autoConnectGateway() {
  if (!hasSavedGatewayUrl()) return false
  return connectGateway(readGatewayUrl())
}
