// 极简 WebSocket 服务端：只实现"服务端推 JSON 文本给浏览器"这一件事。
//
// 为什么不用 `ws` 包：队友的运行环境里往往没有 node_modules，为了跑一个网关去装 npm 包
// 成本太高。这里用 Node 内置的 http/crypto 实现握手与帧编解码，零依赖。
//
// 兼容 `ws` 的最小子集：
//   const wss = createWebSocketServer({ server, path })
//   wss.clients                     // Set，元素是 socket
//   wss.on('connection', socket => { socket.send('...'); socket.on('message', fn) })
//   socket.send(text) / socket.close() / socket.readyState / WebSocket.OPEN
//   wss.close()

import { createHash } from 'node:crypto'

export const WS_OPEN = 1
export const WS_CLOSED = 3

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

// 纯函数：握手用的 Sec-WebSocket-Accept（单测直接覆盖这条 RFC 示例）
export function acceptKey(clientKey) {
  return createHash('sha1').update(`${String(clientKey ?? '').trim()}${GUID}`).digest('base64')
}

// 纯函数：把一段文本编码成"服务端 → 客户端"的帧（不掩码）
export function encodeTextFrame(text) {
  const payload = Buffer.from(String(text ?? ''), 'utf8')
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.from([0x81, length])
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, payload])
}

export function encodeCloseFrame() {
  return Buffer.from([0x88, 0x00])
}

export function encodePongFrame(payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''))
  return Buffer.concat([Buffer.from([0x8a, body.length]), body])
}

// 纯函数：从缓冲区里解出完整帧（客户端 → 服务端，必须带掩码）
// 返回 { frames: [{ opcode, payload, fin }], rest }
export function decodeFrames(buffer) {
  const frames = []
  let offset = 0
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? [])
  while (offset + 2 <= data.length) {
    const first = data[offset]
    const second = data[offset + 1]
    const fin = (first & 0x80) !== 0
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let cursor = offset + 2
    if (length === 126) {
      if (cursor + 2 > data.length) break
      length = data.readUInt16BE(cursor)
      cursor += 2
    } else if (length === 127) {
      if (cursor + 8 > data.length) break
      length = Number(data.readBigUInt64BE(cursor))
      cursor += 8
    }
    const maskKey = masked ? data.subarray(cursor, cursor + 4) : null
    if (masked) cursor += 4
    if (cursor + length > data.length) break
    const raw = Buffer.from(data.subarray(cursor, cursor + length))
    if (masked && maskKey?.length === 4) {
      for (let index = 0; index < raw.length; index += 1) raw[index] ^= maskKey[index % 4]
    }
    frames.push({ opcode, payload: raw, fin })
    offset = cursor + length
  }
  return { frames, rest: data.subarray(offset) }
}

export function createWebSocketServer({ server, path = '/' } = {}) {
  const clients = new Set()
  const connectionHandlers = []
  const closeHandlers = []

  if (!server?.on) throw new Error('createWebSocketServer 需要一个 http(s) server')

  server.on('upgrade', (request, socket, head) => {
    const url = String(request.url ?? '/')
    if (path && !url.startsWith(path)) {
      socket.destroy()
      return
    }
    const key = request.headers['sec-websocket-key']
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '',
      '',
    ].join('\r\n'))

    let buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0)
    const messageHandlers = []
    const socketCloseHandlers = []

    const client = {
      readyState: WS_OPEN,
      send(text) {
        if (client.readyState !== WS_OPEN) return false
        try {
          socket.write(encodeTextFrame(text))
          return true
        } catch {
          client.readyState = WS_CLOSED
          return false
        }
      },
      close() {
        if (client.readyState === WS_CLOSED) return
        client.readyState = WS_CLOSED
        try {
          socket.write(encodeCloseFrame())
        } catch {}
        socket.end()
      },
      on(event, handler) {
        if (event === 'message' && typeof handler === 'function') messageHandlers.push(handler)
        if (event === 'close' && typeof handler === 'function') socketCloseHandlers.push(handler)
        return client
      },
    }

    const cleanup = () => {
      client.readyState = WS_CLOSED
      clients.delete(client)
      socketCloseHandlers.forEach((handler) => {
        try {
          handler()
        } catch {}
      })
    }

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const { frames, rest } = decodeFrames(buffer)
      buffer = Buffer.from(rest)
      for (const frame of frames) {
        if (frame.opcode === 0x8) {
          cleanup()
          socket.end()
          return
        }
        if (frame.opcode === 0x9) {
          try {
            socket.write(encodePongFrame(frame.payload))
          } catch {}
          continue
        }
        if (frame.opcode === 0x1) {
          const text = frame.payload.toString('utf8')
          messageHandlers.forEach((handler) => {
            try {
              handler(text)
            } catch {}
          })
        }
      }
    })
    socket.on('close', cleanup)
    socket.on('error', cleanup)

    clients.add(client)
    connectionHandlers.forEach((handler) => {
      try {
        handler(client)
      } catch {}
    })
  })

  return {
    clients,
    on(event, handler) {
      if (event === 'connection' && typeof handler === 'function') connectionHandlers.push(handler)
      if (event === 'close' && typeof handler === 'function') closeHandlers.push(handler)
      return undefined
    },
    close() {
      clients.forEach((client) => client.close())
      closeHandlers.forEach((handler) => {
        try {
          handler()
        } catch {}
      })
    },
  }
}

// 让调用方的 `WebSocket.OPEN` 这种写法也能用
export const WebSocket = { OPEN: WS_OPEN, CLOSED: WS_CLOSED }
