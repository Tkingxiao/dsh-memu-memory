import fs from 'node:fs'

const src = fs.readFileSync('lib/client.js', 'utf8')
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
const zh = dict('zh')
const en = dict('en')

const missing = (d, label) => [...used].filter((k) => !d.has(k)).map((k) => `${label}: ${k}`)
const unused = (d, label) => [...d].filter((k) => !used.has(k)).map((k) => `${label} unused: ${k}`)

console.log('zh/en key diff:', [...zh].filter((k) => !en.has(k)).concat([...en].filter((k) => !zh.has(k))))
console.log(missing(zh, 'MISSING-ZH').join('\n') || 'zh complete')
console.log(missing(en, 'MISSING-EN').join('\n') || 'en complete')
console.log(unused(zh, 'UNUSED-ZH').join('\n') || 'no unused zh')
if (missing(zh, 'zh').length || missing(en, 'en').length || [...zh].some(key => !en.has(key)) || [...en].some(key => !zh.has(key))) process.exitCode = 1
