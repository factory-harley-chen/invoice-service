import { describe, expect, it } from 'vitest';
import { colourLine, maxLines, terminalPage } from './terminal.ts';

describe('colourLine', () => {
  it('colours passes, failures and the summary counts', () => {
    expect(colourLine('  ✓ totals a GBP booking')).toBe('  <span class="ok">✓</span> totals a GBP booking');
    expect(colourLine('  × bills a JPY booking')).toBe('  <span class="bad">×</span> bills a JPY booking');
    expect(colourLine(' FAIL  src/invoice.test.ts')).toBe(' <span class="fail-badge">FAIL</span>  src/invoice.test.ts');
    expect(colourLine('      Tests  1 failed | 7 passed (8)')).toBe(
      '      Tests  <span class="bad">1 failed</span> | <span class="ok">7 passed</span> (8)',
    );
  });

  it('escapes HTML and drops terminal colour codes', () => {
    expect(colourLine('\x1b[31mexpected <b> & "c"\x1b[39m')).toBe('expected &lt;b&gt; &amp; &quot;c&quot;');
  });
});

describe('terminalPage', () => {
  it('shows the command, then the output', () => {
    const html = terminalPage('npx vitest run src/a.test.ts', 'line one\nline two\n\n');
    expect(html).toContain('<span class="prompt">$</span> npx vitest run src/a.test.ts\nline one\nline two</pre>');
  });

  it('draws the separator lines with a character every monospace font has', () => {
    const html = terminalPage('cmd', '⎯⎯⎯ Failed Tests 1 ⎯⎯⎯');
    expect(html).toContain('─── Failed Tests 1 ───');
    expect(html).not.toContain('⎯');
  });

  it('says how many lines it left out', () => {
    const output = Array.from({ length: maxLines + 5 }, (_, i) => `line ${i}`).join('\n');
    const html = terminalPage('cmd', output);
    expect(html).toContain(`line ${maxLines - 1}\n`);
    expect(html).not.toContain(`line ${maxLines}\n`);
    expect(html).toContain('… 5 more lines');
  });
});
