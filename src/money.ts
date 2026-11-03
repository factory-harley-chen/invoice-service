const amountPattern = /^(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parses a rate-card price such as "95.00" into an integer amount
 * in the currency's smallest unit.
 */
export function parseAmount(value: string): number {
  const match = amountPattern.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid amount: "${value}"`);
  }
  const [, whole = '0', fraction = ''] = match;
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
