const generatedId = crypto.randomUUID();

export function instanceId(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.INSTANCE_ID ?? generatedId;
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) {
    throw new Error('Invalid INSTANCE_ID');
  }

  return value;
}
