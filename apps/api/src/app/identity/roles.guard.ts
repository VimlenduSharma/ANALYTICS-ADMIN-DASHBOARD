import type { OrganizationRole } from '@analytics-admin/contracts';
import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { IdentityRepository } from './identity.repository';

const rolesMetadataKey = 'organization-roles';

export const Roles = (...roles: OrganizationRole[]) =>
  SetMetadata(rolesMetadataKey, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly identityRepository: IdentityRepository,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const roles = this.reflector.getAllAndOverride<OrganizationRole[]>(
      rolesMetadataKey,
      [context.getHandler(), context.getClass()],
    );
    if (!roles?.length) return true;

    const userId = request.identity?.user.id;
    const params = request.params as { organizationId?: unknown };
    const parsedId = z.uuid().safeParse(params.organizationId);
    if (!userId || !parsedId.success) {
      throw new BadRequestException('A valid organization is required');
    }

    const role = await this.identityRepository.membershipRole(
      userId,
      parsedId.data,
    );
    if (!role || !roles.includes(role)) {
      throw new ForbiddenException({
        code: 'ORGANIZATION_ACCESS_DENIED',
        message: 'You do not have permission for this organization',
      });
    }

    request.organization = { id: parsedId.data, role };
    return true;
  }
}
