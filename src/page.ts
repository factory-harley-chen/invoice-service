import type { Invoice } from './invoice.ts';

const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => entities[char] ?? char);
}

function quantityLabel(quantity: number, unit: string): string {
  return `${quantity} ${unit}${quantity === 1 ? '' : 's'}`;
}

const styles = `
  * { box-sizing: border-box; }
  body { margin: 0; background: #f3f4f6; color: #111827; font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Liberation Sans", sans-serif; }
  main { width: 920px; margin: 32px auto; padding: 40px 48px; background: #ffffff; border: 1px solid #d1d5db; border-radius: 12px; }
  header { display: flex; justify-content: space-between; align-items: baseline; }
  h1 { margin: 0; font-size: 34px; }
  .muted { margin: 8px 0 0; color: #4b5563; font-size: 20px; }
  table { width: 100%; margin-top: 28px; border-collapse: collapse; font-size: 22px; }
  th { padding: 10px 0; border-bottom: 2px solid #d1d5db; color: #4b5563; font-weight: 600; text-align: left; }
  td { padding: 14px 0; border-bottom: 1px solid #e5e7eb; }
  .num { text-align: right; }
  .total { display: flex; justify-content: space-between; align-items: baseline; margin-top: 28px; }
  .total span { color: #4b5563; font-size: 22px; }
  .total strong { font-size: 52px; }
  footer { margin-top: 20px; color: #4b5563; font-size: 18px; }
`;

/** The invoice as the customer sees it: one self-contained HTML page. */
export function renderInvoicePage(invoice: Invoice): string {
  const rows = invoice.lines
    .map(
      (line) =>
        `<tr><td>${escapeHtml(line.item)}</td><td class="num">${escapeHtml(quantityLabel(line.quantity, line.unit))}</td>` +
        `<td class="num">${escapeHtml(line.unitPrice.formatted)}</td><td class="num">${escapeHtml(line.total.formatted)}</td></tr>`,
    )
    .join('\n');
  const id = escapeHtml(invoice.bookingId);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Invoice ${id}</title>
<style>${styles}</style>
</head>
<body>
<main>
<header><h1>Invoice ${id}</h1><p class="muted">${escapeHtml(invoice.currency)}</p></header>
<p class="muted">${escapeHtml(invoice.customer.name)} (${escapeHtml(invoice.customer.id)})</p>
<table>
<thead><tr><th>Item</th><th class="num">Quantity</th><th class="num">Unit price</th><th class="num">Amount</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<div class="total"><span>Total</span><strong>${escapeHtml(invoice.total.formatted)}</strong></div>
<footer>Sent at ${escapeHtml(invoice.sendAt)} ${escapeHtml(invoice.timeZone)}</footer>
</main>
</body>
</html>
`;
}
