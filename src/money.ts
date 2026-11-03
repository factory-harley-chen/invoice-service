const amountPattern = /^(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parses a rate-card price such as "95.00" (or "12000" for a currency with
 * no minor unit) into an integer amount in the currency's smallest unit.
 * `exponent` is the currency's number of digits after the separator.
 */
export function parseAmount(value: string, exponent = 2): number {
  const match = amountPattern.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid amount: "${value}"`);
  }
  const [, whole = '0', fraction = ''] = match;
  if (fraction.length > exponent) {
    throw new Error(`Invalid amount: "${value}"`);
  }
  return Number(whole) * 10 ** exponent + Number(fraction.padEnd(exponent, '0'));
}
