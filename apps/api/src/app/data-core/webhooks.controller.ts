import {
  DataCoreService,
  orderIngestionSchema,
} from '@analytics-admin/data-core';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { RawBodyRequest } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseRequest } from '../common/validation';
import { AuthGuard } from '../identity/auth.guard';
import { CsrfGuard } from '../identity/csrf.guard';
import { requestIdentity } from '../identity/request-identity';
import { Roles, RolesGuard } from '../identity/roles.guard';
import { ResponseCacheService } from '../resilience/response-cache.service';
import {
  createdWebhookEndpointOpenApiSchema,
  ingestionResultOpenApiSchema,
  orderIngestionOpenApiSchema,
  webhookEndpointOpenApiSchema,
} from './openapi-schemas';
import { WebhookService } from './webhook.service';

const endpointNameSchema = z.object({
  name: z.string().trim().min(1).max(120),
});
const identifierSchema = z.uuid();
const eventIdSchema = z.string().trim().min(8).max(200);
const headerSchema = z.string().trim().min(1);

@ApiTags('Webhook management')
@ApiCookieAuth('session')
@Controller({
  path: 'organizations/:organizationId/data/webhooks',
  version: '1',
})
@UseGuards(AuthGuard, CsrfGuard, RolesGuard)
@Roles('OWNER', 'ADMIN')
export class WebhookManagementController {
  constructor(private readonly webhooks: WebhookService) {}

  @Post()
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiCreatedResponse({ schema: createdWebhookEndpointOpenApiSchema })
  create(
    @Param('organizationId') organizationId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const { name } = parseRequest(endpointNameSchema, body);
    return this.webhooks.create(
      organizationId,
      requestIdentity(request).user.id,
      name,
    );
  }

  @Get()
  @ApiOkResponse({
    schema: { items: webhookEndpointOpenApiSchema, type: 'array' },
  })
  list(@Param('organizationId') organizationId: string) {
    return this.webhooks.list(organizationId);
  }

  @Delete(':endpointId')
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  revoke(
    @Param('organizationId') organizationId: string,
    @Param('endpointId') rawEndpointId: string,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    return this.webhooks.revoke(
      organizationId,
      parseRequest(identifierSchema, rawEndpointId),
      requestIdentity(request).user.id,
    );
  }

  @Put(':endpointId/credential')
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOkResponse({ schema: createdWebhookEndpointOpenApiSchema })
  rotate(
    @Param('organizationId') organizationId: string,
    @Param('endpointId') rawEndpointId: string,
    @Req() request: FastifyRequest,
  ) {
    return this.webhooks.rotate(
      organizationId,
      parseRequest(identifierSchema, rawEndpointId),
      requestIdentity(request).user.id,
    );
  }
}

@ApiTags('Inbound webhooks')
@Controller({
  path: 'organizations/:organizationId/webhooks/orders/:endpointId',
  version: '1',
})
export class OrderWebhookController {
  constructor(
    private readonly cache: ResponseCacheService,
    private readonly dataCore: DataCoreService,
    private readonly webhooks: WebhookService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Ingest an HMAC-signed order event' })
  @ApiHeader({ name: 'X-Webhook-Event-Id', required: true })
  @ApiHeader({ name: 'X-Webhook-Signature', required: true })
  @ApiHeader({ name: 'X-Webhook-Timestamp', required: true })
  @ApiBody({ schema: orderIngestionOpenApiSchema })
  @ApiCreatedResponse({ schema: ingestionResultOpenApiSchema })
  async receive(
    @Param('organizationId') rawOrganizationId: string,
    @Param('endpointId') rawEndpointId: string,
    @Headers('x-webhook-event-id') rawEventId: unknown,
    @Headers('x-webhook-signature') rawSignature: unknown,
    @Headers('x-webhook-timestamp') rawTimestamp: unknown,
    @Body() body: unknown,
    @Req() request: RawBodyRequest<FastifyRequest>,
  ) {
    const organizationId = parseRequest(identifierSchema, rawOrganizationId);
    const endpointId = parseRequest(identifierSchema, rawEndpointId);
    const eventId = parseRequest(eventIdSchema, rawEventId);
    await this.webhooks.verify({
      endpointId,
      organizationId,
      rawBody: request.rawBody ?? Buffer.alloc(0),
      signature: parseRequest(headerSchema, rawSignature),
      timestamp: parseRequest(headerSchema, rawTimestamp),
    });
    const result = await this.dataCore.ingestOrder({
      idempotencyKey: eventId,
      order: parseRequest(orderIngestionSchema, body),
      organizationId,
      source: `webhook:${endpointId}`,
    });
    await this.cache.invalidateOrganization(organizationId);
    return result;
  }
}
