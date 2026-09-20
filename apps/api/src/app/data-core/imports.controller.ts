import type { Environment } from '@analytics-admin/config';
import { ImportQueueService, type ImportJob } from '@analytics-admin/data-core';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBody,
  ApiAcceptedResponse,
  ApiConsumes,
  ApiCookieAuth,
  ApiHeader,
  ApiOperation,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseRequest } from '../common/validation';
import { AuthGuard } from '../identity/auth.guard';
import { CsrfGuard } from '../identity/csrf.guard';
import { requestIdentity } from '../identity/request-identity';
import { Roles, RolesGuard } from '../identity/roles.guard';
import { ResponseCacheService } from '../resilience/response-cache.service';
import { importJobOpenApiSchema } from './openapi-schemas';

const idempotencyKeySchema = z.string().trim().min(8).max(200);
const filenameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/\.csv$/i);
const identifierSchema = z.uuid();

@ApiTags('CSV imports')
@ApiCookieAuth('session')
@Controller({
  path: 'organizations/:organizationId/data/imports',
  version: '1',
})
@UseGuards(AuthGuard, CsrfGuard, RolesGuard)
@Roles('OWNER', 'ADMIN', 'ANALYST')
export class ImportsController {
  private readonly maxBytes: number;

  constructor(
    private readonly cache: ResponseCacheService,
    config: ConfigService<Environment, true>,
    private readonly imports: ImportQueueService,
  ) {
    this.maxBytes = config.getOrThrow('IMPORT_MAX_BYTES');
  }

  @Post('orders')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Queue an atomic order CSV import' })
  @ApiConsumes('text/csv')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-Import-Filename', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({ schema: { format: 'binary', type: 'string' } })
  @ApiAcceptedResponse({ schema: importJobOpenApiSchema })
  async enqueue(
    @Param('organizationId') organizationId: string,
    @Headers('idempotency-key') rawIdempotencyKey: unknown,
    @Headers('x-import-filename') rawFilename: unknown,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<ImportJob> {
    if (typeof body !== 'string' || Buffer.byteLength(body) > this.maxBytes) {
      throw new BadRequestException({
        code: 'IMPORT_SIZE_INVALID',
        message: `CSV content must be text no larger than ${this.maxBytes} bytes`,
      });
    }
    const job = await this.imports.enqueue({
      csv: body,
      filename: parseRequest(filenameSchema, rawFilename),
      idempotencyKey: parseRequest(idempotencyKeySchema, rawIdempotencyKey),
      organizationId,
      requestedByUserId: requestIdentity(request).user.id,
    });
    await this.cache.invalidateOrganization(organizationId);
    return job;
  }

  @Get(':importId')
  @ApiOkResponse({ schema: importJobOpenApiSchema })
  async status(
    @Param('organizationId') organizationId: string,
    @Param('importId') rawImportId: string,
  ): Promise<ImportJob> {
    const job = await this.imports.find(
      organizationId,
      parseRequest(identifierSchema, rawImportId),
    );
    if (!job) throw new NotFoundException('Import not found');
    return job;
  }
}
