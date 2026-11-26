# dsh-secret-request-t3

A DeepSeek Harness (`dsh`) plugin that asks the user for a secret in the web UI
and gives the agent **either** a one-use in-memory handle **or** a private
temp-file path. The tool result itself never carries the value.

This is a fork of
[`@dungsil/dsh-plugin-tool-secret-request`](https://www.npmjs.com/package/@dungsil/dsh-plugin-tool-secret-request)
0.4.0 (MIT), extended toward the T3 Code `request_secret` contract. The upstream
plugin already had the inline card, session+call binding, timeout, and statuses;
it explicitly did not have one-use refs or file delivery. This fork adds those
two modes and keeps the original credential mode working.

Read the [Threat model](#threat-model) before using file delivery. This plugin
does not claim that a secret can never reach the session log.

## Status

| | |
| --- | --- |
| `dsh` | **0.2.3-alpha.2**, pinned exactly (developer preview) |
| Node | >= 26.13.1 |
| Linux | tested on CachyOS/Arch, Node 26.13.1, `dsh` 0.2.3-alpha.2 |
| Windows 11 | CI `windows-latest`: 60 pass, 3 POSIX-only tests skipped, `atRest=windows-acl`. Interactive checklist still required — see [docs/windows-verification.md](docs/windows-verification.md) |
| Runtime deps | the published package declares no dependencies and ships JS only; dev/test `npm ci` pulls native transitive packages (for example `koffi`) from the dsh toolchain |
| Tests | `npm run verify` → Linux 63/63; Windows 60 pass + 3 POSIX-only skips |

## What changed from upstream

- New `delivery` argument: `"secretRef"` (one-use, memory-only) or `"file"`
  (0600 file in a 0700 per-request temp dir).
- New optional card fields: `url`, `placeholder`, and the destination host shown
  next to the link.
- Ref expiry via the host timer service, plus a lazy deadline check.
- Post-execute file deletion, best-effort redaction, and a fail-closed block when
  a tracked value survives in a channel that cannot be rewritten (including
  JSON-escaped, line-split, and 2000-char-truncated forms).
- The legacy `ref` mode is unchanged: it still writes the host credential store.

## Install

The plugin needs the **web** profile, because it injects the `connection`
service. A bare profile (for example one created with `dsh plugin --profile demo
add ...`) composes the row but stays `pending (waiting for service: connection)`
at boot. This was observed, not assumed.

```sh
git clone https://github.com/TriBrigadeMars/dsh-secret-request-t3.git
cd dsh-secret-request-t3
npm ci
npm run build                 # local `dsh plugin add` links the checkout; dist must exist
dsh plugin --profile web add "$PWD"
dsh --profile web --dump-config | grep -B1 -A2 t3-secret-request
dsh --profile web             # boot; the card is available in the web UI
```

Observed `--dump-config` row:

```yaml
# == dsh-secret-request-t3
- id: t3-secret-request
  name: dsh-secret-request-t3
```

## Tool contract

```
request_secret({
  label:           string     // card title
  reason:          string     // why the agent needs it
  url?:            string     // http(s) sign-in/setup page, shown as a link
  placeholder?:    string
  delivery:        "secretRef" | "file"
  timeoutMs?:      number     // 1000..3600000, default 600000
  clientRequestId?: string    // idempotency retry key
})
```

Legacy mode is selected by passing `ref` **without** `delivery`; it keeps the
upstream arguments (`ref`, `label`, `reason`, `timeout_ms`) and return shape.

Results, by mode:

```jsonc
// secretRef
{ "status": "saved", "delivery": "secretRef", "secretRef": "sr_…", "expiresAt": 1795670000000 }

// file
{ "status": "saved", "delivery": "file", "path": "/…/dsh-secret-XXXX/secret",
  "expiresAt": 1795670000000, "atRest": "posix-0600" }

// legacy
{ "status": "saved", "ref": "STRIPE_API_KEY" }
```

Statuses: `saved`, `declined`, `cancelled`, `timed_out`, `unavailable`.

`atRest` is `posix-0600`, `windows-acl`, or `unrestricted`. `unrestricted` means
the OS default was used because ACL hardening failed; the delivery still
succeeds, and the value is not returned.

### Consuming a `secretRef`

The ref is a capability handle held by the plugin. A consuming host plugin
resolves it exactly once:

```ts
const broker = ctx.get('secretRefs')
const value = broker.consume(result.secretRef, exec.agent.session.id)
// second call throws SecretRefError { code: 'consumed' | 'expired' | 'unknown' | 'session_mismatch' }
```

- Bound to the session that requested it. The minting call id is recorded for
  audit but is not enforced, because the consumer runs in a later call.
- Consumed on first resolve; the reference is dropped and only a tombstone
  remains. JavaScript strings are not overwritten in place, so this is logical
  erasure, not memory zeroing.
- Expires at `min(timeoutMs, 24h)` from the advertised deadline, via the host
  timer service (`ctx.get('timer').timeout`) and a lazy `Date.now()` check.
- Memory only. A host restart loses every live ref; that is intentional.

### File delivery lifecycle

1. `mkdtemp(os.tmpdir()/dsh-secret-)`, `chmod 0700`, verified.
2. `secret` written with `0600` (POSIX) and mode verified; Windows uses
   `icacls <dir|file> /inheritance:r /grant:r <user>:F` and reports
   `windows-acl` or `unrestricted`.
3. Only the path is returned.
4. Deleted when a **different** tool call settles (success or failure) and its
   arguments or rendered **content** mention that exact path (`meta` or a
   structured `value` mention does not trigger deletion); also on expiry and on plugin
   disposal. `request_secret`'s own call is excluded.
5. Any command that runs outside `tools/post-execute` (a promoted job, a
   terminal outside the executor) is not observed.

## Threat model

This section states what is and is not defended. "Safe" below always names what
it is safe against. The plugin does not use "guaranteed", "airtight", or "cannot
leak" as claims.

### Invariants that hold in the plugin's own paths

| Property | Mechanism | Test |
| --- | --- | --- |
| The tool never returns the value | only `secretRef`, `path`, `atRest`, `expiresAt`, `status` | `secretRef`/`file` result assertions |
| A consumed ref is dead | tombstone + `SecretRefError('consumed')` | `test/broker.test.mjs` |
| Expiry is timer-enforced | host timer + lazy deadline check | recording-seam tests in `test/plugin.test.mjs` |
| Ref values are memory-only | `Map`, no disk write, disposed with the fiber | `dispose` tests |
| File mode is 0600/0700 on POSIX, ACL on Windows | POSIX modes verified at creation; Windows applies `icacls` and reports the outcome, never re-reads it | `test/files.test.mjs`, CI logs |
| File deletion on all four exit paths | post-execute, expiry, disposal, create-vs-dispose race | `test/plugin.test.mjs`, `test/files.test.mjs` |
| A tracked value is scrubbed from tool results | post-execute replace + verify | `test/session-log.test.mjs` |
| A result that still carries a tracked value is refused | `kind: 'block'` drops `meta` and replaces content; detection runs on decoded string leaves, not serialized text | `test/block-on-leak.test.mjs` |
| The model never sees the value in the tested echo/read paths | decoded-string walk over a real `AgentLoop` + JSONL backend | `test/session-log.test.mjs` |

### Residual risks

**R1 — A path is readable by design.** File mode gives the model a path. On
every OS, every dsh sandbox mode permits reads. If a command reads the file and
prints the value, the post-execute gate blocks that result when a tracked form
is detected (>= 8 characters, including JSON-escaped, line-split, and
2000-char-truncated forms) and the durable event is clean. A command that runs
**outside** the tool executor, a cap other than 2000 characters, or a transform
the redactor does not know can still disclose the value. Use file mode only
with commands that consume the file without echoing it.

**R2 — `tool/result.meta` cannot be rewritten.** `PostToolDecision` has no
`meta` field, and `postExecute` spreads the original result's `meta` into the
durable event
([`pipeline.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c3/packages/core/tools/src/pipeline.ts),
[`contracts.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c3/packages/core/tools/src/contracts.ts)).
Stock tools such as `read` put line text there. The plugin mitigates this by
**blocking** the call when a tracked value (length >= 8) survives in `meta`,
inspected as decoded string leaves rather than serialized JSON. The block path
builds a fresh result with no `meta`. This is a refusal, not a guarantee:
values shorter than 8 characters are not blocked; a listener that rebuilds
content from the structured `value` after this plugin returns; and a tool's
`finalizeContent`, which the pipeline runs after `tools/post-execute`, are
outside the gate.

**R3 — Redaction is a denylist.** Tracked forms are the raw value, base64,
base64url, `encodeURIComponent`, and `encodeURI`. Hex, reversed, split,
compressed, JSON-escaped, or re-encoded forms are not tracked. The scrub is
best-effort defense in depth. JSON-escaped, line-split, and 2000-char-truncated
forms of the same value are tracked deliberately; other transforms (hex, case
changes, Unicode normalization, chunking across results) are not.

**R4 — Restart.** Live refs are lost. Delivered files are not swept at startup:
a file whose TTL had not elapsed remains in the OS temp directory until the OS
cleans it or its timer would have fired, and the new process's redactor no
longer knows the value. A resumed session that reads a stale path is covered
only by the R2 block gate: `read` of that file is refused, not scrubbed.

**R5 — Cross-plugin trust.** `ctx.secretRefs` is host-wide. Any plugin can call
`consume(ref, sessionId)`; the session id is an assertion by the caller, not
authentication. Treat installed plugins as trusted.

**R6 — Legacy mode.** `ref` mode still writes the value in plaintext to
`$DSH_HOME/.credentials.yaml` (0600 on POSIX) indefinitely and is not one-use.
It is not covered by the one-use claim. Its value is tracked for redaction for
24 hours after a save; after that, echoes are not scrubbed.

**R7 — Environment writes (core).** The plugin injects no environment
variables. If a consumer passes the value in a subprocess environment, dsh core
writes the complete environment to
`<tmpdir>/dsh-subprocess-launch-*/launch-request.json` (0600 in a 0700 directory)
before `systemd-run` and unlinks it when the runner consumes it
([`runner-protocol.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c3/packages/subprocess/subprocess-local/src/runner-protocol.ts)).
Windows passes the same environment over parent/child IPC instead of a file.
A plugin cannot disable this per call.

**R8 — Output spill.** `spill-policy` registers a **prepended**
`tools/post-execute` listener and spills the decision content after awaiting
the inner chain, so with the current core it receives the scrubbed text. That is
verified from source only: this repository has no test that mounts
`spill-policy`. A different listener that spills before the scrub, or an outer
listener that rebuilds content from `value`, is outside this plugin's control.

**R9 — PTC and logged arguments.** With the PTC (`run_code`) executor, a
consumer that returns the value as its structured `value` hands it to
model-authored code; later tool-call arguments are logged in durable
`tool/call` / `tool/ptc-dispatch` events without redaction. Do not return the
value as a structured value from a tool that a model can script.

**R10 — Windows 11.** CI runs the suite on `windows-latest` (60 pass, 3
POSIX-only file-mode tests skipped) and reports `atRest=windows-acl`. ACL
semantics on a localized or domain account, a missing `icacls`, interactive
deletion, and forward-slash path spellings are still covered only by
[docs/windows-verification.md](docs/windows-verification.md).
Path matching is literal: the JSON-escaped `\\` spelling is matched; `C:/…` is
not, and the file then survives until its timer.

**R11 — The card's `url` is model-controlled.** The host is displayed next to
the link, but the destination is not bound to the input. A prompt-injected model
can present a plausible label and link. Verify before typing.

**R12 — Deliberate denials.** The block-on-leak gate can refuse a legitimate
tool result that happens to echo a tracked 8+ character value, and the file
cleanup step runs **before** the gate, so a blocked read also destroys the
delivered file and the user must submit again. The refusal message is a fixed
sentence and does not name which channel tripped. This is a
confidentiality-over-availability choice.

**R13 — Browser and transport.** The value exists in browser memory and in the
authenticated request body. Use HTTPS for remote access. The card requires an
open, authenticated web client; subagents and headless-only hosts get
`unavailable`.

**R14 — Idempotency replay.** A `clientRequestId` retry within 60 seconds
returns the original result, including a ref that may already be consumed or a
path that may already be deleted.

**R15 — Timer semantics.** Expiry is an in-process timer plus a lazy check.
Suspend/resume and wall-clock changes can move the effective deadline; the
24-hour cap is enforced at mint.

## Red-team record

Every finding from three independent reviews, with its fix or documented
residual, is listed in [docs/red-team-findings.md](docs/red-team-findings.md).

## Upstream follow-up

The per-spawn secret-file design (a private per-spawn directory, deleted on
success, failure, timeout, or cancel) is not implemented in `dsh` core. This
plugin implements the file half at the plugin layer. The environment half is
shipped by third-party plugins, not by core.

The `deepseek-ai/deepseek-harness` repository has GitHub Issues disabled, so
there is no upstream thread to cite. The core behaviors this threat model relies
on are cited from source instead:

- complete child environment written to `launch-request.json`:
  [`subprocess-local/src/runner-protocol.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c3/packages/subprocess/subprocess-local/src/runner-protocol.ts)
- post-execute ordering and `meta` propagation:
  [`core/tools/src/pipeline.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c3/packages/core/tools/src/pipeline.ts)
- `PostToolDecision` has no `meta`:
  [`core/tools/src/contracts.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c3/packages/core/tools/src/contracts.ts)
- spill ordering:
  [`spill/spill-policy/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c3/packages/spill/spill-policy/src/index.ts)

What would let this plugin make a stronger claim:

1. A per-call subprocess policy that keeps the environment in memory only
   (no `launch-request.json`, no forced spill file).
2. A post-execute decision that can replace or remove `tool/result.meta`, or a
   tool-result projection that runs before persistence.
3. A way to bind a resolved value to a single command invocation rather than a
   session, so `consume` does not rely on a caller-supplied session id.

## Verification

Run locally:

```sh
npm run verify        # build + tsc --noEmit + node --test
```

Observed on CachyOS, Node 26.13.1, `dsh` 0.2.3-alpha.2:

```
ℹ tests 63
ℹ pass 63
ℹ fail 0
```

The session-log test is not a proxy: it mounts a real `AgentLoop`,
`JsonlSessionPersistence` (plaintext JSONL), the plugin, and a scripted
`LlmAdapter`; it delivers a secret, makes a sibling tool echo the raw value plus
base64 and percent-encoding, and then parses every JSONL line and asserts no
**decoded** string contains any variant of the value. A negative control with
scrub **and** block disabled fails with `session.v4.jsonl leaked a secret
variant`; with only the scrub disabled, the block gate refuses the echo and the
test fails earlier on the missing marker instead.

CI runs the same suite on `ubuntu-latest` and `windows-latest`
(`.github/workflows/ci.yml`). Latest observed:

```
verify (ubuntu-latest): success     atRest=posix-0600 platform=linux
verify (windows-latest): success    atRest=windows-acl platform=win32
```

Clean-clone install, observed end to end:

```sh
git clone https://github.com/TriBrigadeMars/dsh-secret-request-t3.git /tmp/cleanclone
cd /tmp/cleanclone && npm ci && npm run build
DSH_HOME=/tmp/dsh-home dsh plugin --profile web add /tmp/cleanclone
DSH_HOME=/tmp/dsh-home dsh --profile web --dump-config   # shows t3-secret-request
DSH_HOME=/tmp/dsh-home dsh --profile web --no-open --port 0
```

The boot log prints the UI URL with no "did not activate" warning, and the served
client bundle contains `dsh-secret-card` and `Open credential page`.

Not executed here: the interactive [manual UI checklist](docs/manual-ui-checklist.md)
(no desktop browser was connected) and the physical Windows 11 checklist. Both
are written down rather than claimed.

## Non-goals

- No ACP/TUI elicitation.
- No persistence of pending requests or live refs.
- No encryption at rest. The legacy store and the delivered file rely on OS
  permissions.
- No `plugin-win32` / `plugin-linux` forks; OS differences are confined to the
  at-rest mechanism and the threat model.
- No changes to `dsh` core.

## License

MIT. Upstream copyright and vendored files are recorded in
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) and
[LICENSE.upstream](LICENSE.upstream).
