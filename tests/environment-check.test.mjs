// 环境自检与修复动作的回归测试。
// 这套代码的价值全在"故障可见 + 修得动"：检查项漏报等于故障继续静默，
// 修复动作乱进安全名单等于半夜动用户数据。所以两条都要钉住。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-envcheck-'))
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

const env = await import('../lib/environment-check.js')
const diag = await import('../lib/diagnostics.js')
const paths = await import('../lib/paths.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

test.beforeEach(() => {
  diag.clearDiagnostics()
  paths.setLockEventSink(null)
  paths.setWarnSink(null)
  // 上一个用例留下的锁文件会被"整个数据目录"的扫描看见，先清干净再断言。
  try { fs.rmSync(path.join(home, 'locks'), { recursive: true, force: true }) } catch {}
})

function lockFile(name, payload, ageMs = 0) {
  const dir = path.join(home, 'locks')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${name}.lock`)
  fs.writeFileSync(file, payload)
  if (ageMs) {
    const when = new Date(Date.now() - ageMs)
    fs.utimesSync(file, when, when)
  }
  return file
}

// ---------------------------------------------------------------- 检查项

test('every item carries the shape the diagnostics page renders', () => {
  const report = env.runEnvironmentCheck()
  assert.ok(Array.isArray(report.items) && report.items.length > 0, 'a check must produce items')
  for (const entry of report.items) {
    assert.ok(entry.id, 'item without id')
    assert.ok(typeof entry.title === 'string' && entry.title.length > 0, `${entry.id} has no title`)
    assert.ok(['ok', 'warn', 'error', 'skipped'].includes(entry.level), `${entry.id} has level ${entry.level}`)
    assert.equal(typeof entry.ok, 'boolean')
  }
  assert.equal(typeof report.ok, 'boolean')
  assert.equal(typeof report.checkedAt, 'string')
  assert.ok(report.counts && typeof report.counts.ok === 'number')
})

test('a writable data dir is reported ok, so the check itself is not the alarm', () => {
  const report = env.runEnvironmentCheck()
  const dataDir = report.items.find(entry => entry.id === 'data-dir')
  assert.ok(dataDir, 'data-dir must always be checked first')
  assert.equal(dataDir.ok, true)
})

test('an abandoned lock is reported with the repair that clears it', () => {
  lockFile('abandoned', '', 30_000)
  const report = env.runEnvironmentCheck()
  const locks = report.items.find(entry => entry.id === 'locks')
  assert.ok(locks, 'locks must be checked')
  assert.equal(locks.ok, false)
  assert.equal(locks.level, 'warn')
  assert.equal(locks.repair, 'release-stale-locks')
  assert.equal(locks.auto, true, 'clearing provably abandoned locks is safe enough to run at startup')
  assert.match(locks.detail, /abandoned\.lock/)
  assert.ok(report.repairs.includes('release-stale-locks'))
})

test('a healthy live lock is not reported as a problem', () => {
  lockFile('live', `${process.ppid}\n` + new Date().toISOString())
  const report = env.runEnvironmentCheck()
  const locks = report.items.find(entry => entry.id === 'locks')
  assert.ok(locks)
  assert.equal(locks.ok, true)
})

// ---------------------------------------------------------------- 修复门禁

test('repairEnvironment refuses to run without an explicit confirmation', async () => {
  await assert.rejects(
    () => env.repairEnvironment({ actions: ['release-stale-locks'] }),
    /confirmed === true/,
  )
})

test('a repair that runs is recorded, and the report reflects the new state', async () => {
  const abandoned = lockFile('abandoned', '', 30_000)
  const outcome = await env.repairEnvironment({ actions: ['release-stale-locks'], confirmed: true })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.results.length, 1)
  assert.equal(fs.existsSync(abandoned), false, 'the repair must actually remove the lock')
  const repaired = diag.listDiagnostics({}).items.find(row => row.code === 'MEMU_DIAGNOSTIC_REPAIRED')
  assert.ok(repaired, 'a successful repair is recorded in diagnostics')
  assert.equal(repaired.detail.action, 'release-stale-locks')
  const locks = outcome.after.items.find(entry => entry.id === 'locks')
  assert.equal(locks.ok, true, 'the post-repair check must show the fix')
})

test('a repair that fails is still recorded, with the error', async () => {
  const outcome = await env.repairEnvironment({ actions: ['not-a-real-action'], confirmed: true })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.results[0].ok, false)
  assert.match(outcome.results[0].detail, /unknown repair action/)
  const failed = diag.listDiagnostics({}).items.find(row => row.code === 'MEMU_DIAGNOSTIC_REPAIR_FAILED')
  assert.ok(failed, 'a failed repair must not disappear')
  assert.equal(failed.level, 'error')
  assert.equal(failed.detail.action, 'not-a-real-action')
})

test('startup auto-repair only touches the safe list', async () => {
  assert.deepEqual([...env.SAFE_REPAIRS].sort(), ['release-stale-locks', 'repoint-runtime-dir', 'resign-vector-profile'])
  for (const action of env.MANUAL_REPAIRS) {
    assert.ok(!env.SAFE_REPAIRS.includes(action), `${action} must never run automatically`)
  }
  const blocked = await env.autoRepairEnvironment({ actions: ['reinstall-engine'] })
  assert.equal(blocked.changed, false)
  assert.deepEqual(blocked.results, [], 'a manual action asked for by mistake must be ignored, not run')
})

test('every repair action has a label, so the page never shows a bare slug', () => {
  for (const action of [...env.SAFE_REPAIRS, ...env.MANUAL_REPAIRS]) {
    assert.ok(env.REPAIR_LABELS[action], `${action} has no label`)
  }
})

// ---------------------------------------------------------------- 运行时目录发现

test('the managed runtime root is discovered where the service actually installs it', async () => {
  // 真实布局是 downloads/embeddings/runtime/<key>（与模型同级）。早先这里只看
  // downloads/runtime，于是"运行时明明装着"也会报"没有安装"，把用户推去重下 40MB。
  const vp = await import('../lib/vector-profile.js')
  const managed = path.join(home, 'downloads', 'embeddings', 'runtime', 'onnxruntime-node@test@napi-v6@win32-x64-abc')
  const legacy = path.join(home, 'downloads', 'runtime', 'onnxruntime-node@test@napi-v6@win32-x64-def')
  for (const dir of [managed, legacy]) {
    fs.mkdirSync(path.join(dir, 'node_modules', 'onnxruntime-node'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'node_modules', 'onnxruntime-node', 'package.json'), '{"name":"onnxruntime-node"}')
  }
  const candidates = vp.runtimeDirCandidates().map(entry => path.resolve(entry.dir))
  assert.ok(candidates.includes(path.resolve(managed)), 'the managed root must be scanned')
  assert.ok(candidates.includes(path.resolve(legacy)), 'the legacy root keeps working')
})

test('a runtime directory without its package.json is not offered as a candidate', async () => {
  // 真实事故：运行时目录只剩 bin/，package.json 与 lib/ 都没了 → 重指过去仍然 MODULE_NOT_FOUND。
  const vp = await import('../lib/vector-profile.js')
  const hollow = path.join(home, 'downloads', 'embeddings', 'runtime', 'hollow-key')
  fs.mkdirSync(path.join(hollow, 'node_modules', 'onnxruntime-node', 'bin'), { recursive: true })
  const candidates = vp.runtimeDirCandidates().map(entry => path.resolve(entry.dir))
  assert.ok(!candidates.includes(path.resolve(hollow)))
})
