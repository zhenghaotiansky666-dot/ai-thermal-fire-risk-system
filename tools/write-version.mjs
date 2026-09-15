// 构建前生成 public/version.json：它是"线上有没有新版本"的唯一信号。
//
// 每次构建都会写入一个新的 buildId（优先用 CI 的 commit sha，本地用时间戳），
// 前端启动时会拿自己内置的 buildId 和它比对，不一致就提示"有新版本，点此更新"。
//
// 用法：node tools/write-version.mjs   （package.json 的 build 脚本会自动调用）

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

async function main() {
  const pkg = JSON.parse(await readFile(resolve('package.json'), 'utf8'))
  const commit = process.env.GITHUB_SHA || process.env.VERCEL_GIT_COMMIT_SHA || ''
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const buildId = commit ? `${pkg.version}-${commit.slice(0, 7)}` : `${pkg.version}-${stamp}`
  const payload = {
    version: pkg.version,
    buildId,
    builtAt: new Date().toISOString(),
    commit: commit || null,
    _readme: '这个文件由 tools/write-version.mjs 在构建时生成，用于让已安装的用户端/系统端自动发现新版本。',
  }
  await mkdir(resolve('public'), { recursive: true })
  await writeFile(resolve('public/version.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  console.log(`已生成 public/version.json → buildId=${buildId}`)
}

main().catch((error) => {
  console.error('生成版本信息失败：', error)
  process.exit(1)
})
