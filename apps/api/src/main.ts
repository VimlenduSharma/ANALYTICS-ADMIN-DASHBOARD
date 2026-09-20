import type { Environment } from '@analytics-admin/config';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import { Logger, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app/app.module';
import { ApiExceptionFilter } from './app/common/api-exception.filter';

const apiBodyLimitBytes = 10 * 1_024 * 1_024;

async function bootstrap(): Promise<void> {
  const adapter = new FastifyAdapter({
    bodyLimit: apiBodyLimitBytes,
    trustProxy: 1,
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    adapter,
    { rawBody: true },
  );
  const config = app.get(ConfigService<Environment, true>);

  adapter
    .getInstance()
    .addContentTypeParser(
      'text/csv',
      { parseAs: 'string' },
      (_request, body, done) => done(null, body),
    );

  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: false });
  const webOrigin = config.getOrThrow('WEB_ORIGIN');
  app.enableCors({
    credentials: true,
    origin: (origin, callback) => callback(null, origin === webOrigin),
  });
  app.enableShutdownHooks();
  app.enableVersioning({ type: VersioningType.URI });
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new ApiExceptionFilter());

  const openApiConfig = new DocumentBuilder()
    .setTitle('Analytics Admin API')
    .setDescription('Tenant-safe operational and sales ingestion API')
    .setVersion(config.getOrThrow('APP_VERSION'))
    .addCookieAuth(
      '__Host-analytics_session',
      { type: 'apiKey', in: 'cookie' },
      'session',
    )
    .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'metrics')
    .build();
  const openApiDocument = SwaggerModule.createDocument(app, openApiConfig);
  adapter
    .getInstance()
    .get('/api/openapi.json', (_request, reply) => reply.send(openApiDocument));

  const host = config.getOrThrow('API_HOST');
  const port = config.getOrThrow('API_PORT');
  await app.listen({ host, port });
  Logger.log(`Analytics API listening on http://${host}:${port}/api`);
}

void bootstrap().catch((error: unknown) => {
  Logger.error('Analytics API failed to start', error, 'Bootstrap');
  process.exitCode = 1;
});
