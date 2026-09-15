// 位置 → 警报频道（"人在附近就自动收到"）
//
// 思路：每个区域（校园、某栋楼、某个小区）对应一个警报频道。手机打开用户端并授权定位后，
// 如果当前位置落在某个区域内，就自动加入该区域的频道 —— 用户的动作只有"扫码 + 允许定位"。
//
// 频道的具体形式由云端通道决定：
//   · 原型：ntfy: 主题名（公共转发，零部署）
//   · 正式：https://你们的中继域名#分组名

import { CAMPUS_CENTER, insideCampus, latLonToLocal } from '../user/geo.js'

export const AREA_CHANNELS_KEY = 'thermalGuardAreaChannels'
export const AUTO_JOIN_KEY = 'thermalGuardAutoJoin'

// 默认区域表。演示用公开频道（主题名即暗号），正式部署请换成你们自己的中继 + 分组。
export const DEFAULT_AREAS = [
  {
    id: 'must-campus',
    label: '澳门科技大学校园',
    channel: 'ntfy:tg-must-campus-demo-2026',
    lat: CAMPUS_CENTER.lat,
    lon: CAMPUS_CENTER.lon,
    // 校园边界再加一点缓冲，校门外的马路也能收到
    radiusMeters: 700,
  },
]

function toRad(value) {
  return (value * Math.PI) / 180
}

export function haversineMeters(a, b) {
  const earth = 6371000
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * earth * Math.asin(Math.min(1, Math.sqrt(h)))
}

// 解析某个经纬度落在哪个区域（可能多个，按距离排序）
export function resolveAreas(lat, lon, areas = DEFAULT_AREAS) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return []
  const point = { lat: Number(lat), lon: Number(lon) }
  return (areas ?? [])
    .map((area) => {
      const distanceMeters = Math.round(haversineMeters(point, { lat: area.lat, lon: area.lon }))
      const local = latLonToLocal(point.lat, point.lon)
      return {
        area,
        distanceMeters,
        insideRadius: distanceMeters <= area.radiusMeters,
        insideCampusRect: area.id === 'must-campus' ? insideCampus(local.x, local.y) : false,
      }
    })
    .filter((item) => item.insideRadius || item.insideCampusRect)
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
}

export function resolveAreaChannel(lat, lon, areas) {
  const [first] = resolveAreas(lat, lon, areas)
  return first ?? null
}

// 允许通过配置文件覆盖区域表（ai-config.json 的 areaChannels 字段）
export function readAreaChannels() {
  if (typeof localStorage === 'undefined') return DEFAULT_AREAS
  try {
    const raw = JSON.parse(localStorage.getItem(AREA_CHANNELS_KEY) || 'null')
    if (Array.isArray(raw) && raw.length) return raw
  } catch {}
  return DEFAULT_AREAS
}

export function saveAreaChannels(areas) {
  if (typeof localStorage === 'undefined') return
  try {
    if (Array.isArray(areas) && areas.length) localStorage.setItem(AREA_CHANNELS_KEY, JSON.stringify(areas))
    else localStorage.removeItem(AREA_CHANNELS_KEY)
  } catch {}
}

// 自动加入开关（默认开）：允许用户关掉，避免"我不想被自动订阅"
export function isAutoJoinEnabled() {
  if (typeof localStorage === 'undefined') return true
  const raw = localStorage.getItem(AUTO_JOIN_KEY)
  return raw === null ? true : raw === '1'
}

export function setAutoJoinEnabled(enabled) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(AUTO_JOIN_KEY, enabled ? '1' : '0')
  } catch {}
}

// ---------------------------------------------------------------- 扫码进入演示
// 演示二维码里带 ?ch=频道，扫码即加入，不受网络环境影响
export function extractChannelFromSearch(search) {
  if (!search) return ''
  try {
    const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`)
    return String(params.get('ch') ?? params.get('channel') ?? params.get('join') ?? '').trim()
  } catch {
    return ''
  }
}

export function buildJoinUrl(baseUrl, channel) {
  if (!channel) return baseUrl
  const separator = baseUrl.includes('?') ? '&' : '?'
  return `${baseUrl}${separator}ch=${encodeURIComponent(channel)}`
}
