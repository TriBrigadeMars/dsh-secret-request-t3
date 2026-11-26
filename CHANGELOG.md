# Changelog

## 0.5.0

Fork of `@dungsil/dsh-plugin-tool-secret-request` 0.4.0 into a standalone
package. No behaviour change yet: the same inline card, session+call binding,
timeout, statuses, and credential-store write. Changes in this release are
packaging only:

- Renamed to `dsh-secret-request-t3`; plugin id `t3-secret-request`.
- Vendored the two private `@dungsil/*` helpers (`rpc`, `locale`) so the
  package builds and installs outside the upstream monorepo.
- Pinned `dsh` to `0.2.3-alpha.2` exactly.
- Added `LICENSE.upstream` and `THIRD_PARTY_NOTICES`.

Upstream history before the fork is in the upstream repository.
