import { describe, expect, it } from 'vitest';
import { loadBilling, loadRateCard } from './config.ts';
import { findBooking } from './data/bookings.ts';
import { buildInvoice, type Invoice } from './invoice.ts';
import { renderInvoicePage } from './page.ts';

function invoiceFor(id: string): Invoice {
  const booking = findBooking(id);
  if (!booking) throw new Error(`missing seed booking ${id}`);
  return buildInvoice(booking, loadRateCard(), loadBilling({}));
}

describe('renderInvoicePage', () => {
  it('shows the customer, every line and the total', () => {
    const html = renderInvoicePage(invoiceFor('B-1041'));
    expect(html).toContain('<h1>Invoice B-1041</h1>');
    expect(html).toContain('Harbourline Studios (C-201)');
    expect(html).toContain('<td>Lisbon hotel</td><td class="num">3 nights</td>');
    expect(html).toContain('<td>Lisbon airport transfer</td><td class="num">2 trips</td>');
    expect(html).toContain('<strong>€322.00</strong>');
    expect(html).toContain('Sent at 15:00 Europe/Berlin');
  });

  it('uses the singular for one unit', () => {
    expect(renderInvoicePage(invoiceFor('B-1046'))).toContain('<td class="num">1 night</td>');
  });

  it('escapes text from the data', () => {
    const invoice = invoiceFor('B-1043');
    const html = renderInvoicePage({ ...invoice, customer: { id: 'C-1', name: 'A & B <Ltd>' } });
    expect(html).toContain('A &amp; B &lt;Ltd&gt; (C-1)');
    expect(html).not.toContain('<Ltd>');
  });
});
