import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { parseRpcRequest, rpcResponse } from './vendor/rpc.js'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  channel,
  endpointPrefix,
  maxSecretLength,
  type Delivery,
  type SecretRequest,
  type SecretStatus,
} from './protocol.js'
import { SecretBroker } from './broker.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Disposal-aware timer seam installed by the host timer plugin. The pinned
     * standalone test Context has no timer plugin, so callers must tolerate it
     * being absent and fall back to an unref'd host timer.
     */
    timeout?: (callback: () => void, delayMs: number) => unknown
  }
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
}

type ResultExtra = Omit<ToolResultValue, 'status'>

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

export function apply(ctx: Context) {
  const pending = new Map<string, Pending>()
  const completed = new Map<string, IdempotencyEntry>()
  const broker = new SecretBroker()
  const lifetime = new AbortController()
  let lastClientSeen = 0

  ctx.provide('secretRefs', broker)
  ctx.effect(() => () => broker.dispose(), 'request-secret: broker')

  ctx.effect(
    () => async () => {
      lifetime.abort()
      await Promise.all([...pending.values()].flatMap((request) => (request.saving ? [request.saving] : [])))
    },
    'request-secret: pending requests'
  )

  /**
   * Schedule one one-use reference's expiry through the host timer seam. The
   * lazy `Date.now()` check in `consume` remains authoritative if this timer
   * never fires or the seam is unavailable in a minimal host.
   */
  const scheduleExpiry = (secretRef: string, ttlMs: number): void => {
    const fire = () => broker.expire(secretRef)
    const delay = Math.max(0, ttlMs)
    if (typeof ctx.timeout === 'function') {
      try {
        ctx.timeout(fire, delay)
        return
      } catch {
        // Fall through to a plain timer; consume() still enforces the deadline.
      }
    }
    setTimeout(fire, delay).unref()
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
          saveExpiry(minted.secretRef, minted.expiresAt)
          saved = true
          request.finish('saved', {
            delivery: 'secretRef',
            secretRef: minted.secretRef,
            expiresAt: minted.expiresAt,
          })
        } else {
          // File delivery is a later slice. Never fall back to writing the value somewhere else.
          saved = true
          request.finish('unavailable')
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
        'delivery:"file" is not available in this version. ' +
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
            'How to deliver the value when ref is absent. secretRef is a one-use in-memory reference; file is not implemented.',
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
