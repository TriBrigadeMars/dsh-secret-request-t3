import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { parseRpcRequest, rpcResponse } from './vendor/rpc.js'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineTool, type PostToolDecision, type ToolExecutionResult, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  channel,
  endpointPrefix,
  maxSecretLength,
  type Delivery,
  type SecretRequest,
  type SecretStatus,
} from './protocol.js'
import { SecretBroker } from './broker.js'
import { FileDelivery, type AtRest } from './files.js'
import { Redactor } from './redact.js'

/**
 * The host timer service (cordis-plugin-timer) as this plugin uses it. Reached
 * through the unguarded `ctx.get('timer')` accessor because `timer` is not a
 * hard injection: a host without the timer row still runs the tool, and the
 * broker's lazy deadline check keeps expiry correct.
 */
interface TimerSeam {
  timeout?: (callback: () => void, delayMs: number) => unknown
}

export const name = 't3-secret-request'
export const inject = ['tools', 'credentials', 'connection', 'agents']

interface ToolResultValue {
  status: SecretStatus
  ref?: string
  delivery?: Delivery
  secretRef?: string
  path?: string
  expiresAt?: number
  atRest?: AtRest
}

type ResultExtra = Omit<ToolResultValue, 'status'>

/** Deferred context the executor carries from a tool body to the agent loop. */
type AdditionalContexts = NonNullable<ToolExecutionResult['additionalContexts']>

interface Pending {
  view: SecretRequest
  saving?: Promise<void>
  finish: (status: SecretStatus, extra?: ResultExtra) => void
}

interface LegacyArgs {
  label: string
  reason: string
  timeout_ms?: number
}

interface DeliveryArgs {
  label: string
  reason: string
  delivery: Delivery
  url?: string
  placeholder?: string
  timeoutMs?: number
  clientRequestId?: string
}

interface IdempotencyEntry {
  promise: Promise<ToolResultValue>
  result?: ToolResultValue
}

const defaultTimeoutMs = 600_000
const maxDeliveryTimeoutMs = 3_600_000
const idempotencyRetentionMs = 60_000

/** Best-effort JSON for path scraping; never throws on cyclic or exotic values. */
const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

export function apply(ctx: Context) {
  const pending = new Map<string, Pending>()
  const completed = new Map<string, IdempotencyEntry>()
  const broker = new SecretBroker()
  const files = new FileDelivery()
  const redactor = new Redactor()
  const lifetime = new AbortController()
  let lastClientSeen = 0

  ctx.provide('secretRefs', broker)
  ctx.effect(() => () => broker.dispose(), 'request-secret: broker')
  ctx.effect(() => () => redactor.dispose(), 'request-secret: redaction')
  ctx.effect(
    () => async () => {
      await files.disposeAll()
    },
    'request-secret: delivered files'
  )

  ctx.effect(
    () => async () => {
      lifetime.abort()
      await Promise.all([...pending.values()].flatMap((request) => (request.saving ? [request.saving] : [])))
    },
    'request-secret: pending requests'
  )

  // Exit binding for commands that run through the tool executor: this settles
  // on both success and failure, so a delivered file disappears when the call
  // that named its path finishes. `request_secret` is excluded so a file
  // survives the call that created it. The same hook scrubs tracked value
  // variants out of the model-facing text before the result is persisted.
  // Scrubbing is best-effort defence in depth, never a guarantee; a bug in it
  // must not fail the user's call, and it must not skip file cleanup.
  const scrubContexts = (contexts: AdditionalContexts): AdditionalContexts =>
    contexts.map((context) => ({
      ...context,
      content: context.content.map((block) =>
        block.type === 'text' ? { ...block, text: redactor.scrub(block.text) } : block
      ),
    }))

  /**
   * Fixed refusal for a result that still carries a tracked value. The block
   * path builds a fresh result with no `meta`, no `value` and replaced content,
   * so it is the only outcome that drops channels (notably `meta`) this hook
   * cannot rewrite. Feedback is a constant: no part of the value is echoed.
   */
  const blockedResult = (): PostToolDecision => ({
    kind: 'block',
    feedback: [{ type: 'text', text: 'Blocked: this tool result would disclose a requested secret.' }],
  })

  /**
   * Check every post-scrub text channel for a tracked value. `accept` can only
   * replace `content`; `meta`, deferred contexts, and an already-materialized
   * frozen result are outside the decision's control. A match therefore means
   * the value would reach persistence, and the call must be blocked.
   */
  const hasUnscrubbedValue = (result: ToolExecutionResult, decision: PostToolDecision): boolean => {
    const channels = [
      result.meta === undefined ? '' : safeStringify(result.meta),
      safeStringify(decision.kind === 'accept' && decision.content !== undefined ? decision.content : result.content),
      safeStringify(result.additionalContexts ?? []),
      safeStringify(decision.additionalContexts ?? []),
      result.isError ? result.error.message : '',
    ]
    return channels.some((text) => redactor.hasMatch(text, 8))
  }

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    let outcome: PostToolDecision = decision
    try {
      // 1. File cleanup first so a scrubbing failure cannot leave a file behind.
      try {
        if (exec.name !== 'request_secret' && exec.agent) {
          const text = safeStringify(exec.arguments) + safeStringify(result.content)
          await files.removeReferenced(exec.agent.session.id, text)
        }
      } catch {
        // Cleanup must never fail the user's tool call.
      }

      // 2. Replace tracked variants in text blocks.
      try {
        if (decision.kind === 'accept') {
          const blocks = decision.content ?? result.content
          const scrubbed = blocks.map((block) =>
            block.type === 'text' ? { ...block, text: redactor.scrub(block.text) } : block
          )
          const changed = scrubbed.some((block, index) => block !== blocks[index])
          // A value replacement re-renders through the tool definition; do not
          // fight it with a content replacement. `additionalContexts` survives.
          if (changed && !Object.hasOwn(decision, 'value')) {
            outcome = {
              kind: 'accept',
              content: scrubbed,
              ...(decision.additionalContexts === undefined
                ? {}
                : { additionalContexts: decision.additionalContexts }),
            }
          }
        }
      } catch {
        // Redaction is best-effort; the original result is still returned.
      }

      // 3. Scrub deferred context. The executor merges `result.additionalContexts`
      // into the delivered result AFTER this waterfall, so the decision alone
      // cannot replace it: mutate the property in place as a deliberate
      // mitigation of that core merge order. The decision's own contexts are
      // returned scrubbed.
      try {
        if (result.additionalContexts !== undefined) {
          const mutable = result as { additionalContexts?: AdditionalContexts }
          mutable.additionalContexts = scrubContexts(result.additionalContexts)
        }
        if (decision.additionalContexts !== undefined) {
          outcome = { ...outcome, additionalContexts: scrubContexts(decision.additionalContexts) }
        }
      } catch {
        // Best-effort: an immutable result still reaches the loop unmodified.
      }

      // 4. Scrub the live failure message in place. The durable event omits it,
      // but observers and log sinks that see the result object must not receive
      // a value the tool happened to echo in its error.
      try {
        if (result.isError) {
          const mutable = result as { error: { message: string } }
          mutable.error.message = redactor.scrub(mutable.error.message)
        }
      } catch {
        // Best-effort, like every other step here.
      }

      // 5. Verify after scrubbing, then fail closed. `meta` and a frozen
      // `additionalContexts` cannot be rewritten by an accept decision, and the
      // in-place attempts above may have thrown. If a tracked value survives in
      // any channel the only safe outcome is a block, which replaces content and
      // drops both `meta` and tool-deferred contexts before persistence.
      try {
        if (exec.name !== 'request_secret' && hasUnscrubbedValue(result, outcome)) return blockedResult()
      } catch {
        // A verification failure must not degrade into an accepted result.
        return blockedResult()
      }
    } catch {
      // Belt and braces: nothing in this hook may fail the user's tool call.
    }
    return outcome
  })

  /**
   * Run one cleanup callback through the host timer seam when the host has one,
   * else through an unref'd host timer. Both expiry and file removal share this
   * path so a minimal test Context behaves like production.
   */
  const schedule = (fire: () => void, delayMs: number): void => {
    const delay = Math.max(0, delayMs)
    // `ctx.timeout` is guarded by cordis inject and throws in this fiber;
    // `ctx.get('timer')` reads the service without that requirement.
    const timer = ctx.get('timer') as TimerSeam | undefined
    if (typeof timer?.timeout === 'function') {
      try {
        timer.timeout(fire, delay)
        return
      } catch {
        // Fall through to a plain timer; the lazy check still enforces the deadline.
      }
    }
    setTimeout(fire, delay).unref()
  }

  /**
   * Schedule one one-use reference's expiry. The lazy `Date.now()` check in
   * `consume` remains authoritative if this timer never fires or the seam is
   * unavailable in a minimal host.
   */
  const scheduleExpiry = (secretRef: string, ttlMs: number): void => {
    schedule(() => broker.expire(secretRef), ttlMs)
  }

  const saveExpiry = (secretRef: string, expiresAt: number): void => {
    try {
      scheduleExpiry(secretRef, expiresAt - Date.now())
    } catch {
      // Minting succeeded; the lazy deadline check still rejects a stale ref.
    }
  }

  const handle = async (endpoint: string, payload: unknown, signal: AbortSignal) => {
    const failure = (code: string) => ({
      ok: false as const,
      error: { code, message: 'Secret request could not be completed.', details: {} },
    })
    if (lifetime.signal.aborted || signal.aborted) return failure('cancelled')
    if (endpoint === 'pending') {
      lastClientSeen = Date.now()
      return { ok: true, value: [...pending.values()].map((request) => request.view) }
    }
    if (endpoint !== 'answer' || !payload || typeof payload !== 'object') return failure('invalid')
    const answer = payload as { id?: unknown; action?: unknown; value?: unknown }
    if (typeof answer.id !== 'string') return failure('invalid')
    const request = pending.get(answer.id)
    if (!request || request.saving) return failure('closed')
    if (answer.action === 'decline') {
      request.finish('declined')
      return { ok: true, value: null }
    }
    if (
      answer.action !== 'save' ||
      typeof answer.value !== 'string' ||
      !answer.value.length ||
      answer.value.length > maxSecretLength
    )
      return failure('invalid')

    // Lock before the first await: another tab cannot overwrite the same request.
    const value = answer.value
    let saved = false
    request.saving = Promise.resolve().then(async () => {
      try {
        const view = request.view
        if (view.delivery === undefined) {
          if (view.ref === undefined) return
          await ctx.credentials.set(credentialRef(view.ref), value)
          // The legacy store has no expiry signal and its consumer may read the
          // credential later, so keep scrubbing echoes of this value for 24 h —
          // the same ceiling as file delivery. Best effort only: a consumer that
          // runs beyond this horizon is outside what redaction can cover.
          redactor.add(value, 24 * 60 * 60 * 1000)
          saved = true
          request.finish('saved', { ref: view.ref })
        } else if (view.delivery === 'secretRef') {
          const remaining = Math.max(0, (view.expiresAt ?? Date.now()) - Date.now())
          const minted = broker.mint({
            sessionId: view.sessionId,
            callId: view.callId,
            value,
            ttlMs: remaining,
          })
          // Track before settling the call so a consumer that echoes the value
          // in the very next step is already scrubbed. Keep it for exactly as
          // long as the reference lives.
          redactor.add(value, remaining)
          saveExpiry(minted.secretRef, minted.expiresAt)
          saved = true
          request.finish('saved', {
            delivery: 'secretRef',
            secretRef: minted.secretRef,
            expiresAt: minted.expiresAt,
          })
        } else {
          // File delivery: only the path is returned; the value lives solely in
          // the private file and is removed when the consumer settles or expires.
          const remaining = Math.max(0, (view.expiresAt ?? Date.now()) - Date.now())
          const file = await files.create({
            sessionId: view.sessionId,
            callId: view.callId,
            value,
            ttlMs: remaining,
          })
          redactor.add(value, remaining)
          try {
            schedule(() => void files.remove(file), file.expiresAt - Date.now())
          } catch {
            // Delivery succeeded; the file is still removed by post-execute or
            // by an explicit call, and a stale timer only costs disk space.
          }
          saved = true
          request.finish('saved', {
            delivery: 'file',
            path: file.path,
            expiresAt: file.expiresAt,
            atRest: file.atRest,
          })
        }
      } catch {
        // Credential providers may include the submitted value in an exception.
        // Neither the browser nor the tool result receives that exception.
      }
    })
    await request.saving
    request.saving = undefined
    return saved ? { ok: true, value: null } : failure('save_failed')
  }

  // Connection's exact Fetch routes enforce authenticated owner-only access
  // before dispatch. Keep its standard RPC envelope for the browser carrier.
  for (const endpoint of ['pending', 'answer']) {
    ctx.effect(
      () =>
        ctx.connection.fetch.register({
          path: `${channel}/${endpointPrefix}${endpoint}`,
          methods: ['POST'],
          requestBody: 'buffered',
          async fetch(request) {
            const parsed = await parseRpcRequest(request, `${endpointPrefix}${endpoint}`)
            if (!parsed) return new Response('Invalid request', { status: 400 })
            const result = await handle(endpoint, parsed.payload, request.signal)
            return rpcResponse(parsed.rpcId, result)
          },
        }),
      `request-secret: ${endpoint} route`
    )
  }

  const legacyRequest = async (refName: string, args: LegacyArgs, exec: ToolRunContext): Promise<ToolResultValue> => {
    const ref = credentialRef(refName)
    const result = (status: SecretStatus) => ({ status, ref: refName })
    if (exec.signal?.aborted || lifetime.signal.aborted) return Promise.resolve(result('cancelled'))
    // Delegated agents have no independent human interaction surface.
    if (
      !exec.agent ||
      ctx.agents.get(exec.agent.session.id) !== exec.agent ||
      exec.agent.session.header.origin === 'subagent' ||
      Date.now() - lastClientSeen > 15_000
    )
      return Promise.resolve(result('unavailable'))
    if ([...pending.values()].some((request) => request.view.ref === ref)) {
      return Promise.reject(new Error('Another secret request is already using this reference.'))
    }
    let configured: boolean
    try {
      const info = await ctx.credentials.describe(ref)
      if (!info.writable) return Promise.resolve(result('unavailable'))
      configured = info.configured
    } catch {
      return Promise.resolve(result('unavailable'))
    }
    const signal = AbortSignal.any([lifetime.signal, ...(exec.signal ? [exec.signal] : [])])
    if (signal.aborted) return Promise.resolve(result('cancelled'))
    // Recheck after describe: simultaneous calls may have passed the first check.
    if ([...pending.values()].some((request) => request.view.ref === ref)) {
      return Promise.reject(new Error('Another secret request is already using this reference.'))
    }
    return new Promise<ToolResultValue>((resolve) => {
      const id = randomUUID()
      const finish = (status: SecretStatus, extra?: ResultExtra) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', cancel)
        pending.delete(id)
        resolve({ status, ...extra })
      }
      const request: Pending = {
        view: {
          id,
          ref: refName,
          label: args.label,
          reason: args.reason,
          sessionId: exec.agent!.session.id,
          callId: exec.callId,
          configured,
        },
        finish,
      }
      // A user-admitted write cannot be rolled back. Let it finish before settling cancellation.
      const stop = (status: SecretStatus) => {
        if (request.saving)
          void request.saving.then(() => {
            if (pending.has(id)) finish(status)
          })
        else finish(status)
      }
      const cancel = () => stop('cancelled')
      const timer = setTimeout(() => stop('timed_out'), args.timeout_ms ?? defaultTimeoutMs)
      timer.unref()
      signal.addEventListener('abort', cancel, { once: true })
      pending.set(id, request)
    })
  }

  const deliveryRequest = (
    args: DeliveryArgs,
    exec: ToolRunContext,
    sessionId: string
  ): Promise<ToolResultValue> => {
    const timeoutMs = args.timeoutMs ?? defaultTimeoutMs
    if (exec.signal?.aborted || lifetime.signal.aborted) return Promise.resolve({ status: 'cancelled' })
    // Delegated agents have no independent human interaction surface.
    if (
      !exec.agent ||
      ctx.agents.get(exec.agent.session.id) !== exec.agent ||
      exec.agent.session.header.origin === 'subagent' ||
      Date.now() - lastClientSeen > 15_000
    )
      return Promise.resolve({ status: 'unavailable' })
    const signal = AbortSignal.any([lifetime.signal, ...(exec.signal ? [exec.signal] : [])])
    if (signal.aborted) return Promise.resolve({ status: 'cancelled' })
    return new Promise<ToolResultValue>((resolve) => {
      const id = randomUUID()
      const finish = (status: SecretStatus, extra?: ResultExtra) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', cancel)
        pending.delete(id)
        resolve({ status, ...extra })
      }
      const request: Pending = {
        view: {
          id,
          label: args.label,
          reason: args.reason,
          sessionId,
          callId: exec.callId,
          configured: false,
          delivery: args.delivery,
          expiresAt: Date.now() + timeoutMs,
          ...(args.url === undefined ? {} : { url: args.url }),
          ...(args.placeholder === undefined ? {} : { placeholder: args.placeholder }),
        },
        finish,
      }
      // A minted reference cannot be un-minted. Let an in-flight save finish.
      const stop = (status: SecretStatus) => {
        if (request.saving)
          void request.saving.then(() => {
            if (pending.has(id)) finish(status)
          })
        else finish(status)
      }
      const cancel = () => stop('cancelled')
      const timer = setTimeout(() => stop('timed_out'), timeoutMs)
      timer.unref()
      signal.addEventListener('abort', cancel, { once: true })
      pending.set(id, request)
    })
  }

  ctx.tools.register(
    defineTool({
      name: 'request_secret',
      description:
        'Ask the user for a secret through a private password form. Pass only a label, a reason and a delivery mode, NEVER the secret value. ' +
        'delivery:"secretRef" returns a one-use opaque reference held only in host memory: it is never persisted, is lost on host restart, and works once. ' +
        'delivery:"file" writes the value to a private file and returns only its path: on POSIX a 0600 file inside a 0700 per-request temp directory, on Windows a directory whose inherited ACLs are replaced (falling back to the OS default when that hardening fails). ' +
        'The file is deleted when the consuming tool call settles or when its TTL expires. Commands promoted outside the tool executor are not observed, so their file survives until expiry. ' +
        'The legacy ref mode stores the value in the host-wide DSH credential store, replacing any value at that reference; it is NOT exported to shell environment variables or the project .env. ' +
        'Requires the plugin in an open DSH web UI. Never ask for secrets in chat or read the credential file.',
      parameters: {
        ref: {
          type: 'string',
          description:
            'Legacy mode only: DSH credential reference, e.g. STRIPE_API_KEY. Letters, digits and underscores; cannot start with a digit.',
        },
        label: {
          type: 'string',
          required: true,
          description: 'Card title: the environment-style key name or a short description of the key.',
        },
        reason: {
          type: 'string',
          required: true,
          description:
            'One short sentence explaining why this key is needed by the DSH consumer. Omit input instructions and storage details.',
        },
        timeout_ms: {
          type: 'integer',
          description: 'Legacy mode only: wait from 1000 to 600000 milliseconds; default 600000.',
        },
        delivery: {
          type: 'string',
          enum: ['secretRef', 'file'],
          description:
            'How to deliver the value when ref is absent. secretRef is a one-use in-memory reference; file is a private file path (0600 in a 0700 temp directory on POSIX) deleted when the consuming tool call settles or at expiry.',
        },
        url: { type: 'string', description: 'Optional http(s) page that needs the secret, for context.' },
        placeholder: { type: 'string', description: 'Optional input placeholder shown to the user.' },
        timeoutMs: {
          type: 'integer',
          description: 'Wait from 1000 to 3600000 milliseconds for a delivery request; default 600000.',
        },
        clientRequestId: {
          type: 'string',
          description: 'Optional idempotency key; a retry with the same id joins the original request.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true },
            ref: { type: 'string' },
            delivery: { type: 'string' },
            secretRef: { type: 'string' },
            path: { type: 'string' },
            expiresAt: { type: 'integer' },
            atRest: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const refName = args.ref
        const delivery = args.delivery
        // Legacy credential mode: exactly the previous contract and storage path.
        if (refName !== undefined && delivery === undefined) {
          if (
            !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(refName) ||
            !args.label.trim() ||
            args.label.length > 200 ||
            !args.reason.trim() ||
            args.reason.length > 2000 ||
            (args.timeout_ms !== undefined &&
              (!Number.isInteger(args.timeout_ms) || args.timeout_ms < 1000 || args.timeout_ms > 600_000))
          ) {
            throw new Error('Invalid secret request metadata.')
          }
          return legacyRequest(refName, args, exec)
        }

        if (delivery !== 'secretRef' && delivery !== 'file')
          throw new Error('Invalid secret request metadata.')
        if (!args.label.trim() || args.label.length > 200 || !args.reason.trim() || args.reason.length > 2000)
          throw new Error('Invalid secret request metadata.')
        const timeoutMs = args.timeoutMs ?? defaultTimeoutMs
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > maxDeliveryTimeoutMs)
          throw new Error('Invalid secret request metadata.')
        if (args.url !== undefined) {
          if (args.url.length > 2048) throw new Error('Invalid secret request metadata.')
          let parsed: URL
          try {
            parsed = new URL(args.url)
          } catch {
            throw new Error('Invalid secret request metadata.')
          }
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
            throw new Error('Invalid secret request metadata.')
        }
        if (args.placeholder !== undefined && args.placeholder.length > 200)
          throw new Error('Invalid secret request metadata.')
        if (args.clientRequestId !== undefined && args.clientRequestId.length > 200)
          throw new Error('Invalid secret request metadata.')

        const requestArgs: DeliveryArgs = {
          label: args.label,
          reason: args.reason,
          delivery,
          ...(args.url === undefined ? {} : { url: args.url }),
          ...(args.placeholder === undefined ? {} : { placeholder: args.placeholder }),
          ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
          ...(args.clientRequestId === undefined ? {} : { clientRequestId: args.clientRequestId }),
        }
        const sessionId = exec.agent?.session.id
        const key =
          sessionId !== undefined && requestArgs.clientRequestId !== undefined
            ? `${sessionId}:${requestArgs.clientRequestId}`
            : undefined
        if (key !== undefined) {
          const prior = completed.get(key)
          if (prior) return prior.result ?? prior.promise
        }
        const promise = deliveryRequest(requestArgs, exec, sessionId ?? '')
        if (key !== undefined) {
          const entry: IdempotencyEntry = { promise }
          completed.set(key, entry)
          void promise.then(
            (value) => {
              entry.result = value
              setTimeout(() => {
                if (completed.get(key) === entry) completed.delete(key)
              }, idempotencyRetentionMs).unref()
            },
            () => {
              if (completed.get(key) === entry) completed.delete(key)
            }
          )
        }
        return promise
      },
    })
  )
}
