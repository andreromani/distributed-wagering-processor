import { DataSource } from 'typeorm';

const connecting = new WeakMap<DataSource, Promise<DataSource>>();

export async function ensureDatabaseConnection(
  source: DataSource,
): Promise<void> {
  if (source.isInitialized) {
    return;
  }

  let pending = connecting.get(source);
  if (!pending) {
    pending = source.initialize().finally(() => {
      connecting.delete(source);
    });
    connecting.set(source, pending);
  }

  await pending;
}
