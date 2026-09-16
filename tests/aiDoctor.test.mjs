// 本地 AI 自检的判定逻辑单测：把"队友接不进去"的常见原因都覆盖一遍，
// 保证脚本给出的诊断和修复建议是对的（这些是纯函数，不需要真的跑模型）。

import {
  classifyChat,
  classifyCors,
  classifyModels,
  classifyPortCheck,
  summarize,
} from '../tools/ai-doctor.mjs'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`)
  else { failures += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('[1] 端口可达性判定')
{
  check('能连上 → pass', classifyPortCheck({ ok: true, label: '本机模型' }).level === 'pass')

  const refused = classifyPortCheck({ ok: false, error: 'fetch failed', label: '本机模型' })
  check('连不上 → fail 并提示 ollama serve', refused.level === 'fail' && refused.remedy.includes('ollama serve'))

  const lanFail = classifyPortCheck({ ok: false, error: 'timeout', label: '局域网 192.168.1.9' })
  check('局域网连不上 → 提示 OLLAMA_HOST=0.0.0.0', lanFail.remedy.includes('OLLAMA_HOST=0.0.0.0'))
  check('局域网失败还提示放行防火墙', lanFail.remedy.includes('防火墙'))

  const unauthorized = classifyPortCheck({ ok: false, status: 401, label: '本机模型' })
  check('401/403 → 提示检查密钥', unauthorized.remedy.includes('密钥'))
}

console.log('[2] CORS 判定')
{
  check('允许 * → pass', classifyCors({ 'access-control-allow-origin': '*' }).level === 'pass')
  check('允许具体来源 → pass', classifyCors({ 'access-control-allow-origin': 'https://example.com' }).level === 'pass')
  const missing = classifyCors({})
  check('没有 CORS 头 → fail', missing.level === 'fail')
  check('并给出 OLLAMA_ORIGINS 修复建议', missing.remedy.includes('OLLAMA_ORIGINS'))
  check('兼容 Headers 对象', classifyCors(new Headers({ 'access-control-allow-origin': '*' })).level === 'pass')
}

console.log('[3] 模型列表判定')
{
  const empty = classifyModels([], 'qwen2.5:7b')
  check('没有任何模型 → fail 并提示 ollama pull', empty.level === 'fail' && empty.remedy.includes('ollama pull qwen2.5:7b'))

  const exact = classifyModels(['llama3:8b', 'qwen2.5:7b'], 'qwen2.5:7b')
  check('精确命中 → pass', exact.level === 'pass' && exact.matched === 'qwen2.5:7b')

  const sameFamily = classifyModels([{ name: 'qwen2.5:3b' }], 'qwen2.5:7b')
  check('同系列不同规格 → 也能用（warn 提醒）', sameFamily.level === 'pass' && sameFamily.matched === 'qwen2.5:3b')

  const other = classifyModels(['llama3:8b'], 'qwen2.5:7b')
  check('完全没有目标模型 → warn 并给出两个选择', other.level === 'warn' && other.remedy.includes('ollama pull') && other.remedy.includes('改成'))
  check('对象形式的模型列表也能解析', classifyModels([{ id: 'qwen2.5:7b' }], 'qwen2.5:7b').level === 'pass')
}

console.log('[4] 对话测试判定')
{
  check('有返回内容 → pass', classifyChat({ ok: true, content: '可用' }).level === 'pass')
  check('404 → 提示模型名不存在', classifyChat({ ok: false, status: 404 }).remedy.includes('模型名'))
  check('400 → 提示模型名或路径前缀', classifyChat({ ok: false, status: 400 }).remedy.includes('/v1'))
  const crash = classifyChat({ ok: false, error: 'fetch failed' })
  check('连不上 → 提示看服务端日志/换小模型', crash.level === 'fail' && crash.remedy.includes('显存'))
  check('返回为空也算失败', classifyChat({ ok: true, content: '' }).level === 'fail')
}

console.log('[5] 汇总结论')
{
  const allPass = summarize([{ level: 'pass' }, { level: 'pass' }])
  check('全通过 → ok 且文案明确', allPass.ok === true && allPass.headline.includes('全部通过'))

  const withWarn = summarize([{ level: 'pass' }, { level: 'warn' }])
  check('只有警告 → 仍算可用', withWarn.ok === true && withWarn.headline.includes('需要注意'))

  const withFail = summarize([{ level: 'pass' }, { level: 'fail' }, { level: 'warn' }])
  check('有失败 → 不可用并统计数量', withFail.ok === false && withFail.fails === 1)
}

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
