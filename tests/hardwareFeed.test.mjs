// 硬件链路：温度矩阵 → 系统统一帧、数据新鲜度判定

import { frameFromMatrix } from '../src/mobile/thermal.js'
import { describeFreshness } from '../src/shared/freshness.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`)
  else { failures += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

const matrix = (peak) => Array.from({ length: 768 }, (_, index) => {
  const x = index % 32
  const y = Math.floor(index / 32)
  const nx = x / 31
  const ny = y / 23
  const hot = peak * Math.exp(-(((nx - 0.35) ** 2 + (ny - 0.4) ** 2) / 0.02))
  return Number((27 + 2 * (1 - ny) + hot).toFixed(2))
})

console.log('[1] 硬件矩阵 → 系统统一帧')
{
  const cool = frameFromMatrix({ temperatures: matrix(6), source: '硬件 MLX90640' })
  check('帧结构与内置模拟器一致', cool.width === 32 && cool.height === 24 && cool.temperatures.length === 768)
  check('统计值齐全', Number.isFinite(cool.maxTemp) && Number.isFinite(cool.minTemp) && Number.isFinite(cool.averageTemp))
  check('常温 → 低风险', cool.risk === 'low')
  check('标注了数据来源', cool.source === '硬件 MLX90640')

  const hot = frameFromMatrix({ temperatures: matrix(60), source: '硬件 MLX90640' })
  check('火情帧 → 高风险', hot.risk === 'high', `${hot.maxTemp}`)
  check('提取出热区（供三维热感板显示）', hot.hotspots.length >= 1)
  check('热区温度不高于最高温', hot.hotspots[0].temp <= hot.maxTemp && hot.hotspots[0].temp >= hot.averageTemp)

  check('点数不对返回 null', frameFromMatrix({ temperatures: [1, 2, 3] }) === null)
  check('非数字返回 null', frameFromMatrix({ temperatures: new Array(768).fill('x') }) === null)
  check('自定义阈值生效', frameFromMatrix({ temperatures: matrix(40) }, { high: 35, medium: 30 }).risk === 'high')
}

console.log('[2] 数据新鲜度')
{
  const now = 1_000_000
  check('刚刚更新 → 在线', describeFreshness(now - 1000, now).state === 'live')
  check('超时 15 秒 → 疑似离线', describeFreshness(now - 20000, now).state === 'stale')
  check('没有任何数据 → none', describeFreshness(null, now).state === 'none')
  check('文案可读（含秒数）', describeFreshness(now - 5000, now).label.includes('秒'))
}

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
