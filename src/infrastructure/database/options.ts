import type { DataSourceOptions } from 'typeorm';
import { financialEntities } from './entities/financial-entities.js';
import { environment } from '../config/environment.js';

export function databaseOptions(): Extract<
  DataSourceOptions,
  { type: 'postgres' }
> {
  return {
    type: 'postgres',
    ...environment().database,
    synchronize: false,
    migrationsRun: false,
    entities: financialEntities,
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
