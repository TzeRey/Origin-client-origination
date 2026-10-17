"use strict";

/* Audit-log retention and deletion. Run with `npm test`. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "origin-audit-"));
process.env.OUTREACH_AUDIT_DIR = dir;
const audit = require("../server/audit");

const NOW = Date.parse("2026-10-10T12:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
const file = () => path.join(dir, "outreach-audit.jsonl");
const reset = (entries, raw = []) => {
  fs.rmSync(file(), { force: true });
  const lines = [...entries.map((e) => JSON.stringify(e)), ...raw];
  if (lines.length) fs.writeFileSync(file(), `${lines.join("\n")}\n`);
};

test("auditLog appends one JSON line per event", () => {
  reset([]);
  audit.auditLog({ ts: daysAgo(0), subject: "Jane Roe @ Company A", risk: "clear" });
  audit.auditLog({ ts: daysAgo(0), type: "email_draft", subject: "Jane Roe @ Company A", risk: "clear" });
  assert.equal(audit.listEntries().length, 2);
  assert.equal(audit.listEntries()[1].type, "email_draft");
});

test("purge removes entries older than the retention window and keeps recent ones", () => {
  reset([
    { ts: daysAgo(40), subject: "Old Person @ Company A" },
    { ts: daysAgo(31), subject: "Older Person @ Company B" },
    { ts: daysAgo(29), subject: "Recent Person @ Company C" },
    { ts: daysAgo(1), subject: "New Person @ Company A" }
  ]);
  const result = audit.purgeOlderThan(30, NOW);
  assert.deepEqual(result, { kept: 2, removed: 2 });
  assert.deepEqual(audit.listEntries().map((e) => e.subject), ["Recent Person @ Company C", "New Person @ Company A"]);
});

test("entries with a missing, invalid or unparseable timestamp are purged (age cannot be verified)", () => {
  reset([{ subject: "No Timestamp @ Company A" }, { ts: "not-a-date", subject: "Bad Date @ Company A" }, { ts: daysAgo(1), subject: "Good @ Company A" }], ["{ this is not json"]);
  const result = audit.purgeOlderThan(30, NOW);
  assert.deepEqual(result, { kept: 1, removed: 3 });
  assert.equal(audit.listEntries()[0].subject, "Good @ Company A");
});

test("retention days: default 30, configurable, 0 disables automatic purging", () => {
  const saved = process.env.AUDIT_RETENTION_DAYS;
  try {
    delete process.env.AUDIT_RETENTION_DAYS;
    assert.equal(audit.retentionDays(), 30);
    process.env.AUDIT_RETENTION_DAYS = "7";
    assert.equal(audit.retentionDays(), 7);
    process.env.AUDIT_RETENTION_DAYS = "garbage";
    assert.equal(audit.retentionDays(), 30);
    process.env.AUDIT_RETENTION_DAYS = "0";
    reset([{ ts: daysAgo(400), subject: "Ancient @ Company A" }]);
    assert.equal(audit.startRetentionJob().days, 0);
    assert.equal(audit.listEntries().length, 1, "nothing is purged when retention is off");
    assert.deepEqual(audit.purgeOlderThan(0, NOW), { kept: 1, removed: 0 });
  } finally {
    if (saved === undefined) delete process.env.AUDIT_RETENTION_DAYS; else process.env.AUDIT_RETENTION_DAYS = saved;
  }
});

test("startRetentionJob purges old entries immediately", () => {
  const saved = process.env.AUDIT_RETENTION_DAYS;
  try {
    process.env.AUDIT_RETENTION_DAYS = "30";
    reset([{ ts: daysAgo(90), subject: "Stale @ Company A" }, { ts: daysAgo(0), subject: "Fresh @ Company A" }]);
    const result = audit.startRetentionJob();
    assert.equal(result.removed, 1);
    assert.equal(result.days, 30);
    assert.deepEqual(audit.listEntries().map((e) => e.subject), ["Fresh @ Company A"]);
  } finally {
    if (saved === undefined) delete process.env.AUDIT_RETENTION_DAYS; else process.env.AUDIT_RETENTION_DAYS = saved;
  }
});

test("erasure request: delete every entry about one person, leave everyone else", () => {
  reset([
    { ts: daysAgo(1), subject: "Jane Roe @ Company A", risk: "clear" },
    { ts: daysAgo(2), type: "email_draft", subject: "Jane Roe @ Company A" },
    { ts: daysAgo(3), subject: "Jane Roe @ Company B" },
    { ts: daysAgo(4), subject: "Janet Roe @ Company A" },
    { ts: daysAgo(5), subject: "John Smith @ Company C" }
  ]);
  assert.deepEqual(audit.deleteForPerson({ name: "jane roe", company: "Company A" }), { removed: 2, kept: 3 });
  assert.deepEqual(audit.listEntries().map((e) => e.subject), ["Jane Roe @ Company B", "Janet Roe @ Company A", "John Smith @ Company C"]);
  assert.deepEqual(audit.deleteForPerson({ name: "Jane Roe" }), { removed: 1, kept: 2 }, "no company: every company");
  assert.deepEqual(audit.deleteForPerson({ name: "Nobody Here" }), { removed: 0, kept: 2 });
  assert.throws(() => audit.deleteForPerson({ name: "  " }), /name is required/);
});

test("delete-all removes the log file; an empty or missing log is handled", () => {
  reset([{ ts: daysAgo(1), subject: "A B @ Company A" }]);
  assert.deepEqual(audit.deleteAll(), { removed: 1, kept: 0 });
  assert.equal(fs.existsSync(file()), false);
  assert.deepEqual(audit.listEntries(), []);
  assert.deepEqual(audit.purgeOlderThan(30, NOW), { kept: 0, removed: 0 });
  assert.deepEqual(audit.deleteForPerson({ name: "Anyone" }), { removed: 0, kept: 0 });
});

test("deleting the last entry leaves no empty file and no temp files behind", () => {
  reset([{ ts: daysAgo(1), subject: "Only One @ Company A" }]);
  audit.deleteForPerson({ name: "Only One" });
  assert.equal(fs.existsSync(file()), false);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

test("command-line tool: list, delete with confirmation, delete-all needs --yes", () => {
  reset([{ ts: daysAgo(1), subject: "Jane Roe @ Company A", risk: "clear" }, { ts: daysAgo(1), subject: "John Smith @ Company C", risk: "review" }]);
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, "..", "tools", "audit-log.js"), ...args], { env: { ...process.env, OUTREACH_AUDIT_DIR: dir }, encoding: "utf8" });
  const list = run("list");
  assert.match(list.stdout, /2 entries/);
  assert.match(list.stdout, /Jane Roe @ Company A\s+\[clear\]/);
  assert.match(run("delete", "--name", "Jane Roe").stdout, /Removed 1 entry about "Jane Roe"/);
  assert.equal(audit.listEntries().length, 1);
  const refused = run("delete-all");
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /--yes/);
  assert.equal(audit.listEntries().length, 1, "delete-all without --yes changes nothing");
  assert.match(run("delete-all", "--yes").stdout, /Removed the audit log/);
  assert.equal(fs.existsSync(file()), false);
  assert.notEqual(run("delete").status, 0, "delete without a name fails");
});

test("the server's runs write through the same audit module", () => {
  reset([]);
  const { auditLog } = require("../server/outreach");
  auditLog({ ts: daysAgo(0), subject: "Via Outreach @ Company A" });
  assert.equal(audit.listEntries().length, 1);
});
