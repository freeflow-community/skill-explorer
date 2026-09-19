import { Script } from "node:vm";

/** Script types that hold JavaScript we can syntax-check (module scripts would need import support). */
const CLASSIC = /^(|text\/javascript|application\/javascript)$/i;

/**
 * Check a generated flow page before it is stored. A syntax error in the page's inline
 * script blanks everything the script renders, so it counts as a failed build.
 * Returns human-readable problems; an empty array means the page is usable.
 */
export function validateFlowHtml(html: string): string[] {
  const problems: string[] = [];
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  scripts.forEach((m, i) => {
    const attrs = m[1] ?? "";
    if (/\bsrc\s*=/.test(attrs)) return;
    const type = attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i)?.[1] ?? "";
    if (!CLASSIC.test(type)) return;
    const src = m[2] ?? "";
    try {
      new Script(src, { filename: `inline-script-${i + 1}.js` });
    } catch (e) {
      const err = e as SyntaxError;
      const where = String(err.stack ?? "").match(/inline-script-\d+\.js:(\d+)/);
      const lineNo = where ? Number(where[1]) : undefined;
      const line = lineNo ? src.split("\n")[lineNo - 1]?.trim().slice(0, 200) : undefined;
      problems.push(
        `Inline script ${i + 1} has a JavaScript syntax error (${err.message})` +
          (lineNo ? ` at its line ${lineNo}: ${line}` : ""),
      );
    }
  });
  return problems;
}
