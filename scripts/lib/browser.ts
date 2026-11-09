import { chromium, type Browser } from 'playwright-core';

/** Playwright's Chromium, or Google Chrome when that is missing, or the browser at CHROME_PATH. */
export async function launch(): Promise<Browser> {
  const executablePath = process.env.CHROME_PATH;
  if (executablePath) return chromium.launch({ executablePath });
  try {
    return await chromium.launch();
  } catch (bundled) {
    try {
      return await chromium.launch({ channel: 'chrome' });
    } catch {
      throw bundled;
    }
  }
}
