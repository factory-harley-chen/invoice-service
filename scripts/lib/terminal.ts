const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => entities[char] ?? char);
}

// eslint-disable-next-line no-control-regex
const ansi = /\x1b\[[0-9;]*m/g;

/** Colours one line of the test runner's plain output the way a terminal does. */
export function colourLine(line: string): string {
  return escapeHtml(line.replace(ansi, ''))
    .replace(/\bFAIL\b/g, '<span class="fail-badge">FAIL</span>')
    .replace(/✓/g, '<span class="ok">✓</span>')
    .replace(/×/g, '<span class="bad">×</span>')
    .replace(/\b(\d+ failed)/g, '<span class="bad">$1</span>')
    .replace(/\b(\d+ passed)/g, '<span class="ok">$1</span>');
}

export const maxLines = 60;

/** A terminal window showing a command and its output, as one HTML page. */
export function terminalPage(command: string, output: string, title = 'invoice-service'): string {
  // Vitest draws its separator lines with U+23AF, which the fonts on GitHub's
  // Ubuntu runners lack; U+2500 looks the same and every monospace font has it.
  const lines = output.replace(ansi, '').replace(/⎯/g, '─').replace(/\s+$/, '').split('\n');
  const shown = lines.slice(0, maxLines).map(colourLine).join('\n');
  const more = lines.length > maxLines ? `\n<span class="dim">… ${lines.length - maxLines} more lines</span>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(command)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; background: #ffffff; }
  main { width: 960px; border-radius: 10px; overflow: hidden; background: #0d1117; border: 1px solid #30363d; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: #161b22; border-bottom: 1px solid #30363d; }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .title { margin-left: auto; margin-right: auto; color: #8b949e; font: 14px -apple-system, "Segoe UI", Roboto, "Liberation Sans", sans-serif; }
  pre { margin: 0; padding: 16px 18px 18px; color: #e6edf3; font: 15px/1.45 ui-monospace, "SF Mono", Menlo, "DejaVu Sans Mono", "Liberation Mono", monospace; white-space: pre-wrap; word-break: break-word; }
  .prompt { color: #7ee787; }
  .ok { color: #3fb950; }
  .bad { color: #f85149; }
  .dim { color: #8b949e; }
  .fail-badge { background: #f85149; color: #0d1117; padding: 0 4px; font-weight: 700; }
</style>
</head>
<body>
<main>
<div class="bar"><span class="dot" style="background:#ff5f56"></span><span class="dot" style="background:#ffbd2e"></span><span class="dot" style="background:#27c93f"></span><span class="title">${escapeHtml(title)}</span></div>
<pre><span class="prompt">$</span> ${escapeHtml(command)}
${shown}${more}</pre>
</main>
</body>
</html>
`;
}
