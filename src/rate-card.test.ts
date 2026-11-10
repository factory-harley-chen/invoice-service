import { describe, expect, it } from 'vitest';
import type { BillingConfig } from './config.ts';
import { loadBilling, loadRateCard } from './config.ts';
import { buildInvoice } from './invoice.ts';

// Decimal places from ISO 4217 and the en-GB symbol, written out here so the
// expected amounts do not come from the code under test or Intl's defaults.
const iso4217: Record<string, { digits: number; symbol: string }> = {
  EUR: { digits: 2, symbol: '€' },
  GBP: { digits: 2, symbol: '£' },
  USD: { digits: 2, symbol: '$' },
  JPY: { digits: 0, symbol: '¥' },
};

const rates = loadRateCard();
const billing: BillingConfig = loadBilling({});

const cases = rates.items.flatMap((item) =>
  Object.entries(item.prices).map(([currency, price]) => ({ item: item.name, currency, price })),
);

function expectedAmount(price: string, currency: string) {
  const entry = iso4217[currency];
  if (!entry) throw new Error(`${currency} is on the rate card but not in the ISO 4217 table of this test`);
  const [whole = '', fraction = ''] = price.split('.');
  if (fraction.length > entry.digits) throw new Error(`${currency} price "${price}" has too many decimal places`);
  const paddedFraction = fraction.padEnd(entry.digits, '0');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return {
    minor: Number(whole) * 10 ** entry.digits + Number(paddedFraction || '0'),
    formatted: `${entry.symbol}${grouped}${entry.digits > 0 ? `.${paddedFraction}` : ''}`,
  };
}

describe('rate card currencies', () => {
  it('has every rate card currency in the ISO 4217 table', () => {
    const currencies = [...new Set(cases.map(({ currency }) => currency))];
    expect(currencies.filter((currency) => !Object.hasOwn(iso4217, currency))).toEqual([]);
  });

  it.each(cases)('invoices one unit of $item in $currency at the rate card price $price', ({ item, currency, price }) => {
    const booking = {
      id: 'B-CHECK',
      customer: { id: 'C-CHECK', name: 'Rate card check', billingCurrency: currency },
      items: [{ item, quantity: 1 }],
    };
    const invoice = buildInvoice(booking, rates, { ...billing, currencies: [currency] });
    const expected = expectedAmount(price, currency);

    expect(invoice.currency).toBe(currency);
    expect(invoice.lines[0]?.unitPrice).toEqual(expected);
    expect(invoice.lines[0]?.total).toEqual(expected);
    expect(invoice.total).toEqual(expected);
  });
});
