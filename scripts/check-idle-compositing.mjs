import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

// 空闲合成负载探针：WebUI 的 GPU 占用问题不是算力，是「空闲期仍在持续产帧」。
// 用 CDP screencast 数帧：页面没有视觉变化就不该有帧；无限 CSS 动画 / 常开 rAF /
// 全屏 backdrop-filter 都会让帧率钉在刷新率上。跑法：
//   node --import ./tests/loader-register.mjs scripts/preview.mjs --port 7789
//   node scripts/check-idle-compositing.mjs
// 只读本地预览（隔离示例数据），不写任何记忆库。
const base = process.argv[2] || 'http://127.0.0.1:7789/dsh-memu-memory/ui'
const seconds = Number(process.argv[3] || 6)

const chromeExe = ['chromium-1248/chrome-win64/chrome.exe', 'chromium-1194/chrome-win/chrome.exe', 'chromium-1117/chrome-win/chrome.exe']
  .map(rel => path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', rel))
  .find(p => fs.existsSync(p))
if (!chromeExe) throw new Error('no chromium build under %LOCALAPPDATA%/ms-playwright — run `npx playwright install chromium`')

const browser = await chromium.launch({ headless: true, executablePath: chromeExe })

async function measure(label, setup) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  await page.goto(base + '#/settings/memories', { waitUntil: 'load' })
  await page.waitForSelector('.dshm-wall-item', { timeout: 20000 })
  await page.waitForTimeout(1500) // boot 遮罩 900ms 后移除，等它走完
  if (setup) await setup(page)
  await page.waitForTimeout(1200) // 让入场动画结束，只量「空闲」
  const animations = await page.evaluate(() => document.getAnimations()
    .filter(a => a.playState === 'running')
    .map(a => ({ name: a.animationName || a.transitionProperty || a.constructor.name, target: String(a.effect?.target?.className || a.effect?.target?.tagName || '').slice(0, 40) })))
  const cdp = await context.newCDPSession(page)
  let frames = 0
  cdp.on('Page.screencastFrame', async (event) => {
    frames++
    try { await cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }) } catch {}
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 20, everyNthFrame: 1 })
  await page.waitForTimeout(seconds * 1000)
  await cdp.send('Page.stopScreencast')
  await context.close()
  return { label, frames, fps: Number((frames / seconds).toFixed(1)), animations }
}

const results = []
results.push(await measure('wall idle', null))
results.push(await measure('drawer open', async (page) => { await page.click('.dshm-wall-item'); await page.waitForSelector('.dshm-drawer') }))
results.push(await measure('graph cooled', async (page) => {
  await page.goto(base + '#/settings/graph', { waitUntil: 'load' })
  await page.waitForSelector('canvas.dshm-graph-canvas', { timeout: 20000 })
  await page.waitForTimeout(6000) // 等力导向冷下来
}))
await browser.close()

for (const r of results) {
  console.log(`${r.label.padEnd(12)} frames=${String(r.frames).padStart(4)} fps=${String(r.fps).padStart(5)}  running animations: ${r.animations.length ? JSON.stringify(r.animations) : 'none'}`)
}
const idle = results.filter(r => r.label !== 'graph cooled')
const bad = idle.some(r => r.fps > 2)
console.log(bad ? 'FAIL: 空闲期仍在持续产帧（合成器没睡）' : 'PASS: 空闲期合成器已睡')
process.exitCode = bad ? 1 : 0
