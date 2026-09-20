import { Route } from '@angular/router';
import {
  authenticatedGuard,
  invitationGuard,
  organizationMemberGuard,
  teamManagerGuard,
} from './identity/auth.guards';

export const appRoutes: Route[] = [
  {
    path: 'sign-in',
    data: {
      title: 'Sign in | Analytics Admin',
      description: 'Sign in to your private Analytics Admin workspace.',
    },
    loadComponent: () =>
      import('./pages/sign-in/sign-in').then(({ SignInPage }) => SignInPage),
  },
  {
    path: 'access-denied',
    data: {
      title: 'Access denied | Analytics Admin',
      description: 'This organization or action is outside your access.',
    },
    loadComponent: () =>
      import('./pages/access-denied/access-denied').then(
        ({ AccessDeniedPage }) => AccessDeniedPage,
      ),
  },
  {
    path: '',
    canActivate: [authenticatedGuard],
    data: {
      title: 'Overview | Analytics Admin',
      description: 'Review your organization scope and service readiness.',
    },
    loadComponent: () =>
      import('./pages/home/home').then(({ HomePage }) => HomePage),
  },
  {
    path: 'organizations/:organizationId/sales',
    canActivate: [authenticatedGuard, organizationMemberGuard],
    data: {
      title: 'Sales | Analytics Admin',
      description: 'Explore reconciled sales trends, orders, and segments.',
    },
    loadComponent: () =>
      import('./pages/sales/sales').then(({ SalesPage }) => SalesPage),
  },
  {
    path: 'organizations/:organizationId/operations',
    canActivate: [authenticatedGuard, organizationMemberGuard],
    data: {
      title: 'Operations | Analytics Admin',
      description: 'Review fulfilment, inventory, service risk, and alerts.',
    },
    loadComponent: () =>
      import('./pages/operations/operations').then(
        ({ OperationsPage }) => OperationsPage,
      ),
  },
  {
    path: 'organizations/:organizationId/team',
    canActivate: [authenticatedGuard, teamManagerGuard],
    data: {
      title: 'Team access | Analytics Admin',
      description: 'Manage authorized organization members and roles.',
    },
    loadComponent: () =>
      import('./pages/team/team').then(({ TeamPage }) => TeamPage),
  },
  {
    path: 'organizations/:organizationId/accept-invitation',
    canActivate: [invitationGuard],
    data: {
      title: 'Accept invitation | Analytics Admin',
      description:
        'Accept access to an organization with a one-time invitation.',
    },
    loadComponent: () =>
      import('./pages/accept-invitation/accept-invitation').then(
        ({ AcceptInvitationPage }) => AcceptInvitationPage,
      ),
  },
  {
    path: 'organizations/:organizationId/governance',
    canActivate: [authenticatedGuard, teamManagerGuard],
    data: {
      title: 'Governance | Analytics Admin',
      description:
        'Manage data sources, retention, privacy jobs, and audit history.',
    },
    loadComponent: () =>
      import('./pages/governance/governance').then(
        ({ GovernancePage }) => GovernancePage,
      ),
  },
  {
    path: 'profile',
    canActivate: [authenticatedGuard],
    data: {
      title: 'Profile | Analytics Admin',
      description: 'Update your private profile and regional preferences.',
    },
    loadComponent: () =>
      import('./pages/profile/profile').then(({ ProfilePage }) => ProfilePage),
  },
  {
    path: 'workspace/components',
    canActivate: [authenticatedGuard],
    data: {
      title: 'Interface patterns | Analytics Admin',
      description: 'Explore consistent application interaction patterns.',
    },
    loadComponent: () =>
      import('./pages/component-catalog/component-catalog').then(
        ({ ComponentCatalogPage }) => ComponentCatalogPage,
      ),
  },
  {
    path: '**',
    data: {
      title: 'Page not found | Analytics Admin',
      description: 'The requested Analytics Admin page could not be found.',
    },
    loadComponent: () =>
      import('./pages/not-found/not-found').then(
        ({ NotFoundPage }) => NotFoundPage,
      ),
  },
];
