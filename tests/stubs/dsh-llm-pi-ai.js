// dsh-llm-pi-ai 的测试桩：整理 fork 自定义模型 route（lib/fork-model.js）在测试进程里
// 拉不到宿主包，loader（tests/loader.mjs）把该 peer 依赖映射到这里。只保证「PiAiAdapter
// 是可构造的类、构造 options 会被记录」——构造/探测/注册的真实逻辑由 fork-model.test.mjs
// 用注入的 loader stub（mock llm + 注入 PiAiAdapter）逐分支覆盖，这里只让 private.js 的
// 生产接线（默认 loader）在测试里走通成功路径。
export class PiAiAdapter {
  constructor(options) {
    globalThis.__dshMemuLastPiAiAdapterOptions = options
  }
}

export const name = 'llm-pi-ai'
export const inject = ['llm']
