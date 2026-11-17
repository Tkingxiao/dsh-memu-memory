import fs from 'node:fs'

const src = fs.readFileSync('lib/client.js', 'utf8')
const standalone = fs.readFileSync('lib/webui/standalone.js', 'utf8')
const used = new Set()
for (const m of src.matchAll(/\bt\('([a-zA-Z][a-zA-Z0-9]*)'\)/g)) used.add(m[1])

// Enum labels are reached through the *_LABELS maps (enumText(t, MAP, value)), so a
// key named there is used even though no literal t('key') exists for the checker.
for (const line of src.split('\n')) {
  if (!/const [A-Z][A-Z0-9_]*LABELS\b/.test(line)) continue
  for (const entry of line.matchAll(/:\s*'([a-zA-Z][a-zA-Z0-9]*)'/g)) used.add(entry[1])
}

const dict = (name) => {
  const start = src.indexOf(`const ${name} = {`)
  const end = src.indexOf('\n    }', start)
  const body = src.slice(start, end)
  return new Set([...body.matchAll(/^\s+([a-zA-Z][a-zA-Z0-9]*):/gm)].map((m) => m[1]))
}
// 同一语言表里重复定义同一个键：对象字面量后者静默覆盖前者，先定义的文案成了
// 死键——「整理提醒」行曾经因此渲染出整理按钮的通知长模板，把侧边栏撑出卡片
// 右缘（consolidateDone/deleteForever 双定义）。这里按硬门禁拦住整类事故。
const duplicateKeys = (name) => {
  const start = src.indexOf(`const ${name} = {`)
  const end = src.indexOf('\n    }', start)
  const body = src.slice(start, end)
  const seen = new Map()
  for (const m of body.matchAll(/^\s+([a-zA-Z][a-zA-Z0-9]*):/gm)) {
    if (!seen.has(m[1])) seen.set(m[1], 0)
    seen.set(m[1], seen.get(m[1]) + 1)
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${k} ×${n}`)
}
const zh = dict('zh')
const en = dict('en')
const zhDupes = duplicateKeys('zh')
const enDupes = duplicateKeys('en')

const missing = (d, label) => [...used].filter((k) => !d.has(k)).map((k) => `${label}: ${k}`)
const unused = (d, label) => [...d].filter((k) => !used.has(k)).map((k) => `${label} unused: ${k}`)

console.log('zh/en key diff:', [...zh].filter((k) => !en.has(k)).concat([...en].filter((k) => !zh.has(k))))
console.log(missing(zh, 'MISSING-ZH').join('\n') || 'zh complete')
console.log(missing(en, 'MISSING-EN').join('\n') || 'en complete')
console.log(unused(zh, 'UNUSED-ZH').join('\n') || 'no unused zh')

// The standalone shell carries its own COPY (data-i18n attributes) and PAGE_NAMES
// (breadcrumb / title labels). They are reached dynamically, so literal t('key')
// matching never sees them; check zh/en parity and the page list here instead of
// letting a missing page silently fall back to "memories".
const standaloneKeys = (block, lang) => {
  const start = block.indexOf(lang + ': {')
  if (start < 0) return new Set()
  const end = block.indexOf('\n    }', start)
  const body = block.slice(start, end < 0 ? undefined : end)
  // COPY / PAGE_NAMES pack several `key: 'value'` pairs onto one line, so match
  // every pair rather than only the first key on each line.
  return new Set([...body.matchAll(/([a-zA-Z][a-zA-Z0-9]*)\s*:\s*'/g)].map((m) => m[1]))
}
const copyBlock = standalone.slice(standalone.indexOf('var COPY = {'), standalone.indexOf('var SETTINGS_PAGES = ['))
const pageBlock = standalone.slice(standalone.indexOf('var PAGE_NAMES = {'), standalone.indexOf('var copy = COPY'))
const settingsPages = new Set([...src.matchAll(/const SETTINGS_PAGES = \[([^\]]+)\]/g)]
  .flatMap((m) => [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1])))

const diff = (a, b) => [...a].filter((k) => !b.has(k)).concat([...b].filter((k) => !a.has(k)))
const checks = [
  ['COPY zh/en', diff(standaloneKeys(copyBlock, 'zh'), standaloneKeys(copyBlock, 'en'))],
  ['PAGE_NAMES zh/en', diff(standaloneKeys(pageBlock, 'zh'), standaloneKeys(pageBlock, 'en'))],
  ['PAGE_NAMES vs SETTINGS_PAGES', diff(standaloneKeys(pageBlock, 'zh'), settingsPages)],
]
let standaloneOk = true
for (const [label, keys] of checks) {
  if (keys.length) { standaloneOk = false; console.log(label + ' mismatch:', keys.join(', ')) }
}
if (standaloneOk) console.log('standalone zh/en + page keys complete')

const i18nOk = !missing(zh, 'zh').length && !missing(en, 'en').length
  && ![...zh].some((key) => !en.has(key)) && ![...en].some((key) => !zh.has(key))
  && !zhDupes.length && !enDupes.length
if (zhDupes.length) console.log('DUPLICATE-ZH:', zhDupes.join(', '))
if (enDupes.length) console.log('DUPLICATE-EN:', enDupes.join(', '))
if (!i18nOk || !standaloneOk) process.exitCode = 1
