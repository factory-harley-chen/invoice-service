import { describe, expect, it } from 'vitest';
import {
  berlinTime,
  checkAll,
  checkInvoice,
  firingText,
  formatMinor,
  priceToMinor,
  quantityLabel,
  ratioLabel,
  resolvedText,
  type RateCard,
  type ServedInvoice,
} from './check.ts';

const rates: RateCard = {
  items: [
    { name: 'Kyoto hotel', unit: 'night', prices: { EUR: '74.00', JPY: '12000' } },
    { name: 'Lisbon hotel', unit: 'night', prices: { EUR: '95.00' } },
    { name: 'Lisbon airport transfer', unit: 'trip', prices: { EUR: '18.50' } },
  ],
};

function invoice(currency: string, lines: Array<[string, string, number, number]>, total?: number): ServedInvoice {
  const served = lines.map(([item, unit, quantity, unitMinor]) => ({
    item,
    unit,
    quantity,
    unitPrice: { minor: unitMinor, formatted: formatMinor(unitMinor, currency) },
    total: { minor: unitMinor * quantity, formatted: formatMinor(unitMinor * quantity, currency) },
  }));
  const sum = total ?? served.reduce((acc, line) => acc + line.total.minor, 0);
  return {
    bookingId: 'B-1042',
    customer: { id: 'C-204', name: 'Sakura Lane Design' },
    currency,
    lines: served,
    total: { minor: sum, formatted: formatMinor(sum, currency) },
  };
}

describe('priceToMinor', () => {
  it('uses the number of decimals of each currency', () => {
    expect(priceToMinor('74.00', 'EUR')).toBe(7400);
    expect(priceToMinor('18.5', 'EUR')).toBe(1850);
    expect(priceToMinor('12000', 'JPY')).toBe(12000);
    expect(priceToMinor('95', 'GBP')).toBe(9500);
  });

  it('rejects prices the currency cannot have, and unknown currencies', () => {
    expect(() => priceToMinor('12000.5', 'JPY')).toThrow('more decimals');
    expect(() => priceToMinor('1.234', 'EUR')).toThrow('more decimals');
    expect(() => priceToMinor('abc', 'EUR')).toThrow('not a number');
    expect(() => priceToMinor('1.00', 'XTS')).toThrow('does not know');
  });
});

describe('formatMinor', () => {
  it('shows narrow symbols', () => {
    expect(formatMinor(12000, 'JPY')).toBe('¥12,000');
    expect(formatMinor(1200000, 'JPY')).toBe('¥1,200,000');
    expect(formatMinor(84000, 'USD')).toBe('$840.00');
    expect(formatMinor(32200, 'EUR')).toBe('€322.00');
  });
});

describe('checkInvoice', () => {
  it('passes an invoice that matches the rate card', () => {
    const ok = invoice('EUR', [
      ['Lisbon hotel', 'night', 3, 9500],
      ['Lisbon airport transfer', 'trip', 2, 1850],
    ]);
    expect(checkInvoice(ok, rates)).toBeUndefined();
  });

  it('reports a line priced 100 times too high', () => {
    const wrong = invoice('JPY', [['Kyoto hotel', 'night', 1, 1200000]]);
    expect(checkInvoice(wrong, rates)).toEqual({
      bookingId: 'B-1042',
      customer: 'Sakura Lane Design',
      item: 'Kyoto hotel',
      unit: 'night',
      quantity: 1,
      currency: 'JPY',
      expected: { minor: 12000, formatted: '¥12,000' },
      actual: { minor: 1200000, formatted: '¥1,200,000' },
    });
  });

  it('passes the same booking once it is invoiced correctly', () => {
    expect(checkInvoice(invoice('JPY', [['Kyoto hotel', 'night', 1, 12000]]), rates)).toBeUndefined();
  });

  it('reports a total that does not add up even when every line is right', () => {
    const wrongTotal = invoice('EUR', [['Kyoto hotel', 'night', 2, 7400]], 99);
    expect(checkInvoice(wrongTotal, rates)).toMatchObject({ item: 'invoice total', expected: { minor: 14800 }, actual: { minor: 99 } });
  });

  it('skips an invoice it cannot judge (item or currency not on the rate card)', () => {
    expect(checkInvoice(invoice('EUR', [['Paris hotel', 'night', 1, 1]]), rates)).toBeUndefined();
    expect(checkInvoice(invoice('XTS', [['Kyoto hotel', 'night', 1, 1]]), rates)).toBeUndefined();
  });

  it('checkAll keeps the order of the invoices it was given', () => {
    const first = { ...invoice('JPY', [['Kyoto hotel', 'night', 1, 1200000]]), bookingId: 'B-2' };
    const second = { ...invoice('JPY', [['Kyoto hotel', 'night', 2, 1200000]]), bookingId: 'B-1' };
    expect(checkAll([first, second], rates).map((m) => m.bookingId)).toEqual(['B-2', 'B-1']);
  });
});

describe('alert text', () => {
  const firstSeen = new Date('2026-11-11T13:02:31Z');

  it('labels quantities and ratios in plain words', () => {
    expect(quantityLabel(1, 'night')).toBe('1 night');
    expect(quantityLabel(2, 'trip')).toBe('2 trips');
    expect(ratioLabel(12000, 1200000)).toBe('100x');
    expect(ratioLabel(1200000, 12000)).toBe('0.01x');
  });

  it('shows Berlin time', () => {
    expect(berlinTime(firstSeen)).toBe('14:02:31');
  });

  it('writes the FIRING message, one fact per line', () => {
    const mismatch = checkInvoice(invoice('JPY', [['Kyoto hotel', 'night', 1, 1200000]]), rates);
    if (!mismatch) throw new Error('expected a mismatch');
    const text = firingText(mismatch, {
      firstSeen,
      currencies: ['EUR', 'GBP', 'USD', 'JPY'],
      repo: 'factory-harley-chen/invoice-service',
      sendAt: '15:00',
    });
    expect(text.split('\n')).toEqual([
      'FIRING invoice-total-mismatch (staging)',
      'Booking B-1042, Sakura Lane Design: Kyoto hotel, 1 night. Expected ¥12,000, invoiced ¥1,200,000 (100x).',
      'First seen 14:02:31 Europe/Berlin. Invoices go out at 15:00 Europe/Berlin.',
      'Staging: BILLING_CURRENCIES=EUR,GBP,USD,JPY',
      'Repo: github.com/factory-harley-chen/invoice-service',
    ]);
  });

  it('writes RESOLVED without the word that starts runs', () => {
    const text = resolvedText(firstSeen, new Date('2026-11-11T13:19:02Z'), 2);
    expect(text.split('\n')[0]).toBe('RESOLVED invoice-total-mismatch (staging)');
    expect(text).toContain('16 min 31 s after it was first seen');
    expect(text).not.toContain('FIRING');
  });
});
