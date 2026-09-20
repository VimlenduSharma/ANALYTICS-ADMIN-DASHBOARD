import {
  CredentialCipher,
  GovernanceJobsService,
  GovernanceService,
} from '@analytics-admin/governance';
import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import {
  GovernanceController,
  InvitationAcceptanceController,
  ProfileController,
} from './governance.controller';

@Module({
  controllers: [
    GovernanceController,
    InvitationAcceptanceController,
    ProfileController,
  ],
  imports: [IdentityModule],
  providers: [CredentialCipher, GovernanceJobsService, GovernanceService],
})
export class GovernanceModule {}
