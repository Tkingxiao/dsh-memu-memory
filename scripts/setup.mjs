#!/usr/bin/env node
import process from 'node:process'
import { ENGINE_VERSION, ensureEngine, engineStatus } from '../lib/engine.js'
import { dataDir } from '../lib/paths.js'
import { backupDatabases } from '../lib/state.js'

const args = new Set(process.argv.slice(2))
const force = args.has('--force') || args.has('-f')
const json = args.has('--json')

function log(line) {
  if (!json) console.log(line)
}

async function main() {
  const before = engineStatus()
  if (!json) {
    console.log(`dsh-memu-memory engine setup`)
    console.log(`target: memu-cli ${ENGINE_VERSION}`)
    console.log(`data:   ${dataDir()}`)
    console.log('')
  }

  const result = await ensureEngine({ force: force || before.status !== 'ready', log, beforeSwitch: backupDatabases })
  if (json) {
    console.log(JSON.stringify(result, null, 2))
  } else if (result.ok) {
    console.log('')
    console.log('dsh-memu-memory engine is ready.')
    console.log(`python: ${result.current.python}`)
    console.log(`version: ${result.current.version}`)
    console.log(`commands: ${(result.current.commands || []).join(', ')}`)
    console.log('next: configure an embedding provider in DSH settings -> MemU.')
  } else {
    console.error('')
    console.error('dsh-memu-memory engine setup failed.')
    console.error(result.error || result.status)
    console.error(`log: ${engineStatus().log}`)
  }
  process.exit(result.ok ? 0 : 1)
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exit(1)
})
