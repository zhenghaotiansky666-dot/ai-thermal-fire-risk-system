// 一键配置本地 AI（队友在另一台电脑上直接跑这一条命令）
//
//   node tools/setup-local-ai.mjs
//
// 它会依次：
//   1. 找到 Ollama；没装就打印官网下载地址（不会偷偷装东西）
//   2. 用「局域网可访问 + 放开 CORS」的方式启动 ollama serve（OLLAMA_HOST=0.0.0.0:11434、OLLAMA_ORIGINS=*）
//      —— 这两条正是"队友接不进去"最常见的原因
//   3. 检查目标模型，缺了就自动 ollama pull
//   4. 启动我们的本地站点 + /ai 同源代理 + /sync 事件中继（tools/local-ai-server.mjs）
//   5. 跑一遍自检（tools/ai-doctor.mjs）并打印结论、手机/队友该打开的地址、二维码
//
// 常用参数：
//   --model qwen2.5:7b      指定模型（默认 qwen2.5:7b）
//   --port 4173             站点端口
//   --upstream http://…/v1  直接用别的端点（跳过 Ollama 启用步骤）
//   --no-open               不自动打开浏览器
//   --check-only            只做自检，不启动任何服务

import { spawn } from 'node:child_process'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { runDoctor, formatReport, lanAddresses, DEFAULT_MODEL } from './ai-doctor.mjs'

const args = process.argv.slice(2)
const readArg = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const hasFlag = (name) => args.includes(name)

const model = readArg('--model', DEFAULT_MODEL)
const requestedPort = Number(readArg('--port', '4173'))
let sitePort = requestedPort
const upstream = readArg('--upstream', 'http://127.0.0.1:11434/v1').replace(/\/$/, '')
const checkOnly = hasFlag('--check-only')
const shouldOpen = !hasFlag('--no-open')
const withHardware = !hasFlag('--no-hardware')
const hardwarePort = Number(readArg('--hardware-port', '5000'))
const ollamaPort = new URL(upstream).port || '11434'
// 显式给了 --upstream 就说明用的是别的端点（LM Studio / 自建），不再去管 Ollama
const isOllama = !args.includes('--upstream')
const logFile = resolve('tools', 'local-ai.log')

const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const isWindows = process.platform === 'win32'

function run(command, commandArgs, options = {}) {
  return new Promise((done) => {
    const child = spawn(command, commandArgs, { shell: isWindows, ...options })
    let out = ''
    let err = ''
    child.stdout?.on('data', (chunk) => {
      out += chunk
      if (options.echo) process.stdout.write(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      err += chunk
      if (options.echo) process.stderr.write(chunk)
    })
    child.on('error', (error) => done({ code: -1, out, err: String(error?.message ?? error) }))
    child.on('close', (code) => done({ code: code ?? 0, out, err }))
  })
}

async function reachable(url, timeoutMs = 1500) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = setTimeout(() => controller?.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller?.signal })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

// 端口是否被占用（用来"把端口搞好一点"：首选端口被占就自动往后找一个空闲的）
export function isPortBusy(port, host = '127.0.0.1') {
  return new Promise((done) => {
    const probe = createServer()
    probe.once('error', () => done(true))
    probe.once('listening', () => probe.close(() => done(false)))
    probe.listen(port, host)
  })
}

export async function findFreePort(start, tries = 12) {
  for (let offset = 0; offset < tries; offset += 1) {
    const candidate = start + offset
    if (!(await isPortBusy(candidate))) return candidate
  }
  return start
}

async function ensureOllama() {
  if (!isOllama) {
    console.log(`· 使用自定义端点 ${upstream}，跳过 Ollama 启用步骤`)
    return true
  }

  const version = await run('ollama', ['--version'])
  if (version.code !== 0) {
    console.log('❌ 没找到 Ollama。请先安装（任选其一）：')
    console.log('   · macOS / Windows：打开 https://ollama.com/download 下载安装包')
    console.log('   · macOS 用 Homebrew：brew install ollama')
    console.log('   · Linux：curl -fsSL https://ollama.com/install.sh | sh')
    console.log('   安装后重新运行：node tools/setup-local-ai.mjs')
    return false
  }
  console.log(`· 已安装 Ollama：${version.out.trim().split('\n')[0]}`)

  // 端口被别的程序占着（不是 Ollama）时，直接说清楚，别让人误以为是模型问题
  if ((await isPortBusy(Number(ollamaPort))) && !(await reachable(`http://127.0.0.1:${ollamaPort}/api/tags`))) {
    console.log(`⚠️ 端口 ${ollamaPort} 已被其它程序占用，且不响应 Ollama 接口。两种处理：`)
    console.log(`   1) 关掉占用该端口的程序后重跑本脚本；`)
    console.log(`   2) 换端口启动：OLLAMA_HOST=0.0.0.0:11435 ollama serve，然后`)
    console.log(`      node tools/setup-local-ai.mjs --upstream http://127.0.0.1:11435/v1`)
  }

  if (await reachable(`http://127.0.0.1:${ollamaPort}/api/tags`)) {
    console.log(`· Ollama 已在运行（127.0.0.1:${ollamaPort}）`)
    const lan = lanAddresses()[0]
    if (lan && !(await reachable(`http://${lan}:${ollamaPort}/api/tags`))) {
      console.log(`⚠️ 当前 Ollama 只监听本机，队友/手机连不上。建议重启成"局域网可访问"：`)
      console.log(`   先退出正在运行的 Ollama，然后执行：${isWindows ? 'set OLLAMA_HOST=0.0.0.0:' : 'OLLAMA_HOST=0.0.0.0:' + ollamaPort + ' '}ollama serve`)
      console.log('   本脚本也可以帮你启一个新的实例（会自动带上正确环境变量）。')
    } else {
      return true
    }
  }

  // 以"局域网可访问 + 放开 CORS"的方式启动
  const env = {
    ...process.env,
    OLLAMA_HOST: `0.0.0.0:${ollamaPort}`,
    OLLAMA_ORIGINS: '*',
  }
  await mkdir(resolve('tools'), { recursive: true })
  const logHandle = await (await import('node:fs')).openSync?.(logFile, 'a')
  const child = spawn('ollama', ['serve'], {
    env,
    shell: isWindows,
    detached: true,
    stdio: ['ignore', logHandle ?? 'ignore', logHandle ?? 'ignore'],
  })
  child.unref()
  console.log(`· 已按"局域网可访问 + 放开 CORS"启动 Ollama（日志：${logFile}）`)

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await reachable(`http://127.0.0.1:${ollamaPort}/api/tags`)) {
      console.log('· Ollama 就绪')
      return true
    }
    await wait(500)
  }
  console.log('⚠️ 等了 20 秒还没起来，继续往下走，自检会告诉你具体卡在哪一步')
  return true
}

async function ensureModel() {
  if (!isOllama) return
  const tags = await run('ollama', ['list'])
  const hasModel = tags.out.split('\n').some((line) => line.trim().startsWith(model.split(':')[0]))
  if (hasModel) {
    console.log(`· 模型就绪：${model}`)
    return
  }
  console.log(`· 本机没有 ${model}，开始下载（首次可能要几分钟，取决于网速与模型大小）…`)
  const pull = await run('ollama', ['pull', model], { echo: true })
  if (pull.code !== 0) {
    console.log(`⚠️ 下载失败：${pull.err.trim().split('\n').slice(-1)[0] || '未知原因'}`)
    console.log('   可以换小一点的模型：node tools/setup-local-ai.mjs --model qwen2.5:3b')
  }
}

async function ensureSite() {
  // 运行包里自带 dist（预构建好的站点），所以正常情况不需要 npm install / build
  if (!existsSync(resolve('dist', 'index.html'))) {
    console.log('⚠️ 没找到预构建的 dist/index.html。若是源码包，请先执行：npm install && npm run build')
  }
  if (await reachable(`http://127.0.0.1:${sitePort}/`)) {
    console.log(`· 本地站点已在运行（端口 ${sitePort}）`)
    return
  }
  // 首选端口被别的程序占用时自动换一个，避免"起不来"这种低级卡点
  const freePort = await findFreePort(sitePort)
  if (freePort !== sitePort) {
    console.log(`⚠️ 端口 ${sitePort} 被占用，自动改用 ${freePort}`)
    sitePort = freePort
  }
  await mkdir(resolve('tools'), { recursive: true })
  const logHandle = await (await import('node:fs')).openSync?.(logFile, 'a')
  const child = spawn(process.execPath, ['tools/local-ai-server.mjs', '--port', String(sitePort), '--upstream', upstream], {
    detached: true,
    stdio: ['ignore', logHandle ?? 'ignore', logHandle ?? 'ignore'],
  })
  child.unref()
  console.log(`· 已启动本地站点 + /ai 代理 + /sync 中继（端口 ${sitePort}）`)
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await reachable(`http://127.0.0.1:${sitePort}/`)) return
    await wait(400)
  }
  console.log('⚠️ 站点没起来，请查看 tools/local-ai.log')
}

// 硬件接收端（ESP32-S3 上传可见光与热像）：默认一起拉起来，队友不用记第二条命令
async function ensureHardwareReceiver() {
  if (!withHardware) return
  if (await reachable(`http://127.0.0.1:${hardwarePort}/health`)) {
    console.log(`· 硬件接收端已在运行（端口 ${hardwarePort}）`)
    return
  }
  const logHandle = await (await import('node:fs')).openSync?.(logFile, 'a')
  const child = spawn(process.execPath, ['tools/hardware-receiver.mjs', '--port', String(hardwarePort)], {
    detached: true,
    stdio: ['ignore', logHandle ?? 'ignore', logHandle ?? 'ignore'],
  })
  child.unref()
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await wait(300)
    // 端口被占时接收端会自动往后找，这里把 5000~5008 都探一遍
    for (let candidate = hardwarePort; candidate <= hardwarePort + 8; candidate += 1) {
      if (await reachable(`http://127.0.0.1:${candidate}/health`)) {
        console.log(`· 硬件接收端已启动（端口 ${candidate}）：可见光 POST /upload，热像 POST /upload_thermal`)
        return
      }
    }
  }
  console.log('⚠️ 硬件接收端没起来，请查看 tools/local-ai.log')
}

async function printQr(url) {
  try {
    const require = createRequire(import.meta.url)
    const QRCode = require('qrcode')
    console.log(await QRCode.toString(url, { type: 'terminal', small: true, margin: 1 }))
  } catch {
    console.log('（未安装 qrcode 包，跳过二维码；直接打开上面的网址即可）')
  }
}

function openBrowser(url) {
  const command = isWindows ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    spawn(command, [url], { shell: true, detached: true, stdio: 'ignore' }).unref()
  } catch {}
}

export async function main() {
  console.log('== 热感哨兵 · 本地 AI 一键配置 ==')
  console.log(`模型：${model}　端点：${upstream}　站点端口：${sitePort}`)

  if (!checkOnly) {
    const ollamaReady = await ensureOllama()
    if (ollamaReady) await ensureModel()
    await ensureSite()
    await ensureHardwareReceiver()
  }

  console.log('\n== 自检 ==')
  const report = await runDoctor({ upstream, model, siteBase: `http://127.0.0.1:${sitePort}` })
  console.log(formatReport(report))

  const lan = lanAddresses()[0]
  const lanUrl = lan ? `http://${lan}:${sitePort}/mobile-app.html` : `http://127.0.0.1:${sitePort}/mobile-app.html`
  console.log('\n== 给队友/手机 ==')
  console.log(`系统端：${lanUrl}`)
  console.log(`用户端：${lanUrl.replace('mobile-app.html', 'user-app.html')}`)
  console.log('在页面「AI 指挥」里这样填：')
  console.log('  推理来源：本地 Ollama（或自定义端点）')
  console.log('  端点地址：/ai/v1        ← 同源代理，不用填 IP，也不会被浏览器拦')
  console.log(`  模型名  ：${report.checks.find((item) => item.id === 'models')?.matched ?? model}`)
  console.log('')
  console.log('== 硬件（ESP32-S3）==')
  console.log('  可见光上传：http://<本机IP>:5000/upload          ← 固件 serverUrl')
  console.log('  热像上传：  http://<本机IP>:5000/upload_thermal   ← 固件 thermalServerUrl')
  console.log('  观察页面：  http://127.0.0.1:5000/')
  console.log('  没有硬件时可先用模拟器：node tools/hardware-sim.mjs --port 5000 --hot')
  console.log('')
  console.log('手机扫下面这个二维码即可打开系统端：')
  await printQr(lanUrl)

  if (shouldOpen && !checkOnly) openBrowser(`http://127.0.0.1:${sitePort}/mobile-app.html`)
  return report
}

// 只有直接运行本文件时才执行配置流程（被测试或其它脚本 import 时不会乱起服务）
const isCli = process.argv[1] && process.argv[1].endsWith('setup-local-ai.mjs')
if (isCli) {
  const report = await main()
  process.exit(report.ok ? 0 : 1)
}
