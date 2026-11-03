import { describe, expect, it } from 'vitest';
import type { BillingConfig } from './config.ts';
import { loadBilling, loadRateCard } from './config.ts';
import { currencyExponent } from './currencies.ts';
import { buildInvoice } from './invoice.ts';

const rates = loadRateCard();
const billing: BillingConfig = loadBilling({});

const cases = rates.items.flatMap((rate) =>
  Object.entries(rate.prices).map(([currency, price]) => ({ item: rate.name, currency, price })),
);

describe('rate card prices', () => {
  it.each(cases)('invoices one $item in $currency at exactly $price', ({ item, currency, price }) => {
    const booking = {
      id: 'B-CHECK',
      customer: { id: 'C-CHECK', name: 'Rate card check', billingCurrency: currency },
      items: [{ item, quantity: 1 }],
    };
    const invoice = buildInvoice(booking, rates, { ...billing, currencies: [currency] });

    const expectedMinor = Math.round(Number(price) * 10 ** currencyExponent(currency));
    const expectedDisplay = new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
    }).format(Number(price));

    expect(invoice.currency).toBe(currency);
    expect(invoice.lines[0]?.total).toEqual({ minor: expectedMinor, formatted: expectedDisplay });
    expect(invoice.total).toEqual({ minor: expectedMinor, formatted: expectedDisplay });
  });
});
