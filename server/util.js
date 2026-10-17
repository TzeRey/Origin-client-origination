"use strict";

const stripDiacritics = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

function normalize(value) {
  return stripDiacritics(String(value || ""))
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitName(fullName) {
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  const first = parts[0] || "";
  const last = parts.length > 1 ? parts[parts.length - 1] : "";
  return {
    full: parts.join(" "),
    first,
    last,
    incomplete: parts.length < 2 || last.replace(/\./g, "").length < 2
  };
}

/* True when `candidate` plausibly refers to the same person as `query` (first + last token agree). */
function nameCompatible(query, candidate) {
  const q = normalize(query).split(" ").filter(Boolean);
  const c = normalize(candidate).split(" ").filter(Boolean);
  if (!q.length || !c.length) return false;
  const first = q[0];
  const last = q[q.length - 1];
  const hasFirst = c.some((token) => token === first || (first.length === 1 && token.startsWith(first)));
  if (q.length === 1) return hasFirst;
  const hasLast = last.length <= 1 ? c.some((token) => token.startsWith(last)) : c.includes(last);
  return hasFirst && hasLast;
}

function truncate(text, max) {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Fetch JSON with a timeout, cancellation and one optional retry. Error messages never include URLs with query strings or headers. */
async function fetchJson(url, init = {}, { timeoutMs = 30000, signal, retries = 0 } = {}) {
  const host = new URL(url).host;
  let attempt = 0;
  for (;;) {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.any(signals) });
      const text = await res.text();
      if (!res.ok) {
        const error = new Error(`HTTP ${res.status} from ${host}: ${truncate(text.replace(/\s+/g, " "), 220)}`);
        error.status = res.status;
        if (attempt < retries && (res.status === 429 || res.status >= 500)) {
          attempt += 1;
          await sleep(800 * attempt);
          continue;
        }
        throw error;
      }
      return text ? JSON.parse(text) : {};
    } catch (error) {
      if (error.name === "AbortError" || error.name === "TimeoutError") {
        throw new Error(`Timed out or cancelled while calling ${host}`);
      }
      throw error;
    }
  }
}

/* Parse the first JSON object found in model output (tolerates code fences and prose). */
function parseJsonLoose(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/* Run `worker` over `items` with at most `limit` in flight. */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function normalizeUrl(raw) {
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) return "";
    url.hash = "";
    return url.href.replace(/\/$/, "").toLowerCase();
  } catch {
    return "";
  }
}

module.exports = { normalize, splitName, nameCompatible, truncate, sleep, fetchJson, parseJsonLoose, pool, normalizeUrl };