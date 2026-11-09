import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { loadBilling, loadRateCard } from './config.ts';
import { bookings } from './data/bookings.ts';

let server: Server;
let baseUrl: string;
const logLines: string[] = [];

beforeAll(async () => {
  const app = createApp({
    bookings,
    rates: loadRateCard(),
    billing: loadBilling({}),
    log: (line) => logLines.push(line),
  });
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('server', () => {
  it('GET /health', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('GET /invoices lists every booking', async () => {
    const res = await fetch(`${baseUrl}/invoices`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { invoices: Array<{ bookingId: string }> };
    expect(body.invoices.map((invoice) => invoice.bookingId)).toEqual(bookings.map((booking) => booking.id));
  });

  it('GET /invoices/:bookingId returns the invoice', async () => {
    const res = await fetch(`${baseUrl}/invoices/B-1043`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      bookingId: 'B-1043',
      customer: { name: 'Northgate Analytics' },
      currency: 'GBP',
      total: { minor: 28000, formatted: '£280.00' },
      sendAt: '15:00',
    });
  });

  it('GET /invoices/:bookingId/page returns the invoice page', async () => {
    const res = await fetch(`${baseUrl}/invoices/B-1043/page`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<h1>Invoice B-1043</h1>');
    expect(html).toContain('<strong>£280.00</strong>');
  });

  it('returns 404 JSON for the page of an unknown booking', async () => {
    const res = await fetch(`${baseUrl}/invoices/B-9999/page`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_found' });
  });

  it('returns 404 JSON for an unknown booking', async () => {
    const res = await fetch(`${baseUrl}/invoices/B-9999`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toMatchObject({ error: 'not_found' });
  });

  it('returns 404 JSON for an unknown route', async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_found' });
  });

  it('logs one line per request', () => {
    expect(logLines.some((line) => line.startsWith('GET /health 200'))).toBe(true);
  });
});
