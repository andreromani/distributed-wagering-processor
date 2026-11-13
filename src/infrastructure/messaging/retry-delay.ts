export function retryDelay(
  attempt: number,
  base: number,
  maximum: number,
): number {
  return Math.min(maximum, base * 2 ** Math.min(30, Math.max(0, attempt - 1)));
}

export function waitForWorker(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}
