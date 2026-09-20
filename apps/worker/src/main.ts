import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
}

void bootstrap().catch((error: unknown) => {
  Logger.error('Analytics worker failed to start', error, 'Bootstrap');
  process.exitCode = 1;
});
