import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const failures = []

const check = (label, command, args) => {
  try {
    execFileSync(command, args, { cwd: root, stdio: 'pipe' })
    console.log(`ok   ${label}`)
  } catch (error) {
    failures.push(label)
    console.log(`FAIL ${label}`)
    console.log(String(error.stdout || error.stderr || error.message).trim().split('\n').slice(0, 12).map((l) => `     ${l}`).join('\n'))
  }
}

for (const dir of ['lib', 'scripts', 'tests']) {
  for (const file of fs.readdirSync(path.join(root, dir), { recursive: true })) {
    if (!/\.(js|mjs)$/.test(file)) continue
    check(`${dir}/${file}`, process.execPath, ['--check', path.join(dir, file)])
  }
}

// AGENTS.md 吃的是宿主预算：@deepseek-ai/dsh-agent-instructions 的 maxBytes 是 65536，
// 超了会静默截断尾部（尾部内容模型永远看不到，只发一条通知、不报错）。留 6000 余量。
const budget = (rel, limit) => {
  const bytes = fs.statSync(path.join(root, rel)).size
  if (bytes > limit) failures.push(rel + ' budget')
  console.log(`${bytes > limit ? 'FAIL' : 'ok  '} ${rel} budget (${bytes} / ${limit} bytes)`)
}
budget('AGENTS.md', 60000)

check('i18n', process.execPath, ['scripts/check-i18n.mjs'])
check('package.json', process.execPath, ['-e', 'JSON.parse(require("fs").readFileSync("package.json","utf8"))'])

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nall checks passed')
