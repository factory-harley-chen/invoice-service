import { currencyExponent } from './currencies.ts';

const amountPattern = /^(\d+)(?:\.(\d+))?$/;

/**
 * Parses a rate-card price such as "95.00" into an integer amount
 * in the currency's smallest unit.
 */
export function parseAmount(value: string, currency: string): number {
  const exponent = currencyExponent(currency);
  const match = amountPattern.exec(value.trim());
  if (!match || (match[2] ?? '').length > exponent) {
    throw new Error(`Invalid amount: "${value}"`);
  }
  const [, whole = '0', fraction = ''] = match;
  return Number(whole) * 10 ** exponent + Number(fraction.padEnd(exponent, '0'));
}
