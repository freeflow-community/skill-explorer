import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import type { Skill } from "./db.ts";
import { summary, SITE_NAME, SITE_TAGLINE } from "./pages.ts";
import type { SafetySummary } from "./scores/jobs.ts";
import type { BlobStore } from "./storage.ts";

/**
 * Open Graph cards, drawn as SVG and rasterised to PNG. X, Slack and iMessage all refuse SVG
 * for og:image, so every card goes out as a 1200x630 PNG.
 *
 * Text is laid out by hand because SVG has no line wrapping: `measure()` reads real advance
 * widths out of the TTFs, so a line break lands where the glyphs actually run out of room
 * rather than where a character count guesses they might.
 */

const W = 1200;
const H = 630;

/** The light half of the palette in public/app.css, so a card looks like the site. */
const C = {
  ground: "#EEF1F4",
  surface: "#FFFFFF",
  ink: "#151B24",
  muted: "#5A6373",
  line: "#D6DCE3",
  accent: "#0F6A8B",
  accentSoft: "#DCEEF4",
  ok: "#1D7A45",
  okSoft: "#DEF1E5",
  warn: "#8F5400",
  warnSoft: "#FCEFD7",
  bad: "#B3261E",
  badSoft: "#FBE3E1",
} as const;

const DISPLAY = "Gabarito";
const BODY = "Atkinson Hyperlegible Next";

const xml = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

/* ---------------- font metrics ---------------- */

interface Metrics {
  unitsPerEm: number;
  /** Advance width in font units, by code point. Missing code points fall back to `fallback`. */
  advance: Map<number, number>;
  fallback: number;
}

const u16 = (b: Buffer, o: number) => b.readUInt16BE(o);
const u32 = (b: Buffer, o: number) => b.readUInt32BE(o);

/**
 * Advance widths for one TTF, by code point: the table directory gives head (unitsPerEm),
 * hhea (how many entries hmtx holds), hmtx (the widths) and cmap (code point to glyph).
 * Only cmap format 4 is read, which covers every character these cards draw.
 */
function readMetrics(file: string): Metrics {
  const b = readFileSync(file);
  const tables = new Map<string, number>();
  for (let i = 0; i < u16(b, 4); i++) {
    const rec = 12 + i * 16;
    tables.set(b.toString("latin1", rec, rec + 4), u32(b, rec + 8));
  }
  const need = (t: string) => {
    const off = tables.get(t);
    if (off === undefined) throw new Error(`${file} has no ${t} table`);
    return off;
  };

  const unitsPerEm = u16(b, need("head") + 18);
  const numHMetrics = u16(b, need("hhea") + 34);
  const hmtx = need("hmtx");
  // hmtx holds numHMetrics widths; glyphs past that all share the last one (monospaced tail).
  const widthOf = (gid: number) => u16(b, hmtx + Math.min(gid, numHMetrics - 1) * 4);

  // cmap: prefer a Windows BMP subtable (3,1), else take any format 4 that is present.
  const cmap = need("cmap");
  let sub = 0;
  for (let i = 0; i < u16(b, cmap + 2); i++) {
    const rec = cmap + 4 + i * 8;
    const off = cmap + u32(b, rec + 4);
    if (u16(b, off) !== 4) continue;
    if (u16(b, rec) === 3 && u16(b, rec + 2) === 1) { sub = off; break; }
    sub ||= off;
  }
  if (!sub) throw new Error(`${file} has no format 4 cmap`);

  const segX2 = u16(b, sub + 6);
  const ends = sub + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const ranges = deltas + segX2;

  const advance = new Map<number, number>();
  for (let s = 0; s < segX2 / 2; s++) {
    const end = u16(b, ends + s * 2);
    const start = u16(b, starts + s * 2);
    if (start > end || start === 0xffff) continue;
    const delta = u16(b, deltas + s * 2);
    const rangeOff = u16(b, ranges + s * 2);
    for (let cp = start; cp <= end; cp++) {
      let gid: number;
      if (rangeOff === 0) {
        gid = (cp + delta) & 0xffff;
      } else {
        const at = ranges + s * 2 + rangeOff + (cp - start) * 2;
        if (at + 1 >= b.length) continue;
        gid = u16(b, at);
        if (gid) gid = (gid + delta) & 0xffff;
      }
      if (gid) advance.set(cp, widthOf(gid));
    }
  }
  return { unitsPerEm, advance, fallback: advance.get(0x6e) ?? widthOf(0) };
}

/** One entry per (family, weight) pair the cards draw with. */
type FaceKey = `${string}:${number}`;

export class CardFonts {
  readonly dir: string;
  private faces = new Map<FaceKey, Metrics>();

  constructor(dir = "./public/fonts") {
    this.dir = dir;
    const files: [FaceKey, string][] = [
      [`${DISPLAY}:800`, "Gabarito-ExtraBold.ttf"],
      [`${DISPLAY}:400`, "Gabarito-Regular.ttf"],
      [`${BODY}:600`, "AtkinsonHyperlegibleNext-SemiBold.ttf"],
      [`${BODY}:400`, "AtkinsonHyperlegibleNext-Regular.ttf"],
    ];
    for (const [key, name] of files) this.faces.set(key, readMetrics(join(dir, name)));
  }

  /** Width of `text` in pixels, at `size`, for one face. */
  measure(text: string, family: string, weight: number, size: number): number {
    const m = this.faces.get(`${family}:${weight}`);
    if (!m) throw new Error(`no metrics for ${family} ${weight}`);
    let units = 0;
    for (const ch of text) units += m.advance.get(ch.codePointAt(0)!) ?? m.fallback;
    return (units / m.unitsPerEm) * size;
  }

  /**
   * Greedy wrap to at most `maxLines`. Lines break at spaces and after hyphens — skill names
   * are nearly all hyphenated, so "aws-lambda-managed-instances" breaks at a hyphen instead
   * of mid-syllable. A fragment still too wide is cut where it stops fitting, and an
   * overflowing last line ends in an ellipsis.
   */
  wrap(text: string, family: string, weight: number, size: number, width: number, maxLines: number): string[] {
    const fits = (s: string) => this.measure(s, family, weight, size) <= width;
    // Each token carries whether a space belongs in front of it when it follows another.
    const tokens: { text: string; spaced: boolean }[] = [];
    for (const word of String(text ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean)) {
      // Keep the hyphen on the fragment before the break, so the line ends "aws-".
      const pieces = word.split(/(?<=-)/);
      pieces.forEach((p, i) => tokens.push({ text: p, spaced: i === 0 }));
    }

    const lines: string[] = [];
    let line = "";
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      const joiner = line && t.spaced ? " " : "";
      if (fits(line + joiner + t.text)) { line += joiner + t.text; continue; }

      if (line) lines.push(line);
      if (lines.length === maxLines) return this.ellipsize(lines, family, weight, size, width);

      // A single fragment wider than the whole line has to be cut somewhere.
      let rest = t.text;
      while (!fits(rest)) {
        let cut = rest.length - 1;
        while (cut > 1 && !fits(rest.slice(0, cut))) cut--;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
        if (lines.length === maxLines) return this.ellipsize(lines, family, weight, size, width);
      }
      line = rest;
    }
    if (line) lines.push(line);
    return lines;
  }

  /** The largest of `sizes` that wraps `text` into `maxLines` or fewer. */
  fitSize(text: string, family: string, weight: number, sizes: number[], width: number, maxLines: number): number {
    for (const size of sizes) {
      if (this.wrap(text, family, weight, size, width, maxLines + 1).length <= maxLines) return size;
    }
    return sizes[sizes.length - 1]!;
  }

  /** Put an ellipsis on the last kept line, trimming it until the ellipsis fits too. */
  private ellipsize(lines: string[], family: string, weight: number, size: number, width: number): string[] {
    const out = [...lines];
    let last = out[out.length - 1] ?? "";
    while (last && this.measure(`${last}…`, family, weight, size) > width) {
      last = last.slice(0, -1).replace(/[\s,;:.]+$/, "");
    }
    out[out.length - 1] = `${last}…`;
    return out;
  }
}

/* ---------------- drawing ---------------- */

interface TextOpts {
  family?: string;
  weight?: number;
  size: number;
  fill: string;
  anchor?: "start" | "middle" | "end";
  spacing?: number;
  /** Emitted as a class, so tests can pick out one kind of line by its role. */
  role?: string;
}

function text(s: string, x: number, y: number, o: TextOpts): string {
  const attrs = [
    `x="${x}"`,
    `y="${y}"`,
    `font-family="${o.family ?? BODY}"`,
    `font-weight="${o.weight ?? 400}"`,
    `font-size="${o.size}"`,
    `fill="${o.fill}"`,
    o.anchor ? `text-anchor="${o.anchor}"` : "",
    o.spacing ? `letter-spacing="${o.spacing}"` : "",
    o.role ? `class="${o.role}"` : "",
  ].filter(Boolean);
  return `<text ${attrs.join(" ")}>${xml(s)}</text>`;
}

/** Grades map onto the same three states the safety pages use. */
function gradeColors(grade: string): { fg: string; bg: string } {
  if (grade === "A" || grade === "B") return { fg: C.ok, bg: C.okSoft };
  if (grade === "C") return { fg: C.warn, bg: C.warnSoft };
  return { fg: C.bad, bg: C.badSoft };
}

interface PillOpts {
  size: number;
  weight: number;
  fg: string;
  bg: string;
  padX?: number;
}

const pillWidth = (label: string, fonts: CardFonts, o: PillOpts) => fonts.measure(label, BODY, o.weight, o.size) + (o.padX ?? 18) * 2;

function pill(label: string, x: number, y: number, h: number, fonts: CardFonts, o: PillOpts): string {
  const padX = o.padX ?? 18;
  const w = pillWidth(label, fonts, o);
  return (
    `<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${h}" rx="${h / 2}" fill="${o.bg}"/>` +
    text(label, x + padX, y + h / 2 + o.size * 0.35, { size: o.size, weight: o.weight, fill: o.fg })
  );
}

export interface CardInput {
  title: string;
  /** Sits under the title in the accent colour, e.g. "by trailofbits". */
  byline: string;
  body: string;
  tags?: string[];
  safety?: SafetySummary;
  footer?: string;
  /** Small caps above the title. Empty drops it, for the card whose title is the site name. */
  eyebrow?: string;
}

/** The card as SVG. Kept separate from rasterising so tests can read the layout. */
export function cardSvg(input: CardInput, fonts: CardFonts): string {
  const pad = 40;
  const inset = 56;
  const left = pad + inset;
  const right = W - pad - inset;
  const width = right - left;
  const parts: string[] = [
    `<rect width="${W}" height="${H}" fill="${C.ground}"/>`,
    `<rect x="${pad}" y="${pad}" width="${W - pad * 2}" height="${H - pad * 2}" rx="28" fill="${C.surface}" stroke="${C.line}" stroke-width="2"/>`,
  ];

  // Header: wordmark left, safety grade right.
  const headY = pad + inset + 18;
  const eyebrow = input.eyebrow ?? SITE_NAME.toUpperCase();
  if (eyebrow) parts.push(text(eyebrow, left, headY, { size: 21, weight: 600, fill: C.accent, spacing: 2.5, role: "eyebrow" }));
  if (input.safety) {
    const { fg, bg } = gradeColors(input.safety.grade);
    const opts = { size: 22, weight: 600, fg, bg, padX: 20 };
    const label = `${input.safety.grade} · ${input.safety.label}`;
    parts.push(pill(label, right - pillWidth(label, fonts, opts), headY - 30, 44, fonts, opts));
  }

  // The footer is pinned to the bottom, so everything above it has a fixed budget to fit in.
  const footY = H - pad - inset - 30;
  const divider = footY - 34;

  const bodySize = 27;
  const bodyLeading = 38;
  const titleTop = headY + 96;

  // How the blocks stack for a given title size: a two-line title costs a whole line of
  // description, so try the big sizes first and drop a step until the description still fits.
  const plan = (size: number) => {
    const lines = fonts.wrap(input.title, DISPLAY, 800, size, width, 2);
    const bylineY = titleTop + lines.length * (size + 8) + 6;
    const bodyTop = bylineY + 56;
    return { size, lines, bylineY, bodyTop, room: Math.floor((divider - 26 - bodyTop) / bodyLeading) + 1 };
  };
  const steps = [76, 66, 58, 50].map(plan);
  const layout = steps.find((s) => s.room >= 2) ?? steps[steps.length - 1]!;

  let y = titleTop;
  for (const line of layout.lines) {
    parts.push(text(line, left, y, { family: DISPLAY, weight: 800, size: layout.size, fill: C.ink, role: "title" }));
    y += layout.size + 8;
  }
  parts.push(text(input.byline, left, layout.bylineY, { size: 30, weight: 600, fill: C.accent, role: "byline" }));

  y = layout.bodyTop;
  const bodyLines = layout.room < 1 ? [] : fonts.wrap(input.body, BODY, 400, bodySize, width, Math.min(3, layout.room));
  for (const line of bodyLines) {
    parts.push(text(line, left, y, { size: bodySize, fill: C.muted, role: "body" }));
    y += bodyLeading;
  }

  // Footer: tags along the bottom left, the domain on the right.
  parts.push(`<line x1="${left}" y1="${divider}" x2="${right}" y2="${divider}" stroke="${C.line}" stroke-width="2"/>`);

  const tagOpts = { size: 20, weight: 600, fg: C.accent, bg: C.accentSoft, padX: 16 };
  let tagX = left;
  for (const tag of (input.tags ?? []).slice(0, 5)) {
    const w = pillWidth(tag, fonts, tagOpts);
    // Stop before a pill would collide with the domain on the right.
    if (tagX + w > right - 260) break;
    parts.push(pill(tag, tagX, footY - 6, 38, fonts, tagOpts));
    tagX += w + 10;
  }
  parts.push(text(input.footer ?? "skillexplorer.dev", right, footY + 20, { size: 22, weight: 600, fill: C.muted, anchor: "end" }));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
}

function rasterise(svg: string, fonts: CardFonts): Buffer {
  const png = new Resvg(svg, {
    font: { fontDirs: [fonts.dir], loadSystemFonts: false, defaultFontFamily: BODY },
    fitTo: { mode: "width", value: W },
  })
    .render()
    .asPng();
  return Buffer.from(png);
}

export function repoOwnerOf(repoUrl: string): string {
  return repoUrl.replace(/^https?:\/\/github\.com\//, "").split("/")[0] ?? "GitHub";
}

export function skillCard(skill: Skill, safety: SafetySummary | undefined, fonts: CardFonts): Buffer {
  const body = skill.description ? summary(skill.description, 220) : "An agent skill on skillexplorer.dev.";
  return rasterise(
    cardSvg({ title: skill.name, byline: `by ${repoOwnerOf(skill.repoUrl)}`, body, tags: skill.tags, safety }, fonts),
    fonts,
  );
}

/** The card every non-skill page shares. */
export function siteCard(total: number, fonts: CardFonts): Buffer {
  return rasterise(
    cardSvg({ title: SITE_NAME, byline: `${total.toLocaleString("en-US")} agent skills, indexed from GitHub`, body: SITE_TAGLINE, eyebrow: "" }, fonts),
    fonts,
  );
}

/**
 * Cache key for a skill's card. The hash covers everything drawn, so an edited description or
 * a fresh safety grade lands on a new key instead of serving the old picture.
 */
export function cardKey(skill: Skill, safety?: SafetySummary): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([skill.name, skill.repoUrl, skill.description, skill.tags, safety?.grade, safety?.label]))
    .digest("hex")
    .slice(0, 12);
  return `og/v1/${skill.slug}-${hash}.png`;
}

/**
 * Cards on demand, cached twice over: a bounded map in front of the blob store, so a crawler
 * storm over one link costs a single render. Keys carry a content hash, so nothing has to be
 * invalidated when a skill changes — it simply lands on a key that isn't there yet.
 */
export class CardService {
  private fonts: CardFonts;
  private store: BlobStore;
  private memo = new Map<string, Uint8Array<ArrayBuffer>>();
  private memoMax: number;

  constructor(store: BlobStore, opts: { fonts?: CardFonts; memoMax?: number } = {}) {
    this.store = store;
    this.fonts = opts.fonts ?? new CardFonts();
    this.memoMax = opts.memoMax ?? 128;
  }

  /** Copied into a plain Uint8Array once here, so serving a cached card copies nothing. */
  private remember(key: string, png: Buffer): Uint8Array<ArrayBuffer> {
    // Oldest-first eviction: a Map iterates in insertion order, so the first key is the oldest.
    if (this.memo.size >= this.memoMax) {
      const oldest = this.memo.keys().next().value;
      if (oldest !== undefined) this.memo.delete(oldest);
    }
    const body = new Uint8Array(png.byteLength);
    body.set(png);
    this.memo.set(key, body);
    return body;
  }

  async skill(skill: Skill, safety: SafetySummary | undefined): Promise<Uint8Array<ArrayBuffer>> {
    const key = cardKey(skill, safety);
    const hit = this.memo.get(key);
    if (hit) return hit;

    const stored = await this.store.get(key).catch(() => null);
    if (stored) return this.remember(key, stored.body);

    const png = skillCard(skill, safety, this.fonts);
    // A card that can't be stored is still a card worth serving, so a write failure is not fatal.
    await this.store.put(key, png, "image/png").catch(() => undefined);
    return this.remember(key, png);
  }

  /** The shared card, rendered once per process — its only input is the skill count. */
  site(total: number): Uint8Array<ArrayBuffer> {
    const key = `site:${total}`;
    return this.memo.get(key) ?? this.remember(key, siteCard(total, this.fonts));
  }
}
