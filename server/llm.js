"use strict";

/*
 * Language-model client. Claude Sonnet is reached through OpenRouter (default) or the Anthropic API.
 * Both providers can ground an answer with live web search; citations are returned so callers can verify URLs.
 */
const { fetchJson, truncate, normalizeUrl } = require("./util");

function llmConfig() {
  if (process.env.OPENROUTER_API_KEY) {
    return {
      provider: "openrouter",
      key: process.env.OPENROUTER_API_KEY,
      model: process.env.OUTREACH_MODEL || "anthropic/claude-sonnet-5.5"
    };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: "anthropic",
      key: process.env.ANTHROPIC_API_KEY,
      model: process.env.OUTREACH_MODEL || process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5"
    };
  }
  return null;
}

function dedupeCitations(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = normalizeUrl(item.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ url: item.url, title: item.title || "", snippet: item.snippet || "" });
  }
  return out;
}

async function viaOpenRouter(cfg, { system, user, web, maxTokens, signal, temperature }) {
  const body = {
    model: cfg.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    max_tokens: maxTokens,
    temperature: temperature ?? 0.2
  };
  if (web) body.plugins = [{ id: "web", max_results: web.maxResults || 6 }];
  const json = await fetchJson(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost",
        "X-Title": "Origin outreach agent"
      },
      body: JSON.stringify(body)
    },
    { timeoutMs: web ? 150000 : 100000, signal, retries: 1 }
  );
  const message = json.choices?.[0]?.message || {};
  const text = typeof message.content === "string"
    ? message.content
    : (message.content || []).map((part) => part.text || "").join("");
  const citations = (message.annotations || [])
    .filter((a) => a.type === "url_citation" && a.url_citation?.url)
    .map((a) => ({ url: a.url_citation.url, title: a.url_citation.title, snippet: truncate(a.url_citation.content || "", 500) }));
  return { text, citations: dedupeCitations(citations), usage: json.usage || null };
}

async function viaAnthropic(cfg, { system, user, web, maxTokens, signal, temperature }) {
  const body = {
    model: cfg.model,
    max_tokens: maxTokens,
    temperature: temperature ?? 0.2,
    system,
    messages: [{ role: "user", content: user }]
  };
  if (web) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: Math.min(web.maxResults || 5, 8) }];
  const json = await fetchJson(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: { "x-api-key": cfg.key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body)
    },
    { timeoutMs: web ? 150000 : 100000, signal, retries: 1 }
  );
  const blocks = json.content || [];
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text || "").join("");
  const citations = [];
  for (const block of blocks) {
    if (block.type === "text") {
      for (const c of block.citations || []) {
        if (c.url) citations.push({ url: c.url, title: c.title, snippet: truncate(c.cited_text || "", 500) });
      }
    } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content) {
        if (r.url) citations.push({ url: r.url, title: r.title, snippet: "" });
      }
    }
  }
  return { text, citations: dedupeCitations(citations), usage: json.usage || null };
}

async function complete({ system, user, web = null, maxTokens = 2500, signal, temperature }) {
  const cfg = llmConfig();
  if (!cfg) throw new Error("No language-model key configured (set OPENROUTER_API_KEY or ANTHROPIC_API_KEY).");
  const args = { system, user, web, maxTokens, signal, temperature };
  return cfg.provider === "openrouter" ? viaOpenRouter(cfg, args) : viaAnthropic(cfg, args);
}

module.exports = { llmConfig, complete };
