// 线上更新 → 已安装用户同步
//
// 机制有两层，互为兜底：
//   1. Service Worker：导航请求走 network-first（见 public/sw.js），装到主屏幕的用户下次打开就是新版；
//      新版本安装完成后 skipWaiting + clients.claim，不需要用户手动清缓存。
//   2. 版本信号：构建时生成 public/version.json（buildId 每次都不一样），
//      页面启动时把自己内置的 __BUILD_ID__ 与它比对；不一致就浮出一个"有新版本"的小条。
//
// 这一层不依赖 React，用户端/系统端/静态页都能用。

export const BUILD_ID = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : ''

export function isStale(localBuildId, remoteBuildId) {
  if (!remoteBuildId) return false
  if (!localBuildId) return false
  return localBuildId !== remoteBuildId
}

export function describeBuild(buildId) {
  if (!buildId) return '开发模式'
  return buildId
}

function showBanner(text, onClick) {
  if (typeof document === 'undefined') return null
  const existing = document.getElementById('tg-update-banner')
  if (existing) existing.remove()
  const banner = document.createElement('div')
  banner.id = 'tg-update-banner'
  banner.setAttribute('role', 'status')
  banner.style.cssText = [
    'position:fixed', 'left:50%', 'transform:translateX(-50%)',
    'bottom:calc(16px + env(safe-area-inset-bottom))', 'z-index:9999',
    'display:flex', 'align-items:center', 'gap:10px',
    'padding:10px 14px', 'border-radius:999px',
    'background:linear-gradient(110deg,#2563eb,#38bdf8)', 'color:#fff',
    'font:600 13px/1.4 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif',
    'box-shadow:0 12px 30px rgba(0,0,0,.35)', 'cursor:pointer',
  ].join(';')
  banner.textContent = text
  banner.addEventListener('click', onClick)
  document.body.appendChild(banner)
  return banner
}

// 启动监听：返回 stop() 以便清理
export function startUpdateWatch({ intervalMs = 5 * 60 * 1000 } = {}) {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return () => {}
  let timer = null
  let stopped = false

  const prompt = () => {
    showBanner('有新版本 · 点此更新', () => {
      // 先让 SW 去拿新版本，再整页刷新（刷新后内置 buildId 就是新的了）
      navigator.serviceWorker?.getRegistration?.()
        .then((registration) => registration?.update?.())
        .catch(() => {})
        .finally(() => window.location.reload())
    })
  }

  const check = async () => {
    if (stopped) return
    try {
      const response = await fetch('./version.json', { cache: 'no-store' })
      if (!response.ok) return
      const info = await response.json()
      if (isStale(BUILD_ID, info?.buildId)) prompt()
    } catch {}
  }

  // Service Worker 更新完成（waiting 状态）时也提示一次
  if (navigator.serviceWorker?.addEventListener) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!stopped) prompt()
    })
  }

  check()
  timer = window.setInterval(check, intervalMs)
  return () => {
    stopped = true
    if (timer) window.clearInterval(timer)
    document.getElementById('tg-update-banner')?.remove()
  }
}
