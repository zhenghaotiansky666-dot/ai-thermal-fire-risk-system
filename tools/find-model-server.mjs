// 局域网里找模型服务（"队友接不进去"里最常见的一种：IP 填错/根本不知道对端 IP）
//
// 做法：在同一个网段里扫常见端口（Ollama 11434、LM Studio 1234、vLLM 8000、通用 8080），
// 谁的 /v1/models 能正常返回，就把它列出来，并给出可直接粘贴的「端点地址 / 模型名」。
//
// 用法：
//   node tools/find-model-server.mjs                 # 扫本机所在网段
//   node tools/find-model-server.mjs --subnet 192.168.1   # 指定网段
//   node tools/find-model-server.mjs --budget 8000   # 扫描预算（毫秒）

import { networkInterfaces } from 'node:os'

export const COMMON_PORTS = [11434, 1234, 8000, 8080]

export function hostsInSubnet(ip, prefix = 24) {
  const parts = String(ip).split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return []
  const base = prefix === 24 ? parts.slice(0, 3).join('.') : parts.slice(0, 2).join('.')
  const hosts = []
  const range = prefix === 24 ? 254 : 65534
  for (let index = 1; index <= Math.min(range, 254); index += 1) {
    hosts.push(`${base}.${index}`)
  }
  return hosts
}

export function candidateUrls(host, ports = COMMON_PORTS) {
  return ports.map((port) => `http://${host}:${port}/v1/models`)
}

// 排序：优先 Ollama/LM Studio 这类明确是本机模型服务的端口，其次才是通用端口
export function rankCandidates(list) {
  const weight = (url) => {
    if (url.includes(':11434')) return 0
    if (url.includes(':1234')) return 1
    if (url.includes(':8000')) return 2
    return 3
  }
  return [...list].sort((a, b) => weight(a.url) - weight(b.url) || a.url.localeCompare(b.url))
}

export function localSubnets() {
  const out = new Set()
  const interfaces = networkInterfaces()
  Object.values(interfaces).forEach((list) => {
    (list ?? []).forEach((item) => {
      if (item.family === 'IPv4' && !item.internal) out.add(item.address.split('.').slice(0, 3).join('.'))
    })
  })
  return [...out]
}

async function probe(url, timeoutMs) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = setTimeout(() => controller?.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller?.signal, cache: 'no-store' })
    if (!response.ok) return null
    const data = await response.json().catch(() => null)
    const models = (data?.data ?? data?.models ?? []).map((item) => item?.id ?? item?.name).filter(Boolean)
    return { url, models }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function discoverModelServers(options = {}) {
  const prefixes = options.subnet ? [String(options.subnet).replace(/\.$/, '')] : localSubnets()
  const ports = options.ports ?? COMMON_PORTS
  const budgetMs = Number(options.budgetMs) || 7000
  const perRequestMs = Number(options.timeoutMs) || 500
  const concurrency = Number(options.concurrency) || 24
  const deadline = Date.now() + budgetMs

  const targets = []
  prefixes.forEach((prefix) => {
    hostsInSubnet(`${prefix}.1`).forEach((host) => {
      candidateUrls(host, ports).forEach((url) => targets.push({ url }))
    })
  })

  const found = []
  let cursor = 0
  async function worker() {
    while (cursor < targets.length && Date.now() < deadline) {
      const target = targets[cursor]
      cursor += 1
      const hit = await probe(target.url, perRequestMs)
      if (hit) found.push(hit)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return { found: rankCandidates(found), scanned: cursor, total: targets.length, prefixes, ports }
}

function endpointOf(url) {
  return url.replace(/\/models$/, '')
}

const isCli = process.argv[1] && process.argv[1].endsWith('find-model-server.mjs')
if (isCli) {
  const args = process.argv.slice(2)
  const readArg = (name, fallback) => {
    const index = args.indexOf(name)
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback
  }
  const subnet = readArg('--subnet', '')
  console.log('== 扫描局域网里的模型服务 ==')
  console.log(`网段：${subnet || localSubnets().join('、') || '（没检测到局域网）'}　端口：${COMMON_PORTS.join('、')}`)
  const result = await discoverModelServers({ subnet, budgetMs: Number(readArg('--budget', '7000')) })
  console.log(`已探测 ${result.scanned}/${result.total} 个地址`)
  if (!result.found.length) {
    console.log('没找到可用的模型服务。可以检查：')
    console.log('  · 模型是否用"局域网可访问"的方式启动：OLLAMA_HOST=0.0.0.0:11434 ollama serve')
    console.log('  · 两台电脑是否在同一个 Wi-Fi（可先互相 ping 一下）')
    console.log('  · 防火墙是否放行 11434')
    process.exit(1)
  }
  result.found.forEach((hit, index) => {
    console.log(`\n${index + 1}) ${endpointOf(hit.url)}`)
    console.log(`   可用模型：${hit.models.slice(0, 5).join('、') || '（接口没返回模型名）'}`)
    console.log(`   端点在页面「AI 指挥」里这样填：${endpointOf(hit.url)}`)
    console.log(`   模型名填：${hit.models[0] ?? '（用 ollama list 查看）'}`)
  })
}
