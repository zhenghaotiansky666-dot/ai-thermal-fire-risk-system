// 本机 AI 自动发现：状态描述与模型名归一化的单测。
//
// 为什么测这些纯函数：现场"AI 到底接上没有"全靠这段状态文案来告诉操作员，
// 文案判错（例如把 demo 假服务显示成"已就绪"）会让答辩时说错话。

import {
  CHAT_CANDIDATES,
  VISION_CANDIDATES,
  describeAiStatus,
  isMockModel,
  normalizeModelIds,
  pickModelId,
} from '../src/shared/aiDiscovery.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`)
  else { failures += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('[1] 模型列表归一化：兼容 OpenAI / Ollama / 裸数组三种形状')
{
  check('OpenAI 的 {data:[{id}]}', JSON.stringify(normalizeModelIds({ data: [{ id: 'qwen2.5:7b' }] })) === JSON.stringify(['qwen2.5:7b']))
  check('Ollama 的 {models:[{name}]}', JSON.stringify(normalizeModelIds({ models: [{ name: 'llama3.1:8b' }] })) === JSON.stringify(['llama3.1:8b']))
  check('裸数组', JSON.stringify(normalizeModelIds(['a', 'b'])) === JSON.stringify(['a', 'b']))
  check('空输入不炸', normalizeModelIds(null).length === 0 && normalizeModelIds({}).length === 0)
  check('优先挑对话模型、跳过 embedding', pickModelId({ data: [{ id: 'nomic-embed-text' }, { id: 'qwen2.5:7b' }] }) === 'qwen2.5:7b')
  check('没有可选时退回第一个', pickModelId({ data: [{ id: 'nomic-embed-text' }] }) === 'nomic-embed-text')
}

console.log('[2] 假服务识别：mock-yolo.pt 必须被标出来')
{
  check('mock-yolo.pt 是假服务', isMockModel('mock-yolo.pt'))
  check('MOCK 大写也识别', isMockModel('MOCK-YOLO'))
  check('dummy 也识别', isMockModel('dummy-detector'))
  check('真权重不算假服务', !isMockModel('yolov8n.pt') && !isMockModel('fire-smoke-v3.pt'))
  check('空值不算假服务', !isMockModel('') && !isMockModel(null))
}

console.log('[3] 状态描述：四种组合都要说清楚谁在感知、谁在决策')
{
  const full = describeAiStatus({ settings: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', visionUrl: 'http://127.0.0.1:8000', visionModel: 'yolov8n.pt' } })
  check('决策+感知都就绪 → tone=full', full.tone === 'full' && full.chatReady && full.visionReady)
  check('文案里带模型名', full.label.includes('qwen2.5:7b'), full.label)

  const mock = describeAiStatus({ settings: { provider: 'custom', baseUrl: 'http://127.0.0.1:8000/v1', model: 'x', visionUrl: 'http://127.0.0.1:8000', visionModel: 'mock-yolo.pt' } })
  check('假 YOLO → tone=warn 且提醒换成真模型', mock.tone === 'warn' && mock.detail.includes('演示'), mock.detail)

  const chatOnly = describeAiStatus({ settings: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:3b' } })
  check('只有对话模型 → tone=chat（决策有、感知没有）', chatOnly.tone === 'chat' && chatOnly.chatReady && !chatOnly.visionReady)

  const visionOnly = describeAiStatus({ settings: {}, vision: { baseUrl: 'http://127.0.0.1:8000', model: 'yolov8n.pt' } })
  check('自动发现到 YOLO → tone=vision（规则引擎决策）', visionOnly.tone === 'vision' && visionOnly.visionReady && !visionOnly.chatReady)

  const rules = describeAiStatus({ settings: { provider: 'offline', baseUrl: '' } })
  check('什么都没配 → tone=rules 且强调仍然有指令', rules.tone === 'rules' && rules.detail.includes('规则引擎'))
  check('顶部状态条的短文案：rules → AI 规则兜底', rules.chip === 'AI 规则兜底', rules.chip)

  const probed = describeAiStatus({ settings: {}, discovered: { chat: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', label: 'Ollama 本机' } } })
  check('未显式配置但自动发现了对话模型 → 仍算 chat 就绪', probed.tone === 'chat' && probed.label.includes('qwen2.5:7b'), probed.label)
  check('短文案：假 YOLO 必须显眼', describeAiStatus({ settings: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'q', visionUrl: 'http://127.0.0.1:8000', visionModel: 'mock-yolo.pt' } }).chip === 'AI · 假 YOLO')
  // 现场最容易踩的坑：配置里存的是 yolov8n.pt，实际挂着的却是 mock 服务 —— 必须以实时探测为准
  const staleConfig = describeAiStatus({
    settings: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', visionUrl: 'http://127.0.0.1:8000', visionModel: 'yolov8n.pt' },
    vision: { baseUrl: 'http://127.0.0.1:8000', model: 'mock-yolo.pt', mock: true },
  })
  check('配置写 nice 名字、实测是假服务 → 仍然报假服务', staleConfig.tone === 'warn' && staleConfig.chip === 'AI · 假 YOLO', `${staleConfig.tone}/${staleConfig.chip}`)
}

console.log('[4] 探测顺序：本站代理优先，其次常见本地服务')
{
  check('第一个候选是同源 /ai/v1（HTTPS 页面下最可靠）', CHAT_CANDIDATES[0].baseUrl === '/ai/v1')
  check('包含 Ollama 11434', CHAT_CANDIDATES.some((item) => item.baseUrl.includes('11434')))
  check('包含 LM Studio 1234', CHAT_CANDIDATES.some((item) => item.baseUrl.includes('1234')))
  check('视觉候选含 8000', VISION_CANDIDATES.some((item) => item.baseUrl.includes('8000')))
}

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
