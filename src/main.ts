import { environment } from './infrastructure/config/environment.js';
import { configureHttp } from './infrastructure/http/configure-http.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ApplicationLogger } from './infrastructure/observability/application-logger.js';

const logger = new ApplicationLogger();
process.once('SIGTERM', () => {
  console.log(
    JSON.stringify({
      event: 'signal_received',
      signal: 'SIGTERM',
      instanceId: environment().instanceId,
    }),
  );
});

if (environment().workers.httpEnabled) {
  const app = await NestFactory.create(AppModule, { logger });
  configureHttp(app);
  app.enableShutdownHooks();
  await app.listen(environment().port);
} else {
  const app = await NestFactory.createApplicationContext(AppModule, { logger });
  app.enableShutdownHooks();
}
