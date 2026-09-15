// 生成手机安装用素材（可重复执行）：
//   1. 两份 iOS 描述文件（.mobileconfig）：把用户端 / 系统端以 Web Clip 形式装到主屏幕
//   2. 两份二维码 SVG：扫一下直接在手机浏览器打开对应页面
//
// 用法：node tools/make-install-assets.mjs [站点根地址]
// 默认站点根地址：https://zhenghaotiansky666-dot.github.io/ai-thermal-fire-risk-system

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import QRCode from 'qrcode'

const base = (process.argv[2] || 'https://zhenghaotiansky666-dot.github.io/ai-thermal-fire-risk-system').replace(/\/$/, '')
const publicDir = resolve('public')
const downloadDir = resolve(publicDir, 'download')

const APPS = [
  {
    id: 'user',
    label: '逃生指引',
    name: '热感哨兵 · 逃生指引',
    url: `${base}/user-app.html`,
    file: '热感哨兵-用户端-安装.mobileconfig',
    qr: 'qr-user.svg',
  },
  {
    id: 'system',
    label: '热感哨兵',
    name: '热感哨兵 · 系统端',
    url: `${base}/mobile-app.html`,
    file: '热感哨兵-系统端-安装.mobileconfig',
    qr: 'qr-system.svg',
  },
]

function uuidFrom(seed) {
  // 稳定 UUID：同一个应用每次生成都一样，避免每次重建描述文件都变成"新配置"
  const chars = '0123456789abcdef'
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) % 0xffffff
  const block = (offset) => Array.from({ length: 8 }, (_, index) => chars[(hash + offset * 7 + index * 13) % 16]).join('')
  return `${block(1)}-${block(2).slice(0, 4)}-4${block(3).slice(0, 3)}-8${block(4).slice(0, 3)}-${block(5)}${block(6).slice(0, 4)}`
}

function profileFor(app, iconBase64) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key>
      <string>com.apple.webClip.managed</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PayloadIdentifier</key>
      <string>com.thermalguard.webclip.${app.id}</string>
      <key>PayloadUUID</key>
      <string>${uuidFrom(`payload-${app.id}`)}</string>
      <key>PayloadDisplayName</key>
      <string>${app.name}</string>
      <key>PayloadDescription</key>
      <string>在 iPhone / iPad 主屏幕添加「${app.label}」图标，点开即用（可随时删除）。</string>
      <key>URL</key>
      <string>${app.url}</string>
      <key>Label</key>
      <string>${app.label}</string>
      <key>Icon</key>
      <data>
${iconBase64}
      </data>
      <key>IsRemovable</key>
      <true/>
      <key>Precomposed</key>
      <true/>
      <key>FullScreen</key>
      <true/>
      <key>IgnoreManifestScope</key>
      <true/>
    </dict>
  </array>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>PayloadIdentifier</key>
  <string>com.thermalguard.install.${app.id}</string>
  <key>PayloadUUID</key>
  <string>${uuidFrom(`profile-${app.id}`)}</string>
  <key>PayloadDisplayName</key>
  <string>${app.name} 安装配置</string>
  <key>PayloadDescription</key>
  <string>热感哨兵 ${app.label} 的网页应用快捷方式（不修改系统设置、不采集任何信息）。</string>
  <key>PayloadOrganization</key>
  <string>澳门科技大学 · 热感哨兵</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
</dict>
</plist>
`
}

async function main() {
  await mkdir(downloadDir, { recursive: true })
  const icon = await readFile(resolve(publicDir, 'apple-touch-icon.png'))
  const iconLines = icon.toString('base64').match(/.{1,68}/g) ?? []
  const iconBase64 = iconLines.map((line) => `      ${line}`).join('\n')

  for (const app of APPS) {
    const profilePath = resolve(downloadDir, app.file)
    await writeFile(profilePath, profileFor(app, iconBase64), 'utf8')
    const qr = await QRCode.toString(app.url, { type: 'svg', margin: 1, width: 320 })
    await writeFile(resolve(downloadDir, app.qr), qr, 'utf8')
    console.log(`已生成：${profilePath.replace(process.cwd() + '/', '')}  → ${app.url}`)
    console.log(`已生成：public/download/${app.qr}`)
  }

  // 兼容旧文件名：把用户端那份也写成 thermal-guard.mobileconfig（老二维码/文档指向它）
  const legacy = profileFor({ ...APPS[0], file: 'thermal-guard.mobileconfig' }, iconBase64)
  await writeFile(resolve(publicDir, 'thermal-guard.mobileconfig'), legacy, 'utf8')
  console.log('已更新：public/thermal-guard.mobileconfig（指向用户端）')
  await mkdir(dirname(resolve(publicDir, 'thermal-guard.mobileconfig')), { recursive: true })
}

main().catch((error) => {
  console.error('生成失败：', error)
  process.exit(1)
})
