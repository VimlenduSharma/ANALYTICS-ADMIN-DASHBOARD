import type { Environment } from '@analytics-admin/config';
import {
  ForbiddenException,
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly expectedOrigin: string;

  constructor(config: ConfigService<Environment, true>) {
    this.expectedOrigin = new URL(config.getOrThrow('WEB_ORIGIN')).origin;
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (safeMethods.has(request.method)) return true;

    if (request.headers.origin !== this.expectedOrigin) {
      throw new ForbiddenException({
        code: 'CSRF_ORIGIN_INVALID',
        message: 'The request origin is not permitted',
      });
    }

    const expected = request.identity?.session.csrfToken;
    const supplied = request.headers['x-csrf-token'];
    if (
      !expected ||
      typeof supplied !== 'string' ||
      !safeEqual(expected, supplied)
    ) {
      throw new ForbiddenException({
        code: 'CSRF_INVALID',
        message: 'The request security token is missing or expired',
      });
    }
    return true;
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
