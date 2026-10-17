"use strict";

/* The server and page wiring for the "upload your data or try the sample" flow. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

process.env.OUTREACH_AUDIT_DIR = path.join(require("node:os").tmpdir(), "origin-test-audit");
const { server } = require("../server/server");
const DataLoader = require("../data-loader.js");
const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: urlPath }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on("error", reject);
  });
}

test("no prospect data file ships with the app", () => {
  assert.equal(fs.existsSync(path.join(__dirname, "..", "prospects-data.js")), false, "prospects-data.js must not exist");
  assert.equal(fs.existsSync(path.join(__dirname, "..", "tools", "generate-synthetic-prospects.js")), false, "the generator that wrote it is gone too");
  for (const file of ["app.html", "app.js", "data-upload.js", "equity-model.js", "server/server.js", "README.md"]) {
    assert.ok(!/prospects-data/.test(read(file)), `${file} must not refer to prospects-data.js`);
  }
});

test("the page opens with two upload sections where the loading animation used to start", () => {
  const html = read("app.html");
  assert.match(html, /<section class="data-prompt" id="dataPrompt"/, "the prompt exists");
  assert.match(html, /id="slotProspects"[\s\S]*?id="fileProspects"/, "section 1: prospects, with its own file chooser");
  assert.match(html, /id="slotProfiles"[\s\S]*?id="fileProfiles"/, "section 2: company profiles, with its own file chooser");
  assert.ok(html.indexOf('id="slotProspects"') < html.indexOf('id="slotProfiles"'), "prospects first, then company profiles");
  assert.match(html, /href="templates\/prospects-template\.js"/);
  assert.match(html, /href="templates\/company-profiles-template\.js"/);
  assert.match(html, /id="continueButton"[^>]*\shidden/, "continue-without-profiles is hidden until it applies");
  assert.match(html, /id="sampleButton"/, "and a button for the sample data");
  assert.match(html, /id="cardLoading"[^>]*\shidden/, "the loading animation starts hidden");
  assert.match(html, /id="discoveryResults"\s+hidden/, "results start hidden");
  assert.match(html, /id="discoveryToolbar"\s+hidden/, "filters start hidden (nothing to filter yet)");
  const prompt = html.indexOf('id="dataPrompt"');
  const loading = html.indexOf('id="cardLoading"');
  const results = html.indexOf('id="discoveryResults"');
  assert.ok(prompt < loading && loading < results, "prompt, then loading animation, then results");
});

test("there is no Skip animation button and no Simulate loading button", () => {
  const html = read("app.html");
  const app = read("app.js");
  const styles = read("styles.css");
  assert.ok(!/skipLoading|Skip animation|skip-loading/.test(html + app + styles), "Skip animation is gone");
  assert.ok(!/reloadButton|Simulate loading|triggerReload|reload-label/.test(html + app + styles), "Simulate loading is gone");
});

test("after data arrives the loading animation plays before the results (state logic in app.js)", () => {
  const app = read("app.js");
  assert.match(app, /function startLoading\(\)[\s\S]*?showView\("loading"\)[\s\S]*?setTimeout\(finishLoading, 5000\)/, "loading shows for 5s");
  assert.match(app, /function finishLoading\(\)[\s\S]*?showView\(prospects\.length \? "results" : "empty"\)/);
  assert.match(app, /function advance\(\)[\s\S]*?startLoading\(\)/, "loading a file starts the animation (once both parts are in, or on replace)");
  assert.match(app, /function loadSample\(pack\)[\s\S]*?startLoading\(\)/, "so does the sample");
  assert.match(app, /function continueWithoutProfiles\(\)[\s\S]*?startLoading\(\)/, "and continuing without company profiles");
  assert.match(app, /function clearData\(\)[\s\S]*?showView\("empty"\)/, "Load different data returns to the prompt");
});

test("server: serves the sample pack, the template and the app scripts; refuses everything else", async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const sample = await get(port, "/templates/sample-data-pack.js");
    assert.equal(sample.status, 200);
    assert.match(sample.headers["content-type"], /javascript/);
    assert.equal(sample.headers["cache-control"], "no-cache");
    const pack = DataLoader.parsePack(sample.body);
    assert.equal(pack.counts.valid, 14, "what the server sends is a valid data pack");
    assert.equal((await get(port, "/templates/prospects-template.js")).status, 200);
    assert.equal((await get(port, "/templates/company-profiles-template.js")).status, 200);
    assert.equal((await get(port, "/data-upload.js")).status, 200);
    assert.equal((await get(port, "/data-loader.js")).status, 200);
    assert.equal((await get(port, "/app.html")).status, 200);
    for (const forbidden of ["/prospects-data.js", "/private/real-data-pack.js", "/.env", "/server/server.js", "/tests/model.test.js", "/templates/../server/server.js", "/logs/outreach-audit.jsonl", "/__proto__", "/constructor"]) {
      assert.equal((await get(port, forbidden)).status, 404, forbidden);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the sample pack and template contain no real-looking personal data", () => {
  for (const file of ["templates/sample-data-pack.js", "templates/prospects-template.js"]) {
    const pack = DataLoader.parsePack(read(file));
    for (const p of pack.prospects) assert.match(p.name, /^(Demo|Example) Person \d+$/, `${file}: ${p.name}`);
    assert.ok(!/@|https?:\/\//.test(pack.prospects.map((p) => JSON.stringify(p)).join("")), `${file}: no emails or links in prospects`);
  }
});
