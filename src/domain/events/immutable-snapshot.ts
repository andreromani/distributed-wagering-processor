export function immutableSnapshot<T>(value: T): T {
  const copy = structuredClone(value);

  const freeze = (item: unknown): void => {
    if (item !== null && typeof item === 'object') {
      for (const child of Object.values(item)) {
        freeze(child);
      }
      Object.freeze(item);
    }
  };

  freeze(copy);

  return copy;
}
