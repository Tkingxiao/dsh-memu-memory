import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const { windowsSystemEnv } = await import('../lib/paths.js')
const { childEnvironment } = await import('../lib/local-embedding-manager.js')

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

test('every child-process site seeds the overlay before the inherited environment', () => {
  // N7: the local embedding worker is the third spawn site and the one that loads
  // native libraries (onnxruntime/DirectML, tokenizers), so it must be listed here —
  // "both sites" is exactly how it was missed the first time.
  for (const file of ['lib/engine.js', 'lib/memu.js']) {
    const text = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8')
    assert.match(text, /\.\.\.windowsSystemEnv\(\)/, file + ' must seed the child environment')
    const overlayAt = text.indexOf('...windowsSystemEnv()')
    const inheritedAt = text.indexOf('...process.env', overlayAt)
    assert.ok(inheritedAt > overlayAt, file + ' must let the host environment win over the defaults')
  }
  const worker = fs.readFileSync(new URL('../lib/local-embedding-manager.js', import.meta.url), 'utf8')
  const overlayAt = worker.indexOf('...windowsSystemEnv(')
  const inheritedAt = worker.indexOf('...inherited', overlayAt)
  assert.ok(overlayAt > 0, 'lib/local-embedding-manager.js must seed the child environment')
  assert.ok(inheritedAt > overlayAt, 'the overlay must come first so a real host value wins')
})

test('the worker child gets the system variables back and keeps nothing else', () => {
  const env = childEnvironment(
    { ELECTRON_RUN_AS_NODE: '1', DSH_MEMU_EMBED_TOKEN: 'tok' },
    { platform: 'win32', env: { SystemDrive: 'D:', PATH: 'D:/bin', HTTP_PROXY: 'http://corp:8080', OPENAI_API_KEY: 'sk-x' } },
  )
  assert.equal(env.SystemDrive, 'D:', 'an existing value is never overwritten')
  assert.equal(env.SystemRoot, 'D:/Windows', 'the missing root is rebuilt from the drive the host gave')
  assert.equal(env.windir, 'D:/Windows')
  assert.equal(env.PATH, 'D:/bin', 'the inherited PATH wins over the system32 default')
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(env.DSH_MEMU_EMBED_TOKEN, 'tok')
  assert.equal(env.HTTP_PROXY, undefined, 'an inherited proxy would reroute the loopback call')
  assert.equal(env.OPENAI_API_KEY, undefined, 'the worker must never hold a cloud credential')
})

test('a stripped worker environment is still complete enough to load a native library', () => {
  const env = childEnvironment({}, { platform: 'win32', env: {} })
  assert.equal(env.SystemDrive, 'C:')
  assert.equal(env.SystemRoot, 'C:/Windows')
  assert.equal(env.windir, 'C:/Windows')
  assert.equal(env.PATH, 'C:/Windows/system32')
})

test('a stripped worker environment gets the directory the DLLs are resolved from', () => {
  const env = childEnvironment({}, { platform: 'win32', env: { HOMEDRIVE: 'E:' } })
  assert.equal(env.SystemDrive, 'E:', 'the drive comes from HOMEDRIVE when SystemDrive is gone')
  assert.equal(env.SystemRoot, 'E:/Windows')
})
