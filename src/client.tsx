import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { localizedCopy, useLocaleSnapshot } from './vendor/locale.js'
import { channel, endpointPrefix, maxSecretLength, type SecretRequest, type SecretStatus } from './protocol.js'
import en from '../locale/en.json' with { type: 'json' }
import ko from '../locale/ko.json' with { type: 'json' }
import zh from '../locale/zh.json' with { type: 'json' }
import ja from '../locale/ja.json' with { type: 'json' }
import es from '../locale/es.json' with { type: 'json' }
import fr from '../locale/fr.json' with { type: 'json' }
import de from '../locale/de.json' with { type: 'json' }
import ru from '../locale/ru.json' with { type: 'json' }
import pt from '../locale/pt.json' with { type: 'json' }

export const name = 't3-secret-request'
export const inject = ['connection', 'locale', 'slots']

const copy = {
  en: en.ui,
  ko: ko.ui,
  zh: zh.ui,
  ja: ja.ui,
  es: es.ui,
  fr: fr.ui,
  de: de.ui,
  ru: ru.ui,
  pt: pt.ui,
}

const styles = `
.dsh-secret-card { box-sizing: border-box; width: 100%; min-width: 0; margin: 6px 0; padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l4, #8886); border-radius: var(--dsw-radius-md); color: var(--dsw-alias-label-primary, #222); background: var(--dsw-alias-bg-layer-2, #fff); font: var(--dsw-font-xs-13); overflow-wrap: anywhere; }
.dsh-secret-card bdi { unicode-bidi: isolate; }
.dsh-secret-card .dsh-secret-context { unicode-bidi: plaintext; }
.dsh-secret-card h3 { margin: 0; font-size: var(--dsw-font-s-14-font-size); }
.dsh-secret-card p { margin: 4px 0; }
.dsh-secret-card small { display: block; margin-top: 6px; font-size: var(--dsw-font-xxs-12-font-size); color: var(--dsw-alias-label-secondary, #666); }
.dsh-secret-card input { box-sizing: border-box; flex: 1 1 140px; min-width: 0; height: 36px; padding: 6px 10px; border: 1px solid var(--dsw-alias-border-l4, #8888); border-radius: var(--dsw-radius-sm); font: inherit; color: inherit; background: var(--dsw-alias-bg-layer-1, #f5f5f5); }
.dsh-secret-card input:focus-visible, .dsh-secret-card button:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 3px; }
.dsh-secret-card footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 6px; margin-top: 8px; }
.dsh-secret-card button { flex: none; min-height: 36px; border: 1px solid var(--dsw-alias-border-l4, #8886); border-radius: var(--dsw-radius-sm); padding: 6px 10px; font: inherit; cursor: pointer; background: transparent; color: inherit; }
.dsh-secret-card .dsh-secret-link { display: inline-flex; align-items: center; min-height: 32px; padding: 4px 10px; border: 1px solid var(--dsw-alias-border-l4, #8886); border-radius: var(--dsw-radius-sm); color: inherit; text-decoration: none; }
.dsh-secret-card .dsh-secret-link:hover { filter: brightness(.9); }
.dsh-secret-card button[type=submit] { background: var(--dsw-alias-button-primary-fill, #222); border-color: transparent; color: var(--dsw-alias-label-primary-foreground, white); }
.dsh-secret-card button:hover:not(:disabled) { filter: brightness(.9); }
.dsh-secret-card button:disabled { opacity: .5; cursor: default; }
.dsh-secret-card [role=alert] { color: var(--dsw-alias-state-error-primary, #b54424); }
@media (max-width: 480px) { .dsh-secret-card input { flex-basis: 100%; } }
`

type Text = (typeof copy)[keyof typeof copy]

/** One-line note that explains how long this value lives, keyed by delivery mode. */
function deliveryNote(request: SecretRequest, text: Text): string {
  if (request.delivery === 'secretRef') return text.oneUse
  if (request.delivery === 'file') return text.fileNote
  return text.privacy
}

/** Whole seconds left before `expiresAt`; never negative. Recomputed on render, no timer. */
function secondsLeft(expiresAt: number): number {
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
}

/**
 * Destination host for a model-supplied link. The URL is untrusted, so a
 * malformed value falls back to showing no host instead of failing the card.
 */
function linkHost(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  try {
    return new URL(url).host || undefined
  } catch {
    return undefined
  }
}

function SecretForm({
  request,
  text,
  connection,
  onSettled,
}: {
  request: SecretRequest
  text: Text
  connection: ConnectionHandle
  onSettled: (status: SecretStatus) => void
}) {
  // Keep the value only in this input, never in the chat store or React state.
  const input = useRef<HTMLInputElement>(null)
  const lock = useRef(false)
  const [lifetime] = useState(() => new AbortController())
  const [busy, setBusy] = useState(false)
  const [empty, setEmpty] = useState(true)
  const [error, setError] = useState(false)
  useEffect(() => {
    const element = input.current
    return () => {
      if (element) element.value = ''
      lifetime.abort()
    }
  }, [lifetime])

  const answer = async (action: 'save' | 'decline') => {
    const element = input.current
    if (!element || lock.current || (action === 'save' && !element.value.length)) return
    lock.current = true
    setBusy(true)
    setError(false)
    try {
      const response = await connection.rpc.call(
        channel,
        `${endpointPrefix}answer`,
        {
          id: request.id,
          action,
          ...(action === 'save' ? { value: element.value } : {}),
        },
        lifetime.signal
      )
      if (!response.ok) throw new Error('Secret request failed')
      onSettled(action === 'save' ? 'saved' : 'declined')
    } catch {
      // Never display, log or report transport/provider exception objects.
      setError(true)
    } finally {
      element.value = ''
      lock.current = false
      setEmpty(true)
      setBusy(false)
    }
  }
  useEffect(() => {
    if (error && !busy) input.current?.focus()
  }, [error, busy])

  const host = linkHost(request.url)

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        event.stopPropagation()
        void answer('save')
      }}
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
      onKeyPress={(event) => event.stopPropagation()}
      onPaste={(event) => event.stopPropagation()}
    >
      <p id={`secret-target-${request.id}`}>
        <strong>{text.target}: </strong>
        <code>
          <bdi dir="ltr">{request.ref ?? request.label}</bdi>
        </code>
      </p>
      {request.ref && request.configured && (
        <p>
          {text.replace}{' '}
          <code>
            <bdi dir="ltr">{request.ref}</bdi>
          </code>
        </p>
      )}
      {request.url && (
        <p>
          <a
            className="dsh-secret-link"
            href={request.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {host ? `${text.openUrl} · ${host}` : text.openUrl}
          </a>
        </p>
      )}
      <footer>
        <input
          ref={input}
          id={`secret-${request.id}`}
          aria-label={text.value}
          aria-describedby={`secret-target-${request.id} secret-privacy-${request.id}`}
          placeholder={request.placeholder ?? text.value}
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          data-1p-ignore=""
          data-lpignore="true"
          required
          maxLength={maxSecretLength}
          disabled={busy}
          onInput={(event) => {
            event.stopPropagation()
            setEmpty(!event.currentTarget.value.length)
          }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void answer('decline')
          }}
        >
          {text.decline}
        </button>
        <button type="submit" disabled={busy || empty}>
          {busy ? text.saving : text.save}
        </button>
      </footer>
      <small id={`secret-privacy-${request.id}`}>{deliveryNote(request, text)}</small>
      {error && <p role="alert">{text.error}</p>}
    </form>
  )
}

export function apply(ctx: Context) {
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  const lifetime = new AbortController()
  let requests: SecretRequest[] = []
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  const snapshot = () => requests
  const update = (next: SecretRequest[]) => {
    requests = next
    for (const listener of listeners) listener()
  }

  function SecretCard(props: ToolCallViewProps) {
    const pending = useSyncExternalStore(subscribe, snapshot)
    const [submitted, setSubmitted] = useState<SecretStatus>()
    const locale = useLocaleSnapshot(ctx.locale)
    const text = localizedCopy(copy, locale.active)
    // A card may only answer the live request for this exact session and call.
    const request = pending.find((item) => item.sessionId === props.sessionId && item.callId === props.callId)
    const label = request?.label ?? props.block.args.text('label')
    const reason = request?.reason ?? props.block.args.text('reason')
    let status: string | undefined
    let expired = false
    if (props.phase === 'result') {
      status = text.closed
      const content = props.block.content[0]
      try {
        const result = content?.type === 'text' ? JSON.parse(content.text) : null
        if (
          !props.block.isError &&
          ['saved', 'declined', 'cancelled', 'timed_out', 'unavailable'].includes(result?.status)
        ) {
          status = text[result.status as SecretStatus]
          expired = result.status === 'timed_out'
        }
      } catch {
        /* Do not echo raw results or error text into the private card. */
      }
    } else if (submitted) {
      status = text[submitted]
    }
    return (
      <section className="dsh-secret-card" aria-label={text.title} title={label}>
        <h3>{text.title}</h3>
        <small>{text.context}</small>
        <p className="dsh-secret-context">{label}</p>
        <p className="dsh-secret-context">{reason}</p>
        {!status && request?.expiresAt !== undefined && (
          <small>{text.expiresIn.replace('{seconds}', String(secondsLeft(request.expiresAt)))}</small>
        )}
        {status ? (
          [
            <p key="status" role="status">
              {status}
            </p>,
            expired ? (
              <p key="hint" role="note">
                {text.expiredHint}
              </p>
            ) : null,
          ]
        ) : request && connection.interactions === 'answer' ? (
          <SecretForm key={request.id} request={request} text={text} connection={connection} onSettled={setSubmitted} />
        ) : (
          <p role="status">{text.waiting}</p>
        )}
      </section>
    )
  }

  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register(
      {
        name: 'tool.call.toolview',
        key: 'request_secret',
      },
      SecretCard
    )
  )

  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = styles
    document.head.append(style)
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const response = await connection.rpc.call(channel, `${endpointPrefix}pending`, {}, lifetime.signal)
        if (!lifetime.signal.aborted) update(response.ok ? (response.value as SecretRequest[]) : [])
      } catch {
        if (!lifetime.signal.aborted) update([])
      } finally {
        if (!lifetime.signal.aborted)
          timer = setTimeout(() => {
            void poll()
          }, 1000)
      }
    }
    if (connection.interactions === 'answer') void poll()
    return () => {
      lifetime.abort()
      clearTimeout(timer)
      update([])
      style.remove()
    }
  }, 'request-secret: inline input')
}
