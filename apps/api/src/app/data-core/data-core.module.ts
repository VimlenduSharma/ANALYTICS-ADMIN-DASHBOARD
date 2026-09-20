import {
  DataCoreService,
  ImportQueueService,
} from '@analytics-admin/data-core';
import { CredentialCipher } from '@analytics-admin/governance';
import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { DataController } from './data.controller';
import { ImportsController } from './imports.controller';
import {
  OrderWebhookController,
  WebhookManagementController,
} from './webhooks.controller';
import { WebhookService } from './webhook.service';

@Module({
  imports: [IdentityModule],
  controllers: [
    DataController,
    ImportsController,
    OrderWebhookController,
    WebhookManagementController,
  ],
  providers: [
    CredentialCipher,
    DataCoreService,
    ImportQueueService,
    WebhookService,
  ],
})
export class DataCoreModule {}
