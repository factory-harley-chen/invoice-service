import { describe, expect, it } from 'vitest';
import type { BillingConfig } from './config.ts';
import { loadBilling, loadRateCard } from './config.ts';
import type { Booking } from './data/bookings.ts';
import { buildInvoice } from './invoice.ts';

// Decimal places from ISO 4217, written out here so the expected amounts
// do not depend on the code under test or on Intl's defaults.
const iso4217: Record<string, { decimals: number; symbol: string }> = {
  EUR: { decimals: 2, symbol: '€' },
  GBP: { decimals: 2, symbol: '£' },
  USD: { decimals: 2, symbol: '$' },
  JPY: { decimals: 0, symbol: '¥' },
};

const rates = loadRateCard();
const billing: BillingConfig = loadBilling({});

function expected(price: string, currency: string) {
  const entry = iso4217[currency];
  if (!entry) throw new Error(`${currency} is on the rate card but not in the ISO 4217 table`);
  const [whole = '', fraction = ''] = price.trim().split('.');
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction) || fraction.length > entry.decimals) {
    throw new Error(`${currency} price "${price}" does not fit ${entry.decimals} decimal places`);
  }
  const digits = fraction.padEnd(entry.decimals, '0');
  const grouped = String(Number(whole)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return {
    minor: Number(whole) * 10 ** entry.decimals + Number(digits || '0'),
    formatted: `${entry.symbol}${grouped}${entry.decimals > 0 ? `.${digits}` : ''}`,
  };
}

const cases = rates.items.flatMap((rate) =>
  Object.entries(rate.prices).map(([currency, price]) => ({ item: rate.name, currency, price })),
);

describe('every rate card price', () => {
  it.each(cases)('invoices one $item in $currency at the rate card price $price', ({ item, currency, price }) => {
    const booking: Booking = {
      id: 'B-CHECK',
      customer: { id: 'C-CHECK', name: 'Check customer', billingCurrency: currency },
      items: [{ item, quantity: 1 }],
    };
    const invoice = buildInvoice(booking, rates, { ...billing, currencies: [currency] });
    const amount = expected(price, currency);

    expect(invoice.currency).toBe(currency);
    expect(invoice.lines[0]?.unitPrice).toEqual(amount);
    expect(invoice.lines[0]?.total).toEqual(amount);
    expect(invoice.total).toEqual(amount);
  });
});
