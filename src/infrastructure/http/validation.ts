import { ValidationPipe, BadRequestException, type Type } from '@nestjs/common';

export function httpValidation(expectedType: Type<unknown>): ValidationPipe {
  return new ValidationPipe({
    expectedType,
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    transformOptions: { enableImplicitConversion: false },
    validationError: { target: false, value: false },
    exceptionFactory: () =>
      new BadRequestException({
        code: 'INVALID_INPUT',
        message: 'Invalid request fields',
      }),
  });
}
