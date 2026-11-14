import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DistributedTestBarrier } from '../../src/infrastructure/messaging/distributed-test-barrier.js';

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true });
  }
});

test('distributed barriers are disabled by default', async () => {
  expect(
    await new DistributedTestBarrier({}).wait(
      'consumer-after-commit',
      crypto.randomUUID(),
      new AbortController().signal,
    ),
  ).toBeUndefined();
});

test('distributed barriers require explicit valid configuration', () => {
  expect(
    () => new DistributedTestBarrier({ DISTRIBUTED_TEST_HOOKS_ENABLED: 'yes' }),
  ).toThrow();
  expect(
    () =>
      new DistributedTestBarrier({ DISTRIBUTED_TEST_HOOKS_ENABLED: 'true' }),
  ).toThrow();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'wager-barrier-'));
  directories.push(directory);
  const runId = crypto.randomUUID();
  const id = crypto.randomUUID();
  const barrier = new DistributedTestBarrier({
    DISTRIBUTED_TEST_HOOKS_ENABLED: 'true',
    DISTRIBUTED_TEST_DIRECTORY: directory,
    DISTRIBUTED_TEST_RUN_ID: runId,
  });
  return { directory, runId, id, barrier };
}

test('barriers match the run, point and target and release after disarming', async () => {
  const { directory, runId, id, barrier } = await fixture();
  const path = join(directory, 'control.json');
  await Bun.write(
    path,
    JSON.stringify({
      runId: crypto.randomUUID(),
      point: 'consumer-after-commit',
      ids: [id],
    }),
  );
  expect(
    await barrier.wait(
      'consumer-after-commit',
      id,
      new AbortController().signal,
    ),
  ).toBeUndefined();
  await Bun.write(
    path,
    JSON.stringify({ runId, point: 'consumer-after-commit', ids: [id] }),
  );
  expect(
    await barrier.wait(
      'publisher-after-send',
      id,
      new AbortController().signal,
    ),
  ).toBeUndefined();
  expect(
    await barrier.wait(
      'consumer-after-commit',
      crypto.randomUUID(),
      new AbortController().signal,
    ),
  ).toBeUndefined();
  let finished = false;
  const waiting = barrier
    .wait('consumer-after-commit', id, new AbortController().signal)
    .then(() => {
      finished = true;
    });
  const deadline = Date.now() + 1000;
  const marker = Bun.file(
    join(directory, 'consumer-after-commit-' + id + '.json'),
  );
  while (!(await marker.exists()) && Date.now() < deadline) {
    await Bun.sleep(5);
  }

  expect(await marker.exists()).toBe(true);
  expect(finished).toBe(false);
  expect(
    (
      await Bun.file(
        join(directory, 'consumer-after-commit-' + id + '.json'),
      ).json()
    ).id,
  ).toBe(id);
  await Bun.write(
    path + '.next',
    JSON.stringify({ runId, point: null, ids: [] }),
  );
  await rename(path + '.next', path);
  await waiting;
  expect(finished).toBe(true);
});

test('barriers respect worker cancellation', async () => {
  const { directory, runId, id, barrier } = await fixture();
  await Bun.write(
    join(directory, 'control.json'),
    JSON.stringify({ runId, point: 'publisher-after-send', ids: [id] }),
  );
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  const result = await barrier
    .wait('publisher-after-send', id, controller.signal)
    .catch((error: unknown) => error);
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toBe('cancelled');
});
