"use strict";

/* The equity model: it starts empty, takes company profiles from data files only, and guards against bad data. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const EquityModel = require("../equity-model.js");
const DataLoader = require("../data-loader.js");

const SAMPLE = DataLoader.parsePack(fs.readFileSync(path.join(__dirname, "..", "templates", "sample-data-pack.js"), "utf8"), { asOf: EquityModel.AS_OF });
const sampleProfiles = () => JSON.parse(JSON.stringify(SAMPLE.profiles));
const A = "Demo Company A"; // double-trigger, 1-year cliff, one tender, pay ladder L3..L6
const B = "Demo Company B"; // single-trigger, 40/30/20/10, no tender, pay ladder IC1..IC4
const base = { name: "Demo Person 0", title: "Software Engineer", department: "Engineering/Technical" };
const withSample = (fn) => () => {
  EquityModel.resetProfiles();
  EquityModel.registerProfiles(sampleProfiles());
  try { fn(); } finally { EquityModel.resetProfiles(); }
};
const empty = (fn) => () => { EquityModel.resetProfiles(); try { fn(); } finally { EquityModel.resetProfiles(); } };

/* ------------------------------------------------------------------ nothing is built in */
test("the model starts empty: no company profiles ship in the code", empty(() => {
  assert.deepEqual(EquityModel.profileNames(), []);
  assert.equal(EquityModel.hasProfile(A), false);
  assert.equal(EquityModel.DEFAULT_PROFILES, undefined);
}));

test("a company without a profile is listed but never estimated", empty(() => {
  const e = EquityModel.estimate({ ...base, company: "Nowhere Inc", startDate: "2022-03-01" });
  assert.equal(e.estimated, false);
  assert.equal(e.confidence, "n/a");
  assert.equal(e.net.p50, 0);
  assert.match(e.dataIssue, /No company profile for "Nowhere Inc"/);
  assert.equal(e.structure.short, "n/a");
}));

test("resetProfiles forgets everything that was loaded", withSample(() => {
  assert.deepEqual(EquityModel.profileNames(), [A, B]);
  EquityModel.resetProfiles();
  assert.deepEqual(EquityModel.profileNames(), []);
  assert.equal(EquityModel.estimate({ ...base, company: A, startDate: "2022-03-01" }).estimated, false);
}));

/* ------------------------------------------------------------------ the sample data */
test("the sample pack is fictional and small: 14 numbered demo people at 2 demo companies", () => {
  assert.equal(SAMPLE.prospects.length, 14);
  SAMPLE.prospects.forEach((p, i) => {
    assert.equal(p.name, `Demo Person ${i + 1}`);
    assert.match(p.company, /^Demo Company [AB]$/);
  });
  const allowed = new Set(["name", "company", "title", "seniority", "department", "subDepartment", "startDate", "tenure", "founder"]);
  for (const p of SAMPLE.prospects) for (const key of Object.keys(p)) assert.ok(allowed.has(key), `${p.name}: unexpected field ${key}`);
  const counts = SAMPLE.prospects.reduce((acc, p) => ({ ...acc, [p.company]: (acc[p.company] || 0) + 1 }), {});
  assert.deepEqual(counts, { [A]: 8, [B]: 6 });
});

test("sample data: every prospect is estimated except the one impossible start date", withSample(() => {
  const results = SAMPLE.prospects.map((p) => ({ p, e: EquityModel.estimate(p) }));
  const skipped = results.filter((r) => !r.e.estimated);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].p.name, "Demo Person 14");
  assert.match(skipped[0].e.dataIssue, /before Demo Company B was founded/);
  for (const { p, e } of results.filter((r) => r.e.estimated)) {
    assert.ok(e.net.p10 > 0 && e.net.p10 <= e.net.p50 && e.net.p50 <= e.net.p90, p.name);
  }
}));

test("sample data shows each flag: a founder (Low confidence), an early hire, a hire before the first round", withSample(() => {
  const by = (name) => EquityModel.estimate(SAMPLE.prospects.find((p) => p.name === name));
  const founder = by("Demo Person 8");
  assert.equal(founder.confidence, "Low");
  assert.ok(founder.flags.some((f) => /founder/i.test(f)));
  const early = by("Demo Person 7");
  assert.ok(early.flags.some((f) => /very early hire/i.test(f)));
  assert.ok(early.flags.some((f) => /before the first priced round/i.test(f)));
  assert.ok(by("Demo Person 8").net.p50 > by("Demo Person 3").net.p50 * 5, "the founder placeholder is far above an ordinary principal engineer");
}));

/* ------------------------------------------------------------------ company profiles */
test("vesting is data-driven: cliff and yearly shares", withSample(() => {
  const a = EquityModel.getProfile(A).cumulative;
  const b = EquityModel.getProfile(B).cumulative;
  assert.equal(a(11), 0, "nothing before a 12-month cliff");
  assert.ok(Math.abs(a(12) - 0.25) < 1e-9, "a quarter at the cliff");
  assert.ok(Math.abs(a(48) - 1) < 1e-9);
  assert.ok(Math.abs(b(12) - 0.4) < 1e-9, "40% after year one");
  assert.ok(Math.abs(b(24) - 0.7) < 1e-9);
  assert.ok(Math.abs(b(36) - 0.9) < 1e-9);
  assert.ok(Math.abs(b(48) - 1) < 1e-9);
  assert.match(EquityModel.getProfile(B).vesting.label, /40\/30\/20\/10/);
  const linear = { ...sampleProfiles()[A], foundedYear: 2010, vesting: { yearlyPercent: [25, 25, 25, 25] } };
  EquityModel.registerProfiles({ Linear: linear });
  const l = EquityModel.getProfile("Linear").cumulative;
  assert.ok(Math.abs(l(1) - 1 / 48) < 1e-9 && Math.abs(l(24) - 0.5) < 1e-9, "linear monthly with no cliff");
  assert.match(EquityModel.getProfile("Linear").vesting.label, /no cliff/);
}));

test("a valid custom profile is registered and used for estimates", empty(() => {
  const profile = { ...sampleProfiles()[A], foundedYear: 2010 };
  const result = EquityModel.registerProfiles({ "Acme Labs": profile });
  assert.deepEqual(result.registered, ["Acme Labs"]);
  assert.deepEqual(result.errors, {});
  const e = EquityModel.estimate({ ...base, company: "Acme Labs", startDate: "2022-03-01" });
  assert.equal(e.estimated, true);
  assert.ok(e.net.p50 > 0);
}));

test("invalid profiles are rejected with readable reasons and do not break the valid ones", empty(() => {
  const broken = sampleProfiles()[A];
  broken.vesting.yearlyPercent = [30, 30, 30];
  broken.curve = [["2020-01-01", 5, 1], ["2019-01-01", 6, 2]];
  broken.levels = [{ name: "L1", stockPerYear: 500 }, { name: "L2", stockPerYear: 100 }];
  broken.structure.type = "triple";
  broken.tenders = [{ date: "2025-01-01", price: -3, cap: null, participation: [0.5, 0.2], label: "x", note: "y" }];
  broken.foundedYear = "soon";
  const result = EquityModel.registerProfiles({ Broken: broken, Fine: sampleProfiles()[B] });
  assert.deepEqual(result.registered, ["Fine"]);
  const text = result.errors.Broken.join(" | ");
  for (const expected of [/foundedYear/, /add up to 100/, /not later than the previous round/, /3 to 12 pay levels|must not be lower/, /structure\.type/, /tenders\[0\]/]) assert.match(text, expected);
  assert.equal(EquityModel.hasProfile("Broken"), false);
  assert.equal(EquityModel.hasProfile("Fine"), true);
  assert.ok(EquityModel.registerProfiles("nope").errors["(file)"]);
  assert.ok(EquityModel.registerProfiles([]).errors["(file)"]);
  assert.ok(EquityModel.validateProfile("x", null).errors.length);
}));

test("profile names are only keys: prototype tricks do nothing", empty(() => {
  const result = EquityModel.registerProfiles(JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"x": 1}}'));
  assert.deepEqual(result.registered, []);
  assert.equal({}.polluted, undefined);
  assert.equal(EquityModel.hasProfile("constructor"), false);
  assert.equal(EquityModel.hasProfile("toString"), false);
}));

test("a title that states a level uses it; words like Senior or Staff are never mistaken for levels", withSample(() => {
  const stated = EquityModel.estimate({ ...base, title: "Software Engineer - L5", company: A, startDate: "2022-03-01" });
  assert.match(stated.band.basis, /states level L5/);
  const wordy = { ...sampleProfiles()[B], levels: [{ name: "Entry", stockPerYear: 50000 }, { name: "Senior", stockPerYear: 100000 }, { name: "Lead", stockPerYear: 200000 }, { name: "Staff", stockPerYear: 400000 }] };
  EquityModel.registerProfiles({ Wordy: wordy });
  for (const title of ["Senior Software Engineer", "Member of Technical Staff", "Research Lead"]) {
    const e = EquityModel.estimate({ ...base, title, company: "Wordy", startDate: "2023-03-01" });
    assert.doesNotMatch(e.band.basis, /states level/, title);
  }
}));

test("roleBands in a profile override the generic rule for that role", withSample(() => {
  EquityModel.registerProfiles({ Acme: { ...sampleProfiles()[A], foundedYear: 2010, roleBands: { marketing: [30000, 40000] } } });
  const e = EquityModel.estimate({ ...base, title: "Digital Marketing Manager", company: "Acme", startDate: "2022-03-01" });
  assert.equal(e.band.low, 30000);
  assert.equal(e.band.high, 40000);
  assert.match(e.band.basis, /set by the company profile/);
  assert.ok(EquityModel.registerProfiles({ Bad: { ...sampleProfiles()[A], roleBands: { astronaut: [1, 2] } } }).errors.Bad);
}));

test("pay bands rise with seniority on the same ladder", withSample(() => {
  const at = (title) => EquityModel.estimate({ ...base, title, company: A, startDate: "2022-03-01", department: "Engineering/Technical" }).net.p50;
  assert.ok(at("Vice President, Engineering") > at("Technical Director"), "VP above technical director");
  assert.ok(at("Technical Director") > at("Principal Software Engineer"), "director above principal");
  assert.ok(at("Principal Software Engineer") > at("Software Engineer"), "principal above engineer");
  assert.ok(at("Software Engineer") > at("Recruiting Manager, Talent Acquisition"), "engineering above recruiting");
}));

test("a founder flag gives a much higher, Low-confidence placeholder", withSample(() => {
  const normal = EquityModel.estimate({ ...base, company: B, startDate: "2018-03-01" });
  const founder = EquityModel.estimate({ ...base, company: B, startDate: "2018-03-01", founder: true });
  assert.ok(founder.net.p50 > normal.net.p50 * 5);
  assert.equal(founder.confidence, "Low");
}));

/* ------------------------------------------------------------------ guards */
test("impossible start dates are not estimated (before founding, future, unreadable)", withSample(() => {
  const cases = [[A, "1999-01-01"], [A, "2015-06-01"], [B, "2005-01-01"], [A, "2031-01-01"], [A, "not-a-date"]];
  for (const [company, startDate] of cases) {
    const e = EquityModel.estimate({ ...base, company, startDate });
    assert.equal(e.estimated, false, `${company} ${startDate}`);
    assert.equal(e.confidence, "n/a");
    assert.equal(e.net.p50, 0);
    assert.ok(e.dataIssue);
  }
  assert.equal(EquityModel.estimate({ ...base, company: A, startDate: "2022-03-01" }).estimated, true);
}));

test("incomplete-name rule: initials and single names are flagged, numbered names are not", () => {
  assert.equal(DataLoader.isIncompleteName("Demo Person 7"), false);
  assert.equal(DataLoader.isIncompleteName("Jane Roe"), false);
  assert.equal(DataLoader.isIncompleteName("Jane"), true);
  assert.equal(DataLoader.isIncompleteName("Jane R"), true);
  assert.equal(DataLoader.isIncompleteName("J. Roe"), true);
});
