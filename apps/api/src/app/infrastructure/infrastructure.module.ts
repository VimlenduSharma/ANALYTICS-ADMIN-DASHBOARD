import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { RedisService } from './redis.service';

@Global()
@Module({
  exports: [DatabaseService, RedisService],
  providers: [DatabaseService, RedisService],
})
export class InfrastructureModule {}
