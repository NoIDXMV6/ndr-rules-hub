// Рендер диаграмм §12 architecture.md / architecture.en.md в PNG (2x) для раздела «Помощь».
// Валидация: mermaid.parse + mermaid.render в реальном mermaid 11 (headless chrome).
// PNG вместо SVG: flowchart с foreignObject не отображается через <img>.
// Запуск: cp в /tmp/mmdcheck && node render-help-diagrams.mjs
import puppeteer from 'puppeteer-core'
import fs from 'fs'
import path from 'path'

const EXE = '/home/z/.cache/puppeteer/chrome-headless-shell/linux-156.0.8078.47/chrome-headless-shell-linux64/chrome-headless-shell'
const WORK = '/tmp/mmdcheck'
const OUT = '/home/z/my-project/public/diagrams'
const ARCH = {
  ru: '/home/z/my-project/architecture.md',
  en: '/home/z/my-project/architecture.en.md',
}
// порядок блоков в §12: схемы доставки (flowchart), PUSH (sequence), PULL (sequence)
const NAMES = ['clearndr-schemes', 'clearndr-push', 'clearndr-pull']

function extractSection12(md) {
  const m = md.match(/^## 12\.[\s\S]*$/m)
  if (!m) throw new Error('раздел 12 не найден')
  const re = /```mermaid\n([\s\S]*?)```/g
  const blocks = []
  let b
  while ((b = re.exec(m[0]))) blocks.push(b[1])
  return blocks
}

const tasks = []
for (const lang of ['ru', 'en']) {
  const blocks = extractSection12(fs.readFileSync(ARCH[lang], 'utf8'))
  if (blocks.length !== NAMES.length) {
    throw new Error(`${ARCH[lang]}: ждали ${NAMES.length} диаграмм в §12, нашли ${blocks.length}`)
  }
  NAMES.forEach((name, i) => tasks.push({
    id: `${name}-${lang}`,
    src: blocks[i],
    out: path.join(OUT, lang === 'en' ? `${name}-en.png` : `${name}.png`),
  }))
}

fs.mkdirSync(OUT, { recursive: true })

const html = `<!doctype html><html><head><meta charset="utf-8"><script src="./node_modules/mermaid/dist/mermaid.min.js"></script>
<style>body{margin:0;padding:0;background:#fff}#box{display:inline-block;padding:10px;background:#fff;width:1400px}</style></head>
<body><div id="box"></div><script>
mermaid.initialize({ startOnLoad: false, theme: 'default' });
window.ready = async (src, id) => {
  document.getElementById('box').innerHTML = '';
  await mermaid.parse(src);
  const { svg } = await mermaid.render(id, src);
  if (!svg.includes('<svg')) throw new Error('render: в выводе нет <svg>');
  document.getElementById('box').innerHTML = svg;
  // SVG с width=100% в shrink-to-fit контейнере сжимается до 300px —
  // поэтому контейнер заранее фиксированной ширины, а после рендера подгоняем вплотную
  const s = document.querySelector('#box svg');
  const r = s.getBoundingClientRect();
  document.getElementById('box').style.width = (r.width + 20) + 'px';
  return { w: Math.round(r.width), h: Math.round(r.height) };
};
</script></body></html>`
fs.writeFileSync(path.join(WORK, 'help-diagrams.html'), html)

const browser = await puppeteer.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
try {
  const page = await browser.newPage()
  page.on('pageerror', e => { throw new Error('pageerror: ' + (e && e.message ? e.message : String(e))) })
  await page.setViewport({ width: 1500, height: 1600, deviceScaleFactor: 2 })
  await page.goto('file://' + path.join(WORK, 'help-diagrams.html'))
  let pass = 0
  for (const t of tasks) {
    const domId = 'd-' + t.id.replace(/[^a-z0-9-]/gi, '')
    const info = await page.evaluate(async (src, id) => { return await window.ready(src, id) }, t.src, domId)
    // даём шрифтам/разметке устаканиться
    await new Promise(r => setTimeout(r, 250))
    const el = await page.$('#box')
    await el.screenshot({ path: t.out })
    const kb = (fs.statSync(t.out).size / 1024).toFixed(0)
    console.log('PASS', t.id, '→', path.basename(t.out), info.w + 'x' + info.h + 'css @2x', kb + 'KB')
    pass++
  }
  if (pass !== tasks.length) process.exit(1)
  console.log(`Итого: ${pass}/${tasks.length} PNG (2x) в ${OUT}`)
} finally {
  await browser.close()
}
