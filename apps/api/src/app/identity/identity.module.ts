import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthenticationService } from './authentication.service';
import { AuthGuard } from './auth.guard';
import { CookieService } from './cookie.service';
import { CsrfGuard } from './csrf.guard';
import { IdentityRepository } from './identity.repository';
import { OidcService } from './oidc.service';
import { OrganizationsController } from './organizations.controller';
import { RolesGuard } from './roles.guard';
import { SessionService } from './session.service';
import { TeamController } from './team.controller';
import { TeamService } from './team.service';

@Module({
  controllers: [AuthController, OrganizationsController, TeamController],
  exports: [
    AuthGuard,
    AuthenticationService,
    CookieService,
    CsrfGuard,
    IdentityRepository,
    RolesGuard,
    SessionService,
  ],
  providers: [
    AuthenticationService,
    AuthGuard,
    CookieService,
    CsrfGuard,
    IdentityRepository,
    OidcService,
    RolesGuard,
    SessionService,
    TeamService,
  ],
})
export class IdentityModule {}
