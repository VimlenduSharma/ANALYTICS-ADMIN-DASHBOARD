import { inject } from '@angular/core';
import type { CanActivateFn } from '@angular/router';
import { Router } from '@angular/router';
import { SessionService } from './session.service';

export const authenticatedGuard: CanActivateFn = async (_, state) => {
  const session = inject(SessionService);
  const router = inject(Router);
  const result = await session.ensureLoaded();
  return result.kind === 'authenticated'
    ? true
    : router.createUrlTree(['/sign-in'], {
        queryParams: { returnTo: state.url },
      });
};

export const invitationGuard: CanActivateFn = async () => {
  const result = await inject(SessionService).ensureLoaded();
  return result.kind === 'authenticated'
    ? true
    : inject(Router).createUrlTree(['/sign-in'], {
        queryParams: { invitation: 'reopen' },
      });
};

export const organizationMemberGuard: CanActivateFn = async (route) => {
  const session = inject(SessionService);
  const router = inject(Router);
  const result = await session.ensureLoaded();
  if (result.kind !== 'authenticated') {
    return router.createUrlTree(['/sign-in']);
  }
  return result.session.organizations.some(
    ({ id }) => id === route.paramMap.get('organizationId'),
  )
    ? true
    : router.createUrlTree(['/access-denied']);
};

export const teamManagerGuard: CanActivateFn = async (route) => {
  const session = inject(SessionService);
  const router = inject(Router);
  const result = await session.ensureLoaded();
  if (result.kind !== 'authenticated') {
    return router.createUrlTree(['/sign-in']);
  }

  const organizationId = route.paramMap.get('organizationId');
  const membership = result.session.organizations.find(
    ({ id }) => id === organizationId,
  );
  return membership?.role === 'OWNER' || membership?.role === 'ADMIN'
    ? true
    : router.createUrlTree(['/access-denied']);
};
