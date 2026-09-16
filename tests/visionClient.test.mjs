// YOLO 视觉通道单测：各种返回形状的归一化 + 服务类型识别

import { buildVisionPromptSummary, normalizeYoloResult } from '../src/shared/visionClient.js'
import { classifyServiceShape } from '../tools/ai-doctor.mjs'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`)
  else { failures += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('[1] 归一化：我们推荐的契约')
{
  const result = normalizeYoloResult({ flame: 0.82, smoke: 0.35, model: 'yolov8n.pt' })
  check('直接给置信度时原样使用', result.flame === 0.82 && result.smoke === 0.35)
  check('带回模型名', result.model === 'yolov8n.pt')
  check('摘要可读', buildVisionPromptSummary(result).includes('火焰 82%'))
}

console.log('[2] 归一化：Ultralytics / 常见 YOLO 返回')
{
  const ultralytics = normalizeYoloResult({
    results: [
      { name: 'fire', confidence: 0.91 },
      { name: 'smoke', confidence: 0.42 },
      { name: 'person', confidence: 0.99 },
    ],
  })
  check('从 results 里取火焰/烟雾最高置信度', ultralytics.flame === 0.91 && ultralytics.smoke === 0.42)
  check('不相关的类别被忽略', ultralytics.detections.length === 3 && ultralytics.flame < 0.99)

  const shortKeys = normalizeYoloResult({ detections: [{ class: 'flame', conf: 0.77 }, { cls: '烟', conf: 0.5 }] })
  check('兼容 conf / class / cls 字段', shortKeys.flame === 0.77 && shortKeys.smoke === 0.5)

  const chinese = normalizeYoloResult({ detections: [{ label: '明火', confidence: 0.6 }] })
  check('中文类别名也能识别', chinese.flame === 0.6 && chinese.smoke === null)

  const none = normalizeYoloResult({ detections: [] })
  check('没有命中时给出 null（而不是 0）', none.flame === null && none.smoke === null)

  const bad = normalizeYoloResult(null)
  check('空返回不崩', bad.flame === null && Array.isArray(bad.detections))

  const clamped = normalizeYoloResult({ flame: 1.4, smoke: -0.2 })
  check('置信度夹到 0–1', clamped.flame === 1 && clamped.smoke === 0)
}

console.log('[3] 服务类型识别（填错地方要能点出来）')
{
  const chat = classifyServiceShape({ modelsOk: true, modelsStatus: 200, healthOk: false, detectOk: false })
  check('有 /v1/models → 对话模型', chat.kind === 'chat' && chat.level === 'pass')

  const vision = classifyServiceShape({ modelsOk: false, modelsStatus: 404, healthOk: true, detectOk: true })
  check('health+detect 通、models 404 → 视觉服务', vision.kind === 'vision')
  check('并提示改填到「视觉通道（YOLO）」', vision.remedy.includes('视觉通道'))

  const visionNoDetect = classifyServiceShape({ modelsOk: false, modelsStatus: 404, healthOk: true, detectOk: false })
  check('只有 health 响应也能认出是视觉服务', visionNoDetect.kind === 'vision')

  const unknown = classifyServiceShape({ modelsOk: false, modelsStatus: 0, healthOk: false, detectOk: false })
  check('两者都不像 → unknown 并提示检查监听地址', unknown.kind === 'unknown' && unknown.remedy.includes('0.0.0.0'))
}

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
