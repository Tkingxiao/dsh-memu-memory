// Dice 阈值标定脚手架（scripts/lexicon-calibrate.mjs）的轻量 smoke 测试：
// 只保证脚本独立运行不抛错、产出指标行；标定样本本身是给人看的报告，
// 不进 npm test 门禁断言（脚本不在此处做阈值回归）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const scriptPath = path.join(here, '..', 'scripts', 'lexicon-calibrate.mjs')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-lexicon-calibrate-smoke-'))
process.env.DSH_MEMU_HOME = home

test.after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

function runCalibrate(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, DSH_MEMU_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-lexicon-calibrate-run-')) },
  })
}

test('lexicon-calibrate.mjs runs standalone, never touches the caller data dir, and prints the 0.60 metrics', () => {
  const run = runCalibrate([])
  assert.equal(run.status, 0, `calibrate exits 0. stderr: ${run.stderr}`)
  assert.match(run.stdout, /只出报告，不自动改 LEXICON_DICE_THRESHOLD/)
  assert.match(run.stdout, /正例 16 对，负例 16 对/)
  assert.match(run.stdout, /当前 0\.60 下的指标：precision=/)
  // 汇总表覆盖默认阈值扫描 0.55..0.75。
  for (const threshold of ['0.55', '0.60', '0.65', '0.70', '0.75']) {
    assert.ok(run.stdout.includes(threshold), `sweep table contains ${threshold}`)
  }
})

test('lexicon-calibrate.mjs accepts a --threshold list and still exits cleanly', () => {
  const run = runCalibrate(['--threshold=0.5,0.62,0.9'])
  assert.equal(run.status, 0, `stderr: ${run.stderr}`)
  assert.match(run.stdout, /当前 0\.50 下的指标/, 'the primary threshold is the first given value')
  for (const threshold of ['0.50', '0.62', '0.90']) {
    assert.ok(run.stdout.includes(threshold), `sweep table contains ${threshold}`)
  }
})
