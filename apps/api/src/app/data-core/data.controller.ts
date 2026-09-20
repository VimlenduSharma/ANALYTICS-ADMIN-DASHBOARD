import {
  type IngestionResult,
  DataCoreService,
  inventorySnapshotSchema,
  orderIngestionSchema,
} from '@analytics-admin/data-core';
import type { InventoryIngestionResult } from '@analytics-admin/contracts';
import {
  Body,
  Controller,
  Headers,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOperation,
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
import {
  ingestionResultOpenApiSchema,
  inventoryIngestionResultOpenApiSchema,
  inventorySnapshotOpenApiSchema,
  orderIngestionOpenApiSchema,
} from './openapi-schemas';

const idempotencyKeySchema = z.string().trim().min(8).max(200);

@ApiTags('Data ingestion')
@ApiCookieAuth('session')
@Controller({ path: 'organizations/:organizationId/data', version: '1' })
@UseGuards(AuthGuard, CsrfGuard, RolesGuard)
@Roles('OWNER', 'ADMIN', 'ANALYST')
export class DataController {
  constructor(
    private readonly cache: ResponseCacheService,
    private readonly dataCore: DataCoreService,
  ) {}

  @Post('orders')
  @ApiOperation({ summary: 'Create or replace a source order snapshot' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({ schema: orderIngestionOpenApiSchema })
  @ApiCreatedResponse({ schema: ingestionResultOpenApiSchema })
  async ingestOrder(
    @Param('organizationId') organizationId: string,
    @Headers('idempotency-key') rawIdempotencyKey: unknown,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<IngestionResult> {
    const result = await this.dataCore.ingestOrder({
      actorUserId: requestIdentity(request).user.id,
      idempotencyKey: parseRequest(idempotencyKeySchema, rawIdempotencyKey),
      order: parseRequest(orderIngestionSchema, body),
      organizationId,
      source: 'rest:orders',
    });
    await this.cache.invalidateOrganization(organizationId);
    return result;
  }

  @Post('inventory')
  @ApiOperation({
    summary: 'Create or replace one inventory position snapshot',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({ schema: inventorySnapshotOpenApiSchema })
  @ApiCreatedResponse({ schema: inventoryIngestionResultOpenApiSchema })
  async ingestInventory(
    @Param('organizationId') organizationId: string,
    @Headers('idempotency-key') rawIdempotencyKey: unknown,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<InventoryIngestionResult> {
    const result = await this.dataCore.ingestInventory({
      actorUserId: requestIdentity(request).user.id,
      idempotencyKey: parseRequest(idempotencyKeySchema, rawIdempotencyKey),
      organizationId,
      snapshot: parseRequest(inventorySnapshotSchema, body),
      source: 'rest:inventory',
    });
    await this.cache.invalidateOrganization(organizationId);
    return result;
  }
}
