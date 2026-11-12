// Only lib/memu.js is routed here (see tests/memu-resident-route.test.mjs), and
// only `spawn` is intercepted: the test injects a fake child that speaks the
// resident worker protocol. Everything else, and every other importer in the
// process, still gets the real child_process.
import real from 'node:child_process'

export * from 'node:child_process'

export const spawn = (...args) => {
  const spy = globalThis.__dshMemuSpawnSpy
  return typeof spy === 'function' ? spy(...args) : real.spawn(...args)
}

export default { ...real, spawn }
