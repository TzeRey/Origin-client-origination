"use strict";

/*
 * Audit log with retention and deletion.
 *
 * Every research run and email draft appends one JSON line to logs/outreach-audit.jsonl (accountability: who researched whom,
 * when, with what compliance status). Because those lines name real people, they are NOT kept forever:
 *   - Automatic retention: entries older than AUDIT_RETENTION_DAYS (default 30) are purged at startup and every 6 hours.
 *     Set AUDIT_RETENTION_DAYS=0 to switch automatic purging off (not recommended).
 *   - Deletion on request: deleteForPerson() removes every entry about one named person (a data-erasure request),
 *     deleteAll() removes the whole log. Both are available from the command line: see tools/audit-log.js.
 * Entries that cannot be parsed or have no valid timestamp are removed by a purge, since their age cannot be verified.
 * Rewrites are atomic (write a temp file, then rename it over the log).
 */
const fs = require("fs");
const path = require("path");

const FILE_NAME = "outreach-audit.jsonl";
const DAY_MS = 86400000;
const PURGE_EVERY_MS = 6 * 3600 * 1000;

const logDir = () => process.env.OUTREACH_AUDIT_DIR || path.join(__dirname, "..", "logs");
const logPath = () => path.join(logDir(), FILE_NAME);

function retentionDays() {
  const raw = process.env.AUDIT_RETENTION_DAYS;
  if (raw === undefined || raw === "") return 30;
  const days = Number(raw);
  return Number.isFinite(days) && days >= 0 ? days : 30;
}

/* Append one entry. Auditing must never break a run, so failures are swallowed. */
function auditLog(entry) {
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    fs.appendFileSync(logPath(), `${JSON.stringify(entry)}\n`);
  } catch {
    /* ignore */
  }
}

function readLines() {
  try {
    return fs.readFileSync(logPath(), "utf8").split("\n").filter((line) => line.trim());
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function parse(line) {
  try {
    const data = JSON.parse(line);
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

function writeLines(lines) {
  const target = logPath();
  if (!lines.length) {
    fs.rmSync(target, { force: true });
    return;
  }
  fs.mkdirSync(logDir(), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${lines.join("\n")}\n`);
  fs.renameSync(temp, target);
}

/* Remove entries older than `days`. Returns { kept, removed }. days <= 0 removes nothing. */
function purgeOlderThan(days = retentionDays(), now = Date.now()) {
  const lines = readLines();
  if (!(days > 0)) return { kept: lines.length, removed: 0 };
  const cutoff = now - days * DAY_MS;
  const keep = lines.filter((line) => {
    const time = Date.parse(parse(line)?.ts);
    return Number.isFinite(time) && time >= cutoff;
  });
  if (keep.length !== lines.length) writeLines(keep);
  return { kept: keep.length, removed: lines.length - keep.length };
}

/* "Jane Roe @ Company A" -> { name: "jane roe", company: "company a" } */
function splitSubject(subject) {
  const text = String(subject ?? "");
  const at = text.lastIndexOf(" @ ");
  return at < 0 ? { name: text.trim().toLowerCase(), company: "" } : { name: text.slice(0, at).trim().toLowerCase(), company: text.slice(at + 3).trim().toLowerCase() };
}

/* Erasure request: delete every entry about one person (optionally limited to one company). Returns { removed, kept }. */
function deleteForPerson({ name, company = "" }) {
  const wantName = String(name ?? "").trim().toLowerCase();
  if (!wantName) throw new Error("A name is required");
  const wantCompany = String(company ?? "").trim().toLowerCase();
  const lines = readLines();
  const keep = lines.filter((line) => {
    const subject = splitSubject(parse(line)?.subject);
    return !(subject.name === wantName && (!wantCompany || subject.company === wantCompany));
  });
  if (keep.length !== lines.length) writeLines(keep);
  return { removed: lines.length - keep.length, kept: keep.length };
}

function deleteAll() {
  const count = readLines().length;
  fs.rmSync(logPath(), { force: true });
  return { removed: count, kept: 0 };
}

/* Summaries for the CLI (no sources or step details). */
function listEntries() {
  return readLines().map((line) => {
    const data = parse(line) || {};
    return { ts: data.ts || "(unreadable)", type: data.type || "research", subject: data.subject || "(unknown)", risk: data.risk || "" };
  });
}

/* Purge now and then every 6 hours while the server runs. Returns the first purge result. */
function startRetentionJob() {
  const days = retentionDays();
  if (!(days > 0)) return { days: 0, kept: readLines().length, removed: 0 };
  const first = purgeOlderThan(days);
  const timer = setInterval(() => {
    try { purgeOlderThan(days); } catch { /* never crash the server over housekeeping */ }
  }, PURGE_EVERY_MS);
  timer.unref?.();
  return { days, ...first };
}

module.exports = { auditLog, purgeOlderThan, deleteForPerson, deleteAll, listEntries, startRetentionJob, retentionDays, logPath };
