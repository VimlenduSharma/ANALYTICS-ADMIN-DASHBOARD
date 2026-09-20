import type { Environment } from '@analytics-admin/config';
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  RequestTimeoutException,
  type NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TimeoutError, catchError, throwError, timeout } from 'rxjs';

@Injectable()
export class RequestTimeoutInterceptor implements NestInterceptor {
  private readonly timeoutMs: number;

  constructor(config: ConfigService<Environment, true>) {
    this.timeoutMs = config.getOrThrow('API_REQUEST_TIMEOUT_MS');
  }

  intercept(_context: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(
      timeout(this.timeoutMs),
      catchError((error: unknown) =>
        throwError(() =>
          error instanceof TimeoutError
            ? new RequestTimeoutException({
                code: 'REQUEST_TIMEOUT',
                message: 'The request exceeded its execution budget',
              })
            : error,
        ),
      ),
    );
  }
}
