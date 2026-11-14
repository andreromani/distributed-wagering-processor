import { existsSync, readFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { instanceId } from '../config/instance-id.js';
import { waitForWorker } from './retry-delay.js';

export type DistributedTestPoint =
  'consumer-after-commit' | 'publisher-before-send' | 'publisher-after-send';

export class DistributedTestBarrier {
  readonly #directory: string | undefined;
  readonly #runId: string | undefined;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const enabled = env.DISTRIBUTED_TEST_HOOKS_ENABLED ?? 'false';
    if (enabled !== 'true' && enabled !== 'false') {
      throw new Error('Invalid DISTRIBUTED_TEST_HOOKS_ENABLED');
    }

    if (enabled === 'true') {
      if (
        !env.DISTRIBUTED_TEST_DIRECTORY ||
        !/^[a-f0-9-]{36}$/i.test(env.DISTRIBUTED_TEST_RUN_ID ?? '')
      ) {
        throw new Error(
          'Explicit distributed test directory and run ID required',
        );
      }

      this.#directory = env.DISTRIBUTED_TEST_DIRECTORY;
      this.#runId = env.DISTRIBUTED_TEST_RUN_ID;
    }
  }

  private matches(point: DistributedTestPoint, id: string): boolean {
    if (!this.#directory) {
      return false;
    }

    const path = join(this.#directory, 'control.json');
    if (!existsSync(path)) {
      return false;
    }

    const control: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return (
      !!control &&
      typeof control === 'object' &&
      'runId' in control &&
      control.runId === this.#runId &&
      'point' in control &&
      control.point === point &&
      'ids' in control &&
      Array.isArray(control.ids) &&
      control.ids.includes(id)
    );
  }

  async wait(
    point: DistributedTestPoint,
    id: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.matches(point, id)) {
      return;
    }

    if (!/^[a-f0-9-]{36}$/i.test(id) || !this.#directory) {
      throw new Error('Invalid distributed test target');
    }

    const marker = {
      runId: this.#runId,
      point,
      id,
      instanceId: instanceId(),
      pid: process.pid,
      reachedAt: new Date().toISOString(),
    };
    const path = join(this.#directory, point + '-' + id + '.json');
    await Bun.write(path + '.next', JSON.stringify(marker));
    await rename(path + '.next', path);
    console.log(
      JSON.stringify({ event: 'distributed_test_barrier', ...marker }),
    );
    const deadline = Date.now() + 180000;
    while (this.matches(point, id)) {
      signal.throwIfAborted();
      if (Date.now() >= deadline) {
        throw new Error('Distributed test barrier deadline');
      }

      await waitForWorker(25, signal);
    }
    signal.throwIfAborted();
  }
}
