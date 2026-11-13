import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';

export function requestHeader(
  request: Pick<Request, 'rawHeaders'>,
  name: string,
  required: boolean,
): string | undefined {
  const values: string[] = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    if (request.rawHeaders[i]?.toLowerCase() === name) {
      values.push(request.rawHeaders[i + 1] ?? '');
    }
  }
  if (values.length === 0 && !required) {
    return undefined;
  }
  const value = values[0];
  const valid =
    name === 'x-correlation-id'
      ? /^[A-Za-z0-9._:-]{1,128}$/
      : /^[\x20-\x7E]{1,256}$/;
  if (
    values.length !== 1 ||
    !value ||
    !value.trim() ||
    !valid.test(value) ||
    value.includes(',')
  ) {
    throw new BadRequestException({
      code: 'INVALID_INPUT',
      message: 'Invalid ' + name + ' header',
    });
  }
  return value;
}
