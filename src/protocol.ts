export const channel = '/api'
export const endpointPrefix = 'dungsil-secrets/'
export const maxSecretLength = 65_536

/** How a submitted secret is delivered to its consumer. */
export type Delivery = 'secretRef' | 'file'

/**
 * Public metadata only. Never add the submitted value to this view.
 *
 * Legacy credential requests omit `delivery` and `expiresAt`; one-use
 * references and file requests include them.
 */
export interface SecretRequest {
  id: string
  ref?: string
  label: string
  reason: string
  sessionId: string
  callId: string
  configured: boolean
  delivery?: Delivery
  expiresAt?: number
  url?: string
  placeholder?: string
}

export type SecretStatus = 'saved' | 'declined' | 'cancelled' | 'timed_out' | 'unavailable'
