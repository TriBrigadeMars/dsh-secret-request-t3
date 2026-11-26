import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import TimerService from '@deepseek-ai/cordis-plugin-timer'
import * as plugin from '../dist/index.js'
import { REDACTION } from '../dist/redact.js'

const owner = { principal: { kind: 'owner' }, interactions: 'answer' }
const args = { ref: 'DSH_SECRET_TEST', label: 'Test credential', reason: 'Used by the test DSH provider.' }

async function setup(t, provider, options = {}) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  // Real host timer seam unless a test injects a recording fake.
  if (options.timer) ctx.provide('timer', options.timer)
  else await ctx.plugin(TimerService)
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
  return { ctx, fork, rpc, run, next, path, child, agent }
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
  // Windows cannot express POSIX owner-only bits; the credential provider uses
  // the OS default there, so the 0600 guarantee is asserted on POSIX only.
  if (process.platform !== 'win32') assert.equal((await stat(h.path)).mode & 0o777, 0o600)
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

const exists = async (path) => {
  try {
    await stat(path)
    return true
  } catch (error) {
    assert.equal(error.code, 'ENOENT')
    return false
  }
}

/** Disposal and expiry removals are async; poll briefly instead of assuming a tick. */
const waitGone = async (path, ms = 2000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!(await exists(path))) return true
    await delay(10)
  }
  return !(await exists(path))
}

const registerConsumer = (h, execute, name = 'consume_file', parameters = { path: { type: 'string', required: true } }) => {
  h.ctx.tools.register(
    defineTool({
      name,
      description: 'Test consumer for a delivered secret file.',
      parameters,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { length: { type: 'integer', required: true } },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute,
    })
  )
}

/** Same executor pattern as `run`, for tools the tests register themselves. */
const runTool = async (h, name, input = {}, caller = h.agent) => {
  const batch = await h.ctx.tools.execute({
    calls: [
      {
        type: 'tool-call',
        id: `test-${name}`,
        name,
        arguments: JSON.stringify(input),
      },
    ],
    agent: caller,
    signal: new AbortController().signal,
  })
  assert.equal(batch.results.length, 1)
  assert.equal(batch.results[0].callId, `test-${name}`)
  return batch.results[0].result
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

await test('도구가 deferContext로 전달한 값도 결과 문맥에서 지운다', async (t) => {
  const h = await setup(t)
  await h.rpc('pending')
  const value = freshValue()
  const running = h.run(deliveryArgs())
  const request = await h.next()
  await answerWith(h, request, value)
  await running

  h.ctx.tools.register(
    defineTool({
      name: 'defer_echo',
      description: 'Defers an echoed secret as extra context.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean', required: true } },
        },
        render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
      },
      execute(_args, exec) {
        // A consumer that legitimately held the value can ferry it as context.
        exec.deferContext({ content: [{ type: 'text', text: value }], source: { kind: 'user' } })
        return { ok: true }
      },
    })
  )
  const result = await runTool(h, 'defer_echo', {})
  assert.equal(result.isError, false)
  const contexts = JSON.stringify(result.additionalContexts)
  assert.ok(contexts.includes(REDACTION), 'the deferred text block is replaced')
  assert.ok(!contexts.includes(value), 'the value never reaches the delivered context')
})

await test('다른 post-execute 리스너가 붙인 문맥도 결과로 전달되기 전에 지운다', async (t) => {
  const h = await setup(t)
  await h.rpc('pending')
  const value = freshValue()
  const running = h.run(deliveryArgs())
  const request = await h.next()
  await answerWith(h, request, value)
  await running

  // Registered after the plugin, so its decision reaches the plugin's `next()`.
  h.ctx.on('tools/post-execute', async (_exec, _result, next) => {
    const decision = await next()
    return {
      ...decision,
      additionalContexts: [{ content: [{ type: 'text', text: value }], source: { kind: 'user' } }],
    }
  })
  registerConsumer(h, async () => ({ length: 0 }), 'defer_from_policy', {})
  const result = await runTool(h, 'defer_from_policy', {})
  assert.equal(result.isError, false)
  const contexts = JSON.stringify(result.additionalContexts)
  assert.ok(contexts.includes(REDACTION))
  assert.ok(!contexts.includes(value))
})

await test('도구가 오류 메시지에 값을 되돌려도 결과의 오류 문구를 지운다', async (t) => {
  const h = await setup(t)
  await h.rpc('pending')
  const value = freshValue()
  const running = h.run(deliveryArgs())
  const request = await h.next()
  await answerWith(h, request, value)
  const { secretRef } = (await running).value

  h.ctx.tools.register(
    defineTool({
      name: 'echo_error',
      description: 'Throws with the consumed value in the message.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean', required: true } },
        },
        render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
      },
      execute() {
        const consumed = h.ctx.get('secretRefs').consume(secretRef, 'secret-test-session')
        throw new Error(`provider echoed ${consumed}`)
      },
    })
  )
  const result = await runTool(h, 'echo_error', {})
  assert.equal(result.isError, true)
  assert.ok(result.error.message.includes(REDACTION))
  assert.ok(!result.error.message.includes(value))
  assert.ok(!result.content[0].text.includes(value))
})

await test('file 모드는 비공개 파일 경로만 반환하고 제출한 값을 결과에 남기지 않는다', async (t) => {
  const h = await setup(t)
  await h.rpc('pending')
  const value = freshValue()
  const running = h.run(deliveryArgs({ delivery: 'file' }))
  const request = await h.next()
  assert.equal(request.delivery, 'file')
  const answer = await answerWith(h, request, value)
  const result = await running

  assert.equal(result.isError, false)
  assert.equal(result.value.status, 'saved')
  assert.equal(result.value.delivery, 'file')
  assert.equal(typeof result.value.path, 'string')
  assert.ok(Number.isInteger(result.value.expiresAt))
  assert.ok(result.value.expiresAt > Date.now())
  t.diagnostic(`file delivery atRest=${result.value.atRest} platform=${process.platform}`)
  if (process.platform === 'win32') {
    // ACLs are best effort; report whichever guarantee the host actually met.
    assert.ok(result.value.atRest === 'windows-acl' || result.value.atRest === 'unrestricted')
  } else {
    assert.equal(result.value.atRest, 'posix-0600')
    assert.equal((await stat(result.value.path)).mode & 0o777, 0o600)
    assert.equal((await stat(dirname(result.value.path))).mode & 0o777, 0o700)
  }
  assert.equal(await readFile(result.value.path, 'utf8'), value)
  assert.ok(!JSON.stringify(result).includes(value))
  assert.ok(!result.content[0].text.includes(value))
  assert.ok(!JSON.stringify([request, answer]).includes(value))
  assert.deepEqual((await h.rpc('pending')).value, [])
})

await test('file 모드는 서브에이전트에게 unavailable로 남는다', async (t) => {
  const h = await setup(t)
  await h.rpc('pending')
  const result = await h.run(deliveryArgs({ delivery: 'file' }), undefined, h.child)
  assert.equal(result.isError, false)
  assert.deepEqual(result.value, { status: 'unavailable' })
  assert.deepEqual((await h.rpc('pending')).value, [])
})

await test('파일을 소비한 도구 호출이 성공하면 파일과 디렉터리를 삭제한다', async (t) => {
  const h = await setup(t)
  await h.rpc('pending')
  const value = freshValue()
  const running = h.run(deliveryArgs({ delivery: 'file' }))
  const request = await h.next()
  await answerWith(h, request, value)
  const { path } = (await running).value
  const directory = dirname(path)

  registerConsumer(h, async (args) => ({ length: (await readFile(args.path, 'utf8')).length }))
  const consumed = await runTool(h, 'consume_file', { path })
  assert.equal(consumed.isError, false)
  assert.deepEqual(consumed.value, { length: value.length })
  assert.equal(await exists(path), false)
  assert.equal(await exists(directory), false)
})

await test('파일을 소비한 도구 호출이 실패해도 파일을 삭제한다', async (t) => {
  const h = await setup(t)
  await h.rpc('pending')
  const value = freshValue()
  const running = h.run(deliveryArgs({ delivery: 'file' }))
  const request = await h.next()
  await answerWith(h, request, value)
  const { path } = (await running).value
  const directory = dirname(path)

  registerConsumer(h, async (args) => {
    await readFile(args.path, 'utf8')
    throw new Error('consumer failed')
  })
  const consumed = await runTool(h, 'consume_file', { path })
  assert.equal(consumed.isError, true)
  assert.equal(await exists(path), false)
  assert.equal(await exists(directory), false)
})

await test('경로를 언급하지 않는 도구 호출은 파일을 남겨 둔다', async (t) => {
  const h = await setup(t)
  await h.rpc('pending')
  const value = freshValue()
  const running = h.run(deliveryArgs({ delivery: 'file' }))
  const request = await h.next()
  await answerWith(h, request, value)
  const { path } = (await running).value

  registerConsumer(h, async () => ({ length: 0 }), 'unrelated_read', {})
  const unrelated = await runTool(h, 'unrelated_read', {})
  assert.equal(unrelated.isError, false)
  assert.equal(await exists(path), true)
})

await test('유효 시간이 지나면 소비되지 않은 파일도 삭제한다', async (t) => {
  const h = await setup(t)
  await h.rpc('pending')
  const value = freshValue()
  const running = h.run(deliveryArgs({ delivery: 'file', timeoutMs: 1000 }))
  const request = await h.next()
  await answerWith(h, request, value)
  const { path } = (await running).value
  const directory = dirname(path)

  await delay(1200)
  assert.equal(await waitGone(path), true)
  assert.equal(await waitGone(directory), true)
})

await test('플러그인이 해제되면 전달된 파일을 삭제한다', async (t) => {
  const h = await setup(t)
  await h.rpc('pending')
  const value = freshValue()
  const running = h.run(deliveryArgs({ delivery: 'file' }))
  const request = await h.next()
  await answerWith(h, request, value)
  const { path } = (await running).value
  const directory = dirname(path)

  await h.ctx.fiber.dispose()
  assert.equal(await waitGone(path), true)
  assert.equal(await waitGone(directory), true)
})

await test('다른 세션의 소비 호출은 파일을 삭제하지 않는다', async (t) => {
  const h = await setup(t)
  await h.rpc('pending')
  const value = freshValue()
  const running = h.run(deliveryArgs({ delivery: 'file' }))
  const request = await h.next()
  await answerWith(h, request, value)
  const { path } = (await running).value

  registerConsumer(h, async (args) => ({ length: (await readFile(args.path, 'utf8')).length }))
  const foreign = await runTool(h, 'consume_file', { path }, { session: { id: 'another-session', header: {} } })
  assert.equal(foreign.isError, false)
  assert.equal(await exists(path), true)

  const own = await runTool(h, 'consume_file', { path })
  assert.equal(own.isError, false)
  assert.equal(await exists(path), false)
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

await test('만료는 호스트 타이머 서비스로 예약되고 그 콜백이 참조를 죽인다', async (t) => {
  const scheduled = []
  const h = await setup(t, undefined, {
    timer: {
      timeout: (fire, delayMs) => {
        scheduled.push({ fire, delayMs })
        return () => {}
      },
    },
  })
  await h.rpc('pending')
  const running = h.run(deliveryArgs({ timeoutMs: 60_000 }))
  const request = await h.next()
  await answerWith(h, request, freshValue())
  const { secretRef } = (await running).value
  // One schedule, through the host seam, for the advertised TTL (mint happens
  // after the user answers, so the remaining budget is slightly under 60s).
  assert.equal(scheduled.length, 1)
  assert.ok(scheduled[0].delayMs > 55_000 && scheduled[0].delayMs <= 60_000)
  const broker = h.ctx.get('secretRefs')
  const value = broker.consume(secretRef, 'secret-test-session')
  assert.ok(value.startsWith('ts_'))
  scheduled[0].fire()
  assert.throws(
    () => broker.consume(secretRef, 'secret-test-session'),
    (error) => error.code === 'consumed'
  )
})

await test('파일 삭제도 같은 호스트 타이머 서비스로 예약된다', async (t) => {
  const scheduled = []
  const h = await setup(t, undefined, {
    timer: {
      timeout: (fire, delayMs) => {
        scheduled.push({ fire, delayMs })
        return () => {}
      },
    },
  })
  await h.rpc('pending')
  const running = h.run(deliveryArgs({ delivery: 'file', timeoutMs: 60_000 }))
  const request = await h.next()
  await answerWith(h, request, freshValue())
  const result = (await running).value
  assert.equal(result.delivery, 'file')
  assert.equal(scheduled.length, 1)
  assert.ok(scheduled[0].delayMs > 55_000 && scheduled[0].delayMs <= 60_000)
  scheduled[0].fire()
  for (let i = 0; i < 100; i++) {
    try {
      await stat(result.path)
      await delay(10)
    } catch {
      return
    }
  }
  assert.fail('the expiry callback did not delete the delivered file')
})
