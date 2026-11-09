import { describe, expect, it } from 'vitest';
import type { BillingConfig } from './config.ts';
import { loadBilling, loadRateCard } from './config.ts';
import type { Booking } from './data/bookings.ts';
import { buildInvoice } from './invoice.ts';

const rates = loadRateCard();

const cases = rates.items.flatMap((item) =>
  Object.entries(item.prices).map(([currency, price]) => ({ item: item.name, currency, price })),
);

// Expected values come from the platform's own currency rules, not from the service's currency table.
function expectedLine(price: string, currency: string) {
  const formatter = new Intl.NumberFormat('en-GB', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 0;
  return { minor: Math.round(Number(price) * 10 ** digits), formatted: formatter.format(Number(price)) };
}

describe('rate card prices', () => {
  it('covers every currency in the rate card', () => {
    const currencies = new Set(cases.map(({ currency }) => currency));
    expect([...currencies].sort()).toEqual(['EUR', 'GBP', 'JPY', 'USD']);
  });

  it.each(cases)('invoices one unit of $item in $currency at $price', ({ item, currency, price }) => {
    const billing: BillingConfig = { ...loadBilling({}), currencies: [currency] };
    const booking: Booking = {
      id: 'B-TEST',
      customer: { id: 'C-TEST', name: 'Test customer', billingCurrency: currency },
      items: [{ item, quantity: 1 }],
    };
    const invoice = buildInvoice(booking, rates, billing);
    const expected = expectedLine(price, currency);
    expect(invoice.currency).toBe(currency);
    expect(invoice.lines[0]?.unitPrice).toEqual(expected);
    expect(invoice.lines[0]?.total).toEqual(expected);
    expect(invoice.total).toEqual(expected);
  });
});
