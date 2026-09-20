# Contributing

Keep each change focused on one product or operational outcome. Cross-boundary dependencies should be explicit in the pull request and backed by the relevant contract or architecture decision.

## Before opening a change

1. Read `docs/ENGINEERING_STANDARDS.md` and the relevant architecture decisions.
2. Keep credentials, personal notes, customer data, and private URLs outside tracked files.
3. Add tests at the narrowest boundary that proves the behaviour.
4. Run `pnpm check`; run `pnpm e2e` when browser or API behaviour changes.
5. Update documentation when a command, contract, or operational assumption changes.

Prefer focused functions and shared mechanics over line-count targets. Domain rules and test scenarios must remain explicit even when helpers remove repetition.
