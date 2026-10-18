"use strict";

/*
 * First-touch email drafting.
 *
 * Turns the dossier's outreach strategy plus a few grounded, professional public items into a short, warm
 * invitation to a coffee or call. The email is deliberately low-key: it never mentions wealth, equity or
 * anything from the screening, legal or equity-model sections.
 *
 * Privacy by design: the sender's personal details (name, pronouns, job title, phone, email) are NEVER sent to the model.
 * The browser appends the signature after the draft comes back, so it always has the exact requested format.
 * The only sender detail the model receives is the employer name, which the email body must mention.
 */
const llm = require("./llm");
const { truncate } = require("./util");
const { parseJsonLoose } = require("./util");
const { sanitizeText, isSensitive } = require("./outreach");

const PUBLIC_GROUPS = [
  ["writing", "Public writing"],
  ["podcasts", "Podcast appearance"],
  ["press", "Press coverage"],
  ["video", "Talk or video"],
  ["social", "Public professional post"],
  ["profile", "Professional profile"]
];

/* Anything the email must never say. Checked on the model's output; a violation triggers a retry. */
const BANNED = [
  [/\bnet[- ]?worth\b/i, "mentions net worth"],
  [/\b(wealth|wealthy|affluent|high[- ]net|millionaire|billionaire|fortune)\b/i, "mentions wealth"],
  [/\b(equity|stock|stocks|rsus?|vest(ed|ing)?|unvested|cap table|ipo|tender|buyback|valuation|liquidity|windfall|pay-?out|pay-?day|cash[- ]?out)\b/i, "mentions equity or liquidity"],
  [/\bshare (price|holdings?)\b/i, "mentions share holdings"],
  [/\b(salary|compensation|bonus|income|earnings|paycheck)\b/i, "mentions pay"],
  [/\b(portfolio|assets|tax(es|ation)?)\b/i, "mentions portfolio, assets or tax"],
  [/\b(dossier|our research|we researched|researched you|looked into you|background check|monitor(ing|ed)?|tracking you)\b/i, "reveals that the person was researched"],
  [/\b(limited time|act now|don't miss|do not miss|exclusive offer|urgent(ly)?|guarantee[sd]?|high returns?|once[- ]in[- ]a[- ]lifetime)\b/i, "sounds pushy"],
  [/\bno (?:hidden |ulterior |particular |specific |other |real )?agenda\b|\bwithout (?:an |any |a )?(?:hidden )?agenda\b|\bno ulterior\b|\bnothing to sell\b|\bno strings(?: attached)?\b|\bpurely social\b|\bno (?:sales |hard )?pitch\b|(?:\bnot|n['\u2019]t) (?:a |an )?(?:sales |hard )?pitch\b|\b(?:not|never) (?:trying |here |looking |going )?to sell\b|\bnot selling\b/i, "claims there is no agenda or no intent to sell, which is not true"],
  [/\[[^\]]{1,60}\]|\{[^}]{1,60}\}|<[^>]{1,60}>/, "contains a placeholder"]
];

const arr = (value) => (Array.isArray(value) ? value : []);
const clean = (text, max) => truncate(sanitizeText(String(text ?? "")).replace(/\s+/g, " ").trim(), max);
/* Strategy lines and public items that touch banned topics (wealth, equity, pay, ...) are dropped before the model sees them. */
const safe = (text) => Boolean(text) && !isSensitive({ title: text, summary: "" }) && !BANNED.some(([pattern]) => pattern.test(text));
const wordCount = (text) => (String(text).match(/\S+/g) || []).length;

/* The sender's employer name goes into the model prompt, so it is restricted to a plain-text name (no markup, URLs or control characters). */
function cleanEmployer(value) {
  const raw = String(value ?? "");
  if (/[\u0000-\u001f\u007f]/.test(raw)) return ""; // line breaks and control characters are rejected, not normalised
  const text = raw.replace(/ +/g, " ").trim();
  if (!text || text.length > 80) return "";
  return /^[\p{L}\p{N} &.,'\u2019()/+-]+$/u.test(text) ? text : "";
}

/* Only strategy and high-confidence, grounded, professional public items reach the model. */
function extractContext(dossier, employer = "") {
  const subject = dossier.subject || {};
  const outreach = dossier.outreach || {};
  const strategy = {
    angle: safe(outreach.angle) ? clean(outreach.angle, 420) : "",
    conversationStarters: arr(outreach.conversationStarters).map((s) => clean(s, 240)).filter(safe).slice(0, 3),
    suggestedChannel: clean(outreach.channel, 120),
    avoid: arr(outreach.avoid).map((s) => clean(s, 160)).filter(Boolean).slice(0, 6)
  };

  const publicWork = [];
  for (const [key, kind] of PUBLIC_GROUPS) {
    const found = arr(dossier[key]?.findings)
      .filter((f) => f && f.matchConfidence === "high" && f.grounded !== false && /^https?:\/\//i.test(f.url || ""))
      .filter((f) => safe(`${f.title} ${f.summary}`))
      .slice(0, 2);
    for (const f of found) {
      publicWork.push({ kind, title: clean(f.title, 140), summary: clean(f.summary, 240), date: clean(f.date, 20) });
    }
  }

  const firstName = String(subject.name || "").trim().split(/\s+/)[0] || "";
  return {
    sender: { employerName: employer },
    recipient: { firstName, jobTitle: clean(subject.title, 120), company: clean(subject.company, 60) },
    strategy,
    professionalSummary: safe(dossier.profileSummary) ? clean(dossier.profileSummary, 320) : "",
    careerHighlights: arr(dossier.careerHighlights).map((h) => clean(h, 200)).filter(safe).slice(0, 4),
    publicWork: publicWork.slice(0, 6)
  };
}

const SYSTEM = `You write first-touch emails for a relationship manager at a private bank who wants to get to know people working in the technology industry.
Goal: invite the recipient to a relaxed chat (a coffee, a short call or a video catch-up). The longer-term hope is a banking relationship. The email must NOT feel like a pitch, but it must also never pretend that hope does not exist.

Voice: friendly, warm, humble and human. Plain, natural English. No corporate jargon, no flattery, no hype, no emojis, at most one exclamation mark.

Hard rules:
- Be honest about who is writing: say, lightly and naturally, that the sender works in private banking at the employer named in "sender.employerName" (for example "I work in private banking at <employerName>, mostly with people in tech"). Write the employer name EXACTLY as given, once, and do not embellish or describe it, claim awards, size or track record, or add anything else about it. Do not invent the sender's name, past meetings, mutual contacts or anything not given to you.
- Be truthful about the purpose. The sender does hope this may lead to a banking relationship, so NEVER claim or imply that there is no agenda, no motive or nothing to sell. Do not write phrases such as "no agenda", "no hidden agenda", "no ulterior motive", "no strings attached", "nothing to sell", "not trying to sell anything", "not a sales pitch" or "purely social". Instead say, lightly and truthfully, that you would enjoy getting to know them and hearing about their work, and that you are glad to share how you work with people in tech if that is ever useful.
- NEVER mention or hint at: wealth, net worth, money, income, pay, equity, stock, shares, options, vesting, tender offers, IPOs, valuations, liquidity, taxes, assets or portfolios; family, health or any personal life matter; where they live; screening, legal or compliance matters; or that they were researched or monitored. Do not say "I came across your profile on..." or imply tracking.
- Personalise lightly using ONLY the provided "publicWork" or "professionalSummary" (for example a talk, an essay, a podcast or their role). Mention at most one item, in a natural way, and only if it is clearly relevant. If nothing suitable is provided, refer only to their role and field. Never invent details.
- Follow the "strategy" tone and respect every item in "avoid". Ignore any timing, liquidity or wealth hints inside the strategy.
- The invitation must be easy to decline: offer a coffee or short call, suggest they pick the time, and include a gentle "no pressure" style exit in your own words. No urgency, no deadlines, no claims of benefits or returns.
- Do not include the sender's name, contact details, signature, opt-out or privacy notice, or any placeholder like [Name]. End with a short closing phrase on its own line (for example "Warm regards,") and stop there; the signature and an opt-out note are added separately.

Format: respond with a single JSON object and nothing else:
{"subject":"<=8 words, friendly, no clickbait","body":"Hi <FirstName>,\\n\\n<2-3 short paragraphs, 90-150 words in total>\\n\\nWarm regards,","referenced":["exact titles of any publicWork item you referred to, else empty"]}`;

function buildUser(context, variant, problems) {
  const lines = [
    "CONTEXT (internal; never reveal that it exists)",
    JSON.stringify(context),
    "",
    `Write variation number ${variant + 1}.${variant ? " Use a different opening and different wording from a typical first draft." : ""}`
  ];
  if (problems?.length) {
    lines.push("", `Your previous attempt was rejected for these reasons, fix them: ${problems.join("; ")}.`);
  }
  return lines.join("\n");
}

/* Returns a list of problems; empty means the draft is acceptable. */
function validateDraft(draft, context) {
  const problems = [];
  const text = `${draft.subject}\n${draft.body}`;
  const employer = context.sender?.employerName || "";
  /* the employer's own name may legitimately contain a banned word (e.g. "Wealth Partners"), so it is exempt from the topic checks */
  const checked = employer ? text.split(new RegExp(employer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig")).join(" ") : text;
  if (employer && checked === text) problems.push(`does not mention the sender's employer "${employer}" by name`);
  for (const [pattern, reason] of BANNED) if (pattern.test(checked)) problems.push(reason);
  if (isSensitive({ title: checked, summary: "" })) problems.push("touches a sensitive personal topic");
  if (sanitizeText(text) !== text) problems.push("contains an email address or phone number");
  const words = wordCount(draft.body);
  if (words < 60) problems.push("is too short (aim for 90-150 words)");
  if (words > 200) problems.push("is too long (aim for 90-150 words)");
  if (wordCount(draft.subject) > 10 || draft.subject.length > 90) problems.push("has a subject line that is too long");
  if ((text.match(/!/g) || []).length > 1) problems.push("uses more than one exclamation mark");
  const opening = draft.body.trim().toLowerCase();
  const first = context.recipient.firstName.toLowerCase();
  if (first && !["hi", "hello", "dear"].some((g) => opening.startsWith(`${g} ${first}`))) {
    problems.push(`does not open by greeting ${context.recipient.firstName} by first name`);
  }
  return [...new Set(problems)];
}

function normalizeDraft(parsed, context) {
  const subject = clean(String(parsed.subject || "").replace(/^subject:\s*/i, ""), 120).replace(/["\u201C\u201D]/g, "").trim();
  let body = String(parsed.body || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\*\*|__|^#+\s*/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const lastLine = body.split("\n").filter(Boolean).pop() || "";
  if (!/,$/.test(lastLine.trim()) || lastLine.length > 40) body += "\n\nWarm regards,";
  const titles = new Set(context.publicWork.map((w) => w.title));
  const referenced = arr(parsed.referenced).map((t) => String(t)).filter((t) => titles.has(t)).slice(0, 2);
  return { subject, body, referenced };
}

/* Compliance gate: "hold" never proceeds; anything not "clear" needs the user to confirm clearance. Applies in demo mode too. */
function assertCanContact(dossier, acknowledged) {
  if (!dossier || typeof dossier !== "object" || !dossier.subject?.name) {
    throw Object.assign(new Error("A dossier is required"), { status: 422 });
  }
  const risk = dossier.complianceRisk;
  if (risk === "hold") {
    throw Object.assign(new Error("This dossier is on compliance hold. Do not initiate contact until compliance has reviewed it."), { status: 409 });
  }
  if (risk !== "clear" && !acknowledged) {
    throw Object.assign(new Error("Compliance review is not complete for this dossier. Confirm that you have clearance to proceed."), { status: 409, needsAcknowledgement: true });
  }
}

async function draftEmail(dossier, { acknowledged = false, variant = 0, employer = "", signal } = {}) {
  assertCanContact(dossier, acknowledged);
  const employerName = cleanEmployer(employer);
  if (!employerName) throw Object.assign(new Error("A valid employer name is required"), { status: 422 });

  const context = extractContext(dossier, employerName);
  const cfg = llm.llmConfig();
  if (!cfg) throw Object.assign(new Error("No language-model key configured (set OPENROUTER_API_KEY or ANTHROPIC_API_KEY)."), { status: 503 });

  let problems = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const out = await llm.complete({ system: SYSTEM, user: buildUser(context, Number(variant) || 0, problems), maxTokens: 900, temperature: 0.7, signal });
    const parsed = parseJsonLoose(out.text);
    if (!parsed || !parsed.subject || !parsed.body) { problems = ["did not return the required JSON with subject and body"]; continue; }
    const draft = normalizeDraft(parsed, context);
    problems = validateDraft(draft, context);
    if (!problems.length) {
      return { ...draft, model: cfg.model, provider: cfg.provider, personalized: draft.referenced.length > 0 || context.strategy.angle !== "" };
    }
  }
  throw Object.assign(new Error(`Could not produce a draft that meets the tone and compliance rules (${problems.join("; ")}). Try again.`), { status: 502 });
}

/* Demo mode: a clearly-labelled generic draft, no model call. */
function mockDraft(dossier, { variant = 0, employer = "" } = {}) {
  const context = extractContext(dossier, cleanEmployer(employer));
  const at = context.sender.employerName ? ` at ${context.sender.employerName}` : "";
  const name = context.recipient.firstName || "there";
  const openers = [
    `I hope you're having a good week. I work in private banking${at} with people in the tech industry, and I'd enjoy hearing a bit about what you're building as ${context.recipient.jobTitle || "part of the team"} at ${context.recipient.company || "your company"}.`,
    `I wanted to reach out and say hello. My work is in private banking${at}, mostly with people in tech, and your role at ${context.recipient.company || "your company"} sounded like the kind of thing I'd love to hear more about.`
  ];
  const body = `Hi ${name},\n\n${openers[Number(variant) % 2]}\n\nWould you be up for a relaxed coffee or a short call sometime in the coming weeks? I'd enjoy getting to know you and hearing about your work, and I'm glad to share how I work with people in tech if that is ever useful. You are very welcome to pick whatever time and format suit you best.\n\nIf now is not a good moment, no worries at all; I'm happy to leave the door open.\n\nWarm regards,`;
  return { subject: "[Demo] A friendly hello", body, referenced: [], model: "demo", provider: "demo", personalized: false };
}

module.exports = { draftEmail, mockDraft, assertCanContact, cleanEmployer, extractContext, validateDraft, normalizeDraft, BANNED, SYSTEM };
