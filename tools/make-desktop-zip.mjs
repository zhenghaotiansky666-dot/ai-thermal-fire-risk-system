// 打包"电脑版"：预构建站点 + 一键启动器 + 本地服务 + 硬件接收端 + 编辑指南。
//
// 用法：node tools/make-desktop-zip.mjs [输出目录]
// 产物：FireAegis-电脑版-<日期>.zip
//
// 与"队友运行包"的区别：这个包是给**要在电脑上长期监看、并且可能要改硬件参数**的人用的，
// 所以带上启动电脑版的脚本（独立窗口 + 监看模式）和 docs/ 里的硬件编辑指南。

import { chmod, cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { resolve, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const argv = process.argv.slice(2)
// --with-model：把 1.9GB 的决策模型和 Ollama 离线安装包一起打进去（离线演示用，包会很大）
const withModel = argv.includes('--with-model')
const positional = argv.filter((item) => !item.startsWith('--'))
const outDir = resolve(positional[0] || 'outputs')
const stamp = new Date().toISOString().slice(0, 10)
const packageName = withModel ? `FireAegis-电脑版-AI离线版-${stamp}` : `FireAegis-电脑版-${stamp}`
const stage = resolve('.desktop-stage', packageName)
// 决策模型与 Ollama 离线包放在这两个位置（存在才一起打包）
const MODEL_SRC = resolve(process.env.FIREAEGIS_MODEL_FILE || join(process.env.HOME || '', 'ollama-models', 'qwen2.5-3b-instruct.gguf'))
// 离线版要带的是 **Ollama 运行时安装包**（约 200MB），不是队友那个含模型的 zip
//（那个里面已经有 1.9GB 的 gguf，模型我们单独放在 models/ 下，避免重复打包）
const OLLAMA_RUNTIME_CANDIDATES = [
  resolve('Ollama-darwin.zip'),
  resolve('/tmp/Ollama-darwin.zip'),
  resolve(process.env.HOME || '', 'Downloads', 'Ollama-darwin.zip'),
]
const OLLAMA_ZIP_SRC = OLLAMA_RUNTIME_CANDIDATES.find((item) => existsSync(item)) || OLLAMA_RUNTIME_CANDIDATES[0]
const OLLAMA_ZIP_NAME = 'Ollama-运行时.zip'

const FILES = [
  '启动电脑版.command',
  '启动电脑版.bat',
  '启动AI.command',
  '启动AI.bat',
  'package.json',
  'pnpm-lock.yaml',
  'README.md',
]
const DIRS = [
  ['tools', 'tools'],
  ['dist', 'dist'],
  ['docs', 'docs'],
  ['firmware', 'firmware'],
  ['ai', 'ai'],
]

const README = `FireAegis · 电脑版（${stamp}）
========================================

这个包是"放在电脑上监看"的版本：站点已经构建好，双击启动器就能跑，
不用装依赖、也不用编译（除非你自己改了源码）。

【第一步】macOS：双击 启动电脑版.command
          Windows：双击 启动电脑版.bat
    它会自动：检查 Node → 启动硬件接收端（默认 8787）→ 启动站点 →
             等站点就绪后用独立窗口打开指挥端（自动进"电脑监看"模式）
    如果提示没装 Node：macOS 去 nodejs.org 下 LTS；Windows 可让脚本用 winget 装。

【想连 AI（推荐一起做）】
    先双击 启动AI.command（macOS）/ 启动AI.bat（Windows），它会：
      · 装好并启动 Ollama（本包已带离线安装包时不会联网）
      · 导入决策模型 fireaegis（视觉/决策两块 AI 自动接上）
      · 启动视觉服务（YOLO + ai/best.pt，端口 8000）
    然后再双击「启动电脑版」。系统端打开后右上角会显示
    「AI 就绪 · fireaegis:latest + YOLO」。

    · 视觉 AI：ai/best.pt（队友训练的火焰/烟雾模型），端口 8000
    · 决策 AI：本地 Ollama 的 fireaegis（qwen2.5-3b-instruct），端口 11434
    · 没有 AI 也能跑：页面会自动回落到本机规则引擎，报警与疏散不受影响。

【第二步】把窗口放到大屏上
    · 指挥端地址：http://127.0.0.1:4173/mobile-app.html
    · 建看模式：  http://127.0.0.1:4173/mobile-app.html?monitor=1
      也可以在页面右上角点「电脑监看」按钮随时切换（设置会记住）
    · 手机/其它设备（同一 Wi-Fi）：看站点窗口里打印的局域网地址与二维码

【硬件同学要看这里】
    docs/硬件同学-编辑指南.md
    里面写了：端口三处怎么改、/upload 与 /upload_thermal 的约定、
    终审阈值、固件两行地址怎么生成、有哪些接口不要动。

【常用命令】
    node tools/ai-doctor.mjs                     # 环境与端口自检
    node tools/hardware-sim.mjs --port 8787 --hot # 没有硬件时模拟一次高温帧
    node tools/hardware-receiver.mjs --port 8787 --print-firmware  # 打印固件要替换的两行

【说明】
    · 端口默认 8787：macOS 的 5000 被"隔空播放接收器"占用，所以刻意避开；
    · 改源码后需要重新构建：npm install（第一次）→ npm run build；
    · 出问题把 ai-doctor 的输出发回来即可。
`

async function main() {
  if (!existsSync(resolve('dist', 'index.html'))) {
    throw new Error('没找到 dist/index.html，请先构建：npm run build')
  }
  await rm(resolve('.desktop-stage'), { recursive: true, force: true })
  await mkdir(stage, { recursive: true })

  for (const file of FILES) {
    if (existsSync(resolve(file))) await cp(resolve(file), join(stage, file))
  }
  for (const [from, to] of DIRS) {
    if (existsSync(resolve(from))) await cp(resolve(from), join(stage, to), { recursive: true })
  }
  // 双击启动器必须保留可执行位
  const macLauncher = join(stage, '启动电脑版.command')
  if (existsSync(macLauncher)) await chmod(macLauncher, 0o755)
  const aiLauncher = join(stage, '启动AI.command')
  if (existsSync(aiLauncher)) await chmod(aiLauncher, 0o755)

  // 离线版：把决策模型（1.9GB）与 Ollama 离线安装包一起放进去
  if (withModel) {
    if (existsSync(MODEL_SRC)) {
      await mkdir(join(stage, 'models'), { recursive: true })
      console.log(`· 打包决策模型：${MODEL_SRC}`)
      await cp(MODEL_SRC, join(stage, 'models', 'qwen2.5-3b-instruct.gguf'))
    } else {
      console.warn(`⚠️ 没找到决策模型（${MODEL_SRC}），离线版将不含大模型`)
    }
    if (existsSync(OLLAMA_ZIP_SRC)) {
      console.log(`· 打包 Ollama 运行时（${OLLAMA_ZIP_SRC}）`)
      await cp(OLLAMA_ZIP_SRC, join(stage, OLLAMA_ZIP_NAME))
    } else {
      console.warn('⚠️ 没找到 Ollama 运行时安装包（Ollama-darwin.zip），离线版首次安装 Ollama 时需要联网')
    }
  }
  await writeFile(join(stage, '说明-先读我.txt'), README, 'utf8')

  await mkdir(outDir, { recursive: true })
  const zipPath = join(outDir, `${packageName}.zip`)
  await rm(zipPath, { force: true })

  const zipScript = [
    'import os, sys, zipfile',
    'root, out, name = sys.argv[1], sys.argv[2], sys.argv[3]',
    'with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:',
    '    for base, dirs, files in os.walk(os.path.join(root, name)):',
    '        dirs[:] = [d for d in dirs if d not in {"node_modules", ".git", ".venv", "__pycache__", ".desktop-stage"}]',
    '        for f in files:',
    '            if f.endswith((".log", ".pyc")) or f == ".DS_Store":',
    '                continue',
    '            full = os.path.join(base, f)',
    '            z.write(full, os.path.relpath(full, root))',
    'print("ok")',
  ].join('\n')
  await run('python3', ['-c', zipScript, resolve('.desktop-stage'), zipPath, packageName])

  const verify = await run('python3', ['-c', [
    'import sys, zipfile',
    'names = zipfile.ZipFile(sys.argv[1]).namelist()',
    'hits = [n for n in names if "启动电脑版.command" in n or "说明-先读我" in n or "硬件同学" in n]',
    'print(len(names), "|", "; ".join(hits))',
  ].join('\n'), zipPath])
  console.log(`压缩包内文件名自检：${verify.stdout.trim()}`)
  await rm(resolve('.desktop-stage'), { recursive: true, force: true })

  const { stdout } = await run('du', ['-sh', zipPath])
  console.log(`已生成电脑版：${zipPath}（${stdout.trim().split('\t')[0]}）`)
}

main().catch((error) => {
  console.error('打包失败：', error.message)
  process.exit(1)
})
