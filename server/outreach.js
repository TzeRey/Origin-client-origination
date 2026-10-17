"use strict";

/*
 * Outreach research pipeline.
 *   1. Structured tools run in parallel: OpenSanctions, CourtListener, OpenAlex, GitHub (USPTO only if USPTO_ENABLED=true).
 *   2. Eight web-research agents (profile, writing, social, video, press, podcasts, legal/adverse media, business interests) (Claude with live web search, or Firecrawl pages + Claude) gather public, professional information.
 *   3. A synthesis agent writes the executive summary and outreach plan from the verified evidence only.
 *   4. Everything is assembled into one dossier, filtered for sensitive categories and grounded to retrieved URLs.
 *
 * It only runs when the UI's "Initiate outreach" button is pressed.
 */
const tools = require("./tools");
const llm = require("./llm");
const { parseJsonLoose, pool, truncate, normalizeUrl } = require("./util");

/* ------------------------------------------------------------------ privacy guards */
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /\+?\d[\d\s().-]{8,}\d/g;
const SENSITIVE = [
  /\b(home|residential|street) address\b/i,
  /\b(lives|resides|living) (at|on) \d/i,
  /\b(divorc\w+|custody|pregnan\w+|miscarriage)\b/i,
  /\b(diagnos\w+|cancer|chemotherapy|rehab|mental health (condition|diagnosis)|hospitali[sz]ed)\b/i,
  /\b(religio\w+|church|synagogue|mosque|temple) (member|attend\w+|affiliat\w+)\b/i,
  /\b(sexual orientation|is (gay|lesbian|bisexual|transgender))\b/i,
  /\b(immigration status|green card|visa status|asylum)\b/i,
  /\b(voted for|political party|registered (democrat|republican))\b/i,
  /\b(his|her|their) (wife|husband|spouse|partner|son|daughter|kids|children)\b/i,
  /\bmarried to\b/i
];
const sanitizeText = (text) => String(text ?? "").replace(EMAIL, "[email removed]").replace(PHONE, "[phone removed]");
const isSensitive = (item) => SENSITIVE.some((re) => re.test(`${item.title || ""} ${item.summary || ""}`));

/* ------------------------------------------------------------------ research topics */
const quote = (s) => `"${s}"`;
const TOPICS = [
  {
    id: "profile",
    label: "Professional profile (LinkedIn as publicly indexed)",
    task: "Find the person's publicly indexed professional profile: current and past roles, education, location (city level), skills and professional headline. LinkedIn may only be used through what search results publicly show; never attempt to log in or bypass access controls. Also use company pages, conference speaker bios and university pages.",
    queries: (s) => [`${quote(s.name)} ${s.company} ${s.title} LinkedIn`, `${quote(s.name)} ${s.company} biography OR profile OR "speaker bio"`]
  },
  {
    id: "writing",
    label: "Public writing: blogs, essays, interviews",
    task: "Find blog posts, essays, newsletters (Substack, Medium), personal websites, op-eds and written interviews authored by or featuring the person. Podcasts and press coverage are researched separately, so skip them here. Summarize the themes and any publicly stated views on their field.",
    queries: (s) => [`${quote(s.name)} ${s.company} blog OR essay OR newsletter OR substack OR medium`, `${quote(s.name)} ${s.company} "op-ed" OR "Q&A" OR "in conversation"`]
  },
  {
    id: "social",
    label: "Public social profiles & professional posts",
    task: "Find the person's public professional social profiles (X/Twitter, Bluesky, Mastodon, Threads, GitHub, personal site) and summarize notable PUBLIC posts about their work. Skip purely personal or family content.",
    queries: (s) => [`${quote(s.name)} ${s.company} twitter OR x.com OR bluesky OR mastodon OR threads`, `${quote(s.name)} ${s.company} github OR "personal website"`]
  },
  {
    id: "video",
    label: "Video & talks: YouTube, keynotes, video essays",
    task: "Find YouTube videos, conference talks, keynotes, lectures, video essays and podcast video appearances by or featuring the person. Summarize what each covers.",
    queries: (s) => [`${quote(s.name)} ${s.company} youtube talk OR lecture OR keynote OR "video essay"`, `${quote(s.name)} ${s.company} conference talk OR panel`]
  },
  {
    id: "media_legal",
    label: "Legal, regulatory & adverse media",
    task: "Find public lawsuits, court filings, regulatory actions and adverse media (allegations, investigations, controversies) about the person. Routine positive or neutral press coverage is researched separately, so skip it here. Be precise about whether the person is a party, a witness or merely named. Report neutrally; never speculate.",
    queries: (s) => [`${quote(s.name)} ${s.company} lawsuit OR court OR litigation OR complaint OR sanction`, `${quote(s.name)} ${s.company} investigation OR allegations OR controversy OR fined OR settlement`]
  },
  {
    id: "press",
    label: "News & press coverage: newspapers, magazines, trade press",
    task: "Find news articles, magazine features, profiles, wire stories and trade-press coverage that mention the person by name in a professional context: hires and promotions, product launches, quotes given to reporters, company announcements and features about their work. Prefer primary outlets (e.g. Reuters, Bloomberg, WSJ, FT, NYT, The Information, TechCrunch, Wired, Forbes, regional business papers, industry trade press). Use only what is publicly visible; never bypass paywalls or log in. Report who said what and where, with the outlet name and date. If a mention is only a passing name-drop, say so.",
    queries: (s) => [`${quote(s.name)} ${s.company} ${quote("said")} OR ${quote("told")} OR profile OR feature site:reuters.com OR site:bloomberg.com OR site:wsj.com OR site:ft.com OR site:nytimes.com OR site:theinformation.com OR site:techcrunch.com OR site:wired.com`, `${quote(s.name)} ${s.company} ${s.title} newspaper OR magazine OR "trade press" OR announced OR appointed OR hired`]
  },
  {
    id: "podcasts",
    label: "Podcasts & audio interviews",
    task: "Find podcast episodes and audio interviews where the person is a guest or host: show name, episode title, date and what was discussed (topics and stated views on their field). Check podcast directories and show pages (Apple Podcasts, Spotify, Listen Notes, YouTube podcast channels) and transcript pages. Do not transcribe or quote long passages; summarize in one or two sentences.",
    queries: (s) => [`${quote(s.name)} ${s.company} podcast episode guest OR interview OR ${quote("on the show")}`, `${quote(s.name)} ${s.company} site:podcasts.apple.com OR site:open.spotify.com OR site:listennotes.com OR transcript`]
  },
  {
    id: "wealth",
    label: "Business interests, boards & philanthropy",
    task: "Find publicly reported business interests relevant to a private banker: prior startups and exits, angel/venture investments, board or advisory roles, public philanthropy and foundation involvement, and liquidity events. Do not include residential property, family or political giving.",
    queries: (s) => [`${quote(s.name)} ${s.company} founder OR cofounder OR investor OR "angel investor" OR "board member" OR advisor`, `${quote(s.name)} ${s.company} donor OR philanthropy OR foundation OR acquired`]
  }
];

const RESEARCH_SYSTEM = `You are a due-diligence research analyst on a private bank's prospect-research team. You gather PUBLIC, professional information about one named individual.
Rules:
- Report only facts supported by the sources you actually retrieved. Every finding needs a source URL taken from those sources. Never invent URLs, handles, dates, quotes or employers.
- Disambiguate carefully. Common names produce false matches. Attribute a finding to this person only if at least two identifiers agree (employer, role, field, location, bio cross-reference). Otherwise set matchConfidence to "low".
- Do not log in to, scrape behind, or bypass access controls on any site (including LinkedIn). Use only what is publicly visible.
- Exclude sensitive personal categories entirely, even if found: home address, personal phone/email, family members or minors, health, religion, political affiliation or voting, sexual orientation, immigration status, financial account details.
- Stay professional and neutral. No speculation, no gossip.
- Respond with a single JSON object and nothing else.`;

const RESEARCH_SCHEMA = `{"findings":[{"title":"","type":"","summary":"1-2 factual sentences","url":"https://... (one of the retrieved sources)","date":"YYYY or YYYY-MM-DD if known","matchConfidence":"high|medium|low","matchReasons":["why this is the same person"]}],"notes":"ambiguity or gaps"}`;

/* ------------------------------------------------------------------ helpers */
function subjectBlock(s) {
  return [
    `Name: ${s.name}`,
    `Current employer: ${s.company}`,
    `Title: ${s.title}`,
    s.startDate ? `Joined employer: ${s.startDate}` : null,
    s.department ? `Department: ${s.department}` : null,
    "Location: unconfirmed (employer is headquartered in San Francisco)"
  ].filter(Boolean).join("\n");
}

function urlAllowed(url, allowed) {
  const key = normalizeUrl(url);
  if (!key) return false;
  if (allowed.has(key)) return true;
  for (const item of allowed) if (item.startsWith(key) || key.startsWith(item)) return true;
  return false;
}

function cleanFinding(f, grounded) {
  const confidence = ["high", "medium", "low"].includes(f.matchConfidence) ? f.matchConfidence : "low";
  return {
    title: sanitizeText(truncate(f.title || "Untitled", 160)),
    type: sanitizeText(truncate(f.type || "", 60)),
    summary: sanitizeText(truncate(f.summary || "", 420)),
    url: normalizeUrl(f.url) ? String(f.url) : "",
    date: truncate(f.date || "", 20),
    matchConfidence: confidence,
    matchReasons: (Array.isArray(f.matchReasons) ? f.matchReasons : []).slice(0, 3).map((r) => sanitizeText(truncate(r, 140))),
    grounded
  };
}

async function researchTopic(topic, subject, { signal }) {
  if (!llm.llmConfig()) return { status: "skipped", detail: "No language-model key configured", data: null };
  const hints = topic.queries(subject);
  let user;
  let web = null;
  let allowed = new Set();
  let pages = [];

  if (tools.firecrawlConfigured()) {
    const batches = await pool(hints, 2, (q) => tools.firecrawlSearch(q, { limit: 4, signal }).catch(() => []));
    const seen = new Set();
    pages = batches.flat().filter((p) => {
      const key = normalizeUrl(p.url);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 8);
    pages.forEach((p) => allowed.add(normalizeUrl(p.url)));
    if (!pages.length) return { status: "ok", detail: "no pages found", data: { findings: [], unverified: [], notes: "" } };
    const evidence = pages.map((p, i) => `[${i + 1}] ${p.url}\nTitle: ${p.title}\n${p.content || p.description}`).join("\n\n");
    user = `SUBJECT\n${subjectBlock(subject)}\n\nTASK\n${topic.task}\n\nSOURCES (scraped pages; cite only these URLs)\n${evidence}\n\nReturn JSON in exactly this shape (max 6 findings):\n${RESEARCH_SCHEMA}`;
  } else {
    web = { maxResults: 8 };
    user = `SUBJECT\n${subjectBlock(subject)}\n\nTASK\n${topic.task}\n\nSuggested searches:\n${hints.map((h) => `- ${h}`).join("\n")}\n\nSearch the live web, then return JSON in exactly this shape (max 6 findings):\n${RESEARCH_SCHEMA}`;
  }

  const out = await llm.complete({ system: RESEARCH_SYSTEM, user, web, maxTokens: 2400, signal });
  out.citations.forEach((c) => allowed.add(normalizeUrl(c.url)));
  const parsed = parseJsonLoose(out.text) || { findings: [], notes: "The model returned no structured result." };
  const noEvidence = allowed.size === 0;
  const findings = [];
  const unverified = [];
  let dropped = 0;
  for (const raw of (parsed.findings || []).slice(0, 8)) {
    const hasUrl = Boolean(normalizeUrl(raw.url));
    const grounded = hasUrl && urlAllowed(raw.url, allowed);
    if (hasUrl && !grounded && !noEvidence) { dropped += 1; continue; }
    const item = cleanFinding(raw, grounded);
    if (isSensitive(item)) { dropped += 1; continue; }
    (item.matchConfidence === "low" ? unverified : findings).push(item);
  }
  return {
    status: "ok",
    detail: `${findings.length} finding${findings.length === 1 ? "" : "s"}${unverified.length ? `, ${unverified.length} low-confidence` : ""}${dropped ? `, ${dropped} dropped` : ""}`,
    data: { findings, unverified, notes: sanitizeText(truncate(parsed.notes || "", 400)), dropped, sources: out.citations.slice(0, 12), via: tools.firecrawlConfigured() ? "firecrawl+claude" : "claude-web-search" }
  };
}

const compact = (list, n = 6) => (list || []).slice(0, n).map((f) => ({ title: f.title, summary: truncate(f.summary, 200), confidence: f.matchConfidence }));

async function synthesize(subject, evidence, { signal }) {
  const system = `You are a senior private-banking prospect strategist. You write an internal brief for a relationship manager from VERIFIED evidence only.
Rules:
- Use only the evidence provided. If something is not in the evidence, do not state it. Prefer "unknown" over guessing.
- Conversation starters must be grounded in public professional content from the evidence, never in private or sensitive matters.
- Never recommend quoting the prospect's estimated wealth or equity to them; those figures are internal.
- If compliance risk is "hold" or "review", say outreach must wait for compliance review.
- Respond with a single JSON object and nothing else.`;
  const user = `SUBJECT\n${subjectBlock(subject)}\n\nINTERNAL CONTEXT (never repeat to the prospect)\n${JSON.stringify(subject.equity || {})}\n\nEVIDENCE\n${JSON.stringify(evidence)}\n\nReturn JSON exactly in this shape:\n{"executiveSummary":"<=110 words, plain English","profileSummary":"<=80 words","careerHighlights":["max 5, each paraphrasing the evidence"],"outreach":{"angle":"1-2 sentences","conversationStarters":["max 3, grounded in evidence"],"channel":"suggested channel","timing":"timing linked to liquidity events if relevant","avoid":["topics to avoid"]},"dataGaps":["what could not be verified"]}`;
  const out = await llm.complete({ system, user, maxTokens: 2200, signal });
  const parsed = parseJsonLoose(out.text);
  if (!parsed) throw new Error("The synthesis model returned no structured result");
  return parsed;
}

function fallbackSummary(subject, parts) {
  const bits = [`${subject.name} is listed as ${subject.title} at ${subject.company}.`];
  if (parts.patents?.total) bits.push(`${parts.patents.total} patent filing${parts.patents.total === 1 ? "" : "s"} found under a matching inventor name.`);
  bits.push("Automated narrative research was unavailable, so this brief contains structured screening results only.");
  return bits.join(" ");
}

function computeRisk({ sanctions, topics }) {
  if (!sanctions || sanctions.status !== "ok") return "unscreened";
  if (sanctions.data.overall === "hold") return "hold";
  const legalHit = [...(topics.media_legal?.data?.findings || []), ...(topics.press?.data?.findings || [])].some((f) => /lawsuit|court|litigation|sanction|fraud|regulat|indict|settle/i.test(`${f.type} ${f.title} ${f.summary}`) && f.matchConfidence !== "low");
  if (sanctions.data.overall === "review" || legalHit) return "review";
  return "clear";
}

/* Audit logging, retention and deletion live in ./audit.js (re-exported here for existing callers). */
const { auditLog } = require("./audit");

/* ------------------------------------------------------------------ main entry */
async function runOutreach(subject, emit, { signal, ip = "local" } = {}) {
  const started = Date.now();
  const stepStatus = {};
  const step = (id, label, status, detail = "") => {
    stepStatus[id] = status;
    emit({ type: "step", id, label, status, detail });
  };
  const timed = async (id, label, fn) => {
    step(id, label, "running");
    try {
      const out = await fn();
      step(id, label, out.status === "ok" ? "done" : out.status, out.detail || "");
      return out;
    } catch (error) {
      step(id, label, "error", error.message);
      return { status: "error", detail: error.message, data: null };
    }
  };

  step("plan", `Plan research for ${subject.name} (${subject.company})`, "done", "public sources only · professional scope");

  const patentsOn = tools.usptoEnabled();
  const structured = {
    sanctions: timed("sanctions", "OpenSanctions: sanctions & PEP screening", () => tools.screenSanctions(subject, { signal })),
    ...(patentsOn ? { patents: timed("patents", "USPTO Open Data Portal: patent filings", () => tools.searchPatents(subject, { signal })) } : {}),
    courts: timed("courts", "CourtListener: public court records", () => tools.searchCourts(subject, { signal })),
    research: timed("research", "OpenAlex: publications", () => tools.searchResearch(subject, { signal })),
    code: timed("code", "GitHub: public developer profile", () => tools.searchCode(subject, { signal }))
  };

  const topicResults = {};
  const webAgents = pool(TOPICS, 4, async (topic) => {
    topicResults[topic.id] = await timed(`web-${topic.id}`, `Web agent: ${topic.label}`, () => researchTopic(topic, subject, { signal }));
  });

  const settled = Object.fromEntries(await Promise.all(Object.entries(structured).map(async ([key, pending]) => [key, await pending])));
  const { sanctions, courts, research, code } = settled;
  /* With USPTO disabled there is no patents result at all: no step, no dossier section, no data gap. */
  const patents = settled.patents || { status: "disabled", detail: "USPTO integration is disabled", data: null };
  await webAgents;

  const topicData = Object.fromEntries(TOPICS.map((t) => [t.id, topicResults[t.id]?.data || { findings: [], unverified: [], notes: "" }]));
  const risk = computeRisk({ sanctions, topics: topicResults });

  let narrative = null;
  step("synthesize", "Synthesis agent: summary & outreach plan", "running");
  if (llm.llmConfig()) {
    try {
      narrative = await synthesize(subject, {
        complianceRisk: risk,
        sanctions: sanctions.data ? { overall: sanctions.data.overall, matches: sanctions.data.results.slice(0, 3).map((r) => ({ name: r.name, score: r.score, topics: r.topics })) } : "not screened",
        ...(patentsOn ? { patents: patents.data ? { total: patents.data.total, employerAssigned: patents.data.employerAssigned, retention: patents.data.retention } : "not searched" } : {}),
        courts: courts.data ? { total: courts.data.total } : "not searched",
        publications: research.data?.author ? { verified: research.data.author.verified, works: research.data.works.slice(0, 3).map((w) => w.title) } : null,
        code: code.data?.profiles?.slice(0, 1),
        profile: compact(topicData.profile.findings),
        writing: compact(topicData.writing.findings),
        social: compact(topicData.social.findings),
        video: compact(topicData.video.findings),
        press: compact(topicData.press.findings),
        podcasts: compact(topicData.podcasts.findings),
        mediaLegal: compact(topicData.media_legal.findings),
        wealthSignals: compact(topicData.wealth.findings)
      }, { signal });
      step("synthesize", "Synthesis agent: summary & outreach plan", "done");
    } catch (error) {
      step("synthesize", "Synthesis agent: summary & outreach plan", "error", error.message);
    }
  } else {
    step("synthesize", "Synthesis agent: summary & outreach plan", "skipped", "No language-model key configured");
  }

  step("finalize", "Assemble dossier & apply privacy filters", "running");
  const omitted = Object.values(topicData).reduce((sum, t) => sum + (t.dropped || 0), 0);
  const sources = new Map();
  const addSource = (title, url) => {
    const key = normalizeUrl(url);
    if (key && !sources.has(key)) sources.set(key, { title: truncate(title || url, 120), url });
  };
  Object.values(topicData).forEach((t) => [...t.findings, ...t.unverified].forEach((f) => f.url && addSource(f.title, f.url)));
  sanctions.data?.results.forEach((r) => addSource(`OpenSanctions: ${r.name}`, r.url));
  patents.data?.patents.forEach((p) => p.url && addSource(`Patent: ${p.title}`, p.url));
  courts.data?.cases.forEach((c) => c.url && addSource(`Court: ${c.caseName}`, c.url));
  research.data?.works.forEach((w) => w.url && addSource(`Publication: ${w.title}`, w.url));
  code.data?.profiles.forEach((p) => addSource(`GitHub: ${p.login}`, p.url));

  const gaps = [...(narrative?.dataGaps || [])].map((g) => sanitizeText(truncate(g, 200)));
  if (omitted) gaps.push(`${omitted} item${omitted === 1 ? " was" : "s were"} omitted because it could not be tied to a retrieved source or touched a sensitive personal category.`);
  [["sanctions", sanctions], ...(patentsOn ? [["patents", patents]] : []), ["courts", courts], ["research", research], ["code", code]].forEach(([name, r]) => {
    if (r.status !== "ok") gaps.push(`${name}: ${r.detail}`);
  });
  TOPICS.forEach((t) => {
    const r = topicResults[t.id];
    if (r && r.status !== "ok") gaps.push(`${t.label}: ${r.detail}`);
  });

  const dossier = {
    meta: {
      mode: "live",
      generatedAt: new Date().toISOString(),
      elapsedSeconds: Math.round((Date.now() - started) / 1000),
      model: llm.llmConfig()?.model || null,
      provider: llm.llmConfig()?.provider || null,
      webVia: tools.firecrawlConfigured() ? "Firecrawl + Claude" : "Claude web search",
      steps: stepStatus,
      notice: "Compiled from public sources for internal prospect due diligence. Verify before use, honor opt-out requests and comply with applicable privacy law (GDPR, CCPA/CPRA, GLBA) and your firm's policies."
    },
    subject: { name: subject.name, company: subject.company, title: subject.title, startDate: subject.startDate || null },
    complianceRisk: risk,
    summary: sanitizeText(narrative?.executiveSummary || fallbackSummary(subject, { patents: patents.data })),
    profileSummary: sanitizeText(narrative?.profileSummary || ""),
    careerHighlights: (narrative?.careerHighlights || []).slice(0, 5).map((h) => sanitizeText(truncate(h, 220))),
    sanctions: sanctions.data,
    patents: patents.data,
    courts: courts.data,
    publications: research.data,
    code: code.data,
    profile: topicData.profile,
    writing: topicData.writing,
    social: topicData.social,
    video: topicData.video,
    mediaLegal: topicData.media_legal,
    press: topicData.press,
    podcasts: topicData.podcasts,
    wealth: topicData.wealth,
    outreach: narrative?.outreach
      ? {
          angle: sanitizeText(truncate(narrative.outreach.angle || "", 400)),
          conversationStarters: (narrative.outreach.conversationStarters || []).slice(0, 3).map((x) => sanitizeText(truncate(x, 240))),
          channel: sanitizeText(truncate(narrative.outreach.channel || "", 200)),
          timing: sanitizeText(truncate(narrative.outreach.timing || "", 240)),
          avoid: (narrative.outreach.avoid || []).slice(0, 5).map((x) => sanitizeText(truncate(x, 160)))
        }
      : null,
    gaps,
    sources: [...sources.values()].slice(0, 80)
  };
  step("finalize", "Assemble dossier & apply privacy filters", "done", `${dossier.sources.length} sources`);

  auditLog({
    ts: dossier.meta.generatedAt,
    ip,
    subject: `${subject.name} @ ${subject.company}`,
    risk,
    mode: "live",
    steps: stepStatus,
    sources: dossier.sources.length,
    seconds: dossier.meta.elapsedSeconds
  });
  return dossier;
}

module.exports = { runOutreach, TOPICS, sanitizeText, isSensitive, computeRisk, auditLog };
