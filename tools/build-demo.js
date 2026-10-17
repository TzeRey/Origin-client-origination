#!/usr/bin/env node
/*
 * Builds the static site for the hosted demo into public/ (git-ignored). Vercel runs this as its build command.
 *
 *   node tools/build-demo.js [output folder]
 *
 * It copies ONLY the files the app is allowed to serve (the same whitelist the local server uses), so server code,
 * tests, tools, documentation, .env and private data are never published.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { PUBLIC_FILES } = require("../server/server");

const root = path.resolve(__dirname, "..");
const out = path.resolve(process.argv[2] || path.join(root, "public"));

/* Never delete the project itself or any folder above it. */
if (out === root || root.startsWith(out + path.sep)) {
  console.error(`Refusing to use ${out} as the output folder: it contains the project.`);
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
let count = 0;
for (const name of Object.keys(PUBLIC_FILES)) {
  const from = path.join(root, name);
  if (!fs.existsSync(from)) {
    console.error(`Missing file listed in the whitelist: ${name}`);
    process.exit(1);
  }
  const to = path.join(out, name);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  count += 1;
}
console.log(`Built the demo site: ${count} files in ${out}`);
