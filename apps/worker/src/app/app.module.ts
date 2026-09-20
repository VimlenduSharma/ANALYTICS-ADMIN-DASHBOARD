import { loadEnvironment } from '@analytics-admin/config';
import {
  DatabaseService,
  DataCoreService,
  ImportQueueService,
} from '@analytics-admin/data-core';
import {
  CredentialCipher,
  GovernanceJobsService,
} from '@analytics-admin/governance';
import {
  SalesAnalyticsService,
  SalesExportService,
} from '@analytics-admin/sales';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WorkerLifecycleService } from './worker-lifecycle.service';
import { ImportWorkerService } from './import-worker.service';
import { SalesExportWorkerService } from './sales-export-worker.service';
import { GovernanceWorkerService } from './governance-worker.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      cache: true,
      expandVariables: false,
      isGlobal: true,
      validate: loadEnvironment,
    }),
  ],
  providers: [
    CredentialCipher,
    DatabaseService,
    DataCoreService,
    ImportQueueService,
    ImportWorkerService,
    GovernanceJobsService,
    GovernanceWorkerService,
    SalesAnalyticsService,
    SalesExportService,
    SalesExportWorkerService,
    WorkerLifecycleService,
  ],
})
export class AppModule {}
