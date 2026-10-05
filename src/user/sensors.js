// FireAegis · 用户端传感器输入层
//
// 楼道里要"导航精准"，靠的是把所有输入都接进来，而不是只读一个火源。
// 这里把所有传感器通道收口成一层，界面只订阅这里、不直接读 localStorage：
//
// 【位置】优先级从高到低
//   1. thermalGuardBeaconPosition  蓝牙信标/iBeacon 实时定位（真实部署走这条）
//      { floor: 1-8, spot: 'A'|'C'|'B', nodeId?: 'C4', accuracy?: 3.5, at: 时间戳ms, source: 'ble' }
//   2. thermalGuardUserPosition    手动选点（演示用，同时是信标失效时的兜底）
//      { floor, spot }
//
// 【火情与热像】
//   3. thermalGuardFire        系统端判定的火源 { nodeId, floor, startedAt, mode }
//   4. thermalGuardTelemetry   预留：多节点实时温度（系统端 ESP32 最近一帧）
//      { at: 时间戳ms, nodes: [{ id, nodeId?, floor?, temp }] }
//   5. thermalGuardAlerts / thermalGuardDevices   报警记录、设备台账（含安装楼层）
//
// 【朝向】
//   6. deviceorientation 事件（含 iOS Safari 的 webkitCompassHeading 绝对朝向、absolute 标志）
//
// 【设置】
//   7. thermalGuardAlarmSettings   声音 / 播报 / 震动（由系统端维护）
//
// 传播方式：localStorage + storage 事件 + BroadcastChannel('thermalGuard')。
// 原生端（iOS 系统端/用户端）只要按同样的 key 与 JSON 结构写入，Web 端即时生效，
// 不需要改这一层 —— 这就是"保留所有传感器接口"的含义。

import { DEFAULT_THRESHOLDS } from '../mobile/thermal.js'
import { fuseReadings } from '../mobile/sensorFusion.js'

export const KEYS = {
  position: 'thermalGuardUserPosition',
  beacon: 'thermalGuardBeaconPosition',
  fire: 'thermalGuardFire',
  telemetry: 'thermalGuardTelemetry',
  alerts: 'thermalGuardAlerts',
  devices: 'thermalGuardDevices',
  settings: 'thermalGuardAlarmSettings',
}

export const CHANNEL_NAME = 'thermalGuard'

// 信标数据超过这个时长就视为过期，回退到手动选点
export const BEACON_TTL_MS = 90000

export const DEFAULT_SETTINGS = { sound: true, voice: true, vibrate: true }
export const DEFAULT_POSITION = { floor: 4, spot: 'C' }

const SPOT_IDS = new Set(['A', 'C', 'B'])
const FLOORS = new Set([1, 2, 3, 4, 5, 6, 7, 8])

export function readJson(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

export function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    const channel = openChannel()
    channel?.postMessage({ key, value })
  } catch {
    /* 忽略：隐私模式等场景下不可写 */
  }
}

let channel = null
function openChannel() {
  if (typeof BroadcastChannel === 'undefined') return null
  if (!channel) {
    try {
      channel = new BroadcastChannel(CHANNEL_NAME)
    } catch {
      channel = null
    }
  }
  return channel
}

// 订阅若干 key 的变化（localStorage 跨标签页 + BroadcastChannel 同源广播）
export function subscribe(keys, onChange) {
  const list = Array.isArray(keys) ? keys : [keys]
  const onStorage = (event) => {
    if (event.key && !list.includes(event.key)) return
    onChange({ key: event.key, source: 'storage' })
  }
  window.addEventListener('storage', onStorage)
  const bus = openChannel()
  const onMessage = (event) => {
    if (!event?.data?.key || !list.includes(event.data.key)) return
    onChange({ key: event.data.key, source: 'broadcast' })
  }
  bus?.addEventListener('message', onMessage)
  return () => {
    window.removeEventListener('storage', onStorage)
    bus?.removeEventListener('message', onMessage)
  }
}

export function normalizePosition(raw, fallback = DEFAULT_POSITION) {
  if (!raw) return null
  if (raw.nodeId && typeof raw.nodeId === 'string' && /^[ABC][1-8]$/.test(raw.nodeId)) {
    return { floor: Number(raw.nodeId.slice(1)), spot: raw.nodeId[0] }
  }
  const floor = Number(raw.floor)
  const spot = raw.spot
  if (!FLOORS.has(floor) || !SPOT_IDS.has(spot)) return null
  return { floor, spot }
}

export function readBeacon(nowMs = Date.now(), ttlMs = BEACON_TTL_MS) {
  const raw = readJson(KEYS.beacon, null)
  const normalized = normalizePosition(raw)
  if (!normalized) return null
  const at = Number(raw.at) || null
  if (at && nowMs - at > ttlMs) return null
  return { ...normalized, at, accuracy: Number(raw.accuracy) || null, source: raw.source || 'ble' }
}

export function readManualPosition() {
  return normalizePosition(readJson(KEYS.position, null)) || { ...DEFAULT_POSITION }
}

// 信标优先，过期或没有信标就用手动选点
export function resolvePosition(nowMs = Date.now()) {
  const beacon = readBeacon(nowMs)
  if (beacon) return { ...beacon, source: 'beacon' }
  return { ...readManualPosition(), at: null, accuracy: null, source: 'manual' }
}

export function saveManualPosition(position) {
  writeJson(KEYS.position, { floor: position.floor, spot: position.spot })
}

export function readFire() {
  return normalizeFire(readJson(KEYS.fire, null))
}

export function floorFromNodeId(nodeId) {
  const floor = Number(String(nodeId || '').replace(/\D/g, ''))
  return Number.isFinite(floor) && floor > 0 ? floor : null
}

// 火源载荷归一化：支持单个 nodeId、nodes: ['C4','C6']、sources: [{nodeId, startedAt}]
export function normalizeFire(raw) {
  if (!raw) return null
  const list = Array.isArray(raw.sources)
    ? raw.sources
    : Array.isArray(raw.nodes)
      ? raw.nodes
      : raw.nodeId
        ? [raw.nodeId]
        : []
  const startedAt = Number(raw.startedAt) || Date.now()
  const sources = list
    .map((item) => {
      if (typeof item === 'string') return { nodeId: item, startedAt }
      return { nodeId: item?.nodeId ?? null, startedAt: Number(item?.startedAt) || startedAt }
    })
    .filter((item) => item.nodeId)
  if (!sources.length) return null
  return {
    ...raw,
    sources,
    nodeId: raw.nodeId || sources[0].nodeId,
    floor: raw.floor ?? floorFromNodeId(sources[0].nodeId),
    startedAt,
    mode: raw.mode || 'live',
  }
}

// 多传感器共同定位火源：系统端判定的火源 + 热像遥测里超过高温阈值的节点。
// 每个来源带自己的 elapsedSec（后起的火按自己的时间扩散）。
// 火源 + 多传感器联合定位的完整结果。
// fire 载荷里的火源按"已判定"处理；遥测读数交给 sensorFusion 聚类+估计，
// 这样"一个火场被 3 个传感器看到"只会产生 1 处来源，并附带置信度与不确定度。
export function readHazardDetail({ fire, telemetry, thresholds, nowMs = Date.now() } = {}) {
  const resolvedFire = fire === undefined ? readFire() : normalizeFire(fire)
  const resolvedTelemetry = telemetry === undefined ? readTelemetry(nowMs) : telemetry
  const high = thresholds?.highThreshold ?? DEFAULT_THRESHOLDS.high
  const medium = thresholds?.mediumThreshold ?? DEFAULT_THRESHOLDS.medium

  const sources = []
  const seen = new Set()
  const push = (source) => {
    if (!source?.nodeId || seen.has(source.nodeId)) return
    seen.add(source.nodeId)
    sources.push(source)
  }

  resolvedFire?.sources?.forEach((item) => {
    push({ nodeId: item.nodeId, startedAt: item.startedAt ?? resolvedFire.startedAt, from: 'fire' })
  })

  const fusion = fuseReadings(resolvedTelemetry?.nodes ?? [], { high, medium })
  fusion.sources.forEach((item) => {
    push({
      nodeId: item.nodeId,
      startedAt: nowMs,
      from: 'sensor',
      confidence: item.confidence,
      uncertaintyHops: item.uncertaintyHops,
      contributors: item.contributors,
      robust: item.robust,
      maxTemp: item.maxTemp,
      label: item.label,
    })
  })

  return {
    sources: sources.map((source) => ({
      ...source,
      elapsedSec: Math.max(0, (nowMs - source.startedAt) / 1000),
    })),
    estimates: fusion.estimates,
    watch: fusion.watch,
    readings: fusion.readings,
  }
}

export function readHazardSources(options = {}) {
  return readHazardDetail(options).sources
}

export function readTelemetry(nowMs = Date.now(), ttlMs = BEACON_TTL_MS) {
  const raw = readJson(KEYS.telemetry, null)
  if (!raw?.nodes?.length) return null
  const at = Number(raw.at) || null
  if (at && nowMs - at > ttlMs) return null
  return { at, nodes: raw.nodes }
}

export function readSettings() {
  return {
    ...DEFAULT_SETTINGS,
    highThreshold: DEFAULT_THRESHOLDS.high,
    mediumThreshold: DEFAULT_THRESHOLDS.medium,
    ...readJson(KEYS.settings, {}),
  }
}

export function supportsOrientation() {
  return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window
}

// iOS Safari 需要用户手势里显式申请方向权限
export function needsOrientationPermission() {
  return supportsOrientation() && typeof DeviceOrientationEvent.requestPermission === 'function'
}

export async function requestOrientationPermission() {
  if (!needsOrientationPermission()) return true
  try {
    return (await DeviceOrientationEvent.requestPermission()) === 'granted'
  } catch {
    return false
  }
}

// 订阅手机朝向：返回 { heading, absolute, beta, gamma }
export function subscribeOrientation(onChange) {
  const onOrientation = (event) => {
    const heading = typeof event.webkitCompassHeading === 'number'
      ? event.webkitCompassHeading
      : event.alpha != null
        ? 360 - event.alpha
        : null
    onChange({
      heading,
      absolute: Boolean(event.absolute || typeof event.webkitCompassHeading === 'number'),
      beta: event.beta,
      gamma: event.gamma,
    })
  }
  window.addEventListener('deviceorientationabsolute', onOrientation, true)
  window.addEventListener('deviceorientation', onOrientation, true)
  return () => {
    window.removeEventListener('deviceorientationabsolute', onOrientation, true)
    window.removeEventListener('deviceorientation', onOrientation, true)
  }
}
