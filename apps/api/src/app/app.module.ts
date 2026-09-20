import { loadEnvironment } from '@analytics-admin/config';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health.controller';
import { DataCoreModule } from './data-core/data-core.module';
import { HealthService } from './health.service';
import { InfrastructureService } from './infrastructure.service';
import { InfrastructureModule } from './infrastructure/infrastructure.module';
import { IdentityModule } from './identity/identity.module';
import { GovernanceModule } from './governance/governance.module';
import { OperationsModule } from './operations/operations.module';
import { ResilienceModule } from './resilience/resilience.module';
import { SalesModule } from './sales/sales.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      cache: true,
      expandVariables: false,
      isGlobal: true,
      validate: loadEnvironment,
    }),
    InfrastructureModule,
    ResilienceModule,
    IdentityModule,
    GovernanceModule,
    DataCoreModule,
    SalesModule,
    OperationsModule,
  ],
  controllers: [HealthController],
  providers: [HealthService, InfrastructureService],
})
export class AppModule {}
