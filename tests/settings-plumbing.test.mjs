import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// lib/rpc.js 的 setSettings 是 allowlist：没登记的 key 会被静默丢掉，设置页就成了死控件
// （写了、点了保存、什么也没发生）。resetSettings 另有一份 key 表，两处都得跟着新设置走。
// 工单 C/D/E 各加了设置项，这条测试就是盯这个失败模式的。

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-settings-plumbing-'))
process.env.DSH_MEMU_HOME = home

const rpc = await import('../lib/rpc.js')
const state = await import('../lib/state.js')

test.after(() => {
  state.flushState()
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

const SAMPLE = {
  openLoopRemindDays: 14,
  freshnessHint: false,
  freshnessDays: 90,
  crossLibraryRecall: true,
  salientWake: 'schedule',
  salientWakeHour: '20:30',
  salientWakeTimeZone: 'Asia/Shanghai',
}

test('each new setting is writable through setSettings', async () => {
  for (const [key, value] of Object.entries(SAMPLE)) {
    const saved = await rpc.dispatch({}, 'setSettings', { patch: { [key]: value } })
    assert.equal(saved[key], value, key + ' must survive the setSettings allowlist')
  }
})

test('the numeric settings clamp to their documented domain instead of vanishing', async () => {
  const low = await rpc.dispatch({}, 'setSettings', { patch: { openLoopRemindDays: 0 } })
  assert.equal(low.openLoopRemindDays, 1)
  const high = await rpc.dispatch({}, 'setSettings', { patch: { freshnessDays: 999999 } })
  assert.equal(high.freshnessDays, 3650)
})

test('resetSettings restores the new defaults, not last release\u2019s tuning', async () => {
  await rpc.dispatch({}, 'setSettings', { patch: SAMPLE })
  const reset = await rpc.dispatch({}, 'resetSettings', {})
  for (const key of Object.keys(SAMPLE)) {
    assert.deepEqual(reset[key], state.DEFAULT_SETTINGS[key], key + ' must be in the reset key list')
  }
})

test('invalid wake configuration is rejected loudly rather than stored', async () => {
  await assert.rejects(
    rpc.dispatch({}, 'setSettings', { patch: { salientWake: 'always' } }),
    /invalid setting salientWake/,
  )
  await assert.rejects(
    rpc.dispatch({}, 'setSettings', { patch: { salientWakeHour: '9:00' } }),
    /salientWakeHour must be HH:mm/,
  )
  await assert.rejects(
    rpc.dispatch({}, 'setSettings', { patch: { salientWakeTimeZone: 'Not/A Zone' } }),
    /invalid salientWakeTimeZone/,
  )
  // 留空是合法配置：跟随系统时区。
  const empty = await rpc.dispatch({}, 'setSettings', { patch: { salientWakeTimeZone: '' } })
  assert.equal(empty.salientWakeTimeZone, '')
})

test('the client settings page exposes a control for every new setting', () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8')
  for (const key of Object.keys(SAMPLE)) {
    assert.match(source, new RegExp("setSetting\\('" + key + "'"), key + ' has no settings control')
  }
})
