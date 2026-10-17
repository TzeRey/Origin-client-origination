/*
 * Outreach dossier: streams progress from the local research agent (/api/outreach) and renders the result as one card.
 * Everything that originates from the web is HTML-escaped and links are limited to http(s).
 */
(() => {
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (value) => {
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  };
  const link = (url, label) => {
    const safe = safeUrl(url);
    return safe ? `<a href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : `<span>${esc(label)}</span>`;
  };
  const chip = (text, tone = "") => `<span class="d-chip${tone ? ` d-${tone}` : ""}">${esc(text)}</span>`;

  async function health() {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }

  async function run(subject, { signal, onEvent }) {
    const res = await fetch("/api/outreach", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "origin-app" },
      body: JSON.stringify(subject),
      signal
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `The research service returned ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) onEvent(JSON.parse(line));
      }
    }
    if (buffer.trim()) onEvent(JSON.parse(buffer));
  }

  /* ------------------------------------------------------------ progress */
  const STATUS_LABEL = { running: "Running", done: "Done", skipped: "Skipped", error: "Failed" };

  function progressHTML(steps, prospect, toolHealth) {
    const list = [...steps.values()].map((s) => `
      <li class="d-step is-${esc(s.status)}">
        <span class="d-step-ico" aria-hidden="true"></span>
        <span class="d-step-main"><span class="d-step-label">${esc(s.label)}</span>${s.detail ? `<small>${esc(s.detail)}</small>` : ""}</span>
        <span class="d-step-state">${esc(STATUS_LABEL[s.status] || s.status)}</span>
      </li>`).join("");
    const demo = toolHealth?.mock ? chip("Demo mode: synthetic data", "warn") : "";
    return `
      <header class="d-head">
        <div><span class="d-kicker">Outreach agent</span><h3>Researching ${esc(prospect.name)}</h3></div>
        <span class="d-live"><i></i>Working…</span>
      </header>
      <p class="d-lede">Public, professional sources only. Results appear below as one dossier. ${demo}</p>
      <ol class="d-steps">${list || '<li class="d-step is-running"><span class="d-step-ico"></span><span class="d-step-main"><span class="d-step-label">Starting agents…</span></span></li>'}</ol>`;
  }

  /* ------------------------------------------------------------ dossier sections */
  const RISK = {
    clear: ["Clear", "No sanctions or PEP candidates at or above the review threshold and no adverse findings tied to this person."],
    review: ["Compliance review needed", "A potential sanctions/PEP match, name ambiguity or adverse media needs human review before outreach."],
    hold: ["Compliance hold", "A strong sanctions candidate was found. Do not initiate contact until compliance has reviewed."],
    unscreened: ["Not screened", "Sanctions and PEP screening did not run. Do not treat this prospect as cleared."]
  };

  function section(icon, title, count, body, open = true) {
    return `<details class="d-section"${open ? " open" : ""}><summary><span class="d-ico" aria-hidden="true">${icon}</span><span class="d-title">${esc(title)}</span>${count !== undefined && count !== null ? `<span class="d-count">${esc(count)}</span>` : ""}</summary><div class="d-body">${body}</div></details>`;
  }

  function findingItem(f) {
    const meta = [f.type, f.date].filter(Boolean).map(esc).join(" · ");
    return `<li class="d-item">
      <div class="d-item-top">${link(f.url, f.title)}${chip(f.matchConfidence, f.matchConfidence)}${f.url && !f.grounded ? chip("unverified link", "warn") : ""}</div>
      <p>${esc(f.summary)}</p>
      ${meta ? `<small>${meta}</small>` : ""}
    </li>`;
  }

  function findingsBlock(group, emptyText) {
    const findings = group?.findings || [];
    const unverified = group?.unverified || [];
    const main = findings.length ? `<ul class="d-list">${findings.map(findingItem).join("")}</ul>` : `<p class="d-empty">${esc(emptyText)}</p>`;
    const extra = unverified.length
      ? `<details class="d-sub"><summary>${unverified.length} low-confidence possible match${unverified.length === 1 ? "" : "es"} (likely a different person)</summary><ul class="d-list">${unverified.map(findingItem).join("")}</ul></details>`
      : "";
    const notes = group?.notes ? `<p class="d-note">${esc(group.notes)}</p>` : "";
    return main + extra + notes;
  }

  function sanctionsBlock(s) {
    if (!s) return '<p class="d-empty">Sanctions and PEP screening did not run (OPENSANCTIONS_API_KEY not configured or the call failed).</p>';
    const rows = s.results.map((r) => {
      const tags = [r.isSanction ? chip("Sanctions", "bad") : "", r.isPep ? chip("PEP / relative", "warn") : "", ...r.topics.filter((t) => !/^(sanction|role\.pep|role\.rca)/.test(t)).slice(0, 3).map((t) => chip(t))].join("");
      return `<li class="d-item">
        <div class="d-item-top">${link(r.url, r.name)}${chip(`${Math.round(r.score * 100)}% match`, r.score >= 0.85 ? "bad" : "warn")}${tags}</div>
        <p>${esc([r.positions.join(", "), r.countries.join(", ").toUpperCase(), r.birthDate.join(", ")].filter(Boolean).join(" · ") || "No further details")}</p>
        <small>${esc(r.datasets.slice(0, 4).join(", "))}</small>
      </li>`;
    }).join("");
    return `${rows ? `<ul class="d-list">${rows}</ul>` : '<p class="d-empty">No potential matches at or above 60%.</p>'}<p class="d-note">${esc(s.note)}</p>`;
  }

  function patentsBlock(p) {
    if (!p) return '<p class="d-empty">Patent search did not run (USPTO_API_KEY not configured or the call failed).</p>';
    const tone = { high: "good", medium: "warn", low: "", none: "" }[p.retention.level] || "";
    const rows = p.patents.map((x) => `<li class="d-item">
      <div class="d-item-top">${link(x.url, x.title)}${x.employerAssigned ? chip("Assigned to employer", "good") : chip("Other assignee")}${x.domainRelevant ? chip("Relevant field") : ""}</div>
      <p>${esc([x.status, x.filingDate ? `filed ${x.filingDate}` : "", x.grantDate ? `granted ${x.grantDate}` : "", x.applicants.join(", ")].filter(Boolean).join(" · "))}</p>
      <small>${esc([x.patentNumber ? `US ${x.patentNumber}` : x.applicationNumber, ...x.cpc].filter(Boolean).join(" · "))}</small>
    </li>`).join("");
    return `
      <div class="d-stats"><div><strong>${p.total}</strong><span>filings</span></div><div><strong>${p.employerAssigned}</strong><span>employer-assigned</span></div><div><strong>${p.domainRelevant}</strong><span>in employer's field</span></div></div>
      <p class="d-retention"><b>Retention &amp; equity signal:</b> ${chip(p.retention.level, tone)} ${esc(p.retention.rationale)}</p>
      ${rows ? `<ul class="d-list">${rows}</ul>` : ""}
      <p class="d-note">${esc(p.note)}</p>`;
  }

  function courtsBlock(d) {
    const cases = d.courts?.cases || [];
    const caseRows = cases.map((c) => `<li class="d-item"><div class="d-item-top">${link(c.url, c.caseName)}${chip(c.role)}</div><p>${esc([c.court, c.dateFiled, c.docketNumber].filter(Boolean).join(" · "))}</p></li>`).join("");
    const courtPart = d.courts
      ? (caseRows ? `<ul class="d-list">${caseRows}</ul>` : '<p class="d-empty">No federal dockets found naming a party with this name.</p>') + `<p class="d-note">${esc(d.courts.note)}</p>`
      : '<p class="d-empty">Court-record search did not run.</p>';
    return `<h4 class="d-h4">Public court records (CourtListener)</h4>${courtPart}<h4 class="d-h4">Legal, regulatory &amp; adverse media (web)</h4>${findingsBlock(d.mediaLegal, "No litigation, regulatory or adverse-media mentions were tied to this person.")}`;
  }

  function researchBlock(d) {
    const p = d.publications;
    const code = d.code;
    let html = "";
    if (p?.author) {
      html += `<h4 class="d-h4">Publications (OpenAlex)</h4><p class="d-line">${link(p.author.url, p.author.name)} ${chip(p.author.verified ? "affiliation matches employer" : "name match only", p.author.verified ? "good" : "warn")} <small>${esc(`${p.author.works ?? "?"} works · ${p.author.citations ?? "?"} citations`)}</small></p>`;
      html += p.works.length ? `<ul class="d-list compact">${p.works.map((w) => `<li class="d-item"><div class="d-item-top">${link(w.url, w.title)}</div><small>${esc(`${w.year ?? ""} · ${w.citations ?? 0} citations`)}</small></li>`).join("")}</ul>` : "";
      html += `<p class="d-note">${esc(p.note || "")}</p>`;
    } else {
      html += '<h4 class="d-h4">Publications (OpenAlex)</h4><p class="d-empty">No matching author profile.</p>';
    }
    html += '<h4 class="d-h4">Public developer profile (GitHub)</h4>';
    html += code?.profiles?.length
      ? `<ul class="d-list compact">${code.profiles.map((g) => `<li class="d-item"><div class="d-item-top">${link(g.url, `@${g.login}`)}${chip(g.employerHit ? "employer matches" : "name match only", g.employerHit ? "good" : "warn")}</div><p>${esc([g.company, g.bio].filter(Boolean).join(" · "))}</p><small>${esc(`${g.followers ?? 0} followers · ${g.repos ?? 0} repos`)}</small></li>`).join("")}</ul>`
      : '<p class="d-empty">No public profile with a matching full name.</p>';
    return html;
  }

  function outreachBlock(o) {
    if (!o) return '<p class="d-empty">The synthesis agent did not run, so no outreach plan was produced.</p>';
    const list = (items, cls = "") => (items?.length ? `<ul class="d-bullets ${cls}">${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "");
    return `
      <p class="d-angle">${esc(o.angle)}</p>
      <div class="d-cols">
        <div><h4 class="d-h4">Conversation starters</h4>${list(o.conversationStarters)}</div>
        <div><h4 class="d-h4">Channel &amp; timing</h4><p class="d-line">${esc(o.channel)}</p><p class="d-line">${esc(o.timing)}</p></div>
      </div>
      ${o.avoid?.length ? `<h4 class="d-h4">Avoid</h4>${list(o.avoid, "avoid")}` : ""}`;
  }

  function renderDossier(d, toolHealth) {
    const [riskTitle, riskText] = RISK[d.complianceRisk] || RISK.unscreened;
    const live = d.meta.mode === "live";
    const writing = d.writing?.findings?.length || 0;
    const social = d.social?.findings?.length || 0;
    const video = d.video?.findings?.length || 0;
    const press = d.press?.findings?.length || 0;
    const podcasts = d.podcasts?.findings?.length || 0;
    const wealth = d.wealth?.findings?.length || 0;
    const legalCount = (d.courts?.total || 0) + (d.mediaLegal?.findings?.length || 0);
    const sanctionCount = d.sanctions ? d.sanctions.results.length : "–";
    const sources = d.sources.length
      ? `<ul class="d-sources">${d.sources.map((s) => `<li>${link(s.url, s.title)}</li>`).join("")}</ul>`
      : '<p class="d-empty">No sources were retrieved.</p>';
    return `
      <header class="d-head">
        <div><span class="d-kicker">Outreach dossier</span><h3>${esc(d.subject.name)}</h3><p class="d-sub-line">${esc(d.subject.title)} · ${esc(d.subject.company)}</p></div>
        <div class="d-head-actions">
          ${chip(live ? "Live research" : "Demo data", live ? "good" : "warn")}
          <button type="button" class="d-btn d-btn-cta" data-dossier="converse"${d.complianceRisk === "hold" ? ' disabled title="Compliance hold: no outreach until compliance has reviewed this dossier"' : ''}>Start a conversation <span aria-hidden="true">&rarr;</span></button>
          <button type="button" class="d-btn d-btn-primary" data-dossier="pdf">Download dossier (PDF)</button>
          <button type="button" class="d-btn" data-dossier="copy">Copy brief</button>
          <button type="button" class="d-btn" data-dossier="download">Download JSON</button>
        </div>
      </header>
      <div class="d-risk d-risk-${esc(d.complianceRisk)}" role="status"><strong>${esc(riskTitle)}</strong><span>${esc(riskText)}</span></div>
      <p class="d-summary">${esc(d.summary)}</p>
      ${d.careerHighlights?.length ? `<ul class="d-bullets">${d.careerHighlights.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>` : ""}
      ${section("◎", "Sanctions & PEP screening (OpenSanctions)", sanctionCount, sanctionsBlock(d.sanctions))}
      ${section("⚖", "Litigation, court records & adverse media", legalCount, courtsBlock(d))}
      ${d.patents ? section("✦", "Patents (USPTO) & retention signal", d.patents ? d.patents.total : "–", patentsBlock(d.patents)) : ""}
      ${section("☰", "Professional profile (LinkedIn as publicly indexed)", d.profile?.findings?.length || 0, (d.profileSummary ? `<p class="d-line">${esc(d.profileSummary)}</p>` : "") + findingsBlock(d.profile, "No public professional profile was tied to this person."))}
      ${section("\u25A4", "News & press coverage", press, findingsBlock(d.press, "No newspaper, magazine or trade-press coverage was tied to this person."))}
      ${section("✎", "Public writing, blogs & interviews", writing, findingsBlock(d.writing, "No public writing was tied to this person."))}
      ${section("\u266B", "Podcasts & audio interviews", podcasts, findingsBlock(d.podcasts, "No podcast appearances were tied to this person."))}
      ${section("◈", "Social profiles & public posts", social, findingsBlock(d.social, "No public professional social profiles were tied to this person."))}
      ${section("▶", "Video essays, talks & YouTube", video, findingsBlock(d.video, "No public videos or talks were tied to this person."))}
      ${section("⌘", "Research & developer footprint", "", researchBlock(d), false)}
      ${section("◐", "Business interests, boards & philanthropy", wealth, findingsBlock(d.wealth, "No public business, board or philanthropy signals were tied to this person."))}
      ${section("↗", "Outreach plan", "", outreachBlock(d.outreach))}
      ${d.gaps?.length ? section("!", "Data gaps & caveats", d.gaps.length, `<ul class="d-bullets">${d.gaps.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>`, false) : ""}
      ${section("☷", "Sources", d.sources.length, sources, false)}
      <footer class="d-foot">
        <p>${esc(d.meta.notice)}</p>
        <small>${esc(live ? `${d.meta.provider} · ${d.meta.model} · web via ${d.meta.webVia}` : "demo")} · generated ${esc(new Date(d.meta.generatedAt).toLocaleString())} · ${esc(d.meta.elapsedSeconds)}s</small>
      </footer>`;
  }

  function briefText(d) {
    const lines = [
      `OUTREACH BRIEF: ${d.subject.name} (${d.subject.title}, ${d.subject.company})`,
      `Compliance: ${(RISK[d.complianceRisk] || RISK.unscreened)[0]}`,
      "",
      d.summary,
      ""
    ];
    if (d.patents) lines.push(`Patents: ${d.patents.total} filings, ${d.patents.employerAssigned} employer-assigned. Retention signal: ${d.patents.retention.level}.`);
    if (d.outreach) {
      lines.push("", `Angle: ${d.outreach.angle}`, ...d.outreach.conversationStarters.map((c) => `- ${c}`), `Channel: ${d.outreach.channel}`, `Timing: ${d.outreach.timing}`);
    }
    lines.push("", "Sources:", ...d.sources.slice(0, 15).map((s) => `- ${s.url}`), "", d.meta.notice);
    return lines.join("\n");
  }

  function errorHTML(message, prospect) {
    const file = window.location.protocol === "file:";
    const help = file
      ? "This page was opened as a file. Start the local server with <code>npm start</code> and open <code>http://localhost:8787/app.html</code> so the research agent can run."
      : "Check the terminal running the server for details, and confirm your API keys are set in <code>.env</code> (see <code>.env.example</code>).";
    return `
      <header class="d-head"><div><span class="d-kicker">Outreach agent</span><h3>${esc(prospect.name)}</h3></div></header>
      <div class="d-risk d-risk-review" role="alert"><strong>Research could not complete</strong><span>${esc(message)}</span></div>
      <p class="d-lede">${help}</p>`;
  }

  window.Dossier = { esc, health, run, progressHTML, renderDossier, briefText, errorHTML, RISK };
})();
