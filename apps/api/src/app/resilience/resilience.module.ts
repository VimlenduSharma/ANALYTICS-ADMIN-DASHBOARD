import { Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { MetricsController, MetricsGuard } from './metrics.controller';
import { MetricsInterceptor } from './metrics.interceptor';
import { MetricsService } from './metrics.service';
import { RateLimitGuard } from './rate-limit.guard';
import { RateLimitService } from './rate-limit.service';
import { RequestTimeoutInterceptor } from './request-timeout.interceptor';
import { ResponseCacheService } from './response-cache.service';

@Global()
@Module({
  controllers: [MetricsController],
  exports: [MetricsService, ResponseCacheService],
  providers: [
    MetricsGuard,
    MetricsService,
    RateLimitService,
    ResponseCacheService,
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_INTERCEPTOR, useClass: RequestTimeoutInterceptor },
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
  ],
})
export class ResilienceModule {}
