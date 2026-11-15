import { environment } from './infrastructure/config/environment.js';
import { configureHttp } from './infrastructure/http/configure-http.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ApplicationLogger } from './infrastructure/observability/application-logger.js';
import { JsonLog } from './infrastructure/observability/json-log.js';

const logger = new ApplicationLogger();
process.once('SIGTERM', () => {
  new JsonLog().emit('info', 'signal_received', { signal: 'SIGTERM' });
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
