"use strict";

/*
 * Demo mode (npm run start:mock). Produces a clearly synthetic dossier so the interface can be previewed without API keys.
 * Nothing here is real information about the selected person; every URL points to example.com.
 */
const { sleep } = require("./util");

const STEPS = [
  ["plan", "Plan research", 250],
  ["sanctions", "OpenSanctions: sanctions & PEP screening", 700],
  ["courts", "CourtListener: public court records", 600],
  ["research", "OpenAlex: publications", 500],
  ["code", "GitHub: public developer profile", 450],
  ["web-profile", "Web agent: Professional profile (LinkedIn as publicly indexed)", 1100],
  ["web-writing", "Web agent: Public writing: blogs, essays, interviews", 900],
  ["web-social", "Web agent: Public social profiles & professional posts", 800],
  ["web-video", "Web agent: Video & talks: YouTube, keynotes, video essays", 900],
  ["web-press", "Web agent: News & press coverage: newspapers, magazines, trade press", 800],
  ["web-podcasts", "Web agent: Podcasts & audio interviews", 700],
  ["web-media_legal", "Web agent: Legal, regulatory & adverse media", 800],
  ["web-wealth", "Web agent: Business interests, boards & philanthropy", 700],
  ["synthesize", "Synthesis agent: summary & outreach plan", 1000],
  ["finalize", "Assemble dossier & apply privacy filters", 400]
];

async function runMock(subject, emit, { signal } = {}) {
  const speed = process.env.OUTREACH_MOCK_FAST === "1" ? 0 : 1;
  const statuses = {};
  for (const [id, label, ms] of STEPS) {
    if (signal?.aborted) throw new Error("Cancelled");
    emit({ type: "step", id, label, status: "running" });
    await sleep(ms * speed);
    statuses[id] = "done";
    emit({ type: "step", id, label, status: "done", detail: id === "plan" ? "demo mode" : "synthetic data" });
  }
  const ex = (slug) => `https://example.com/${slug}`;
  const item = (title, type, summary, slug, confidence = "high") => ({ title, type, summary, url: ex(slug), date: "2025", matchConfidence: confidence, matchReasons: ["Illustrative placeholder"], grounded: true });
  return {
    meta: {
      mode: "mock",
      generatedAt: new Date().toISOString(),
      elapsedSeconds: 9,
      model: "demo",
      provider: "demo",
      webVia: "demo data",
      steps: statuses,
      notice: "DEMO MODE: every item below is synthetic placeholder content. No live lookups were made and nothing here describes the selected person."
    },
    subject: { name: subject.name, company: subject.company, title: subject.title, startDate: subject.startDate || null },
    complianceRisk: "clear",
    summary: `Demo summary for ${subject.name}. In live mode this section is written by Claude from verified web, sanctions and court evidence, and ends with an outreach recommendation.`,
    profileSummary: "Illustrative profile summary. Live mode summarizes publicly indexed career history, education and skills.",
    careerHighlights: ["Illustrative career highlight one", "Illustrative career highlight two", "Illustrative career highlight three"],
    sanctions: {
      overall: "clear",
      nameIncomplete: false,
      results: [],
      note: "Demo: no OpenSanctions call was made. Live mode lists potential sanctions, PEP and watchlist matches with scores for human review."
    },
    patents: null, // USPTO integration is disabled
    courts: { total: 0, cases: [], note: "Demo: no court search was made." },
    publications: { author: { name: subject.name, works: 12, citations: 340, institutions: [subject.company], verified: true, url: ex("author") }, works: [{ title: "Example publication (illustrative)", year: 2023, citations: 41, url: ex("paper-1") }], note: "Demo data." },
    code: { profiles: [{ login: "example-user", name: subject.name, url: ex("github"), company: subject.company, bio: "Illustrative developer bio", blog: null, followers: 120, repos: 18, employerHit: true }], note: "Demo data." },
    profile: { findings: [item("Illustrative professional profile", "profile", "Placeholder for publicly indexed role, location and headline.", "profile")], unverified: [], notes: "" },
    writing: { findings: [item("Illustrative essay", "blog", "Placeholder for a public essay and its themes.", "essay"), item("Illustrative interview", "interview", "Placeholder for a podcast or interview appearance.", "interview", "medium")], unverified: [], notes: "" },
    social: { findings: [item("Illustrative public profile", "social", "Placeholder for a professional social profile and notable public posts.", "social")], unverified: [], notes: "" },
    video: { findings: [item("Illustrative conference talk", "video", "Placeholder for a YouTube talk or video essay summary.", "talk")], unverified: [], notes: "" },
    press: { findings: [item("Illustrative news feature", "news", "Placeholder for a newspaper, magazine or trade-press article that quotes or profiles the person.", "press")], unverified: [], notes: "" },
    podcasts: { findings: [item("Illustrative podcast episode", "podcast", "Placeholder for a podcast guest appearance: show, episode title and topics discussed.", "podcast", "medium")], unverified: [], notes: "" },
    mediaLegal: { findings: [], unverified: [], notes: "Demo: no adverse media or litigation findings." },
    wealth: { findings: [item("Illustrative advisory role", "advisory", "Placeholder for board, advisory, investment or philanthropy signals.", "advisory", "medium")], unverified: [], notes: "" },
    outreach: {
      angle: "Demo outreach angle. Live mode proposes a grounded, professional approach tied to the prospect's public work and likely liquidity timing.",
      conversationStarters: ["Illustrative conversation starter grounded in a public talk", "Illustrative starter about a published essay", "Illustrative starter about a shared interest"],
      channel: "Warm introduction through a mutual professional contact",
      timing: "Demo: align with the liquidity timeline shown on the equity model.",
      avoid: ["Do not reference estimated wealth or equity", "Do not reference private or family matters"]
    },
    gaps: ["Demo mode: no live research was performed."],
    sources: [{ title: "Example source", url: ex("source") }]
  };
}

module.exports = { runMock };
