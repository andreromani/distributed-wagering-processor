import { test, expect } from 'bun:test';
import { Decimal } from 'decimal.js';
import {
  Money,
  type MoneyProps,
} from '../../src/domain/value-objects/money.js';
import { InvalidMoneyAmountError } from '../../src/domain/errors/invalid-money-amount.error.js';
import { InvalidCurrencyError } from '../../src/domain/errors/invalid-currency.error.js';
import { CurrencyMismatchError } from '../../src/domain/errors/currency-mismatch.error.js';
import { MoneyOutOfRangeError } from '../../src/domain/errors/money-out-of-range.error.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

const max = '9999999999999999999999999999.99';

for (const currency of ['BRL', 'USD']) {
  test('creation and serialization in ' + currency, () => {
    const money = Money.from({ amount: '25.00', currency });

    expect(money.currency).toBe(currency);
    expect(money.toJSON()).toEqual({ amount: '25.00', currency });
    expect(JSON.stringify(money)).toBe(
      JSON.stringify({ amount: '25.00', currency }),
    );
    expect(money.toString()).toBe('25.00');
  });
}

test('zero and signed zero normalization', () => {
  const zero = Money.zero('BRL');

  expect(zero.toString()).toBe('0.00');
  expect(zero.isZero()).toBe(true);
  expect(zero.isPositive()).toBe(false);
  expect(zero.isNegative()).toBe(false);
  expect(zero.negate().toString()).toBe('0.00');
  expect(Money.rehydrate({ amount: '-0.00', currency: 'BRL' }).toString()).toBe(
    '0.00',
  );
});

test('exact arithmetic and negative results', () => {
  expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');

  const negative = brl('1.00').subtract(brl('2.50'));

  expect(negative.toString()).toBe('-1.50');
  expect(negative.isNegative()).toBe(true);
  expect(negative.isPositive()).toBe(false);
  expect(negative.negate().toString()).toBe('1.50');
  expect(negative.add(brl('1.50')).isZero()).toBe(true);
  expect(brl('2.50').subtract(brl('1.00')).toString()).toBe('1.50');
});

test('comparisons', () => {
  const one = brl('1.00');

  expect(one.isPositive()).toBe(true);
  expect(one.isZero()).toBe(false);
  expect(one.isLessThan(brl('2.00'))).toBe(true);
  expect(one.isLessThan(brl('1.00'))).toBe(false);
  expect(one.isLessThan(brl('0.00'))).toBe(false);
  expect(one.equals(brl('1.00'))).toBe(true);
  expect(one.equals(brl('2.00'))).toBe(false);
});

test('operands and serialized copies remain independent', () => {
  const left = brl('2.00');
  const right = brl('1.00');
  for (const result of [
    left.add(right),
    left.subtract(right),
    left.negate(),
    left.add(Money.zero('BRL')),
    left.subtract(Money.zero('BRL')),
  ]) {
    expect(result).not.toBe(left);
    expect(result).not.toBe(right);
  }
  const props = left.toJSON();
  props.amount = '9.00';

  expect(left.toString()).toBe('2.00');
  expect(right.toString()).toBe('1.00');
  expect(Object.isFrozen(left)).toBe(true);
  expect(Reflect.set(left, 'currency', 'USD')).toBe(false);
});

test('repeated arithmetic is exact', () => {
  let value = Money.zero('BRL');
  for (let i = 0; i < 1000; i++) value = value.add(brl('0.01'));

  expect(value.toString()).toBe('10.00');

  for (let i = 0; i < 1000; i++) value = value.subtract(brl('0.01'));

  expect(value.toString()).toBe('0.00');
});

test('large values preserve cents through cancellation and at limits', () => {
  expect(brl('9007199254740993.01').add(brl('0.01')).toString()).toBe(
    '9007199254740993.02',
  );
  expect(brl(max).subtract(brl('0.01')).toString()).toBe(
    '9999999999999999999999999999.98',
  );
  expect(
    brl(max).subtract(brl('9999999999999999999999999999.98')).toString(),
  ).toBe('0.01');
  expect(brl(max).negate().negate().toString()).toBe(max);
  expect(brl(max).add(Money.zero('BRL')).toString()).toBe(max);
});

test('global Decimal configuration does not affect Money', () => {
  const precision = Decimal.precision;
  try {
    Decimal.set({ precision: 2 });

    expect(brl(max).subtract(brl('0.01')).toString()).toBe(
      '9999999999999999999999999999.98',
    );
  } finally {
    Decimal.set({ precision });
  }
});

for (const amount of [
  '',
  ' ',
  'NaN',
  'Infinity',
  '-Infinity',
  '1e2',
  '1E+2',
  '1,000.00',
  '1,25',
  '1.001',
  '1.000',
  'abc',
  '1.00x',
  ' 1.00',
  '1.00 ',
  '+1.00',
  '.50',
  '1.',
  '10',
  '10.5',
  '01.00',
  '-1.00',
  '-0.00',
  '0x10',
  '1.00\n',
]) {
  test('rejects invalid external amount ' + JSON.stringify(amount), () => {
    expect(() => brl(amount)).toThrow(InvalidMoneyAmountError);
  });
}

for (const amount of [1, NaN, Infinity, null, undefined, {}, true]) {
  test('rejects runtime non-string ' + JSON.stringify(amount), () => {
    const props = { amount, currency: 'BRL' } as unknown as MoneyProps;

    expect(() => Money.from(props)).toThrow(InvalidMoneyAmountError);
  });
}

for (const currency of ['', 'brl', ' BRL', 'ZZZ', 'EUR', 'US', 'USDD']) {
  test('rejects unsupported currency ' + currency, () => {
    expect(() => Money.zero(currency)).toThrow(InvalidCurrencyError);
  });
}

test('rehydration validates representation and permits signed values', () => {
  expect(
    Money.rehydrate({ amount: '-1.25', currency: 'USD' }).toJSON(),
  ).toEqual({ amount: '-1.25', currency: 'USD' });
  expect(() => Money.rehydrate({ amount: '-1.001', currency: 'BRL' })).toThrow(
    InvalidMoneyAmountError,
  );
  expect(() => Money.rehydrate({ amount: '1.00', currency: 'ZZZ' })).toThrow(
    InvalidCurrencyError,
  );
});

test('overflow is explicit for creation and both arithmetic directions', () => {
  expect(() => brl('10000000000000000000000000000.00')).toThrow(
    MoneyOutOfRangeError,
  );
  expect(() => brl(max).add(brl('0.01'))).toThrow(MoneyOutOfRangeError);
  expect(() => brl(max).negate().subtract(brl('0.01'))).toThrow(
    MoneyOutOfRangeError,
  );
  expect(() => brl(max).subtract(brl(max).negate())).toThrow(
    MoneyOutOfRangeError,
  );
  expect(() =>
    Money.rehydrate({
      amount: '-10000000000000000000000000000.00',
      currency: 'BRL',
    }),
  ).toThrow(MoneyOutOfRangeError);
});

for (const method of ['add', 'subtract', 'isLessThan', 'equals'] as const) {
  test('currency mismatch in ' + method, () => {
    expect(() =>
      brl('1.00')[method](Money.from({ amount: '1.00', currency: 'USD' })),
    ).toThrow(CurrencyMismatchError);
  });
}
