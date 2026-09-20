import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { tap } from 'rxjs';
import { MetricsService } from './metrics.service';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const startedAt = performance.now();
    const route = request.routeOptions.url || normalizedRoute(request.url);
    let observed = false;
    const observe = (status: number) => {
      if (observed) return;
      observed = true;
      this.metrics.observeRequest(
        request.method,
        route,
        status,
        performance.now() - startedAt,
      );
    };

    return next.handle().pipe(
      tap({
        complete: () => observe(reply.statusCode),
        error: (error: unknown) =>
          observe(error instanceof HttpException ? error.getStatus() : 500),
      }),
    );
  }
}

function normalizedRoute(url: string): string {
  return (url.split('?', 1)[0] ?? url).replaceAll(
    /\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi,
    '/:id',
  );
}
