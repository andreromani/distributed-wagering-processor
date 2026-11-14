import type { LoggerService } from '@nestjs/common';
import { instanceId } from '../config/instance-id.js';

export class ApplicationLogger implements LoggerService {
  log(message: unknown): void {
    this.write(
      'info',
      typeof message === 'string' ? message : 'Framework event',
    );
  }

  error(): void {
    this.write('error', 'Application error');
  }

  warn(message: unknown): void {
    this.write(
      'warn',
      typeof message === 'string' ? message : 'Framework warning',
    );
  }

  debug(): void {}

  verbose(): void {}

  fatal(): void {
    this.write('fatal', 'Application fatal error');
  }

  private write(level: string, message: string): void {
    console.log(JSON.stringify({ level, message, instanceId: instanceId() }));
  }
}
