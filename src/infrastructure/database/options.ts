import type { DataSourceOptions } from 'typeorm';
import { environment } from '../config/environment.js';

export function databaseOptions(): DataSourceOptions {
  return {
    type: 'postgres',
    ...environment().database,
    synchronize: false,
    migrationsRun: false,
    entities: [import.meta.dirname + '/entities/**/*.js'],
    migrations: [import.meta.dirname + '/migrations/**/*.js'],
    poolSize: 3,
    connectTimeoutMS: 2000,
    extra: {
      statement_timeout: 2000,
      query_timeout: 2500,
      idleTimeoutMillis: 10000,
    },
  };
}
