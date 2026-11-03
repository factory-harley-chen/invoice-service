import { createServer } from 'node:http';
import { createApp } from './app.ts';
import { loadBilling, loadRateCard } from './config.ts';
import { bookings } from './data/bookings.ts';

const port = Number(process.env.PORT ?? 4100);
const billing = loadBilling();

const server = createServer(createApp({ bookings, rates: loadRateCard(), billing }));

server.listen(port, () => {
  console.log(`invoice-service listening on http://localhost:${port} (billing: ${billing.currencies.join(', ')})`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
