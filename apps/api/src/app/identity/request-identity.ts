import type {
  IdentityUser,
  OrganizationRole,
} from '@analytics-admin/contracts';
import { UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { SessionRecord } from './session.service';

export interface RequestIdentity {
  session: SessionRecord;
  sessionToken: string;
  user: IdentityUser;
}

export interface OrganizationAuthorization {
  id: string;
  role: OrganizationRole;
}

export function requestIdentity(request: FastifyRequest): RequestIdentity {
  if (!request.identity) throw new UnauthorizedException();
  return request.identity;
}
