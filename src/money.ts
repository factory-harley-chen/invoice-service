const amountPattern = /^(\d+)(?:\.(\d+))?$/;

/**
 * Parses a rate-card price such as "95.00" into an integer amount
 * in the currency's smallest unit, given the currency's exponent.
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
