import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const entry = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url))

// 构建时把 version.json 里的 buildId 注入前端，便于"线上更新 → 已安装用户提示更新"
function readBuildId() {
  try {
    const info = JSON.parse(readFileSync(new URL('./public/version.json', import.meta.url), 'utf8'))
    return info.buildId ?? ''
  } catch {
    return ''
  }
}

export default defineConfig({
  base: './',
  plugins: [react()],
  define: {
    __BUILD_ID__: JSON.stringify(readBuildId()),
  },
  server: { host: '127.0.0.1', port: 5173 },
  build: {
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      input: {
        main: entry('index.html'),
        mobile: entry('mobile-app.html'),
        user: entry('user-app.html')
      }
    }
  }
})
