import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-multi-'))
process.env.DSH_MEMU_HOME = home
const state = await import('../lib/state.js')
test.after(() => { state.flushState(); fs.rmSync(home, { recursive: true, force: true }) })
const library = state.createLibrary({ name: 'parallel', cwd: path.join(home, 'parallel') })
const moduleUrl = new URL('../lib/state.js', import.meta.url).href
function worker(prefix) {
  return new Promise((resolve, reject) => {
    const pathsUrl = new URL('../lib/paths.js', import.meta.url).href
    const code = `const state = await import(${JSON.stringify(moduleUrl)}); const {retryStoreWrite}=await import(${JSON.stringify(pathsUrl)}); for(let i=0;i<15;i++){await retryStoreWrite(()=>state.updatePrivateIndex(${JSON.stringify(library.id)}, index=>{index.entries[${JSON.stringify(prefix)}+i]={content:'retained '+i}}));state.setSessionBinding(${JSON.stringify(prefix)}+i,{useGlobal:false});await retryStoreWrite(()=>state.flushState())}`
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, DSH_MEMU_HOME: home }, windowsHide: true })
    let errors = ''
    child.stderr.on('data', data => { errors += data })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error(errors)))
  })
}
test('independent processes keep every disjoint memory and session binding', async () => {
  await Promise.all([worker('a'), worker('b'), worker('c')])
  state.clearCaches()
  assert.equal(Object.keys(state.loadPrivateIndex(library.id).entries).length, 45)
  assert.equal(Object.keys(state.loadState().sessions).length, 45)
})
