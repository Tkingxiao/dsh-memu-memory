const stubs = new URL('./stubs/', import.meta.url)
const map = {
  '@deepseek-ai/dsh-tools': new URL('dsh-tools.js', stubs),
  '@deepseek-ai/dsh-llm': new URL('dsh-llm.js', stubs),
  '@deepseek-ai/dsh-session': new URL('dsh-session.js', stubs),
}

export async function resolve(specifier, context, next) {
  const hit = map[specifier]
  if (hit) return { url: hit.href, shortCircuit: true }
  return next(specifier, context)
}
