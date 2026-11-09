// Runs one test file and saves a picture of its output, as a terminal shows it:
//   node scripts/test-picture.ts <test file> <out.png>
// Prints the output too, and exits 0 once the picture is saved, whether the
// tests passed or failed; the last line says which.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { launch } from './lib/browser.ts';
import { terminalPage } from './lib/terminal.ts';

const [file, out] = process.argv.slice(2);
if (!file || !out) {
  console.error('usage: node scripts/test-picture.ts <test file> <out.png>');
  process.exit(2);
}

const command = `npx vitest run --reporter=verbose ${file}`;
// Through sh so the runner's stdout and stderr stay in the order a terminal shows them.
const run = spawnSync('sh', ['-c', 'npx vitest run --reporter=verbose "$1" 2>&1', 'sh', file], {
  encoding: 'utf8',
  env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
});
const output = run.stdout ?? '';
process.stdout.write(output);

mkdirSync(dirname(out), { recursive: true });
const browser = await launch();
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 }, deviceScaleFactor: 2 });
  await page.setContent(terminalPage(command, output), { waitUntil: 'load' });
  await page.locator('main').screenshot({ path: out });
} finally {
  await browser.close();
}
console.log(`${run.status === 0 ? 'Tests passed' : `Tests failed (exit ${run.status})`}; picture saved to ${out}`);
