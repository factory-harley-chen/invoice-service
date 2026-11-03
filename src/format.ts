import { currencyExponent } from './currencies.ts';

const formatters = new Map<string, Intl.NumberFormat>();

function formatterFor(currency: string): Intl.NumberFormat {
  let formatter = formatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-GB', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' });
    formatters.set(currency, formatter);
  }
  return formatter;
}

/** Formats an amount held in the currency's smallest unit for display. */
export function formatAmount(minor: number, currency: string): string {
  return formatterFor(currency).format(minor / 10 ** currencyExponent(currency));
}
