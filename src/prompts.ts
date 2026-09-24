/**
 * Personal agent prompts: a curated list of prompts for a personal AI assistant, grouped by
 * the job they do. Unlike skills, these are not indexed from repositories — each one is an
 * entry written here by hand, and each links out to wherever it actually came from.
 *
 * Only ever a short snippet. A prompt belongs to whoever wrote it, so an entry carries
 * enough to tell whether it is worth following the link, and no more. Anything longer than
 * `SNIPPET_MAX` is a copy, not a snippet, and the test enforces that.
 */

/** Longest snippet an entry may carry, in characters. */
export const SNIPPET_MAX = 240;

export interface PromptGroup {
  key: string;
  name: string;
  blurb: string;
}

export interface Prompt {
  /** Stable id, used as the anchor on the listing page. */
  id: string;
  title: string;
  group: string;
  /** What the prompt is for, in our words. */
  summary: string;
  /** A short quote or paraphrase, never the whole prompt. */
  snippet: string;
  /** Who wrote it, as they would want to be credited. */
  author: string;
  /** Where the full prompt lives. */
  url: string;
  /** The collection it belongs to, when it came from one. */
  source?: string;
}

export interface PromptCollection {
  name: string;
  author: string;
  url: string;
  /** Roughly how many prompts it holds, when the collection says so. */
  count?: number;
  description: string;
}

export const PROMPT_GROUPS: PromptGroup[] = [
  { key: "chief-of-staff", name: "Chief of staff", blurb: "Running your week: triage, follow-ups, and the things you said you would do." },
  { key: "writing", name: "Writing and email", blurb: "Drafting in your voice, and cutting what doesn't need saying." },
  { key: "research", name: "Research and reading", blurb: "Going and finding out, then reporting back short." },
  { key: "meetings", name: "Meetings", blurb: "Before, during and after: prep, notes, and what was actually decided." },
  { key: "planning", name: "Planning and decisions", blurb: "Thinking a thing through before committing to it." },
];

/**
 * Collections worth knowing about, linked rather than copied. A collection is listed here
 * when it is a real, maintained set someone can browse for themselves.
 */
export const PROMPT_COLLECTIONS: PromptCollection[] = [
  {
    name: "Muse at Work",
    author: "Chris Abraham",
    url: "https://museatwork.app/",
    count: 500,
    description:
      "Copy-paste workflows that put a personal agent to work across sales, marketing, ops, finance, customer success, hiring and product. Each one is submitted by someone who does that job. Free to browse; an account lifts the limit.",
  },
];

export const PROMPTS: Prompt[] = [
  {
    id: "weekly-triage",
    title: "Weekly triage",
    group: "chief-of-staff",
    summary: "Turns an inbox and a calendar into the five things that actually need you this week.",
    snippet:
      "Read my last week of mail and my calendar for the next one. List the five things only I can do, the ones someone else should own, and anything I have silently dropped. Rank by what breaks if it slips.",
    author: "Skills Explorer",
    url: "/prompts#weekly-triage",
  },
  {
    id: "outreach-follow-up",
    title: "Outreach follow-up",
    group: "chief-of-staff",
    summary: "Chases the threads that went quiet, without sending the same nudge to everyone.",
    snippet: "One of eleven hand-picked workflows the collection opens with, under Sales.",
    author: "Chris Abraham",
    url: "https://museatwork.app/",
    source: "Muse at Work",
  },
  {
    id: "campaign-brief",
    title: "Campaign brief",
    group: "planning",
    summary: "Turns a rough marketing idea into a brief someone else could run with.",
    snippet: "One of eleven hand-picked workflows the collection opens with, under Marketing.",
    author: "Chris Abraham",
    url: "https://museatwork.app/",
    source: "Muse at Work",
  },
  {
    id: "vendor-onboarding",
    title: "Vendor onboarding",
    group: "chief-of-staff",
    summary: "Walks a new vendor from first contact to paperwork done, without losing a step.",
    snippet: "One of eleven hand-picked workflows the collection opens with, under Ops.",
    author: "Chris Abraham",
    url: "https://museatwork.app/",
    source: "Muse at Work",
  },
  {
    id: "reply-in-my-voice",
    title: "Reply in my voice",
    group: "writing",
    summary: "Drafts a reply that sounds like you, from how you have written before.",
    snippet:
      "Here are twenty emails I have written. Draft a reply to the message below in that voice: the same sentence length, the same directness, the same amount of hedging. Do not add warmth I would not have added.",
    author: "Skills Explorer",
    url: "/prompts#reply-in-my-voice",
  },
  {
    id: "cut-it-down",
    title: "Cut it down",
    group: "writing",
    summary: "Halves a draft without losing anything the reader needed.",
    snippet:
      "Cut this to half its length. Keep every fact and every decision. Remove throat-clearing, restatement, and any sentence that only signals effort. Show me what you removed so I can put back what I miss.",
    author: "Skills Explorer",
    url: "/prompts#cut-it-down",
  },
  {
    id: "brief-me",
    title: "Brief me before a call",
    group: "meetings",
    summary: "Ten lines on who you are about to talk to and what happened last time.",
    snippet:
      "I am meeting this person in an hour. Give me ten lines: who they are, what we last agreed, anything I promised and have not delivered, and the one question they are most likely to open with.",
    author: "Skills Explorer",
    url: "/prompts#brief-me",
  },
  {
    id: "what-was-decided",
    title: "What was decided",
    group: "meetings",
    summary: "Separates the decisions from the discussion in a set of notes.",
    snippet:
      "From these notes, list only what was decided, who owns it, and by when. Put anything that sounded like a decision but has no owner in a second list called Unresolved.",
    author: "Skills Explorer",
    url: "/prompts#what-was-decided",
  },
  {
    id: "read-this-for-me",
    title: "Read this for me",
    group: "research",
    summary: "A long document, reduced to what changes your mind.",
    snippet:
      "Read this and tell me what in it would change a decision I am about to make. Skip the summary. If nothing in it would change anything, say so in one line.",
    author: "Skills Explorer",
    url: "/prompts#read-this-for-me",
  },
  {
    id: "steelman-then-decide",
    title: "Steelman, then decide",
    group: "planning",
    summary: "Argues both sides properly before recommending one.",
    snippet:
      "Make the strongest case for each option, including the one I clearly favour — especially its weakest point. Then tell me which you would pick and what would have to be true for you to be wrong.",
    author: "Skills Explorer",
    url: "/prompts#steelman-then-decide",
  },
];

export const promptsInGroup = (key: string): Prompt[] => PROMPTS.filter((p) => p.group === key);

/** Groups that actually have prompts, in the order declared above. */
export const populatedGroups = (): PromptGroup[] => PROMPT_GROUPS.filter((g) => promptsInGroup(g.key).length > 0);
