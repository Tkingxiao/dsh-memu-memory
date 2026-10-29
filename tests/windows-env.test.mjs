import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const { windowsSystemEnv } = await import('../lib/paths.js')

// 现场事故（2026-10-29/30）：仓库里长出字面量目录 `%SystemDrive%/ProgramData/...`。
// 内容是与 C:\ProgramData 同哈希的搜狗缓存和字体缓存副本 —— 宿主清空 env 之后，
// 注入进程把没展开的 `%SystemDrive%` 当相对路径写进了 cwd。这里钉住修复：插件拉起的
// 每个子进程都先补系统变量，再叠加 process.env 和显式 env。

test('non-Windows platforms get no overlay at all', () => {
  assert.deepEqual(windowsSystemEnv('linux', {}), {})
  assert.deepEqual(windowsSystemEnv('darwin', {}), {})
})

test('a stripped environment gets the system variables back', () => {
  const overlay = windowsSystemEnv('win32', {})
  assert.equal(overlay.SystemDrive, 'C:')
  assert.equal(overlay.SystemRoot, 'C:/Windows')
  assert.equal(overlay.windir, 'C:/Windows')
  assert.equal(overlay.PATH, 'C:/Windows/system32')
})

test('existing values are never overwritten', () => {
  const env = { SystemDrive: 'D:', SystemRoot: 'D:/Win', windir: 'D:/Win', PATH: 'D:/bin' }
  assert.deepEqual(windowsSystemEnv('win32', env), {})
})

test('HOMEDRIVE and a Windows-style windir are honoured', () => {
  const overlay = windowsSystemEnv('win32', { HOMEDRIVE: 'E:', WINDIR: 'E:\\Win' })
  assert.equal(overlay.SystemDrive, 'E:')
  assert.equal(overlay.SystemRoot, 'E:/Win')
  assert.equal(overlay.windir, undefined, 'WINDIR already exists; adding a second spelling is noise')
})

test('a partial environment only gets the missing keys', () => {
  const overlay = windowsSystemEnv('win32', { SystemDrive: 'C:' })
  assert.equal(overlay.SystemDrive, undefined)
  assert.equal(overlay.SystemRoot, 'C:/Windows')
})

test('both child-process sites seed the overlay before process.env', () => {
  for (const file of ['lib/engine.js', 'lib/memu.js']) {
    const text = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8')
    assert.match(text, /\.\.\.windowsSystemEnv\(\)/, file + ' must seed the child environment')
    const overlayAt = text.indexOf('...windowsSystemEnv()')
    const inheritedAt = text.indexOf('...process.env', overlayAt)
    assert.ok(inheritedAt > overlayAt, file + ' must let the host environment win over the defaults')
  }
})
