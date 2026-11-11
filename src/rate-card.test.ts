import { describe, expect, it } from 'vitest';
import type { BillingConfig } from './config.ts';
import { loadBilling, loadRateCard } from './config.ts';
import type { Booking } from './data/bookings.ts';
import { buildInvoice } from './invoice.ts';

// Digits after the separator as ISO 4217 gives them, and the symbol shown on invoices.
const iso4217: Record<string, { digits: number; symbol: string }> = {
  EUR: { digits: 2, symbol: '€' },
  GBP: { digits: 2, symbol: '£' },
  USD: { digits: 2, symbol: '$' },
  JPY: { digits: 0, symbol: '¥' },
};

const rates = loadRateCard();

const cases = rates.items.flatMap((rate) =>
  Object.entries(rate.prices).map(([currency, price]) => ({ item: rate.name, currency, price })),
);

function expected(price: string, currency: string): { minor: number; formatted: string } {
  const entry = iso4217[currency];
  if (!entry) throw new Error(`${currency} is on the rate card but not in the ISO 4217 table`);
  const [whole = '', fraction = ''] = price.split('.');
  if (fraction.length > entry.digits) {
    throw new Error(`${price} has more decimal places than ${currency} allows`);
  }
  const padded = fraction.padEnd(entry.digits, '0');
  const grouped = whole.replace(/\B(?=(\d{3})+$)/g, ',');
  return {
    minor: Number(whole + padded),
    formatted: entry.symbol + grouped + (entry.digits > 0 ? `.${padded}` : ''),
  };
}

describe('every rate card price', () => {
  it('covers every currency on the rate card', () => {
    const currencies = new Set(cases.map(({ currency }) => currency));
    expect([...currencies].filter((currency) => !(currency in iso4217))).toEqual([]);
  });

  it.each(cases)('invoices one unit of $item in $currency at exactly $price', ({ item, currency, price }) => {
    const booking: Booking = {
      id: 'B-CHECK',
      customer: { id: 'C-CHECK', name: 'Rate card check', billingCurrency: currency },
      items: [{ item, quantity: 1 }],
    };
    const billing: BillingConfig = { ...loadBilling({}), currencies: [currency] };
    const invoice = buildInvoice(booking, rates, billing);
    const want = expected(price, currency);

    expect(invoice.currency).toBe(currency);
    expect(invoice.lines[0]?.unitPrice).toEqual(want);
    expect(invoice.lines[0]?.total).toEqual(want);
    expect(invoice.total).toEqual(want);
  });
});
