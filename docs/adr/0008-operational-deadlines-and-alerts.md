# ADR 0008: Deterministic operational deadlines and alerts

- **Status:** accepted
- **Date:** 2026-09-11

## Context

Operational metrics become misleading when each card applies a different clock, timezone, cutoff, or source population. The product also needs organization-specific thresholds, traceable alerts, and usable issue lists without giving the browser authority to infer business policy or aggregate unrestricted source records.

## Decision

1. Calculate each Operations overview directly from normalized committed records inside one tenant-scoped, read-only `REPEATABLE READ` transaction and use PostgreSQL's transaction timestamp as the request clock.
2. Store one validated threshold policy per organization. Use integer minutes, quantities, and basis points at the persistence and API boundaries.
3. Resolve each service deadline in the location's valid IANA timezone, falling back to the organization's policy timezone for missing or invalid legacy values. Orders later than the local cutoff roll to the next calendar date before the target duration is added.
4. Keep open overdue backlog separate from shipped-order service-level performance. Define all Operations metrics and denominators in the public product contract.
5. Derive alerts from the same overview snapshot. Persist acknowledgements separately from source risk and audit acknowledgements, reopen actions, and policy changes.
6. Expose issue drill-down through stable keyset pagination. Bind opaque cursors to their filter context and cap pages at 100 rows.
7. Retain forced PostgreSQL row-level security beneath API authorization. Treat representative query measurements as an acceptance gate and defer caches or maintained rollups until evidence requires them.

## Consequences

- Cards, location views, alerts, and issues share one policy vocabulary and can be reconciled to source records.
- Database timezone rules make daylight-saving behavior deterministic and independently testable.
- Acknowledging an alert records workflow intent without mutating or hiding the underlying order or inventory condition.
- Direct normalized-table queries keep ingestion and backfills simple at the current scale. Precomputed read models remain conditional on production-like concurrency and cardinality evidence.
- Calendar-day rollover is explicit. Business calendars, holidays, carrier schedules, and product-specific service promises require a future policy model rather than implicit date arithmetic.

## Alternatives considered

- **Browser-side deadline and metric calculation:** rejected because client clocks, locale libraries, and partial result sets can disagree and cannot enforce tenant boundaries.
- **One global timezone and policy:** rejected because service commitments and data freshness differ by organization and location.
- **Delete acknowledged alerts:** rejected because acknowledgement is a workflow state, not evidence that source risk disappeared.
- **Offset pagination:** rejected because large offsets scan growing prefixes and concurrent ingestion can shift subsequent pages.
- **Immediate operational cubes:** deferred until representative measurements justify refresh, repair, and backfill complexity.

## Verification

The integration gate independently reconciles metrics, checks exact-at-cutoff and after-cutoff behavior, exercises organization policy validation and isolation, verifies all alert categories and their audited lifecycle, proves source health states, checks cursor boundaries, forces row-level-security reads, validates OpenAPI exposure, and measures the real 50,000-order issue query.
