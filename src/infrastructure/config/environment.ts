import { workerOptions } from './worker-options.js';
import { instanceId } from './instance-id.js';
export function environment(env: NodeJS.ProcessEnv = process.env) {
  const get = (name: string): string => {
    const value = env[name];

    if (!value?.trim()) {
      throw new Error('Missing variable: ' + name);
    }

    return value;
  };
  const port = (name: string) => {
    const value = get(name);

    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
      throw new Error('Invalid ' + name);
    }

    return Number(value);
  };
  const endpoint = new URL(get('SQS_ENDPOINT'));

  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new Error('Invalid SQS_ENDPOINT');
  }

  return {
    instanceId: instanceId(env),
    workers: workerOptions(env),
    port: port('PORT'),
    database: {
      host: get('POSTGRES_HOST'),
      port: port('POSTGRES_PORT'),
      database: get('POSTGRES_DB'),
      username: get('POSTGRES_USER'),
      password: get('POSTGRES_PASSWORD'),
    },
    sqs: {
      endpoint: endpoint.href,
      region: get('AWS_REGION'),
      credentials: {
        accessKeyId: get('AWS_ACCESS_KEY_ID'),
        secretAccessKey: get('AWS_SECRET_ACCESS_KEY'),
      },
    },
    queueName: get('SQS_QUEUE_NAME'),
    dlqName: get('SQS_DLQ_NAME'),
  };
}
