import { describe, expect, it } from 'vitest';
import type { BillingConfig } from './config.ts';
import { loadBilling, loadRateCard } from './config.ts';
import type { Booking } from './data/bookings.ts';
import { buildInvoice } from './invoice.ts';

// Written out from ISO 4217 on purpose, so the expected amounts do not come
// from the code under test or from Intl's defaults.
const iso4217: Record<string, { digits: number; symbol: string }> = {
  EUR: { digits: 2, symbol: '€' },
  GBP: { digits: 2, symbol: '£' },
  USD: { digits: 2, symbol: '$' },
  JPY: { digits: 0, symbol: '¥' },
};

const rates = loadRateCard();

function expected(price: string, currency: string): { minor: number; formatted: string } {
  const entry = iso4217[currency];
  if (!entry) throw new Error(`${currency} is on the rate card but missing from the ISO 4217 table in this test`);
  const [whole = '', fraction = ''] = price.split('.');
  if (fraction.length > entry.digits) {
    throw new Error(`${currency} price "${price}" has more than ${entry.digits} decimal places`);
  }
  const digits = fraction.padEnd(entry.digits, '0');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return {
    minor: Number(whole + digits),
    formatted: `${entry.symbol}${grouped}${digits ? `.${digits}` : ''}`,
  };
}

const cases = rates.items.flatMap((item) =>
  Object.entries(item.prices).map(([currency, price]) => ({ item: item.name, currency, price })),
);

describe('rate card', () => {
  it.each(cases)('invoices one unit of $item in $currency at its price $price', ({ item, currency, price }) => {
    const billing: BillingConfig = { ...loadBilling({}), currencies: [currency] };
    const booking: Booking = {
      id: 'B-CHECK',
      customer: { id: 'C-CHECK', name: 'Check', billingCurrency: currency },
      items: [{ item, quantity: 1 }],
    };
    const invoice = buildInvoice(booking, rates, billing);
    const want = expected(price, currency);
    expect(invoice.currency).toBe(currency);
    expect(invoice.lines[0]?.unitPrice).toEqual(want);
    expect(invoice.lines[0]?.total).toEqual(want);
    expect(invoice.total).toEqual(want);
  });
});
