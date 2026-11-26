# Changelog

## 0.5.0

Fork of `@dungsil/dsh-plugin-tool-secret-request` 0.4.0 into a standalone
package, extended with the two delivery modes upstream disclaimed.

### Added

- `delivery: "secretRef"`: one-use, memory-only handle bound to the requesting
  session. Consumed exactly once through `ctx.get('secretRefs').consume(...)`;
  reuse, expiry, unknown handles, and cross-session use are hard errors.
  Expiry uses the host timer service plus a lazy deadline check; the TTL is
  capped at 24 hours.
- `delivery: "file"`: `0600` file in a `0700` per-request directory under
  `os.tmpdir()`. Only the path is returned. POSIX verifies the modes; Windows
  applies `icacls` and reports `windows-acl` or `unrestricted`. Deletion is
  bound to the tool call that names the path, to expiry, and to disposal.
- Card fields `url` (with the destination host shown) and `placeholder`,
  delivery-specific notes, and a remaining-time hint.
- `clientRequestId` idempotency for delivery requests.
- Post-execute scrubbing of the value and its base64, base64url,
  `encodeURIComponent`, and `encodeURI` forms, for the full delivery TTL.
- Fail-closed `block` when a tool result still carries a tracked value in a
  channel that cannot be rewritten (`tool/result.meta`, frozen deferred context,
  error messages).
- Session-log proof test: a real `AgentLoop` + `JsonlSessionPersistence` run
  walks every on-disk artifact and asserts no raw or encoded value.
- CI matrix for Ubuntu and Windows 11.

### Changed

- Standalone packaging: vendored the two private `@dungsil/*` helpers
  (`rpc`, `locale`) that made the upstream package un-installable outside its
  monorepo.
- `dsh` pinned to `0.2.3-alpha.2` exactly.
- Legacy `ref` mode is unchanged in behavior, but its value is now tracked for
  redaction for 24 hours and the card copy no longer promises the agent cannot
  see it.
- Market copy no longer claims the value is never given to the model; the
  README threat model is the accurate statement.

### Security notes

- The plugin does not claim the value can never reach the session log. See
  `README.md#threat-model`, especially R1 (readable path), R2
  (`tool/result.meta`), R3 (denylist redaction), and R6 (legacy plaintext
  store).
- Windows ACL behavior is automated-suite verified on `windows-latest` and
  interactively unverified; see `docs/windows-verification.md`.

Upstream history before the fork is in the upstream repository.
