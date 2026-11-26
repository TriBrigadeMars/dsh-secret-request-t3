import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import TimerService from '@deepseek-ai/cordis-plugin-timer'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SessionStore from '@deepseek-ai/dsh-session'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { REDACTION } from '../dist/redact.js'
import * as plugin from '../dist/index.js'
import { assertNoDecodedVariant } from './decoded-strings.mjs'

const owner = { principal: { kind: 'owner' }, interactions: 'answer' }
const BLOCKED = 'Blocked: this tool result would disclose a requested secret.'

/**
 * Fresh throwaway value per run: random hex plus URL-encodable characters so
 * every tracked encoding is distinct. Never a real-looking credential.
 */
const freshValue = (tag) => `${tag}_` + randomBytes(10).toString('hex') + '/+=&?'

/**
 * Every encoding the redactor is expected to make unmatchable. The JSON-escaped
 * form covers the shape persistence writes for `"` and `\`; the per-line and
 * truncation-prefix forms cover what a line-oriented tool (`read`) persists.
 */
const variantsOf = (value) => {
  const bytes = Buffer.from(value)
  const shape = []
  if (value.includes('\n')) {
    for (const raw of value.split('\n')) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      if (line.length < 8) continue
      shape.push(line, JSON.stringify(line).slice(1, -1))
    }
  }
  if (value.length > 2000) shape.push(value.slice(0, 2000))
  return [...new Set([
    value,
    JSON.stringify(value).slice(1, -1),
    bytes.toString('base64'),
    bytes.toString('base64url'),
    encodeURIComponent(value),
    encodeURI(value),
    ...shape,
  ])]
}

/** Every regular file under `directory`; the gate must see every byte on disk. */
const walk = async (directory) => {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...(await walk(path)))
    else if (entry.isFile()) found.push(path)
  }
  return found
}

/**
 * Harness for a tool call reaching the real post-execute waterfall. `realFs`
 * mounts the local file system seam and the stock `read` tool; `persistence`
 * mounts `SessionStore` plus the real JSONL backend.
 */
async function harness(t, { realFs = false, persistence = false } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-block-ws-'))
  const credentialRoot = await mkdtemp(join(tmpdir(), 'dsh-block-cred-'))
  const root = await mkdtemp(join(tmpdir(), 'dsh-block-sessions-'))
  const sessionId = `block-${randomBytes(6).toString('hex')}`
  const ctx = new Context()
  t.after(async () => {
    await ctx.fiber.dispose()
    await Promise.all(
      [workspace, credentialRoot, root].map((directory) => rm(directory, { recursive: true, force: true }))
    )
  })

  await ctx.plugin(TimerService)
  if (realFs) {
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    ctx.provide('workingDirectory', { ensure: async () => workspace })
  }
  await ctx.plugin(LocalCredentialProvider, { path: join(credentialRoot, 'credentials.yaml'), watch: false })
  await ctx.plugin(Connection)
  await ctx.plugin(Projections)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(SessionStore)
  // Plaintext JSONL so the on-disk assertion cannot pass vacuously.
  if (persistence) await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  if (realFs) await ctx.plugin(ToolFs, { read: true, readImage: false, write: false, edit: false, applyPatch: false })

  const session = ctx.sessions.create(sessionId)
  const agent = { session }
  ctx.provide('agents', { get: (id) => (id === sessionId ? agent : undefined) })
  await ctx.plugin(plugin)
  // A live writer is normally opened by the agent loop; this harness executes
  // tools directly, so claim the session here and let `session/event` route.
  if (persistence) await ctx.sessionPersistence.create(session.header)

  const handler = ctx.connection.createSharedFetchHandler('/api')
  const rpc = async (endpoint, payload = {}) => {
    const method = `dungsil-secrets/${endpoint}`
    const response = await handler.fetch(
      new Request(`http://localhost/api/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'block-on-leak', method, payload }),
      }),
      owner
    )
    assert.equal(response.status, 200)
    return (await response.json()).result
  }
  const run = (calls, step = 1) =>
    ctx.tools.execute({
      calls,
      agent,
      signal: new AbortController().signal,
      log: { turn: 1, step },
    })
  const next = async () => {
    for (let i = 0; i < 400; i++) {
      const response = await rpc('pending')
      if (response.value.length) return response.value[0]
      await delay(5)
    }
    assert.fail('no private input request appeared')
  }

  /** Open one delivery request, answer it, and return its saved value payload. */
  const deliver = async (request, value, step = 1) => {
    await rpc('pending')
    const running = run(
      [
        {
          type: 'tool-call',
          id: `request-${randomBytes(4).toString('hex')}`,
          name: 'request_secret',
          arguments: JSON.stringify(request),
        },
      ],
      step
    )
    const pending = await next()
    assert.deepEqual(await rpc('answer', { id: pending.id, action: 'save', value }), { ok: true, value: null })
    const result = (await running).results[0].result
    assert.equal(result.isError, false, `delivery failed: ${JSON.stringify(result.error)}`)
    assert.equal(result.value.status, 'saved')
    return result.value
  }

  /** Every parsed `tool/result` event in the plaintext JSONL log. */
  const durableToolResults = async () => {
    await ctx.sessions.flush(agent.session)
    const events = []
    for (const file of await walk(root)) {
      if (!file.endsWith('.jsonl')) continue
      const text = await readFile(file, 'utf8')
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        const event = JSON.parse(line)
        if (event?.type === 'tool/result') events.push(event)
      }
    }
    assert.ok(events.length > 0, 'no tool/result event reached the session log')
    return events
  }

  /**
   * Assert no variant appears on disk, both as raw bytes (the original
   * assertion) and, for every JSONL line, in every decoded string. Raw bytes
   * cannot see a JSON-escaped, split, or truncated value; decoding is what
   * catches those.
   */
  const assertAbsentOnDisk = async (value) => {
    await ctx.sessions.flush(agent.session)
    const files = await walk(root)
    assert.ok(files.length > 0, 'the session log was never materialized')
    const variants = variantsOf(value)
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      for (const variant of variants) assert.ok(!text.includes(variant), `${file} leaked a secret variant`)
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const text = await readFile(file, 'utf8')
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        assertNoDecodedVariant(JSON.parse(line), variants, file)
      }
    }
  }

  return { ctx, agent, session, rpc, run, deliver, assertAbsentOnDisk, durableToolResults, root }
}

await test('F1: the stock read tool returning a delivered value in meta is blocked and never persisted', async (t) => {
  const h = await harness(t, { realFs: true, persistence: true })
  assert.equal(typeof h.ctx.tools.get('read'), 'object')

  const value = freshValue('rt5_read')
  const delivered = await h.deliver(
    { label: 'Read gate', reason: 'Block-on-leak read probe.', delivery: 'file', timeoutMs: 60_000 },
    value
  )
  const path = delivered.path

  const result = (
    await h.run([{ type: 'tool-call', id: 'read-1', name: 'read', arguments: JSON.stringify({ file_path: path }) }], 2)
  ).results[0].result

  // The stock read tool put the line text in `meta`; an accept cannot replace
  // it, so the gate must refuse the whole call.
  assert.equal(result.isError, true, 'the gate did not block the read')
  assert.equal(result.error.message, BLOCKED)
  assert.deepEqual(result.content, [{ type: 'text', text: BLOCKED }])
  assert.equal(result.meta, undefined, 'a block must not carry the tool meta')
  assert.ok(!h.session.snapshotEvents().some((event) => event.type === 'tool/result' && event.data.meta !== undefined))

  const durable = [...h.session.snapshotEvents()].reverse().find((event) => event.type === 'tool/result')
  assert.ok(durable, 'tool/result committed')
  assert.equal(durable.data.message.content[0].text, BLOCKED)
  const line = JSON.stringify(sessionFormatCatalog.encodeCurrentEvent(durable))
  for (const variant of variantsOf(value)) assert.ok(!line.includes(variant), 'the durable event leaked a variant')
  await h.assertAbsentOnDisk(value)
})

/** The shapes a line-oriented JSON sink can turn a tracked value into. */
const leakShapes = () => {
  const id = randomBytes(8).toString('hex')
  return [
    ['quote and backslash', `F1q_${id}"\\/+=&?`],
    ['newline split', `F1m_${id}_line1\nF1m_${id}_line2`],
    ['longer than the read line cap', `F1L_${id}_` + 'A'.repeat(2500)],
    ['plain control', freshValue('F1p')],
  ]
}

await test('F1: escaped, split and truncated values in read meta are blocked and never persisted', async (t) => {
  for (const [name, value] of leakShapes()) {
    await t.test(name, async (t) => {
      const h = await harness(t, { realFs: true, persistence: true })
      const delivered = await h.deliver(
        { label: 'Escaping gate', reason: 'Escaped, split, truncated leak probe.', delivery: 'file', timeoutMs: 60_000 },
        value
      )

      const result = (
        await h.run(
          [{ type: 'tool-call', id: 'read-shape', name: 'read', arguments: JSON.stringify({ file_path: delivered.path }) }],
          2
        )
      ).results[0].result

      assert.equal(result.isError, true, 'the gate did not block the read')
      assert.equal(result.error.message, BLOCKED)
      assert.deepEqual(result.content, [{ type: 'text', text: BLOCKED }])
      assert.equal(result.meta, undefined, 'a block must not carry the tool meta')

      // The durable event is JSON: the escaped/split/truncated form only shows
      // up as a decoded string, never as a raw-byte substring.
      const variants = variantsOf(value)
      for (const event of await h.durableToolResults()) {
        assertNoDecodedVariant(event, variants, 'the durable tool/result event')
      }
      await h.assertAbsentOnDisk(value)
    })
  }
})

await test('an echo in plain content is redacted and accepted, not blocked', async (t) => {
  const h = await harness(t)
  const value = freshValue('rt5_echo')
  const delivered = await h.deliver(
    { label: 'Echo probe', reason: 'Plain content echo probe.', delivery: 'secretRef', timeoutMs: 60_000 },
    value
  )

  h.ctx.tools.register(
    defineTool({
      name: 'echo_plain',
      description: 'Test consumer that returns a consumed secret in text content.',
      parameters: { secretRef: { type: 'string', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { raw: { type: 'string', required: true } } },
        render: (_args, output) => [{ type: 'text', text: JSON.stringify(output) }],
      },
      execute: (args, exec) => ({
        raw: h.ctx.get('secretRefs').consume(args.secretRef, exec.agent.session.id),
      }),
    })
  )

  const result = (
    await h.run([{ type: 'tool-call', id: 'echo-1', name: 'echo_plain', arguments: JSON.stringify({ secretRef: delivered.secretRef }) }], 2)
  ).results[0].result

  assert.equal(result.isError, false, 'a scrubbable result must not be blocked')
  const content = JSON.stringify(result.content)
  assert.ok(content.includes(REDACTION), 'the echo was never redacted')
  for (const variant of variantsOf(value)) assert.ok(!content.includes(variant), 'the delivered content leaked a variant')
})

await test('F2: a frozen result whose deferred context holds the value is blocked', async (t) => {
  const h = await harness(t, { persistence: true })
  const value = freshValue('rt5_frozen')
  const delivered = await h.deliver(
    { label: 'Frozen probe', reason: 'Frozen deferred-context probe.', delivery: 'secretRef', timeoutMs: 60_000 },
    value
  )

  // `projectContent` makes the executor materialize and deep-freeze the result
  // (including `additionalContexts`) before post-execute. The in-place scrub
  // throws, so only the verify-and-block gate can stop the value.
  h.ctx.tools.register(
    defineTool({
      name: 'defer_echo',
      description: 'Test consumer that defers a consumed secret as context.',
      parameters: { secretRef: { type: 'string', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
        render: () => [{ type: 'text', text: 'projected' }],
      },
      projectContent: () => [{ type: 'text', text: 'projected' }],
      execute: (args, exec) => {
        const raw = h.ctx.get('secretRefs').consume(args.secretRef, exec.agent.session.id)
        exec.deferContext({
          id: 'deferred-secret',
          role: 'user',
          content: [{ type: 'text', text: raw }],
          source: { kind: 'user' },
        })
        return { ok: true }
      },
    })
  )

  const result = (
    await h.run([{ type: 'tool-call', id: 'defer-1', name: 'defer_echo', arguments: JSON.stringify({ secretRef: delivered.secretRef }) }], 2)
  ).results[0].result

  assert.equal(result.isError, true, 'the gate did not block the frozen result')
  assert.equal(result.error.message, BLOCKED)
  assert.equal(result.meta, undefined)
  assert.equal(result.additionalContexts, undefined, 'a block must drop tool-deferred context')
  assert.ok(!JSON.stringify(result).includes(value))
  await h.assertAbsentOnDisk(value)
})

await test('an unrelated meta payload without a tracked value is not blocked', async (t) => {
  const h = await harness(t)
  const value = freshValue('rt5_unrelated')
  await h.deliver(
    { label: 'Unrelated probe', reason: 'Unrelated meta probe.', delivery: 'secretRef', timeoutMs: 60_000 },
    value
  )

  h.ctx.tools.register(
    defineTool({
      name: 'harmless_meta',
      description: 'Test tool whose presentation meta is unrelated to any secret.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: () => [{ type: 'text', text: 'harmless output' }],
        presentationMeta: () => ({ lines: [{ number: 1, text: 'harmless output' }] }),
      },
      execute: () => ({ text: 'harmless output' }),
    })
  )

  const result = (await h.run([{ type: 'tool-call', id: 'harmless-1', name: 'harmless_meta', arguments: '{}' }], 2))
    .results[0].result
  assert.equal(result.isError, false, 'an unrelated meta payload was blocked')
  assert.deepEqual(result.meta, { lines: [{ number: 1, text: 'harmless output' }] })
})

await test('legacy ref mode scrubs a consumer that echoes the stored credential', async (t) => {
  const h = await harness(t)
  const value = freshValue('rt5_legacy')
  // Legacy mode: the DSH credential provider must report the ref writable.
  t.mock.method(h.ctx.credentials, 'describe', async () => ({ configured: false, writable: true }))

  const delivered = await h.deliver(
    { ref: 'DSH_LEGACY_ECHO_TEST', label: 'Legacy echo', reason: 'Legacy echo probe.', timeout_ms: 60_000 },
    value,
    1
  )
  assert.equal(delivered.ref, 'DSH_LEGACY_ECHO_TEST')

  h.ctx.tools.register(
    defineTool({
      name: 'echo_legacy',
      description: 'Test consumer that reads a stored credential and echoes it.',
      parameters: { ref: { type: 'string', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { raw: { type: 'string', required: true } } },
        render: (_args, output) => [{ type: 'text', text: JSON.stringify(output) }],
      },
      execute: async (args) => ({ raw: (await h.ctx.credentials.resolve(args.ref)).value }),
    })
  )

  const result = (
    await h.run(
      [{ type: 'tool-call', id: 'legacy-echo-1', name: 'echo_legacy', arguments: JSON.stringify({ ref: 'DSH_LEGACY_ECHO_TEST' }) }],
      2
    )
  ).results[0].result

  assert.equal(result.isError, false, 'a scrubbable legacy echo must not be blocked')
  const content = JSON.stringify(result.content)
  assert.ok(content.includes(REDACTION), 'the legacy echo was never redacted')
  for (const variant of variantsOf(value)) assert.ok(!content.includes(variant), 'the legacy echo leaked a variant')
})
