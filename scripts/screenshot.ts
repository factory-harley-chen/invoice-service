// Saves a picture of an invoice page as this checkout serves it:
//   BILLING_CURRENCIES=<list> node scripts/screenshot.ts <booking id> <out.png>
// Serves the app on a free port while the picture is taken, prints the
// invoice's currency and total, then saves the page.
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import type { Browser } from 'playwright-core';
import { createApp } from '../src/app.ts';
import { loadBilling, loadRateCard } from '../src/config.ts';
import { bookings } from '../src/data/bookings.ts';
import { launch } from './lib/browser.ts';

const [bookingId, out] = process.argv.slice(2);
if (!bookingId || !out) {
  console.error('usage: BILLING_CURRENCIES=<list> node scripts/screenshot.ts <booking id> <out.png>');
  process.exit(2);
}

const billing = loadBilling();
const server = createServer(createApp({ bookings, rates: loadRateCard(), billing, log: () => {} }));
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
let browser: Browser | undefined;
try {
  const invoice = await fetch(`${base}/invoices/${encodeURIComponent(bookingId)}`);
  const body = (await invoice.json()) as { currency?: string; total?: { formatted?: string }; message?: string };
  if (!invoice.ok) throw new Error(body.message ?? `invoice answered ${invoice.status}`);
  console.log(`${bookingId}: ${body.currency} ${body.total?.formatted} (billing: ${billing.currencies.join(', ')})`);

  mkdirSync(dirname(out), { recursive: true });
  browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 }, deviceScaleFactor: 2 });
  await page.goto(`${base}/invoices/${encodeURIComponent(bookingId)}/page`, { waitUntil: 'load', timeout: 15_000 });
  await page.locator('main').screenshot({ path: out });
  console.log(out);
} finally {
  await browser?.close();
  server.close();
}
