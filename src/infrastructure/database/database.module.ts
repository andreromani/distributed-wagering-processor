import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { databaseOptions } from './options.js';
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () => ({ ...databaseOptions(), manualInitialization: true }),
    }),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
