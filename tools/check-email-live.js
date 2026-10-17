/* Manual check (makes real model calls with your .env key; synthetic dossier, no real person).
 * Run: node --env-file=.env tools/check-email-live.js */
const { draftEmail } = require("../server/email");

const dossier = {
  subject: { name: "Priya Raman", company: "Company C", title: "Senior Software Engineer" },
  complianceRisk: "clear",
  profileSummary: "Senior engineer working on query engines and data infrastructure; active in open-source data tooling.",
  careerHighlights: ["Worked on query engine performance", "Open-source contributor to data tooling"],
  writing: { findings: [{ title: "Notes on making query planners explain themselves", summary: "A blog post about making query plans easier to understand for engineers.", url: "https://example.com/blog/query-planners", date: "2025", matchConfidence: "high", grounded: true }] },
  podcasts: { findings: [{ title: "Data Engineering Weekly: scaling SQL engines", summary: "Guest on a podcast discussing performance engineering for SQL engines.", url: "https://example.com/pod/1", date: "2025", matchConfidence: "high", grounded: true }] },
  outreach: {
    angle: "Lead with genuine interest in her query-planner writing; keep it collegial, not salesy. Her likely liquidity event after the next tender makes this a good moment.",
    conversationStarters: ["Ask what drew her to making query plans explainable", "Mention her podcast discussion on SQL performance"],
    channel: "Warm intro or a direct note",
    timing: "Before the next tender offer",
    avoid: ["Do not mention her estimated net worth or equity", "No family or personal topics"]
  }
};

(async () => {
  for (const variant of [0, 1]) {
    const draft = await draftEmail(dossier, { variant, employer: "Harbor & Pine Private Bank" });
    console.log(`\n=== variant ${variant} | ${draft.provider} / ${draft.model} | referenced: ${JSON.stringify(draft.referenced)}`);
    console.log("Subject:", draft.subject, "\n");
    console.log(draft.body);
    console.log(`\n(words: ${draft.body.split(/\s+/).length})`);
  }
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
