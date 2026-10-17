"use strict";

/* PDF export tests: build the dossier PDF in Node (no browser). Run with `npm test`. */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.OUTREACH_MOCK_FAST = "1"; // skip the demo generator's artificial delays

const { jsPDF } = require(path.join(__dirname, "..", "vendor", "jspdf.umd.min.js"));
global.window = global.window || {};
require("../dossier-pdf.js");
const { runMock } = require("../server/mock");
const PDF = global.window.DossierPDF;

const SUBJECT = { name: "Jane Roe", company: "Testco", title: "Principal Research Scientist", startDate: "2021-04-01" };
const bytes = (doc) => Buffer.from(doc.output("arraybuffer"));

test("builds a valid multi-section PDF from a dossier", async () => {
  const dossier = await runMock(SUBJECT, () => {}, {});
  const doc = PDF.build(dossier, jsPDF);
  const buf = bytes(doc);
  assert.equal(buf.slice(0, 5).toString(), "%PDF-");
  assert.ok(doc.getNumberOfPages() >= 2);
  assert.match(buf.toString("latin1"), /Jane Roe/); // document title metadata is uncompressed
  assert.match(PDF.filename(dossier), /^jane-roe-dossier-\d{4}-\d{2}-\d{2}-DEMO\.pdf$/);
});

test("long content paginates and never throws on awkward input", async () => {
  const dossier = await runMock(SUBJECT, () => {}, {});
  const longUrl = `https://example.com/${"segment-".repeat(60)}`;
  const item = (i) => ({ title: `Item ${i} ${"word ".repeat(40)}`, type: "news", summary: "Sentence. ".repeat(80), url: longUrl, date: "2025", matchConfidence: "high", grounded: true });
  dossier.press = { findings: Array.from({ length: 30 }, (_, i) => item(i)), unverified: [item(99)], notes: "n" };
  dossier.summary = "Long. ".repeat(500);
  const doc = PDF.build(dossier, jsPDF);
  assert.ok(doc.getNumberOfPages() >= 8);
  // minimal dossier with every optional section missing
  const bare = { meta: { mode: "live" }, subject: { name: "X", title: "T", company: "C" }, complianceRisk: "unscreened", summary: "s" };
  assert.ok(PDF.build(bare, jsPDF).getNumberOfPages() >= 1);
});

test("only http(s) links become clickable; script URLs are not", async () => {
  const dossier = await runMock(SUBJECT, () => {}, {});
  dossier.press = { findings: [
    { title: "Safe", url: "https://example.com/a", summary: "s", matchConfidence: "high", grounded: true },
    { title: "Unsafe", url: "javascript:alert(1)", summary: "s", matchConfidence: "high", grounded: false }
  ], unverified: [], notes: "" };
  dossier.sources = [{ title: "bad", url: "data:text/html,<script>1</script>" }, { title: "ok", url: "https://example.com/ok" }];
  const raw = bytes(PDF.build(dossier, jsPDF)).toString("latin1");
  assert.match(raw, /\/URI \(https:\/\/example\.com\/a\)/);
  assert.ok(!/javascript:/i.test(raw), "javascript: URL must not be linked");
  assert.ok(!/data:text\/html/i.test(raw), "data: URL must not be linked");
});

test("text is normalised for the PDF's Latin-1 fonts and filenames are safe", () => {
  assert.equal(PDF.clean("Zo\u00eb \u2013 \u201Cq\u201D \u2248 5\u00d7"), 'Zo\u00eb - "q" ~ 5\u00d7');
  assert.equal(PDF.clean("\u5317\u4eac"), "??");
  assert.equal(PDF.clean("a\u0000b"), "a?b");
  const name = PDF.filename({ subject: { name: "Zo\u00eb M\u00fcller-O\u2019Brien" }, meta: { mode: "live", generatedAt: "2026-10-03T00:00:00Z" } });
  assert.equal(name, "zoe-muller-o-brien-dossier-2026-10-03.pdf");
  assert.ok(!/[\\/:*?"<>|]/.test(PDF.filename({ subject: { name: '../../evil:"name' }, meta: { mode: "live" } })));
});
