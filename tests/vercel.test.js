"use strict";

/* The hosted-demo (Vercel) setup: static build, demo-only API functions, headers and safety nets. */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Readable } = require("node:stream");

/* Keys that must NEVER be used by the hosted demo, even if someone sets them in the Vercel settings. */
process.env.OPENROUTER_API_KEY = "FAKE_OPENROUTER_KEY_FOR_TESTS_ONLY";
process.env.OPENSANCTIONS_API_KEY = "FAKE_OPENSANCTIONS_KEY_FOR_TESTS_ONLY";
process.env.ANTHROPIC_API_KEY = "FAKE_VENDOR_KEY_FOR_TESTS_ONLY";
process.env.USPTO_ENABLED = "true";
process.env.OUTREACH_MOCK_SPEED = "0.01";
delete process.env.OUTREACH_MOCK;

let networkCalls = 0;
global.fetch = () => { networkCalls += 1; throw new Error("the hosted demo must never make a network call"); };

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/* the api/ files, loaded the way Vercel loads them (each file is one function) */
const health = require("../api/health.js");
const outreach = require("../api/outreach.js");
const emailDraft = require("../api/email-draft.js");
const { PUBLIC_FILES, SECURITY_HEADERS, readBody } = require("../server/server");

/* A stand-in for Vercel's routing: /api/<name> runs api/<name>.js, nothing else is served. */
function startFakeVercel() {
  const handlers = { health, outreach, "email-draft": emailDraft };
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, "http://localhost").pathname.replace(/^\/api\//, "");
    const handler = handlers[name];
    if (!handler) { res.writeHead(404); return res.end(); }
    return handler(req, res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function call(port, method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, method, headers: { ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(data);
  });
}
const APP = { "X-Requested-With": "origin-app" };

/* ------------------------------------------------------------------ configuration files */
test("vercel.json: builds the static site, limits function time, and carries the same security headers as the local server", () => {
  const config = JSON.parse(read("vercel.json"));
  assert.equal(config.buildCommand, "node tools/build-demo.js");
  assert.equal(config.outputDirectory, "public");
  assert.ok(config.functions["api/*.js"].maxDuration <= 60, "stays within a conservative function time limit");
  const headers = Object.fromEntries(config.headers.find((h) => h.source === "/(.*)").headers.map((h) => [h.key, h.value]));
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) assert.equal(headers[key], value, `${key} matches the local server`);
  assert.match(headers["Content-Security-Policy"], /script-src 'self'/);
});

test("ignore files keep private data, keys, logs and tests out of the upload and the repository", () => {
  const vercelIgnore = read(".vercelignore");
  for (const entry of ["private/", ".env", "logs/", "tests/", "public/"]) assert.ok(vercelIgnore.split("\n").includes(entry), `.vercelignore lists ${entry}`);
  assert.ok(!/^tools\/?$/m.test(vercelIgnore) && !/^server\/?$/m.test(vercelIgnore), "tools/ and server/ stay: the build and the functions need them");
  const gitIgnore = read(".gitignore");
  for (const entry of ["private/", ".env", "logs/", "public/"]) assert.ok(gitIgnore.split("\n").includes(entry), `.gitignore lists ${entry}`);
});

/* ------------------------------------------------------------------ the static build */
test("the build publishes exactly the whitelisted files and nothing else", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "origin-site-"));
  const run = spawnSync(process.execPath, [path.join(ROOT, "tools", "build-demo.js"), out], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const published = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full); else published.push(path.relative(out, full).split(path.sep).join("/"));
    }
  })(out);
  assert.deepEqual(published.sort(), Object.keys(PUBLIC_FILES).sort());
  for (const name of published) assert.equal(sha(path.join(out, name)), sha(path.join(ROOT, name)), `${name} is an exact copy`);
  for (const secret of ["server", "api", "tests", "tools", "private", ".env", "README.md", "logs", "package.json", "vercel.json"]) {
    assert.ok(!published.some((f) => f === secret || f.startsWith(`${secret}/`)), `${secret} is not published`);
  }
  assert.ok(published.includes("templates/sample-data-pack.js") && published.includes("app.html") && published.includes("index.html"));
});

test("the build refuses to delete the project or anything above it", () => {
  for (const target of [ROOT, path.dirname(ROOT)]) {
    const run = spawnSync(process.execPath, [path.join(ROOT, "tools", "build-demo.js"), target], { encoding: "utf8" });
    assert.notEqual(run.status, 0, target);
    assert.match(run.stderr, /Refusing/);
  }
  assert.ok(fs.existsSync(path.join(ROOT, "app.html")), "nothing was deleted");
  assert.ok(fs.existsSync(path.join(ROOT, "server", "server.js")));
});

/* ------------------------------------------------------------------ the demo-only API functions */
test("demo functions remove live keys from the process and keep their log out of the project", () => {
  for (const key of ["OPENROUTER_API_KEY", "OPENSANCTIONS_API_KEY", "ANTHROPIC_API_KEY", "USPTO_ENABLED"]) assert.equal(process.env[key], undefined, `${key} was removed`);
  assert.equal(process.env.OUTREACH_MOCK, "1");
  assert.ok(process.env.OUTREACH_AUDIT_DIR.startsWith(os.tmpdir()), "any log goes to temporary storage");
});

test("health reports demo mode with every live tool off, even though keys were set", async () => {
  const server = await startFakeVercel();
  try {
    const res = await call(server.address().port, "GET", "/api/health");
    assert.equal(res.status, 200);
    const json = JSON.parse(res.text);
    assert.equal(json.mock, true);
    assert.equal(json.tools.language_model, null);
    assert.equal(json.tools.opensanctions, false);
    assert.equal(json.tools.uspto, false);
  } finally { server.close(); }
});

test("research streams a SYNTHETIC dossier with no network calls, over a request that looks like a browser on HTTPS", async () => {
  const server = await startFakeVercel();
  try {
    const port = server.address().port;
    const res = await call(port, "POST", "/api/outreach", {
      body: { name: "Demo Person 3", company: "Demo Company A", title: "Principal Engineer", startDate: "2019-09-01" },
      headers: { ...APP, Origin: `https://127.0.0.1:${port}` }
    });
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /ndjson/);
    assert.match(res.headers["content-security-policy"], /script-src 'self'/);
    const events = res.text.trim().split("\n").map((l) => JSON.parse(l));
    const result = events.find((e) => e.type === "result");
    assert.ok(result, "a dossier arrives");
    assert.equal(result.dossier.meta.mode, "mock");
    assert.match(result.dossier.meta.notice, /DEMO MODE/);
    assert.ok(events.filter((e) => e.type === "step").length > 10, "progress steps stream");
    assert.equal(networkCalls, 0, "no network call was made");
  } finally { server.close(); }
});

test("email drafting returns a SYNTHETIC draft that carries the employer name, with no network calls", async () => {
  const server = await startFakeVercel();
  try {
    const port = server.address().port;
    const dossier = { subject: { name: "Demo Person 3", company: "Demo Company A", title: "Principal Engineer" }, complianceRisk: "clear", summary: "s", sources: [] };
    const res = await call(port, "POST", "/api/email-draft", { body: { dossier, variant: 0, employer: "Harbor & Pine Private Bank" }, headers: { ...APP, Origin: `https://127.0.0.1:${port}` } });
    assert.equal(res.status, 200);
    const draft = JSON.parse(res.text);
    assert.match(draft.subject, /^\[Demo\]/);
    assert.equal(draft.model, "demo");
    assert.match(draft.body, /private banking at Harbor & Pine Private Bank/);
    assert.equal(networkCalls, 0);
  } finally { server.close(); }
});

test("the same-site check works for https origins, and still rejects other sites and missing headers", async () => {
  const server = await startFakeVercel();
  try {
    const port = server.address().port;
    const body = { name: "Demo Person 3", company: "Demo Company A", title: "Engineer" };
    const other = await call(port, "POST", "/api/outreach", { body, headers: { ...APP, Origin: "https://evil.example" } });
    assert.equal(other.status, 403);
    const garbage = await call(port, "POST", "/api/outreach", { body, headers: { ...APP, Origin: "not a url" } });
    assert.equal(garbage.status, 403);
    const noHeader = await call(port, "POST", "/api/outreach", { body, headers: { Origin: `https://127.0.0.1:${port}` } });
    assert.equal(noHeader.status, 400);
    const wrongMethod = await call(port, "GET", "/api/outreach");
    assert.ok([404, 405].includes(wrongMethod.status));
  } finally { server.close(); }
});

test("the demo handler serves nothing but the API: other paths are a 404, never a file", async () => {
  const demo = require("../api/_demo.js");
  const server = http.createServer((req, res) => demo.handle(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const p of ["/server/server.js", "/.env", "/private/real-data-pack.js", "/app.html", "/README.md"]) {
      const res = await call(server.address().port, "GET", p);
      assert.equal(res.status, 404, p);
    }
  } finally { server.close(); }
});

test("fail closed: if the server was loaded in live mode first, the demo functions refuse to start", () => {
  const code = `process.env.OPENROUTER_API_KEY = "FAKE"; delete process.env.OUTREACH_MOCK; require("./server/server"); try { require("./api/health.js"); console.log("STARTED"); } catch (e) { console.log("REFUSED: " + e.message); }`;
  const run = spawnSync(process.execPath, ["-e", code], { cwd: ROOT, encoding: "utf8", env: { ...process.env, OUTREACH_MOCK: "" } });
  assert.match(run.stdout, /REFUSED: Refusing to start: the hosted demo functions must run in mock mode/);
  assert.doesNotMatch(run.stdout, /STARTED/);
});

/* ------------------------------------------------------------------ request bodies on different hosts */
test("readBody works whether the host pre-parses the body (Vercel) or leaves the stream alone (plain Node)", async () => {
  assert.equal(await readBody(Readable.from([Buffer.from('{"a":1}')])), '{"a":1}');
  assert.equal(await readBody(Object.assign(Readable.from([Buffer.from("tail")]), { body: undefined })), "tail");
  assert.equal(await readBody({ body: { a: 1 } }), '{"a":1}');
  assert.equal(await readBody({ body: '{"b":2}' }), '{"b":2}');
  assert.equal(await readBody({ body: Buffer.from('{"c":3}') }), '{"c":3}');
  assert.equal(await readBody(Object.assign(Readable.from([Buffer.from("from-stream")]), { body: null })), "from-stream");
});

test("readBody enforces the size limit and turns a failing pre-parse into a 400", async () => {
  await assert.rejects(() => readBody({ body: { big: "x".repeat(500) } }, 100), (e) => e.status === 413);
  await assert.rejects(() => readBody(Readable.from([Buffer.alloc(500)]), 100), (e) => e.status === 413);
  const broken = {};
  Object.defineProperty(broken, "body", { get() { throw new SyntaxError("Unexpected token"); } });
  await assert.rejects(() => readBody(broken), (e) => e.status === 400);
});

/* ------------------------------------------------------------------ the page */
test("the page tells visitors when it is in demo mode, using the health endpoint", () => {
  const html = read("app.html");
  assert.match(html, /id="demoBanner"[^>]*\shidden/);
  assert.match(html, /synthetic placeholders and no live lookups are made/);
  assert.match(read("app.js"), /health\?\.mock/);
});
