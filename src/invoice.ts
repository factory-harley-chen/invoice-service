import type { BillingConfig, RateCard } from './config.ts';
import type { Booking } from './data/bookings.ts';
import { formatAmount } from './format.ts';
import { parseAmount } from './money.ts';

export type Amount = {
  minor: number;
  formatted: string;
};

export type InvoiceLine = {
  item: string;
  unit: string;
  quantity: number;
  unitPrice: Amount;
  total: Amount;
};

export type Invoice = {
  bookingId: string;
  customer: { id: string; name: string };
  currency: string;
  lines: InvoiceLine[];
  total: Amount;
  sendAt: string;
  timeZone: string;
};

function amount(minor: number, currency: string): Amount {
  return { minor, formatted: formatAmount(minor, currency) };
}

/** The customer's currency when billing is enabled for it, otherwise the fallback. */
export function invoiceCurrency(booking: Booking, billing: BillingConfig): string {
  const preferred = booking.customer.billingCurrency;
  return billing.currencies.includes(preferred) ? preferred : billing.fallbackCurrency;
}

export function buildInvoice(booking: Booking, rates: RateCard, billing: BillingConfig): Invoice {
  const currency = invoiceCurrency(booking, billing);

  const lines = booking.items.map(({ item, quantity }): InvoiceLine => {
    const rate = rates.items.find((entry) => entry.name === item);
    if (!rate) {
      throw new Error(`No rate for "${item}"`);
    }
    const price = rate.prices[currency];
    if (price === undefined) {
      throw new Error(`No ${currency} price for "${item}"`);
    }
    const unitPrice = parseAmount(price);
    return {
      item,
      unit: rate.unit,
      quantity,
      unitPrice: amount(unitPrice, currency),
      total: amount(unitPrice * quantity, currency),
    };
  });

  const total = lines.reduce((sum, line) => sum + line.total.minor, 0);

  return {
    bookingId: booking.id,
    customer: { id: booking.customer.id, name: booking.customer.name },
    currency,
    lines,
    total: amount(total, currency),
    sendAt: billing.sendAt,
    timeZone: billing.timeZone,
  };
}
