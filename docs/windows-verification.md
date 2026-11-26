# Windows 11 verification

**Not executed by the implementer.** Slice 2 was developed and verified on Linux
only. The Windows ACL path, the `atRest: 'windows-acl'` guarantee, and the
Windows test expectations in `test/files.test.mjs` and `test/plugin.test.mjs`
therefore still need a human run on a real Windows 11 machine. Do not claim
Windows support until every item below has been run and the output recorded.

## Setup

1. Install Node 26 (matching `engines.node`) and Git.
2. In a clean clone of this branch run `npm ci`. Do not reuse `node_modules`
   from another OS.
3. Run `npm run verify`. Build, typecheck, and both test files must pass. On
   Windows the POSIX `0700`/`0600` assertions are skipped or replaced by the
   Windows expectation, so a pass here is expected even without POSIX modes.

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

## Confirm deletion

- [ ] **Consume success:** run a tool that reads the returned `path`. After the
      tool call settles, `Test-Path` is `False` for the file and for its
      directory.
- [ ] **Consume failure:** run a tool that reads the file and then throws. After
      the failed call settles, `Test-Path` is `False` for the file and for its
      directory.
- [ ] **Expiry:** call with `timeoutMs: 1000`, save, wait more than a second
      without consuming. `Test-Path` is `False` for the file and directory.
- [ ] **Unrelated call:** run a tool that never names the path. The file is
      still present until it is consumed or expires.
- [ ] **Cross-session:** a tool call in a different session that names the path
      does not delete it.
- [ ] **Plugin dispose:** unload the plugin. The file and directory are gone.

## Record

Attach to the PR:

- Windows version and Node version.
- `npm run verify` tail.
- The `atRest` value observed.
- Full `icacls` output for the directory and the file.
- Any deviation from the checklist.

Commands promoted outside the DSH tool executor are not observed by the
post-execute hook; their files survive until expiry. That limitation is
documented in the tool description, not fixed by the Windows run.
