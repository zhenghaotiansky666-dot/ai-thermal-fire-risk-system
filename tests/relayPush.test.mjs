// 局域网中继"发出去就立刻到"的回归测试。
//
// 为什么值得单独测：用户端、楼道喇叭页、系统端都靠 /sync/events 长轮询拿事件。
// 如果推送唤醒这段逻辑坏了，事件不会丢，但会一直等到 15 秒超时才送达——
// 演示时就是"报警了，手机过十几秒才响"。这个坑之前真的出现过（等待者比较条件写错），
// 所以这里直接卡死延迟上限。

import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`)
  else { failures += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

const port = 9100 + Math.floor(Math.random() * 90)
const base = `http://127.0.0.1:${port}`
const server = spawn(process.execPath, ['tools/local-ai-server.mjs', '--port', String(port)], { stdio: 'ignore' })

async function waitReady() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${base}/sync/health`)
      if (response.ok) return true
    } catch {}
    await delay(200)
  }
  return false
}

const publish = (event) => fetch(`${base}/sync/publish`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(event),
})

try {
  const ready = await waitReady()
  check('本地站点与中继能启动', ready)

  if (ready) {
    console.log('[1] 长轮询：发布后立即唤醒等待者')
    {
      // 先取一次拿游标（和页面的做法一致：第一次 wait=0 立刻返回）
      const first = await (await fetch(`${base}/sync/events?since=0&wait=0`)).json()
      const cursor = Number(first.seq)

      const startedAt = Date.now()
      const waiting = fetch(`${base}/sync/events?since=${cursor}&wait=20000`).then((response) => response.json())
      await delay(500)
      await publish({ v: 1, id: 'push-test-1', kind: 'fire', at: Date.now(), from: 'system', payload: { nodeId: 'C4', floor: 4 } })
      const payload = await waiting
      const elapsed = Date.now() - startedAt

      check('等待者拿到刚发布的事件', payload.events?.some((item) => item.id === 'push-test-1'))
      check('唤醒是"推送"而不是等超时（20000ms 的长轮询，实际远小于它）', elapsed < 3000, `实际 ${elapsed}ms`)
    }

    console.log('[2] 游标推进：不会重复收到旧事件')
    {
      const all = await (await fetch(`${base}/sync/events?since=0&wait=0`)).json()
      const latest = Number(all.seq)
      const empty = await (await fetch(`${base}/sync/events?since=${latest}&wait=600`)).json()
      check('取到最新游标后没有新事件', (empty.events || []).length === 0)

      const older = await (await fetch(`${base}/sync/events?since=0&wait=0`)).json()
      check('从 0 开始仍能取到历史事件（喇叭页/用户端刚打开时会灌一次）', older.events.some((item) => item.id === 'push-test-1'))
    }

    console.log('[3] 心跳事件：喇叭页值守状态可被系统端读到')
    {
      await publish({
        v: 1,
        id: 'speaker-beat-1',
        kind: 'status',
        at: Date.now(),
        ttl: 120000,
        from: 'speaker',
        payload: { role: 'speaker', name: 'R 座' },
      })
      const all = await (await fetch(`${base}/sync/events?since=0&wait=0`)).json()
      const beat = all.events.find((item) => item.id === 'speaker-beat-1')
      check('喇叭页心跳带得动"值守设备"统计', beat?.from === 'speaker' && beat?.payload?.name === 'R 座')
    }
  }
} finally {
  server.kill('SIGKILL')
}

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
