// 设置面全覆盖守卫（设计文档 §11 第 6 项）：防止"新增设置键 + 多处白名单"漂移。
// 四条断言：
//   1. state.js 枚举表（:425 附近的 enums 对象）里的每个键必须出现在 setSettings
//      白名单里——枚举校验为可设置的键而存在，校验了却不可设置 = 死键。
//      （注意：resetSettings 是产品 curated 名单——backend 类选择如 vectorSource
//      有意不参与"重置调参"，故 reset 不做全量断言。）
//   2. resetSettings 名单的每个键必须在 DEFAULT_SETTINGS 里——reset 的实现是
//      `patch[key] = DEFAULT_SETTINGS[key]`，键缺默认就会把 undefined 写进 state。
//   3. 每个枚举键的 DEFAULT_SETTINGS 默认值必须是该枚举的合法值——默认值越界等于
//      出厂即非法。
//   4. 三个新键（consolidationRunner / consolidationTurnLog / consolidationTurnLogTools）
//      必须在两张名单里（本设计的回归锚点）。
// 实现取源码文本解析而非 import（enums 表未导出，且解析即守卫源码形态本身——
// 与 check-doc-drift / binding-diagnostics 的行号契约同款思路）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SETTINGS } from '../lib/state.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const stateSrc = fs.readFileSync(path.join(HERE, '..', 'lib', 'state.js'), 'utf8')
const rpcSrc = fs.readFileSync(path.join(HERE, '..', 'lib', 'rpc.js'), 'utf8')

function enumBlock(src) {
  const marker = src.indexOf('const enums = {')
  assert.notEqual(marker, -1, 'state.js 的 enums 表必须存在（校验函数被移动后请更新本测试的定位标记）')
  let depth = 0, end = -1
  for (let i = marker; i < src.length; i++) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i; break } }
  }
  assert.notEqual(end, -1, 'enums 表右括号配平失败')
  return src.slice(marker, end + 1)
}

function extractEnumKeys(src) {
  const keys = [...enumBlock(src).matchAll(/(?:^|[,{\s])([A-Za-z_][A-Za-z0-9_]*):\s*\[/g)].map((m) => m[1])
  assert.ok(keys.length >= 10, `enums 表解析出 ${keys.length} 个键，明显过少——解析器或表结构变了`)
  return keys
}

function extractWhitelist(src, caseName, terminator) {
  const label = `case '${caseName}'`
  const start = src.indexOf(label)
  assert.notEqual(start, -1, `rpc.js 缺少 case '${caseName}'（结构变了请更新本测试定位）`)
  const stop = src.indexOf(terminator, start)
  // 从 case 标签之后起切 + 剥离行注释——注释里的引号词（如 "'fork'"）与标签本身不是名单项
  let block = src.slice(start + label.length, stop === -1 ? src.length : stop)
  block = block.replace(/\/\/[^\n]*/g, '')
  const items = [...block.matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)].map((m) => m[1]).filter((k) => k !== caseName)
  assert.ok(items.length >= 20, `${caseName} 白名单解析出 ${items.length} 项，明显过少`)
  return new Set(items)
}

const enumKeys = extractEnumKeys(stateSrc)
const resetList = extractWhitelist(rpcSrc, 'resetSettings', "case 'setSettings'")
const setList = extractWhitelist(rpcSrc, 'setSettings', 'const clean = {}')

// 有意不走通用 setSettings 的枚举键（专用 RPC 路径，自带校验）：
//   vectorSource → setEmbeddingSource（memu-config.js，切源有副作用需专门处理，
//   源值校验在专用函数内：local|api，'remote'→'api' 归一化）。
// 新增豁免必须在此登记 + 注明专用路径，否则视为漂移。
const SET_WHITELIST_EXCEPTIONS = new Set(['vectorSource'])

test('enums 表的每个键都在 setSettings 白名单里（可设置，否则是死键；豁免见 SET_WHITELIST_EXCEPTIONS）', () => {
  const missing = enumKeys.filter((k) => !setList.has(k) && !SET_WHITELIST_EXCEPTIONS.has(k))
  assert.deepEqual(missing, [], `以下枚举键缺出 setSettings 白名单（既不在名单也不在豁免表）：${missing.join(', ')}`)
})

test('resetSettings 名单的每个键都有 DEFAULT_SETTINGS 默认值（否则 reset 写入 undefined）', () => {
  const missing = [...resetList].filter((k) => !(k in DEFAULT_SETTINGS))
  assert.deepEqual(missing, [], `以下 reset 键缺默认值（重置会写 undefined）：${missing.join(', ')}`)
})

test('每个枚举键的默认值都是该枚举的合法值', () => {
  const block = enumBlock(stateSrc)
  const problems = []
  for (const key of enumKeys) {
    const m = block.match(new RegExp(`${key}:\\s*\\[([^\\]]+)\\]`))
    if (!m) continue
    const values = [...m[1].matchAll(/'([^']+)'/g)].map((v) => v[1])
    const def = DEFAULT_SETTINGS[key]
    if (def !== undefined && values.length && !values.includes(def)) {
      problems.push(`${key}: 默认 '${def}' 不在枚举 [${values.join(', ')}] 里`)
    }
  }
  assert.deepEqual(problems, [], `默认值越界：\n${problems.join('\n')}`)
})

test('三个新键（runner/turnLog/turnLogTools）都在两张名单里（本设计回归锚点）', () => {
  for (const key of ['consolidationRunner', 'consolidationTurnLog', 'consolidationTurnLogTools']) {
    assert.ok(resetList.has(key), `${key} 缺出 resetSettings`)
    assert.ok(setList.has(key), `${key} 缺出 setSettings`)
  }
})
