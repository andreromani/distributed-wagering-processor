import { createHash } from 'node:crypto';
import type { WagerPayload } from '../ports/wager-payload.js';
import {
  canonicalJson,
  canonicalPayloadHash,
} from './canonical-payload-hash.js';

export function inboxPayloadHash(
  input: WagerPayload & { idempotencyKey: string },
): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        payloadHash: canonicalPayloadHash(input),
        idempotencyKey: input.idempotencyKey,
      }),
    )
    .digest('hex');
}
