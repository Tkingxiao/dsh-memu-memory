import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memu-memory-env-'))
process.env.DSH_MEMU_MEMORY_HOME = home

const { localEmbeddingEnv } = await import('../lib/memu.js')

test.after(() => fs.rmSync(home, { recursive: true, force: true }))

const E5 = 'multilingual-e5-small@252d0dcb679dda2c7b6fd5bbfed15df3c7feaebf+dsh-local-embedding-v1'
const BGE = 'bge-small-zh-v1.5-int8@313386ad7ffad360a4870fd1910f8ecaf1a05151+dsh-local-embedding-v1'
const BASE = 'http://127.0.0.1:45123/v1'
const TOKEN = 'worker-token-0123456789abcdef'

// §14.4：MemU 的请求信封里没有角色字段，所以「这条文本是查询还是条目」只能由启动子进程的
// 插件来说——它写在 model 字符串上，由 worker 解析回来。
test('the role the plugin knows rides on the model string MemU echoes back', () => {
  const query = localEmbeddingEnv({ baseUrl: BASE, token: TOKEN, model: E5, rolesRequired: true, role: 'query', db: 'C:/x/global.sqlite3' })
  assert.equal(query.MEMU_EMBED_MODEL, E5 + ':query')
  const document = localEmbeddingEnv({ baseUrl: BASE, token: TOKEN, model: E5, rolesRequired: true, role: 'document' })
  assert.equal(document.MEMU_EMBED_MODEL, E5 + ':passage')
  // 未知角色也只能落在文档读法上，不能悄悄变成查询读法
  assert.equal(localEmbeddingEnv({ baseUrl: BASE, token: TOKEN, model: E5, rolesRequired: true }).MEMU_EMBED_MODEL, E5 + ':passage')
})

test('a model with one prefix for both sides keeps the byte-identical model string', () => {
  for (const role of [undefined, 'query', 'document']) {
    assert.equal(
      localEmbeddingEnv({ baseUrl: BASE, token: TOKEN, model: BGE, rolesRequired: false, role }).MEMU_EMBED_MODEL,
      BGE,
      'BGE/MiniLM must not pick up a role suffix',
    )
  }
})

test('the strict-local envelope is unchanged: loopback base, token as key, telemetry off', () => {
  const env = localEmbeddingEnv({ baseUrl: BASE, token: TOKEN, model: BGE, db: 'C:/x/global.sqlite3' })
  assert.equal(env.MEMU_MEMORY_MODE, 'local')
  assert.equal(env.MEMU_EMBED_PROVIDER, 'openai')
  assert.equal(env.MEMU_TELEMETRY, '0')
  assert.equal(env.DO_NOT_TRACK, '1')
  assert.equal(env.MEMU_EVENTS_BASE_URL, '')
  assert.equal(env.MEMU_BASE_URL, BASE)
  assert.equal(env.MEMU_API_KEY, TOKEN, 'the loopback token is the only credential this env can carry')
  assert.equal(env.MEMU_DB, 'C:/x/global.sqlite3')
  assert.equal(Object.keys(env).filter(name => /PROXY/i.test(name)).length, 0)
})
