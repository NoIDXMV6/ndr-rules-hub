// Растеризация логотипа в PNG нужных размеров для favicon.ico.
// Запуск: bun scripts/make-favicon.mjs
// SVG — векторный, поэтому каждый размер рендерится отдельно (чётко на 16px и на 256px).
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import sharp from 'sharp'

const OUT = '/tmp/favicon-png'
const SIZES = [16, 32, 48, 64, 128, 256]

mkdirSync(OUT, { recursive: true })

const svg = resolve(process.cwd(), 'public/logo.svg')

// SVG viewBox 512×512 при 72dpi → 512px; density = 72 * size/512 даёт ровно size px
for (const size of SIZES) {
  await sharp(svg, { density: (72 * size) / 512 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(`${OUT}/icon-${size}.png`)
  console.log(`ok ${size}px`)
}
