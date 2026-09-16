// 打包"队友运行包"：预构建站点 + 一键脚本 + YOLO 服务模板（不含 node_modules / 源码构建链）。
//
// 用法：node tools/make-handoff-zip.mjs [输出目录]
// 产物：热感哨兵-队友运行包-<日期>.zip

import { chmod, cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { resolve, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const outDir = resolve(process.argv[2] || 'outputs')
const stamp = new Date().toISOString().slice(0, 10)
const packageName = `热感哨兵-队友运行包-${stamp}`
const stage = resolve('.handoff-stage', packageName)

const FILES = [
  '启动本地AI.bat',
  '启动本地AI.command',
  'package.json',
  'pnpm-lock.yaml',
]
const DIRS = [
  ['tools', 'tools'],
  ['dist', 'dist'],
]

const README = `热感哨兵 · 队友运行包（${stamp}）
========================================

这个包是"拿来就能跑"的版本：站点已经构建好，不需要联网装依赖、不需要编译。

【第一步】Windows：双击 启动本地AI.bat  ；macOS：双击 启动本地AI.command
    它会自动：检查 Node → 启动本地站点（含 /ai 代理与事件中继）→ 自检 → 打印地址与二维码
    如果提示没装 Node：winget install OpenJS.NodeJS.LTS（或去 nodejs.org 下 LTS）

【第二步】把打印出来的地址发给手机/另一台电脑（同一个 Wi-Fi 即可）：
    系统端  http://<本机IP>:4173/mobile-app.html
    用户端  http://<本机IP>:4173/user-app.html

【第三步】接 YOLO（视觉通道）
    注意：python 命令必须在【命令提示符(cmd)或 PowerShell】里敲，
    不能在 Node 的交互窗口里敲（会出现 Uncaught SyntaxError）。

    先装 Python（如果还没有）：winget install Python.Python.3.12
    然后：
        cd tools\\yolo-service
        pip install -r requirements.txt
        python app.py --host 0.0.0.0 --port 8000

    页面上填：系统端 → AI 指挥 → 视觉通道（YOLO）→ 服务地址 http://<本机IP>:8000
    没有装 YOLO 也能先联调：node tools\\yolo-service\\mock_service.mjs 8000 --flame 0.82 --smoke 0.35

【检查工具】
    node tools\\ai-doctor.mjs                # 自检：端口 / CORS / 模型 / 站点 / 代理
    node tools\\find-model-server.mjs        # 在局域网里找模型服务
    页面：http://127.0.0.1:4173/ai-check.html （浏览器端自检 + 扫描配对二维码）

【说明】
    · 只装 YOLO 也能跑完整流程：感知（火焰/烟雾）来自 YOLO，决策由本机规则引擎给出；
      再配一个对话模型（Ollama 等）可以让决策变成生成式、并写救援简报。
    · 出问题就把 ai-doctor 的输出或 ai-check 页面的结果截图发回来。
`

async function main() {
  if (!existsSync(resolve('dist', 'index.html'))) {
    throw new Error('没找到 dist/index.html，请先构建：npm run build')
  }
  await rm(resolve('.handoff-stage'), { recursive: true, force: true })
  await mkdir(stage, { recursive: true })

  for (const file of FILES) {
    if (existsSync(resolve(file))) await cp(resolve(file), join(stage, file))
  }
  for (const [from, to] of DIRS) {
    if (existsSync(resolve(from))) await cp(resolve(from), join(stage, to), { recursive: true })
  }
  // macOS 的 .command 必须是可执行文件，双击才能运行（zip 会保留这个权限位）
  const macLauncher = join(stage, '启动本地AI.command')
  if (existsSync(macLauncher)) await chmod(macLauncher, 0o755)
  await writeFile(join(stage, '说明-先读我.txt'), README, 'utf8')

  await mkdir(outDir, { recursive: true })
  const zipPath = join(outDir, `${packageName}.zip`)
  await rm(zipPath, { force: true })
  // 用 Python 的 zipfile 打包：它会为非 ASCII 文件名写 UTF-8 标记，
  // Windows 资源管理器解压后中文文件名不会变成乱码（Info-ZIP 在 macOS 上不写这个标记）
  const zipScript = [
    'import os, sys, zipfile',
    'root, out, name = sys.argv[1], sys.argv[2], sys.argv[3]',
    'with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:',
    '    for base, dirs, files in os.walk(os.path.join(root, name)):',
    '        dirs[:] = [d for d in dirs if d not in {"node_modules", ".git"}]',
    '        for f in files:',
    '            if f.endswith(".log") or f == ".DS_Store":',
    '                continue',
    '            full = os.path.join(base, f)',
    '            z.write(full, os.path.relpath(full, root))',
    'print("ok")',
  ].join('\n')
  await run('python3', ['-c', zipScript, resolve('.handoff-stage'), zipPath, packageName])
  // 自检：读回压缩包，确认中文文件名能正确解出（避免队友那边看到乱码）
  const verify = await run('python3', ['-c', [
    'import sys, zipfile',
    'names = zipfile.ZipFile(sys.argv[1]).namelist()',
    'hits = [n for n in names if "启动本地AI.bat" in n or "说明-先读我" in n]',
    'print(len(names), "|", "; ".join(hits))',
  ].join('\n'), zipPath])
  console.log(`压缩包内文件名自检：${verify.stdout.trim()}`)
  await rm(resolve('.handoff-stage'), { recursive: true, force: true })

  const { stdout } = await run('du', ['-sh', zipPath])
  console.log(`已生成运行包：${zipPath}（${stdout.trim().split('\t')[0]}）`)
}

main().catch((error) => {
  console.error('打包失败：', error.message)
  process.exit(1)
})
