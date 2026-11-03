// The monitor's own view of what an invoice should say. It deliberately shares
// no code with src/, so a fault in the service cannot hide itself here.

export type Amount = { minor: number; formatted: string };

export type ServedLine = {
  item: string;
  unit: string;
  quantity: number;
  unitPrice: Amount;
  total: Amount;
};

export type ServedInvoice = {
  bookingId: string;
  customer: { id: string; name: string };
  currency: string;
  lines: ServedLine[];
  total: Amount;
};

export type RateCard = {
  items: Array<{ name: string; unit: string; prices: Record<string, string> }>;
};

export type Mismatch = {
  bookingId: string;
  customer: string;
  item: string;
  unit: string;
  quantity: number;
  currency: string;
  expected: Amount;
  actual: Amount;
};

// ISO 4217 minor-unit digits for the currencies the business prices in or may soon.
const minorDigits: Record<string, number> = {
  AUD: 2,
  CAD: 2,
  CHF: 2,
  CNY: 2,
  DKK: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  KRW: 0,
  NOK: 2,
  SEK: 2,
  USD: 2,
};

export function minorDigitsOf(currency: string): number | undefined {
  return Object.hasOwn(minorDigits, currency) ? minorDigits[currency] : undefined;
}

/** "12000" JPY is 12000; "74.00" EUR is 7400. Throws on a price the currency cannot have. */
export function priceToMinor(price: string, currency: string): number {
  const digits = minorDigitsOf(currency);
  if (digits === undefined) throw new Error(`monitor does not know currency ${currency}`);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(price.trim());
  if (!match) throw new Error(`price "${price}" is not a number`);
  const [, whole = '0', fraction = ''] = match;
  if (fraction.length > digits) throw new Error(`price "${price}" has more decimals than ${currency} allows`);
  return Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, '0') || '0');
}

const formatters = new Map<string, Intl.NumberFormat>();

export function formatMinor(minor: number, currency: string): string {
  const digits = minorDigitsOf(currency);
  if (digits === undefined) return `${minor} ${currency} (minor units)`;
  let formatter = formatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-GB', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' });
    formatters.set(currency, formatter);
  }
  return formatter.format(minor / 10 ** digits);
}

function amount(minor: number, currency: string): Amount {
  return { minor, formatted: formatMinor(minor, currency) };
}

/** The first line (or the total) on an invoice that differs from the rate card, if any. */
export function checkInvoice(invoice: ServedInvoice, rates: RateCard): Mismatch | undefined {
  const { currency } = invoice;
  if (minorDigitsOf(currency) === undefined) return undefined;
  let expectedTotal = 0;
  for (const line of invoice.lines) {
    const rate = rates.items.find((entry) => entry.name === line.item);
    const price = rate?.prices[currency];
    if (price === undefined) return undefined;
    const unitMinor = priceToMinor(price, currency);
    const lineMinor = unitMinor * line.quantity;
    expectedTotal += lineMinor;
    if (line.unitPrice.minor !== unitMinor || line.total.minor !== lineMinor) {
      return {
        bookingId: invoice.bookingId,
        customer: invoice.customer.name,
        item: line.item,
        unit: line.unit,
        quantity: line.quantity,
        currency,
        expected: amount(lineMinor, currency),
        actual: { minor: line.total.minor, formatted: line.total.formatted },
      };
    }
  }
  if (invoice.total.minor !== expectedTotal) {
    return {
      bookingId: invoice.bookingId,
      customer: invoice.customer.name,
      item: 'invoice total',
      unit: '',
      quantity: invoice.lines.length,
      currency,
      expected: amount(expectedTotal, currency),
      actual: { minor: invoice.total.minor, formatted: invoice.total.formatted },
    };
  }
  return undefined;
}

export function checkAll(invoices: ServedInvoice[], rates: RateCard): Mismatch[] {
  return invoices.map((invoice) => checkInvoice(invoice, rates)).filter((m): m is Mismatch => m !== undefined);
}

export function quantityLabel(quantity: number, unit: string): string {
  if (!unit) return `${quantity} lines`;
  return `${quantity} ${unit}${quantity === 1 ? '' : 's'}`;
}

/** "100x" when invoiced 100 times the expected amount; "0.01x" when 100 times too low. */
export function ratioLabel(expected: number, actual: number): string {
  if (expected === 0) return 'expected zero';
  const ratio = actual / expected;
  const rounded = ratio >= 1 ? Math.round(ratio * 100) / 100 : Number(ratio.toPrecision(2));
  return `${rounded}x`;
}

export const berlin = 'Europe/Berlin';

export function berlinTime(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: berlin,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

export const alertName = 'invoice-total-mismatch';

export type FiringContext = {
  firstSeen: Date;
  currencies: string[] | undefined;
  repo: string;
  sendAt: string;
};

export function firingText(m: Mismatch, ctx: FiringContext): string {
  const what = m.unit ? `${m.item}, ${quantityLabel(m.quantity, m.unit)}` : m.item;
  return [
    `FIRING ${alertName} (staging)`,
    `Booking ${m.bookingId}, ${m.customer}: ${what}. Expected ${m.expected.formatted}, invoiced ${m.actual.formatted} (${ratioLabel(m.expected.minor, m.actual.minor)}).`,
    `First seen ${berlinTime(ctx.firstSeen)} ${berlin}. Invoices go out at ${ctx.sendAt} ${berlin}.`,
    `Staging: BILLING_CURRENCIES=${ctx.currencies?.join(',') ?? 'unknown'}`,
    `Repo: github.com/${ctx.repo}`,
  ].join('\n');
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} min ${seconds % 60} s` : `${seconds} s`;
}

export function resolvedText(firstSeen: Date, resolvedAt: Date, pollSeconds: number): string {
  return [
    `RESOLVED ${alertName} (staging)`,
    `All invoices match the rate card again, on two checks ${pollSeconds} s apart.`,
    `Resolved ${berlinTime(resolvedAt)} ${berlin}, ${duration(resolvedAt.getTime() - firstSeen.getTime())} after it was first seen.`,
  ].join('\n');
}
