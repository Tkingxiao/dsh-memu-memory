import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// 2026-10-30 现场：日志页的 7 个 useState + useEffect 被写在
// `if (!state) return ...` 之后。首屏少调 10 个 hook、数据到达后多调 10 个，
// React 抛 #310，整个设置弹窗和 WebUI 白屏，控制台只有一行 minified 报错。
//
// 这类 bug 很难被假 React 的渲染用例覆盖（它不校验 hook 顺序），所以用一条静态守卫：
// 组件函数体内、与组件同级的 React.use* 必须全部出现在提前 return 之前。

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// 从 `function Name(` 后的 `{` 开始做括号配对，跳过字符串与注释，拿到精确的函数体。
function bodyOf(name) {
  const start = source.indexOf('function ' + name + '(')
  assert.ok(start > 0, name + ' not found in lib/client.js')
  let index = source.indexOf('{', source.indexOf(')', start))
  assert.ok(index > start, name + ' has no function body')
  const begin = index
  let depth = 0
  let quote = null
  for (; index < source.length; index++) {
    const ch = source[index]
    if (quote) {
      if (ch === '\\') { index++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '\u0060') { quote = ch; continue }
    if (ch === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index)
      index = newline < 0 ? source.length : newline
      continue
    }
    if (ch === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2)
      index = close < 0 ? source.length : close + 1
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(begin, index + 1)
    }
  }
  assert.fail(name + ' body was never closed')
}

for (const [name, earlyReturn] of [
  ['SettingsPage', 'if (!state) return'],
  ['MemoryTab', 'if (!sessionId) return'],
]) {
  test(`${name}: every component-level hook is declared before "${earlyReturn}"`, () => {
    const body = bodyOf(name)
    const lines = body.split('\n')
    // 只认与组件同级（6 空格缩进）的提前 return：注释里也会出现这段文字，
    // 嵌套回调里的 return 则不影响组件自身的 hook 顺序。
    const literal = earlyReturn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const atComponentLevel = new RegExp('^ {6}' + literal + '\\b')
    const retLine = lines.findIndex(line => atComponentLevel.test(line))
    assert.ok(retLine > 0, `${name} no longer contains "${earlyReturn}" — update this guard instead of deleting it`)
    const later = []
    for (let line = retLine + 1; line < lines.length; line++) {
      // 同级 hook 缩进固定为 6 个空格（模块工厂内 4 + 函数体 2）；嵌套组件的 hook 更深，
      // 它们的顺序不受这个提前 return 影响。
      if (!/^ {6}\S/.test(lines[line])) continue
      if (/React\.use[A-Z]/.test(lines[line])) later.push(`${line + 1}: ${lines[line].trim().slice(0, 80)}`)
    }
    assert.deepEqual(later, [], `${name}: hook after the early return — React #310 blanks the panel. Move it above.\n` + later.join('\n'))
  })
}
