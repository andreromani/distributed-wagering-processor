import { Injectable, type CanActivate } from '@nestjs/common';

/** Extension point only: this no-op guard provides no authentication or authorization. */
@Injectable()
export class FinancialAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
