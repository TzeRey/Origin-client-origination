"use strict";

/* The CSV importer: it writes a private data file, never anything inside the app. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { convert, render } = require("../tools/import-prospects.js");
const DataLoader = require("../data-loader.js");

const CSV = [
  '"Name","Company","Title","Seniority","Department","SubDepartment","StartDate","TenureYears"',
  '"Example Person 1 ","Example Corp","Software  Engineer","ENTRY","master_engineering_technical","engineering_technical; software_development","2022-03-01","4.5"',
  '"Example Person 2","Example Corp","Senior Director ??? Applied AI","director","Operations","corporate strategy","2020-01-01","6.7"',
  '"Example Person 2","Example Corp","Duplicate row","director","","","2020-01-01","6.7"',
  '"Single","Other Co","Engineer","entry","","","2021-05-01","5.4"'
].join("\n");

test("the importer cleans labels, trims names, fixes placeholders, skips duplicates and flags incomplete names", () => {
  const { people, warnings } = convert(CSV);
  assert.equal(people.length, 3);
  assert.equal(people[0].name, "Example Person 1");
  assert.equal(people[0].title, "Software Engineer");
  assert.equal(people[0].seniority, "entry");
  assert.equal(people[0].department, "Engineering/Technical");
  assert.equal(people[0].subDepartment, "Engineering; Software Dev");
  assert.equal(people[1].title, "Senior Director - Applied AI");
  assert.equal(people[1].subDepartment, "Corporate Strategy");
  assert.equal(people[2].nameIncomplete, true);
  assert.ok(warnings.some((w) => /Duplicate skipped/.test(w)));
});

test("its output is a data file the app can load (same format as the template)", () => {
  const { people } = convert(CSV);
  const text = render(people, "my-export.csv");
  assert.match(text, /^\/\*\s*\n \* PRIVATE DATA/, "marked private");
  assert.match(text, /window\.RAW_PROSPECTS = \[/);
  const pack = DataLoader.parsePack(text);
  assert.equal(pack.fatal, undefined);
  assert.equal(pack.counts.valid, 3);
  assert.equal(pack.errors.length, 0);
});

test("the command line writes where you say, creates folders, and never touches the app's own files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "origin-import-"));
  const csvPath = path.join(dir, "people.csv");
  const outPath = path.join(dir, "nested", "out.js");
  fs.writeFileSync(csvPath, CSV);
  const run = spawnSync(process.execPath, [path.join(__dirname, "..", "tools", "import-prospects.js"), csvPath, outPath], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(fs.existsSync(outPath));
  assert.equal(DataLoader.parsePack(fs.readFileSync(outPath, "utf8")).counts.valid, 3);
  assert.match(run.stdout, /Do not commit it/);
  const none = spawnSync(process.execPath, [path.join(__dirname, "..", "tools", "import-prospects.js")], { encoding: "utf8" });
  assert.notEqual(none.status, 0, "no CSV given: usage error");
  assert.ok(!fs.existsSync(path.join(__dirname, "..", "prospects-data.js")));
});

test("the default output folder is the git-ignored private/ folder", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "tools", "import-prospects.js"), "utf8");
  assert.match(source, /"private", "prospects-from-csv\.js"/);
  assert.match(fs.readFileSync(path.join(__dirname, "..", ".gitignore"), "utf8"), /^private\/$/m);
});
