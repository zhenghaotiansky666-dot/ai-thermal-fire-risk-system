// AI 配置配对：把「端点 + 模型名」打包成一段可扫码的链接
//
// 场景：跑模型的机器上点「生成配对二维码」，另一台电脑/手机扫码打开本系统，
// 自动把「AI 指挥」里的端点与模型填好 —— 不用手输 IP，也不用问"你那台机器 IP 是多少"。
//
// 纯函数，便于单测；真正的读写走 aiClient 的 saveAiSettings。

export const AI_PAIR_PARAM = 'ai'

function toBase64Url(text) {
  const bytes = typeof TextEncoder !== 'undefined'
    ? new TextEncoder().encode(text)
    : Uint8Array.from(unescape(encodeURIComponent(text)).split('').map((char) => char.charCodeAt(0)))
  let binary = ''
  bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
  const base64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64')
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(code) {
  const padded = String(code).replace(/-/g, '+').replace(/_/g, '/')
  const withPad = padded + '='.repeat((4 - (padded.length % 4)) % 4)
  const binary = typeof atob === 'function' ? atob(withPad) : Buffer.from(withPad, 'base64').toString('binary')
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return typeof TextDecoder !== 'undefined' ? new TextDecoder().decode(bytes) : decodeURIComponent(escape(binary))
}

export function encodeAiPairing({ baseUrl = '', model = '', vision = false, label = '' } = {}) {
  const payload = { v: 1, baseUrl: String(baseUrl), model: String(model), vision: Boolean(vision), label: String(label).slice(0, 24) }
  return toBase64Url(JSON.stringify(payload))
}

export function decodeAiPairing(code) {
  if (!code) return null
  try {
    const parsed = JSON.parse(fromBase64Url(String(code).trim()))
    if (!parsed || typeof parsed !== 'object') return null
    const baseUrl = String(parsed.baseUrl ?? '').trim()
    if (!baseUrl) return null
    return {
      baseUrl,
      model: String(parsed.model ?? '').trim(),
      vision: Boolean(parsed.vision),
      label: String(parsed.label ?? '').slice(0, 24),
    }
  } catch {
    return null
  }
}

export function extractAiPairingFromSearch(search) {
  if (!search) return null
  try {
    const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`)
    return decodeAiPairing(params.get(AI_PAIR_PARAM))
  } catch {
    return null
  }
}

export function buildAiPairUrl(baseUrl, pairing) {
  if (!baseUrl || !pairing) return baseUrl
  const code = encodeAiPairing(pairing)
  const separator = baseUrl.includes('?') ? '&' : '?'
  return `${baseUrl}${separator}${AI_PAIR_PARAM}=${code}`
}
