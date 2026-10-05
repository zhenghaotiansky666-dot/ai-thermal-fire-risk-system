// 用户端上报（隐患随手拍 / 被困求助）→ 系统端联动
//
// 这一层对应队友（roubizhao6）的用户端"隐患上报 + 云端同步"：
// 做法是把上报 POST 到一个 Cloudflare Worker 或一个写死的 ntfy 主题。
// 我们沿用本仓库已有的三级链路（localStorage/BroadcastChannel → 局域网中继 → ntfy/自建中继 → 离线码），
// 只把"隐患（含照片）+ 求助状态"接进同一条事件总线，不额外引入第二套同步协议。
//
// 一个细节：ntfy 的消息体只有 ~4KB，塞不下照片的 dataURL。
// 所以走 ntfy 时先把照片当成附件传上去，事件里只带附件 URL（同队友的做法），
// 走局域网中继/自建中继时消息体没有这个限制，直接带压缩后的图即可。

import { createEvent, parseCloudChannel } from './eventBus.js'

// 与系统端「隐患随手拍」共用同一个键：同一台设备上两端直接互见，
// 跨设备时再由事件总线补齐（系统端把总线里收到的事件也写回这个键）。
export const HAZARD_KEY = 'thermalGuardHazards'
export const MAX_HAZARDS = 20
// 照片先压到这个边长以内再存/发：既不糊到看不清，也不会把中继和本机存储撑爆
export const PHOTO_MAX_EDGE = 720
export const PHOTO_QUALITY = 0.6
// 本地缓存里的照片可以用 dataURL；超过这个长度就不适合放进事件消息体了
export const INLINE_IMAGE_LIMIT = 60_000

function storageOf(storage) {
  if (storage) return storage
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 纯函数

// 把任意来源的记录收拾成统一结构（本机存的、事件里收的，都走这里）
export function normalizeHazard(raw = {}) {
  const at = Number(raw.at) || Number(raw.time) || Date.now()
  const desc = String(raw.desc ?? raw.description ?? raw.text ?? '').trim()
  const loc = String(raw.loc ?? raw.location ?? raw.place ?? '').trim()
  return {
    id: String(raw.id ?? `hz-${at.toString(36)}`),
    desc: desc || '未描述',
    loc: loc || '未填写位置',
    img: typeof raw.img === 'string' ? raw.img : '',
    floor: raw.floor ?? null,
    spot: raw.spot ?? null,
    time: String(raw.time ?? new Date(at).toLocaleString('zh-CN', { hour12: false })),
    at,
    from: raw.from ?? 'user',
  }
}

// 事件总线里的 report 事件 → 隐患记录；不是隐患返回 null
export function hazardFromEvent(event) {
  if (!event || event.kind !== 'report') return null
  const payload = event.payload ?? {}
  if (payload.category !== 'hazard') return null
  return normalizeHazard({ ...payload, at: payload.at || event.at, from: event.from })
}

// 事件总线里的 report 事件 → 求助状态；不是求助返回 null
export function helpFromEvent(event) {
  if (!event || event.kind !== 'report') return null
  const payload = event.payload ?? {}
  if (payload.category !== 'help') return null
  return {
    ...payload,
    id: String(payload.id ?? `help-${event.at.toString(36)}`),
    updatedAt: Number(payload.updatedAt) || event.at,
    from: event.from ?? 'user',
  }
}

// 合并去重（按 id，新的在前），并限制条数
export function mergeHazards(list = [], incoming = [], limit = MAX_HAZARDS) {
  const map = new Map()
  ;[...incoming, ...list].forEach((item) => {
    const record = normalizeHazard(item)
    const previous = map.get(record.id)
    if (!previous || record.at >= previous.at) map.set(record.id, record)
  })
  return [...map.values()].sort((a, b) => b.at - a.at).slice(0, Math.max(1, limit))
}

// 事件里带多大体积的照片才安全：超了就只发链接/丢弃，避免把中继打爆
export function imageForEvent(img, limit = INLINE_IMAGE_LIMIT) {
  const text = typeof img === 'string' ? img : ''
  if (!text) return ''
  if (!text.startsWith('data:')) return text // 已经是远程链接，直接用
  return text.length <= limit ? text : ''
}

// ---------------------------------------------------------------- 本机存储

export function readHazards(storage) {
  const store = storageOf(storage)
  if (!store) return []
  try {
    const raw = JSON.parse(store.getItem(HAZARD_KEY) || '[]')
    return Array.isArray(raw) ? mergeHazards(raw) : []
  } catch {
    return []
  }
}

export function writeHazards(list, storage) {
  const store = storageOf(storage)
  const next = mergeHazards(list)
  if (!store) return next
  try {
    store.setItem(HAZARD_KEY, JSON.stringify(next))
  } catch {
    // 存储满了：退化成只保留文字，别让上报整个失败
    try {
      store.setItem(HAZARD_KEY, JSON.stringify(next.map((item) => ({ ...item, img: '' }))))
    } catch {}
  }
  return next
}

export function addHazard(record, storage) {
  return writeHazards(mergeHazards([normalizeHazard(record)], readHazards(storage)), storage)
}

export function removeHazard(id, storage) {
  return writeHazards(readHazards(storage).filter((item) => item.id !== id), storage)
}

// ---------------------------------------------------------------- 照片处理

// 用 canvas 把照片压小；没有 canvas（测试环境）就原样返回
export function compressImage(dataUrl, {
  maxEdge = PHOTO_MAX_EDGE,
  quality = PHOTO_QUALITY,
  doc = typeof document !== 'undefined' ? document : null,
} = {}) {
  return new Promise((resolve) => {
    const text = typeof dataUrl === 'string' ? dataUrl : ''
    if (!text.startsWith('data:image') || !doc) {
      resolve(text)
      return
    }
    try {
      const image = new Image()
      image.onload = () => {
        try {
          const scale = Math.min(1, maxEdge / Math.max(image.width || 1, image.height || 1))
          const canvas = doc.createElement('canvas')
          canvas.width = Math.max(1, Math.round((image.width || 1) * scale))
          canvas.height = Math.max(1, Math.round((image.height || 1) * scale))
          const context = canvas.getContext('2d')
          context.drawImage(image, 0, 0, canvas.width, canvas.height)
          resolve(canvas.toDataURL('image/jpeg', quality))
        } catch {
          resolve(text)
        }
      }
      image.onerror = () => resolve(text)
      image.src = text
    } catch {
      resolve(text)
    }
  })
}

export async function readPhotoFile(file, options = {}) {
  if (!file || typeof FileReader === 'undefined') return ''
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('file-read-failed'))
    reader.readAsDataURL(file)
  })
  return compressImage(dataUrl, options)
}

// 走 ntfy 时把照片当附件传（消息体只有 4KB，塞不下图）；返回附件 URL，失败返回 ''
export async function uploadPhotoToChannel(channel, dataUrl, { fetchImpl } = {}) {
  const target = parseCloudChannel(channel)
  const text = typeof dataUrl === 'string' ? dataUrl : ''
  const request = fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : null)
  if (target.mode !== 'ntfy' || !text.startsWith('data:image') || !request) return ''
  try {
    const blob = await (await request(text)).blob()
    const response = await request(target.publishUrl, {
      method: 'PUT',
      headers: { Filename: 'hazard.jpg', 'Content-Type': blob.type || 'image/jpeg' },
      body: blob,
    })
    if (!response.ok) return ''
    const data = await response.json().catch(() => null)
    return data?.attachment?.url ?? ''
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------- 发布

// 发布一条隐患上报：照片该传附件的传附件，事件里只留能跨设备带走的内容
export async function publishHazard(bus, record, { channel, fetchImpl } = {}) {
  if (!bus?.publish) return null
  const hazard = normalizeHazard(record)
  let img = imageForEvent(hazard.img)
  if (!img && hazard.img && hazard.img.startsWith('data:')) {
    const channelText = channel ?? (typeof localStorage !== 'undefined' ? localStorage.getItem('thermalGuardCloudChannel') || '' : '')
    img = await uploadPhotoToChannel(channelText, hazard.img, { fetchImpl })
  }
  const event = createEvent('report', {
    category: 'hazard',
    id: hazard.id,
    desc: hazard.desc,
    loc: hazard.loc,
    img,
    floor: hazard.floor,
    spot: hazard.spot,
    at: hazard.at,
  }, { from: 'user', at: hazard.at })
  await bus.publish(event)
  return event
}

// 发布一条被困求助（自救问答的结果），让系统端/救援端看到楼里谁需要帮助
export async function publishHelp(bus, status) {
  if (!bus?.publish || !status) return null
  const event = createEvent('report', {
    category: 'help',
    id: status.id,
    floor: status.floor ?? null,
    spot: status.spot ?? null,
    needsHelp: Boolean(status.needsHelp),
    tone: status.tone ?? '',
    advice: status.advice ?? '',
    updatedAt: status.updatedAt ?? Date.now(),
  }, { from: 'user' })
  await bus.publish(event)
  return event
}
