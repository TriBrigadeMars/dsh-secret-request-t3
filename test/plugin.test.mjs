import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../dist/index.js'

const owner = { principal: { kind: 'owner' }, interactions: 'answer' }
const args = { ref: 'DSH_SECRET_TEST', label: 'Test credential', reason: 'Used by the test DSH provider.' }

async function setup(t, provider) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const directory = await mkdtemp(join(tmpdir(), 'dsh-secret-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'credentials.yaml')
  await ctx.plugin(LocalCredentialProvider, { path, watch: false })
  await ctx.plugin(Connection)
  if (provider) {
    for (const [method, implementation] of Object.entries(provider))
      t.mock.method(ctx.credentials, method, implementation)
  }
  await ctx.plugin(Projections)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const agent = { session: { id: 'secret-test-session', header: { parentSession: 'fork-source', isSeeded: true } } }
  const child = { session: { id: 'child', header: { origin: 'subagent' } } }
  ctx.provide('agents', { get: (id) => [agent, child].find((entry) => entry.session.id === id) })
  const fork = ctx.plugin(plugin)
  await fork
  const handler = ctx.connection.createSharedFetchHandler('/api')
  const rpc = async (endpoint, payload = {}, peer = owner) => {
    const method = `dungsil-secrets/${endpoint}`
    const response = await handler.fetch(
      new Request(`http://localhost/api/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'fixture', method, payload }),
      }),
      peer
    )
    if (response.status === 403) return { ok: false, error: { code: 'forbidden' } }
    assert.equal(response.status, 200)
    return (await response.json()).result
  }
  const run = async (input = args, signal = new AbortController().signal, caller = agent) => {
    const batch = await ctx.tools.execute({
      calls: [
        {
          type: 'tool-call',
          id: 'secret-test-call',
          name: 'request_secret',
          arguments: JSON.stringify(input),
        },
      ],
      agent: caller,
      signal,
    })
    assert.equal(batch.results.length, 1)
    assert.equal(batch.results[0].callId, 'secret-test-call')
    return batch.results[0].result
  }
  const next = async () => {
    for (let i = 0; i < 100; i++) {
      const response = await rpc('pending')
      if (response.value.length) return response.value[0]
      await delay(5)
    }
    assert.fail('No private input request appeared')
  }
  return { ctx, fork, rpc, run, next, path, child }
}

await test('도구 런타임을 통해 입력을 비공개로 정확히 저장하고 참조와 상태만 반환한다', async (t) => {
  const h = await setup(t)
  assert.equal((await h.run()).value.status, 'unavailable')
  await h.rpc('pending')
  const seen = []
  h.ctx.on('tools/result', (_exec, result) => {
    seen.push(result)
  })
  const running = h.run()
  const request = await h.next()
  assert.equal(request.configured, false)
  const secret = '  synthetic-$value-한글-"\\  '
  const answer = await h.rpc('answer', { id: request.id, action: 'save', value: secret })
  assert.deepEqual(answer, { ok: true, value: null })
  const result = await running
  assert.equal(result.isError, false)
  assert.deepEqual(result.value, { status: 'saved', ref: args.ref })
  assert.deepEqual(JSON.parse(result.content[0].text), result.value)
  assert.equal((await h.ctx.credentials.resolve(credentialRef(args.ref))).value, secret)
  assert.equal((await stat(h.path)).mode & 0o777, 0o600)
  assert.ok(!JSON.stringify([request, answer, result, seen]).includes('synthetic-$value-'))
  assert.deepEqual((await h.rpc('pending')).value, [])
  assert.equal((await h.rpc('answer', { id: request.id, action: 'save', value: 'overwrite' })).ok, false)

  const declined = h.run()
  const replacement = await h.next()
  assert.equal(replacement.configured, true)
  await h.rpc('answer', { id: replacement.id, action: 'decline' })
  assert.equal((await declined).value.status, 'declined')
  assert.equal((await h.ctx.credentials.resolve(credentialRef(args.ref))).value, secret)
  await h.fork.dispose()
  assert.equal(h.ctx.tools.get('request_secret'), undefined)
  // Reloading does not remove stored credentials or duplicate tool registrations.
  await h.ctx.plugin(plugin)
  assert.ok(h.ctx.tools.get('request_secret'))
  assert.equal((await h.ctx.credentials.resolve(credentialRef(args.ref))).value, secret)
})

await test('권한 없는 응답, 형식이 잘못된 응답, 늦은 응답을 거부하며 취소와 타임아웃은 절대 기록하지 않는다', async (t) => {
  const h = await setup(t)
  for (const peer of [
    { principal: { kind: 'session', sessionId: 'secret-test-session' }, interactions: 'answer' },
    { principal: { kind: 'observer' }, interactions: 'none' },
  ]) {
    assert.equal((await h.rpc('pending', {}, peer)).error.code, 'forbidden')
  }
  await h.rpc('pending')
  assert.equal((await h.run(args, undefined, { session: { id: 'child' } })).value.status, 'unavailable')
  assert.equal((await h.run(args, undefined, h.child)).value.status, 'unavailable')
  assert.equal((await h.run({ ...args, ref: '../invalid' })).isError, true)
  assert.equal((await h.run({ ...args, timeout_ms: 999 })).isError, true)
  const abort = new AbortController()
  const cancelled = h.run(args, abort.signal)
  const request = await h.next()
  for (const value of ['', 23, 'x'.repeat(65_537)]) {
    assert.equal((await h.rpc('answer', { id: request.id, action: 'save', value })).ok, false)
  }
  assert.equal((await h.run()).isError, true)
  abort.abort()
  assert.equal((await cancelled).isError, true)
  assert.deepEqual((await h.rpc('pending')).value, [])
  assert.equal((await h.rpc('answer', { id: request.id, action: 'save', value: 'too-late' })).ok, false)
  const timed = h.run({ ...args, timeout_ms: 1000 })
  await h.next()
  // Keep a real timer alive: the plugin's deadline intentionally does not hold Node open.
  await delay(1100)
  assert.equal((await timed).value.status, 'timed_out')
  assert.equal(await h.ctx.credentials.resolve(credentialRef(args.ref)), undefined)
  const unloaded = h.run()
  await h.next()
  await h.fork.dispose()
  assert.equal((await unloaded).value.status, 'cancelled')
})

await test('저장 실패를 정제하고 쓰기 도중 취소를 포함해 동시 저장을 하나만 허용한다', async (t) => {
  const secret = 'synthetic-provider-error-secret'
  let release
  let stored
  let fail = true
  const h = await setup(t, {
    describe: async () => ({ configured: false, writable: true }),
    set: async (_ref, value) => {
      if (fail) throw new Error(`Provider echoed ${value}`)
      await new Promise((resolve) => {
        release = resolve
      })
      stored = value
    },
  })
  await h.rpc('pending')
  const abort = new AbortController()
  const running = h.run(args, abort.signal)
  const request = await h.next()
  const rejected = await h.rpc('answer', { id: request.id, action: 'save', value: secret })
  assert.equal(rejected.error.code, 'save_failed')
  assert.ok(!JSON.stringify(rejected).includes(secret))
  fail = false
  const first = h.rpc('answer', { id: request.id, action: 'save', value: secret })
  await delay(0)
  const second = await h.rpc('answer', { id: request.id, action: 'save', value: 'wrong-winner' })
  assert.equal(second.error.code, 'closed')
  abort.abort()
  release()
  assert.equal((await first).ok, true)
  const result = await running
  assert.ok(!JSON.stringify(result).includes(secret))
  assert.equal(stored, secret)
  assert.deepEqual((await h.rpc('pending')).value, [])
})

/** Fresh throwaway value per test; never a real-looking credential. */
const freshValue = () => 'ts_' + randomBytes(16).toString('hex')

const deliveryArgs = (value = {}) => ({
  label: 'One-use test token',
  reason: 'Used by the test consumer exactly once.',
  delivery: 'secretRef',
  timeoutMs: 60_000,
  ...value,
})

const answerWith = async (h, request, value) => {
  const answer = await h.rpc('answer', { id: request.id, action: 'save', value })
  assert.deepEqual(answer, { ok: true, value: null })
  return answer
}

await test('secretRef 모드는 일회용 참조만 반환하고 제출한 값을 결과에 남기지 않는다', async (t) => {
  const h = await setup(t)
  await h.rpc('pending')
  const value = freshValue()
  const running = h.run(deliveryArgs())
  const request = await h.next()
  assert.equal(request.delivery, 'secretRef')
  assert.equal(request.configured, false)
  assert.equal(request.ref, undefined)
  assert.ok(request.expiresAt > Date.now())
  const answer = await answerWith(h, request, value)
  const result = await running
  assert.equal(result.isError, false)
  assert.equal(result.value.status, 'saved')
  assert.equal(result.value.delivery, 'secretRef')
  assert.match(result.value.secretRef, /^sr_/)
  assert.ok(Number.isInteger(result.value.expiresAt))
  assert.ok(result.value.expiresAt > Date.now())
  assert.ok(!JSON.stringify(result).includes(value))
  assert.ok(!result.content[0].text.includes(value))
  assert.ok(!JSON.stringify([request, answer]).includes(value))
  assert.deepEqual((await h.rpc('pending')).value, [])
})

await test('발급된 secretRef는 같은 세션에서 정확히 한 번만 값을 돌려준다', async (t) => {
  const h = await setup(t)
  await h.rpc('pending')
  const value = freshValue()
  const running = h.run(deliveryArgs())
  const request = await h.next()
  await answerWith(h, request, value)
  const { secretRef } = (await running).value
  const broker = h.ctx.get('secretRefs')
  assert.equal(broker.consume(secretRef, 'secret-test-session'), value)
  assert.throws(
    () => broker.consume(secretRef, 'secret-test-session'),
    (error) => error.code === 'consumed'
  )
})

await test('file 배달은 아직 구현되지 않았으므로 unavailable로 정직하게 답한다', async (t) => {
  const h = await setup(t)
  await h.rpc('pending')
  const value = freshValue()
  const running = h.run(deliveryArgs({ delivery: 'file' }))
  const request = await h.next()
  assert.equal(request.delivery, 'file')
  await answerWith(h, request, value)
  const result = await running
  assert.equal(result.isError, false)
  assert.deepEqual(result.value, { status: 'unavailable' })
  assert.ok(!JSON.stringify(result).includes(value))
  assert.deepEqual((await h.rpc('pending')).value, [])
})

await test('같은 clientRequestId 재시도는 새로 발급하지 않고 같은 결과를 돌려준다', async (t) => {
  const h = await setup(t)
  await h.rpc('pending')
  const input = deliveryArgs({ clientRequestId: 'idem-delivery-1' })
  const first = h.run(input)
  const request = await h.next()
  await answerWith(h, request, freshValue())
  const firstResult = await first
  assert.equal(firstResult.value.status, 'saved')
  const second = await h.run(input)
  assert.deepEqual(second.value, firstResult.value)
  assert.equal(second.value.secretRef, firstResult.value.secretRef)
  assert.deepEqual((await h.rpc('pending')).value, [])
})

await test('다른 세션은 발급된 secretRef를 소비할 수 없다', async (t) => {
  const h = await setup(t)
  await h.rpc('pending')
  const value = freshValue()
  const running = h.run(deliveryArgs())
  const request = await h.next()
  await answerWith(h, request, value)
  const { secretRef } = (await running).value
  const broker = h.ctx.get('secretRefs')
  assert.throws(
    () => broker.consume(secretRef, 'another-session'),
    (error) => error.code === 'session_mismatch'
  )
  assert.equal(broker.consume(secretRef, 'secret-test-session'), value)
})
