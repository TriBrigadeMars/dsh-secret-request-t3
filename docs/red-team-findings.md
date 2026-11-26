# Red-team findings and dispositions

Three independent reviews attacked the plugin. Every finding below is either
fixed with a regression test or documented as a residual risk in
[`README.md#threat-model`](../README.md#threat-model). Nothing is silently
dropped.

Legend: **fixed** = code + test; **documented** = residual with an OS scope;
**verified** = could not be falsified.

## Review 1 (implementation diff, commit `96bbc7e`)

| # | Finding | Disposition |
| --- | --- | --- |
| F1 | `read` persists line text in `tool/result.meta`, which post-execute cannot replace | **fixed** by a `kind:'block'` gate that drops `meta` (`test/block-on-leak.test.mjs`); escaped/split/truncated bypasses fixed later, see Review 3 |
| F2 | `deferContext` and `decision.additionalContexts` carried the value into a `user/message` | **fixed**: scrub both, plus a block fallback when the result is frozen (`test/plugin.test.mjs` F2 tests) |
| F3 | File mode gives the model a readable path; every sandbox permits reads | **documented** R1, R3 |
| F4 | Redaction forgot values after 10 minutes while delivery TTL is up to 24 h | **fixed**: TTL-bound tracking (`test/redact.test.mjs`) |
| F5 | A restart leaves delivered files and forgets the value | **documented** R4 |
| F6 | Windows deletion matcher missed JSON-escaped `C:\` paths | **fixed** (`test/files.test.mjs`); forward-slash spelling documented R10 |
| F7 | `disposeAll` raced an in-flight `create` | **fixed**: disposed flag + awaited disposer (`test/files.test.mjs`) |
| F8 | `ctx.secretRefs` trusts a caller-supplied session id | **documented** R5 |
| F9 | Legacy card copy promised the agent could not see the value | **fixed**: all nine locales (`test/client.test.mjs`) |
| F10 | `error.message` leaked to live observers | **fixed**: scrub + gate |
| F11 | `clientRequestId` replay returns a consumed ref / deleted path | **documented** R14 |
| F12 | Core writes the child environment to `launch-request.json` (Linux) / IPC (Windows) | **documented** R7, source-cited |
| F13 | PTC `value` reaches model code and later arguments are logged | **documented** R9 |
| F14 | Model-controlled `url` can phish | **mitigated** (host shown) + **documented** R11 |
| F15 | An outer listener that rebuilds content from `value` runs outside the scrub | **documented** R2/R8; `finalizeContent` also noted |
| F16 | Spill files might receive the unredacted value | **verified safe from source** (`spill-policy` prepends and spills the post-scrub decision); no local test mounts it — stated in R8 |
| F17 | Secret-shaped strings in the repo or history | **verified none** (`git grep` over all commits) |
| F18 | Tests could be vacuous | **verified**: disabling redaction, one-use, or file cleanup fails real tests |
| F19 | Test coverage missed `meta`, deferred context, `read`, spill, PTC | **fixed** for `meta`/context/`read`; spill and PTC remain source-verified/documented |

## Review 2 (fix verification, commit `c7e3f31`)

| Finding | Disposition |
| --- | --- |
| F1 "unfixable at the plugin layer" was wrong; a block drops `meta` | **fixed** in `slice/5d-block` |
| F2 bypass via frozen `projectContent` result | **fixed**: verify-after-scrub + block |
| Legacy mode never fed the redactor | **fixed**: 24 h tracking |
| Duplicate `add` kept the shorter TTL | **fixed**: later deadline wins |
| Market copy claimed "never to the model" | **fixed**: honest copy in nine locales |
| No README / threat model | **fixed**: `README.md` |
| Windows ACL unexecuted | **partially verified**: CI `windows-latest` reports `windows-acl`; interactive checklist remains |

## Review 3 (final sign-off, commit `baffb06`)

| Finding | Disposition |
| --- | --- |
| Gate checked serialized JSON, so `"` and `\` escaped past it and `meta` leaked the exact value | **fixed**: gate inspects decoded string leaves (`hasMatchInLeaves`), tracks the JSON-escaped form; `test/block-on-leak.test.mjs` |
| Multi-line values split across `meta.lines[]` | **fixed**: each line >= 8 chars and joined leaves are checked |
| Values longer than `read`'s 2000-char cap were truncated past the gate | **fixed**: the 2000-char prefix is tracked and checked |
| On-disk assertions were escape-blind (`text.includes`) | **fixed**: tests parse every JSONL line and scan decoded strings (`test/decoded-strings.mjs`) |
| Windows count was not stated (3 POSIX-only skips) | **documented** in README status/verification |
| "value is zeroed" overstated | **corrected**: logical erasure, not memory zeroing |
| Deletion trigger wording (`meta`/`value` do not trigger) | **corrected** |
| `grep -A2` could not print the `# ==` header | **corrected** to `grep -B1 -A2` |
| Negative control wording implied scrub-only | **corrected**: scrub + block disabled |
| `npm ci` pulls native transitive dev packages | **corrected**: published package has zero deps and JS only |
| Two test imports resolved only by hoisting | **fixed**: explicit devDependencies |
| `docs/windows-verification.md` called the ACL a "guarantee" | **corrected** to applied-and-reported, never re-read |
| `engines.dsh` is non-standard | **noted**; the exact pins in `peerDependencies`/`devDependencies` are what npm enforces |

## What is still not claimed

- No claim that the value can never reach a log through an arbitrary command,
  transform, or a cap other than 2000 characters.
- No claim of interactive Windows 11 verification.
- No claim that redaction covers encodings outside its tracked set.
- No claim that a trusted host plugin cannot misuse `ctx.secretRefs`.
