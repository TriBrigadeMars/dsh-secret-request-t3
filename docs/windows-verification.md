# Windows 11 verification

CI runs the full automated suite on `windows-latest` and the latest run
reported:

```
file delivery atRest=windows-acl platform=win32
verify (windows-latest): success
```

That covers creating a private directory/file, the `icacls` branch, deletion on
consumer success and failure, expiry, disposal, and the session-log assertions.
It does **not** cover an interactive Windows 11 desktop: ACL semantics under a
localized or domain account, `icacls` missing from `PATH`, Explorer/AV behavior,
or path spellings a real shell produces. Those remain manual. Do not describe
the plugin as fully verified on Windows until the items below are run and
recorded.

## Setup

1. Install Node 26 (matching `engines.node`) and Git.
2. In a clean clone run `npm ci`. Do not reuse `node_modules` from another OS.
3. Run `npm run verify`. On Windows the POSIX `0700`/`0600` assertions are
   skipped or replaced by the Windows expectation.

## Confirm the ACL guarantee

Use the plugin through a DSH web UI, or a scratch script that mirrors
`test/plugin.test.mjs`, and call `request_secret` with `delivery: "file"`.
After submitting the value, record the tool result:

- [ ] `result.atRest === 'windows-acl'`
- [ ] If it is `'unrestricted'`, record exactly why (`icacls` missing from
      `PATH`, access denied, unknown username, or another error). Delivery must
      still succeed; hardening never discards the user's submission.

There is no `0700`/`0600` equivalent on NTFS. The equivalent guarantee is that
inherited ACEs are removed and only the current account has full control:

```powershell
icacls "$env:TEMP\dsh-secret-<suffix>"
icacls "$env:TEMP\dsh-secret-<suffix>\secret"
```

- [ ] Both listings show the inheritance marker removed (`(I)` entries gone)
      and `<USERNAME>:F` present.
- [ ] Paste the full output of both `icacls` commands into the PR or issue.

## Confirm deletion interactively

- [ ] **Consume success:** run a tool that reads the returned `path`. After the
      tool call settles, `Test-Path` is `False` for the file and its directory.
      Note: the block-on-leak gate refuses a `read` that returns the value; use
      a command that consumes the file without echoing it.
- [ ] **Consume failure:** run a tool that reads the file and then throws. After
      the failed call settles, `Test-Path` is `False` for both.
- [ ] **Expiry:** call with `timeoutMs: 1000`, save, wait more than a second
      without consuming. `Test-Path` is `False` for both.
- [ ] **Unrelated call:** run a tool that never names the path. The file is
      still present until consumed or expired.
- [ ] **Cross-session:** a tool call in a different session that names the path
      does not delete it.
- [ ] **Plugin dispose:** unload the plugin. The file and directory are gone.
- [ ] **Forward slashes:** confirm what a `C:/…` spelling does. The matcher
      matches the raw and JSON-escaped backslash spellings, not the
      forward-slash spelling; such a file survives until expiry by design.

## Record

Attach to the PR:

- Windows version and Node version.
- `npm run verify` tail.
- The `atRest` value observed.
- Full `icacls` output for the directory and the file.
- Any deviation from the checklist.

Commands promoted outside the DSH tool executor are not observed by the
post-execute hook; their files survive until expiry. That limitation is
documented in the tool description and the README threat model.
