// 「只装 YOLO 也能做决策」这条链路的单测：
// 感知（视觉证据）→ 规则决策文案；以及决策层对"没有对话模型"的处理。

import { localDecision } from '../src/shared/aiClient.js'
import { fusePreventionSignals } from '../src/shared/aiPhases.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`)
  else { failures += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('[1] 没有对话模型时：规则引擎仍给出完整决策')
{
  const decision = localDecision({
    fire: { nodeId: 'A4', floor: 4 },
    route: { ok: true, meters: 76, exitLabel: '1 楼大堂正门' },
    position: { floor: 4, spot: 'C' },
  })
  check('有 source=offline-rules 标记', decision.source === 'offline-rules')
  check('给出撤离动作与出口', decision.action.includes('1 楼大堂正门'))
  check('给出分步指令', typeof decision.instruction === 'string' && decision.instruction.length > 0)
  check('urgency 为立即撤离', decision.urgency === 'immediate')
  check('未配置感知时不写视觉证据', !decision.summary.includes('视觉火焰'))
}

console.log('[2] 只装了 YOLO（没有对话模型）：视觉证据进入决策文案')
{
  const decision = localDecision({
    fire: { nodeId: 'A4', floor: 4 },
    route: { ok: true, meters: 76, exitLabel: '1 楼大堂正门' },
    position: { floor: 4, spot: 'C' },
    perception: { flame: 0.82, smoke: 0.35, source: 'yolo' },
  })
  check('summary 里带火焰置信度', decision.summary.includes('视觉火焰 82%'), decision.summary)
  check('summary 里带烟雾置信度', decision.summary.includes('烟雾 35%'), decision.summary)
  check('标注感知来源为 yolo', decision.perception === 'yolo')
  check('决策来源仍是本机规则（因为没配对话模型）', decision.source === 'offline-rules')
}

console.log('[3] YOLO 证据参与"该不该报警"的判定')
{
  // 热像正常，但视觉识别到明火 + 烟雾 → 三路证据里有两路，应该报警
  const withVision = fusePreventionSignals({
    thermal: { maxTemp: 33, ror: 0.4, sustainedSec: 0 },
    visual: { flame: 0.9, smoke: 0.6 },
  })
  check('热像正常但视觉有火有烟 → 报警', withVision.alarm === true, JSON.stringify(withVision.evidence.sources))

  const thermalOnly = fusePreventionSignals({ thermal: { maxTemp: 33, ror: 0.4, sustainedSec: 0 } })
  check('只有热像且正常 → 不报警', thermalOnly.alarm === false)
  check('两种情况的判据得分不同', withVision.score > thermalOnly.score)
}

console.log('[4] 感知来源标注')
{
  const silent = localDecision({})
  check('无火情时也能返回值守状态', silent.summary.includes('值守'))
  const thermalOnly = localDecision({ fire: { nodeId: 'C4', floor: 4 }, route: { ok: true, meters: 30, exitLabel: '南门' }, perception: { source: 'thermal-only' } })
  check('感知来源可透传给界面', thermalOnly.perception === 'thermal-only')
}

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
