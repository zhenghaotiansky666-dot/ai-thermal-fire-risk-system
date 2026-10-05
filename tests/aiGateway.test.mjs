// AI 网关（队友的笔记本视频流）接入层的纯逻辑单测：
// 消息归一化、标签识别、时效性判断、以及"过期数据不当作证据"这条安全边界。

import {
  GATEWAY_FRESH_MS,
  isFresh,
  normalizeGatewayPayload,
  toVisionEvidence,
} from '../src/shared/aiGateway.js'
import { fusePreventionSignals } from '../src/shared/aiPhases.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`)
  else { failures += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

const NOW = 1_800_000_000_000
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString()

console.log('[1] 网关消息归一化（队友 ai-gateway.mjs 的推送格式）')
{
  const payload = {
    camera_id: 'laptop-ai-camera',
    source: 'laptop-ai-gateway-simulator',
    risk: 'high',
    max_temp: 83.4,
    detections: [
      { class: 'smoke', confidence: 0.84, bbox: [0.2, 0.2, 0.2, 0.2] },
      { class: 'flame', confidence: 0.78, bbox: [0.5, 0.3, 0.1, 0.1] },
      { class: 'person', confidence: 0.91, bbox: [0.6, 0.3, 0.1, 0.3] },
    ],
    hotspots: [{ x: 0.6, y: 0.35, temp: 81 }],
    timestamp: iso(0),
  }
  const normalized = normalizeGatewayPayload(payload)
  check('取出火焰置信度', normalized.flame === 0.78)
  check('取出烟雾置信度', normalized.smoke === 0.84)
  check('人物目标不算火情证据', normalized.detections.length === 3 && normalized.flame !== 0.91)
  check('保留网关自己的分级', normalized.risk === 'high')
  check('保留最高温与热区', normalized.maxTemp === 83.4 && normalized.hotspots.length === 1)
  check('时间戳解析成毫秒', normalized.at === NOW)
}

console.log('[2] 标签兼容：中英文与常见写法都能认出来')
{
  const flame = normalizeGatewayPayload({ detections: [{ class: 'Fire', confidence: 0.6 }], timestamp: iso(0) })
  const smoke = normalizeGatewayPayload({ detections: [{ class: '烟雾', confidence: 0.5 }], timestamp: iso(0) })
  const multi = normalizeGatewayPayload({
    detections: [{ class: 'flame', confidence: 0.4 }, { class: 'fire', confidence: 0.72 }],
    timestamp: iso(0),
  })
  check('Fire → flame', flame.flame === 0.6)
  check('中文“烟雾” → smoke', smoke.smoke === 0.5)
  check('同类多个目标取最大置信度', multi.flame === 0.72)
  check('置信度超范围会被夹到 0–1', normalizeGatewayPayload({ detections: [{ class: 'flame', confidence: 7 }] }).flame === 1)
  check('未知类别不会污染证据', normalizeGatewayPayload({ detections: [{ class: 'car', confidence: 0.9 }] }).flame === null)
}

console.log('[3] 时效性：过期帧不能当作火情证据')
{
  check('刚到的帧是新鲜的', isFresh(NOW, NOW) === true)
  check('刚好卡在 TTL 边界算新鲜', isFresh(NOW - GATEWAY_FRESH_MS, NOW) === true)
  check('超过 TTL 算过期', isFresh(NOW - GATEWAY_FRESH_MS - 1, NOW) === false)
  check('没有时间戳不算新鲜', isFresh(null, NOW) === false)

  const fresh = toVisionEvidence({ detections: [{ class: 'flame', confidence: 0.9 }], timestamp: iso(-1000) }, { now: NOW })
  check('新鲜帧返回火焰置信度', fresh.flame === 0.9)
  check('说明里标明来源是 AI 网关', fresh.note.includes('AI 网关'))

  const stale = toVisionEvidence({ detections: [{ class: 'flame', confidence: 0.9 }], timestamp: iso(-30_000) }, { now: NOW })
  check('过期帧返回 null（不拿旧数据判火警）', stale.flame === null && stale.smoke === null)
  check('过期会说明原因', stale.note.includes('超时'))

  const offline = toVisionEvidence({ detections: [] }, { now: NOW, connected: false })
  check('未连接时返回未连接', offline.note.includes('未连接'))

  const empty = toVisionEvidence(null, { now: NOW })
  check('空负载不报错', empty.flame === null && empty.note.includes('暂无数据'))
}

console.log('[4] 无火情但有视频流时：证据为空但通道仍然在线')
{
  const calm = toVisionEvidence({ detections: [{ class: 'person', confidence: 0.9 }], risk: 'low', timestamp: iso(0) }, { now: NOW })
  check('人物不产生火焰/烟雾证据', calm.flame === null && calm.smoke === null)
  check('文案说清“未识别到火焰或烟雾”', calm.note.includes('未识别到'))
}

console.log('[5] 接进判决链：网关证据真的能改变阶段一的报警结论')
{
  const payload = {
    camera_id: 'laptop-ai-camera',
    risk: 'high',
    max_temp: 42,
    detections: [
      { class: 'flame', confidence: 0.87, bbox: [0.55, 0.34, 0.14, 0.18] },
      { class: 'smoke', confidence: 0.92, bbox: [0.22, 0.23, 0.2, 0.2] },
    ],
    timestamp: new Date(NOW).toISOString(),
  }
  const thermalOnly = { thermal: { maxTemp: 30 }, thresholds: { high: 65, medium: 45 } }

  const baseline = fusePreventionSignals({ ...thermalOnly, visual: {} })
  check('只有热像、温度正常时 → 不报警', baseline.level === 'normal')

  const visual = toVisionEvidence(payload, { now: NOW })
  const withGateway = fusePreventionSignals({ ...thermalOnly, visual })
  check('接入网关后：火焰 87% + 烟雾 92% 双路确认 → 报警', withGateway.level === 'alarm')
  check('判据里写明视觉证据', withGateway.reasons.join(' ').includes('视觉'))

  const stale = toVisionEvidence(payload, { now: NOW + GATEWAY_FRESH_MS + 1000 })
  const afterTimeout = fusePreventionSignals({ ...thermalOnly, visual: stale })
  check('网关断流后不再凭旧帧报警', afterTimeout.level !== 'alarm')

  const offline = fusePreventionSignals({ ...thermalOnly, visual: toVisionEvidence(payload, { now: NOW, connected: false }) })
  check('网关未连接时不报警', offline.level !== 'alarm')
}

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
