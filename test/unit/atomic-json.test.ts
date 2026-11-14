import { afterEach, expect, test } from 'bun:test';
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson } from '../../scripts/support/atomic-json.js';

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true });
  }
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'wager-atomic-json-'));
  directories.push(directory);
  const path = join(directory, 'control.json');
  await writeFile(path, JSON.stringify({ point: 'original' }));

  return { directory, path };
}

function filesystemError(code: string): Error & { code: string } {
  return Object.assign(new Error('Injected filesystem failure'), { code });
}

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
  test(
    code + ' retries replacement while readers retain the original JSON',
    async () => {
      const { directory, path } = await fixture();
      const waits: number[] = [];
      let attempts = 0;

      await atomicJson(
        path,
        { point: null, ids: [] },
        {
          rename: async (source, destination) => {
            attempts += 1;
            expect(destination).toBe(path);
            expect(JSON.parse(await readFile(source, 'utf8'))).toEqual({
              point: null,
              ids: [],
            });

            if (attempts === 1) {
              throw filesystemError(code);
            }

            await rename(source, destination);
          },
          wait: async (milliseconds) => {
            waits.push(milliseconds);
            expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
              point: 'original',
            });
          },
        },
      );

      expect(attempts).toBe(2);
      expect(waits).toEqual([10]);
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
        point: null,
        ids: [],
      });
      expect(await readdir(directory)).toEqual(['control.json']);
    },
  );
}

test('replacement exhaustion preserves the active file, removes its temporary and propagates the error', async () => {
  const { directory, path } = await fixture();
  const error = filesystemError('EPERM');
  const waits: number[] = [];
  let attempts = 0;

  expect(
    atomicJson(
      path,
      { point: null },
      {
        rename: async () => {
          attempts += 1;
          throw error;
        },
        wait: async (milliseconds) => {
          waits.push(milliseconds);
        },
      },
    ),
  ).rejects.toBe(error);

  expect(attempts).toBe(8);
  expect(waits).toEqual([10, 20, 40, 80, 100, 100, 100]);
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
    point: 'original',
  });
  expect(await readdir(directory)).toEqual(['control.json']);
});

for (const code of ['EIO', 'ENOENT', 'ENOSPC']) {
  test(
    code + ' is propagated immediately without hiding permanent errors',
    async () => {
      const { directory, path } = await fixture();
      const error = filesystemError(code);
      let attempts = 0;
      const waits: number[] = [];

      expect(
        atomicJson(
          path,
          { point: null },
          {
            rename: async () => {
              attempts += 1;
              throw error;
            },
            wait: async (milliseconds) => {
              waits.push(milliseconds);
            },
          },
        ),
      ).rejects.toBe(error);

      expect(attempts).toBe(1);
      expect(waits).toEqual([]);
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
        point: 'original',
      });
      expect(await readdir(directory)).toEqual(['control.json']);
    },
  );
}

test('same-path writers retain invocation order during retries while different paths progress', async () => {
  const { directory, path } = await fixture();
  const entered = deferred();
  const release = deferred();
  const commits: unknown[] = [];
  const temporaries = new Set<string>();
  let attempts = 0;
  const replacement = async (source: string, destination: string) => {
    const value: unknown = JSON.parse(await readFile(source, 'utf8'));
    temporaries.add(source);
    commits.push(value);
    await rename(source, destination);
  };
  const first = atomicJson(
    path,
    { point: 'armed' },
    {
      rename: async (source, destination) => {
        attempts += 1;
        if (attempts === 1) {
          throw filesystemError('EBUSY');
        }

        await replacement(source, destination);
      },
      wait: async () => {
        entered.resolve();
        await release.promise;
      },
    },
  );
  await entered.promise;
  const middleValue = { point: 'newer' };
  const second = atomicJson(path, middleValue, { rename: replacement });
  middleValue.point = 'mutated-after-call';
  const third = atomicJson(path, { point: null }, { rename: replacement });

  try {
    const other = join(directory, 'other.json');
    await atomicJson(other, { independent: true });

    expect(JSON.parse(await readFile(other, 'utf8'))).toEqual({
      independent: true,
    });
    expect(commits).toEqual([]);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      point: 'original',
    });
  } finally {
    release.resolve();
    await Promise.all([first, second, third]);
  }

  expect(commits).toEqual([
    { point: 'armed' },
    { point: 'newer' },
    { point: null },
  ]);
  expect(temporaries.size).toBe(3);
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ point: null });
  expect((await readdir(directory)).sort()).toEqual([
    'control.json',
    'other.json',
  ]);
});

test('a queued disarm succeeds after an older writer exhausts retries', async () => {
  const { directory, path } = await fixture();
  const entered = deferred();
  const release = deferred();
  const error = filesystemError('EACCES');
  let attempts = 0;
  const first = atomicJson(
    path,
    { point: 'armed' },
    {
      rename: async () => {
        attempts += 1;
        throw error;
      },
      wait: async () => {
        entered.resolve();
        await release.promise;
      },
    },
  );
  const rejected = first.catch((failure: unknown) => failure);
  await entered.promise;
  const disarm = atomicJson(path, { point: null });
  release.resolve();
  const [failure] = await Promise.all([rejected, disarm]);

  expect(failure).toBe(error);
  expect(attempts).toBe(8);
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ point: null });
  expect(await readdir(directory)).toEqual(['control.json']);
});

test('unserializable values never create a temporary or replace active JSON', async () => {
  const { directory, path } = await fixture();

  expect(atomicJson(path, undefined)).rejects.toBeInstanceOf(TypeError);

  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
    point: 'original',
  });
  expect(await readdir(directory)).toEqual(['control.json']);
});
