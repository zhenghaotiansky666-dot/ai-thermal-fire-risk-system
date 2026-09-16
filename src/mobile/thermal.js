// 热像仪数据源：内置模拟工况、温度配色与风险分级
//
// 三种模拟工况让演示可以复现完整的「正常 → 升温 → 火警」过程，
// 而不是一打开页面就恒为高风险。接入真实 ESP32 后由 normalizePacket 接管。

export const DEFAULT_THRESHOLDS = { high: 65, medium: 45 }

export const SIM_PROFILES = [
  { id: 'normal', label: '正常运行', hint: '室温稳定，低风险' },
  { id: 'warming', label: '缓慢升温', hint: '约 10 秒内从低风险升到高风险' },
  { id: 'fire', label: '高温火情', hint: '持续高风险，用于完整演示' },
]

export function riskFromMaxTemp(maxTemp, thresholds = DEFAULT_THRESHOLDS) {
  if (maxTemp >= thresholds.high) return 'high'
  if (maxTemp >= thresholds.medium) return 'medium'
  return 'low'
}

export function temperatureColor(value) {
  const stops = [
    [0, [7, 13, 30]],
    [0.24, [32, 28, 93]],
    [0.44, [125, 23, 84]],
    [0.62, [220, 38, 50]],
    [0.78, [249, 115, 22]],
    [0.9, [250, 204, 21]],
    [1, [255, 251, 220]],
  ]
  const t = Math.max(0, Math.min(1, value))
  let left = stops[0]
  let right = stops[stops.length - 1]
  for (let i = 1; i < stops.length; i += 1) {
    if (t <= stops[i][0]) {
      left = stops[i - 1]
      right = stops[i]
      break
    }
  }
  const span = Math.max(right[0] - left[0], 0.001)
  const p = (t - left[0]) / span
  return left[1].map((channel, i) => Math.round(channel + (right[1][i] - channel) * p))
}

function profileGain(phase, profile) {
  if (profile === 'fire') return 1
  if (profile === 'warming') return 0.08 + 0.62 * Math.min(phase / 40, 1)
  return 0.05
}

// 从温度矩阵提取热区，替代写死的框选位置，热区数量随工况自然变化。
// 阈值同时要求「明显高于全画幅均温」和「接近本帧最高温」，
// 否则室温画面会把整块画面都当成热区。
function detectHotspots(width, height, temperatures, maxTemp, averageTemp) {
  const threshold = Math.max(averageTemp + 6, maxTemp - 24)
  const candidates = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const temp = temperatures[y * width + x]
      if (temp >= threshold) candidates.push({ x, y, temp })
    }
  }
  candidates.sort((a, b) => b.temp - a.temp)

  const picked = []
  for (const cell of candidates) {
    if (picked.length >= 3) break
    if (picked.some((spot) => Math.abs(spot.x - cell.x) < 5 && Math.abs(spot.y - cell.y) < 5)) continue
    picked.push(cell)
  }

  return picked.map((cell) => ({
    x: Math.max(2, Math.min(80, (cell.x / width) * 100 - 8)),
    y: Math.max(2, Math.min(74, (cell.y / height) * 100 - 10)),
    w: 18,
    h: 22,
    temp: cell.temp,
  }))
}

// 把任意来源的 32×24 温度矩阵包装成系统统一的 frame 结构。
// 硬件（MLX90640 经 Wi-Fi 上传）走的就是这条路：帧格式与内置模拟器完全一致，
// 于是三维热感板、报警阈值、危险场与疏散算法都不需要改。
export function frameFromMatrix({ width = 32, height = 24, temperatures, source = '外部热像源', timestamp } = {}, thresholds = DEFAULT_THRESHOLDS) {
  const list = Array.isArray(temperatures) ? temperatures.map(Number) : []
  if (list.length !== width * height || list.some((value) => !Number.isFinite(value))) {
    return null
  }
  const maxTemp = Math.max(...list)
  const minTemp = Math.min(...list)
  const averageTemp = list.reduce((sum, value) => sum + value, 0) / list.length
  return {
    width,
    height,
    temperatures: list,
    minTemp,
    maxTemp,
    averageTemp,
    risk: riskFromMaxTemp(maxTemp, thresholds),
    hotspots: detectHotspots(width, height, list, maxTemp, averageTemp),
    source,
    timestamp: timestamp ? new Date(timestamp) : new Date(),
  }
}

export function createFrame(phase = 0, profile = 'normal') {
  const width = 32
  const height = 24
  const gain = profileGain(phase, profile)
  const temperatures = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const nx = x / (width - 1)
      const ny = y / (height - 1)
      const drift = Math.sin(phase * 0.055) * 4
      const second = Math.cos(phase * 0.031) * 3
      const base = 27.5 + 3.5 * (1 - ny) + 0.9 * Math.sin(nx * 8)
      const hotA = (60 + drift) * gain * Math.exp(-((nx - 0.35) ** 2 + (ny - 0.34) ** 2) / 0.019)
      const hotB = (39 + second) * gain * Math.exp(-((nx - 0.72) ** 2 + (ny - 0.28) ** 2) / 0.027)
      const hotC = (21 + drift * 0.4) * gain * Math.exp(-((nx - 0.79) ** 2 + (ny - 0.70) ** 2) / 0.031)
      temperatures.push(base + hotA + hotB + hotC)
    }
  }
  const maxTemp = Math.max(...temperatures)
  const minTemp = Math.min(...temperatures)
  const averageTemp = temperatures.reduce((sum, value) => sum + value, 0) / temperatures.length
  return {
    width,
    height,
    temperatures,
    minTemp,
    maxTemp,
    averageTemp,
    risk: riskFromMaxTemp(maxTemp),
    hotspots: detectHotspots(width, height, temperatures, maxTemp, averageTemp),
    source: `模拟热像仪 · ${SIM_PROFILES.find((item) => item.id === profile)?.label || '正常运行'}`,
    timestamp: new Date(),
  }
}

export function normalizePacket(packet) {
  const width = Number(packet.width || 32)
  const height = Number(packet.height || 24)
  let temperatures = Array.isArray(packet.temperatures) ? packet.temperatures.map(Number) : []
  if (temperatures.length !== width * height) temperatures = createFrame().temperatures
  const maxTemp = Number(packet.max_temp ?? packet.maxTemp ?? Math.max(...temperatures))
  const minTemp = Number(packet.min_temp ?? packet.minTemp ?? Math.min(...temperatures))
  const averageTemp = temperatures.reduce((sum, value) => sum + value, 0) / temperatures.length
  const hotspots = (packet.hotspots || []).map((spot) => ({
    x: Number(spot.x || 0) * 100,
    y: Number(spot.y || 0) * 100,
    w: Number(spot.width || 0.15) * 100,
    h: Number(spot.height || 0.18) * 100,
    temp: Number(spot.temp ?? maxTemp),
  }))
  return {
    width,
    height,
    temperatures,
    maxTemp,
    minTemp,
    averageTemp,
    hotspots,
    risk: riskFromMaxTemp(maxTemp),
    source: packet.source || 'ESP32 设备',
    timestamp: new Date(),
  }
}
