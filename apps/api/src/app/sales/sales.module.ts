import {
  SalesAnalyticsService,
  SalesExportService,
} from '@analytics-admin/sales';
import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { SalesController } from './sales.controller';

@Module({
  controllers: [SalesController],
  imports: [IdentityModule],
  providers: [SalesAnalyticsService, SalesExportService],
})
export class SalesModule {}
