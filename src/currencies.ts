// ISO 4217 currency codes and the number of digits after the separator.
const exponents: Record<string, number> = {
  EUR: 2,
  GBP: 2,
  USD: 2,
  JPY: 0,
};

export function isKnownCurrency(code: string): boolean {
  return Object.hasOwn(exponents, code);
}

export function currencyExponent(code: string): number {
  const exponent = exponents[code];
  if (exponent === undefined) {
    throw new Error(`Unknown currency: ${code}`);
  }
  return exponent;
}
