/**
 * A small markdown renderer for previewing a skill's SKILL.md: headings, lists, fenced code,
 * tables, quotes and the usual inline marks. Everything is escaped before any rule runs, and
 * link targets are checked, so a file from a stranger's repository cannot inject HTML or a
 * `javascript:` URL into the page. Anything it doesn't recognise is left as plain text.
 */

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Link and image targets we're willing to emit: http(s), mail, in-page anchors, and repo-relative paths. */
function safeUrl(href: string): string | null {
  const url = href.trim().replace(/^<|>$/g, "");
  if (!url) return null;
  const scheme = url.match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme && !/^(https?|mailto)$/i.test(scheme[1]!)) return null;
  return url;
}

/** Inline marks. Code spans are lifted out first so nothing rewrites what's inside them. */
function inline(text: string): string {
  const spans: string[] = [];
  let s = esc(text).replace(/(`+)([\s\S]*?)\1/g, (_, _ticks, code: string) => `\u0000${spans.push(`<code>${code.trim()}</code>`) - 1}\u0000`);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (raw, alt: string, src: string) => {
    const url = safeUrl(src);
    return url ? `<img src="${url}" alt="${alt}" loading="lazy">` : raw;
  });
  // A target we won't emit (a javascript: URL, say) is left exactly as it was written in the file.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (raw, label: string, href: string) => {
    const url = safeUrl(href);
    return url ? `<a href="${url}" target="_blank" rel="noopener nofollow">${label}</a>` : raw;
  });
  s = s.replace(/\*\*([^\n]+?)\*\*/g, "<strong>$1</strong>").replace(/(^|\s)__([^\n]+?)__(?=\s|$)/g, "$1<strong>$2</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_([^_\n]+?)_(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/~~([^\n]+?)~~/g, "<del>$1</del>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => spans[Number(i)]!);
}

const INDENT = (line: string): number => (line.match(/^[ \t]*/)![0]!.replace(/\t/g, "  ").length);
const BULLET = /^[ \t]*([-*+]|\d{1,9}[.)])\s+(.*)$/;
const isBlank = (line: string): boolean => !line.trim();

/** One list, possibly with nested lists under its items. Takes the lines it owns and returns HTML. */
function renderList(lines: string[]): string {
  const ordered = /^\s*\d/.test(lines[0]!);
  const items: { text: string[]; children: string[] }[] = [];
  const base = INDENT(lines[0]!);
  for (const line of lines) {
    const m = line.match(BULLET);
    if (m && INDENT(line) <= base) items.push({ text: [m[2]!], children: [] });
    else if (!items.length) continue;
    else if (line.match(BULLET)) items.at(-1)!.children.push(line.slice(Math.min(INDENT(line), base + 2)));
    // A continuation line: part of the same item's paragraph.
    else if (!isBlank(line)) items.at(-1)!.text.push(line.trim());
  }
  const body = items
    .map((it) => `<li>${inline(it.text.join(" "))}${it.children.length ? renderList(it.children) : ""}</li>`)
    .join("");
  return ordered ? `<ol>${body}</ol>` : `<ul>${body}</ul>`;
}

/** A pipe table, given its header row, and the body rows after the delimiter. */
function renderTable(header: string, rows: string[]): string {
  const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
  const head = cells(header).map((c) => `<th>${c}</th>`).join("");
  const body = rows.map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const fence = line.match(/^\s*(```|~~~)(\w[\w+-]*)?/);
    if (fence) {
      flush();
      const body: string[] = [];
      while (++i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!)) body.push(lines[i]!);
      const lang = fence[2] ? ` class="lang-${esc(fence[2])}"` : "";
      out.push(`<pre><code${lang}>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }

    if (isBlank(line)) {
      flush();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*$/);
    if (heading) {
      flush();
      const level = Math.min(heading[1]!.length + 1, 6); // The modal's own title is the h1.
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push("<hr>");
      continue;
    }

    if (BULLET.test(line)) {
      flush();
      const block: string[] = [];
      const ordered = (l: string) => /^[ \t]*\d/.test(l);
      // Another list of the other kind starts a new list; an indented one is nested inside this one.
      const sameList = (l: string) => BULLET.test(l) && (INDENT(l) > INDENT(line) || ordered(l) === ordered(line));
      // The list runs to the first line that is neither an item of it, a continuation, nor a blank line inside it.
      for (; i < lines.length; i++) {
        const l = lines[i]!;
        if (sameList(l) || (block.length && !isBlank(l) && INDENT(l) > 0)) block.push(l);
        else if (isBlank(l) && sameList(lines[i + 1] ?? "")) continue;
        else break;
      }
      i--;
      out.push(renderList(block));
      continue;
    }

    if (line.includes("|") && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] ?? "")) {
      flush();
      const header = line;
      const rows: string[] = [];
      i++;
      while (i + 1 < lines.length && lines[i + 1]!.includes("|") && !isBlank(lines[i + 1]!)) rows.push(lines[++i]!);
      out.push(renderTable(header, rows));
      continue;
    }

    if (/^\s*>/.test(line)) {
      flush();
      const quoted: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]!); i++) quoted.push(lines[i]!.replace(/^\s*>\s?/, ""));
      i--;
      out.push(`<blockquote>${renderMarkdown(quoted.join("\n"))}</blockquote>`);
      continue;
    }

    para.push(line.trim());
  }
  flush();
  return out.join("\n");
}
