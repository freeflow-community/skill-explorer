/**
 * Static safety scan of a skill's files. Deterministic and offline: it classifies the files,
 * matches known risk signals line by line, and turns category levels into a score and grade.
 * The model review (rater.ts) reads these hits as hints; the stub rater uses them as-is.
 */

export type CategoryKey = "execution" | "network" | "filesystem" | "secrets" | "privilege" | "injection" | "autonomy" | "opacity";

/** 0 none · 1 low · 2 moderate · 3 high */
export type Level = 0 | 1 | 2 | 3;

export interface Category {
  key: CategoryKey;
  name: string;
  /** Relative contribution to the overall score. */
  weight: number;
  question: string;
}

export const CATEGORIES: Category[] = [
  { key: "execution", name: "Code & shell execution", weight: 1, question: "Does it run scripts, shell commands or evaluate code?" },
  { key: "network", name: "Network access", weight: 1, question: "Does it download files or send data to remote hosts?" },
  { key: "filesystem", name: "Filesystem reach", weight: 1, question: "Does it read, write or delete outside the project?" },
  { key: "secrets", name: "Secrets & credentials", weight: 1.5, question: "Does it touch tokens, keys, passwords or credential stores?" },
  { key: "privilege", name: "Privilege & persistence", weight: 1.5, question: "Does it need sudo, install globally, or change shell or OS settings?" },
  { key: "injection", name: "Instruction hijack surface", weight: 1.5, question: "Does it tell the agent to skip confirmations, follow remote instructions or ignore its rules?" },
  { key: "autonomy", name: "Irreversible actions", weight: 1, question: "Does it push, deploy, send, pay or delete without a human check?" },
  { key: "opacity", name: "Transparency", weight: 1, question: "Is there obfuscated code, binaries or unverifiable downloads?" },
];

export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key) as [CategoryKey, ...CategoryKey[]];

export type Grade = "A" | "B" | "C" | "D" | "F";
export const GRADE_LABELS: Record<Grade, string> = { A: "Minimal risk", B: "Low risk", C: "Moderate risk", D: "Elevated risk", F: "High risk" };

/**
 * Score is 0–100 risk points: the weighted sum of category levels over the weighted maximum.
 * Any category at level 3 caps the grade at C; two or more cap it at D.
 */
export function scoreLevels(levels: Record<CategoryKey, Level>): { score: number; grade: Grade; label: string } {
  let total = 0;
  let max = 0;
  let highs = 0;
  for (const c of CATEGORIES) {
    const level = levels[c.key] ?? 0;
    total += c.weight * level;
    max += c.weight * 3;
    if (level >= 3) highs++;
  }
  const score = Math.round((100 * total) / max);
  const order: Grade[] = ["A", "B", "C", "D", "F"];
  let grade: Grade = score <= 10 ? "A" : score <= 25 ? "B" : score <= 45 ? "C" : score <= 65 ? "D" : "F";
  const cap = highs >= 2 ? "D" : highs === 1 ? "C" : null;
  if (cap && order.indexOf(grade) < order.indexOf(cap)) grade = cap;
  return { score, grade, label: GRADE_LABELS[grade] };
}

export const clampLevel = (n: unknown): Level => Math.max(0, Math.min(3, Math.round(Number(n) || 0))) as Level;

/* ---------------- file inventory ---------------- */

export type FileKind = "markdown" | "shell" | "python" | "javascript" | "powershell" | "code" | "config" | "web" | "data" | "binary" | "other";

const KIND_BY_EXT: Record<string, FileKind> = {
  md: "markdown", mdx: "markdown", txt: "markdown", rst: "markdown",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell", ksh: "shell",
  py: "python", pyw: "python",
  js: "javascript", mjs: "javascript", cjs: "javascript", ts: "javascript", tsx: "javascript", jsx: "javascript",
  ps1: "powershell", psm1: "powershell", bat: "powershell", cmd: "powershell",
  rb: "code", pl: "code", php: "code", lua: "code", go: "code", rs: "code", swift: "code", java: "code", kt: "code",
  cs: "code", r: "code", applescript: "code", scpt: "binary", c: "code", cpp: "code", h: "code",
  json: "config", yaml: "config", yml: "config", toml: "config", ini: "config", cfg: "config", env: "config", example: "config",
  html: "web", htm: "web", css: "web", svg: "web",
  sql: "data", csv: "data", tsv: "data", xml: "data",
  png: "binary", jpg: "binary", jpeg: "binary", gif: "binary", webp: "binary", ico: "binary", pdf: "binary",
  zip: "binary", gz: "binary", tar: "binary", tgz: "binary", "7z": "binary", jar: "binary", wasm: "binary",
  exe: "binary", dll: "binary", so: "binary", dylib: "binary", bin: "binary", dmg: "binary", pkg: "binary", deb: "binary",
  pyc: "binary", node: "binary", woff: "binary", woff2: "binary", ttf: "binary", otf: "binary", mp3: "binary", mp4: "binary",
};
const EXTENSIONLESS_CODE = /(^|\/)(Makefile|Dockerfile|Justfile|Rakefile|Gemfile|Procfile)$/;

export function classifyFile(path: string): FileKind {
  const name = path.split("/").at(-1) ?? path;
  if (EXTENSIONLESS_CODE.test(name)) return "code";
  const ext = name.includes(".") ? name.split(".").at(-1)!.toLowerCase() : "";
  if (!ext) return "other";
  return KIND_BY_EXT[ext] ?? "other";
}

/** Kinds whose content holds instructions or code worth scanning and sending to the model. */
export const SCANNABLE_KINDS = new Set<FileKind>(["markdown", "shell", "python", "javascript", "powershell", "code", "config", "web", "data"]);
export const CODE_KINDS = new Set<FileKind>(["shell", "python", "javascript", "powershell", "code"]);

export interface Inventory {
  files: number;
  byKind: Partial<Record<FileKind, number>>;
  /** Native scripts and programs (anything in CODE_KINDS). */
  scripts: string[];
  /** Files that cannot be read as text. */
  binaries: string[];
  /** Files read and scanned. */
  scanned: string[];
  /** Text files that were listed but not read (size or budget). */
  skipped: string[];
}

export function buildInventory(files: { path: string }[], scanned: string[]): Inventory {
  const byKind: Partial<Record<FileKind, number>> = {};
  const scripts: string[] = [];
  const binaries: string[] = [];
  const read = new Set(scanned);
  const skipped: string[] = [];
  for (const f of files) {
    const kind = classifyFile(f.path);
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (CODE_KINDS.has(kind)) scripts.push(f.path);
    if (kind === "binary") binaries.push(f.path);
    else if (SCANNABLE_KINDS.has(kind) && !read.has(f.path)) skipped.push(f.path);
  }
  return { files: files.length, byKind, scripts, binaries, scanned, skipped };
}

/** "2 shell scripts, 1 Python script, 3 markdown files, 1 binary" */
export function describeInventory(inv: Inventory): string {
  const names: Record<FileKind, [string, string]> = {
    markdown: ["markdown file", "markdown files"], shell: ["shell script", "shell scripts"], python: ["Python script", "Python scripts"],
    javascript: ["JS/TS file", "JS/TS files"], powershell: ["PowerShell/batch script", "PowerShell/batch scripts"], code: ["other program", "other programs"],
    config: ["config file", "config files"], web: ["web file", "web files"], data: ["data file", "data files"],
    binary: ["binary", "binaries"], other: ["other file", "other files"],
  };
  const parts = (Object.entries(inv.byKind) as [FileKind, number][])
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${n} ${names[kind][n === 1 ? 0 : 1]}`);
  return parts.join(", ") || "no files";
}

/* ---------------- risk signals ---------------- */

interface Signal {
  id: string;
  category: CategoryKey;
  severity: 1 | 2 | 3;
  /** Which files the pattern applies to: any text, only code, or only prose. */
  scope: "any" | "code" | "doc";
  pattern: RegExp;
  what: string;
}

const SIGNALS: Signal[] = [
  // execution
  { id: "pipe-to-shell", category: "execution", severity: 3, scope: "any", pattern: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, what: "Downloads a script and pipes it straight into a shell" },
  { id: "eval", category: "execution", severity: 3, scope: "code", pattern: /(^|[^\w.])(eval|exec)\s*\(|\beval\s+"?\$|Invoke-Expression|\biex\b/i, what: "Evaluates dynamically built code" },
  { id: "subprocess", category: "execution", severity: 2, scope: "code", pattern: /\b(subprocess\.|os\.system|os\.popen|child_process|execSync|spawnSync|execFile|shell_exec|system\()/, what: "Spawns shell commands from a script" },
  { id: "shell-c", category: "execution", severity: 2, scope: "any", pattern: /\b(ba|z)?sh\s+-c\s+["']/, what: "Runs a command string through a shell" },
  { id: "npx", category: "execution", severity: 1, scope: "any", pattern: /\b(npx|uvx|pipx run|bunx)\s+[\w@./-]/, what: "Runs a package straight from a registry" },
  { id: "install", category: "execution", severity: 1, scope: "any", pattern: /\b(npm|pnpm|yarn|pip3?|uv|cargo|gem|brew|apt(-get)?|go)\s+(install|add|i)\b/, what: "Installs packages" },
  { id: "chmod-x", category: "execution", severity: 1, scope: "any", pattern: /\bchmod\s+(\+x|[0-7]*7[0-7]*)\b/, what: "Makes a file executable" },
  // network
  { id: "download", category: "network", severity: 2, scope: "any", pattern: /\b(curl|wget|Invoke-WebRequest|iwr)\b/, what: "Downloads from the network" },
  { id: "http-client", category: "network", severity: 1, scope: "code", pattern: /\b(fetch\(|requests\.(get|post|put|delete)|urllib|http\.client|axios|got\(|httpx|aiohttp|net\/http|WebSocket\()/, what: "Makes HTTP requests from code" },
  { id: "upload", category: "network", severity: 2, scope: "code", pattern: /\b(requests\.post|axios\.post|method:\s*["']POST["']|-X\s*POST|--data(-binary)?\b|-d\s*@|FormData\()/, what: "Sends data to a remote host" },
  { id: "tunnel", category: "network", severity: 2, scope: "any", pattern: /\b(ngrok|cloudflared|localtunnel|reverse\s+shell|nc\s+-e|ncat\b|socat\b)/i, what: "Opens a tunnel or raw socket" },
  { id: "raw-ip", category: "network", severity: 2, scope: "any", pattern: /https?:\/\/(?!127\.|0\.0\.0\.0|10\.|192\.168\.)\d{1,3}(\.\d{1,3}){3}\b/, what: "Contacts a raw IP address" },
  { id: "paste-host", category: "network", severity: 2, scope: "any", pattern: /https?:\/\/(pastebin\.com|paste\.ee|hastebin|transfer\.sh|0x0\.st|file\.io|ngrok\.io|ngrok-free\.app|trycloudflare\.com|bit\.ly|tinyurl\.com|t\.co)\b/i, what: "References a paste site, tunnel or URL shortener" },
  // filesystem
  { id: "rm-rf", category: "filesystem", severity: 3, scope: "any", pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b|\bshutil\.rmtree|\bfs\.rm(Sync)?\([^)]*recursive|\brimraf\b|Remove-Item[^\n]*-Recurse/, what: "Deletes directories recursively" },
  { id: "rm", category: "filesystem", severity: 1, scope: "code", pattern: /\brm\s+-|\bos\.remove|\bos\.unlink|\bfs\.unlink|\bunlinkSync|\bfind\b[^\n]*-delete/, what: "Deletes files" },
  { id: "home-dotfile", category: "filesystem", severity: 2, scope: "any", pattern: /(~|\$HOME|%USERPROFILE%|os\.homedir\(\)|expanduser\(["']~)\/\.[a-zA-Z]/, what: "Reads or writes a dotfile or dot-directory in the home folder" },
  { id: "system-path", category: "filesystem", severity: 2, scope: "any", pattern: /(^|[\s"'`=(])\/(etc|usr\/local|usr\/bin|bin|sbin|var|opt|Library|System|private)\//, what: "Touches a system path" },
  { id: "disk", category: "filesystem", severity: 3, scope: "any", pattern: /\b(mkfs|dd\s+if=|diskutil\s+(erase|partition)|fdisk|format\s+[a-z]:)\b/i, what: "Formats or writes raw disks" },
  { id: "write-outside", category: "filesystem", severity: 1, scope: "code", pattern: /(open\([^)]*["'][wa]|writeFile|writeFileSync|Out-File|Set-Content|>\s*\$HOME|>\s*~\/)/, what: "Writes files" },
  // secrets
  { id: "cred-store", category: "secrets", severity: 3, scope: "any", pattern: /(~|\$HOME|%USERPROFILE%)\/\.(ssh|aws|gnupg|gcloud|azure|kube|netrc|npmrc|pypirc|docker\/config\.json|git-credentials)|\bid_(rsa|ed25519)\b|security\s+find-(generic|internet)-password|\bkeychain\b|\bkeyring\b|Credential\s*Manager|Login\s*Data|Cookies\.sqlite/i, what: "Reaches into a credential store or key file" },
  { id: "env-file", category: "secrets", severity: 2, scope: "any", pattern: /(^|[\s"'`/])\.env(\.[\w.]+)?\b(?!\.example)|\bdotenv\b|loadEnvFile/, what: "Reads a .env file" },
  { id: "secret-var", category: "secrets", severity: 1, scope: "any", pattern: /\b[A-Z][A-Z0-9_]*(API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|CLIENT_SECRET|ACCESS_KEY)\b/, what: "Uses a secret-looking environment variable" },
  { id: "token-cli", category: "secrets", severity: 2, scope: "any", pattern: /\b(gh\s+auth\s+token|aws\s+(configure|sts\s+get-session-token)|gcloud\s+auth\s+print-access-token|op\s+(read|item\s+get)|vault\s+(read|kv\s+get)|docker\s+login|npm\s+token)\b/, what: "Extracts a token from a CLI's stored login" },
  { id: "asks-secret", category: "secrets", severity: 2, scope: "doc", pattern: /\b(paste|enter|provide|give)\b[^\n.]{0,40}\b(password|passcode|2fa code|one-time code|otp|recovery code|seed phrase|private key)\b/i, what: "Asks the person for a password, code or key" },
  { id: "browser-session", category: "secrets", severity: 2, scope: "any", pattern: /--cookies(-from-browser)?\b|\bcookies?\.(sqlite|txt|db)\b|document\.cookie|\bsession\s*(id|token|cookie)s?\b|localStorage\.getItem\(["'][^"']*(token|auth)|browser\s+cookies/i, what: "Reads browser cookies or session tokens" },
  // privilege
  { id: "sudo", category: "privilege", severity: 3, scope: "any", pattern: /\b(sudo|doas|runas|Start-Process\s+[^\n]*-Verb\s+RunAs)\b/, what: "Runs as root or administrator" },
  { id: "shell-rc", category: "privilege", severity: 3, scope: "any", pattern: /\.(bashrc|zshrc|bash_profile|zprofile|profile|zshenv|config\/fish\/config\.fish)\b|\$PROFILE\b/, what: "Edits shell startup files" },
  { id: "persistence", category: "privilege", severity: 3, scope: "any", pattern: /\b(crontab|launchctl|LaunchAgents|LaunchDaemons|systemctl\s+enable|schtasks|Register-ScheduledTask|HKLM|HKCU|reg\s+add|defaults\s+write|osascript)\b/, what: "Installs a background service, scheduled task or OS setting" },
  { id: "global-install", category: "privilege", severity: 2, scope: "any", pattern: /\b(npm|pnpm|yarn)\s+(install|add|i)\s+(-g|--global)\b|\bpip3?\s+install\b[^\n]*--user|\bbrew\s+install\b|\bapt(-get)?\s+install\b|\bcargo\s+install\b|\bgo\s+install\b|\bgem\s+install\b/, what: "Installs software system-wide or for the whole user" },
  { id: "git-global", category: "privilege", severity: 2, scope: "any", pattern: /\bgit\s+config\s+--global\b|\.git\/hooks\b|core\.hooksPath|\bgit\s+config\b[^\n]*credential\.helper/, what: "Changes global git settings or hooks" },
  { id: "chown", category: "privilege", severity: 2, scope: "any", pattern: /\b(chown|chmod\s+(-R\s+)?777|setuid|setcap|LD_PRELOAD|DYLD_INSERT_LIBRARIES)\b/, what: "Changes ownership, permissions or process loading" },
  { id: "docker-priv", category: "privilege", severity: 2, scope: "any", pattern: /docker\s+run\b[^\n]*(--privileged|-v\s*\/:|\/var\/run\/docker\.sock)/, what: "Runs a privileged container or mounts the host" },
  // injection
  { id: "ignore-rules", category: "injection", severity: 3, scope: "any", pattern: /\b(ignore|disregard|forget|override)\b[^\n.]{0,40}\b(previous|prior|earlier|all|any|your|system)\b[^\n.]{0,20}\b(instructions?|rules|guidelines|prompt|guardrails)\b/i, what: "Tells the agent to ignore its instructions" },
  { id: "skip-confirm", category: "injection", severity: 3, scope: "any", pattern: /\b(without|never|don'?t|do\s+not|no\s+need\s+to|skip(ping)?)\b[^\n.]{0,30}\b(confirm(ation|ing)?|permission|approval|prompt(ing)?\s+(the\s+)?(user|human|person)|ask(ing)?\s+(for\s+)?(confirmation|permission|approval|first)|ask(ing)?\s+(the\s+)?(user|human|person)\s+(first|before|for))\b/i, what: "Tells the agent not to ask for confirmation" },
  { id: "skip-perms-flag", category: "injection", severity: 3, scope: "any", pattern: /--dangerously-skip-permissions|--yolo\b|--auto-approve\b|--no-verify\b|--force-with-lease|-y\s+--force|\bYOLO\b/, what: "Uses a flag that disables permission checks" },
  { id: "remote-instructions", category: "injection", severity: 3, scope: "any", pattern: /\b(fetch|read|load|download|get|retrieve)\b[^\n.]{0,60}\b(instructions?|prompt|skill|rules|commands?)\b[^\n.]{0,60}\b(from|at)\s+(https?:\/\/|the\s+url|this\s+link)|\bfollow\b[^\n.]{0,40}\binstructions?\b[^\n.]{0,20}\b(at|from)\s+https?:\/\//i, what: "Fetches instructions from a remote location and follows them" },
  { id: "hidden-text", category: "injection", severity: 2, scope: "doc", pattern: /<!--[^>]*\b(instruction|ignore|must|always|never|secret|do\s+not\s+tell)\b[^>]*-->|[​‌‍⁠﻿]{2,}|<(div|span|p)[^>]*(display:\s*none|font-size:\s*0|color:\s*(white|#fff))/i, what: "Hidden text that a reader would not see" },
  { id: "system-prompt", category: "injection", severity: 2, scope: "doc", pattern: /\b(system\s+prompt|jailbreak|developer\s+mode|you\s+are\s+now\b|new\s+persona|pretend\s+(you|to)\b|role-?play\s+as)\b/i, what: "Talks about the agent's system prompt or persona" },
  { id: "auto-yes", category: "injection", severity: 1, scope: "any", pattern: /\byes\s*\|\s*|\s(-y|--yes|--assume-yes|--non-?interactive|--batch)\b/, what: "Answers prompts automatically" },
  { id: "keep-secret", category: "injection", severity: 3, scope: "doc", pattern: /\b(do\s+not|don'?t|never)\s+(tell|mention|reveal|show|inform|report)\b[^\n.]{0,30}\b(user|human|person|anyone)\b/i, what: "Tells the agent to hide something from the person" },
  // autonomy
  { id: "git-push", category: "autonomy", severity: 2, scope: "any", pattern: /\bgit\s+push\b|\bgh\s+pr\s+(create|merge)\b|\bgh\s+release\s+create\b/, what: "Pushes code or opens/merges pull requests" },
  { id: "git-destructive", category: "autonomy", severity: 3, scope: "any", pattern: /\bgit\s+push\b[^\n]*(--force|-f)\b|\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D|checkout\s+--\s+\.)|\bgh\s+repo\s+delete\b/, what: "Rewrites or discards git history" },
  { id: "deploy", category: "autonomy", severity: 2, scope: "any", pattern: /\b(railway\s+up|vercel\s+(deploy|--prod)|fly\s+deploy|wrangler\s+(deploy|publish)|terraform\s+apply|pulumi\s+up|kubectl\s+apply|helm\s+(install|upgrade)|aws\s+\w+\s+(create|put|update)-|gcloud\s+\w+\s+(create|deploy)|az\s+\w+\s+create|npm\s+publish|cargo\s+publish|twine\s+upload|gem\s+push|docker\s+push)\b/, what: "Deploys or publishes" },
  { id: "destroy", category: "autonomy", severity: 3, scope: "any", pattern: /\b(terraform\s+destroy|kubectl\s+delete|helm\s+(uninstall|delete)|aws\s+\w+\s+(delete|terminate)-|gcloud\s+\w+\s+delete|az\s+\w+\s+delete|railway\s+(down|delete)|fly\s+(destroy|apps\s+destroy)|DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE|DELETE\s+FROM\b(?![^\n;]*WHERE))\b/i, what: "Destroys infrastructure or data" },
  { id: "send-message", category: "autonomy", severity: 2, scope: "any", pattern: /\b(chat\.postMessage|slack_send_message|send_message|sendMessage|sendmail|smtplib|nodemailer|sgMail|twilio|messages\.create|tweet|post\s+(a\s+)?(comment|reply|message)|gh\s+(issue|pr)\s+comment|create_draft|send_email|Gmail__send)\b/i, what: "Sends messages, email or posts on the person's behalf" },
  { id: "payments", category: "autonomy", severity: 3, scope: "any", pattern: /\b(stripe\.(charges|paymentIntents|checkout)|paymentIntents\.create|charges\.create|checkout\.sessions\.create|purchase|place\s+(the\s+)?order|book(ing)?\s+(the\s+)?(flight|hotel|ticket)|buy\s+now|transfer\s+funds)\b/i, what: "Makes purchases, bookings or payments" },
  { id: "browser-automation", category: "autonomy", severity: 1, scope: "any", pattern: /\b(puppeteer|playwright|selenium|chromedriver|claude-in-chrome|chrome-devtools|browser\s+automation)\b/i, what: "Drives a browser" },
  // opacity
  { id: "base64-blob", category: "opacity", severity: 3, scope: "any", pattern: /[A-Za-z0-9+/]{200,}={0,2}/, what: "Contains a long base64-looking blob" },
  { id: "decode-exec", category: "opacity", severity: 3, scope: "code", pattern: /\b(base64\s+(-d|--decode)|atob\(|b64decode|fromCharCode|unescape\(|marshal\.loads|pickle\.loads|zlib\.decompress)\b/, what: "Decodes hidden content at run time" },
  { id: "hex-escapes", category: "opacity", severity: 2, scope: "code", pattern: /(\\x[0-9a-fA-F]{2}){8,}|(\\u[0-9a-fA-F]{4}){8,}/, what: "Long runs of escaped characters" },
  { id: "minified", category: "opacity", severity: 2, scope: "code", pattern: /^.{1500,}$/, what: "A very long line, typical of minified or packed code" },
  { id: "exe-download", category: "opacity", severity: 2, scope: "any", pattern: /https?:\/\/[^\s"'<>]+\.(exe|dmg|pkg|msi|deb|rpm|apk|bin|run)\b/i, what: "Downloads an installer or executable" },
  { id: "unpinned-git", category: "opacity", severity: 1, scope: "any", pattern: /\bpip3?\s+install\s+git\+|\bnpm\s+(install|i|add)\s+(github:|git\+|https:\/\/github\.com)/, what: "Installs code straight from a git URL" },
];

export interface ScanHit {
  id: string;
  category: CategoryKey;
  severity: 1 | 2 | 3;
  what: string;
  file: string;
  line: number;
  excerpt: string;
}

export interface ScanResult {
  hits: ScanHit[];
  /** Highest severity seen per category (0 when nothing matched). */
  levels: Record<CategoryKey, Level>;
}

const MAX_HITS_PER_SIGNAL_FILE = 3;
const MAX_HITS = 200;

/** Match every signal against every line of every text file. */
export function scanSources(sources: { path: string; content: string }[]): ScanResult {
  const hits: ScanHit[] = [];
  const perKey = new Map<string, number>();
  for (const f of sources) {
    const kind = classifyFile(f.path);
    const isCode = CODE_KINDS.has(kind);
    const isDoc = kind === "markdown";
    const lines = f.content.split("\n");
    for (const sig of SIGNALS) {
      if (sig.scope === "code" && !isCode) continue;
      if (sig.scope === "doc" && !isDoc) continue;
      const key = `${sig.id}\0${f.path}`;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!sig.pattern.test(line)) continue;
        const n = perKey.get(key) ?? 0;
        if (n >= MAX_HITS_PER_SIGNAL_FILE) break;
        perKey.set(key, n + 1);
        hits.push({ id: sig.id, category: sig.category, severity: sig.severity, what: sig.what, file: f.path, line: i + 1, excerpt: line.trim().slice(0, 160) });
        if (hits.length >= MAX_HITS) return finish(hits);
      }
    }
  }
  return finish(hits);
}

function finish(hits: ScanHit[]): ScanResult {
  const levels = Object.fromEntries(CATEGORY_KEYS.map((k) => [k, 0])) as Record<CategoryKey, Level>;
  for (const h of hits) if (h.severity > levels[h.category]) levels[h.category] = h.severity;
  hits.sort((a, b) => b.severity - a.severity || a.file.localeCompare(b.file) || a.line - b.line);
  return { hits, levels };
}

/** Binaries the model can't read still count against transparency. */
export function applyInventory(scan: ScanResult, inv: Inventory): ScanResult {
  if (inv.binaries.length && scan.levels.opacity < 2) scan.levels.opacity = 2;
  return scan;
}
