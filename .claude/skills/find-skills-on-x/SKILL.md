---
name: find-skills-on-x
description: Search X for people posting about agent skills, pull the GitHub repos out of those posts, check them against the skillexplorer.dev index, and register the ones that are new. Use when asked to find new skills on X/Twitter, harvest what people are sharing, or top up the index from social. Proposes candidates and waits for approval before registering.
---

# Finding new skills on X

People post agent skills on X faster than the index picks them up. This goes and looks,
finds repositories the index doesn't have yet, and adds them. Default target is **4 new
repos**; the human can ask for a different number.

**You propose, the human approves, then you register.** Registering puts a stranger's
repository on a public site under Scott's name, so it is never automatic.

## 0. Check the index is the real one first

```sh
npm run cli -- sync status
```

The `storage:` line must show **r2**. If it says `local:` you are pointed at a scratch
database on this machine, not the live index — registering would silently change nothing
that anyone can see. Stop and tell the human that `R2_*` credentials are missing from
`.env`, rather than doing the work into a void.

You also need GitHub API access. The CLI takes `GITHUB_TOKEN`, or falls back to
`gh auth token`. Unauthenticated works but rate-limits quickly across many repos.

## 1. Search X

Use the logged-in session from `browser-auth-handoff` (the search results page needs an
account). Drive `https://x.com/search?q=<encoded>&f=live` — `f=live` is the Latest tab,
which is what you want; the default Top tab buries new posts under popular old ones.

Run several queries, not one. "skill" alone returns mostly noise about job skills:

```
SKILL.md
"agent skill" github.com
claude skill github.com
"claude code" skill repo
skills.md agent
```

Scroll the results a few times (`p.mouse.wheel`) — X loads ~10 posts per screen and the
interesting ones are rarely in the first batch. For each post keep the text, the author
handle, the permalink, and every link in it.

## 2. Turn posts into candidate repos

Links in a post are `t.co` redirects in the DOM. Resolve them:

```sh
curl -sI -o /dev/null -w '%{url_effective}' -L "https://t.co/xxxx"
```

Keep `github.com/<owner>/<repo>` URLs. A `/tree/<ref>/<path>` link is a gift — it points
straight at the skill's directory and `register` accepts that form as-is. Drop gists, raw
file links to something other than a SKILL.md, and anything that isn't GitHub.

Also read the post text: people often name a repo without linking it (`just shipped
foo/bar-skills`). Those count, if you can confirm the repo exists.

## 3. Filter before you propose

A candidate has to survive all of these:

- **It actually contains a SKILL.md.** `npm run cli -- register <repo> --dry-run` prints
  what it would add, or "No SKILL.md files found." A post enthusing about skills often
  links to a blog, a framework, or someone's dotfiles.
- **The index doesn't have it.**
  `curl -s "https://skillexplorer.dev/api/search?repo=https://github.com/<owner>/<repo>"`
  — a non-empty `results` means skip. Check the live site, not your local database.
- **It isn't in `found.jsonl`** next to this file, which records both what was registered
  and what was rejected, with the reason. Don't re-propose something the human already
  turned down.
- **It's a reasonable size.** Pass `--max-skills 40`. A monorepo that vendors a thousand
  SKILL.md files will swamp the index and is usually a mirror of skills already in it.
- **It's a real skill repo, not a copy.** Vendored `.claude/skills/` folders inside an
  unrelated project are usually someone's installed copies of other people's skills — the
  original author deserves the listing, so follow it upstream or skip it.

Stop once you have 4 that pass. If the searches run dry, say so and report how many you
found; do not pad the list with weak candidates to hit the number.

## 4. Propose

For each candidate give the human:

- the repo, and how many skills `--dry-run` found in it, with their names
- one line on what they do
- who posted it and a link to the post, so the human can judge the source
- anything that gave you pause (no README, a single stub skill, an author you can't identify)

Then stop and wait for an actual answer.

## 5. Register

```sh
npm run cli -- register <repo> [<repo>...] --auto-tags --max-skills 40
npm run cli -- sync push
```

`--auto-tags` asks the tagging model for tags so the new skills are findable by topic
rather than landing untagged. `register` alone only changes the local database; **the push
is what makes it live** — don't skip it and report success.

Then confirm: `curl -s "https://skillexplorer.dev/api/search?repo=<repo>"` should return the
new skills within a few minutes (the server re-reads storage on an interval). Report what
actually landed, including anything that failed.

Append one line per candidate to `found.jsonl`, registered or not:

```json
{"repo":"https://github.com/o/r","status":"registered","skills":3,"from":"https://x.com/someone/status/123","at":"2026-09-22T03:00:00Z"}
{"repo":"https://github.com/o/other","status":"rejected","reason":"no SKILL.md, it's a blog post about skills","from":"...","at":"..."}
```

## Not your call

Posting, liking, following or replying from the account — this skill only reads X. Removing
or re-tagging skills already in the index. Registering a repo the human passed on.
