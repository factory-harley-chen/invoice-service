import { readFileSync } from 'node:fs';

export type RateItem = {
  name: string;
  unit: 'night' | 'trip';
  prices: Record<string, string>;
};

export type RateCard = {
  items: RateItem[];
};

export type BillingConfig = {
  currencies: string[];
  fallbackCurrency: string;
  sendAt: string;
  timeZone: string;
};

function readJson<T>(relativePath: string): T {
  const url = new URL(relativePath, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

export function loadRateCard(): RateCard {
  return readJson<RateCard>('../config/rates.json');
}

/**
 * Loads config/billing.json. BILLING_CURRENCIES (a comma-separated list)
 * overrides the enabled currencies without a code change.
 */
export function loadBilling(env: NodeJS.ProcessEnv = process.env): BillingConfig {
  const billing = readJson<BillingConfig>('../config/billing.json');
  const override = env.BILLING_CURRENCIES?.trim();
  if (override) {
    billing.currencies = override
      .split(',')
      .map((code) => code.trim().toUpperCase())
      .filter((code) => code.length > 0);
  }
  return billing;
}
