import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dataDir, ensureDir, readJson, writeJson, stamp } from './paths.js'
import { getPromptDomains } from './state.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_DIR = path.join(HERE, 'prompts')
const MANIFEST_VERSION = 1

export const PROMPT_DEFS = [
  {
    key: 'image-caption', file: 'image-caption.md', title: '图片客观描述',
    description: '可选视觉服务的描述边界：只描述可见内容，不猜身份与意义。',
    variables: [], scope: 'private',
  },
  {
    key: 'system-guide',
    file: 'system-guide.md',
    title: '记忆使用指南',
    description: '注入 system prompt 的常驻记忆规则：什么时候检索、什么时候写入、永久记忆与 unpin 的边界。',
    variables: ['mustRememberCap', 'unpinBudget', 'shortTermTtlHours', 'anchorTokens', 'turnTokens'],
    scope: 'private',
    domainLayered: true,
  },
  {
    key: 'private-policy',
    file: 'private-policy.md',
    title: '私有记忆策略',
    description: '按领域约束主 agent 的记忆写入：代码逻辑与验证、角色连续性、事实与推断、永久记忆与披露边界。',
    variables: ['mustRememberCap', 'unpinBudget', 'shortTermTtlHours', 'anchorTokens', 'turnTokens'],
    scope: 'private',
    domainLayered: true,
  },
  {
    key: 'private-consolidation',
    file: 'private-consolidation.md',
    title: '私有记忆整理',
    description: '点击“整理这次对话”时发给主 agent 的整理指令。',
    variables: ['libraryName', 'domain', 'mustRememberCap'],
    scope: 'private',
    domainLayered: true,
  },
  {
    key: 'global-curator',
    file: 'global-curator.md',
    title: '全局记忆 curator',
    description: '非主 curator 从选中对话提炼全局记忆的完整提示词。{{input}} 由插件注入会话数据。',
    variables: ['input'],
    scope: 'global',
    // The curator's job is to reason across domains; splitting it would break that.
  },
]

function variantDefs(def) {
  if (def.domainLayered !== true) return []
  return getPromptDomains().map((domain) => ({
    ...def,
    key: `${def.key}.${domain}`,
    file: def.file.replace(/\.md$/, `.${domain}.md`),
    baseKey: def.key,
    domain,
    // The domain is shown by the client, translated, so the title stays the same
    // on every page and the page chip does the distinguishing.
    title: def.title,
  }))
}

/** Every prompt the manifest knows about, base first then its variants. */
export function allDefs() {
  const out = []
  for (const def of PROMPT_DEFS) {
    out.push(def)
    out.push(...variantDefs(def))
  }
  return out
}

// The one instruction that differs between "the session agent writes memory with
// its tools" and "a remote model returns JSON". It is a protocol contract, not
// guidance, so it lives in code while the prompt body stays shared.
export const CONSOLIDATION_CONTRACTS = {
  local: '使用当前可用的记忆工具，先按主题检索去重。兼容细节用 memu_private_update 合并；真正新增或矛盾待复核的内容用 memu_private_remember，一条一件，不自行裁定冲突。不能查询或更新时如实保留限制，不宣称已核对或已修改。没有值得留的就直接结束，不要勉强写。',
  remote: [
    '只输出一个 JSON 对象，不要任何解释或 Markdown 代码块：',
    '{"memories":[{"title":"≤30字","content":"完整正文","layer":"long_term|short_term","tags":["可选"],"open_loop":false,"confidence":0.0,"source":"inferred|user_said|imagined|told","visibility":"session|shared|secret","disclosure":"can_tell|only_if_asked|never_say","owner":"me|us|about_user|about_project","mood_valence":0.0,"arousal":0.35,"peak":false,"salient_date":null}]}',
    '你没有记忆工具，也没有输入以外的索引：只返回最多 3 条候选，不声称已检索、合并、更新、裁决或完成写入。不要输出工具调用或 must_remember；矛盾候选在 content 中保留来源、时间与不确定性，交给后续复核。领域表达服从上文，字段服从本 JSON 协议。未确定的感受/日期用 null，不为填字段编造。',
    '没有值得留的就输出 {"memories":[]}。',
  ].join('\n'),
}

// The domain page list is data, so the key map has to be rebuilt when it changes
// instead of being frozen at import time.
const defCache = { domainsKey: null, map: new Map() }
function defMap() {
  const key = getPromptDomains().join(',')
  if (defCache.domainsKey !== key) {
    defCache.domainsKey = key
    defCache.map = new Map(allDefs().map((d) => [d.key, d]))
  }
  return defCache.map
}
function defByKey(key) { return defMap().get(key) }

export function promptsDir() {
  return path.join(dataDir(), 'prompts')
}

function manifestPath() {
  return path.join(promptsDir(), 'manifest.json')
}

function defaultPath(def) {
  return path.join(DEFAULT_DIR, def.file)
}

function userPath(def) {
  return path.join(promptsDir(), def.file)
}

function hash(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex').slice(0, 16)
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return null }
}

export function renderTemplate(text, vars = {}) {
  return String(text || '').replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) return String(vars[key] ?? '')
    return match
  })
}

function readManifest() {
  const raw = readJson(manifestPath(), null)
  return raw && typeof raw === 'object' && raw.prompts && typeof raw.prompts === 'object'
    ? { version: MANIFEST_VERSION, prompts: raw.prompts }
    : { version: MANIFEST_VERSION, prompts: {} }
}

function writeManifest(manifest) {
  writeJson(manifestPath(), manifest)
}

export function getPromptState(key) {
  const def = defByKey(key)
  if (!def) throw new Error(`unknown prompt: ${key}`)
  let readDefault = readText(defaultPath(def))
  let inheritedFrom = null
  if (readDefault === null && def.baseKey) {
    // A freshly added domain page has no file yet. Showing the base text gives the
    // user something to edit instead of an empty box; the runtime still only
    // prefers the variant once a real file exists (see resolveDef).
    const base = defByKey(def.baseKey)
    const baseText = base ? readText(defaultPath(base)) : null
    if (baseText !== null) {
      readDefault = baseText
      inheritedFrom = def.baseKey
    }
  }
  // A base prompt missing from the package means a broken install and must be
  // loud. A variant may legitimately not ship (or be deleted by hand) — that is
  // a fallback decision, not an error.
  if (readDefault === null && !def.baseKey) throw new Error(`missing default prompt: ${def.file}`)
  const defaultText = readDefault === null ? '' : readDefault
  const userText = readText(userPath(def))
  const defaultHash = hash(defaultText)
  const userHash = userText === null ? null : hash(userText)
  const manifest = readManifest()
  const record = manifest.prompts[key] || {}
  return {
    key,
    baseKey: def.baseKey || null,
    domain: def.domain || null,
    scope: def.scope || 'private',
    inheritedFrom,
    title: def.title,
    description: def.description,
    variables: def.variables,
    source: userText === null ? 'default' : 'user',
    text: userText === null ? defaultText : userText,
    defaultText,
    userText,
    defaultHash,
    userHash,
    defaultUpdated: record.defaultUpdated === true
      || Boolean(record.defaultHash && record.defaultHash !== defaultHash && userHash !== null),
    updatedAt: record.updatedAt || null,
  }
}

export function getPromptStates() {
  return allDefs().map((def) => getPromptState(def.key))
}

/**
 * Picks the definition to use for a conversation's domain. A variant applies only
 * when the domain is listed *and* its file exists — in the package or as a user
 * override — so deleting a variant degrades to the base prompt instead of
 * throwing inside system-prompt assembly.
 */
export function resolveDef(key, domain) {
  const base = defByKey(key)
  if (!base) throw new Error(`unknown prompt: ${key}`)
  if (base.baseKey) return base
  const want = String(domain || 'general')
  if (base.domainLayered !== true) return base
  if (!getPromptDomains().includes(want)) return base
  const variant = defByKey(`${key}.${want}`)
  if (!variant) return base
  if (readText(defaultPath(variant)) === null && readText(userPath(variant)) === null) return base
  return variant
}

export function loadPrompt(key, vars = {}) {
  const state = getPromptState(key)
  return {
    ...state,
    text: renderTemplate(state.text, vars),
  }
}

export function loadPromptForDomain(key, vars = {}, domain = 'general') {
  const def = resolveDef(key, domain)
  const state = getPromptState(def.key)
  return {
    ...state,
    baseKey: def.baseKey || key,
    text: renderTemplate(state.text, vars),
    fellBackToBase: !def.baseKey,
  }
}

export function savePromptOverride(key, text) {
  const def = defByKey(key)
  if (!def) throw new Error(`unknown prompt: ${key}`)
  const value = String(text ?? '')
  if (value.length > 200_000) throw new Error('prompt is too long (max 200000 chars)')
  ensureDir(promptsDir())
  fs.writeFileSync(userPath(def), value, 'utf8')
  const manifest = readManifest()
  const defaultText = readText(defaultPath(def)) || ''
  manifest.prompts[key] = {
    defaultHash: hash(defaultText),
    userHash: hash(value),
    defaultUpdated: false,
    updatedAt: stamp(),
  }
  writeManifest(manifest)
  return getPromptState(key)
}

export function resetPrompt(key) {
  const def = defByKey(key)
  if (!def) throw new Error(`unknown prompt: ${key}`)
  try { fs.rmSync(userPath(def), { force: true }) } catch {}
  const manifest = readManifest()
  const defaultText = readText(defaultPath(def)) || ''
  manifest.prompts[key] = {
    defaultHash: hash(defaultText),
    userHash: null,
    defaultUpdated: false,
    updatedAt: stamp(),
  }
  writeManifest(manifest)
  return getPromptState(key)
}

export function resetAllPrompts() {
  for (const def of allDefs()) resetPrompt(def.key)
  return getPromptStates()
}

export function syncPromptDefaults() {
  const manifest = readManifest()
  // Start from what is already recorded: introducing variant keys must never
  // drop a user's override record for a base key that still exists.
  const next = { ...manifest.prompts }
  let changed = false
  for (const def of allDefs()) {
    const defaultText = readText(defaultPath(def))
    if (defaultText === null) continue
    const defaultHash = hash(defaultText)
    const userText = readText(userPath(def))
    const userHash = userText === null ? null : hash(userText)
    const previous = next[def.key] || {}
    const defaultUpdated = userHash !== null && (previous.defaultUpdated === true
      || previous.defaultHash !== undefined && previous.defaultHash !== defaultHash)
    next[def.key] = {
      defaultHash,
      userHash,
      defaultUpdated,
      updatedAt: previous.updatedAt || stamp(),
    }
    if (previous.defaultHash !== defaultHash || previous.userHash !== userHash || previous.defaultUpdated !== defaultUpdated) changed = true
  }
  manifest.prompts = next
  if (changed || !fs.existsSync(manifestPath())) writeManifest(manifest)
  return getPromptStates()
}

export function promptDefaultsVersion() {
  return allDefs().map((def) => {
    const text = readText(defaultPath(def)) || ''
    return `${def.key}:${hash(text)}`
  }).join(',')
}

export { DEFAULT_DIR }
