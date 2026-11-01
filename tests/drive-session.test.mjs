import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

// drive-session 之前一条测试都没有，于是它的 RPC envelope 一直是错的：网关按**参数名**包参数，
// 单参数 remote 必须是 `{ args: { request: … } }`，直接铺请求字段会在到达宿主前被拒
// （gateway/arguments-invalid: missing "request"）。第一次真机对接才暴露。这里钉住形状。
const mod = await import('../scripts/drive-session.mjs')

test('the prompt envelope names the remote parameter, as the gateway carrier requires', () => {
  const request = {
    requestId: 'memu-eval-x-001-ab',
    sessionId: 'session-1',
    mode: 'queue',
    content: [{ type: 'text', text: '你还记得林眠的相机吗？' }],
    clientTimeZone: 'Asia/Shanghai',
  }
  const envelope = mod.buildPromptEnvelope(request, 'rpc-1')
  assert.equal(envelope.type, 'client-request')
  assert.equal(envelope.rpcId, 'rpc-1')
  assert.equal(envelope.method, 'session/prompt')
  assert.deepEqual(envelope.payload, { args: { request } })
  // 铺平发送会被宿主拒绝：这条断言就是那个 bug 的回归。
  assert.notDeepEqual(envelope.payload.args, request)
  assert.equal(envelope.payload.args.request, request)

  const auto = mod.buildPromptEnvelope(request)
  assert.match(auto.rpcId, /^[0-9a-f-]{36}$/, 'each send needs its own correlation id')
  assert.notEqual(auto.rpcId, mod.buildPromptEnvelope(request).rpcId)
})

test('request builders give every turn one identity and cycle the prompts', () => {
  const requests = mod.buildRequests({
    sessionId: 'session-9',
    turns: 5,
    prompts: ['第一条', '第二条'],
    clientTimeZone: 'UTC',
  })
  assert.equal(requests.length, 5)
  assert.deepEqual(requests.map((item) => item.turn), [1, 2, 3, 4, 5])
  assert.deepEqual(requests.map((item) => item.request.content[0].text),
    ['第一条', '第二条', '第一条', '第二条', '第一条'])
  assert.equal(new Set(requests.map((item) => item.requestId)).size, 5, 'requestIds must never repeat')
  for (const item of requests) {
    assert.equal(item.request.sessionId, 'session-9')
    assert.equal(item.request.mode, 'queue')
    assert.equal(item.request.clientTimeZone, 'UTC')
    // 日志匹配用的 id 和发出去的 id 必须同源，否则轮次永远判不出完成。
    assert.equal(item.requestId, item.request.requestId)
  }
})

test('completion is read from the transcript, not from an accepted response', () => {
  const requestId = 'memu-eval-run-001-ab'
  const admitted = [{ type: 'agent/inbox/spliced', data: { inserted: [{ source: { rpcId: requestId } }] } }]
  assert.equal(mod.promptAdmitted(admitted, requestId), true, 'a spliced inbox item proves the host took the prompt')
  assert.equal(mod.promptAdmitted([], requestId), false)
  assert.equal(mod.promptAdmitted(admitted, 'other-id'), false)

  const events = [
    ...admitted,
    { type: 'turn/start', data: { turn: 7 } },
    { type: 'user/message', data: { source: { rpcId: requestId } } },
    { type: 'step/end', data: {} },
  ]
  const claim = mod.promptClaimIndex(events, requestId)
  assert.equal(claim, 2, 'the newest claim for this requestId wins')
  assert.equal(mod.enclosingTurn(events, claim), 7, 'the turn that opened before the claim is the one to wait for')
  // 一条已结束的回合之后再来消息，不属于任何还在跑的回合。
  const after = [...events, { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    { type: 'user/message', data: { source: { rpcId: 'next-id' } } }]
  assert.equal(mod.promptClaimIndex(after, 'next-id'), after.length - 1)
  assert.equal(mod.enclosingTurn(after, after.length - 1), null, 'turn/end closes the window')
  assert.equal(mod.enclosingTurn(events, 0), null, 'nothing encloses a claim with no turn/start before it')
})

test('path segments are encoded so any session id maps to one directory', () => {
  assert.equal(mod.encodeSegment('plain-Name_1.2'), 'plain-Name_1.2')
  assert.equal(mod.encodeSegment('a/b'), 'a~002Fb')
  assert.equal(mod.encodeSegment('a~b'), 'a~007Eb')
  assert.notEqual(mod.encodeSegment('a/b'), mod.encodeSegment('a_b'), 'separators must not collide with names')
})

test('prompt text is read from every accepted text-file shape', () => {
  assert.equal(mod.textOfPromptItem('  一条  ', 0), '一条')
  assert.equal(mod.textOfPromptItem({ text: 'A' }, 0), 'A')
  assert.equal(mod.textOfPromptItem({ prompt: 'B' }, 1), 'B')
  assert.equal(mod.textOfPromptItem({ content: [{ type: 'text', text: 'C' }, { type: 'text', text: 'D' }] }, 2), 'C\nD')
  assert.throws(() => mod.textOfPromptItem(42, 3), /not a string or object/)
})

// 传输层连错两次（参数没按名字包、返回体引用了不存在的变量），因为一直没有东西真的跑过
// sendPrompt。用一个 loopback 假网关把它钉住：请求形状、cookie 透传、相关 id 校验、401 提示。
async function fakeGateway(handler) {
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => handler({ raw, body: JSON.parse(raw), req, res }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('sendPrompt sends the named-parameter envelope the gateway accepts', async () => {
  const seen = []
  const gateway = await fakeGateway(({ body, req, res }) => {
    seen.push({ body, cookie: req.headers.cookie })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { accepted: true } } }))
  })
  const request = { requestId: 'r-1', sessionId: 'session-1', mode: 'queue', content: [{ type: 'text', text: '第一条' }] }
  try {
    const out = await mod.sendPrompt({ base: gateway.base, request, timeoutMs: 5000, cookie: 'dsh-auth=abc' })
    assert.equal(typeof out.rpcId, 'string', 'the correlation id comes back from the envelope that was actually sent')
    assert.equal(seen[0].body.type, 'client-request')
    assert.equal(seen[0].body.method, 'session/prompt')
    assert.deepEqual(seen[0].body.payload.args.request, request, 'the remote parameter must be named "request"')
    assert.equal(seen[0].cookie, 'dsh-auth=abc', 'the host session cookie is forwarded')
  } finally {
    await gateway.close()
  }
})

test('sendPrompt refuses an unrelated response and says what a 401 needs', async () => {
  const mismatched = await fakeGateway(({ res }) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'server-response', rpcId: 'not-the-same', result: { ok: true, value: { accepted: true } } }))
  })
  await assert.rejects(
    mod.sendPrompt({ base: mismatched.base, request: { requestId: 'r' }, timeoutMs: 5000 }),
    /matching Connection RPC envelope/,
  )
  await mismatched.close()

  const unauthorized = await fakeGateway(({ res }) => { res.writeHead(401); res.end('unauthorized') })
  await assert.rejects(
    mod.sendPrompt({ base: unauthorized.base, request: { requestId: 'r' }, timeoutMs: 5000 }),
    /--cookie-file/,
    'a 401 has to name the fix, not just the status'
  )
  await unauthorized.close()

  const rejected = await fakeGateway(({ body, res }) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: { code: 'gateway/arguments-invalid', message: 'missing "request"' } } }))
  })
  await assert.rejects(
    mod.sendPrompt({ base: rejected.base, request: { requestId: 'r' }, timeoutMs: 5000 }),
    /gateway\/arguments-invalid/,
  )
  await rejected.close()
})
