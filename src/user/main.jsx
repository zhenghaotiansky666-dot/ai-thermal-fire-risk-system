import React from 'react'
import { createRoot } from 'react-dom/client'
import UserApp from './UserApp.jsx'
import { bootstrapAiConfig } from '../shared/aiClient.js'
import { extractChannelFromSearch } from '../shared/geoChannels.js'
import { readCloudChannel, saveCloudChannel } from '../shared/eventBus.js'
import { startUpdateWatch } from '../shared/updateCheck.js'
import { extractAiPairingFromSearch } from '../shared/aiPairing.js'
import { readAiSettings, saveAiSettings } from '../shared/aiClient.js'
import './user.css'

// 扫码进入演示：二维码里带 ?ch=频道，先落地频道再做其他初始化
// （演示场景下这一步是"明确的加入动作"，所以直接覆盖本机已保存的频道）
const joinChannel = extractChannelFromSearch(typeof window === 'undefined' ? '' : window.location.search)
if (joinChannel && joinChannel !== readCloudChannel()) {
  saveCloudChannel(joinChannel)
}

// 扫「AI 配置配对」二维码进来的：自动填好 AI 端点与模型
const paired = extractAiPairingFromSearch(typeof window === 'undefined' ? '' : window.location.search)
if (paired) {
  const current = readAiSettings()
  saveAiSettings({
    provider: 'custom',
    baseUrl: paired.baseUrl,
    model: paired.model || current.model,
    ...(paired.vision ? { vision: true } : {}),
  })
}

// 先把 AI 接入配置读进来（window.THERMAL_GUARD_AI / ai-config.json），再渲染界面，
// 这样队友改配置文件就能直接生效，不需要在界面上点。
bootstrapAiConfig().finally(() => {
  createRoot(document.getElementById('user-root')).render(
    <React.StrictMode>
      <UserApp />
    </React.StrictMode>
  )
  // 标记渲染成功：白屏兜底脚本看到这个标记就不再弹"加载失败"
  window.__tgReady = true
})

// 线上更新：装了主屏图标的用户下次打开会自动拿到新版本，这里额外给一个可见提示
startUpdateWatch()

// 逃生指引是断网时最需要打开的那个页面，所以自己也注册 Service Worker
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {})
  })
}
