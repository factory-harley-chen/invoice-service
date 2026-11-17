const amountPattern = /^(\d+)(?:\.(\d+))?$/;

/**
 * Parses a rate-card price such as "95.00" into an integer amount
 * in the currency's smallest unit. `exponent` is the currency's number
 * of digits after the separator (2 for EUR, 0 for JPY).
 */
export function parseAmount(value: string, exponent = 2): number {
  const match = amountPattern.exec(value.trim());
  const fraction = match?.[2] ?? '';
  if (!match || fraction.length > exponent) {
    throw new Error(`Invalid amount: "${value}"`);
  }
  const whole = match[1] ?? '0';
  return Number(whole) * 10 ** exponent + Number(fraction.padEnd(exponent, '0'));
}
