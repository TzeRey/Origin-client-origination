#!/usr/bin/env node
/*
 * Manage the audit log (logs/outreach-audit.jsonl), which records who was researched and when.
 *
 *   npm run audit -- list                              show what is stored (names, dates, risk; nothing else)
 *   npm run audit -- purge [--days 30]                 delete entries older than N days (default AUDIT_RETENTION_DAYS or 30)
 *   npm run audit -- delete --name "Jane Roe" [--company "Company A"]
 *                                                       erase every entry about one person (data-erasure request)
 *   npm run audit -- delete-all --yes                  erase the whole log
 *
 * Run it while the server is idle: the server appends to the same file.
 */
const audit = require("../server/audit");

function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "list") {
    const entries = audit.listEntries();
    console.log(`${entries.length} entr${entries.length === 1 ? "y" : "ies"} in ${audit.logPath()} (automatic retention: ${audit.retentionDays() || "off"} days)`);
    for (const e of entries) console.log(`${e.ts}  ${e.type.padEnd(12)} ${e.subject}${e.risk ? `  [${e.risk}]` : ""}`);
  } else if (command === "purge") {
    const days = flag(args, "days") !== undefined ? Number(flag(args, "days")) : audit.retentionDays();
    if (!(days > 0)) throw new Error("Give a positive number of days, for example: purge --days 30");
    const r = audit.purgeOlderThan(days);
    console.log(`Removed ${r.removed} entr${r.removed === 1 ? "y" : "ies"} older than ${days} days; ${r.kept} kept.`);
  } else if (command === "delete") {
    const name = flag(args, "name");
    if (!name) throw new Error('Give a name, for example: delete --name "Jane Roe" [--company "Company A"]');
    const r = audit.deleteForPerson({ name, company: flag(args, "company") });
    console.log(`Removed ${r.removed} entr${r.removed === 1 ? "y" : "ies"} about "${name}"; ${r.kept} kept.`);
  } else if (command === "delete-all") {
    if (!args.includes("--yes")) throw new Error("This erases the whole audit log. Re-run with --yes to confirm.");
    const r = audit.deleteAll();
    console.log(`Removed the audit log (${r.removed} entr${r.removed === 1 ? "y" : "ies"}).`);
  } else {
    console.log("Usage: npm run audit -- <list | purge [--days N] | delete --name \"Full Name\" [--company X] | delete-all --yes>");
    process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
