import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import sharp from 'sharp'

// README 的七张图是**产物**：界面一改，它们就跟着过期（1.3.3 之前就漏了「关系图谱」这一页）。
// 跑法：先起预览，再跑本脚本。
//   node --import ./tests/loader-register.mjs scripts/preview.mjs --port 7789
//   node scripts/make-readme-shots.mjs
// 预览只在临时 DSH_MEMU_HOME 里造示例数据，不会碰任何真实记忆库。
const base = process.argv[2] || 'http://127.0.0.1:7789/dsh-memu-memory/ui'
const out = path.resolve(import.meta.dirname, '../assets/screenshots')

const shots = [
  { name: 'webui-memory', hash: '#/settings/memories', width: 1600, height: 1180, wait: '.dshm-wall-item' },
  { name: 'drawer', hash: '#/settings/memories', width: 1600, height: 1044, wait: '.dshm-wall-item', then: '.dshm-wall-item', opened: '.dshm-drawer' },
  { name: 'relations', hash: '#/settings/graph', width: 1440, height: 1293, wait: 'canvas', settle: 2600 },
  { name: 'settings', hash: '#/settings/settings', width: 1600, height: 1346, wait: '.dshm-card' },
  { name: 'stats', hash: '#/settings/stats', width: 1400, height: 1740, wait: '.dshm-card' },
  { name: 'webui-dark', hash: '#/settings/memories', width: 1600, height: 1044, wait: '.dshm-wall-item', dark: true },
  { name: 'mobile', hash: '#/settings/memories', width: 390, height: 844, wait: '.dshm-wall-item' },
]

// Playwright 想要 1248 号构建；机器上只有更早的构建时直接用那个可执行文件。
const chromeExe = ['chromium-1248/chrome-win64/chrome.exe', 'chromium-1194/chrome-win/chrome.exe', 'chromium-1117/chrome-win/chrome.exe']
  .map(rel => path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', rel))
  .find(p => fs.existsSync(p))
if (!chromeExe) throw new Error('no chromium build under %LOCALAPPDATA%/ms-playwright — run `npx playwright install chromium`')

const browser = await chromium.launch({ headless: true, executablePath: chromeExe })
const written = []
try {
  for (const shot of shots) {
    // 每图一个新 context：主题、选中的库、滚动位置都存在 localStorage 里，
    // 共用的话「深色」那张会把后面所有图都染黑。
    const context = await browser.newContext({ viewport: { width: shot.width, height: shot.height }, deviceScaleFactor: 1 })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(String(error.message || error)))
    await page.goto(base + shot.hash, { waitUntil: 'load' })
    await page.waitForSelector('.dshm-root', { timeout: 20000 })
    if (shot.wait) await page.waitForSelector(shot.wait, { timeout: 20000 })
    if (shot.dark) await page.click('#theme')
    if (shot.then) await page.click(shot.then)
    if (shot.opened) await page.waitForSelector(shot.opened, { timeout: 10000 })
    await page.waitForTimeout(shot.settle ?? 900)
    if (errors.length) throw new Error(`${shot.name}: page errors ${errors.join(' | ')}`)
    const png = await page.screenshot()
    const image = await sharp(png).jpeg({ quality: 84, mozjpeg: true }).toBuffer()
    const file = path.join(out, `${shot.name}.jpg`)
    fs.writeFileSync(file, image)
    const meta = await sharp(image).metadata()
    written.push(`${shot.name}.jpg ${meta.width}x${meta.height} ${(image.length / 1024).toFixed(0)}KB`)
    await context.close()
  }
} finally {
  await browser.close()
}
console.log(written.join('\n'))
