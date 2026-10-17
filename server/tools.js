"use strict";

/*
 * Structured research tools. Each returns { status: "ok" | "skipped" | "error", detail, data }.
 * They only call fixed, documented API hosts; no user-supplied URLs are ever fetched.
 */
const { splitName, nameCompatible, normalize, truncate, fetchJson } = require("./util");

/* How an employer is recognised in text: its normalised name. */
const employerKeys = (company) => [normalize(company)];
const mentionsEmployer = (text, company) => {
  const haystack = normalize(text);
  return employerKeys(company).some((key) => haystack.includes(key));
};
const skipped = (detail) => ({ status: "skipped", detail, data: null });
const failed = (error) => ({ status: "error", detail: error.message || String(error), data: null });

/* ---------------------------------------------------------------- OpenSanctions (sanctions + PEPs) */
function mapSanctionsResult(result) {
  const props = result.properties || {};
  return {
    id: result.id,
    name: result.caption,
    schema: result.schema,
    score: Number((result.score || 0).toFixed(3)),
    match: Boolean(result.match),
    topics: props.topics || [],
    datasets: result.datasets || [],
    countries: props.country || props.nationality || [],
    birthDate: props.birthDate || [],
    positions: (props.position || []).slice(0, 4),
    url: `https://www.opensanctions.org/entities/${result.id}/`
  };
}

async function screenSanctions(subject, { signal } = {}) {
  const key = process.env.OPENSANCTIONS_API_KEY;
  if (!key) return skipped("OPENSANCTIONS_API_KEY is not set");
  try {
    const { full, first, last, incomplete } = splitName(subject.name);
    const properties = { name: [full], firstName: [first] };
    if (!incomplete) properties.lastName = [last];
    const params = new URLSearchParams({ algorithm: "best", threshold: "0.6", limit: "5" });
    const json = await fetchJson(
      `https://api.opensanctions.org/match/default?${params}`,
      {
        method: "POST",
        headers: { Authorization: `ApiKey ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ queries: { q: { schema: "Person", properties } } })
      },
      { timeoutMs: 30000, signal, retries: 1 }
    );
    const results = (json?.responses?.q?.results || []).map(mapSanctionsResult).filter((r) => r.score >= 0.6);
    const isSanction = (r) => r.topics.some((t) => t === "sanction" || t.startsWith("sanction"));
    const isPep = (r) => r.topics.some((t) => t === "role.pep" || t === "role.rca");
    const strong = results.filter((r) => r.score >= 0.85 && isSanction(r));
    const possible = results.filter((r) => r.score >= 0.7);
    const overall = strong.length ? "hold" : possible.length || (incomplete && results.length) ? "review" : "clear";
    return {
      status: "ok",
      detail: results.length ? `${results.length} candidate match${results.length === 1 ? "" : "es"}` : "no matches",
      data: {
        overall,
        nameIncomplete: incomplete,
        results: results.map((r) => ({ ...r, isSanction: isSanction(r), isPep: isPep(r) })),
        note: incomplete
          ? "Name in the source data is incomplete, so screening is unreliable. Confirm the full legal name before relying on this result."
          : "Name-based matches are not identity confirmations. Review birth date, nationality and positions before acting."
      }
    };
  } catch (error) {
    return failed(error);
  }
}

/* ---------------------------------------------------------------- USPTO Open Data Portal (patents) */
const DOMAIN_TITLE = /(neural|machine learning|deep learning|language model|transformer|inference|training|embedding|generative|reinforcement|retrieval|vector|agent|attention|data ?base|data ?lake|lakehouse|query|spark|distributed|streaming|storage|compute|gpu|accelerat|alignment|safety|privacy|optimi[sz]|model)/i;
const DOMAIN_CPC = /^(G06N|G06F|G06V|G06T|G10L|G06Q|H04L|G16)/i;

const firstDefined = (...values) => values.find((v) => v !== undefined && v !== null && v !== "");
const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

function mapPatent(item, subject) {
  const meta = item.applicationMetaData || item;
  const inventorNames = [
    ...asArray(meta.inventorBag || item.inventorBag).map((i) => (typeof i === "string" ? i : firstDefined(i.inventorNameText, [i.firstName, i.lastName].filter(Boolean).join(" ")))),
    meta.firstInventorName
  ].filter(Boolean);
  const applicantNames = [
    ...asArray(meta.applicantBag || item.applicantBag).map((a) => (typeof a === "string" ? a : firstDefined(a.applicantNameText, a.nameLineOneText, a.organizationName))),
    meta.firstApplicantName,
    ...asArray(item.assignmentBag).flatMap((a) => asArray(a.assigneeBag).map((x) => x.assigneeNameText))
  ].filter(Boolean);
  const cpc = asArray(meta.cpcClassificationBag).map((c) => (typeof c === "string" ? c : firstDefined(c.cpcClassificationText, c.classificationText))).filter(Boolean);
  const title = firstDefined(meta.inventionTitle, item.inventionTitle, "Untitled application");
  const nameListed = inventorNames.some((n) => nameCompatible(subject.name, n));
  const employerAssigned = applicantNames.some((n) => mentionsEmployer(n, subject.company));
  const domainRelevant = DOMAIN_TITLE.test(title) || cpc.some((c) => DOMAIN_CPC.test(c));
  const patentNumber = firstDefined(meta.patentNumber, item.patentNumber);
  return {
    title,
    applicationNumber: firstDefined(item.applicationNumberText, meta.applicationNumberText),
    patentNumber,
    status: firstDefined(meta.applicationStatusDescriptionText, meta.applicationStatus),
    filingDate: firstDefined(meta.filingDate, item.filingDate),
    grantDate: firstDefined(meta.grantDate, item.grantDate),
    applicants: [...new Set(applicantNames)].slice(0, 3),
    inventors: [...new Set(inventorNames)].slice(0, 6),
    cpc: cpc.slice(0, 4),
    nameListed,
    hasInventorData: inventorNames.length > 0,
    employerAssigned,
    domainRelevant,
    url: patentNumber
      ? `https://patents.google.com/patent/US${String(patentNumber).replace(/\D/g, "")}`
      : null
  };
}

async function callUspto(base, key, query, signal) {
  const headers = { "X-API-KEY": key, Accept: "application/json" };
  const getUrl = `${base}?${new URLSearchParams({ q: query, limit: "50", offset: "0" })}`;
  try {
    return await fetchJson(getUrl, { headers }, { timeoutMs: 40000, signal, retries: 1 });
  } catch (error) {
    if (![400, 404, 405, 415].includes(error.status)) throw error;
    return fetchJson(
      base,
      { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ q: query, pagination: { offset: 0, limit: 50 } }) },
      { timeoutMs: 40000, signal, retries: 1 }
    );
  }
}

function assessRetention(patents) {
  const employer = patents.filter((p) => p.employerAssigned);
  const recent = employer.filter((p) => p.filingDate && Date.now() - new Date(p.filingDate).getTime() < 4 * 365.25 * 864e5);
  const relevant = patents.filter((p) => p.domainRelevant);
  let level = "none";
  let rationale = "No patents were found for this name.";
  if (employer.length >= 2 || (employer.length >= 1 && recent.length >= 1)) {
    level = "high";
    rationale = `${employer.length} employer-assigned filing${employer.length === 1 ? "" : "s"} (${recent.length} recent). Named inventors on core IP are typically treated as hard-to-replace contributors, which may mean longer retention and above-band equity. This is a heuristic, not a fact.`;
  } else if (relevant.length) {
    level = "medium";
    rationale = `${relevant.length} filing${relevant.length === 1 ? "" : "s"} in technology areas relevant to the employer, but none assigned to the employer. Possible prior-employer IP or a same-name inventor.`;
  } else if (patents.length) {
    level = "low";
    rationale = "Patents exist under a matching name but do not appear related to the employer's field.";
  }
  return { level, rationale };
}

/* The USPTO integration is OFF unless USPTO_ENABLED=true. It also needs USPTO_API_KEY. */
function usptoEnabled() {
  return process.env.USPTO_ENABLED === "true";
}

async function searchPatents(subject, { signal } = {}) {
  if (!usptoEnabled()) return skipped("USPTO integration is disabled");
  const key = process.env.USPTO_API_KEY;
  if (!key) return skipped("USPTO_API_KEY is not set");
  const base = process.env.USPTO_API_BASE || "https://api.uspto.gov/api/v1/patent/applications/search";
  const quoted = `"${subject.name.replace(/"/g, "")}"`;
  const attempts = [
    `applicationMetaData.inventorBag.inventorNameText:${quoted}`,
    `applicationMetaData.firstInventorName:${quoted}`,
    quoted
  ];
  const errors = [];
  let items = [];
  let usedQuery = null;
  for (const query of attempts) {
    try {
      const json = await callUspto(base, key, query, signal);
      const bag = json.patentFileWrapperDataBag || json.results || json.patents || [];
      if (bag.length) {
        items = bag;
        usedQuery = query;
        break;
      }
      usedQuery = usedQuery || query;
    } catch (error) {
      if (error.status === 401 || error.status === 403) return failed(new Error("USPTO rejected the API key (check USPTO_API_KEY)"));
      errors.push(error.message);
    }
  }
  if (!items.length && errors.length === attempts.length) {
    return failed(new Error(`USPTO search failed for every query form. Last error: ${errors[errors.length - 1]}`));
  }
  const mapped = items.map((item) => mapPatent(item, subject));
  const patents = mapped
    .filter((p) => (p.hasInventorData ? p.nameListed : true))
    .sort((a, b) => Number(b.employerAssigned) - Number(a.employerAssigned) || Number(b.domainRelevant) - Number(a.domainRelevant));
  const shown = patents.slice(0, 12);
  const retention = assessRetention(patents);
  return {
    status: "ok",
    detail: patents.length ? `${patents.length} filing${patents.length === 1 ? "" : "s"} under a matching inventor name` : "no filings found",
    data: {
      total: patents.length,
      employerAssigned: patents.filter((p) => p.employerAssigned).length,
      domainRelevant: patents.filter((p) => p.domainRelevant).length,
      retention,
      patents: shown,
      query: usedQuery,
      note: "Inventor-name matches are not identity confirmations; employer assignment is the strongest corroboration."
    }
  };
}

/* ---------------------------------------------------------------- CourtListener (public court records) */
async function searchCourts(subject, { signal } = {}) {
  try {
    const headers = { Accept: "application/json" };
    if (process.env.COURTLISTENER_TOKEN) headers.Authorization = `Token ${process.env.COURTLISTENER_TOKEN}`;
    const params = new URLSearchParams({ q: `"${subject.name.replace(/"/g, "")}"`, type: "r", page_size: "15" });
    const json = await fetchJson(`https://www.courtlistener.com/api/rest/v4/search/?${params}`, { headers }, { timeoutMs: 30000, signal, retries: 1 });
    const target = normalize(subject.name);
    const cases = [];
    for (const r of json.results || []) {
      const parties = asArray(r.party).map(normalize);
      const attorneys = asArray(r.attorney).map(normalize);
      const caption = normalize(r.caseName || "");
      const partyHit = parties.some((p) => p.includes(target)) || caption.includes(target);
      const attorneyOnly = !partyHit && attorneys.some((a) => a.includes(target));
      if (!partyHit || attorneyOnly) continue;
      cases.push({
        caseName: r.caseName,
        court: r.court,
        dateFiled: r.dateFiled,
        docketNumber: r.docketNumber,
        url: r.docket_absolute_url ? `https://www.courtlistener.com${r.docket_absolute_url}` : r.absolute_url ? `https://www.courtlistener.com${r.absolute_url}` : null,
        role: "named party (by name only)"
      });
    }
    return {
      status: "ok",
      detail: cases.length ? `${cases.length} docket${cases.length === 1 ? "" : "s"} naming a party with this name` : "no dockets found",
      data: { total: cases.length, cases: cases.slice(0, 10), note: "Court matches are by name only. Confirm identity (employer, location, case subject) before relying on them." }
    };
  } catch (error) {
    return failed(error);
  }
}

/* ---------------------------------------------------------------- OpenAlex (publications, no key needed) */
async function searchResearch(subject, { signal } = {}) {
  try {
    const mailto = process.env.OPENALEX_MAILTO ? `&mailto=${encodeURIComponent(process.env.OPENALEX_MAILTO)}` : "";
    const authors = await fetchJson(`https://api.openalex.org/authors?search=${encodeURIComponent(subject.name)}&per-page=5${mailto}`, {}, { timeoutMs: 25000, signal, retries: 1 });
    const candidates = (authors.results || [])
      .filter((a) => nameCompatible(subject.name, a.display_name))
      .map((a) => ({
        id: a.id,
        name: a.display_name,
        works: a.works_count,
        citations: a.cited_by_count,
        institutions: [...asArray(a.last_known_institutions), ...asArray(a.affiliations).map((x) => x.institution)].filter(Boolean).map((i) => i.display_name).slice(0, 4),
        employerHit: mentionsEmployer(JSON.stringify([a.last_known_institutions, a.affiliations]), subject.company)
      }))
      .sort((a, b) => Number(b.employerHit) - Number(a.employerHit) || (b.citations || 0) - (a.citations || 0));
    if (!candidates.length) return { status: "ok", detail: "no matching author profile", data: { author: null, works: [], note: "No OpenAlex author profile matched." } };
    const best = candidates[0];
    const shortId = String(best.id).split("/").pop();
    const works = await fetchJson(`https://api.openalex.org/works?filter=author.id:${shortId}&sort=cited_by_count:desc&per-page=5&select=id,display_name,publication_year,cited_by_count,doi${mailto}`, {}, { timeoutMs: 25000, signal, retries: 1 });
    return {
      status: "ok",
      detail: best.employerHit ? "author profile linked to employer" : "name match only (unverified)",
      data: {
        author: { ...best, url: best.id, verified: best.employerHit },
        works: (works.results || []).map((w) => ({ title: w.display_name, year: w.publication_year, citations: w.cited_by_count, url: w.doi || w.id })),
        otherCandidates: candidates.length - 1,
        note: best.employerHit ? "Affiliation matches the employer." : "No affiliation match with the employer: could be a different person with the same name."
      }
    };
  } catch (error) {
    return failed(error);
  }
}

/* ---------------------------------------------------------------- GitHub (public profile, no key needed) */
async function searchCode(subject, { signal } = {}) {
  try {
    const headers = { Accept: "application/vnd.github+json", "User-Agent": "origin-outreach-agent" };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const found = await fetchJson(`https://api.github.com/search/users?q=${encodeURIComponent(`fullname:"${subject.name}"`)}&per_page=3`, { headers }, { timeoutMs: 20000, signal });
    const profiles = [];
    for (const item of (found.items || []).slice(0, 3)) {
      const user = await fetchJson(`https://api.github.com/users/${encodeURIComponent(item.login)}`, { headers }, { timeoutMs: 20000, signal });
      if (!nameCompatible(subject.name, user.name || "")) continue;
      profiles.push({
        login: user.login,
        name: user.name,
        url: user.html_url,
        company: user.company,
        bio: truncate(user.bio || "", 240),
        blog: user.blog || null,
        followers: user.followers,
        repos: user.public_repos,
        employerHit: mentionsEmployer(`${user.company || ""} ${user.bio || ""}`, subject.company)
      });
    }
    profiles.sort((a, b) => Number(b.employerHit) - Number(a.employerHit));
    return {
      status: "ok",
      detail: profiles.length ? `${profiles.length} public profile${profiles.length === 1 ? "" : "s"}` : "no public profile found",
      data: { profiles, note: "Only profiles whose full name matches are listed. A matching employer in the profile is the strongest corroboration." }
    };
  } catch (error) {
    return failed(error);
  }
}

/* ---------------------------------------------------------------- Firecrawl (optional deep web scraping) */
function firecrawlConfigured() {
  return Boolean(process.env.FIRECRAWL_API_KEY);
}

async function firecrawlSearch(query, { limit = 4, signal } = {}) {
  const json = await fetchJson(
    "https://api.firecrawl.dev/v2/search",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit, scrapeOptions: { formats: [{ type: "markdown" }], onlyMainContent: true } })
    },
    { timeoutMs: 90000, signal, retries: 1 }
  );
  return (json?.data?.web || []).map((r) => ({
    title: r.title || r.metadata?.title || "",
    url: r.url || r.metadata?.sourceURL || "",
    description: truncate(r.description || "", 300),
    content: truncate(r.markdown || "", 3200)
  })).filter((r) => r.url);
}

module.exports = {
  employerKeys,
  mentionsEmployer,
  screenSanctions,
  searchPatents,
  usptoEnabled,
  searchCourts,
  searchResearch,
  searchCode,
  firecrawlConfigured,
  firecrawlSearch,
  mapPatent,
  assessRetention
};
