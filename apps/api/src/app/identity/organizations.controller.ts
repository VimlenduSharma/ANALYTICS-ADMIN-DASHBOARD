import type {
  CreateOrganizationRequest,
  OrganizationAccess,
} from '@analytics-admin/contracts';
import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseRequest } from '../common/validation';
import { AuthGuard } from './auth.guard';
import { CsrfGuard } from './csrf.guard';
import { requestIdentity } from './request-identity';
import { TeamService } from './team.service';

const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(100),
});

@Controller({ path: 'organizations', version: '1' })
@UseGuards(AuthGuard, CsrfGuard)
export class OrganizationsController {
  constructor(private readonly team: TeamService) {}

  @Get()
  list(@Req() request: FastifyRequest): Promise<OrganizationAccess[]> {
    return this.team.organizations(requestIdentity(request).user.id);
  }

  @Post()
  create(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<OrganizationAccess> {
    const input: CreateOrganizationRequest = parseRequest(
      createOrganizationSchema,
      body,
    );
    return this.team.createOrganization(
      requestIdentity(request).user.id,
      input,
    );
  }
}
