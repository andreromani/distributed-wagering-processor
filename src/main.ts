import { environment } from './infrastructure/config/environment.js';
import { configureHttp } from './infrastructure/http/configure-http.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

if (environment().workers.httpEnabled) {
  const app = await NestFactory.create(AppModule);
  configureHttp(app);
  app.enableShutdownHooks();
  await app.listen(environment().port);
} else {
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
}
