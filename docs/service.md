# invoice-service

invoice-service produces invoices for the bookings team. Each booking belongs to
a customer and lists the items booked (hotel nights, transfers) with a
quantity. The service prices every line from the rate card, totals the invoice
and returns it as JSON, with each amount as an integer and as a display string.

## Endpoints

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/health` | `{"status": "ok"}` |
| GET | `/invoices` | One summary per booking: booking id, customer, currency and total. |
| GET | `/invoices/:bookingId` | The full invoice: booking id, customer, currency, lines (item, unit, quantity, unit price and line total), the total, `sendAt` and `timeZone`. |

An unknown booking id or path returns `404` with a JSON body such as
`{"error": "not_found", "message": "No booking B-9999"}`. Each request writes
one log line: method, path, status and duration.

## Config

- `config/rates.json`: the rate card. Each item has a name, a unit (`night` or
  `trip`) and a price per currency, written as a string in the currency's usual
  notation (for example `"95.00"`).
- `config/billing.json`: the currencies enabled for billing, the fallback
  currency, and when invoices are sent.

```json
{
  "currencies": ["EUR", "GBP", "USD"],
  "fallbackCurrency": "EUR",
  "sendAt": "15:00",
  "timeZone": "Europe/Berlin"
}
```

The `BILLING_CURRENCIES` environment variable, a comma-separated list, overrides
`currencies` at runtime, for example `BILLING_CURRENCIES=EUR,GBP,USD npm start`.

## Billing currencies

EUR, GBP and USD are enabled. JPY is rolling out: it is enabled per environment
by adding it to `BILLING_CURRENCIES`, with no code change.

## Fallback rule

An invoice is issued in the customer's billing currency when that currency is
enabled. Otherwise it is issued in the fallback currency (EUR), at the rate
card's price for that currency. For example, a customer billed in a currency
that is not yet enabled, booking one night at the Kyoto hotel, is invoiced
€74.00.

## Schedule

Invoices go out daily at 15:00 Europe/Berlin.
