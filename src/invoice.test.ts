import { describe, expect, it } from 'vitest';
import type { BillingConfig } from './config.ts';
import { loadBilling, loadRateCard } from './config.ts';
import { findBooking } from './data/bookings.ts';
import { buildInvoice } from './invoice.ts';

const rates = loadRateCard();
const billing: BillingConfig = loadBilling({});

function invoiceFor(id: string) {
  const booking = findBooking(id);
  if (!booking) throw new Error(`missing seed booking ${id}`);
  return buildInvoice(booking, rates, billing);
}

describe('buildInvoice', () => {
  it('totals a EUR booking with several lines', () => {
    const invoice = invoiceFor('B-1041');
    expect(invoice.currency).toBe('EUR');
    expect(invoice.lines.map((line) => line.total.minor)).toEqual([28500, 3700]);
    expect(invoice.total).toEqual({ minor: 32200, formatted: '€322.00' });
  });

  it('totals a GBP booking', () => {
    const invoice = invoiceFor('B-1043');
    expect(invoice.currency).toBe('GBP');
    expect(invoice.lines[0]?.unitPrice).toEqual({ minor: 14000, formatted: '£140.00' });
    expect(invoice.total).toEqual({ minor: 28000, formatted: '£280.00' });
  });

  it('totals a USD booking', () => {
    const invoice = invoiceFor('B-1044');
    expect(invoice.currency).toBe('USD');
    expect(invoice.total).toEqual({ minor: 84000, formatted: '$840.00' });
  });

  it("bills in the fallback currency when the customer's currency is not enabled", () => {
    const invoice = invoiceFor('B-1042');
    expect(invoice.currency).toBe('EUR');
    expect(invoice.lines).toEqual([
      {
        item: 'Kyoto hotel',
        unit: 'night',
        quantity: 1,
        unitPrice: { minor: 7400, formatted: '€74.00' },
        total: { minor: 7400, formatted: '€74.00' },
      },
    ]);
    expect(invoice.total).toEqual({ minor: 7400, formatted: '€74.00' });
  });

  it('bills a JPY booking at the rate card price when JPY is enabled', () => {
    const booking = findBooking('B-1042');
    if (!booking) throw new Error('missing seed booking B-1042');
    const invoice = buildInvoice(booking, rates, { ...billing, currencies: ['EUR', 'GBP', 'USD', 'JPY'] });
    expect(invoice.currency).toBe('JPY');
    expect(invoice.lines[0]?.unitPrice).toEqual({ minor: 12000, formatted: '¥12,000' });
    expect(invoice.total).toEqual({ minor: 12000, formatted: '¥12,000' });
  });

  it('carries the send time from billing config', () => {
    const invoice = invoiceFor('B-1046');
    expect(invoice.sendAt).toBe('15:00');
    expect(invoice.timeZone).toBe('Europe/Berlin');
  });
});

describe('loadBilling', () => {
  it('reads the enabled currencies from config', () => {
    expect(loadBilling({}).currencies).toEqual(['EUR', 'GBP', 'USD']);
  });

  it('lets BILLING_CURRENCIES override the enabled currencies', () => {
    expect(loadBilling({ BILLING_CURRENCIES: 'eur, gbp' }).currencies).toEqual(['EUR', 'GBP']);
  });
});
