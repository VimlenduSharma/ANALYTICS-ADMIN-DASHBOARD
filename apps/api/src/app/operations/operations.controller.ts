import type {
  OperationsIssuesResponse,
  OperationsOverviewResponse,
  OperationsThresholds,
} from '@analytics-admin/contracts';
import {
  OperationsService,
  operationsAlertKeySchema,
  operationsFilterQuerySchema,
  operationsIssuesQuerySchema,
  operationsThresholdSchema,
} from '@analytics-admin/operations';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import type { FastifyReply } from 'fastify';
import { parseRequest } from '../common/validation';
import { AuthGuard } from '../identity/auth.guard';
import { CsrfGuard } from '../identity/csrf.guard';
import { requestIdentity } from '../identity/request-identity';
import { Roles, RolesGuard } from '../identity/roles.guard';
import { ResponseCacheService } from '../resilience/response-cache.service';
import {
  operationsIssuesOpenApiSchema,
  operationsOverviewOpenApiSchema,
  operationsThresholdRequestOpenApiSchema,
  operationsThresholdsOpenApiSchema,
} from './openapi-schemas';

@ApiTags('Operations intelligence')
@ApiCookieAuth('session')
@Controller({ path: 'organizations/:organizationId/operations', version: '1' })
@UseGuards(AuthGuard, CsrfGuard, RolesGuard)
@Roles('OWNER', 'ADMIN', 'ANALYST', 'VIEWER')
export class OperationsController {
  constructor(
    private readonly cache: ResponseCacheService,
    private readonly operations: OperationsService,
  ) {}

  @Get('overview')
  @OperationsFilterQueries()
  @ApiOperation({
    summary: 'Read operational risk, service levels, and alerts',
  })
  @ApiOkResponse({ schema: operationsOverviewOpenApiSchema })
  async overview(
    @Param('organizationId') organizationId: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<OperationsOverviewResponse> {
    const filters = parseRequest(operationsFilterQuerySchema, query);
    const result = await this.cache.getOrLoad(
      'operations-overview',
      organizationId,
      filters,
      () => this.operations.overview(organizationId, filters),
    );
    reply.header('x-analytics-cache', result.status);
    return result.value;
  }

  @Get('issues')
  @OperationsFilterQueries()
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ maximum: 100, minimum: 10, name: 'pageSize', required: false })
  @ApiOkResponse({ schema: operationsIssuesOpenApiSchema })
  issues(
    @Param('organizationId') organizationId: string,
    @Query() query: unknown,
  ): Promise<OperationsIssuesResponse> {
    return this.operations.issues(
      organizationId,
      parseRequest(operationsIssuesQuerySchema, query),
    );
  }

  @Patch('thresholds')
  @Roles('OWNER', 'ADMIN')
  @ApiBody({ schema: operationsThresholdRequestOpenApiSchema })
  @ApiOkResponse({ schema: operationsThresholdsOpenApiSchema })
  async updateThresholds(
    @Param('organizationId') organizationId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<OperationsThresholds> {
    const result = await this.operations.updateThresholds(
      requestIdentity(request).user.id,
      organizationId,
      parseRequest(operationsThresholdSchema, body),
    );
    await this.cache.invalidateOrganization(organizationId);
    return result;
  }

  @Post('alerts/:alertKey/acknowledgement')
  @Roles('OWNER', 'ADMIN', 'ANALYST')
  @HttpCode(HttpStatus.NO_CONTENT)
  @OperationsFilterQueries()
  @ApiNoContentResponse()
  async acknowledgeAlert(
    @Param('organizationId') organizationId: string,
    @Param('alertKey') rawAlertKey: string,
    @Query() query: unknown,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.operations.acknowledgeAlert(
      requestIdentity(request).user.id,
      organizationId,
      parseRequest(operationsAlertKeySchema, rawAlertKey),
      parseRequest(operationsFilterQuerySchema, query),
    );
    await this.cache.invalidateOrganization(organizationId);
  }

  @Delete('alerts/:alertKey/acknowledgement')
  @Roles('OWNER', 'ADMIN', 'ANALYST')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async reopenAlert(
    @Param('organizationId') organizationId: string,
    @Param('alertKey') rawAlertKey: string,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.operations.reopenAlert(
      requestIdentity(request).user.id,
      organizationId,
      parseRequest(operationsAlertKeySchema, rawAlertKey),
    );
    await this.cache.invalidateOrganization(organizationId);
  }
}

function OperationsFilterQueries(): MethodDecorator {
  return applyDecorators(
    ApiQuery({ format: 'date', name: 'from', required: false }),
    ApiQuery({
      enum: [
        'backlog',
        'late-fulfilment',
        'low-stock',
        'cancellation',
        'return',
      ],
      name: 'issueType',
      required: false,
    }),
    ApiQuery({ format: 'uuid', name: 'locationId', required: false }),
    ApiQuery({
      enum: ['critical', 'warning', 'info'],
      name: 'severity',
      required: false,
    }),
    ApiQuery({ format: 'date', name: 'to', required: false }),
  );
}
