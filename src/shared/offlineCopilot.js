// 队友交付的「离线 AI 决策树」在浏览器里的同一套实现
//
// 对应 ai/offline_copilot.c（由 ai/train-and-export.py 依据 ai/fire_dataset.csv 生成），
// 输入输出与 C 版本完全一致，这样网页端、原生端、硬件端拿到的是同一个判据：
//
//   input = [smoke, temp, rate, is_blocked]
//   返回 0 = PASS（可通行） / 1 = BLOCK（封路、换一条）
//
// 规则（与生成的 C 代码逐条对应）：
//   1) 视觉通道受阻（is_blocked > 0.5）→ 直接 BLOCK；
//   2) 温度 > 60°C 或 烟雾 > 80       → BLOCK；
//   3) 其余                          → PASS。

export const COPILOT_THRESHOLDS = { blocked: 0.5, tempC: 60, smoke: 80 }
export const COPILOT_FEATURES = ['smoke', 'temp', 'rate', 'isBlocked']

const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback)

// 纯函数：与 run_offline_ai(double* input) 逐行对应
export function runOfflineCopilot(input = {}) {
  const smoke = num(input.smoke)
  const temp = num(input.temp)
  const rate = num(input.rate)
  const isBlocked = num(input.isBlocked)
  const features = [smoke, temp, rate, isBlocked]

  if (isBlocked > COPILOT_THRESHOLDS.blocked) {
    return { block: true, value: 1, action: 'BLOCK', features, reason: '视觉判定通道受阻，封路改道' }
  }
  if (temp > COPILOT_THRESHOLDS.tempC) {
    return { block: true, value: 1, action: 'BLOCK', features, reason: `温度 ${temp.toFixed(1)}°C 超过 ${COPILOT_THRESHOLDS.tempC}°C` }
  }
  if (smoke > COPILOT_THRESHOLDS.smoke) {
    return { block: true, value: 1, action: 'BLOCK', features, reason: `烟雾 ${smoke.toFixed(0)} 超过 ${COPILOT_THRESHOLDS.smoke}` }
  }
  return { block: false, value: 0, action: 'PASS', features, reason: '温度、烟雾与视觉通道均正常，可通行' }
}

// 把现场证据映射成决策树要的四个特征，避免各处自己换算。
// smoke：优先用烟感原始读数；没有烟感时用视觉通道的烟雾置信度（0-1 → 0-100）。
export function copilotFromEvidence({ thermal = {}, visual = {}, smokeSensor = null, isBlocked = false } = {}) {
  const temp = num(thermal.maxTemp, 0)
  const rate = num(thermal.ror, 0)
  const smoke = smokeSensor != null
    ? num(smokeSensor, 0)
    : (num(visual.smoke, 0) * 100)
  const verdict = runOfflineCopilot({ smoke, temp, rate, isBlocked })
  return { ...verdict, input: { smoke, temp, rate, isBlocked: num(isBlocked) ? 1 : 0 } }
}
