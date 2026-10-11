import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { PageRenderer } from "../src/pages.ts";

// Run the actual client script with a minimal browser shell and controlled network.
const script = readFileSync(new URL("../public/app.js", import.meta.url), "utf8")
  .replace('import { initializePosthog } from "./posthog.js";', "");
const serverHtml = "<h1>Review PR</h1><p>Install steps and safety report</p>";

async function client(path: string, status: number, body = {}, html = serverHtml) {
  const app = { innerHTML: html, textContent: html.replace(/<[^>]*>/g, "") };
  const location = new URL(path, "https://example.test");
  const document = {
    title: "Server page title",
    getElementById: (id: string) => id === "app" ? app : id === "q" ? { value: "" } : id === "searchForm" ? { addEventListener() {} } : null,
    addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
  };
  const requests: string[] = [];
  const context = {
    document, location, URLSearchParams, console,
    window: { addEventListener() {}, scrollTo() {}, dataLayer: [] },
    localStorage: { getItem: () => null },
    fetch: async (url: string) => {
      requests.push(url);
      return { ok: status === 200, status, statusText: "Client Closed Request", json: async () => body };
    },
    initializePosthog: async () => {},
    setTimeout() {},
  };
  runInNewContext(script, context);
  // Flush config, rendering and error-handling promise chains.
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { app, document, requests, context };
}

for (const path of ["/skill/review-pr", "/", "/search?page=2"]) {
  for (const status of [499, 503, 404]) {
    test(`client keeps server content at ${path} when API returns ${status}`, async () => {
      const page = await client(path, status);
      assert.equal(page.app.innerHTML, serverHtml);
      assert.equal(page.document.title, "Server page title");
      assert.ok(page.requests.length >= 2, "the client tried config and page data");
    });
  }
}

test("client still renders a skill when its API succeeds", async () => {
  const page = await client("/skill/review-pr", 200, {
    skill: { slug: "review-pr", name: "Interactive review", description: "Review changes", repoUrl: "https://github.com/acme/skills", repoRef: "main", tags: [], createdAt: "2026-10-01", updatedAt: "2026-10-01" },
    links: { skillMd: "https://github.com/acme/skills/blob/main/SKILL.md" },
    related: [],
  });
  assert.match(page.app.innerHTML, /<h1>Interactive review<\/h1>/);
  assert.match(page.document.title, /Interactive review/);
});

test("failed navigation does not restore content from a different URL", async () => {
  const page = await client("/skill/review-pr", 499);
  page.context.location.href = "https://example.test/skill/another";
  await runInNewContext("route()", page.context);
  assert.match(page.app.innerHTML, /Something went wrong loading this page/);
  assert.doesNotMatch(page.app.innerHTML, /Install steps and safety report/);
});

test("empty app shells still show an API error", async () => {
  const page = await client("/skill/review-pr", 499, {}, "");
  assert.match(page.app.innerHTML, /Something went wrong loading this page/);
});

// Apply robots' longest-match rule to the resources requested by the client.
function crawlAllowed(path: string) {
  const rules = new PageRenderer("https://example.test").robots().split("\n")
    .flatMap((line) => {
      const match = /^(Allow|Disallow): (.+)$/.exec(line);
      if (!match) return [];
      const pattern = match[2]!;
      const exact = pattern.endsWith("$");
      const prefix = exact ? pattern.slice(0, -1) : pattern;
      return (exact ? path === prefix : path.startsWith(prefix))
        ? [{ allowed: match[1] === "Allow", length: prefix.length }] : [];
    }).sort((a, b) => b.length - a.length || Number(b.allowed) - Number(a.allowed));
  return rules[0]?.allowed ?? true;
}

test("robots allows rendering data while keeping other API routes excluded", () => {
  for (const path of ["/api/config", "/api/home", "/api/search?q=&page=1", "/api/popular?limit=12", "/api/skills/review-pr", "/api/skills/review-pr/safety", "/api/skills/review-pr/flow"]) {
    assert.equal(crawlAllowed(path), true, path);
  }
  for (const path of ["/api/private", "/api/config/other", "/api/skills?slugs=review-pr", "/flows/review-pr", "/favorites"]) {
    assert.equal(crawlAllowed(path), false, path);
  }
});
