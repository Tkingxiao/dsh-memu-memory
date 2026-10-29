#!/usr/bin/env node
// 本地向量目录/下载器的可复现核验脚本（§14.4）。
//
//   node scripts/local-vector-verify.mjs                  # 只读：校验目录、manifest、来源与已安装制品
//   node scripts/local-vector-verify.mjs --download       # 显式联网下载（等同用户确认），默认落到临时目录
//   node scripts/local-vector-verify.mjs --download --target <dir> --id <modelId>
//
// 边界：不读不写真实记忆库、不写 active profile；默认目标目录是仓库里的 .tmp-* 临时目录。

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getEmbeddingCatalog,
  getEmbeddingModel,
  resolveEmbeddingSources,
  validateEmbeddingManifest,
} from '../lib/embedding-catalog.js'
import { createEmbeddingDownloadManager } from '../lib/embedding-download.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')

const argv = process.argv.slice(2)
const flag = name => argv.includes('--' + name)
const option = name => {
  const index = argv.indexOf('--' + name)
  return index >= 0 ? argv[index + 1] : undefined
}

const download = flag('download')
const target = path.resolve(option('target') || path.join(REPO, '.tmp-local-vector-20261030', 'model-root'))
const only = option('id')

let failures = 0
const log = line => console.log(line)
const bad = line => { failures += 1; console.error('FAIL ' + line) }

log('== 目录校验（manifest schema / 固定 revision / 逐文件 hash 声明）')
for (const entry of getEmbeddingCatalog()) {
  if (only && entry.id !== only) continue
  const report = validateEmbeddingManifest(entry)
  const source = resolveEmbeddingSources(entry)
  log('-- ' + entry.id + ' [' + entry.availability + '] dim=' + entry.dimension + ' maxTokens=' + entry.maxTokens
    + ' bytes=' + entry.totalBytes + ' fingerprint=' + entry.profileFingerprint.slice(0, 12))
  if (report.errors.length) for (const error of report.errors) bad(entry.id + ' ' + error.code + ': ' + error.message)
  else log('   manifest ok, ' + report.warnings.length + ' warning(s)')
  for (const warning of report.warnings) log('   warn ' + warning.code + ': ' + warning.message)
  if (entry.availability === 'available') {
    if (!source.primary) bad(entry.id + ' has no usable pinned source')
    else {
      log('   source=' + source.primary.provider + ' repo=' + source.primary.repo + ' revision=' + source.primary.revision)
      for (const file of source.primary.files) log('   file ' + file.path + ' ' + file.bytes + 'B ' + file.sha256.slice(0, 16) + '…')
    }
    for (const skipped of source.skipped) log('   skipped ' + skipped.provider + ': ' + skipped.reason)
  } else {
    log('   pending, 无可下载制品：' + entry.pendingReasons.join(' / '))
  }
}

if (download) {
  const entry = getEmbeddingModel(only || 'bge-small-zh-v1.5-int8')
  if (!entry) { bad('unknown model id: ' + only); process.exit(1) }
  log('')
  log('== 显式下载 ' + entry.id + ' → ' + target)
  const manager = createEmbeddingDownloadManager({ root: target })
  try {
    const status = await manager.download(entry.id, { confirmed: true })
    log('installed=' + status.installed + ' state=' + status.state + ' revision=' + status.revision + ' provider=' + status.provider)
    log('checks: ' + status.checks.join(', '))
    const deep = manager.getStatus(entry.id, { deep: true })
    log('deep hash re-verify: ' + deep.verified)
    if (deep.verified !== true) bad('installed artifact does not re-verify')
  } catch (error) {
    bad('download failed: ' + (error.code || '') + ' ' + error.message)
  }
} else {
  log('')
  log('== 已安装状态（只读，deep=重新计算每个文件的 sha256）')
  const manager = createEmbeddingDownloadManager({ root: target })
  for (const entry of getEmbeddingCatalog()) {
    if (only && entry.id !== only) continue
    const status = manager.getStatus(entry.id, { deep: true })
    log('-- ' + entry.id + ': state=' + status.state + ' installed=' + status.installed + ' active=' + status.active
      + (status.verified === null ? '' : ' deep=' + status.verified)
      + (status.error ? ' error=' + status.error.code : ''))
    if (status.installed && status.verified === false) bad(entry.id + ' installed files no longer match their hashes')
  }
  log('（加 --download 才会联网；本脚本从不写 active profile）')
}

log('')
log(failures === 0 ? 'RESULT ok' : 'RESULT ' + failures + ' failure(s)')
process.exit(failures === 0 ? 0 : 1)
