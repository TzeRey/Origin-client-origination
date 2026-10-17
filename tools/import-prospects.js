#!/usr/bin/env node
/*
 * Converts YOUR OWN candidate CSV export into a data file you can load with "Use your own data" on the dashboard.
 *
 *   node tools/import-prospects.js "<path to your csv>" [output file]
 *
 * The output defaults to private/prospects-from-csv.js, a git-ignored folder, so real people never end up in the repository.
 * The file is in the same format as templates/prospects-template.js (window.RAW_PROSPECTS = [ ... ]). It has no company
 * profiles: add them from your own sources (see the template), or load a separate profiles file after it.
 * Only import data you are allowed to hold.
 *
 * Expected columns: Name,Company,Title,Seniority,Department,SubDepartment,StartDate,TenureYears
 * Cleans the messy fields (snake_case tokens, known typos, "???" placeholders, stray whitespace)
 * and flags incomplete names. Does NOT judge data validity beyond that: start-date sanity checks
 * live in equity-model.js so they apply to any data source.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const TOKEN_MAP = {
  /* departments */
  master_engineering_technical: "Engineering/Technical",
  master_information_technology: "IT",
  master_finance: "Finance",
  master_operations: "Operations",
  product_management: "Product Mgmt",
  design: "Design",
  /* sub-departments */
  engineering_technical: "Engineering",
  artificial_intelligence_machine_learning: "AI/ML",
  research_development: "R&D",
  software_development: "Software Dev",
  application_development: "App Dev",
  data_science: "Data Science",
  quality_assurance: "QA",
  project_management: "Project Mgmt",
  project_program_management: "Project Mgmt; Program Mgmt",
  enterprise_architecture: "Enterprise Architecture",
  inside_sales: "Inside Sales",
  product_mangement: "Product Mgmt",
  "corporate strategy": "Corporate Strategy",
  "corporate ctrategy": "Corporate Strategy",
  "field marketing": "Field Marketing",
  "field farketing": "Field Marketing",
  "event earketing": "Event Marketing",
  "digital darketing": "Digital Marketing",
  "account management": "Account Mgmt",
  "sales enablement": "Sales Enablement",
  "hr financial erp systems": "HR Financial/ERP Systems",
  "all design": "Design",
  networking: "Networking",
  operations: "Operations",
  sales: "Sales",
  infrastructure: "Infrastructure",
  finance: "Finance",
  marketing: "Marketing"
};

/* People to leave out of an import, as "Company|Name" (matched case-insensitively). Add entries here to keep someone off the
 * site, for example after an erasure request; the exclusion survives re-imports. Example: ["Company A|Jane Roe"] */
const EXCLUDED = [].map((s) => s.toLowerCase());

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((cell) => cell !== "")) rows.push(row);
  return rows;
}

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

function normalizeList(value) {
  const parts = String(value || "").split(";").map(clean).filter(Boolean);
  const out = [];
  for (const part of parts) {
    const mapped = TOKEN_MAP[part.toLowerCase()] || part;
    for (const piece of mapped.split(";").map(clean)) if (piece && !out.includes(piece)) out.push(piece);
  }
  return out.join("; ");
}

function normalizeTitle(value) {
  return clean(value).replace(/\s*\?{2,}\s*/g, " - ");
}

/* A name is "incomplete" when it has fewer than two tokens or a token that is a single initial. */
function isIncompleteName(name) {
  const tokens = name.split(" ").filter(Boolean);
  return tokens.length < 2 || tokens.some((t) => /^\p{L}\.?$/u.test(t));
}

function convert(csvText) {
  const [header, ...body] = parseCsv(csvText);
  const col = Object.fromEntries(header.map((h, i) => [clean(h).toLowerCase(), i]));
  for (const required of ["name", "company", "title", "seniority", "department", "subdepartment", "startdate", "tenureyears"]) {
    if (!(required in col)) throw new Error(`Missing column: ${required}`);
  }
  const seen = new Set();
  const people = [];
  const warnings = [];
  for (const cells of body) {
    const get = (key) => cells[col[key]] ?? "";
    const name = clean(get("name"));
    const company = clean(get("company"));
    const startDate = clean(get("startdate"));
    if (!name || !company) { warnings.push(`Skipped row without name/company: ${cells.join(",")}`); continue; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || Number.isNaN(Date.parse(startDate))) {
      warnings.push(`Invalid start date for ${name}: "${startDate}"`);
    }
    const key = `${company}|${name}`.toLowerCase();
    if (seen.has(key)) { warnings.push(`Duplicate skipped: ${company} / ${name}`); continue; }
    if (EXCLUDED.includes(key)) { warnings.push(`Excluded by request: ${company} / ${name}`); continue; }
    seen.add(key);
    const person = {
      name,
      company,
      title: normalizeTitle(get("title")),
      seniority: clean(get("seniority")).toLowerCase(),
      department: normalizeList(get("department")),
      subDepartment: normalizeList(get("subdepartment")),
      startDate,
      tenure: Number(clean(get("tenureyears"))) || 0
    };
    if (isIncompleteName(name)) person.nameIncomplete = true;
    people.push(person);
  }
  /* Companies keep the order in which they first appear in the file; people are sorted by name within a company. */
  const order = new Map();
  for (const p of people) if (!order.has(p.company)) order.set(p.company, order.size);
  people.sort((a, b) => order.get(a.company) - order.get(b.company) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { people, warnings };
}

function render(people, source) {
  const lines = people.map((p) => `  ${JSON.stringify(p)}`).join(",\n");
  return `/*
 * PRIVATE DATA: generated by tools/import-prospects.js from ${path.basename(source)}. Do not commit or share this file.
 * Load it with "Use your own data" on the dashboard. It is read as data in your browser, never run or uploaded.
 * It has no company profiles: add window.COMPANY_PROFILES from your own sources (see templates/company-profiles-template.js).
 */
window.RAW_PROSPECTS = [
${lines}
];
`;
}

if (require.main === module) {
  const source = process.argv[2];
  if (!source) {
    console.error('Usage: node tools/import-prospects.js "<path to csv>" [output file]');
    process.exit(1);
  }
  const { people, warnings } = convert(fs.readFileSync(source, "utf8").replace(/^\uFEFF/, ""));
  const target = path.resolve(process.argv[3] || path.join(__dirname, "..", "private", "prospects-from-csv.js"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, render(people, source), "utf8");
  const counts = people.reduce((acc, p) => ({ ...acc, [p.company]: (acc[p.company] || 0) + 1 }), {});
  console.log(`Wrote ${people.length} prospects to ${target}`, counts);
  console.log("Load it with 'Use your own data' on the dashboard. Do not commit it.");
  console.log(`Incomplete names: ${people.filter((p) => p.nameIncomplete).map((p) => p.name).join(", ") || "none"}`);
  for (const w of warnings) console.warn("WARN:", w);
}

module.exports = { convert, parseCsv, render };
