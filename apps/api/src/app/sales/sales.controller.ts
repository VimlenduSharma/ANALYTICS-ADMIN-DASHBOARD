import type {
  SalesExportJob,
  SalesFilterOptionsResponse,
  SalesOrderDetail,
  SalesOrdersResponse,
  SalesOverviewResponse,
} from '@analytics-admin/contracts';
import {
  SalesAnalyticsService,
  SalesExportService,
  salesExportRequestSchema,
  salesFilterOptionsQuerySchema,
  salesFilterQuerySchema,
  salesOrdersQuerySchema,
} from '@analytics-admin/sales';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiCookieAuth,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseRequest } from '../common/validation';
import { AuthGuard } from '../identity/auth.guard';
import { CsrfGuard } from '../identity/csrf.guard';
import { requestIdentity } from '../identity/request-identity';
import { Roles, RolesGuard } from '../identity/roles.guard';
import { ResponseCacheService } from '../resilience/response-cache.service';
import {
  salesExportOpenApiSchema,
  salesExportRequestOpenApiSchema,
  salesFilterOptionsOpenApiSchema,
  salesOrderDetailOpenApiSchema,
  salesOrdersOpenApiSchema,
  salesOverviewOpenApiSchema,
} from './openapi-schemas';

const identifierSchema = z.uuid();
const idempotencyKeySchema = z.string().trim().min(8).max(200);

@ApiTags('Sales analytics')
@ApiCookieAuth('session')
@Controller({ path: 'organizations/:organizationId/sales', version: '1' })
@UseGuards(AuthGuard, CsrfGuard, RolesGuard)
@Roles('OWNER', 'ADMIN', 'ANALYST', 'VIEWER')
export class SalesController {
  constructor(
    private readonly analytics: SalesAnalyticsService,
    private readonly cache: ResponseCacheService,
    private readonly exports: SalesExportService,
  ) {}

  @Get('overview')
  @SalesFilterQueries()
  @ApiOperation({ summary: 'Read reconciled sales KPIs and segment trends' })
  @ApiOkResponse({ schema: salesOverviewOpenApiSchema })
  async overview(
    @Param('organizationId') organizationId: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SalesOverviewResponse> {
    const filters = parseRequest(salesFilterQuerySchema, query);
    const result = await this.cache.getOrLoad(
      'sales-overview',
      organizationId,
      filters,
      () => this.analytics.overview(organizationId, filters),
    );
    reply.header('x-analytics-cache', result.status);
    return result.value;
  }

  @Get('filter-options')
  @ApiQuery({ name: 'productQuery', required: false, type: String })
  @ApiQuery({ name: 'selectedProductId', required: false, type: String })
  @ApiOkResponse({ schema: salesFilterOptionsOpenApiSchema })
  async filterOptions(
    @Param('organizationId') organizationId: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SalesFilterOptionsResponse> {
    const filters = parseRequest(salesFilterOptionsQuerySchema, query);
    const result = await this.cache.getOrLoad(
      'sales-filter-options',
      organizationId,
      filters,
      () => this.analytics.filterOptions(organizationId, filters),
    );
    reply.header('x-analytics-cache', result.status);
    return result.value;
  }

  @Get('orders')
  @SalesFilterQueries()
  @ApiQuery({ enum: ['asc', 'desc'], name: 'direction', required: false })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ maximum: 100, minimum: 10, name: 'pageSize', required: false })
  @ApiQuery({
    enum: ['occurredAt', 'orderNumber', 'revenue', 'status'],
    name: 'sort',
    required: false,
  })
  @ApiOkResponse({ schema: salesOrdersOpenApiSchema })
  orders(
    @Param('organizationId') organizationId: string,
    @Query() query: unknown,
  ): Promise<SalesOrdersResponse> {
    return this.analytics.listOrders(
      organizationId,
      parseRequest(salesOrdersQuerySchema, query),
    );
  }

  @Get('orders/:orderId')
  @ApiOkResponse({ schema: salesOrderDetailOpenApiSchema })
  order(
    @Param('organizationId') organizationId: string,
    @Param('orderId') orderId: string,
  ): Promise<SalesOrderDetail> {
    return this.analytics.orderDetail(
      organizationId,
      parseRequest(identifierSchema, orderId),
    );
  }

  @Post('exports')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({ schema: salesExportRequestOpenApiSchema })
  @ApiAcceptedResponse({ schema: salesExportOpenApiSchema })
  enqueueExport(
    @Param('organizationId') organizationId: string,
    @Headers('idempotency-key') rawIdempotencyKey: unknown,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<SalesExportJob> {
    return this.exports.enqueue({
      idempotencyKey: parseRequest(idempotencyKeySchema, rawIdempotencyKey),
      organizationId,
      request: parseRequest(salesExportRequestSchema, body),
      userId: requestIdentity(request).user.id,
    });
  }

  @Get('exports/:exportId')
  @ApiOkResponse({ schema: salesExportOpenApiSchema })
  async exportStatus(
    @Param('organizationId') organizationId: string,
    @Param('exportId') rawExportId: string,
    @Req() request: FastifyRequest,
  ): Promise<SalesExportJob> {
    const job = await this.exports.find(
      organizationId,
      parseRequest(identifierSchema, rawExportId),
      requestIdentity(request).user.id,
    );
    if (!job) throw new NotFoundException('Sales export not found');
    return job;
  }

  @Get('exports/:exportId/download')
  @ApiProduces('text/csv')
  @ApiOkResponse({ schema: { format: 'binary', type: 'string' } })
  async downloadExport(
    @Param('organizationId') organizationId: string,
    @Param('exportId') rawExportId: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const result = await this.exports.download(
      organizationId,
      parseRequest(identifierSchema, rawExportId),
      requestIdentity(request).user.id,
    );
    if (!result)
      throw new NotFoundException('Completed sales export not found');
    reply.header(
      'Content-Disposition',
      `attachment; filename="${result.filename}"`,
    );
    reply.type('text/csv; charset=utf-8').send(result.csv);
  }
}

function SalesFilterQueries(): MethodDecorator {
  return applyDecorators(
    ApiQuery({ format: 'uuid', name: 'channelId', required: false }),
    ApiQuery({ name: 'currency', pattern: '^[A-Z]{3}$', required: false }),
    ApiQuery({ format: 'date', name: 'from', required: false }),
    ApiQuery({ format: 'uuid', name: 'locationId', required: false }),
    ApiQuery({ format: 'uuid', name: 'productId', required: false }),
    ApiQuery({ maxLength: 120, name: 'query', required: false }),
    ApiQuery({
      enum: ['pending', 'confirmed', 'fulfilled', 'cancelled', 'refunded'],
      name: 'status',
      required: false,
    }),
    ApiQuery({ format: 'date', name: 'to', required: false }),
  );
}
