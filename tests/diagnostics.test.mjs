// 诊断体系（lib/diagnostics.js / lib/environment-check.js / lib/paths.js 的锁判据）的回归测试。
// 这些代码的失败方式是"静默"：写盘失败被吞、锁永远不释放、摘要判定把好档案判废。
// 所以每个断言都盯着"它有没有发出可见信号"，而不是只看返回值。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-diagnostics-'))
process.env.DSH_MEMU_HOME = home
process.env.DSH_MEMU_MEMORY_HOME = home

const diag = await import('../lib/diagnostics.js')
const paths = await import('../lib/paths.js')
const vp = await import('../lib/vector-profile.js')

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

test.beforeEach(() => {
  diag.clearDiagnostics()
  paths.setLockEventSink(null)
  paths.setWarnSink(null)
})

// ---------------------------------------------------------------- 记录与去重

test('the same fault inside the dedupe window bumps a counter instead of adding rows', () => {
  const first = diag.recordDiagnostic({ level: 'error', scope: 'vector', code: 'VECTOR_PROFILE_MANIFEST_CHANGED', message: 'manifest moved' })
  const second = diag.recordDiagnostic({ level: 'error', scope: 'vector', code: 'VECTOR_PROFILE_MANIFEST_CHANGED', message: 'manifest moved' })
  assert.equal(second.count, 2)
  assert.equal(second.id, first.id, 'a repeat must keep the same row id')
  const { items, total, counts } = diag.listDiagnostics({})
  assert.equal(total, 1)
  assert.equal(items[0].count, 2)
  assert.equal(counts.error, 1)
})

test('a different message with the same code stays a separate row', () => {
  diag.recordDiagnostic({ level: 'error', scope: 'vector', code: 'LOCAL_VECTOR_WORKER_EXITED', message: 'worker died: a' })
  diag.recordDiagnostic({ level: 'error', scope: 'vector', code: 'LOCAL_VECTOR_WORKER_EXITED', message: 'worker died: b' })
  assert.equal(diag.listDiagnostics({}).total, 2)
})

test('diagnostics land in their own file, not in the activity log', () => {
  diag.recordDiagnostic({ level: 'warn', scope: 'engine', code: 'ENGINE_MISSING', message: 'no python' })
  const csv = path.join(home, 'diagnostics', 'events.jsonl')
  assert.ok(fs.existsSync(csv), 'diagnostics/events.jsonl must exist')
  const lines = fs.readFileSync(csv, 'utf8').trim().split(/\r?\n/)
  assert.equal(lines.length, 1)
  assert.equal(JSON.parse(lines[0]).code, 'ENGINE_MISSING')
  assert.equal(fs.existsSync(path.join(home, 'logs', 'activity.jsonl')), false,
    'nothing may leak into the regular activity log')
})

test('filters by level and by free text, newest first', () => {
  diag.recordDiagnostic({ level: 'error', scope: 'vector', code: 'E1', message: 'alpha failed' })
  diag.recordDiagnostic({ level: 'info', scope: 'store', code: 'I1', message: 'beta repaired' })
  assert.equal(diag.listDiagnostics({ level: 'error' }).total, 1)
  assert.equal(diag.listDiagnostics({ q: 'beta' }).items[0].code, 'I1')
  assert.equal(diag.listDiagnostics({ q: 'nothing-matches-this' }).total, 0)
  assert.equal(diag.listDiagnostics({}).items[0].code, 'I1', 'newest first')
})

test('detail is captured for repair but secrets are redacted', () => {
  diag.recordDiagnostic({
    level: 'error',
    scope: 'vector',
    code: 'LOCAL_VECTOR_WORKER_EXITED',
    message: 'worker exited',
    detail: { stderrTail: 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz 0123' },
  })
  const row = diag.listDiagnostics({}).items[0]
  assert.match(row.detail.stderrTail, /^OPENAI_API_KEY=/)
  assert.doesNotMatch(row.detail.stderrTail, /sk-abcdefghijklmnopqrstuvwxyz/)
})

// ---------------------------------------------------------------- 启动告警

test('alerts only carry unacknowledged error/warn rows and stop after acknowledgement', () => {
  diag.recordDiagnostic({ level: 'info', scope: 'store', code: 'I1', message: 'just information' })
  diag.recordDiagnostic({ level: 'error', scope: 'vector', code: 'E1', message: 'broken' })
  const first = diag.diagnosticAlerts()
  assert.deepEqual(first.alerts.map(alert => alert.code), ['E1'], 'info rows never raise a popup')
  diag.acknowledgeDiagnostics({ codes: ['E1'] })
  assert.equal(diag.diagnosticAlerts().alerts.length, 0, 'an acknowledged fault is not re-announced')
  // 同一个故障再次出现：出现次数超过已确认次数，必须重新提醒一次。
  diag.recordDiagnostic({ level: 'error', scope: 'vector', code: 'E1', message: 'broken' })
  assert.deepEqual(diag.diagnosticAlerts().alerts.map(alert => alert.code), ['E1'])
})

// ---------------------------------------------------------------- 修复记账

test('repair outcomes are recorded either way, so a failed repair is still diagnosable', () => {
  diag.recordRepair({ action: 'release-stale-locks', ok: true, detail: { released: 2 } })
  diag.recordRepair({ action: 'reinstall-engine', ok: false, detail: { stage: 'download' } })
  const rows = diag.listDiagnostics({}).items
  const ok = rows.find(row => row.code === 'MEMU_DIAGNOSTIC_REPAIRED')
  const failed = rows.find(row => row.code === 'MEMU_DIAGNOSTIC_REPAIR_FAILED')
  assert.ok(ok, 'a successful repair is recorded')
  assert.ok(failed, 'a failed repair is recorded too')
  assert.equal(failed.level, 'error')
  assert.equal(failed.detail.action, 'reinstall-engine')
  assert.equal(failed.detail.stage, 'download')
})

test('clearDiagnostics empties the ring and the file', () => {
  diag.recordDiagnostic({ level: 'error', scope: 'vector', code: 'E1', message: 'x' })
  diag.clearDiagnostics()
  assert.equal(diag.listDiagnostics({}).total, 0)
  assert.equal(fs.existsSync(path.join(home, 'diagnostics', 'events.jsonl')), false,
    'clearing must not leave a file that is re-read on the next start')
})

// ---------------------------------------------------------------- 锁判据

const lockFile = (name, body, ageMs = 0) => {
  const file = path.join(home, 'locks', name + '.lock')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
  if (ageMs) {
    const when = new Date(Date.now() - ageMs)
    fs.utimesSync(file, when, when)
  }
  return file
}

test('an empty lock file is stale only after the grace window', () => {
  const fresh = lockFile('fresh-empty', '')
  assert.equal(paths.inspectLock(fresh), null, 'a lock being created right now is not stale')
  const old = lockFile('old-empty', '', 30_000)
  assert.equal(paths.inspectLock(old)?.reason, 'unparseable-owner')
})

test('a lock owned by a dead pid is stale immediately', () => {
  // pid 2^22 以上在这两个平台都远超 pid_max，kill(pid, 0) 必然 ESRCH。
  const dead = lockFile('dead', '4194303\n' + new Date().toISOString())
  assert.equal(paths.inspectLock(dead)?.reason, 'dead-owner')
})

test('a live foreign owner keeps the lock, and a very old one ages out', () => {
  const live = lockFile('live', `${process.ppid}\n` + new Date().toISOString())
  assert.equal(paths.inspectLock(live), null, 'pid 1 exists; the lock must be respected')
  const aged = lockFile('aged', `${process.ppid}\n` + new Date().toISOString(), 5 * 60_000)
  assert.equal(paths.inspectLock(aged)?.reason, 'aged-out')
})

test('a lock naming our own pid without a held transaction waits for the grace window', () => {
  const own = lockFile('own', String(process.pid))
  assert.equal(paths.inspectLock(own), null, 'another copy of the plugin may hold it')
  const old = lockFile('own-old', String(process.pid), 30_000)
  assert.equal(paths.inspectLock(old)?.reason, 'own-pid-without-transaction')
})

test('releaseStaleLocks only removes the ones it can prove are abandoned', () => {
  const abandoned = lockFile('abandoned', '', 30_000)
  const healthy = lockFile('healthy', `${process.ppid}\n` + new Date().toISOString())
  const report = paths.releaseStaleLocks()
  // 同一份 home 里前面的用例也留了遗弃锁，所以只核对"这一个被清掉、健康的没被动"。
  assert.ok(report.released.some(item => path.resolve(item.path) === path.resolve(abandoned)))
  assert.equal(fs.existsSync(abandoned), false)
  assert.equal(fs.existsSync(healthy), true)
})

test('breaking a stale lock reports an event so the diagnostics page can show it', () => {
  const seen = []
  paths.setLockEventSink(event => seen.push(event))
  const lock = path.join(home, 'store.json.lock')
  fs.writeFileSync(lock, '')
  const when = new Date(Date.now() - 30_000)
  fs.utimesSync(lock, when, when)
  // withFileLock 会先发现遗弃锁、清掉、再正常执行。
  const value = paths.withFileLock(path.join(home, 'store.json'), () => 'ok')
  assert.equal(value, 'ok')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].code, 'MEMU_LOCK_BROKEN')
  assert.equal(seen[0].reason, 'unparseable-owner')
})

test('a live lock still fails the write instead of being broken', () => {
  const target = path.join(home, 'busy.json')
  const lock = target + '.lock'
  fs.writeFileSync(lock, `${process.ppid}\n` + new Date().toISOString())
  try {
    assert.throws(() => paths.withFileLock(target, () => 'never'), /busy/i)
    assert.ok(fs.existsSync(lock), 'a live lock must survive the failure')
  } finally {
    fs.rmSync(lock, { force: true })
  }
})

// ---------------------------------------------------------------- 摘要兼容

test('all three digest algorithms are still accepted, so upgrades do not invalidate a profile', () => {
  const manifest = {
    id: 'm', dimension: 512, tokenizer: { vocab: 21128 },
    runtime: { engine: 'onnxruntime-node', version: '1.31.1' },
    files: [{ name: 'model.onnx', bytes: 10, sha256: 'c'.repeat(64) }],
  }
  const current = vp.manifestDigest(manifest)
  const raw = vp.rawManifestDigest(manifest)
  const legacy = vp.legacyManifestDigest(manifest)
  assert.ok(vp.manifestDigestAccepted(current, manifest))
  assert.ok(vp.manifestDigestAccepted(raw, manifest), '1.3.x digests stay valid')
  assert.ok(vp.manifestDigestAccepted(legacy, manifest), 'pre-1.3 digests stay valid')
  assert.equal(vp.manifestDigestAccepted('d'.repeat(64), manifest), false)
})

test('a mirror-only artifact change is metadata drift, not an identity change', () => {
  const artifact = { name: 'onnxruntime-node', version: '1.31.1', bytes: 10, sha256: 'e'.repeat(64) }
  const recorded = { id: 'm', dimension: 512, runtime: { engine: 'onnxruntime-node', artifacts: { 'win32-x64': artifact } } }
  const current = {
    id: 'm',
    dimension: 512,
    runtime: {
      engine: 'onnxruntime-node',
      artifacts: {
        'win32-x64': {
          ...artifact,
          sources: [{ id: 'npmjs', url: 'https://registry.npmjs.org' }, { id: 'npmmirror', label: '国内镜像' }],
        },
      },
    },
  }
  const drift = vp.manifestDrift(recorded, current)
  assert.deepEqual(drift.metadataOnly, ['runtime'])
  assert.deepEqual(drift.identityChanged, [], 'mirror metadata must not force a rebuild')
  assert.equal(vp.manifestDigest(recorded), vp.manifestDigest(current), 'the identity digest ignores mirrors')
})

test('a version or hash change inside an artifact is an identity change', () => {
  const recorded = { id: 'm', runtime: { engine: 'onnxruntime-node', artifacts: { 'win32-x64': { version: '1.31.1', sha256: 'a'.repeat(64) } } } }
  const current = { id: 'm', runtime: { engine: 'onnxruntime-node', artifacts: { 'win32-x64': { version: '1.32.0', sha256: 'a'.repeat(64) } } } }
  assert.deepEqual(vp.manifestDrift(recorded, current).identityChanged, ['runtime'])
})

test('rows on disk survive a restart, so the page is not empty after a reload', () => {
  // 这条守的是一个真实事故：读盘时无条件丢掉第一行，导致"落盘了但重启后永远看不见"。
  diag.recordDiagnostic({ level: 'error', scope: 'vector', code: 'PERSISTED_ROW', message: 'survive me' })
  const entry = pathToFileURL(path.resolve('lib/diagnostics.js')).href
  const script = [
    "const diag = await import(process.env.MEMU_CHECK_ENTRY)",
    'const list = diag.listDiagnostics({})',
    'console.log(JSON.stringify({ total: list.total, code: list.items[0] && list.items[0].code }))',
  ].join('\n')
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, DSH_MEMU_HOME: home, DSH_MEMU_MEMORY_HOME: home, MEMU_CHECK_ENTRY: entry },
    encoding: 'utf8',
  }).trim()
  const parsed = JSON.parse(out.split('\n').pop())
  assert.equal(parsed.total >= 1, true, 'a fresh process must read the persisted rows')
  assert.equal(parsed.code, 'PERSISTED_ROW')
})
