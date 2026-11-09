import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BillingConfig, RateCard } from './config.ts';
import type { Booking } from './data/bookings.ts';
import { buildInvoice } from './invoice.ts';
import { renderInvoicePage } from './page.ts';

export type AppOptions = {
  bookings: Booking[];
  rates: RateCard;
  billing: BillingConfig;
  log?: (line: string) => void;
};

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

export function createApp(options: AppOptions): Handler {
  const { bookings, rates, billing, log = console.log } = options;

  const routes: Array<{ pattern: RegExp; handle: (res: ServerResponse, params: string[]) => void }> = [
    {
      pattern: /^\/health$/,
      handle: (res) => sendJson(res, 200, { status: 'ok' }),
    },
    {
      pattern: /^\/invoices$/,
      handle: (res) => {
        const invoices = bookings.map((booking) => {
          const invoice = buildInvoice(booking, rates, billing);
          return {
            bookingId: invoice.bookingId,
            customer: invoice.customer,
            currency: invoice.currency,
            total: invoice.total,
          };
        });
        sendJson(res, 200, { invoices });
      },
    },
    {
      pattern: /^\/invoices\/([^/]+)$/,
      handle: (res, [bookingId = '']) => {
        const booking = bookings.find((entry) => entry.id === bookingId);
        if (!booking) {
          sendJson(res, 404, { error: 'not_found', message: `No booking ${bookingId}` });
          return;
        }
        sendJson(res, 200, buildInvoice(booking, rates, billing));
      },
    },
    {
      pattern: /^\/invoices\/([^/]+)\/page$/,
      handle: (res, [bookingId = '']) => {
        const booking = bookings.find((entry) => entry.id === bookingId);
        if (!booking) {
          sendJson(res, 404, { error: 'not_found', message: `No booking ${bookingId}` });
          return;
        }
        sendHtml(res, renderInvoicePage(buildInvoice(booking, rates, billing)));
      },
    },
  ];

  return (req, res) => {
    const started = performance.now();
    const method = req.method ?? 'GET';
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;

    res.on('finish', () => {
      const ms = (performance.now() - started).toFixed(1);
      log(`${method} ${path} ${res.statusCode} ${ms}ms`);
    });

    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }

    for (const route of routes) {
      const match = route.pattern.exec(path);
      if (match) {
        try {
          route.handle(res, match.slice(1).map(decodeURIComponent));
        } catch (error) {
          log(`error ${method} ${path}: ${(error as Error).message}`);
          sendJson(res, 500, { error: 'internal_error' });
        }
        return;
      }
    }

    sendJson(res, 404, { error: 'not_found', message: `No route for ${path}` });
  };
}
