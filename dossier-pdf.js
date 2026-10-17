/*
 * Dossier -> PDF. Builds a text PDF in the browser from the dossier data (nothing is uploaded anywhere).
 * Uses jsPDF (MIT, bundled in vendor/, loaded only when the button is pressed, so the CSP "script-src 'self'" still holds).
 * The built-in PDF fonts only cover Latin-1, so text is normalised first (see clean()).
 */
(() => {
  "use strict";

  const LIB_URL = "vendor/jspdf.umd.min.js";
  const PAGE = { w: 612, h: 792 }; // US Letter, points
  const M = 54; // side/top margin
  const BOTTOM = 58; // reserved for the page footer
  const CW = PAGE.w - M * 2;

  const C = {
    ink: [15, 23, 42],
    text: [30, 41, 59],
    muted: [100, 116, 139],
    rule: [203, 213, 225],
    accent: [67, 56, 202],
    link: [37, 99, 235],
    warn: [180, 83, 9],
    bad: [185, 28, 28]
  };
  const RISK_TONE = {
    clear: { bg: [220, 252, 231], bar: [22, 163, 74], text: [20, 83, 45] },
    review: { bg: [254, 243, 199], bar: [217, 119, 6], text: [120, 53, 15] },
    hold: { bg: [254, 226, 226], bar: [220, 38, 38], text: [127, 29, 29] },
    unscreened: { bg: [241, 245, 249], bar: [100, 116, 139], text: [51, 65, 85] }
  };
  const RISK_FALLBACK = {
    clear: ["Clear", "No sanctions or PEP candidates at or above the review threshold and no adverse findings tied to this person."],
    review: ["Compliance review needed", "A potential sanctions/PEP match, name ambiguity or adverse media needs human review before outreach."],
    hold: ["Compliance hold", "A strong sanctions candidate was found. Do not initiate contact until compliance has reviewed."],
    unscreened: ["Not screened", "Sanctions and PEP screening did not run. Do not treat this prospect as cleared."]
  };

  /* ---------------------------------------------------------------- text helpers */
  const SUBSTITUTIONS = {
    "\u2013": "-", "\u2014": "-", "\u2012": "-", "\u2212": "-",
    "\u2018": "'", "\u2019": "'", "\u201A": ",", "\u201C": '"', "\u201D": '"',
    "\u2022": "-", "\u25CF": "-", "\u2026": "...", "\u00A0": " ", "\u2009": " ", "\u202F": " ", "\u200B": "",
    "\u2248": "~", "\u2192": "->", "\u2190": "<-", "\u2191": "^", "\u2197": "",
    "\u2713": "ok", "\u2717": "x", "\u20AC": "EUR ", "\u2122": "(TM)"
  };

  /* Keep Latin-1, map common punctuation, strip diacritics from anything else, otherwise "?". */
  function clean(value) {
    const input = String(value ?? "").replace(/\r\n?/g, "\n");
    let out = "";
    for (const ch of input) {
      const code = ch.codePointAt(0);
      if (ch === "\n" || ch === "\t") out += ch === "\t" ? " " : "\n";
      else if (code >= 0x20 && code <= 0x7e) out += ch;
      else if (code >= 0xa0 && code <= 0xff) out += SUBSTITUTIONS[ch] ?? ch;
      else if (SUBSTITUTIONS[ch] !== undefined) out += SUBSTITUTIONS[ch];
      else {
        const base = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        out += /^[\x20-\x7e\xa0-\xff]+$/.test(base) ? base : "?";
      }
    }
    return out;
  }

  const safeUrl = (value) => {
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  };
  const host = (value) => {
    try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return ""; }
  };
  const list = (value) => (Array.isArray(value) ? value : []);

  /* ---------------------------------------------------------------- builder */
  function build(d, jsPDF) {
    const doc = new jsPDF({ unit: "pt", format: "letter", compress: true });
    let y = M;

    doc.setProperties({
      title: clean(`Outreach dossier - ${d.subject?.name || "prospect"}`),
      subject: "Internal prospect due-diligence brief",
      author: "Origin",
      creator: "Origin"
    });

    const font = (style = "normal", size = 10, color = C.text) => {
      doc.setFont("helvetica", style);
      doc.setFontSize(size);
      doc.setTextColor(color[0], color[1], color[2]);
    };

    function need(height) {
      if (y + height > PAGE.h - BOTTOM) {
        doc.addPage();
        y = M;
      }
    }

    /* Greedy word wrap using the active font; over-long tokens (URLs) are split by character. */
    function wrap(text, width) {
      const lines = [];
      for (const paragraph of clean(text).split("\n")) {
        const words = paragraph.split(/\s+/).filter(Boolean);
        let line = "";
        for (let word of words) {
          while (doc.getTextWidth(word) > width) {
            /* binary search for the longest prefix that fits */
            let lo = 1;
            let hi = word.length - 1;
            while (lo < hi) {
              const mid = Math.ceil((lo + hi) / 2);
              if (doc.getTextWidth(word.slice(0, mid)) <= width) lo = mid;
              else hi = mid - 1;
            }
            const cut = lo;
            if (line) { lines.push(line); line = ""; }
            lines.push(word.slice(0, cut));
            word = word.slice(cut);
          }
          const next = line ? `${line} ${word}` : word;
          if (doc.getTextWidth(next) <= width) line = next;
          else { lines.push(line); line = word; }
        }
        if (line) lines.push(line);
      }
      return lines;
    }

    /* Writes wrapped text at the cursor. Options: size, style, color, indent, url, after, lh. */
    function write(text, o = {}) {
      const size = o.size || 10;
      const lineHeight = size * (o.lh || 1.4);
      const x = M + (o.indent || 0);
      font(o.style, size, o.url ? C.link : o.color || C.text);
      const lines = wrap(text, CW - (o.indent || 0));
      for (const line of lines) {
        need(lineHeight);
        font(o.style, size, o.url ? C.link : o.color || C.text);
        if (o.url) {
          doc.textWithLink(line, x, y + size, { url: o.url });
          doc.setDrawColor(C.link[0], C.link[1], C.link[2]);
          doc.setLineWidth(0.4);
          doc.line(x, y + size + 1.5, x + doc.getTextWidth(line), y + size + 1.5);
        } else {
          doc.text(line, x, y + size);
        }
        y += lineHeight;
      }
      y += o.after || 0;
    }

    function bullet(text, o = {}) {
      const indent = o.indent || 0;
      need(14);
      doc.setFillColor(C.muted[0], C.muted[1], C.muted[2]);
      doc.circle(M + indent + 3, y + 6.2, 1.3, "F");
      write(text, { size: 9.5, ...o, indent: indent + 12, after: o.after ?? 3 });
    }

    function heading(title, count) {
      need(78);
      y += 12;
      doc.setDrawColor(C.rule[0], C.rule[1], C.rule[2]);
      doc.setLineWidth(0.6);
      doc.line(M, y, PAGE.w - M, y);
      y += 9;
      font("bold", 12.5, C.accent);
      doc.text(clean(title), M, y + 12);
      if (count !== undefined && count !== null && count !== "") {
        font("normal", 9.5, C.muted);
        doc.text(clean(String(count)), PAGE.w - M, y + 12, { align: "right" });
      }
      y += 26;
    }

    function sub(title) {
      need(44);
      y += 3;
      write(title, { style: "bold", size: 10, color: C.ink, after: 3 });
    }

    const empty = (text) => write(text, { style: "italic", size: 9.5, color: C.muted, after: 6 });
    const note = (text) => text && write(text, { style: "italic", size: 8.5, color: C.muted, after: 6 });

    function finding(f, o = {}) {
      need(46);
      const url = safeUrl(f.url);
      write(f.title || "Untitled", { style: "bold", size: 10, url, color: o.muted ? C.muted : C.text, after: 0 });
      const meta = [
        f.type,
        f.date,
        f.matchConfidence ? `${f.matchConfidence} confidence` : "",
        url ? host(url) : "",
        f.url && !f.grounded ? "unverified link" : ""
      ].filter(Boolean).join("  |  ");
      if (meta) write(meta, { size: 8.5, color: C.muted, after: 1 });
      if (f.summary) write(f.summary, { size: 9.5, color: o.muted ? C.muted : C.text, after: 7 });
      else y += 6;
    }

    function group(g, emptyText) {
      const found = list(g?.findings);
      const unverified = list(g?.unverified);
      if (found.length) found.forEach((f) => finding(f));
      else empty(emptyText);
      if (unverified.length) {
        sub(`${unverified.length} low-confidence possible match${unverified.length === 1 ? "" : "es"} (likely a different person)`);
        unverified.forEach((f) => finding(f, { muted: true }));
      }
      note(g?.notes);
    }

    /* ------------------------------------------------------------ title block */
    font("bold", 8.5, C.accent);
    doc.text("OUTREACH DOSSIER  |  INTERNAL USE ONLY", M, y + 8, { charSpace: 0.8 });
    y += 20;
    write(d.subject?.name || "Prospect", { style: "bold", size: 24, color: C.ink, lh: 1.2, after: 2 });
    write([d.subject?.title, d.subject?.company].filter(Boolean).join("  |  "), { size: 11.5, color: C.muted, after: 4 });
    const live = d.meta?.mode === "live";
    if (live) {
      const stamp = d.meta?.generatedAt ? new Date(d.meta.generatedAt).toLocaleString() : "";
      write(clean(["Live research", stamp && `generated ${stamp}`, d.meta?.provider && d.meta?.model && `${d.meta.provider} / ${d.meta.model}`, d.meta?.webVia && `web via ${d.meta.webVia}`].filter(Boolean).join("  |  ")), { size: 8.5, color: C.muted, after: 10 });
    } else {
      write("DEMO DATA: every item in this document is synthetic placeholder content, not information about this person.", { style: "bold", size: 9, color: C.warn, after: 10 });
    }

    /* ------------------------------------------------------------ compliance banner */
    const riskSource = (typeof window !== "undefined" && window.Dossier?.RISK) || RISK_FALLBACK;
    const [riskTitle, riskText] = riskSource[d.complianceRisk] || riskSource.unscreened || RISK_FALLBACK.unscreened;
    const tone = RISK_TONE[d.complianceRisk] || RISK_TONE.unscreened;
    font("normal", 9.5, tone.text);
    const riskLines = wrap(riskText, CW - 28);
    const boxH = 16 + 15 + riskLines.length * 13 + 8;
    need(boxH + 6);
    doc.setFillColor(tone.bg[0], tone.bg[1], tone.bg[2]);
    doc.rect(M, y, CW, boxH, "F");
    doc.setFillColor(tone.bar[0], tone.bar[1], tone.bar[2]);
    doc.rect(M, y, 4, boxH, "F");
    font("bold", 11, tone.text);
    doc.text(`Compliance: ${clean(riskTitle)}`, M + 16, y + 20);
    font("normal", 9.5, tone.text);
    riskLines.forEach((line, i) => doc.text(line, M + 16, y + 35 + i * 13));
    y += boxH + 14;

    /* ------------------------------------------------------------ summary */
    if (d.summary) write(d.summary, { size: 10.5, lh: 1.5, after: 6 });
    list(d.careerHighlights).forEach((h) => bullet(h));

    /* ------------------------------------------------------------ sanctions */
    const s = d.sanctions;
    heading("Sanctions & PEP screening (OpenSanctions)", s ? list(s.results).length : "n/a");
    if (!s) {
      empty("Sanctions and PEP screening did not run (key not configured or the call failed).");
    } else {
      if (s.nameIncomplete) write("The name in the source is incomplete, so this screening is unreliable until the full legal name is confirmed.", { size: 9.5, color: C.warn, style: "bold", after: 5 });
      if (!list(s.results).length) empty("No potential matches at or above 60%.");
      list(s.results).forEach((r) => {
        need(46);
        write(r.name || "Unnamed match", { style: "bold", size: 10, url: safeUrl(r.url), after: 0 });
        const tags = [
          `${Math.round((r.score || 0) * 100)}% match`,
          r.isSanction ? "SANCTIONS" : "",
          r.isPep ? "PEP / relative" : "",
          ...list(r.topics).filter((t) => !/^(sanction|role\.pep|role\.rca)/.test(t)).slice(0, 3)
        ].filter(Boolean).join("  |  ");
        write(tags, { size: 8.5, color: r.isSanction ? C.bad : C.muted, style: r.isSanction ? "bold" : "normal", after: 1 });
        const detail = [list(r.positions).join(", "), list(r.countries).join(", ").toUpperCase(), list(r.birthDate).join(", ")].filter(Boolean).join("  |  ");
        write(detail || "No further details", { size: 9.5, after: 1 });
        if (list(r.datasets).length) write(list(r.datasets).slice(0, 4).join(", "), { size: 8.5, color: C.muted, after: 6 });
      });
      note(s.note);
    }

    /* ------------------------------------------------------------ legal */
    const caseCount = list(d.courts?.cases).length;
    heading("Litigation, court records & adverse media", (d.courts?.total || 0) + list(d.mediaLegal?.findings).length);
    sub("Public court records (CourtListener)");
    if (!d.courts) empty("Court-record search did not run.");
    else {
      if (!caseCount) empty("No federal dockets found naming a party with this name.");
      list(d.courts.cases).forEach((c) => {
        need(40);
        write(c.caseName || "Case", { style: "bold", size: 10, url: safeUrl(c.url), after: 0 });
        write([c.role, c.court, c.dateFiled, c.docketNumber].filter(Boolean).join("  |  "), { size: 8.5, color: C.muted, after: 6 });
      });
      note(d.courts.note);
    }
    sub("Legal, regulatory & adverse media (web)");
    group(d.mediaLegal, "No litigation, regulatory or adverse-media mentions were tied to this person.");

    /* ------------------------------------------------------------ patents (only when that integration is enabled) */
    if (d.patents) {
      const p = d.patents;
      heading("Patents (USPTO) & retention signal", p.total);
      write(`${p.total} filings | ${p.employerAssigned} employer-assigned | ${p.domainRelevant} in the employer's field`, { size: 9.5, after: 3 });
      if (p.retention) write(`Retention & equity signal: ${p.retention.level}. ${p.retention.rationale || ""}`, { size: 9.5, after: 6 });
      list(p.patents).forEach((x) => {
        need(40);
        write(x.title, { style: "bold", size: 10, url: safeUrl(x.url), after: 0 });
        write([x.status, x.filingDate && `filed ${x.filingDate}`, x.grantDate && `granted ${x.grantDate}`, list(x.applicants).join(", ")].filter(Boolean).join("  |  "), { size: 8.5, color: C.muted, after: 6 });
      });
    }

    /* ------------------------------------------------------------ web research sections */
    const blocks = [
      ["Professional profile (LinkedIn as publicly indexed)", d.profile, "No public professional profile was tied to this person.", d.profileSummary],
      ["News & press coverage", d.press, "No newspaper, magazine or trade-press coverage was tied to this person."],
      ["Public writing, blogs & interviews", d.writing, "No public writing was tied to this person."],
      ["Podcasts & audio interviews", d.podcasts, "No podcast appearances were tied to this person."],
      ["Social profiles & public posts", d.social, "No public professional social profiles were tied to this person."],
      ["Video essays, talks & YouTube", d.video, "No public videos or talks were tied to this person."]
    ];
    blocks.forEach(([title, g, emptyText, intro]) => {
      heading(title, list(g?.findings).length);
      if (intro) write(intro, { size: 9.5, after: 5 });
      group(g, emptyText);
    });

    /* ------------------------------------------------------------ research & code */
    heading("Research & developer footprint");
    sub("Publications (OpenAlex)");
    const author = d.publications?.author;
    if (author) {
      write(author.name, { style: "bold", size: 10, url: safeUrl(author.url), after: 0 });
      write([author.verified ? "affiliation matches employer" : "name match only", `${author.works ?? "?"} works`, `${author.citations ?? "?"} citations`].join("  |  "), { size: 8.5, color: C.muted, after: 4 });
      list(d.publications.works).forEach((w) => bullet(`${w.title}${w.year ? ` (${w.year})` : ""}${w.citations != null ? `, ${w.citations} citations` : ""}`));
      note(d.publications.note);
    } else empty("No matching author profile.");
    sub("Public developer profile (GitHub)");
    if (list(d.code?.profiles).length) {
      d.code.profiles.forEach((g) => {
        need(40);
        write(`@${g.login}`, { style: "bold", size: 10, url: safeUrl(g.url), after: 0 });
        write([g.employerHit ? "employer matches" : "name match only", g.company, `${g.followers ?? 0} followers`, `${g.repos ?? 0} repos`].filter(Boolean).join("  |  "), { size: 8.5, color: C.muted, after: g.bio ? 1 : 6 });
        if (g.bio) write(g.bio, { size: 9.5, after: 6 });
      });
    } else empty("No public profile with a matching full name.");

    heading("Business interests, boards & philanthropy", list(d.wealth?.findings).length);
    group(d.wealth, "No public business, board or philanthropy signals were tied to this person.");

    /* ------------------------------------------------------------ outreach plan */
    heading("Outreach plan");
    const o = d.outreach;
    if (!o) empty("The synthesis agent did not run, so no outreach plan was produced.");
    else {
      write(o.angle, { size: 10.5, lh: 1.5, after: 6 });
      if (list(o.conversationStarters).length) {
        sub("Conversation starters");
        o.conversationStarters.forEach((c) => bullet(c));
      }
      if (o.channel) { sub("Channel"); write(o.channel, { size: 9.5, after: 4 }); }
      if (o.timing) { sub("Timing"); write(o.timing, { size: 9.5, after: 4 }); }
      if (list(o.avoid).length) {
        sub("Avoid");
        o.avoid.forEach((a) => bullet(a));
      }
    }

    if (list(d.gaps).length) {
      heading("Data gaps & caveats", d.gaps.length);
      d.gaps.forEach((g) => bullet(g));
    }

    heading("Sources", list(d.sources).length);
    if (!list(d.sources).length) empty("No sources were retrieved.");
    list(d.sources).forEach((src, i) => {
      const url = safeUrl(src.url);
      need(30);
      write(`${i + 1}. ${src.title || src.url}`, { size: 9.5, url, after: 0 });
      if (url) write(url, { size: 7.5, color: C.muted, indent: 12, after: 4 });
    });

    if (d.meta?.notice) {
      y += 8;
      write(d.meta.notice, { style: "italic", size: 8.5, color: C.muted, after: 0 });
    }

    /* ------------------------------------------------------------ page footers */
    const pages = doc.getNumberOfPages();
    const label = clean(`${d.subject?.name || "Prospect"} | Outreach dossier | Internal use only`);
    for (let i = 1; i <= pages; i += 1) {
      doc.setPage(i);
      doc.setDrawColor(C.rule[0], C.rule[1], C.rule[2]);
      doc.setLineWidth(0.5);
      doc.line(M, PAGE.h - 40, PAGE.w - M, PAGE.h - 40);
      font("normal", 8, C.muted);
      doc.text(label, M, PAGE.h - 27);
      doc.text(`Page ${i} of ${pages}`, PAGE.w - M, PAGE.h - 27, { align: "right" });
    }
    return doc;
  }

  /* ---------------------------------------------------------------- public API */
  function filename(d) {
    const slug = String(d.subject?.name || "prospect").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "prospect";
    const stamp = (d.meta?.generatedAt ? new Date(d.meta.generatedAt) : new Date()).toISOString().slice(0, 10);
    return `${slug}-dossier-${stamp}${d.meta?.mode === "live" ? "" : "-DEMO"}.pdf`;
  }

  let loading = null;
  function loadLibrary() {
    if (window.jspdf?.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = LIB_URL;
        script.onload = () => (window.jspdf?.jsPDF ? resolve(window.jspdf.jsPDF) : reject(new Error("The PDF library loaded but is unusable")));
        script.onerror = () => { loading = null; reject(new Error("Could not load the PDF library")); };
        document.head.appendChild(script);
      });
    }
    return loading;
  }

  async function save(d) {
    const jsPDF = await loadLibrary();
    const doc = build(d, jsPDF);
    doc.save(filename(d));
    return doc;
  }

  window.DossierPDF = { build, save, filename, clean };
})();
