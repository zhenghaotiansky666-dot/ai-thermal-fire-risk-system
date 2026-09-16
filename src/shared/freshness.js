// 数据新鲜度判定（纯函数，便于单测）
//
// 硬件每 2 秒上传一轮；超过窗口没有新数据就认为链路中断，
// 系统端据此把「硬件在线 / 疑似离线」显式标出来，而不是让人盯着时间戳猜。

export const DEFAULT_FRESH_MS = 15000

export function describeFreshness(lastAt, now = Date.now(), freshMs = DEFAULT_FRESH_MS) {
  if (!lastAt) return { state: 'none', label: '还没有数据', ageMs: null }
  const ageMs = Math.max(0, Number(now) - Number(lastAt))
  if (!Number.isFinite(ageMs)) return { state: 'none', label: '还没有数据', ageMs: null }
  const seconds = Math.round(ageMs / 1000)
  if (ageMs <= freshMs) return { state: 'live', label: `${seconds} 秒前更新`, ageMs }
  return { state: 'stale', label: `${seconds} 秒没有新数据`, ageMs }
}
