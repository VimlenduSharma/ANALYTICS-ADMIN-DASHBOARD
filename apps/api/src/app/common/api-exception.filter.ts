import type { ApiError } from '@analytics-admin/contracts';
import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';

const statusCodes: Partial<Record<HttpStatus, string>> = {
  [HttpStatus.BAD_REQUEST]: 'INVALID_REQUEST',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.FORBIDDEN]: 'ACCESS_DENIED',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.REQUEST_TIMEOUT]: 'REQUEST_TIMEOUT',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'SERVICE_UNAVAILABLE',
  [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMITED',
  [HttpStatus.UNAUTHORIZED]: 'AUTH_REQUIRED',
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<FastifyRequest>();
    const reply = context.getResponse<FastifyReply>();
    const requestId = request.id || randomUUID();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const response =
      exception instanceof HttpException ? exception.getResponse() : undefined;
    const details = recordValue(response, 'details');
    const body: ApiError = {
      code:
        stringValue(response, 'code') ??
        statusCodes[status as HttpStatus] ??
        'INTERNAL_ERROR',
      ...(details ? { details } : {}),
      message:
        status === HttpStatus.INTERNAL_SERVER_ERROR
          ? 'The request could not be completed'
          : (stringValue(response, 'message') ?? messageForStatus(status)),
      requestId,
    };

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} failed [${requestId}]`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    reply.header('x-request-id', requestId).status(status).send(body);
  }
}

function stringValue(
  value: object | string | undefined,
  key: string,
): string | undefined {
  if (!value || typeof value === 'string' || !(key in value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

function recordValue(
  value: object | string | undefined,
  key: string,
): Record<string, unknown> | undefined {
  if (!value || typeof value === 'string' || !(key in value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return isRecord(candidate) ? candidate : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageForStatus(status: number): string {
  return status === HttpStatus.UNAUTHORIZED
    ? 'Sign in is required'
    : 'The request is not permitted';
}
