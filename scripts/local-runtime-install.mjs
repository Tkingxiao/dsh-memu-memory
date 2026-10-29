#!/usr/bin/env node
// 受管本地向量运行时的可复现安装/核验脚本（§14.13）。
//
//   node scripts/local-runtime-install.mjs                        # 只读：打印制品计划、当前状态、已装摘要
//   node scripts/local-runtime-install.mjs --download             # 显式联网安装（等同用户在设置里点确认）
//   node scripts/local-runtime-install.mjs --download --target <dir> --id <modelId> --platform win32-x64
//   node scripts/local-runtime-install.mjs --shallow              # 复用判定只比字节数，不重算 sha256
//   node scripts/local-runtime-install.mjs --download --cache <dir> # 用离线缓存里的同名 tarball 替代联网
//
// 边界：只写 --target（默认仓库内 .tmp-* 临时目录）；不写 DSH_MEMU_HOME、不写 active profile、
// 不读不写真实记忆库；不装 Ollama，也不需要 DSH_MEMU_EMBED_RUNTIME_DIR。
// --cache 只改「字节从哪来」：大小与 sha256 仍按 catalog pin 逐项校验。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEmbeddingRuntimeInstaller, embeddingRuntimePlatform } from '../lib/embedding-runtime.js'
import { getEmbeddingCatalog, getEmbeddingModel } from '../lib/embedding-catalog.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')

const argv = process.argv.slice(2)
const flag = name => argv.includes('--' + name)
const option = name => {
  const index = argv.indexOf('--' + name)
  return index >= 0 ? argv[index + 1] : undefined
}

const target = path.resolve(option('target') || path.join(REPO, '.tmp-local-vector-20261030', 'runtime-managed'))
const platform = option('platform') || embeddingRuntimePlatform()
const modelId = option('id') || null
const download = flag('download')
const deep = !flag('shallow')
const cache = option('cache') ? path.resolve(option('cache')) : null

// 离线缓存：只替换字节来源，不跳过任何校验。tarball 文件名允许几种常见写法。
function cacheLookup() {
  const entry = modelId ? getEmbeddingModel(modelId) : getEmbeddingCatalog().find(item => item.availability === 'available')
  const artifacts = Array.isArray(entry?.runtime?.artifacts) ? entry.runtime.artifacts : []
  const map = new Map()
  for (const artifact of artifacts) {
    const names = []
    const base = String(artifact.url || '').split('/').pop()
    if (base) names.push(base)
    const pkg = String(artifact.name || '')
    if (pkg) {
      names.push(pkg + '.tgz', pkg.replace(/[\\/]+/g, '__') + '.tgz', pkg.split('/').pop() + '.tgz')
      names.push(pkg.replace(/[^A-Za-z0-9._-]+/g, '-') + '.tgz')
    }
    for (const name of names) {
      const candidate = path.join(cache, name)
      if (fs.existsSync(candidate)) { map.set(artifact.url, candidate); break }
    }
  }
  return map
}

const cacheFiles = cache ? cacheLookup() : null
const fetchImpl = cacheFiles
  ? async url => {
    const file = cacheFiles.get(url)
    if (!file) throw new Error('offline cache ' + cache + ' has no tarball for ' + url)
    const bytes = fs.readFileSync(file)
    return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } })
  }
  : undefined

const installer = createEmbeddingRuntimeInstaller({
  root: target,
  platform,
  fetchImpl,
  logger: {
    info: message => console.error('info ' + message),
    warn: message => console.error('warn ' + message),
  },
})

const summarize = status => ({
  status: status.status,
  ready: status.ready,
  platform: status.platform,
  key: status.key,
  path: status.path,
  engine: status.engine,
  version: status.version,
  abi: status.abi,
  root: status.root,
  verifiedPlatforms: status.verifiedPlatforms,
  artifacts: Array.isArray(status.artifacts)
    ? status.artifacts.map(item => ({ name: item.name, version: item.version, bytes: item.bytes, sha256: item.sha256, license: item.license }))
    : null,
  installedAt: status.installedAt ?? null,
  verifiedAt: status.verifiedAt ?? null,
  smoke: status.smoke ?? null,
  checks: Array.isArray(status.checks) ? status.checks : null,
  progress: status.progress ?? null,
  inspect: status.inspect ?? null,
  error: status.error ?? null,
})

try {
  const before = installer.getStatus({ deep, modelId })
  console.log(JSON.stringify({ phase: 'before', deep, download, ...summarize(before) }, null, 2))
  if (!before.ready && !download) {
    console.error('\n未安装。加 --download 才会联网下载并安装（有明确确认语义）；本脚本不会自动下载。')
    process.exit(0)
  }
  if (download) {
    const started = Date.now()
    const result = await installer.ensure({ modelId, confirmed: true })
    console.log(JSON.stringify({
      phase: 'install',
      elapsedMs: Date.now() - started,
      status: result.status,
      ready: result.ready,
      reused: result.reused,
      key: result.key,
      platform: result.platform,
      path: result.path,
      engine: result.engine,
      version: result.version,
      abi: result.abi,
      installedAt: result.installedAt,
      verifiedAt: result.verifiedAt,
      checks: result.checks,
      smoke: result.smoke,
      artifacts: result.artifacts,
    }, null, 2))
    const after = installer.getStatus({ deep: true, modelId })
    console.log(JSON.stringify({ phase: 'after', ...summarize(after) }, null, 2))
    if (!after.ready) throw new Error('installer reported installed but the runtime is not reusable')
  }
} catch (error) {
  const code = String(error?.code || 'LOCAL_VECTOR_RUNTIME_SCRIPT_FAILED')
  console.error('FAIL ' + code + ': ' + String(error?.message || error))
  if (Array.isArray(error?.errors)) for (const item of error.errors) console.error('  - ' + JSON.stringify(item))
  if (error?.inspect) console.error('  inspect: ' + error.inspect)
  process.exit(1)
} finally {
  installer.dispose()
}
