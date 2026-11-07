import { describe, expect, it } from 'vitest';
import type { BillingConfig } from './config.ts';
import { loadBilling, loadRateCard } from './config.ts';
import type { Booking } from './data/bookings.ts';
import { buildInvoice } from './invoice.ts';

const rates = loadRateCard();

// Expected values come from the rate card text and the standard decimal places
// for each currency, not from the code under test.
function expectedAmount(price: string, currency: string) {
  const format = new Intl.NumberFormat('en-GB', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  const [whole = '0', fraction = ''] = price.split('.');
  const minor = Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, '0').slice(0, digits) || '0');
  return { minor, formatted: format.format(Number(price)) };
}

const cases = rates.items.flatMap((rate) =>
  Object.entries(rate.prices).map(([currency, price]) => ({ item: rate.name, currency, price })),
);

describe('every rate card price', () => {
  it('reads at least one price from the rate card', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)('invoices one unit of $item in $currency at $price', ({ item, currency, price }) => {
    const billing: BillingConfig = { ...loadBilling({}), currencies: [currency] };
    const booking: Booking = {
      id: 'B-TEST',
      customer: { id: 'C-TEST', name: 'Test customer', billingCurrency: currency },
      items: [{ item, quantity: 1 }],
    };
    const invoice = buildInvoice(booking, rates, billing);
    const expected = expectedAmount(price, currency);
    expect(invoice.currency).toBe(currency);
    expect(invoice.lines[0]?.unitPrice).toEqual(expected);
    expect(invoice.lines[0]?.total).toEqual(expected);
    expect(invoice.total).toEqual(expected);
  });
});
