import type {
  AddTeamMemberRequest,
  AuditEventSummary,
  TeamMember,
  TeamResponse,
  UpdateTeamMemberRequest,
} from '@analytics-admin/contracts';
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
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseRequest } from '../common/validation';
import { AuthGuard } from './auth.guard';
import { CsrfGuard } from './csrf.guard';
import { requestIdentity } from './request-identity';
import { Roles, RolesGuard } from './roles.guard';
import { TeamService } from './team.service';

const memberRole = z.enum(['ADMIN', 'ANALYST', 'VIEWER']);
const addMemberSchema = z.object({
  email: z
    .email()
    .max(320)
    .transform((value) => value.toLowerCase()),
  role: memberRole,
});
const updateMemberSchema = z.object({
  role: z.enum(['OWNER', 'ADMIN', 'ANALYST', 'VIEWER']),
});
const identifierSchema = z.uuid();

@Controller({ path: 'organizations/:organizationId', version: '1' })
@UseGuards(AuthGuard, CsrfGuard, RolesGuard)
@Roles('OWNER', 'ADMIN')
export class TeamController {
  constructor(private readonly teamService: TeamService) {}

  @Get('team')
  team(@Param('organizationId') organizationId: string): Promise<TeamResponse> {
    return this.teamService.team(organizationId);
  }

  @Post('team')
  addMember(
    @Param('organizationId') organizationId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<TeamMember> {
    const input: AddTeamMemberRequest = parseRequest(addMemberSchema, body);
    return this.teamService.addMember(
      requestIdentity(request).user.id,
      organizationId,
      input,
    );
  }

  @Patch('team/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async updateMember(
    @Param('organizationId') organizationId: string,
    @Param('userId') rawUserId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    const userId = parseRequest(identifierSchema, rawUserId);
    const input: UpdateTeamMemberRequest = parseRequest(
      updateMemberSchema,
      body,
    );
    await this.teamService.updateMember(
      requestIdentity(request).user.id,
      organizationId,
      userId,
      input,
    );
  }

  @Delete('team/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeMember(
    @Param('organizationId') organizationId: string,
    @Param('userId') rawUserId: string,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.teamService.removeMember(
      requestIdentity(request).user.id,
      organizationId,
      parseRequest(identifierSchema, rawUserId),
    );
  }

  @Get('audit-events')
  auditEvents(
    @Param('organizationId') organizationId: string,
  ): Promise<AuditEventSummary[]> {
    return this.teamService.auditEvents(organizationId);
  }
}
