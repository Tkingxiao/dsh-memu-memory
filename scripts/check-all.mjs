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

check('i18n', process.execPath, ['scripts/check-i18n.mjs'])
check('package.json', process.execPath, ['-e', 'JSON.parse(require("fs").readFileSync("package.json","utf8"))'])

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nall checks passed')
