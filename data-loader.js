/*
 * Data-file loader: reads a user-supplied prospects file (.js or .json) WITHOUT executing it.
 *
 * Why not just run the file? Running an uploaded script would let it do anything the page can do (read the research
 * dossiers, call the local API, send data elsewhere), and the page's Content-Security-Policy forbids it anyway. So the
 * file is treated as text: the loader finds the data values in it, parses them as JSON and validates every field.
 *
 * Accepted shapes (the dashboard has one upload section for prospects and one for company profiles; each reads only its own part)
 *   1. A .js file that assigns the data:   window.RAW_PROSPECTS = [ ... ];   window.COMPANY_PROFILES = { ... };
 *   2. The files this project generates:   const data = [ ... ];
 *   3. A .json file:                        { "prospects": [ ... ], "companyProfiles": { ... } }  or just  [ ... ]
 * The values must be valid JSON (double-quoted keys and strings). Comments and trailing commas are tolerated.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DataLoader = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MAX_BYTES = 5 * 1024 * 1024;
  const MAX_ROWS = 5000;
  const MAX_ERRORS_SHOWN = 25;
  const DAY_MS = 86400000;

  /* ---------------------------------------------------------------- text scanning (string-aware, never evaluates) */
  function stripComments(text) {
    let out = "";
    let i = 0;
    let inString = false;
    while (i < text.length) {
      const c = text[i];
      const next = text[i + 1];
      if (inString) {
        out += c;
        if (c === "\\") { out += next ?? ""; i += 2; continue; }
        if (c === '"') inString = false;
        i += 1;
      } else if (c === '"') {
        inString = true;
        out += c;
        i += 1;
      } else if (c === "/" && next === "/") {
        while (i < text.length && text[i] !== "\n") i += 1;
      } else if (c === "/" && next === "*") {
        const end = text.indexOf("*/", i + 2);
        i = end < 0 ? text.length : end + 2;
      } else {
        out += c;
        i += 1;
      }
    }
    return out;
  }

  function stripTrailingCommas(text) {
    let out = "";
    let inString = false;
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      if (inString) {
        out += c;
        if (c === "\\") { out += text[i + 1] ?? ""; i += 1; } else if (c === '"') inString = false;
      } else if (c === '"') {
        inString = true;
        out += c;
      } else if (c === ",") {
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j += 1;
        if (text[j] === "]" || text[j] === "}") continue; // drop the comma
        out += c;
      } else {
        out += c;
      }
    }
    return out;
  }

  /* Returns the balanced [...] or {...} starting at text[start]. */
  function readBalanced(text, start) {
    const stack = [];
    let inString = false;
    for (let i = start; i < text.length; i += 1) {
      const c = text[i];
      if (inString) {
        if (c === "\\") i += 1;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; continue; }
      if (c === "'" || c === "`") throw new Error("Use double quotes for text (single-quoted strings and template literals are not valid JSON).");
      if (c === "[" || c === "{") stack.push(c);
      else if (c === "]" || c === "}") {
        const open = stack.pop();
        if (!open || (open === "[") !== (c === "]")) throw new Error("Brackets do not match in the data.");
        if (!stack.length) return text.slice(start, i + 1);
      }
    }
    throw new Error("The data is not closed: a bracket is missing.");
  }

  function parseJsonValue(snippet, label) {
    try {
      return JSON.parse(stripTrailingCommas(snippet));
    } catch (error) {
      throw new Error(`${label} is not valid JSON (${error.message}). Use double-quoted keys and text, no expressions or functions. The template shows the format.`);
    }
  }

  /* Finds `name = <value>` (or `name: <value>`) and returns the parsed value, or undefined when the name is absent. */
  function extractAssignment(text, names, opener) {
    for (const name of names) {
      const re = new RegExp(`(?:^|[^A-Za-z0-9_$])${name}\\s*(?:=|:)\\s*(?=[\\[{])`, "g");
      const match = re.exec(text);
      if (!match) continue;
      const start = match.index + match[0].length;
      if (opener && text[start] !== opener) throw new Error(`${name} must be ${opener === "[" ? "a list [ ... ]" : "an object { ... }"}.`);
      return { name, value: parseJsonValue(readBalanced(text, start), name) };
    }
    return undefined;
  }

  /* ---------------------------------------------------------------- field validation */
  const clean = (value, max) => String(value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  const isIsoDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

  /* A name is "incomplete" when it has fewer than two tokens or a token that is a single initial. */
  function isIncompleteName(name) {
    const tokens = name.split(" ").filter(Boolean);
    return tokens.length < 2 || tokens.some((t) => /^\p{L}\.?$/u.test(t));
  }

  function tenureYears(startDate, asOf = new Date()) {
    const years = (asOf.getTime() - Date.parse(`${startDate}T00:00:00Z`)) / (365.25 * DAY_MS);
    return Math.round(years * 10) / 10;
  }

  /* Returns { value } or { error }. Unknown fields are dropped, so nothing unexpected reaches the app. */
  function normalizeProspect(row, options = {}) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return { error: "is not an object" };
    for (const key of ["name", "company", "title"]) {
      if (typeof row[key] !== "string" || !clean(row[key], 300)) return { error: `needs "${key}" as text` };
    }
    if (!isIsoDate(row.startDate)) return { error: 'needs "startDate" as YYYY-MM-DD' };
    for (const key of ["seniority", "department", "subDepartment", "city"]) {
      if (row[key] !== undefined && row[key] !== null && typeof row[key] !== "string") return { error: `"${key}" must be text` };
    }
    if (row.tenure !== undefined && (typeof row.tenure !== "number" || !Number.isFinite(row.tenure) || row.tenure < 0 || row.tenure > 80)) return { error: '"tenure" must be a number of years' };
    if (row.founder !== undefined && typeof row.founder !== "boolean") return { error: '"founder" must be true or false' };
    if (row.nameIncomplete !== undefined && typeof row.nameIncomplete !== "boolean") return { error: '"nameIncomplete" must be true or false' };

    const name = clean(row.name, 120);
    const value = {
      name,
      company: clean(row.company, 80),
      title: clean(row.title, 200),
      seniority: clean(row.seniority ?? "", 40).toLowerCase(),
      department: clean(row.department ?? "", 120),
      subDepartment: clean(row.subDepartment ?? "", 160),
      startDate: row.startDate,
      tenure: row.tenure ?? tenureYears(row.startDate, options.asOf)
    };
    if (row.city) value.city = clean(row.city, 80);
    if (row.founder === true) value.founder = true;
    if (row.nameIncomplete === true || (row.nameIncomplete === undefined && isIncompleteName(name))) value.nameIncomplete = true;
    return { value };
  }

  /* ---------------------------------------------------------------- the pack */
  /* Returns { fatal } when nothing usable was found, otherwise
   * { prospects, profiles, errors: [{row, message}], warnings: string[], counts: { rows, valid, skipped, duplicates } }. */
  function parsePack(rawText, options = {}) {
    if (typeof rawText !== "string" || !rawText.trim()) return { fatal: "The file is empty." };
    if (rawText.length > MAX_BYTES) return { fatal: `The file is larger than ${MAX_BYTES / 1024 / 1024} MB.` };
    const text = stripComments(rawText.replace(/^\uFEFF/, "")).trim();

    let prospectsRaw;
    let profilesRaw;
    try {
      if (text.startsWith("[") || text.startsWith("{")) {
        const json = parseJsonValue(text, "The file");
        if (Array.isArray(json)) prospectsRaw = json;
        else {
          prospectsRaw = json.prospects ?? json.RAW_PROSPECTS;
          profilesRaw = json.companyProfiles ?? json.COMPANY_PROFILES;
        }
      } else {
        const prospects = extractAssignment(text, ["RAW_PROSPECTS", "prospects"], "[") || extractAssignment(text, ["data"], "[");
        const profiles = extractAssignment(text, ["COMPANY_PROFILES", "companyProfiles"], "{");
        prospectsRaw = prospects?.value;
        profilesRaw = profiles?.value;
      }
    } catch (error) {
      return { fatal: error.message };
    }

    if (prospectsRaw === undefined && profilesRaw === undefined) {
      return { fatal: "No prospects found. The file should contain window.RAW_PROSPECTS = [ ... ]; (and optionally window.COMPANY_PROFILES = { ... };). See the template." };
    }
    if (prospectsRaw !== undefined && !Array.isArray(prospectsRaw)) return { fatal: "The prospects must be a list [ ... ]." };
    if (profilesRaw !== undefined && (typeof profilesRaw !== "object" || profilesRaw === null || Array.isArray(profilesRaw))) return { fatal: "COMPANY_PROFILES must be an object keyed by company name." };
    if ((prospectsRaw || []).length > MAX_ROWS) return { fatal: `The file has more than ${MAX_ROWS} prospects. Split it into smaller files.` };

    const prospects = [];
    const errors = [];
    const warnings = [];
    const seen = new Set();
    let duplicates = 0;
    (prospectsRaw || []).forEach((row, index) => {
      const result = normalizeProspect(row, options);
      if (result.error) {
        errors.push({ row: index + 1, message: `Row ${index + 1} ${result.error}` });
        return;
      }
      const key = `${result.value.company}|${result.value.name}`.toLowerCase();
      if (seen.has(key)) { duplicates += 1; return; }
      seen.add(key);
      prospects.push(result.value);
    });
    if (duplicates) warnings.push(`${duplicates} duplicate row${duplicates === 1 ? "" : "s"} (same company and name) skipped.`);

    return {
      prospects,
      profiles: profilesRaw ?? null,
      errors: errors.slice(0, MAX_ERRORS_SHOWN),
      warnings,
      counts: { rows: (prospectsRaw || []).length, valid: prospects.length, skipped: errors.length, duplicates }
    };
  }

  return { parsePack, normalizeProspect, isIncompleteName, tenureYears, stripComments, MAX_BYTES, MAX_ROWS };
});
