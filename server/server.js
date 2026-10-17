"use strict";

/*
 * Local server for Origin.
 *   GET  /*                  static app files (whitelisted names only)
 *   GET  /api/health         which integrations are configured (booleans only, never keys)
 *   POST /api/outreach       streams the outreach research dossier as NDJSON
 *   POST /api/email-draft    drafts a first-touch email from a dossier
 * API keys are read from the environment / .env on the server and are never sent to the browser.
 * Binds to localhost by default. Run with `npm start`, or `npm run start:mock` for a keyless demo.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { llmConfig } = require("./llm");
const { runOutreach, auditLog } = require("./outreach");
const { runMock } = require("./mock");
const { draftEmail, mockDraft, assertCanContact, cleanEmployer } = require("./email");
const { firecrawlConfigured, usptoEnabled } = require("./tools");
const { startRetentionJob } = require("./audit");

const MOCK = process.argv.includes("--mock") || process.env.OUTREACH_MOCK === "1";
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT) || 8787;
const ROOT = path.join(__dirname, "..");
const MAX_CONCURRENT = 2;
const RUN_TIMEOUT_MS = 240000;
let active = 0;
let activeDrafts = 0;

/* Only these files can be served. Everything else (including .env, server code and logs) is a 404. */
const PUBLIC_FILES = {
  "index.html": "text/html; charset=utf-8",
  "app.html": "text/html; charset=utf-8",
  "styles.css": "text/css; charset=utf-8",
  "landing.css": "text/css; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
  "landing.js": "text/javascript; charset=utf-8",
  "equity-model.js": "text/javascript; charset=utf-8",
  "dossier.js": "text/javascript; charset=utf-8",
  "dossier-pdf.js": "text/javascript; charset=utf-8",
  "compose.js": "text/javascript; charset=utf-8",
  "data-loader.js": "text/javascript; charset=utf-8",
  "data-upload.js": "text/javascript; charset=utf-8",
  "templates/prospects-template.js": "text/javascript; charset=utf-8",
  "templates/company-profiles-template.js": "text/javascript; charset=utf-8",
  "templates/sample-data-pack.js": "text/javascript; charset=utf-8",
  "vendor/jspdf.umd.min.js": "text/javascript; charset=utf-8"
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
};

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

function health() {
  const llm = llmConfig();
  return {
    ok: true,
    mock: MOCK,
    tools: {
      language_model: llm ? llm.provider : null,
      opensanctions: Boolean(process.env.OPENSANCTIONS_API_KEY),
      uspto: usptoEnabled() && Boolean(process.env.USPTO_API_KEY),
      firecrawl: firecrawlConfigured(),
      courtlistener: true,
      openalex: true,
      github: true
    }
  };
}

const str = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

function parseSubject(payload) {
  const subject = {
    name: str(payload.name, 80),
    company: str(payload.company, 60),
    title: str(payload.title, 160),
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(str(payload.startDate, 10)) ? payload.startDate : "",
    department: str(payload.department, 80)
  };
  if (subject.name.length < 2 || !subject.company || !subject.title) return null;
  const eq = payload.equity && typeof payload.equity === "object" ? payload.equity : {};
  subject.equity = {
    estimatedNetEquityMedian: Number.isFinite(eq.netP50) ? Math.round(eq.netP50) : undefined,
    rangeP10: Number.isFinite(eq.netP10) ? Math.round(eq.netP10) : undefined,
    rangeP90: Number.isFinite(eq.netP90) ? Math.round(eq.netP90) : undefined,
    structure: str(eq.structure, 120) || undefined,
    liquidityNote: str(eq.liquidity, 400) || undefined,
    confidence: str(eq.confidence, 20) || undefined
  };
  return subject;
}

async function readBody(req, limit = 20000) {
  /* Some hosts (Vercel's Node runtime, for one) read and parse the body before the handler runs and expose it as req.body.
   * Plain Node leaves req.body undefined, so the stream is read below. */
  let pre;
  try {
    pre = req.body;
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
  if (pre !== undefined && pre !== null) {
    const text = Buffer.isBuffer(pre) ? pre.toString("utf8") : typeof pre === "string" ? pre : JSON.stringify(pre);
    if (Buffer.byteLength(text) > limit) throw Object.assign(new Error("Payload too large"), { status: 413 });
    return text;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Payload too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/* The request's Origin must be this same site. The scheme is ignored on purpose: behind HTTPS hosting the browser's Origin
 * is https://... while this process only sees the Host header. */
function sameSite(origin, host) {
  try {
    return new URL(origin).host.toLowerCase() === String(host || "").toLowerCase();
  } catch {
    return false;
  }
}

/* Shared request guard for the POST APIs: same-origin only, and only from the app's own fetch calls. */
function guardApiRequest(req, res) {
  const origin = req.headers.origin;
  if (origin && !sameSite(origin, req.headers.host)) {
    sendJson(res, 403, { error: "Cross-origin requests are not allowed" });
    return false;
  }
  if (req.headers["x-requested-with"] !== "origin-app" || !String(req.headers["content-type"] || "").includes("application/json")) {
    sendJson(res, 400, { error: "Bad request" });
    return false;
  }
  return true;
}

async function handleOutreach(req, res) {
  if (!guardApiRequest(req, res)) return;
  if (active >= MAX_CONCURRENT) return sendJson(res, 429, { error: "Too many research runs in progress. Try again shortly." });

  let subject;
  try {
    subject = parseSubject(JSON.parse(await readBody(req)));
  } catch (error) {
    return sendJson(res, error.status || 400, { error: error.message || "Invalid JSON" });
  }
  if (!subject) return sendJson(res, 422, { error: "A name, company and title are required" });
  if (!MOCK && !llmConfig() && !process.env.OPENSANCTIONS_API_KEY) {
    return sendJson(res, 503, { error: "No API keys are configured. Add them to .env (see .env.example) or run `npm run start:mock` for a demo." });
  }

  active += 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
  res.on("close", () => controller.abort());
  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", ...SECURITY_HEADERS });
  const emit = (event) => { if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`); };
  try {
    const run = MOCK ? runMock : runOutreach;
    const dossier = await run(subject, emit, { signal: controller.signal, ip: req.socket.remoteAddress });
    emit({ type: "result", dossier });
  } catch (error) {
    emit({ type: "error", message: controller.signal.aborted ? "The research run was cancelled or timed out." : error.message });
  } finally {
    clearTimeout(timer);
    active -= 1;
    if (!res.writableEnded) res.end();
  }
}

/* POST /api/email-draft: drafts a first-touch email from a dossier.
 * Receives the dossier and the sender's employer name only; the sender's personal details never reach this endpoint. */
async function handleEmailDraft(req, res) {
  if (!guardApiRequest(req, res)) return;
  if (activeDrafts >= MAX_CONCURRENT) return sendJson(res, 429, { error: "Too many drafts in progress. Try again shortly." });

  let payload;
  try {
    payload = JSON.parse(await readBody(req, 600000));
  } catch (error) {
    return sendJson(res, error.status || 400, { error: error.message || "Invalid JSON" });
  }
  const dossier = payload && typeof payload.dossier === "object" ? payload.dossier : null;
  if (!dossier?.subject?.name) return sendJson(res, 422, { error: "A dossier is required" });
  const variant = Number.isInteger(payload.variant) ? Math.max(0, Math.min(payload.variant, 9)) : 0;
  const acknowledged = payload.acknowledgeCompliance === true;
  const employer = cleanEmployer(payload.employer);
  if (!employer) return sendJson(res, 422, { error: "A valid employer name is required (letters, numbers and basic punctuation, up to 80 characters)." });

  if (!MOCK && !llmConfig()) {
    return sendJson(res, 503, { error: "No language-model key is configured. Add OPENROUTER_API_KEY to .env (see .env.example) or run `npm run start:mock` for a demo." });
  }
  activeDrafts += 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  res.on("close", () => controller.abort());
  try {
    assertCanContact(dossier, acknowledged);
    const draft = MOCK ? mockDraft(dossier, { variant, employer }) : await draftEmail(dossier, { acknowledged, variant, employer, signal: controller.signal });
    auditLog({
      ts: new Date().toISOString(),
      type: "email_draft",
      ip: req.socket.remoteAddress,
      subject: `${String(dossier.subject.name).slice(0, 80)} @ ${String(dossier.subject.company || "").slice(0, 60)}`,
      risk: dossier.complianceRisk,
      acknowledged,
      variant,
      mode: MOCK ? "mock" : "live",
      model: draft.model
    });
    return sendJson(res, 200, draft);
  } catch (error) {
    const status = error.status || (controller.signal.aborted ? 504 : 502);
    return sendJson(res, status, { error: controller.signal.aborted ? "The draft timed out. Try again." : error.message, needsAcknowledgement: Boolean(error.needsAcknowledgement) });
  } finally {
    clearTimeout(timer);
    activeDrafts -= 1;
  }
}

function serveStatic(req, res, pathname) {
  const name = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const type = Object.hasOwn(PUBLIC_FILES, name) ? PUBLIC_FILES[name] : null;
  if (!type) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
    return res.end("Not found");
  }
  fs.readFile(path.join(ROOT, name), (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache", ...SECURITY_HEADERS });
    res.end(data);
  });
}

/* Routes one request. Used by the local server below and by the hosted demo's api/ functions. */
function route(req, res) {
  const { pathname } = new URL(req.url, "http://localhost");
  if (pathname === "/api/health" && req.method === "GET") return sendJson(res, 200, health());
  if (pathname === "/api/outreach" && req.method === "POST") return handleOutreach(req, res);
  if (pathname === "/api/email-draft" && req.method === "POST") return handleEmailDraft(req, res);
  if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, pathname);
  return sendJson(res, 405, { error: "Method not allowed" });
}

const server = http.createServer(route);

if (require.main === module) {
  server.on("error", (error) => {
    console.error(error.code === "EADDRINUSE" ? `Port ${PORT} is already in use. Stop the other server or set PORT to a different number.` : error.message);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    const h = health();
    console.log(`Origin is running at http://${HOST}:${PORT}/app.html${MOCK ? "  (DEMO MODE: synthetic data)" : ""}`);
    console.log(`Tools: ${Object.entries(h.tools).map(([k, v]) => `${k}=${v ? "on" : "off"}`).join(", ")}`);
    const retention = startRetentionJob();
    console.log(retention.days
      ? `Audit log retention: ${retention.days} days (purged ${retention.removed} old entr${retention.removed === 1 ? "y" : "ies"}, ${retention.kept} kept). Manage it with: npm run audit -- list`
      : "Audit log retention: OFF (AUDIT_RETENTION_DAYS=0). Entries are kept until you delete them: npm run audit -- delete-all --yes");
  });
}

module.exports = { server, route, health, parseSubject, readBody, PUBLIC_FILES, SECURITY_HEADERS };
