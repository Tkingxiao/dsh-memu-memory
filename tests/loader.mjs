const stubs = new URL('./stubs/', import.meta.url)
const map = {
  '@deepseek-ai/dsh-tools': new URL('dsh-tools.js', stubs),
  '@deepseek-ai/dsh-llm': new URL('dsh-llm.js', stubs),
  '@deepseek-ai/dsh-session': new URL('dsh-session.js', stubs),
  // 外部追加恢复（consolidation-snapshot.js 的冷日志交叉核对）动态 import 的宿主 peer。
  '@deepseek-ai/dsh-session-query': new URL('dsh-session-query.js', stubs),
  // 整理 fork 自定义模型 route（lib/fork-model.js）动态 import 的宿主 peer：测试进程
  // 装不上真包，桩只提供可构造的 PiAiAdapter 让生产接线走通成功路径。
  '@deepseek-ai/dsh-llm-pi-ai': new URL('dsh-llm-pi-ai.js', stubs),
}

export async function resolve(specifier, context, next) {
  const hit = map[specifier]
  if (hit) return { url: hit.href, shortCircuit: true }
  return next(specifier, context)
}
