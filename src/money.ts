import { currencyExponent } from './currencies.ts';

const amountPattern = /^(\d+)(?:\.(\d+))?$/;

/**
 * Parses a rate-card price such as "95.00" into an integer amount
 * in the currency's smallest unit (cents for EUR, yen for JPY).
 */
export function parseAmount(value: string, currency: string): number {
  const digits = currencyExponent(currency);
  const match = amountPattern.exec(value.trim());
  const [, whole = '0', fraction = ''] = match ?? [];
  if (!match || fraction.length > digits) {
    throw new Error(`Invalid amount: "${value}"`);
  }
  return Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, '0') || '0');
}
