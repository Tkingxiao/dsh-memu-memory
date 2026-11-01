// 集成回归时移除：lib/lexicon.js 真身（旧版，另一代理并行实现）落地之前，
// 把核心层模块解析到同目录的轻量 stub。判定保持保守——真身存在时一律放行原解析。
// 与 tests/loader.mjs 的 resolve 映射同一机制（node:module register hooks）。
import fs from 'node:fs'

const stub = new URL('./lexicon-stub.mjs', import.meta.url)
const real = new URL('../../lib/lexicon.js', import.meta.url)

export function resolve(specifier, context, next) {
  if (specifier === './lexicon.js' && String(context.parentURL || '').includes('/lib/')) {
    if (fs.existsSync(real)) return next(specifier, context)
    return { url: stub.href, shortCircuit: true, format: 'module' }
  }
  return next(specifier, context)
}
