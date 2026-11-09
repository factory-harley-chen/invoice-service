import { describe, expect, it } from 'vitest';
import type { BillingConfig } from './config.ts';
import { loadRateCard } from './config.ts';
import type { Booking } from './data/bookings.ts';
import { buildInvoice } from './invoice.ts';

// Digits after the separator, as ISO 4217 gives them.
const iso4217Exponents: Record<string, number> = {
  EUR: 2,
  GBP: 2,
  USD: 2,
  JPY: 0,
};

const symbols: Record<string, string> = {
  EUR: '€',
  GBP: '£',
  USD: '$',
  JPY: '¥',
};

function expectedMinor(price: string, exponent: number): number {
  const [whole = '', fraction = ''] = price.split('.');
  if (fraction.length > exponent) throw new Error(`"${price}" has more decimals than ISO 4217 allows`);
  return Number(whole + fraction.padEnd(exponent, '0'));
}

function expectedDisplay(minor: number, exponent: number, symbol: string): string {
  const digits = String(minor).padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${symbol}${grouped}${exponent > 0 ? `.${fraction}` : ''}`;
}

const rates = loadRateCard();
const cases = rates.items.flatMap((rate) =>
  Object.entries(rate.prices).map(([currency, price]) => ({ item: rate.name, currency, price })),
);

describe('every rate card price', () => {
  it.each(cases)('invoices one $item in $currency at exactly $price', ({ item, currency, price }) => {
    const exponent = iso4217Exponents[currency];
    const symbol = symbols[currency];
    if (exponent === undefined || symbol === undefined) {
      throw new Error(`${currency} is priced in the rate card but missing from the ISO 4217 table in this test`);
    }

    const booking: Booking = {
      id: 'B-CHECK',
      customer: { id: 'C-CHECK', name: 'Check customer', billingCurrency: currency },
      items: [{ item, quantity: 1 }],
    };
    const billing: BillingConfig = {
      currencies: [currency],
      fallbackCurrency: currency,
      sendAt: '15:00',
      timeZone: 'Europe/Berlin',
    };

    const invoice = buildInvoice(booking, rates, billing);
    const minor = expectedMinor(price, exponent);
    const line = { minor, formatted: expectedDisplay(minor, exponent, symbol) };

    expect(invoice.currency).toBe(currency);
    expect(invoice.lines[0]?.unitPrice).toEqual(line);
    expect(invoice.lines[0]?.total).toEqual(line);
    expect(invoice.total).toEqual(line);
  });
});
