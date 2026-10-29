import test from 'node:test'
import assert from 'node:assert/strict'
let api
let snapshots = 0
const React = {
  createElement: (type, props, ...children) => typeof type === 'function' ? type({ ...props, children }) : { type, props, children },
  Fragment: Symbol('fragment'),
  useState: value => [typeof value === 'function' ? value() : value, () => {}],
  useMemo: fn => fn(), useCallback: fn => fn, useEffect: () => {}, useRef: value => ({ current: value }),
  useSyncExternalStore: (_subscribe, snapshot) => {
    const first = snapshot()
    assert.equal(snapshot(), first, 'a missing host store must return a stable snapshot')
    snapshots++
    return first
  },
}
globalThis.window = { __ModuleLoader__: { load: spec => { api = spec.factory(name => name === 'react' ? React : { createRoot: () => ({ render() {}, unmount() {} }) }) } } }
globalThis.document = { createElement: () => ({ remove() {} }), head: { appendChild() {} } }
await import('../lib/client.js')
test('standalone sidebar without a host session store does not trigger an external-store render loop', () => {
  assert.doesNotThrow(() => api.mountStandalone({}, { sessionId: 'preview' }))
  assert.equal(snapshots, 1)
})
