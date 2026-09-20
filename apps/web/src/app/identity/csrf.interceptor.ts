import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { CsrfTokenStore } from './csrf-token.store';

const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const csrfInterceptor: HttpInterceptorFn = (request, next) => {
  const token = inject(CsrfTokenStore).token();
  const secured = request.clone({
    setHeaders:
      token && unsafeMethods.has(request.method)
        ? { 'X-CSRF-Token': token }
        : {},
    withCredentials: true,
  });
  return next(secured);
};
