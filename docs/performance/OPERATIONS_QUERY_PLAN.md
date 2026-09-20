# Operations issue-query acceptance

## Target

The representative boundary is an organization with 50,000 open orders. A request for the first ten backlog issues across the fixture's 31-day range must:

- return ten stable rows and a next-page cursor;
- preserve organization and filter isolation; and
- complete below 2,000 ms in the local PostgreSQL 17 integration environment.

The issue query uses a bounded keyset page rather than offset pagination. The supporting order timeline, organization/status, fulfilment, return, inventory-risk, and location indexes are installed by versioned migrations; forced row-level security remains active for tenant business tables.

## Recorded evidence

On 2026-09-11, the final uncached integration fixture inserted and analyzed 50,000 organization-scoped open orders. The compiled API returned the first ten backlog issues in **627.29 ms** against the documented 2,000 ms local target.

The fixture creates an isolated organization on every run and removes it afterward. It calls the authenticated public endpoint rather than timing a simplified presentation query, so request validation, authorization, tenant context, deadline construction, issue ordering, serialization, and cursor generation are included in the measurement.

## Interpretation

This result proves a reproducible local dataset boundary, not production capacity. The mixed-load profile measures concurrent latency and connection-pool behavior; production-like staging evidence still determines whether query restructuring, maintained rollups, partitioning, or caching is warranted.
