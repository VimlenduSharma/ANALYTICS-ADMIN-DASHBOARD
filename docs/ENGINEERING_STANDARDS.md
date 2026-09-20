# Engineering Standards

## Purpose

The codebase should read like the work of a careful product engineering team: specific to the domain, easy to inspect, safe to change, and supported by evidence. Optimization means reducing accidental complexity or measured resource cost without hiding behaviour.

> Reusable helpers contain mechanics; product code and tests make behaviour visible.

## Order of priorities

When two approaches compete, decide in this order:

1. Correctness and data integrity
2. Security and tenant isolation
3. Readability and explicit behaviour
4. Testability and operability
5. Measured runtime or resource performance
6. Reuse that reduces maintenance cost
7. Line count

An implementation is not better merely because it is shorter. Dense one-liners, generic abstractions, or hidden control flow that reduce lines while increasing interpretation cost will be rejected.

## Code design rules

### Keep domain behaviour explicit

- Use business language such as `order`, `fulfilment`, `inventoryMovement`, and `organization`, not generic names such as `data`, `item`, or `manager` when a precise name exists.
- Keep authorization decisions, transaction boundaries, money calculations, and state transitions visible at the call site or behind a clearly named domain operation.
- Prefer one cohesive function over a chain of tiny helpers that forces the reader to jump between files.
- Use early returns to keep the main path clear; avoid deeply nested branches and nested ternaries.
- Comments explain constraints, decisions, and non-obvious risks. They do not translate the next line into English.

### Remove accidental repetition

- Extract a helper when repeated code represents the same stable mechanic and the helper can be named precisely.
- Keep superficially similar code separate when the business rules or reasons for change differ.
- Apply the rule of three as a default signal, not a ritual. Security-sensitive or protocol mechanics may be centralized earlier to prevent drift.
- Use named constants for shared protocol values, limits, and timeouts. Do not create constants for values that are clearer in their local context.
- Delete dead code, stale feature flags, unused imports, commented-out implementations, and abandoned compatibility paths.

### Avoid speculative abstraction

- Do not introduce repositories, factories, facades, event buses, or generic utility layers until they own a real boundary or repeated responsibility.
- A shared helper must have a narrow contract and a meaningful name. Helpers such as `handleData`, `process`, or `utils` are design warnings.
- Prefer composition to inheritance. Use framework extension points only when they simplify a real cross-cutting concern.
- Do not create a shared module merely because two files contain similar syntax.

### Model data with types

- Enable strict TypeScript, including unchecked-index and exact-optional-property checks where compatible with the toolchain.
- Avoid `any`, unsafe type assertions, non-null assertions, and loosely typed dictionaries. A justified exception must be isolated at an external boundary and validated immediately.
- Construct JSON through typed objects and serializers; never build request or response JSON with string interpolation.
- Represent money in minor units plus ISO currency, timestamps as explicit UTC instants, and identifiers with domain-specific types where useful.
- Parse untrusted values once at the boundary and pass validated domain values inward.

## Angular rules

- Components own one clear UI responsibility. Feature state, remote data, and presentation are separated only where the separation makes the flow easier to follow.
- Use Signals and computed values for synchronous derived view state. Do not store a second mutable copy of data that can be derived.
- Use RxJS for cancellation, event streams, and multi-source asynchronous composition; avoid nested subscriptions and manual subscription bookkeeping.
- Lazy-load feature routes, track repeated template items by stable identity, and keep expensive work out of templates.
- Centralize HTTP concerns such as base URLs, credentials, correlation IDs, retry eligibility, and error normalization in interceptors or the generated API client.
- Reuse accessible primitives for focus, overlays, dialogs, menus, and form errors rather than recreating interaction mechanics per page.
- Do not force every component through a facade or global store. State remains as local as its consumers allow.

## NestJS and data-service rules

- Controllers translate HTTP contracts; they do not contain business workflows or persistence logic.
- Services coordinate domain behaviour and transaction boundaries. Persistence adapters own queries and database-specific details.
- Validate every external boundary and reject unknown or forbidden properties according to the endpoint contract.
- Use one error-mapping layer instead of repeated controller `try/catch` blocks. Preserve error causes in server telemetry without leaking internals to clients.
- Parameterize queries, cap list sizes, require pagination, set timeouts, and inspect query plans for high-volume paths.
- Keep request handlers bounded. Imports, exports, aggregation refreshes, and connector synchronization run as resumable background jobs.
- Make retried commands idempotent and make side effects observable through durable state, not process memory.

## Test-code rules

Test code receives the same design care as production code.

- Tests state behaviour through clear arrange/act/assert sections and names that describe the user-visible or contract outcome.
- Helpers may create authenticated clients, headers, typed request bodies, persisted records, or normalized timestamps. The scenario and its meaningful assertions remain in the test.
- Use typed builders with sensible defaults and explicit overrides for repeated setup. Builders must not hide values relevant to the behaviour under test.
- Use parameterized tests when inputs and expected outcomes vary but the behaviour and assertion shape are genuinely the same.
- Load immutable expensive fixtures once per appropriate suite when isolation is preserved; never trade test independence for a cosmetic speedup.
- Prefer integration tests with real PostgreSQL and Redis services for persistence, transaction, locking, queue, and cache behaviour.
- Do not weaken assertions, merge distinct scenarios, or mock away a production boundary merely to reduce lines or runtime.

## Performance rules

- Measure before and after optimizing. Record the workload, dataset size, environment, metric, and result.
- Use algorithmic analysis where CPU or memory growth matters. Do not claim a Big-O improvement for code dominated by fixed network, database, container, or file-system operations.
- Profile database calls, payload size, render work, change detection, bundle cost, queue depth, and external latency before adding caches or concurrency.
- Cache only with an owner, key definition, invalidation rule, maximum age, and stale-data behaviour.
- Optimize hot paths without compressing ordinary code into clever syntax.

## Human product language

- UI copy is concise, concrete, and appropriate for sales and operations work.
- Empty and error states explain what happened, whether existing data is safe, and what the user can do next.
- Avoid generic promotional phrases, fake testimonials, placeholder company names, and text that refers to an assistant or generated implementation.
- Examples in documentation must be clearly labelled and use fictional, non-sensitive values.
- Code, documentation, commit messages, and API descriptions must explain the product rather than narrate how they were generated.

## Review triggers

These are prompts for review, not arbitrary failure thresholds:

- a function mixes validation, authorization, persistence, and response formatting;
- a component coordinates unrelated workflows or has multiple independent reasons to change;
- the same protocol/setup sequence appears repeatedly;
- a helper needs many boolean flags or accepts/returns weakly typed objects;
- a test hides its scenario inside fixtures or asserts several unrelated behaviours;
- an optimization lacks a benchmark, trace, profile, or query-plan comparison;
- a shorter implementation makes failure modes or domain rules harder to identify.

## Automated enforcement

Repository automation enforces the standards that tools can judge reliably:

- strict compiler options and Nx module boundaries;
- formatting, linting, unused-code detection, and import rules;
- dependency and cycle checks;
- test, coverage, build, and secret-scanning CI gates;
- pull-request checklist for domain clarity, security, accessibility, tests, and measured performance;
- architecture decision records for consequential abstractions or dependencies.

Automated metrics will support review, not replace engineering judgment. We will not optimize against a line-count quota.
