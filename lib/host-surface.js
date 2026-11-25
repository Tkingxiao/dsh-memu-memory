// §13.6 运行时结构指纹。
//
// `docs/host-versions.md` §13.1 的台账每行都带一个结构指纹；这一模块就是那个指纹的
// 运行时对应物——在真机上读一眼 `getState().hostSurface`，就能核对台账那一行是真是假。
//
// 纪律：这里**不做任何判断，也不读宿主版本号**（AGENTS.md §1 规则 1）。每个值都由既有
// 探测函数在真正用到它的时候顺手记一次，缺项显示 `unknown`。宿主差异一律走结构探测，
// 本模块只是把已经发生过的探测结果聚合成一行可核对的文本。
const SURFACES = ['rpcGuard', 'schedule', 'activation', 'coldLog']

const resolved = Object.fromEntries(SURFACES.map((name) => [name, 'unknown']))

/** Record what a probe actually saw. Unknown surface names are ignored on purpose:
 *  a stale call site must not be able to invent a new ledger key. */
export function noteHostSurface(surface, value) {
  if (!SURFACES.includes(surface)) return
  const text = String(value ?? '').trim()
  if (text) resolved[surface] = text
}

export function hostSurface() {
  return { ...resolved }
}

/** One-line form, matching the 指纹 column of the ledger. */
export function hostSurfaceLine() {
  return SURFACES.map((name) => `${name}=${resolved[name]}`).join(' ')
}

export { SURFACES as HOST_SURFACES }
