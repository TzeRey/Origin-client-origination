"use strict";

/* Pipeline tests with every external API stubbed. Run with `npm test`. */
const test = require("node:test");
const assert = require("node:assert/strict");

const SECRETS = {
  OPENROUTER_API_KEY: "FAKE_OPENROUTER_KEY_FOR_TESTS_ONLY",
  OPENSANCTIONS_API_KEY: "FAKE_OPENSANCTIONS_KEY_FOR_TESTS_ONLY",
  USPTO_API_KEY: "FAKE_USPTO_KEY_FOR_TESTS_ONLY"
};
Object.assign(process.env, SECRETS);
process.env.USPTO_ENABLED = "true"; // the USPTO path is off by default; most tests exercise it with a stubbed API
delete process.env.FIRECRAWL_API_KEY;
process.env.OUTREACH_MOCK_FAST = "1";
process.env.OUTREACH_AUDIT_DIR = require("path").join(require("os").tmpdir(), "origin-test-audit");

const { runOutreach, sanitizeText, isSensitive } = require("../server/outreach");
const tools = require("../server/tools");

const SUBJECT = { name: "Jane Roe", company: "Testco", title: "Principal Research Scientist", startDate: "2021-04-01", department: "Engineering/Technical", equity: { structure: "double-trigger" } };

const json = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
let calls = [];

function makeFetch({ sanctionScore = 0.5 } = {}) {
  return async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ host: u.host, path: u.pathname, headers: init.headers || {}, body: init.body });
    if (u.host === "api.opensanctions.org") {
      assert.equal(init.headers.Authorization, `ApiKey ${SECRETS.OPENSANCTIONS_API_KEY}`);
      const body = JSON.parse(init.body);
      assert.equal(body.queries.q.schema, "Person");
      return json({ responses: { q: { results: sanctionScore >= 0.6 ? [{ id: "NK-abc", caption: "Jane ROE", schema: "Person", score: sanctionScore, match: sanctionScore >= 0.7, datasets: ["us_ofac_sdn"], properties: { topics: ["sanction"], country: ["ru"], position: ["Owner"] } }] : [] } } });
    }
    if (u.host === "api.uspto.gov") {
      assert.equal(init.headers["X-API-KEY"], SECRETS.USPTO_API_KEY);
      return json({
        patentFileWrapperDataBag: [
          { applicationNumberText: "18/111,111", applicationMetaData: { inventionTitle: "Neural network training method", filingDate: "2024-02-01", applicationStatusDescriptionText: "Patented Case", patentNumber: "12345678", inventorBag: [{ inventorNameText: "Jane Roe" }], applicantBag: [{ applicantNameText: "Testco OpCo, LLC" }], cpcClassificationBag: ["G06N3/08"] } },
          { applicationNumberText: "15/222,222", applicationMetaData: { inventionTitle: "Garden hose reel", filingDate: "2015-01-01", inventorBag: [{ inventorNameText: "Jane Roe" }], applicantBag: [{ applicantNameText: "Acme Garden Co" }] } },
          { applicationNumberText: "15/333,333", applicationMetaData: { inventionTitle: "Someone else's invention", inventorBag: [{ inventorNameText: "John Smith" }], applicantBag: [{ applicantNameText: "Testco" }] } }
        ]
      });
    }
    if (u.host === "www.courtlistener.com") {
      return json({ results: [
        { caseName: "Roe v. Example Corp", court: "N.D. Cal.", dateFiled: "2020-05-01", docketNumber: "3:20-cv-1", party: ["Jane Roe", "Example Corp"], attorney: [], docket_absolute_url: "/docket/1/roe-v-example/" },
        { caseName: "Other v. Thing", court: "S.D.N.Y.", party: ["Other"], attorney: ["Jane Roe, Attorney"], docket_absolute_url: "/docket/2/other/" }
      ] });
    }
    if (u.host === "api.openalex.org") {
      if (u.pathname === "/authors") return json({ results: [{ id: "https://openalex.org/A123", display_name: "Jane Roe", works_count: 20, cited_by_count: 900, last_known_institutions: [{ display_name: "Testco" }] }] });
      return json({ results: [{ id: "https://openalex.org/W1", display_name: "Scaling things", publication_year: 2023, cited_by_count: 50, doi: "https://doi.org/10.1/abc" }] });
    }
    if (u.host === "api.github.com") {
      if (u.pathname === "/search/users") return json({ items: [{ login: "janeroe" }] });
      return json({ login: "janeroe", name: "Jane Roe", html_url: "https://github.com/janeroe", company: "@testco", bio: "Research", followers: 10, public_repos: 4 });
    }
    if (u.host === "openrouter.ai") {
      assert.equal(init.headers.Authorization, `Bearer ${SECRETS.OPENROUTER_API_KEY}`);
      const body = JSON.parse(init.body);
      const wantsWeb = Array.isArray(body.plugins);
      if (wantsWeb) {
        const URL_OK = "https://youtube.com/watch?v=abc";
        const text = JSON.stringify({
          findings: [
            { title: "Conference talk on scaling", type: "talk", summary: "Spoke about scaling research. Contact jane@example.org or +1 (415) 555-0100.", url: "https://youtube.com/watch?v=abc", date: "2024", matchConfidence: "high", matchReasons: ["Testco affiliation", "same field"] },
            { title: "Invented source", type: "blog", summary: "Hallucinated.", url: "https://made-up.example/never-retrieved", matchConfidence: "high" },
            { title: "Her family trip", type: "post", summary: "Posted about her husband and kids on holiday.", url: "https://youtube.com/watch?v=abc", matchConfidence: "high" },
            { title: "Possible namesake", type: "profile", summary: "A Jane Roe in another field.", url: "https://youtube.com/watch?v=abc", matchConfidence: "low" }
          ],
          notes: "ok"
        });
        return json({ choices: [{ message: { content: text, annotations: [{ type: "url_citation", url_citation: { url: "https://youtube.com/watch?v=abc", title: "Talk", content: "snippet" } }] } }] });
      }
      return json({ choices: [{ message: { content: JSON.stringify({ executiveSummary: "Researcher at Testco with employer-assigned patents.", profileSummary: "Principal scientist.", careerHighlights: ["Talk on scaling"], outreach: { angle: "Lead with her scaling talk.", conversationStarters: ["Ask about the talk"], channel: "Warm intro", timing: "After next tender", avoid: ["Do not quote wealth"] }, dataGaps: ["No LinkedIn page indexed"] }) } }] });
    }
    throw new Error(`Unexpected host in test: ${u.host}`);
  };
}

async function run(options) {
  calls = [];
  const events = [];
  global.fetch = makeFetch(options);
  const dossier = await runOutreach(SUBJECT, (e) => events.push(e), {});
  return { dossier, events };
}

test("assembles one dossier from all tools and grounds web findings", async () => {
  const { dossier, events } = await run({ sanctionScore: 0.2 });
  assert.equal(dossier.meta.mode, "live");
  assert.equal(dossier.complianceRisk, "clear");
  assert.equal(dossier.sanctions.overall, "clear");

  // patents: employer-assigned filing kept; other-inventor filing dropped; unrelated same-name filing kept but flagged
  assert.equal(dossier.patents.total, 2);
  assert.equal(dossier.patents.employerAssigned, 1);
  assert.equal(dossier.patents.retention.level, "high");
  assert.ok(dossier.patents.patents[0].employerAssigned);
  assert.ok(!dossier.patents.patents.some((p) => /Someone else/.test(p.title)));

  // courts: party kept, attorney-only dropped
  assert.equal(dossier.courts.total, 1);
  assert.equal(dossier.courts.cases[0].caseName, "Roe v. Example Corp");

  // publications + code verified by employer affiliation
  assert.equal(dossier.publications.author.verified, true);
  assert.equal(dossier.code.profiles[0].employerHit, true);

  // web findings: hallucinated URL and sensitive family item dropped, low-confidence separated, PII masked
  const video = dossier.video;
  assert.equal(video.findings.length, 1);
  assert.equal(video.findings[0].url, "https://youtube.com/watch?v=abc");
  assert.ok(!/jane@example\.org/.test(video.findings[0].summary));
  assert.match(video.findings[0].summary, /\[email removed\]/);
  assert.match(video.findings[0].summary, /\[phone removed\]/);
  assert.equal(video.unverified.length, 1);
  assert.ok(video.dropped >= 2);
  assert.ok(dossier.gaps.some((g) => /omitted/.test(g)));

  assert.match(dossier.summary, /Testco/);
  assert.equal(dossier.outreach.conversationStarters.length, 1);
  assert.ok(dossier.sources.length > 3);
  assert.ok(events.some((e) => e.id === "finalize" && e.status === "done"));
});

test("media coverage: press and podcasts have their own agents; there is no forum agent", async () => {
  const { dossier, events } = await run({ sanctionScore: 0.2 });
  for (const id of ["web-press", "web-podcasts"]) {
    assert.ok(events.some((e) => e.id === id && e.status === "done"), `${id} step should complete`);
  }
  assert.ok(!events.some((e) => /forum/i.test(`${e.id} ${e.label || ""}`)), "no forum step is emitted");
  assert.equal(dossier.forums, undefined, "the dossier has no forum section");
  const modelRequests = calls.filter((c) => c.host === "openrouter.ai").map((c) => String(c.body)).join(" ");
  assert.ok(!/reddit|hacker news|news\.ycombinator|lesswrong|stack overflow/i.test(modelRequests), "no model request asks for forum content");
  // press and podcasts keep the ordinary rules: high/medium shown, low separated, hallucinated URL dropped
  assert.equal(dossier.press.findings.length, 1);
  assert.equal(dossier.press.unverified.length, 1);
  assert.equal(dossier.podcasts.findings.length, 1);
});

test("USPTO integration is off by default: no request, no step, no patents section, no gap", async () => {
  delete process.env.USPTO_ENABLED;
  try {
    const { dossier, events } = await run({ sanctionScore: 0.2 });
    assert.ok(!calls.some((c) => c.host === "api.uspto.gov"), "USPTO must not be called");
    assert.ok(!events.some((e) => e.id === "patents"), "no patents step should be emitted");
    assert.equal(dossier.patents, null);
    assert.ok(!dossier.gaps.some((g) => /patents|USPTO/i.test(g)));
    assert.equal(dossier.complianceRisk, "clear");
    assert.equal((await tools.searchPatents(SUBJECT, {})).status, "skipped");
  } finally {
    process.env.USPTO_ENABLED = "true";
  }
});

test("a strong sanctions candidate puts the dossier on hold", async () => {
  const { dossier } = await run({ sanctionScore: 0.93 });
  assert.equal(dossier.complianceRisk, "hold");
  assert.equal(dossier.sanctions.results[0].isSanction, true);
});

test("API keys never appear in streamed events or the dossier", async () => {
  const { dossier, events } = await run({ sanctionScore: 0.2 });
  const blob = JSON.stringify({ dossier, events });
  for (const secret of Object.values(SECRETS)) assert.ok(!blob.includes(secret), `leaked ${secret}`);
});

test("tools are skipped, not faked, when keys are missing", async () => {
  const saved = process.env.OPENSANCTIONS_API_KEY;
  delete process.env.OPENSANCTIONS_API_KEY;
  global.fetch = makeFetch();
  const result = await tools.screenSanctions(SUBJECT, {});
  process.env.OPENSANCTIONS_API_KEY = saved;
  assert.equal(result.status, "skipped");
  const { dossier } = await (async () => {
    delete process.env.OPENSANCTIONS_API_KEY;
    const out = await run({});
    process.env.OPENSANCTIONS_API_KEY = saved;
    return out;
  })();
  assert.equal(dossier.complianceRisk, "unscreened");
});

test("incomplete names are flagged for screening", async () => {
  global.fetch = makeFetch({ sanctionScore: 0.65 });
  const result = await tools.screenSanctions({ ...SUBJECT, name: "Mark L" }, {});
  assert.equal(result.data.nameIncomplete, true);
  assert.equal(result.data.overall, "review");
});

test("sanitizers", () => {
  assert.equal(sanitizeText("mail a.b@c.io now"), "mail [email removed] now");
  assert.ok(isSensitive({ title: "x", summary: "She posted about her husband" }));
  assert.ok(!isSensitive({ title: "Talk", summary: "Keynote on distributed systems" }));
});
