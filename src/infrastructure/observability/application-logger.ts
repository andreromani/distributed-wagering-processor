import type { LoggerService } from '@nestjs/common';
import { JsonLog } from './json-log.js';

export class ApplicationLogger implements LoggerService {
  constructor(private readonly output = new JsonLog()) {}

  log(_message: unknown): void {
    this.write('info', 'Framework event');
  }

  error(): void {
    this.write('error', 'Application error');
  }

  warn(_message: unknown): void {
    this.write('warn', 'Framework warning');
  }

  debug(): void {
    this.write('debug', 'Framework debug');
  }

  verbose(): void {
    this.write('debug', 'Framework verbose');
  }

  fatal(): void {
    this.write('fatal', 'Application fatal error');
  }

  private write(
    level: 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    message: string,
  ): void {
    this.output.emit(level, 'framework_' + level, { message });
  }
}
