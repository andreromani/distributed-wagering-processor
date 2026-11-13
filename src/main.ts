import { configureHttp } from './infrastructure/http/configure-http.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

const app = await NestFactory.create(AppModule);

configureHttp(app);
app.enableShutdownHooks();

await app.listen(process.env.PORT ?? 3000);
