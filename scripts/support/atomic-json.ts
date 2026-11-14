import { open, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

interface AtomicJsonOptions {
  rename?: (source: string, destination: string) => Promise<void>;
  wait?: (milliseconds: number) => Promise<unknown>;
}

const pendingWrites = new Map<string, Promise<void>>();
const transientCodes = new Set(['EPERM', 'EBUSY', 'EACCES']);

function codeOf(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error
    ? error.code
    : undefined;
}

async function retryTransient(
  action: () => Promise<void>,
  wait: (milliseconds: number) => Promise<unknown>,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await action();
      return;
    } catch (error) {
      if (!transientCodes.has(String(codeOf(error))) || attempt >= 7) {
        throw error;
      }

      await wait(Math.min(10 * 2 ** attempt, 100));
    }
  }
}

async function replaceJson(
  target: string,
  json: string,
  options: AtomicJsonOptions,
): Promise<void> {
  const temporary = target + '.' + crypto.randomUUID() + '.next';
  const file = await open(temporary, 'wx');
  const wait = options.wait ?? Bun.sleep;

  try {
    try {
      await file.writeFile(json, 'utf8');
    } finally {
      await file.close();
    }

    await retryTransient(
      () => (options.rename ?? rename)(temporary, target),
      wait,
    );
  } catch (error) {
    try {
      await retryTransient(() => unlink(temporary), wait);
    } catch (cleanupError) {
      if (codeOf(cleanupError) !== 'ENOENT') {
        throw new AggregateError(
          [error, cleanupError],
          'Atomic JSON replacement and temporary cleanup failed',
        );
      }
    }

    throw error;
  }
}

/** Serializes this process's writers per path; readers see only complete renames. */
export async function atomicJson(
  path: string,
  value: unknown,
  options: AtomicJsonOptions = {},
): Promise<void> {
  const target = resolve(path);
  const key = process.platform === 'win32' ? target.toLowerCase() : target;
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError('Atomic JSON value must be serializable');
  }

  const previous = pendingWrites.get(key) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => replaceJson(target, json, options));
  pendingWrites.set(key, current);

  try {
    await current;
  } finally {
    if (pendingWrites.get(key) === current) {
      pendingWrites.delete(key);
    }
  }
}
