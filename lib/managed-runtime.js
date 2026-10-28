import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { unzipSync } from 'fflate'
import { engineDir, ensureDir, writeJson } from './paths.js'

export const UV_VERSION = '0.13.6'
export const MANAGED_PYTHON = '3.12.14'
// Pinned release digests, verified against astral-sh/uv release metadata on 2026-10-28.
const ASSETS = {
  'win32-x64': ['uv-x86_64-pc-windows-msvc.zip', 'a2a8820d5eea32f08ef467ef3b7f66883a9b076d5737a2fc2fbb5f458d1bb50f'],
  'win32-arm64': ['uv-aarch64-pc-windows-msvc.zip', 'c2426c0c8e28b53d8c440e47a18d96ad4db51e159866c0e81435b196d7f0081c'],
  'linux-x64': ['uv-x86_64-unknown-linux-gnu.tar.gz', 'f29c3e94ffabd7e6f3ba521dba169a9b7ec12100bf3257087f0f24f6123f3645'],
  'linux-arm64': ['uv-aarch64-unknown-linux-gnu.tar.gz', '229e194255c7958d86d56e8790d969a6f74736592133f0dfd0076f754c642c1d'],
  'darwin-x64': ['uv-x86_64-apple-darwin.tar.gz', '63ba17fdda55ad1a230d4b37fc6017ffa10c23688c83818bd3bfdf914c652a02'],
  'darwin-arm64': ['uv-aarch64-apple-darwin.tar.gz', '60fbd5c8a1ed681845eea28d9d622fcde03c51e91a43465b64a1e17db1ed3472'],
}

export function verifyRuntimeArchive(data, digest) {
  if (crypto.createHash('sha256').update(data).digest('hex') !== digest) throw new Error('managed runtime checksum mismatch; refusing to execute')
}

export async function ensureManagedPython({ run, log = () => {}, fetcher = fetch } = {}) {
  const platform = `${process.platform}-${process.arch}`
  const asset = ASSETS[platform]
  if (!asset) throw new Error(`managed Python fallback is unavailable for ${platform}; set DSH_MEMU_PYTHON`)
  const root = ensureDir(engineDir('runtime'))
  const bin = ensureDir(path.join(root, `uv-${UV_VERSION}`))
  const executable = path.join(bin, process.platform === 'win32' ? 'uv.exe' : 'uv')
  const env = {
    UV_PYTHON_INSTALL_DIR: ensureDir(path.join(root, 'python')),
    UV_CACHE_DIR: ensureDir(path.join(root, 'cache')),
    UV_PYTHON_BIN_DIR: ensureDir(path.join(root, 'bin')),
    UV_NO_PROGRESS: '1', UV_PYTHON_PREFERENCE: 'only-managed', UV_NO_MODIFY_PATH: '1', UV_NO_CONFIG: '1',
  }
  if (!fs.existsSync(executable)) {
    log(`no usable Python with pip; downloading pinned uv ${UV_VERSION}`)
    const response = await fetcher(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset[0]}`, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok || Number(response.headers.get('content-length')) > 64 * 1024 * 1024) throw new Error('managed runtime download failed or is too large')
    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > 64 * 1024 * 1024) throw new Error('managed runtime download exceeds 64 MB')
      chunks.push(chunk)
    }
    const bytes = Buffer.concat(chunks)
    verifyRuntimeArchive(bytes, asset[1])
    const temporary = `${executable}.tmp-${crypto.randomUUID()}`
    if (asset[0].endsWith('.zip')) {
      const files = unzipSync(bytes, { filter: item => item.name === 'uv.exe' && item.originalSize < 100 * 1024 * 1024 })
      if (!files['uv.exe']) throw new Error('managed runtime archive has no uv executable')
      fs.writeFileSync(temporary, files['uv.exe'], { mode: 0o700, flag: 'wx' })
    } else {
      const archive = path.join(bin, `download-${crypto.randomUUID()}.tar.gz`)
      fs.writeFileSync(archive, bytes, { mode: 0o600, flag: 'wx' })
      try {
        const { x } = await import('tar')
        await x({ file: archive, cwd: bin, strip: 1, strict: true,
          filter: (name, entry) => entry.type === 'File' && /^uv-[a-z0-9_-]+\/uv$/.test(name) && entry.size < 100 * 1024 * 1024 })
        if (!fs.existsSync(executable)) throw new Error('managed runtime archive has no uv executable')
      } finally { fs.rmSync(archive, { force: true }) }
    }
    if (fs.existsSync(temporary)) fs.renameSync(temporary, executable)
    if (process.platform !== 'win32') fs.chmodSync(executable, 0o700)
    writeJson(path.join(bin, 'verified.json'), { version: UV_VERSION, archive: asset[0], sha256: asset[1] })
  }
  const version = await run(executable, ['--version'], { env, timeoutMs: 20_000 })
  if (version.code !== 0 || !version.stdout.startsWith(`uv ${UV_VERSION} `) && version.stdout.trim() !== `uv ${UV_VERSION}`) throw new Error('managed uv version mismatch')
  log(`installing managed Python ${MANAGED_PYTHON} inside the plugin engine directory`)
  const installed = await run(executable, ['python', 'install', MANAGED_PYTHON, '--no-progress'], { env, timeoutMs: 300_000 })
  if (installed.code !== 0) throw new Error('managed Python installation failed; set DSH_MEMU_PYTHON')
  const found = await run(executable, ['python', 'find', '--no-python-downloads', MANAGED_PYTHON], { env, timeoutMs: 20_000 })
  const python = path.resolve(found.stdout.trim())
  if (found.code !== 0 || !python.startsWith(path.resolve(env.UV_PYTHON_INSTALL_DIR) + path.sep) || !fs.existsSync(python)) throw new Error('managed Python escaped its engine directory')
  return { kind: 'python', cmd: python, prefix: [], version: { major: 3, minor: 12, raw: MANAGED_PYTHON }, hasPip: false, uvPath: executable, uvEnv: env, source: 'managed-uv' }
}
