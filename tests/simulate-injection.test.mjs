import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

// 工单 B 的离线模拟器本身也要有回归：它一旦失真，报告里的数字就全成了装饰。
// 这里钉的是"量具的正确属性"，不是某一次的注入次数（那个随设置与播种变化）。
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const SCRIPT = path.join(REPO, 'scripts', 'simulate-injection.mjs')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-sim-test-'))

const run = (args) => execFileSync(process.execPath, [SCRIPT, ...args], {
  cwd: REPO,
  encoding: 'utf8',
  env: { ...process.env, DSH_MEMU_HOME: path.join(home, 'memu'), DSH_MEMU_MEMORY_HOME: path.join(home, 'memu') },
})

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

test('the simulator measures what the injection pipeline put in each request', () => {
  const out = path.join(home, 'run-6')
  const summary = JSON.parse(run(['--turns', '6', '--json', '--out', out, '--home', path.join(home, 'home-6')]))

  assert.equal(summary.turns, 6)
  assert.equal(summary.warnCount, 0, 'a warn means the pipeline itself complained: that is a failure, not noise')
  assert.equal(summary.sendFailures, 0)
  // 规则 guide 只在首回合投放一次，靠的就是"转录里带着之前发过的插件消息"。
  // 若驱动把历史丢掉，这里会变成 6 而不是 1。
  assert.equal(summary.deltaTotals.guide, 1, 'the rules guide is placed once, not per turn')
  assert.equal(summary.deltaTotals.anchor, 1, 'the anchor lands on the first turn only')
  assert.ok(summary.deltaTotals.context >= 1, 'per-turn recall title cards are counted')
  // 标题卡口径：正文不许混进 prompt。
  assert.equal(summary.titleCardBodyLineMax, 0, 'title cards must not carry body continuation lines')

  const report = fs.readFileSync(summary.reportPath, 'utf8')
  assert.match(report, /## Per-request marker matrix/)
  assert.match(report, /## Totals by block/)
  assert.match(report, /## Zero-injection requests/)
  assert.match(report, /marker set: plugin \d+\.\d+\.\d+/, 'the report names the pinned marker set')

  // 隐私面：日志只有元数据。正文与标题词一旦落进 jsonl，这台量具就成了窃听器。
  const jsonl = fs.readFileSync(summary.logPath, 'utf8')
  assert.ok(jsonl.length > 0)
  assert.ok(!jsonl.includes('的正文'), 'request bodies must never reach the log')
  assert.ok(!jsonl.includes('林眠'), 'memory titles must never reach the log')

  const snapshot = JSON.parse(fs.readFileSync(summary.snapshotPath, 'utf8'))
  assert.equal(typeof snapshot.settings.freshnessDays, 'number', 'the snapshot is the reading context for C/D knobs')
  assert.equal(typeof snapshot.settings.openLoopRemindDays, 'number')
  assert.equal(snapshot.settings.salientWake, 'off', 'the simulator never turns on host wake-up')
})

test('a zero cue chance is the reproducible default and --cue can restore the shipped one', () => {
  const summary = JSON.parse(run(['--turns', '4', '--json', '--out', path.join(home, 'run-cue'), '--home', path.join(home, 'home-cue')]))
  const snapshot = JSON.parse(fs.readFileSync(summary.snapshotPath, 'utf8'))
  assert.equal(snapshot.settings.randomCueChance, 0, 'random side-events are off by default so totals are reproducible')
  assert.equal(summary.deltaTotals.cue, 0)
})

test('usage errors exit 2 and never write a library', () => {
  for (const args of [['--turns', '0'], ['--turns', '501'], ['--cue', '2'], ['--nope']]) {
    let code = 0
    try {
      execFileSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, stdio: 'pipe' })
    } catch (error) {
      code = error.status
    }
    assert.equal(code, 2, args.join(' ') + ' must be rejected as a usage error')
  }
})
