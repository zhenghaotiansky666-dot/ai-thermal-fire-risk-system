// AI 配置配对（扫码填端点/模型）与局域网发现的纯逻辑单测

import {
  buildAiPairUrl,
  decodeAiPairing,
  encodeAiPairing,
  extractAiPairingFromSearch,
} from '../src/shared/aiPairing.js'
import { candidateUrls, hostsInSubnet, rankCandidates } from '../tools/find-model-server.mjs'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`)
  else { failures += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('[1] 配对码编解码')
{
  const code = encodeAiPairing({ baseUrl: 'http://192.168.1.20:11434/v1', model: 'qwen2.5:7b', vision: true, label: '热感哨兵 AI' })
  check('生成的是 URL 安全字符串', !/[\s+/=]/.test(code))
  const back = decodeAiPairing(code)
  check('往返一致（端点）', back.baseUrl === 'http://192.168.1.20:11434/v1')
  check('往返一致（模型与读图开关）', back.model === 'qwen2.5:7b' && back.vision === true)
  check('没有任何路径泄漏 IP 以外的信息', Object.keys(back).sort().join(',') === 'baseUrl,label,model,vision')
  check('乱码返回 null', decodeAiPairing('这不是配对码') === null)
  check('空值返回 null', decodeAiPairing('') === null && decodeAiPairing(null) === null)
  check('缺少端点也算无效', decodeAiPairing(encodeAiPairing({ model: 'x' })) === null)
}

console.log('[2] 从扫码链接里取配置')
{
  const pairing = { baseUrl: '/ai/v1', model: 'qwen2.5:7b' }
  const url = buildAiPairUrl('http://192.168.1.5:4173/mobile-app.html', pairing)
  check('链接里带上了 ai 参数', url.includes('?ai='))
  const parsed = extractAiPairingFromSearch(url.slice(url.indexOf('?')))
  check('能从链接里解出来', parsed?.baseUrl === '/ai/v1' && parsed?.model === 'qwen2.5:7b')
  check('没有参数时返回 null', extractAiPairingFromSearch('?foo=1') === null)
  check('已有查询参数时用 & 拼接', buildAiPairUrl('http://x/y.html?a=1', pairing).includes('&ai='))
}

console.log('[3] 局域网发现')
{
  const hosts = hostsInSubnet('192.168.1.37')
  check('生成 /24 的主机地址', hosts.length === 254 && hosts[0] === '192.168.1.1' && hosts.at(-1) === '192.168.1.254')
  check('非法 IP 返回空', hostsInSubnet('abc').length === 0 && hostsInSubnet('1.2.3').length === 0)

  const urls = candidateUrls('192.168.1.20')
  check('覆盖常见模型端口', urls.some((u) => u.includes(':11434')) && urls.some((u) => u.includes(':1234')) && urls.some((u) => u.includes(':8000')))

  const ranked = rankCandidates([
    { url: 'http://a:8080/v1/models' },
    { url: 'http://a:1234/v1/models' },
    { url: 'http://a:11434/v1/models' },
  ])
  check('排序把 Ollama 排最前、通用端口排最后', ranked[0].url.includes('11434') && ranked.at(-1).url.includes('8080'))
}

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
