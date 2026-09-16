// 硬件接收端纯逻辑单测：固件两种上传格式的解析、热像渲染、终审决策

import {
  decideFire,
  encodePng,
  extractImage,
  parseMultipart,
  parseThermalPayload,
  renderThermalPng,
  temperatureColor,
} from '../tools/hardware-receiver.mjs'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`)
  else { failures += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])])

console.log('[1] 可见光上传（固件格式：image/jpeg + 原始字节）')
{
  const parsed = extractImage(JPEG, 'image/jpeg')
  check('识别为 JPEG', parsed.ok && parsed.jpeg.length === JPEG.length)
  check('内容类型保持 image/jpeg', parsed.contentType === 'image/jpeg')
  check('太小的 body 被拒（避免空包触发终审）', extractImage(Buffer.from([1, 2, 3]), 'image/jpeg').ok === false)
}

console.log('[2] 其它上传方式也兼容（方便用浏览器/Postman 调试）')
{
  const jsonBody = Buffer.from(JSON.stringify({ image: `data:image/jpeg;base64,${JPEG.toString('base64')}` }))
  const fromJson = extractImage(jsonBody, 'application/json')
  check('JSON base64 也能解析', fromJson.ok && fromJson.jpeg.length === JPEG.length)
  check('坏 JSON 给出原因', extractImage(Buffer.from('{oops'), 'application/json').reason === 'json-parse-failed')

  const boundary = '----tgtest'
  const multipart = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    JPEG,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  const parts = parseMultipart(multipart, `multipart/form-data; boundary=${boundary}`)
  check('multipart 解析出字段与类型', parts?.length === 1 && parts[0].name === 'file' && parts[0].type === 'image/jpeg')
  const fromMultipart = extractImage(multipart, `multipart/form-data; boundary=${boundary}`)
  check('multipart 里的图片能取出且字节完整', fromMultipart.ok && fromMultipart.jpeg.length === JPEG.length)
}

console.log('[3] 热像上传（固件格式：{max_temp, sensor_data:[768]}）')
{
  const matrix = Array.from({ length: 768 }, (_, index) => 27 + (index % 10) * 0.5)
  const parsed = parseThermalPayload(Buffer.from(JSON.stringify({ max_temp: 41.5, sensor_data: matrix })), 'application/json')
  check('解析出 768 点矩阵', parsed.ok && parsed.matrix.length === 768)
  check('使用上报的 max_temp', parsed.maxTemp === 41.5)
  check('没给 max_temp 时自行求最大', parseThermalPayload(Buffer.from(JSON.stringify({ sensor_data: matrix })), 'application/json').maxTemp === Math.max(...matrix))
  check('点数不对时拒绝', parseThermalPayload(Buffer.from(JSON.stringify({ sensor_data: [1, 2, 3] })), 'application/json').reason.startsWith('matrix-size'))
  check('非数字矩阵被拒', parseThermalPayload(Buffer.from(JSON.stringify({ sensor_data: new Array(768).fill('abc') })), 'application/json').reason === 'matrix-not-numeric')
  check('兼容 temperatures 字段名', parseThermalPayload(Buffer.from(JSON.stringify({ temperatures: matrix })), 'application/json').ok === true)
}

console.log('[4] 热像渲染成 PNG')
{
  const matrix = Array.from({ length: 768 }, (_, index) => 25 + (index / 768) * 30)
  const png = renderThermalPng(matrix, 32, 24, 10)
  check('产出 PNG 且尺寸正确（32×24 × 10 倍）', Boolean(png) && png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
  check('PNG 里写着 320×240', png.readUInt32BE(16) === 320 && png.readUInt32BE(20) === 240)
  check('矩阵点数不对返回 null', renderThermalPng([1, 2, 3]) === null)
  const color = temperatureColor(85, 25, 90)
  check('高温映射到暖色（红通道最大）', color[0] > color[2])
  check('低温映射到冷色（蓝通道最大）', temperatureColor(26, 25, 90)[2] >= temperatureColor(26, 25, 90)[0])
  check('encodePng 产出合法签名', encodePng(1, 1, Buffer.from([0, 0, 0, 255])).subarray(1, 4).toString() === 'PNG')
}

console.log('[5] 终审决策（固件只看 YES / NO）')
{
  const cool = await decideFire({ jpegBuffer: JPEG, thermal: { at: Date.now(), maxTemp: 34 } })
  check('热像 34°C → NO', cool.answer === 'NO' && cool.source === 'thermal')

  const hot = await decideFire({ jpegBuffer: JPEG, thermal: { at: Date.now(), maxTemp: 86 } })
  check('热像 86°C → YES', hot.answer === 'YES' && hot.source === 'thermal')

  const stale = await decideFire({ jpegBuffer: JPEG, thermal: { at: Date.now() - 60000, maxTemp: 99 } })
  check('热像数据过期（>30 秒）→ 回落到保守 NO', stale.answer === 'NO' && stale.source === 'fallback')

  const noData = await decideFire({ jpegBuffer: JPEG, thermal: null })
  check('没有热像也没有视觉服务 → NO 并说明原因', noData.answer === 'NO' && noData.reason.includes('保守'))

  const unreachable = await decideFire({ jpegBuffer: JPEG, thermal: null, visionUrl: 'http://127.0.0.1:1' })
  check('视觉服务不可用时不抛错', unreachable.answer === 'NO')
}

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
