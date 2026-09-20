import type {
  CreatedOrganizationInvitation,
  GovernanceAuditResponse,
  GovernanceJob,
  GovernanceOverview,
  OrganizationAccess,
  OrganizationGovernanceSettings,
  OrganizationInvitation,
  UserProfile,
} from '@analytics-admin/contracts';
import {
  auditQuerySchema,
  governanceJobRequestSchema,
  GovernanceJobsService,
  GovernanceService,
  invitationCreateSchema,
  profileUpdateSchema,
  settingsUpdateSchema,
} from '@analytics-admin/governance';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseRequest } from '../common/validation';
import { AuthGuard } from '../identity/auth.guard';
import { CsrfGuard } from '../identity/csrf.guard';
import { requestIdentity } from '../identity/request-identity';
import { Roles, RolesGuard } from '../identity/roles.guard';
import {
  createdInvitationOpenApiSchema,
  governanceAuditOpenApiSchema,
  governanceJobOpenApiSchema,
  governanceJobRequestOpenApiSchema,
  governanceOverviewOpenApiSchema,
  governanceSettingsOpenApiSchema,
  governanceSettingsUpdateOpenApiSchema,
  invitationAcceptanceOpenApiSchema,
  invitationCreateOpenApiSchema,
  invitationOpenApiSchema,
  organizationAccessOpenApiSchema,
  profileOpenApiSchema,
  profileUpdateOpenApiSchema,
} from './openapi-schemas';

const identifierSchema = z.uuid();
const idempotencyKeySchema = z.string().trim().min(8).max(200);
const invitationAcceptanceSchema = z.strictObject({
  token: z.string().trim().min(40).max(200),
});

@ApiTags('Profile')
@ApiCookieAuth('session')
@Controller({ path: 'profile', version: '1' })
@UseGuards(AuthGuard, CsrfGuard)
export class ProfileController {
  constructor(private readonly governance: GovernanceService) {}

  @Get()
  @ApiOkResponse({ schema: profileOpenApiSchema })
  profile(@Req() request: FastifyRequest): Promise<UserProfile> {
    return this.governance.profile(requestIdentity(request).user.id);
  }

  @Patch()
  @ApiBody({ schema: profileUpdateOpenApiSchema })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOkResponse({ schema: profileOpenApiSchema })
  updateProfile(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<UserProfile> {
    return this.governance.updateProfile(
      requestIdentity(request).user.id,
      parseRequest(profileUpdateSchema, body),
    );
  }
}

@ApiTags('Governance')
@ApiCookieAuth('session')
@Controller({ path: 'organizations/:organizationId/governance', version: '1' })
@UseGuards(AuthGuard, CsrfGuard, RolesGuard)
@Roles('OWNER', 'ADMIN')
export class GovernanceController {
  constructor(
    private readonly governance: GovernanceService,
    private readonly jobs: GovernanceJobsService,
  ) {}

  @Get()
  @ApiOkResponse({ schema: governanceOverviewOpenApiSchema })
  overview(
    @Param('organizationId') organizationId: string,
  ): Promise<GovernanceOverview> {
    return this.governance.overview(organizationId);
  }

  @Patch('settings')
  @Roles('OWNER')
  @ApiBody({ schema: governanceSettingsUpdateOpenApiSchema })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOkResponse({ schema: governanceSettingsOpenApiSchema })
  updateSettings(
    @Param('organizationId') organizationId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<OrganizationGovernanceSettings> {
    return this.governance.updateSettings(
      requestIdentity(request).user.id,
      organizationId,
      parseRequest(settingsUpdateSchema, body),
    );
  }

  @Get('invitations')
  @ApiOkResponse({ schema: { items: invitationOpenApiSchema, type: 'array' } })
  invitations(
    @Param('organizationId') organizationId: string,
  ): Promise<OrganizationInvitation[]> {
    return this.governance.invitations(organizationId);
  }

  @Post('invitations')
  @ApiBody({ schema: invitationCreateOpenApiSchema })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiCreatedResponse({ schema: createdInvitationOpenApiSchema })
  createInvitation(
    @Param('organizationId') organizationId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<CreatedOrganizationInvitation> {
    const invitation = parseRequest(invitationCreateSchema, body);
    const actorRole = request.organization?.role;
    if (!actorRole) throw new NotFoundException('Organization role not found');
    return this.governance.createInvitation({
      actorRole,
      actorUserId: requestIdentity(request).user.id,
      email: invitation.email,
      organizationId,
      role: invitation.role,
    });
  }

  @Delete('invitations/:invitationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiNoContentResponse()
  revokeInvitation(
    @Param('organizationId') organizationId: string,
    @Param('invitationId') invitationId: string,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    return this.governance.revokeInvitation(
      requestIdentity(request).user.id,
      organizationId,
      parseRequest(identifierSchema, invitationId),
    );
  }

  @Get('audit-events')
  @ApiOkResponse({ schema: governanceAuditOpenApiSchema })
  auditEvents(
    @Param('organizationId') organizationId: string,
    @Query() query: unknown,
  ): Promise<GovernanceAuditResponse> {
    return this.governance.auditEvents(
      organizationId,
      parseRequest(auditQuerySchema, query),
    );
  }

  @Post('jobs')
  @Roles('OWNER')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBody({ schema: governanceJobRequestOpenApiSchema })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiAcceptedResponse({ schema: governanceJobOpenApiSchema })
  enqueueJob(
    @Param('organizationId') organizationId: string,
    @Headers('idempotency-key') rawIdempotencyKey: unknown,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<GovernanceJob> {
    return this.jobs.enqueue({
      idempotencyKey: parseRequest(idempotencyKeySchema, rawIdempotencyKey),
      organizationId,
      request: parseRequest(governanceJobRequestSchema, body),
      userId: requestIdentity(request).user.id,
    });
  }

  @Get('jobs/:jobId')
  @ApiOkResponse({ schema: governanceJobOpenApiSchema })
  async job(
    @Param('organizationId') organizationId: string,
    @Param('jobId') jobId: string,
  ): Promise<GovernanceJob> {
    const job = await this.jobs.find(
      organizationId,
      parseRequest(identifierSchema, jobId),
    );
    if (!job) throw new NotFoundException('Governance job not found');
    return job;
  }

  @Get('jobs/:jobId/download')
  @ApiProduces('application/json')
  async download(
    @Param('organizationId') organizationId: string,
    @Param('jobId') jobId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const result = await this.jobs.download(
      organizationId,
      parseRequest(identifierSchema, jobId),
    );
    if (!result)
      throw new NotFoundException('Completed privacy export not found');
    reply.header(
      'Content-Disposition',
      `attachment; filename="${result.filename}"`,
    );
    reply.type('application/json; charset=utf-8').send(result.payload);
  }
}

@ApiTags('Invitations')
@ApiCookieAuth('session')
@Controller({
  path: 'organizations/:organizationId/invitations',
  version: '1',
})
@UseGuards(AuthGuard, CsrfGuard)
export class InvitationAcceptanceController {
  constructor(private readonly governance: GovernanceService) {}

  @Post('accept')
  @ApiBody({ schema: invitationAcceptanceOpenApiSchema })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiCreatedResponse({ schema: organizationAccessOpenApiSchema })
  accept(
    @Param('organizationId') rawOrganizationId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<OrganizationAccess> {
    return this.governance.acceptInvitation({
      organizationId: parseRequest(identifierSchema, rawOrganizationId),
      token: parseRequest(invitationAcceptanceSchema, body).token,
      userId: requestIdentity(request).user.id,
    });
  }
}
