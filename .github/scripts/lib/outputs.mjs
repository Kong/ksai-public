import { appendFileSync } from 'node:fs';

/** writeOutputs appends step outputs, refusing any value that would break out of one line. */
export function writeOutputs(outputFile, entries) {
  const lines = [];
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) continue;
    const text = String(value);
    if (/[\r\n]/.test(text)) throw new Error(`refusing to write a multi-line \`${key}\` step output`);
    lines.push(`${key}=${text}`);
  }
  if (!lines.length || !outputFile) return lines;
  appendFileSync(outputFile, `${lines.join('\n')}\n`);
  return lines;
}
