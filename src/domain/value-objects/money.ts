import { Decimal } from 'decimal.js';
import {
  InvalidMoneyAmountError,
  InvalidCurrencyError,
  CurrencyMismatchError,
  MoneyOutOfRangeError,
} from '../errors/money.errors.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

// Two bounded 30-digit operands need at most 31 significant digits when added.
const MoneyDecimal = Decimal.clone({
  precision: 32,
  rounding: Decimal.ROUND_HALF_EVEN,
});
const maximum = new MoneyDecimal('9999999999999999999999999999.99');

export class Money {
  readonly #value: Decimal;
  public readonly currency: string;

  private constructor(value: Decimal, currency: string) {
    if (value.abs().greaterThan(maximum)) throw new MoneyOutOfRangeError();
    this.#value = value.isZero() ? new MoneyDecimal('0') : value;
    this.currency = currency;
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    const money = Money.rehydrate(props);
    if (money.isNegative() || props.amount.startsWith('-'))
      throw new InvalidMoneyAmountError();
    return money;
  }

  static rehydrate(props: MoneyProps): Money {
    if (
      typeof props?.amount !== 'string' ||
      !/^-?(0|[1-9]\d*)\.\d{2}(?![\s\S])/.test(props.amount)
    ) {
      throw new InvalidMoneyAmountError();
    }
    if (props.currency !== 'BRL' && props.currency !== 'USD')
      throw new InvalidCurrencyError();
    const unsigned = props.amount.replace(/^-/, '');
    if (unsigned.length > 31) throw new MoneyOutOfRangeError();
    return new Money(new MoneyDecimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.#value.plus(other.#value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.#value.minus(other.#value), this.currency);
  }

  negate(): Money {
    return new Money(this.#value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.#value.isZero();
  }

  isPositive(): boolean {
    return this.#value.greaterThan('0');
  }
  
  isNegative(): boolean {
    return this.#value.lessThan('0');
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#value.lessThan(other.#value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#value.equals(other.#value);
  }

  toJSON(): MoneyProps {
    return { amount: this.#value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return this.toJSON().amount;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new CurrencyMismatchError();
  }
}
