// 给纯静态页面（演示中心等）准备一份浏览器版二维码库，随站点分发、离线可用。
// 构建前执行：node tools/copy-vendor.mjs

import { mkdir, readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const OUT = 'public/vendor/qrcode.min.js'

await mkdir(resolve('public/vendor'), { recursive: true })

try {
  // pnpm 的依赖布局把 esbuild 放在 .pnpm 下，这里按目录名找一次（找不到就退回 CDN）
  const pnpmDir = resolve('node_modules/.pnpm')
  const esbuildDir = (await readdir(pnpmDir)).find((name) => name.startsWith('esbuild@'))
  if (!esbuildDir) throw new Error('未找到 esbuild（pnpm 布局变化）')
  const esbuildEntry = resolve(pnpmDir, esbuildDir, 'node_modules/esbuild/lib/main.js')
  const esbuild = await import(pathToFileURL(esbuildEntry).href)
  await esbuild.build({
    entryPoints: [resolve('node_modules/qrcode/lib/browser.js')],
    bundle: true,
    minify: true,
    format: 'iife',
    globalName: 'QRCode',
    platform: 'browser',
    target: ['es2018'],
    outfile: resolve(OUT),
    logLevel: 'warning',
  })
  const info = await stat(resolve(OUT))
  console.log(`已生成浏览器版二维码库：${OUT}（${Math.round(info.size / 1024)} KB）`)
} catch (error) {
  console.warn(`打包二维码库失败（演示中心会退回 CDN）：${error.message}`)
}
