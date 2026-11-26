import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { REDACTION } from '../dist/redact.js'
import * as plugin from '../dist/index.js'
import { assertNoDecodedVariant } from './decoded-strings.mjs'

const owner = { principal: { kind: 'owner' }, interactions: 'answer' }
const sessionId = 'redaction-e2e'

/**
 * Fresh throwaway value per run: random bytes plus URL-encodable characters so
 * the raw, base64, base64url and percent-encoded forms are all distinct. It is
 * generated in memory and never written to a fixture.
 */
const freshValue = () => 'ts_' + randomBytes(12).toString('hex') + '/+=&? '

const variantsOf = (value) => [
  value,
  JSON.stringify(value).slice(1, -1),
  Buffer.from(value).toString('base64'),
  Buffer.from(value).toString('base64url'),
  encodeURIComponent(value),
  encodeURI(value),
]

/** Helpers to write scripted responses tersely. */
const textResponse = (text) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  ...Array.from(text, (char) => ({ type: 'text-delta', index: 0, text: char })),
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
  { type: 'finish', reason: { kind: 'stop' } },
]

const toolCallResponse = (callId, name, args) => {
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsJson.slice(0, 5) },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsJson.slice(5) },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/**
 * Minimal scripted adapter copied from the dsh reference
 * `packages/core/agent-loop/tests/mock-adapter.ts` (`LlmAdapter` subclass,
 * script entries, recorded requests). Test code keeps the upstream shape.
 */
class MockAdapter extends LlmAdapter {
  requests = []

  constructor(script) {
    super()
    this.script = script
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(options) {
    this.requests.push(options)
    const entry = this.script.shift()
    if (!entry) throw new Error('MockAdapter: script exhausted')
    const chunks = typeof entry === 'function' ? entry(options) : entry
    for (const chunk of chunks) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

/** Parse the one-use reference out of the previous tool result the model saw. */
const findSecretRef = (options) => {
  for (const message of options.messages) {
    for (const block of message.content ?? []) {
      if (block.type !== 'text') continue
      let parsed
      try {
        parsed = JSON.parse(block.text)
      } catch {
        continue
      }
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.secretRef === 'string') {
        return parsed.secretRef
      }
    }
  }
  throw new Error('the conversation did not contain a secretRef tool result')
}

const waitForIdle = (ctx, agent) =>
  new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })

const waitFor = async (probe, message, ms = 10_000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined) return value
    await delay(10)
  }
  assert.fail(message)
}

/** Recursively list regular files; the gate must see every byte on disk. */
const walk = async (directory) => {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...(await walk(path)))
    else if (entry.isFile()) found.push(path)
  }
  return found
}

await test('세션 로그와 모델 요청 어디에도 해석된 비밀값이 남지 않는다', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-secret-redaction-'))
  const credentialsRoot = await mkdtemp(join(tmpdir(), 'dsh-secret-redaction-cred-'))
  const ctx = new Context()
  t.after(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    await rm(credentialsRoot, { recursive: true, force: true })
  })

  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  // Plaintext JSONL keeps the on-disk assertion honest instead of vacuously
  // passing on compressed bytes.
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await ctx.plugin(LocalCredentialProvider, {
    path: join(credentialsRoot, 'credentials.yaml'),
    watch: false,
  })
  await ctx.plugin(Connection)
  await ctx.plugin(plugin)

  // Sibling tool: consumes the one-use reference and echoes every encoding back
  // to the loop, which is exactly what the redactor must survive.
  ctx.tools.register(
    defineTool({
      name: 'echo_secret',
      description: 'Test consumer that echoes a resolved secret in three encodings.',
      parameters: { secretRef: { type: 'string', required: true } },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            raw: { type: 'string', required: true },
            b64: { type: 'string', required: true },
            url: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: (args, exec) => {
        const broker = ctx.get('secretRefs')
        const raw = broker.consume(args.secretRef, exec.agent.session.id)
        return { raw, b64: Buffer.from(raw).toString('base64'), url: encodeURIComponent(raw) }
      },
    })
  )

  const adapter = new MockAdapter([
    toolCallResponse('request-call', 'request_secret', {
      label: 'One-use redaction token',
      reason: 'Used by the redaction session-log test exactly once.',
      delivery: 'secretRef',
      timeoutMs: 60_000,
    }),
    (options) => toolCallResponse('echo-call', 'echo_secret', { secretRef: findSecretRef(options) }),
    textResponse('done'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)

  await ctx.plugin(AgentLoop, {
    agents: [{ id: 'main', sessionId, provider: 'mock', model: 'mock' }],
  })
  const agent = await waitFor(() => ctx.agents.get(sessionId), 'the configured agent was never published')

  const handler = ctx.connection.createSharedFetchHandler('/api')
  const rpc = async (endpoint, payload = {}) => {
    const method = `dungsil-secrets/${endpoint}`
    const response = await handler.fetch(
      new Request(`http://localhost/api/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'redaction-e2e', method, payload }),
      }),
      owner
    )
    assert.equal(response.status, 200)
    return (await response.json()).result
  }

  const delivered = []
  ctx.on('tools/result', (exec, result) => {
    if (exec.name === 'echo_secret') delivered.push(result)
  })

  const value = freshValue()
  // Establish owner presence before the tool call (the plugin requires a
  // recently seen client), then let the model open the request.
  await rpc('pending')
  const idle = waitForIdle(ctx, agent)
  agent.followup(
    createUserMessage({
      content: [{ type: 'text', text: 'Resolve the token and echo it back.' }],
      source: { kind: 'user' },
    })
  )

  const request = await waitFor(async () => {
    const response = await rpc('pending')
    return response.value.length > 0 ? response.value[0] : undefined
  }, 'no private input request appeared')
  assert.equal(request.delivery, 'secretRef')
  const answered = await rpc('answer', { id: request.id, action: 'save', value })
  assert.deepEqual(answered, { ok: true, value: null })
  await idle
  await ctx.sessions.flush(agent.session)

  // (a) Every byte under the persistence root stays free of every variant.
  const paths = await walk(root)
  assert.ok(paths.length > 0, 'the session log was never materialized')
  const variants = variantsOf(value)
  const onDisk = []
  for (const path of paths) {
    const text = await readFile(path, 'utf8')
    onDisk.push(text)
    for (const variant of variants) {
      assert.ok(!text.includes(variant), `${path} leaked a secret variant`)
    }
    // The log is JSON, so `"` and `\` are escaped in the bytes. A decoded walk
    // of every string leaf is what catches an escaped echo.
    if (path.endsWith('.jsonl')) {
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        assertNoDecodedVariant(JSON.parse(line), variants, path)
      }
    }
  }

  // (b) The scrub ran: the marker is in the log, through the read handle and bytes.
  const handle = await ctx.sessionPersistence.open(sessionId, 'read')
  let stored
  try {
    stored = await handle.read()
  } finally {
    await handle.close()
  }
  assert.ok(JSON.stringify(stored.events).includes(REDACTION), 'the stored events never saw the marker')
  assert.ok(onDisk.join('\n').includes(REDACTION), 'the on-disk log never saw the marker')

  // (c) The model never saw a variant in any request it was handed.
  assert.ok(adapter.requests.length >= 3)
  for (const seen of adapter.requests) {
    const serialized = JSON.stringify(seen)
    for (const variant of variants) {
      assert.ok(!serialized.includes(variant), 'a model request leaked a secret variant')
    }
  }

  // (d) The final echo result, as delivered to the loop, is redacted.
  assert.equal(delivered.length, 1)
  const echo = JSON.stringify(delivered[0].content)
  assert.ok(echo.includes(REDACTION), 'the echo result was never redacted')
  for (const variant of variants) assert.ok(!echo.includes(variant), 'the echo result leaked a secret variant')
})
