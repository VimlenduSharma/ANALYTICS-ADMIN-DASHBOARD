import type { Environment } from '@analytics-admin/config';
import {
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  Header,
  Injectable,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { MetricsService } from './metrics.service';

@Injectable()
export class MetricsGuard implements CanActivate {
  private readonly expected?: string;

  constructor(config: ConfigService<Environment, true>) {
    this.expected = config.get('METRICS_BEARER_TOKEN');
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.expected) return true;
    const header = context.switchToHttp().getRequest<FastifyRequest>()
      .headers.authorization;
    const provided = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (safeEqual(provided, this.expected)) return true;
    throw new UnauthorizedException({
      code: 'METRICS_AUTH_REQUIRED',
      message: 'A monitoring credential is required',
    });
  }
}

@ApiTags('Observability')
@Controller({ path: 'observability', version: '1' })
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('metrics')
  @UseGuards(MetricsGuard)
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  @ApiBearerAuth('metrics')
  @ApiOkResponse({ schema: { type: 'string' } })
  metricsDocument(): string {
    return this.metrics.render();
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
