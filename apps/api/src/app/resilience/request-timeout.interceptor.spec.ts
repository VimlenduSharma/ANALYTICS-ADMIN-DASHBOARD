import type { Environment } from '@analytics-admin/config';
import { RequestTimeoutException, type CallHandler } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { firstValueFrom, NEVER } from 'rxjs';
import { RequestTimeoutInterceptor } from './request-timeout.interceptor';

describe('RequestTimeoutInterceptor', () => {
  afterEach(() => jest.useRealTimers());

  it('turns an unbounded handler into a predictable timeout response', async () => {
    jest.useFakeTimers();
    const config = {
      getOrThrow: jest.fn().mockReturnValue(100),
    } as unknown as ConfigService<Environment, true>;
    const next = { handle: () => NEVER } as CallHandler;
    const result = firstValueFrom(
      new RequestTimeoutInterceptor(config).intercept({} as never, next),
    );
    const assertion = expect(result).rejects.toBeInstanceOf(
      RequestTimeoutException,
    );

    await jest.advanceTimersByTimeAsync(100);
    await assertion;
  });
});
