// 用队友给的 Roboflow 数据集实测 ai/best.pt：
// 按 IoU >= 0.5 + 类别一致匹配预测框与标注框，算每类的 precision / recall / F1。
//
// 用法：node tools/validate-yolo.mjs --dir <数据集目录> --names fire,smoke [--limit 50] [--conf 0.25]
//   · --dir    数据集根目录（下面要有 valid/images 与 valid/labels）
//   · --names  该数据集的类别顺序，例如 "fire,smoke" 或 "fire,light,no-fire,smoke"；
//              名字里含 "fire"/"smoke" 的才会与模型输出比对，其余类别（如 light）忽略
//   · --url    视觉服务地址，默认 http://127.0.0.1:8000

import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const valueOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const dir = valueOf('dir', '')
const names = valueOf('names', 'fire,smoke').split(',').map((s) => s.trim())
const limit = Number(valueOf('limit', '50'))
const conf = Number(valueOf('conf', '0.25'))
const url = valueOf('url', 'http://127.0.0.1:8000')
const iouThreshold = Number(valueOf('iou', '0.5'))

if (!dir || !existsSync(join(dir, 'valid', 'images'))) {
  console.error('用法：node tools/validate-yolo.mjs --dir <数据集目录> --names fire,smoke [--limit 50]')
  process.exit(2)
}

// 该数据集的类别 id → 模型能认的类别名（只保留 fire / smoke）
const classOf = (id) => {
  const raw = String(names[id] ?? '').toLowerCase()
  if (raw.includes('fire') || raw.includes('flame')) return 'fire'
  if (raw.includes('smoke')) return 'smoke'
  return null
}

// 从 JPEG 头里读宽高（标注是归一化坐标，要还原成像素才能算 IoU）
function jpegSize(buffer) {
  let index = 2
  while (index + 9 < buffer.length) {
    if (buffer[index] !== 0xff) { index += 1; continue }
    const marker = buffer[index + 1]
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buffer.readUInt16BE(index + 5), width: buffer.readUInt16BE(index + 7) }
    }
    const length = buffer.readUInt16BE(index + 2)
    index += 2 + length
  }
  return null
}

const iou = (a, b) => {
  const x1 = Math.max(a[0], b[0]); const y1 = Math.max(a[1], b[1])
  const x2 = Math.min(a[2], b[2]); const y2 = Math.min(a[3], b[3])
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1])
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1])
  const union = areaA + areaB - inter
  return union <= 0 ? 0 : inter / union
}

const imageDir = join(dir, 'valid', 'images')
const labelDir = join(dir, 'valid', 'labels')
const files = (await readdir(imageDir)).filter((f) => /\.(jpe?g|png)$/i.test(f)).slice(0, limit)

const stats = { fire: { tp: 0, fp: 0, fn: 0 }, smoke: { tp: 0, fp: 0, fn: 0 } }

for (const file of files) {
  const buffer = await readFile(join(imageDir, file))
  const size = jpegSize(buffer)
  if (!size) continue

  const labelPath = join(labelDir, `${file.replace(/\.[^.]+$/, '')}.txt`)
  const gt = []
  if (existsSync(labelPath)) {
    const text = await readFile(labelPath, 'utf8')
    for (const line of text.split('\n')) {
      const parts = line.trim().split(/\s+/).map(Number)
      if (parts.length < 5) continue
      const kind = classOf(parts[0])
      if (!kind) continue
      // 两种标注格式都要认：
      //   · 检测：class cx cy w h（5 个数）
      //   · 分割：class x1 y1 x2 y2 ... （多边形顶点，队友这三个数据集就是这种）
      if (parts.length === 5) {
        const [cx, cy, w, h] = parts.slice(1, 5)
        gt.push({
          kind,
          box: [
            (cx - w / 2) * size.width, (cy - h / 2) * size.height,
            (cx + w / 2) * size.width, (cy + h / 2) * size.height,
          ],
        })
      } else {
        const points = parts.slice(1)
        const xs = points.filter((_, i) => i % 2 === 0).map((v) => v * size.width)
        const ys = points.filter((_, i) => i % 2 === 1).map((v) => v * size.height)
        if (xs.length && ys.length) {
          gt.push({ kind, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] })
        }
      }
    }
  }

  let preds = []
  try {
    const response = await fetch(`${url}/detect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: `data:image/jpeg;base64,${buffer.toString('base64')}`, conf }),
    })
    const payload = await response.json()
    preds = (payload.detections ?? [])
      .map((d) => {
        // 服务的 kind 是内部命名：flame / smoke / other —— 这里统一成 fire / smoke
        const raw = String(d.kind ?? d.label ?? '').toLowerCase()
        const kind = raw === 'flame' || raw === 'fire' ? 'fire' : raw === 'smoke' ? 'smoke' : null
        return { kind, box: d.box, confidence: d.confidence }
      })
      .filter((d) => d.kind !== null)
  } catch (error) {
    console.error(`  ${file} 检测失败：${error.message}`)
    continue
  }

  const usedPred = new Set()
  for (const target of gt) {
    let bestIndex = -1
    let bestIou = 0
    preds.forEach((pred, index) => {
      if (usedPred.has(index) || pred.kind !== target.kind) return
      const score = iou(pred.box, target.box)
      if (score > bestIou) { bestIou = score; bestIndex = index }
    })
    if (bestIndex >= 0 && bestIou >= iouThreshold) {
      stats[target.kind].tp += 1
      usedPred.add(bestIndex)
    } else {
      stats[target.kind].fn += 1
    }
  }
  preds.forEach((pred, index) => {
    if (!usedPred.has(index)) stats[pred.kind].fp += 1
  })
}

console.log(`数据集：${dir}`)
console.log(`类别顺序：${names.join(', ')} · 抽检 ${files.length} 张 · conf=${conf} · IoU>=${iouThreshold}`)
console.log('')
console.log('类别    TP    FP    FN   precision   recall     F1')
for (const kind of ['fire', 'smoke']) {
  const { tp, fp, fn } = stats[kind]
  const precision = tp + fp === 0 ? null : tp / (tp + fp)
  const recall = tp + fn === 0 ? null : tp / (tp + fn)
  const f1 = precision && recall ? (2 * precision * recall) / (precision + recall) : null
  const pct = (v) => (v === null ? '   —  ' : `${(v * 100).toFixed(1)}%`.padStart(6))
  console.log(`${kind.padEnd(6)} ${String(tp).padStart(4)}  ${String(fp).padStart(4)}  ${String(fn).padStart(4)}   ${pct(precision)}     ${pct(recall)}   ${pct(f1)}`)
}
