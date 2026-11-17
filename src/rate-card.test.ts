import { describe, expect, it } from 'vitest';
import type { BillingConfig } from './config.ts';
import { loadRateCard } from './config.ts';
import { buildInvoice } from './invoice.ts';

// Decimal places from ISO 4217, with the symbol the invoice shows.
const iso4217: Record<string, { decimals: number; symbol: string }> = {
  EUR: { decimals: 2, symbol: '€' },
  GBP: { decimals: 2, symbol: '£' },
  USD: { decimals: 2, symbol: '$' },
  JPY: { decimals: 0, symbol: '¥' },
};

function expectedAmount(price: string, currency: string) {
  const entry = iso4217[currency];
  if (!entry) throw new Error(`${currency} is on the rate card but not in the ISO 4217 table`);
  const [whole = '', fraction = ''] = price.split('.');
  if (fraction.length > entry.decimals) {
    throw new Error(`${currency} price "${price}" has more than ${entry.decimals} decimal places`);
  }
  const digits = fraction.padEnd(entry.decimals, '0');
  const grouped = BigInt(whole).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return {
    minor: Number(whole) * 10 ** entry.decimals + Number(digits || '0'),
    formatted: `${entry.symbol}${grouped}${entry.decimals > 0 ? `.${digits}` : ''}`,
  };
}

const rates = loadRateCard();
const cases = rates.items.flatMap((item) =>
  Object.entries(item.prices).map(([currency, price]) => ({ item: item.name, currency, price })),
);

describe('every rate card price', () => {
  it('covers every currency on the rate card', () => {
    const currencies = new Set(cases.map((entry) => entry.currency));
    expect([...currencies].sort()).toEqual(['EUR', 'GBP', 'JPY', 'USD']);
  });

  it.each(cases)('invoices one $item in $currency at exactly $price', ({ item, currency, price }) => {
    const billing: BillingConfig = {
      currencies: [currency],
      fallbackCurrency: currency,
      sendAt: '15:00',
      timeZone: 'Europe/Berlin',
    };
    const invoice = buildInvoice(
      {
        id: 'B-TEST',
        customer: { id: 'C-TEST', name: 'Test customer', billingCurrency: currency },
        items: [{ item, quantity: 1 }],
      },
      rates,
      billing,
    );
    const expected = expectedAmount(price, currency);
    expect(invoice.currency).toBe(currency);
    expect(invoice.lines[0]?.unitPrice).toEqual(expected);
    expect(invoice.lines[0]?.total).toEqual(expected);
    expect(invoice.total).toEqual(expected);
  });
});
