export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export function logLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const value = (env.LOG_LEVEL ?? 'info').toLowerCase();
  if (!['debug', 'info', 'warn', 'error', 'fatal'].includes(value)) {
    throw new Error('Invalid LOG_LEVEL');
  }

  return value as LogLevel;
}
