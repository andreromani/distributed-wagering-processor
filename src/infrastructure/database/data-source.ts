import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { databaseOptions } from './options.js';

const options = databaseOptions();

// Catalog inspection and DDL use an administrative budget, separate from workers.
export default new DataSource({
  ...options,
  connectTimeoutMS: 10000,
  extra: {
    ...options.extra,
    statement_timeout: 60000,
    query_timeout: 65000,
  },
});
