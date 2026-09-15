// 两端事件总线（离线优先）
//
// 问题：火场里网络设备可能被烧坏、Wi-Fi 被干扰，公网也未必通。
// 所以这里把"用户端 ↔ 系统端"的消息做成三级链路，能用哪级用哪级，全部不可用时还能人工递码：
//
//   L1 同屏/同浏览器   ：BroadcastChannel + localStorage（同一台设备开两个页面时最稳，零依赖）
//   L2 局域网中继      ：站点所在局域网内的 /sync/* 中继（本地服务器，不需要互联网）
//                       配合 `node tools/local-ai-server.mjs` 使用；手机连现场热点即可互通
//   L3 离线码（人工）  ：把事件编成一段短码，系统端显示成二维码，用户端扫码/粘贴导入
//                       完全不需要任何网络，代价是需要人拿着手机扫一下
//
// 事件结构（也是离线码的内容）：
//   { v:1, id, kind:'fire'|'clear'|'notice'|'status'|'report', at, ttl, from, payload }
//
// 本文件里纯函数（编解码、去重合并、链路判定）可以单测；运行时部分只在浏览器里有副作用。

export const EVENT_VERSION = 1
export const EVENT_LIMIT = 60
export const DEFAULT_TTL_MS = 30 * 60 * 1000
export const RELAY_BASE_KEY = 'thermalGuardRelayBase'
export const CLOUD_CHANNEL_KEY = 'thermalGuardCloudChannel'
export const STORAGE_KEY = 'thermalGuardFire' // 与旧版兼容：火情事件仍写入这个键
export const BULK_STORAGE_KEY = 'thermalGuardEventLog'
export const NTFY_BASE = 'https://ntfy.sh'

const KINDS = new Set(['fire', 'clear', 'notice', 'status', 'report'])

// 拼接查询参数：云端通道可能自带 ?topic=xxx，不能再塞一个问号
export function withQuery(url, params = {}) {
  const pairs = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
  if (!pairs.length) return url
  return `${url}${url.includes('?') ? '&' : '?'}${pairs.join('&')}`
}

// ---------------------------------------------------------------- 纯函数：事件
export function createEvent(kind, payload = {}, options = {}) {
  if (!KINDS.has(kind)) throw new Error(`unknown-event-kind:${kind}`)
  const at = Number(options.at) || Date.now()
  return {
    v: EVENT_VERSION,
    id: options.id ?? `${kind}-${at.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    at,
    ttl: Number(options.ttl) || DEFAULT_TTL_MS,
    from: options.from ?? 'unknown',
    payload,
  }
}

export function isExpired(event, now = Date.now()) {
  if (!event) return true
  if (!Number.isFinite(Number(event.at))) return true
  return now - Number(event.at) > (Number(event.ttl) || DEFAULT_TTL_MS)
}

// 去重（按 id）+ 丢弃过期 + 只留最近 N 条（按时间正序返回）
export function mergeEvents(list = [], incoming = [], options = {}) {
  const now = Number(options.now) || Date.now()
  const limit = Number(options.limit) || EVENT_LIMIT
  const map = new Map()
  ;[...list, ...(Array.isArray(incoming) ? incoming : [incoming])].forEach((event) => {
    if (!event?.id || isExpired(event, now)) return
    const previous = map.get(event.id)
    if (!previous || Number(event.at) >= Number(previous.at)) map.set(event.id, event)
  })
  return [...map.values()].sort((a, b) => a.at - b.at).slice(-limit)
}

// 火情事件 → 传感器层使用的旧结构（保持向后兼容，用户端不用改读取方式）
export function fireFromEvent(event) {
  if (!event || event.kind !== 'fire') return null
  const payload = event.payload ?? {}
  if (!payload.nodeId) return null
  return {
    nodeId: payload.nodeId,
    floor: payload.floor ?? null,
    startedAt: Number(payload.startedAt) || event.at,
    mode: payload.mode ?? 'live',
    ...(Array.isArray(payload.nodes) && payload.nodes.length > 1 ? { nodes: payload.nodes } : {}),
  }
}

// 用户端上报 → 系统端横幅用的摘要（纯函数，便于单测）
// 区分"看到明火"（疑似火情，系统端应优先处置）与一般求助/隐患。
const FIRE_WORDS = ['明火', '火光', '着火', '起火', '冒烟', '浓烟', '看到火']

export function peerReportSummary(event) {
  if (!event || event.kind !== 'report') return null
  const payload = event.payload ?? {}
  const text = String(payload.text ?? payload.notice ?? '').trim()
  const fireSeen = FIRE_WORDS.some((word) => text.includes(word))
  const floor = payload.floor ?? null
  const spot = payload.spot ?? null
  return {
    id: event.id,
    at: event.at,
    floor,
    spot,
    text: text || '用户端上报火源或异常',
    fireSeen,
    severity: fireSeen ? 'fire' : 'help',
    label: fireSeen ? '疑似火情（用户上报）' : '用户求助（用户上报）',
    place: `${floor ? `${floor} 楼` : '楼层未知'}${spot ? ` · ${spot} 位置` : ''}`,
  }
}

// ---------------------------------------------------------------- 纯函数：离线码
// 离线码 = 版本前缀 + base64url(JSON)。做了字符替换，方便手机扫码与人工粘贴。
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
  const padded = code.replace(/-/g, '+').replace(/_/g, '/')
  const withPad = padded + '='.repeat((4 - (padded.length % 4)) % 4)
  const binary = typeof atob === 'function' ? atob(withPad) : Buffer.from(withPad, 'base64').toString('binary')
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return typeof TextDecoder !== 'undefined' ? new TextDecoder().decode(bytes) : decodeURIComponent(escape(binary))
}

export const EVENT_CODE_PREFIX = 'TGS1-'

export function encodeEventCode(event) {
  const compact = {
    v: EVENT_VERSION,
    i: event.id,
    k: event.kind,
    t: event.at,
    p: event.payload,
  }
  return EVENT_CODE_PREFIX + toBase64Url(JSON.stringify(compact))
}

export function decodeEventCode(code) {
  if (typeof code !== 'string') return null
  const text = code.trim().replace(/\s+/g, '')
  const body = text.startsWith(EVENT_CODE_PREFIX) ? text.slice(EVENT_CODE_PREFIX.length) : text
  if (!body) return null
  try {
    const parsed = JSON.parse(fromBase64Url(body))
    if (!parsed?.k || !parsed?.i) return null
    return createEvent(parsed.k, parsed.p ?? {}, {
      id: parsed.i,
      at: parsed.t,
      ttl: parsed.ttl,
      from: parsed.f ?? 'code',
    })
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 链路选择（纯函数）
// 输入运行时可用的能力，输出应该使用哪一级链路
export function chooseTransport({ hasLocal = true, relayOk = false, cloudOk = false, manualOnly = false } = {}) {
  if (manualOnly) return 'code'
  // 云端通道优先级最高：住户手机、蜂窝网络、跨校园都靠它（不依赖任何局域网）
  if (cloudOk) return 'cloud'
  if (relayOk) return 'lan'
  if (hasLocal) return 'local'
  return 'code'
}

export function describeTransport(level) {
  if (level === 'cloud') return '云端通道（手机蜂窝网络即可，跨楼跨小区）'
  if (level === 'lan') return '局域网中继（不需要互联网）'
  if (level === 'local') return '同机同浏览器（两个页面直接互通）'
  if (level === 'code') return '离线码（二维码/粘贴，完全不需要网络）'
  return '未联通'
}

// ---------------------------------------------------------------- 云端通道（纯函数）
// 支持两种云端通道：
//   · ntfy:<主题>  → 用公开的 ntfy.sh 转发（零部署，适合演示与原型，主题名即暗号）
//   · https://…    → 你自己的 REST 中继（POST /events、GET /events?since=，见 tools/relay-server.mjs）
export function parseCloudChannel(value) {
  const text = String(value ?? '').trim()
  if (!text) return { mode: 'off', raw: '' }
  if (text.startsWith('http://') || text.startsWith('https://')) {
    // 支持用 #分组 区分小区/楼栋：https://relay.example.com#building-a
    const hashIndex = text.indexOf('#')
    const urlPart = hashIndex >= 0 ? text.slice(0, hashIndex) : text
    const topic = hashIndex >= 0 ? text.slice(hashIndex + 1).trim() : ''
    const base = urlPart.replace(/\/$/, '')
    const query = topic ? `?topic=${encodeURIComponent(topic)}` : ''
    return {
      mode: 'rest',
      raw: text,
      base,
      topic,
      publishUrl: `${base}/events${query}`,
      pollUrl: `${base}/events${query}`,
      healthUrl: `${base}/health${query}`,
    }
  }
  const topic = text.startsWith('ntfy:') ? text.slice(5).trim() : text
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(topic)) return { mode: 'off', raw: text, reason: 'bad-topic' }
  return {
    mode: 'ntfy',
    raw: text,
    topic,
    base: NTFY_BASE,
    publishUrl: `${NTFY_BASE}/${topic}`,
    pollUrl: `${NTFY_BASE}/${topic}/json`,
    // 探测用 /json 端点的"最近 30 秒"查询：
    //   · 这个端点带 CORS 头（单纯的主题信息端点不带，浏览器会被拦）
    //   · 只取 30 秒窗口，比 since=all 轻得多，不容易触发公共服务的限流
    healthUrl: `${NTFY_BASE}/${topic}/json?poll=1&since=30s`,
  }
}

// 一键生成一个随机云端通道（主题名足够长，避免和别人的主题撞上）
export function makeCloudChannel(prefix = 'tg') {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'
  let tail = ''
  for (let index = 0; index < 14; index += 1) {
    tail += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return `ntfy:${prefix}-${tail}`
}

export function readCloudChannel() {
  if (typeof localStorage === 'undefined') return ''
  try {
    return localStorage.getItem(CLOUD_CHANNEL_KEY) ?? ''
  } catch {
    return ''
  }
}

export function saveCloudChannel(value) {
  if (typeof localStorage === 'undefined') return
  try {
    const text = String(value ?? '').trim()
    if (text) localStorage.setItem(CLOUD_CHANNEL_KEY, text)
    else localStorage.removeItem(CLOUD_CHANNEL_KEY)
  } catch {}
}

// ---------------------------------------------------------------- 运行时：事件总线
export function createEventBus(options = {}) {
  const channelName = options.channelName ?? 'thermalGuard'
  const relayBase = (options.relayBase ?? readRelayBase()).replace(/\/$/, '')
  const pollMs = Number(options.pollMs) || 3000
  const cloudChannel = parseCloudChannel(options.cloudChannel ?? readCloudChannel())
  const cloudPollMs = Number(options.cloudPollMs) || 5000
  const listeners = new Set()
  const state = {
    level: 'local',
    relayOk: false,
    cloudOk: false,
    cloudChannel: cloudChannel.raw ?? '',
    cloudCursor: '',
    lastSeq: 0,
    peers: 0,
    log: [],
    started: false,
  }

  let channel = null
  let timer = null
  let probeTimer = null
  let cloudTimer = null
  let stopped = false

  function emit(event) {
    state.log = mergeEvents(state.log, event)
    listeners.forEach((listener) => {
      try {
        listener(event, { level: state.level })
      } catch {}
    })
  }

  function onEvent(listener) {
    if (typeof listener !== 'function') return () => {}
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  // 同机同浏览器：BroadcastChannel 优先，退化为 storage 事件
  function publishLocal(event) {
    try {
      channel?.postMessage(event)
    } catch {}
    try {
      localStorage.setItem(BULK_STORAGE_KEY, JSON.stringify(mergeEvents([], [...state.log, event])))
    } catch {}
  }

  async function publishRelay(event) {
    const response = await fetch(`${relayBase}/sync/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    })
    if (!response.ok) throw new Error(`relay-${response.status}`)
    return response.json().catch(() => ({}))
  }

  async function probeRelay() {
    try {
      const response = await fetch(`${relayBase}/sync/health`, { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      state.relayOk = response.ok && data?.ok === true
      if (state.relayOk) state.peers = Number(data.clients) || state.peers
    } catch {
      state.relayOk = false
    }
    state.level = chooseTransport({ hasLocal: typeof BroadcastChannel !== 'undefined', relayOk: state.relayOk, cloudOk: state.cloudOk })
    return state.relayOk
  }

  async function pollRelay() {
    if (!state.relayOk) return
    try {
      const response = await fetch(`${relayBase}/sync/events?since=${state.lastSeq}&wait=15000`, { cache: 'no-store' })
      if (!response.ok) return
      const data = await response.json()
      if (Number.isFinite(Number(data?.seq))) state.lastSeq = Number(data.seq)
      if (Number.isFinite(Number(data?.clients))) state.peers = Number(data.clients)
      ;(data?.events ?? []).forEach((event) => emit(event))
    } catch {}
  }

  async function publish(event) {
    const safe = event?.v && KINDS.has(event.kind)
      ? event
      : createEvent(event?.kind ?? 'notice', event?.payload ?? {}, event ?? {})
    state.log = mergeEvents(state.log, safe)
    publishLocal(safe)
    if (state.relayOk) {
      try {
        await publishRelay(safe)
      } catch {
        state.relayOk = false
        state.level = chooseTransport({ hasLocal: true, relayOk: false, cloudOk: state.cloudOk })
      }
    }
    if (state.cloudOk) {
      try {
        await publishCloud(safe)
      } catch {
        state.cloudOk = false
        state.level = chooseTransport({ hasLocal: true, relayOk: state.relayOk, cloudOk: false })
      }
    }
    return safe
  }

  // -------------------------------------------------------------- 云端通道
  function cloudTarget() {
    return parseCloudChannel(options.cloudChannel ?? readCloudChannel())
  }

  async function probeCloud() {
    const target = cloudTarget()
    state.cloudChannel = target.raw ?? ''
    if (target.mode === 'off') {
      state.cloudOk = false
      state.level = chooseTransport({ hasLocal: typeof BroadcastChannel !== 'undefined', relayOk: state.relayOk })
      return false
    }
    try {
      const response = await fetch(target.healthUrl, { cache: 'no-store' })
      // 429 = 公共中继限流（端点本身是通的），照样算"可达"，随后按游标增量取数即可
      state.cloudOk = response.ok || response.status === 429
    } catch {
      state.cloudOk = false
    }
    state.level = chooseTransport({ hasLocal: typeof BroadcastChannel !== 'undefined', relayOk: state.relayOk, cloudOk: state.cloudOk })
    return state.cloudOk
  }

  async function publishCloud(event) {
    const target = cloudTarget()
    if (target.mode === 'off') return
    const response = await fetch(target.publishUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    })
    if (!response.ok) throw new Error(`cloud-${response.status}`)
    if (target.mode === 'ntfy') {
      const data = await response.json().catch(() => null)
      if (data?.id) state.cloudCursor = String(data.id)
    }
  }

  async function pollCloud() {
    const target = cloudTarget()
    if (target.mode === 'off' || !state.cloudOk) return
    try {
      if (target.mode === 'ntfy') {
        // 第一次用 since=all 把当前会话接上，之后只按游标/时间取增量，避免公共服务的限流
        const since = state.cloudCursor || (state.cloudPrimed ? Math.floor(Date.now() / 1000) : 'all')
        const response = await fetch(withQuery(target.pollUrl, { poll: 1, since }), { cache: 'no-store' })
        if (!response.ok) {
          // 被限流时退一步：改用时间游标，再过一轮就恢复正常
          state.cloudPrimed = true
          return
        }
        const text = await response.text()
        state.cloudPrimed = true
        text.split('\n').filter(Boolean).forEach((line) => {
          let record = null
          try {
            record = JSON.parse(line)
          } catch {
            return
          }
          if (record?.id) state.cloudCursor = String(record.id)
          if (record?.event !== 'message' || typeof record.message !== 'string') return
          let event = null
          try {
            event = JSON.parse(record.message)
          } catch {
            return
          }
          if (event?.id) emit(event)
        })
        return
      }
      const response = await fetch(withQuery(target.pollUrl, { since: state.cloudCursor || '' }), { cache: 'no-store' })
      if (!response.ok) return
      const data = await response.json().catch(() => null)
      if (data?.cursor) state.cloudCursor = String(data.cursor)
      ;(data?.events ?? []).forEach((event) => emit(event))
    } catch {}
  }

  function start() {
    if (state.started) return state
    state.started = true
    stopped = false
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        channel = new BroadcastChannel(channelName)
        channel.onmessage = (message) => {
          if (message?.data?.v) emit(message.data)
        }
      } catch {
        channel = null
      }
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (event) => {
        if (event.key !== BULK_STORAGE_KEY || !event.newValue) return
        try {
          const list = JSON.parse(event.newValue)
          const latest = Array.isArray(list) ? list[list.length - 1] : null
          if (latest?.v) emit(latest)
        } catch {}
      })
    }
    if (options.autoRelay !== false && typeof fetch === 'function') {
      probeRelay().then((ok) => {
        if (!ok || stopped || typeof window === 'undefined') return
        const loop = async () => {
          if (stopped) return
          await pollRelay()
          if (!stopped) timer = window.setTimeout(loop, 200)
        }
        loop()
      })
      if (typeof window !== 'undefined') {
        probeTimer = window.setInterval(() => probeRelay(), 15000)
      }
    }
    if (typeof fetch === 'function') {
      probeCloud().then((ok) => {
        if (!ok || stopped || typeof window === 'undefined') return
        const loop = async () => {
          if (stopped) return
          await pollCloud()
          if (!stopped) cloudTimer = window.setTimeout(loop, cloudPollMs)
        }
        loop()
      })
      if (typeof window !== 'undefined') {
        window.setInterval(() => probeCloud(), 20000)
      }
    }
    state.level = chooseTransport({ hasLocal: typeof BroadcastChannel !== 'undefined', relayOk: state.relayOk, cloudOk: state.cloudOk })
    return state
  }

  function stop() {
    stopped = true
    if (timer && typeof window !== 'undefined') window.clearTimeout(timer)
    if (probeTimer && typeof window !== 'undefined') window.clearInterval(probeTimer)
    if (cloudTimer && typeof window !== 'undefined') window.clearTimeout(cloudTimer)
    timer = null
    probeTimer = null
    cloudTimer = null
    try {
      channel?.close()
    } catch {}
    channel = null
    state.started = false
  }

  function status() {
    return {
      level: state.level,
      label: describeTransport(state.level),
      relayOk: state.relayOk,
      relayBase,
      cloudOk: state.cloudOk,
      cloudChannel: state.cloudChannel,
      peers: state.peers,
      events: state.log.length,
      lastAt: state.log.at(-1)?.at ?? null,
    }
  }

  // 最近收到/发出的事件（用于面板打开时立刻显示历史，而不是等新事件）
  function recent() {
    return [...state.log]
  }

  return { start, stop, publish, onEvent, status, recent, probeRelay, probeCloud }
}

// ---------------------------------------------------------------- 中继地址（同源优先）
let sharedBus = null

// 两个页面各自调用一次，拿到同一个总线实例（页面内共享）
export function sharedEventBus(options = {}) {
  if (!sharedBus) sharedBus = createEventBus(options)
  return sharedBus
}

export function resetSharedEventBus() {
  sharedBus?.stop()
  sharedBus = null
}

export function readRelayBase() {
  if (typeof localStorage !== 'undefined') {
    const saved = localStorage.getItem(RELAY_BASE_KEY)
    if (saved !== null) return saved
  }
  return '' // 空字符串 = 用当前站点同源（配合本地服务器）
}

export function saveRelayBase(base) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(RELAY_BASE_KEY, String(base ?? ''))
  } catch {}
}
