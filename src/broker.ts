import { randomBytes } from 'node:crypto'

/** Hard ceiling for any one-use reference, regardless of the caller's request. */
const maxTtlMs = 24 * 60 * 60 * 1000

export type SecretRefErrorCode = 'unknown' | 'consumed' | 'expired' | 'session_mismatch'

/**
 * Public failure code for a rejected reference. The message is fixed and must
 * never include the stored value or any other request data.
 */
export class SecretRefError extends Error {
  constructor(readonly code: SecretRefErrorCode) {
    super(`Secret reference is ${code}.`)
    this.name = 'SecretRefError'
  }
}

type State = 'live' | 'consumed' | 'expired'

interface Entry {
  sessionId: string
  callId: string
  /** Present only while the entry is live; tombstones never retain the value. */
  value?: string
  expiresAt: number
  state: State
}

/**
 * In-memory, one-use delivery handles for submitted secrets.
 *
 * Handles are opaque and capability-like. They are never persisted, never
 * written to a tool result, and are lost on host restart. Consuming a handle
 * destroys the stored value; the tombstone keeps only enough state to report
 * `consumed` or `expired` instead of `unknown`.
 */
export class SecretBroker {
  private readonly entries = new Map<string, Entry>()

  mint({
    sessionId,
    callId,
    value,
    ttlMs,
  }: {
    sessionId: string
    callId: string
    value: string
    ttlMs: number
  }): { secretRef: string; expiresAt: number } {
    const secretRef = 'sr_' + randomBytes(24).toString('base64url')
    const expiresAt = Date.now() + Math.min(ttlMs, maxTtlMs)
    this.entries.set(secretRef, { sessionId, callId, value, expiresAt, state: 'live' })
    return { secretRef, expiresAt }
  }

  consume(secretRef: string, sessionId: string): string {
    const entry = this.entries.get(secretRef)
    if (!entry) throw new SecretRefError('unknown')
    // A wrong owner learns nothing and cannot consume or mutate the entry.
    if (entry.sessionId !== sessionId) throw new SecretRefError('session_mismatch')
    if (Date.now() >= entry.expiresAt || entry.state === 'expired') {
      entry.state = 'expired'
      delete entry.value
      throw new SecretRefError('expired')
    }
    if (entry.state === 'consumed') throw new SecretRefError('consumed')
    const value = entry.value
    entry.state = 'consumed'
    delete entry.value
    if (value === undefined) throw new SecretRefError('consumed')
    return value
  }

  expire(secretRef: string): void {
    const entry = this.entries.get(secretRef)
    // Expiry must not downgrade a consumed tombstone: a late timer stays `consumed`.
    if (!entry || entry.state === 'consumed') return
    entry.state = 'expired'
    delete entry.value
  }

  dispose(): void {
    this.entries.clear()
  }
}
