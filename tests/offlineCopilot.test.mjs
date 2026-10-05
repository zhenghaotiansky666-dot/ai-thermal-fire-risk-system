// 队友交付的离线 AI 决策树（ai/offline_copilot.c）在网页端的等价实现单测
// 期望值直接按 C 源码逐条写：is_blocked>0.5 → BLOCK；temp>60 或 smoke>80 → BLOCK；其余 PASS

import {
  COPILOT_THRESHOLDS,
  copilotFromEvidence,
  runOfflineCopilot,
} from '../src/shared/offlineCopilot.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`)
  else { failures += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('[1] 规则 1：视觉通道受阻直接封路')
{
  const verdict = runOfflineCopilot({ smoke: 0, temp: 25, rate: 0, isBlocked: 1 })
  check('is_blocked=1 → BLOCK', verdict.block === true && verdict.value === 1)
  check('返回动作是 BLOCK', verdict.action === 'BLOCK')
  check('说明里点出视觉受阻', verdict.reason.includes('视觉'))
  check('特征顺序是 [smoke,temp,rate,isBlocked]', verdict.features.join(',') === '0,25,0,1')
}

console.log('[2] 规则 2：温度或烟雾越线')
{
  check('温度 61°C → BLOCK', runOfflineCopilot({ temp: 61 }).block === true)
  check('温度恰好 60°C → 不封（C 里是 > 60）', runOfflineCopilot({ temp: 60 }).block === false)
  check('烟雾 81 → BLOCK', runOfflineCopilot({ smoke: 81 }).block === true)
  check('烟雾恰好 80 → 不封', runOfflineCopilot({ smoke: 80 }).block === false)
  check('温度越线的说明带温度', runOfflineCopilot({ temp: 88.4 }).reason.includes('88.4'))
}

console.log('[3] 规则 3：正常情况放行')
{
  const verdict = runOfflineCopilot({ smoke: 20, temp: 31, rate: 0.3, isBlocked: 0 })
  check('都正常 → PASS', verdict.block === false && verdict.value === 0)
  check('返回动作是 PASS', verdict.action === 'PASS')
  check('空输入不会崩', runOfflineCopilot().action === 'PASS')
  check('阈值常量与 C 一致', COPILOT_THRESHOLDS.tempC === 60 && COPILOT_THRESHOLDS.smoke === 80 && COPILOT_THRESHOLDS.blocked === 0.5)
}

console.log('[4] 现场证据 → 决策树特征')
{
  const hot = copilotFromEvidence({ thermal: { maxTemp: 72, ror: 3.2 }, visual: { smoke: 0.1 } })
  check('热像 72°C 直接封路', hot.block === true)
  check('温升速率被带上（不做判据但保留）', hot.input.rate === 3.2)
  check('特征映射正确', hot.input.temp === 72 && hot.input.smoke === 10)

  const smoky = copilotFromEvidence({ thermal: { maxTemp: 30 }, visual: { smoke: 0.9 } })
  check('视觉烟雾 90% → 90，越线封路', smoky.block === true && smoky.input.smoke === 90)

  const sensor = copilotFromEvidence({ thermal: { maxTemp: 30 }, visual: { smoke: 0.9 }, smokeSensor: 40 })
  check('有烟感原始读数时优先用烟感', sensor.input.smoke === 40 && sensor.block === false)

  const blocked = copilotFromEvidence({ thermal: { maxTemp: 28 }, visual: {}, isBlocked: true })
  check('通道受阻优先于温度', blocked.block === true && blocked.reason.includes('受阻'))
}

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
if (failures > 0) process.exitCode = 1
