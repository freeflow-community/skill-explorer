---
name: post-skill-to-x
description: Find an interesting agent skill in the skillexplorer.dev index, work out what is genuinely worth saying about it, and post that to X from Scott's account (@persingerscott). Use when asked to post/tweet about a skill, to promote a skill on X, or to do the day's skill post. Runs end to end on its own: picks the skill, writes the options, takes the most casual one and posts it without checking in.
---

# Posting about a skill on X

One post, about one skill, that gives a reader something they didn't know. The account is a
real person's, so the bar is: would someone who follows a lot of AI tooling accounts stop on
this? If the honest answer is no, pick a different skill rather than writing it up anyway.

**You post on your own.** Pick the skill, write the options, take the most casual one and send
it. Don't ask, don't wait, don't post the drafts for a verdict first — Scott has delegated the
whole run. Tell him what went out once it's up.

Nobody reads it before it's public, so the accuracy rules in step 3 are the only check left.
They are not style notes: every claim comes from the SKILL.md, and you never @ anyone whose
handle you haven't confirmed. If a draft needs a fact you can't source, that draft doesn't go
out — pick another angle, or another skill.

## 1. Pick a skill

Skills come from the live site. Its API is public and needs no auth:

```sh
curl -s "https://skillexplorer.dev/api/home"            # recent, popular, collections, total
curl -s "https://skillexplorer.dev/api/popular?limit=50"
curl -s "https://skillexplorer.dev/api/search?q=<term>"  # or ?tag= / ?collection= / ?repo=
curl -s "https://skillexplorer.dev/api/skills/<slug>"    # one skill, plus its safety score
curl -s "https://skillexplorer.dev/api/skills/<slug>/source"  # its SKILL.md, frontmatter + HTML
```

Check `posted.jsonl` next to this file first and skip anything already in it.

What makes a skill worth a post — you need at least one:

- It does something people don't know an agent *can* do (drive a browser, read a heatmap,
  mint a certificate, rig a 3D model).
- Its method is opinionated and specific, not "helps you with X" — the SKILL.md argues for a
  way of working and you can say what the argument is.
- The pairing is odd. A skill about knitting charts or tarot next to one about Kubernetes.
- It quietly solves a problem the reader has felt (flaky test triage, a migration nobody
  wants to do by hand).

Reasons to pass: the description is generic ("assists with data analysis"), the SKILL.md is
a stub, or it's the fifth CRUD-adjacent skill this month. A thin skill can't be rescued by
good writing.

## 2. Read it before you write about it

Pull the SKILL.md — `/api/skills/<slug>/source` — and read the body, not just the
description. The post needs one **concrete particular** from inside the file: a rule it
insists on, a number, a step that reveals how it thinks. That detail is what makes the post
worth reading; without one, you're writing a press release.

Note who owns the repository (`repoUrl` → the GitHub user or org) and what the skill is
actually *for* — the problem it exists to solve, which is often clearer in the body than in
the frontmatter description. Both go in the post.

Note the safety grade too (`/api/skills/<slug>` → `safety`). Mention it only when it's
actually interesting — an A on something that touches the filesystem, or a D that a reader
deserves fair warning about. Never as filler.

## 3. Write the post

Shape:

- Under 280 characters including the link. Aim for 180–240; short reads as confident.
- Open on the specific thing. No "Check out this skill" or "Ever wanted to…".
- Name **who wrote it** and **what it's for**. Both are non-negotiable: a post about
  someone's work that doesn't credit them is bad manners, and a reader who can't tell what
  the skill is *for* has no reason to click. Credit by the GitHub owner from `repoUrl`
  (`addyosmani`, `anthropics`) — only use an X handle if you have actually confirmed it
  belongs to that person, because a wrong @ drags a stranger into the thread. The purpose
  is one clause, in your words, not the description pasted back.
- One detail from the SKILL.md, in concrete terms.
- Close with the link: `https://skillexplorer.dev/skill/<slug>` — its own line. The page has
  og tags, so X renders a card; don't paste a second link and don't use a shortener.
- At most one hashtag, and usually zero. No emoji unless it's doing real work.
- Never invent a capability the SKILL.md doesn't claim. If you're unsure it does the thing,
  it doesn't go in the post.

Voice: casual, specific, a little dry — a person typing a thought, not an announcement.
Contractions, plain words, the shape of talking. The reader is smart and has seen a hundred
AI threads today. Say the interesting thing and stop.

Casual is not hype, and this is the distinction the whole voice turns on. "trailofbits
shipped a tarot skill" is casual. "🚀 This changes everything" is hype. Hype is still out:
no "game changer", no "🚀", no "I've been exploring…", no thread.

Write two or three options in different directions rather than one and a polish pass. It's
cheap, and you need a spread to choose from in the next step.

## 4. Take the most casual one

Of the options you wrote, send the one that sounds most like a person talking — the one you'd
actually say out loud. That's the tiebreak, and it's yours to call.

Two things override it, because a post that's wrong is worse than a post that's stiff:

- It has to survive the step 3 accuracy rules. Every claim traceable to the SKILL.md, the
  owner credited, no unconfirmed @.
- It still has to say what the skill is *for*. Casual that leaves a reader with no idea what
  the thing does is just vague — pick the next one down.

If the most casual option fails either, take the next. If they all do, go back to step 3 and
write better ones; don't ship the least bad.

## 5. Post it

The account is reached with a shared logged-in session, not a password — see the
`browser-auth-handoff` skill. Get a session for `https://x.com` if you don't have a live
one, then drive the composer:

```js
// node, with playwright; bundle from `browser-handoff request --origins https://x.com --out …`
const { newContextFromBundle } = await import(process.env.HOME +
  "/.claude/skills/browser-auth-handoff/scripts/import-bundle.mjs");
const ctx = await newContextFromBundle(await chromium.launch(), bundle);
const p = await ctx.newPage();
await p.goto("https://x.com/compose/post", { waitUntil: "domcontentloaded" });
await p.waitForSelector('[data-testid="tweetTextarea_0"]');
await p.click('[data-testid="tweetTextarea_0"]');
await p.keyboard.type(text);                       // type it; pasting can drop the card preview
await p.waitForSelector('[data-testid="tweetButton"]:not([aria-disabled="true"])');
await p.click('[data-testid="tweetButton"]');
```

Then **verify it actually went out**: load `https://x.com/persingerscott` and confirm the
post is at the top with the card attached. A composer that silently failed looks exactly
like one that worked, and with nobody watching the run, this check is the only thing that
tells the two apart. Mind the pinned post — the newest one may be second.

Then report back: the text you sent, the status URL, and a screenshot. That's a record of
what went out in Scott's name, not a request for a verdict — the post is already live.

If it posted, append one line to `posted.jsonl`:

```json
{"slug":"...","posted_at":"2026-09-22T02:40:00Z","url":"https://x.com/persingerscott/status/...","text":"..."}
```

## Still not your call

Posting about a skill is delegated. Nothing else is. Ask first before deleting or editing an
existing post, replying as Scott to someone else, following, liking, or DMing.

Those stay gated for a reason the new autonomy doesn't touch: a fresh post is yours to get
right and easy to answer for, while the rest either alters a record Scott already stands
behind or pulls a specific stranger into a conversation on his behalf.
