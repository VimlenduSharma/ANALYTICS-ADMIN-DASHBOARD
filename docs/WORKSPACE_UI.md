# Workspace interaction system

The workspace establishes one responsive and accessible language for every authenticated view. It contains no synthetic sales metrics or seeded company data: the Overview and Team routes render the signed-in user's real organizations, permissions, and service state.

## Composition

The application shell owns interactions that must remain consistent across routes:

- primary navigation for Overview, role-gated Team access, and Interface Patterns;
- a global command menu opened by `Control+K` or `Command+K`;
- organization and date-range context;
- light/dark theme and system/reduced-motion choices;
- route focus management, skip navigation, and responsive mobile navigation; and
- one global toast announcement region.

Feature views compose standalone Angular primitives from `apps/web/src/app/shared/ui`:

| Primitive          | Contract                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------ |
| `aad-field`        | Native label association, description/error linkage, required state, and `aria-invalid`    |
| `aad-banner`       | Persistent contextual feedback with polite status or assertive error semantics             |
| `aad-state-panel`  | Loading, empty, stale, partial, error, and success states with an optional recovery action |
| `aad-dialog`       | Native modal focus containment, Escape/backdrop dismissal, and focus restoration           |
| `aad-toast-region` | Bounded, short-lived result announcements shared across routes                             |

The protected `/workspace/components` route is the component documentation. It renders these production components directly, so examples cannot silently diverge from the application implementation.

## Context and persistence

Persistence follows a data-minimization boundary rather than serializing the workspace state wholesale.

| Value                  | Lifetime                              | Reason                                                                |
| ---------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| Theme                  | Browser local storage                 | Non-sensitive display preference                                      |
| Motion preference      | Browser local storage                 | Non-sensitive accessibility preference                                |
| Date preset            | Browser local storage                 | Generic reporting preference without a customer or account identifier |
| Organization selection | Current application session           | Tenant identity is not written to script-readable persistent storage  |
| Command query          | Open command-menu instance            | Search intent is discarded when the interaction ends                  |
| User/session/roles     | Server session and in-memory response | Authentication state never enters local storage                       |

The preference service accepts only known values and rewrites one versioned object containing exactly `theme`, `motion`, and `datePreset`. Invalid JSON, unavailable storage, and unknown values fall back safely. Authorization still comes from the server; selecting an organization in the interface does not grant access to it.

## Accessibility contract

- A skip link moves directly to the main route region.
- Route changes move focus to the main content without animated scroll.
- Command results expose combobox/listbox semantics and support Arrow keys, Home, End, Enter, and Escape.
- Every field has a persistent visible label. Validation changes both the described message and `aria-invalid` state.
- Errors use assertive announcements; informational, warning, success, and loading updates are polite.
- Dialogs use the native modal element and return focus to their trigger when dismissed.
- Touch is not dependent on hover, visible focus is global, and narrow layouts retain the same authorized destinations.
- Reduced motion can follow the operating system or be explicitly selected. The reduced option removes non-essential transitions and smooth movement.

## Responsive behavior

- Desktop uses a three-part top bar, context row, and full sidebar.
- Tablet retains persistent navigation while content grids reduce columns and controls wrap at component boundaries.
- Mobile condenses the brand/actions, stacks global filters, removes the sidebar, and supplies fixed bottom navigation with safe content clearance.
- The shell prevents whole-page horizontal overflow. Individual future data grids must implement their own priority-column or record-card strategy.

## Feedback and data-state policy

Loading reserves the final content area. Empty explains what is absent and how real data can arrive. Stale and partial preserve usable content while naming trust limitations. Error gives a safe recovery action without internal details. Success confirms completion without requiring a toast for every normal transition.

Toasts report outcomes a user could otherwise miss. Banners explain persistent route context. Validation stays next to the field. Dialogs are reserved for decisions that require interruption or confirmation.

## Verification

Run the full repository gates:

```bash
pnpm check
pnpm integration
pnpm openapi:check
pnpm e2e
```

The browser suite executes the signed local OIDC flow and creates disposable real organizations through the API. It then verifies keyboard command navigation, display-preference restoration, storage minimization, role-aware routes, semantic feedback and validation, modal dismissal/focus restoration, landmarks, responsive navigation, horizontal-overflow prevention, and visual baselines at desktop, tablet, and mobile sizes. Global teardown removes generated identities, organizations, sessions, and audit data.
