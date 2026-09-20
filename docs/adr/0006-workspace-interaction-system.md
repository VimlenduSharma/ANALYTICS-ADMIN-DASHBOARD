# ADR 0006: App-local workspace interaction system

- **Status:** accepted
- **Date:** 2026-09-05

## Context

Authenticated routes need the same navigation, filters, feedback, loading behavior, keyboard model, responsive rules, and display preferences. Implementing those mechanics independently would produce inconsistent recovery paths and make accessibility regressions likely. A component documentation tool must also remain honest without introducing a second application, release surface, or package before the component set has stabilized.

The browser may remember useful display preferences, but script-readable persistence must not become a second store for identity, tenant, or authorization data.

## Decision

1. Keep interface primitives as standalone Angular components in an app-local `shared/ui` boundary. Extract a publishable library only when a second application or independently versioned consumer exists.
2. Let the authenticated shell own global navigation, command entry, organization/date context, appearance, responsive mode changes, skip navigation, route focus, and the toast region.
3. Use Angular Signals for synchronous local interaction state and keep identity/API streams in their existing RxJS boundaries.
4. Use native HTML controls and `<dialog>` wherever their semantics satisfy the behavior. Wrap them narrowly to centralize labels, errors, live regions, dismissal, focus return, and visual tokens.
5. Document components on a protected `/workspace/components` route that imports the production primitives. The catalog participates in the same build, authorization, themes, and browser tests as the product.
6. Persist one validated and versioned preference object containing only theme, motion, and a generic date preset. Keep organization selection in service memory, command text inside the active menu, and authentication state in the server-managed BFF session.
7. Verify one behavior suite against desktop, tablet, and mobile Chromium projects, with viewport screenshots for layout regression and semantic assertions for interactions that pixels cannot prove.

## Consequences

- Overview, Team, and future analytics views share mechanics without hiding their feature-specific decisions.
- Native controls reduce custom accessibility code, although application tests still verify the expected keyboard and focus paths.
- The catalog is smaller and cheaper than an independent Storybook deployment, but it does not yet provide isolated package publishing or visual prop controls.
- Preference storage is easy to audit and cannot silently accumulate organization names, user details, roles, or search text.
- Future filter URL synchronization can be added for shareable analytics queries without changing the storage boundary; tenant access must still be revalidated by the API.
- A dedicated component package or Storybook becomes worthwhile when multiple frontends consume the system or isolated release/version workflows are required.

## Alternatives considered

- **Duplicate state markup in every route:** rejected because semantics and recovery behavior would drift.
- **Persist the entire filter/session object:** rejected because it stores more account context than the user experience requires and can become stale authorization evidence.
- **Build a custom modal and select system:** rejected because the interaction requirements are served more reliably by native elements with focused wrappers.
- **Add Storybook immediately:** deferred because there is one Angular application and no independent component consumer; the protected living catalog gives executable documentation without another configuration and dependency surface.
- **Copy a reference dashboard:** rejected because references inform principles, while this product needs an original interaction model grounded in its data and authorization boundaries.

## Verification

- Unit tests validate preference parsing, defaults, application, and the exact persisted allowlist.
- Playwright uses the real BFF sign-in and organization API before exercising command navigation, accessible validation, error announcements, dialogs, focus restoration, responsive navigation, storage minimization, theme/motion/date restoration, and visual baselines.
- Production build budgets, strict type checking, lint, and formatting remain part of the repository-wide gate.
