// 模拟 ESP32-S3 发数据（没有硬件时用来联调/演示）
//
// 完全按硬件队友固件的格式发：
//   1) POST /upload          Content-Type: image/jpeg  + 原始 JPEG 字节（读回 YES/NO）
//   2) POST /upload_thermal  Content-Type: application/json + {max_temp, sensor_data:[768]}
//
// 用法：
//   node tools/hardware-sim.mjs                          # 发一张示例热像 + 一张示例照片到本机 5000
//   node tools/hardware-sim.mjs --host 192.168.1.20      # 发给另一台电脑
//   node tools/hardware-sim.mjs --hot                    # 造一个"高温火情"帧（触发 YES）
//   node tools/hardware-sim.mjs --loop 3                 # 循环 3 轮，每轮间隔 2 秒

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const readArg = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const host = readArg('--host', '127.0.0.1')
const port = Number(readArg('--port', '5000'))
const rounds = Number(readArg('--loop', '1'))
const hot = args.includes('--hot')
const base = `http://${host}:${port}`

// 造 32×24 温度矩阵：常温 + 一处热源（--hot 时到 85°C）
function makeMatrix(seed = Date.now()) {
  const width = 32
  const height = 24
  const matrix = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const nx = x / (width - 1)
      const ny = y / (height - 1)
      const ambient = 27 + 2 * (1 - ny) + Math.sin((seed % 997) / 997 * 6 + nx * 5) * 0.6
      const peak = hot ? 58 : 6
      const hotSpot = peak * Math.exp(-(((nx - 0.35) ** 2 + (ny - 0.4) ** 2) / 0.02))
      matrix.push(Number((ambient + hotSpot).toFixed(2)))
    }
  }
  return matrix
}

async function loadSampleJpeg() {
  // 优先用仓库里的示例照片，没有就现场造一张纯色 JPEG（用 data URL 里的最小 JPEG）
  try {
    return await readFile(resolve('public/demo-thermal.jpg'))
  } catch {
    const tiny = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='
    return Buffer.from(tiny, 'base64')
  }
}

async function sendThermal(matrix, maxTemp) {
  const response = await fetch(`${base}/upload_thermal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_temp: maxTemp, sensor_data: matrix }),
  })
  const body = await response.text()
  console.log(`  热像：${response.status} ${body.slice(0, 90)}`)
}

async function sendPhoto(jpeg) {
  const response = await fetch(`${base}/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' },
    body: jpeg,
  })
  const body = (await response.text()).trim()
  console.log(`  可见光：${response.status} → 终审 "${body}"（固件约定：恰好 YES 才会拉响蜂鸣器）`)
  return body
}

console.log(`模拟 ESP32-S3 发送 → ${base}${hot ? '（高温帧）' : ''}`)
for (let round = 1; round <= rounds; round += 1) {
  const matrix = makeMatrix(Date.now() + round)
  const maxTemp = Math.max(...matrix)
  console.log(`第 ${round}/${rounds} 轮 · 最高温 ${maxTemp.toFixed(1)}°C`)
  await sendThermal(matrix, maxTemp)
  const jpeg = await loadSampleJpeg()
  await sendPhoto(jpeg)
  if (round < rounds) await new Promise((done) => setTimeout(done, 2000))
}
