import { OperationsService } from '@analytics-admin/operations';
import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { OperationsController } from './operations.controller';

@Module({
  controllers: [OperationsController],
  imports: [IdentityModule],
  providers: [OperationsService],
})
export class OperationsModule {}
