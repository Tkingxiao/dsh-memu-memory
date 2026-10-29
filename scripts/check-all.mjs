import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { runChecks as runDocDriftChecks } from './check-doc-drift.mjs'

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

// W2 防漂移闸门：RPC 方法数标记、tests 跟踪状态、loader/stub 完整性。
// 这三项由 scripts/check-doc-drift.mjs 实现，返回 ok / skipped / fail 三态：
// skipped 只用于「没有 .git 的 npm 安装目录」这类明确不适用场景，不算失败。
for (const result of runDocDriftChecks(root)) {
  if (result.status === 'ok') {
    console.log(`ok   ${result.label}: ${result.summary}`)
    continue
  }
  if (result.status === 'skipped') {
    console.log(`skip ${result.label}: ${result.summary}`)
    for (const detail of result.details || []) console.log(`     ${detail}`)
    continue
  }
  failures.push(result.label)
  console.log(`FAIL ${result.label}: ${result.summary}`)
  for (const detail of result.details || []) console.log(`     ${detail}`)
}

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nall checks passed')
