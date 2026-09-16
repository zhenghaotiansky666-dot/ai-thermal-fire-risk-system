const CACHE = 'thermal-guard-v11'
// 逃生指引页与它的 manifest 必须预缓存：断网时用户最需要这个页面
const CORE = ['./', './index.html', './mobile-app.html', './user-app.html', './mobile-install.html', './demo-center.html', './ai-check.html', './alarm-speaker.html', './thermal-guard.mobileconfig', './ai-config.json', './demo-live.gif', './manifest.webmanifest', './manifest-user.webmanifest', './apple-touch-icon.png', './icon-192.png', './icon-512.png', './download/qr-user.svg', './download/qr-system.svg', './download/热感哨兵-用户端-安装.mobileconfig', './download/热感哨兵-系统端-安装.mobileconfig']
const SHELLS = ['./index.html', './mobile-app.html', './user-app.html']

// Vite 产物文件名带 hash，没法写死在清单里。首次加载时 Service Worker 还没接管页面，
// 这些 JS/CSS 不会被运行时缓存接到，断网时就会出现"HTML 打开了但白屏"。
// 所以安装阶段就从各页面 HTML 里解析出引用的脚本与样式，一并预缓存。
async function precacheShellAssets(cache) {
  const assets = new Set()
  for (const page of SHELLS) {
    const response = await cache.match(page)
    if (!response) continue
    const html = await response.text()
    for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const url = match[1]
      if (url.startsWith('./assets/') || url.startsWith('/assets/')) assets.add(url)
    }
  }
  // 单个资源失败不该让整个安装失败
  await Promise.allSettled([...assets].map((url) => cache.add(url)))
  return assets.size
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    // 任何一个文件缺失都不该让整个离线能力失效，因此逐个添加、只保留成功的
    await Promise.allSettled(CORE.map(url => cache.add(url)))
    await precacheShellAssets(cache)
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // 清掉旧版本缓存，避免版本升级后缓存无限堆积
    const keys = await caches.keys()
    await Promise.allSettled(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return

  const requestUrl = new URL(event.request.url)

  // version.json 是"有没有新版本"的信号，永远不缓存，避免装到主屏的用户以为已经是最新
  if (requestUrl.origin === self.location.origin && requestUrl.pathname.endsWith('/version.json')) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }))
    return
  }

  if (requestUrl.origin === self.location.origin && requestUrl.pathname.endsWith('/thermal-guard.mobileconfig')) {
    event.respondWith((async () => {
      const response = await fetch(event.request)
      const body = await response.blob()
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: {
          'Content-Type': 'application/x-apple-aspen-config; charset=utf-8',
          'Content-Disposition': 'inline; filename="thermal-guard.mobileconfig"',
          'Cache-Control': 'no-store'
        }
      })
    })())
    return
  }

  const isSameOrigin = requestUrl.origin === self.location.origin
  const isNavigation = event.request.mode === 'navigate'

  event.respondWith((async () => {
    try {
      const response = await fetch(event.request)
      if (response.ok && isSameOrigin) {
        const copy = response.clone()
        caches.open(CACHE).then(cache => cache.put(event.request, copy)).catch(() => {})
      }
      return response
    } catch (error) {
      // 网络不可用（手机信号差、被墙）时的兜底：依次尝试
      //   1) 完全相同的 URL（含 ?ch= 等查询参数）
      //   2) 去掉查询参数的同路径页面
      //   3) 该端点的主页面
      // 这样"装了主屏图标但网络不好"不会再出现白屏。
      const exact = await caches.match(event.request)
      if (exact) return exact
      if (isSameOrigin) {
        const withoutQuery = await caches.match(requestUrl.origin + requestUrl.pathname)
        if (withoutQuery) return withoutQuery
        const scope = self.registration.scope
        const shellUser = await caches.match(new URL('./user-app.html', scope).href)
        const shellSystem = await caches.match(new URL('./mobile-app.html', scope).href)
        const shell = requestUrl.pathname.includes('mobile-app')
          ? (shellSystem ?? shellUser)
          : (shellUser ?? shellSystem)
        if (shell) return shell
        if (isNavigation && shellUser) return shellUser
      }
      throw error
    }
  })())
})
