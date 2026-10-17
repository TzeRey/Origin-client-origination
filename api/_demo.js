"use strict";

/*
 * Shared handler for the hosted DEMO deployment (Vercel). Files in api/ whose name starts with an underscore are not
 * exposed as routes, so this file is only ever used by api/health.js, api/outreach.js and api/email-draft.js.
 *
 * The hosted demo is ALWAYS mock mode:
 *   - research dossiers and email drafts are synthetic placeholders; no live lookups and no AI calls are ever made;
 *   - any API keys that happen to be set in the project's environment are removed from this process, so a mistake in
 *     the Vercel settings can never make the public demo spend credits or research a real person;
 *   - nothing is stored (the audit log would only be written to temporary storage, and mock runs do not write it).
 * To run the real thing, use `npm start` on your own machine (see the README), not this deployment.
 */
const os = require("node:os");
const path = require("node:path");

process.env.OUTREACH_MOCK = "1";
process.env.OUTREACH_MOCK_SPEED = process.env.OUTREACH_MOCK_SPEED || "0.5"; // about 5 seconds for a research run
process.env.OUTREACH_AUDIT_DIR = path.join(os.tmpdir(), "origin-demo-audit");
for (const key of [
  "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "OUTREACH_MODEL", "OPENSANCTIONS_API_KEY", "COURTLISTENER_TOKEN",
  "GITHUB_TOKEN", "FIRECRAWL_API_KEY", "USPTO_API_KEY", "USPTO_ENABLED", "USPTO_API_BASE", "OPENALEX_MAILTO"
]) delete process.env[key];

const { route, health } = require("../server/server");

/* Fail closed: if the server module was somehow loaded in live mode first, refuse to start rather than risk a live run. */
if (!health().mock) throw new Error("Refusing to start: the hosted demo functions must run in mock mode.");

function handle(req, res) {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (!pathname.startsWith("/api/")) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }
  return route(req, res);
}

module.exports = { handle };
