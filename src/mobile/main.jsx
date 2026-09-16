import React from 'react'
import { createRoot } from 'react-dom/client'
import MobileApp from './MobileApp.jsx'
import { bootstrapAiConfig } from '../shared/aiClient.js'
import { extractChannelFromSearch } from '../shared/geoChannels.js'
import { readCloudChannel, saveCloudChannel } from '../shared/eventBus.js'
import { startUpdateWatch } from '../shared/updateCheck.js'
import { extractAiPairingFromSearch } from '../shared/aiPairing.js'
import { readAiSettings, saveAiSettings } from '../shared/aiClient.js'
import './mobile.css'

// 演示中心可以带着频道直接打开系统端：?ch=ntfy:xxx
const joinChannel = extractChannelFromSearch(typeof window === 'undefined' ? '' : window.location.search)
if (joinChannel && joinChannel !== readCloudChannel()) {
  saveCloudChannel(joinChannel)
}

// 扫「AI 配置配对」二维码进来的：直接把端点和模型填好，队友不用手输 IP
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

// 与用户端一致：先读 AI 接入配置，再渲染，队友改 ai-config.json 即可生效
bootstrapAiConfig().finally(() => {
  createRoot(document.getElementById('mobile-root')).render(
    <React.StrictMode>
      <MobileApp />
    </React.StrictMode>
  )
  window.__tgReady = true
})

// 线上更新提示（与用户端同一套机制）
startUpdateWatch()

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {})
  })
}
