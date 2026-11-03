import { describe, expect, it } from 'vitest';
import { loadBilling, loadRateCard } from './config.ts';
import type { Booking } from './data/bookings.ts';
import { buildInvoice } from './invoice.ts';

const rates = loadRateCard();

// Expected values come from the ISO digits that Intl knows, not from src/, so a
// wrong entry in the currency table or price parser cannot hide here.
function isoDigits(currency: string): number {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

function displayed(price: string, currency: string): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).format(
    Number(price),
  );
}

const cases = rates.items.flatMap((item) =>
  Object.entries(item.prices).map(([currency, price]) => ({ item: item.name, currency, price })),
);

describe('every rate card price', () => {

  it.each(cases)('invoices one unit of $item in $currency at $price', ({ item, currency, price }) => {
    const booking: Booking = {
      id: 'B-CHECK',
      customer: { id: 'C-CHECK', name: 'Check customer', billingCurrency: currency },
      items: [{ item, quantity: 1 }],
    };
    const invoice = buildInvoice(booking, rates, loadBilling({ BILLING_CURRENCIES: currency }));
    const expected = {
      minor: Math.round(Number(price) * 10 ** isoDigits(currency)),
      formatted: displayed(price, currency),
    };

    expect(invoice.currency).toBe(currency);
    expect(invoice.lines[0]?.unitPrice).toEqual(expected);
    expect(invoice.lines[0]?.total).toEqual(expected);
    expect(invoice.total).toEqual(expected);
  });
});
