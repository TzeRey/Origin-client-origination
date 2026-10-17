/*
 * Origin equity estimator.
 *
 * Produces a MODELED range of after-tax equity for a person from public data only
 * (title, company, start date). Nothing here is a verified holding.
 *
 * The model is company-agnostic and starts EMPTY. Everything that is specific to one employer lives in a COMPANY
 * PROFILE: funding-round history, vesting schedule, trigger structure (single vs double), tender offers, a level
 * ladder with average stock value per year, and a few reference values. Profiles come only from a data file the
 * user loads (see templates/company-profiles-template.js; templates/sample-data-pack.js is a small fictional example).
 * A prospect whose company has no profile is listed but not estimated: the model never invents company figures.
 *
 * Pipeline per person (Monte Carlo over assumption uncertainty):
 *   1. Pay-level band -> initial grant (4-year value), scaled down for earlier hires by valuation at hire.
 *   2. Explicit annual refresh grants (0-50% of the initial grant) on each anniversary.
 *   3. The profile's vesting schedule evaluated month by month.
 *   4. The profile's tender offers: part of vested holdings is sold at the tender price (subject to caps).
 *   5. Taxes: single-trigger RSUs are taxed as ordinary income at vest (then capital gains on sale);
 *      double-trigger RSUs are taxed as ordinary income when they settle (tender or IPO).
 *   6. Outputs: after-tax net equity (tender cash + remaining equity after hypothetical liquidation tax).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.EquityModel = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const AS_OF = new Date("2026-09-30T00:00:00Z");
  const SCENARIOS = 1500;

  const TENDER_ELIGIBLE_AFTER_YEARS = 1;

  /* ------------------------------------------------------------------ taxes */
  /* Marginal; equity income stacks on top of salary so the top bracket applies. */
  const TAX_PROFILES = {
    "CA-SF": {
      label: "California (San Francisco)",
      federalOrdinary: 0.37,
      medicare: 0.0235,
      state: 0.133,
      local: 0,
      federalLtcg: 0.2,
      niit: 0.038,
      stateLtcg: 0.133,
      localLtcg: 0,
      note: "Federal 37% + Medicare 2.35% + CA 13.3% (incl. 1% mental-health surcharge); SF levies no personal income tax. Capital gains: 20% + 3.8% NIIT + CA 13.3%."
    },
    "NY-NYC": {
      label: "New York City",
      federalOrdinary: 0.37,
      medicare: 0.0235,
      state: 0.109,
      local: 0.03876,
      federalLtcg: 0.2,
      niit: 0.038,
      stateLtcg: 0.109,
      localLtcg: 0.03876,
      note: "Federal 37% + Medicare 2.35% + NY 10.9% + NYC 3.876%."
    }
  };
  const DEFAULT_TAX_PROFILE = "CA-SF";
  function taxRates(profileKey) {
    const p = TAX_PROFILES[profileKey] || TAX_PROFILES[DEFAULT_TAX_PROFILE];
    return {
      key: TAX_PROFILES[profileKey] ? profileKey : DEFAULT_TAX_PROFILE,
      label: p.label,
      note: p.note,
      ordinary: p.federalOrdinary + p.medicare + p.state + p.local,
      capitalGains: p.federalLtcg + p.niit + p.stateLtcg + p.localLtcg
    };
  }

  const INPUTS = {
    alphaRange: [0.3, 0.65],
    refreshRange: [0, 0.5],
    vestYears: 4
  };

  /* ------------------------------------------------------------------ company profiles: validation and registry */
  const ROLE_BAND_KEYS = [
    "vp", "directorTech", "directorBusiness", "architect", "principalArchitect", "principal", "product", "marketing", "program",
    "sales", "recruiting", "design", "prompt", "datasci", "noc", "bizops", "researchLead", "researchSenior", "research",
    "gm", "countryManager", "engmanager", "fieldManager", "manager", "icSenior", "icTenured", "ic"
  ];
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const isText = (v, max = 400) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
  const isIsoDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

  /* Returns { errors: string[], profile } where profile is the normalised, ready-to-use form (or null when there are errors). */
  function validateProfile(name, raw) {
    const errors = [];
    const fail = (message) => errors.push(message);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { errors: ["profile must be an object"], profile: null };

    if (!Number.isInteger(raw.foundedYear) || raw.foundedYear < 1900 || raw.foundedYear > 2100) fail("foundedYear must be a four-digit year");
    if (!isNum(raw.referenceValuationB) || raw.referenceValuationB <= 0) fail("referenceValuationB must be a positive number (billions): the valuation your pay data reflects");
    if (raw.earlyHireValuationB !== undefined && (!isNum(raw.earlyHireValuationB) || raw.earlyHireValuationB < 0)) fail("earlyHireValuationB must be zero or a positive number (billions)");

    let curve = [];
    if (!Array.isArray(raw.curve) || raw.curve.length < 1 || raw.curve.length > 60) {
      fail("curve must list 1 to 60 funding rounds as [date, pricePerShare, valuationInBillions]");
    } else {
      let previous = "";
      raw.curve.forEach((row, i) => {
        const ok = Array.isArray(row) && row.length === 3 && isIsoDate(row[0]) && isNum(row[1]) && row[1] > 0 && isNum(row[2]) && row[2] > 0;
        if (!ok) return fail(`curve[${i}] must be [YYYY-MM-DD, price > 0, valuation > 0]`);
        if (previous && row[0] <= previous) fail(`curve[${i}] is not later than the previous round`);
        previous = row[0];
      });
      curve = raw.curve;
    }

    const refs = raw.priceRef;
    if (!refs || !isNum(refs.low) || refs.low <= 0 || !isNum(refs.high) || refs.high < refs.low) fail("priceRef needs low > 0 and high >= low (the price range used to mark equity today)");
    else if (!isText(refs.lowLabel) || !isText(refs.highLabel)) fail("priceRef needs lowLabel and highLabel text");

    const v = raw.vesting;
    if (!v || !Array.isArray(v.yearlyPercent) || v.yearlyPercent.length < 1 || v.yearlyPercent.length > 6 || !v.yearlyPercent.every((x) => isNum(x) && x > 0)) {
      fail("vesting.yearlyPercent must list 1 to 6 positive percentages, one per year (for example [25, 25, 25, 25])");
    } else {
      const total = v.yearlyPercent.reduce((a, b) => a + b, 0);
      if (Math.abs(total - 100) > 0.5) fail(`vesting.yearlyPercent must add up to 100 (currently ${total})`);
    }
    if (v && v.cliffMonths !== undefined && (!Number.isInteger(v.cliffMonths) || v.cliffMonths < 0 || v.cliffMonths > 36)) fail("vesting.cliffMonths must be a whole number from 0 to 36");
    if (v && v.label !== undefined && !isText(v.label, 200)) fail("vesting.label must be short text");

    const s = raw.structure;
    if (!s || !["single", "double"].includes(s.type)) fail('structure.type must be "single" or "double" (single-trigger RSUs are taxed at vest; double-trigger at a liquidity event)');
    else if (!isText(s.trigger) || !isText(s.liquidity)) fail("structure needs trigger and liquidity descriptions");
    if (s && s.short !== undefined && !isText(s.short, 40)) fail("structure.short must be short text");

    const tenders = [];
    if (raw.tenders !== undefined) {
      if (!Array.isArray(raw.tenders) || raw.tenders.length > 20) fail("tenders must be a list of at most 20 tender offers");
      else {
        raw.tenders.forEach((t, i) => {
          const price = t && (t.price === "interp" || (isNum(t.price) && t.price > 0));
          const ok = t && isIsoDate(t.date) && price && (t.cap === null || t.cap === undefined || (isNum(t.cap) && t.cap > 0)) &&
            Array.isArray(t.participation) && t.participation.length === 2 && isNum(t.participation[0]) && isNum(t.participation[1]) &&
            t.participation[0] >= 0 && t.participation[1] <= 1 && t.participation[0] <= t.participation[1] && isText(t.label) && isText(t.note);
          if (!ok) return fail(`tenders[${i}] needs date, price (number or "interp"), cap (number or null), participation [low, high] between 0 and 1, label and note`);
          tenders.push({ date: t.date, price: t.price, cap: t.cap ?? null, participation: [t.participation[0], t.participation[1]], label: t.label, note: t.note, verified: t.verified === true });
        });
      }
    }

    const levels = [];
    if (!Array.isArray(raw.levels) || raw.levels.length < 3 || raw.levels.length > 12) {
      fail("levels must list 3 to 12 pay levels, lowest first, as { name, stockPerYear }");
    } else {
      raw.levels.forEach((l, i) => {
        if (!l || !isText(l.name, 20) || !isNum(l.stockPerYear) || l.stockPerYear <= 0) return fail(`levels[${i}] needs a short name and stockPerYear > 0`);
        if (levels.length && l.stockPerYear < levels[levels.length - 1].stock) fail(`levels[${i}] must not be lower than the level before it`);
        levels.push({ name: l.name, stock: l.stockPerYear });
      });
    }

    const roleBands = {};
    if (raw.roleBands !== undefined) {
      if (!raw.roleBands || typeof raw.roleBands !== "object" || Array.isArray(raw.roleBands)) fail("roleBands must be an object");
      else {
        for (const [key, band] of Object.entries(raw.roleBands)) {
          if (!ROLE_BAND_KEYS.includes(key)) fail(`roleBands.${key} is not a known role (${ROLE_BAND_KEYS.join(", ")})`);
          else if (!Array.isArray(band) || band.length !== 2 || !isNum(band[0]) || !isNum(band[1]) || band[0] <= 0 || band[1] < band[0]) fail(`roleBands.${key} must be [low, high] in dollars per year`);
          else roleBands[key] = [band[0], band[1]];
        }
      }
    }

    if (errors.length) return { errors, profile: null };

    const percents = v.yearlyPercent;
    const profile = {
      name,
      foundedYear: raw.foundedYear,
      referenceValuationB: raw.referenceValuationB,
      earlyHireValuationB: raw.earlyHireValuationB ?? 1,
      curve: curve.map((r) => ({ date: r[0], time: Date.parse(`${r[0]}T00:00:00Z`), price: r[1], valuation: r[2] })),
      priceRef: { low: refs.low, high: refs.high, lowLabel: refs.lowLabel, highLabel: refs.highLabel },
      vesting: {
        yearlyPercent: percents,
        cliffMonths: v.cliffMonths ?? 0,
        months: percents.length * 12,
        label: v.label || describeVesting(percents, v.cliffMonths ?? 0)
      },
      structure: { type: s.type, short: s.short || (s.type === "single" ? "Single-trigger" : "Double-trigger"), trigger: s.trigger, liquidity: s.liquidity },
      tenders,
      levels,
      roleBands
    };
    profile.cumulative = makeCumulative(profile.vesting);
    return { errors: [], profile };
  }

  function describeVesting(percents, cliff) {
    const years = percents.length;
    const even = percents.every((x) => Math.abs(x - percents[0]) < 1e-9);
    const shape = even ? `${years} years, linear monthly` : `${percents.join("/")}% by year, monthly`;
    return `${shape}, ${cliff ? `${cliff}-month cliff` : "no cliff"}`;
  }

  /* Cumulative fraction vested after m months: linear within each year, nothing before the cliff. */
  function makeCumulative(vesting) {
    const total = vesting.yearlyPercent.reduce((a, b) => a + b, 0);
    const share = vesting.yearlyPercent.map((x) => x / total);
    const months = vesting.months;
    return (m) => {
      if (m < vesting.cliffMonths) return 0;
      const clamped = Math.max(0, Math.min(months, m));
      const whole = Math.floor(clamped / 12);
      let vested = 0;
      for (let i = 0; i < whole; i++) vested += share[i];
      if (whole < share.length) vested += share[whole] * ((clamped - whole * 12) / 12);
      return Math.min(1, vested);
    };
  }

  const registry = new Map();
  /* Forgets every loaded company profile (the model has no built-in ones). */
  function resetProfiles() {
    registry.clear();
  }

  /* Adds or replaces profiles. Invalid ones are skipped and reported. Returns { registered: string[], errors: { [name]: string[] } }. */
  function registerProfiles(map) {
    const out = { registered: [], errors: {} };
    if (!map || typeof map !== "object" || Array.isArray(map)) { out.errors["(file)"] = ["COMPANY_PROFILES must be an object keyed by company name"]; return out; }
    for (const [rawName, raw] of Object.entries(map)) {
      const name = String(rawName).trim();
      if (!name || name.length > 80) { out.errors[rawName.slice(0, 40) || "(blank)"] = ["company name must be 1 to 80 characters"]; continue; }
      const { profile, errors } = validateProfile(name, raw);
      if (errors.length) out.errors[name] = errors;
      else { registry.set(name, profile); out.registered.push(name); }
    }
    return out;
  }
  const getProfile = (company) => registry.get(String(company ?? "").trim()) || null;
  const hasProfile = (company) => registry.has(String(company ?? "").trim());
  const profileNames = () => [...registry.keys()];

  /* ------------------------------------------------------------------ role classification and pay bands */
  function band(low, high, basis, ambiguous) {
    return { low, high, basis, ambiguous: Boolean(ambiguous) };
  }

  /* Classify a title into a pay track. Order matters: more specific / senior tracks first. */
  function roleOf(p) {
    const t = p.title.toLowerCase();
    if (/\bvp\b|vice president/.test(t)) return "vp";
    if (/\bdirector\b/.test(t)) return "director";
    if (/solutions? architect|\barchitect\b/.test(t)) return "architect";
    if (/\bprincipal\b/.test(t)) return "principal";
    if (/talent acquisition|recruit/.test(t)) return "recruiting";
    if (/\bsales\b|account manager|business development/.test(t)) return "sales";
    if (/marketing|event manager/.test(t)) return "marketing";
    if (/product manager|^product$/.test(t)) return "product";
    if (/program manager|project manager/.test(t)) return "program";
    if (/design|creative/.test(t) || /\bdesign\b/i.test(p.department || "")) return "design";
    if (/prompt engineer/.test(t)) return "prompt";
    if (/data scientist/.test(t)) return "datasci";
    if (/network operations/.test(t)) return "noc";
    if (/strategy|operations/.test(t) && /manager/.test(t)) return "bizops";
    if (/research (scientist|lead|manager)/.test(t)) return "research";
    if (/general manager|country manager/.test(t)) return "gm";
    if (/manager/.test(t) && /engineer|technical|tech\b|\bai\b|machine|systems|research/.test(t)) return "engmanager";
    if (/manager/.test(t)) return "manager";
    return "ic";
  }

  /* True when a director/manager title or its department points at a technical (engineering/research/data) track. */
  function isTechnicalTrack(p) {
    return /technical|engineering|data science|research|machine|\bai\b|artificial/i.test(p.title) ||
      /engineering\/technical/i.test(p.department || "");
  }

  /* Each rule places a role on the company's level ladder. q = position on the ladder (0 = lowest level, 1 = highest),
   * scale = share of that level's stock a non-engineering track typically receives, mult = extra multiple above the ladder. */
  const RULES = {
    vp: { label: "VP-level leader", q: [1, 1], mult: [1, 1.8], ambiguous: true },
    directorTech: { label: "Technical director", q: [0.75, 1], ambiguous: true },
    directorBusiness: { label: "Business-track director", q: [0.1, 0.55], scale: 0.7, ambiguous: true },
    architect: { label: "Solutions/architect track", q: [0.1, 0.5], scale: 0.6, ambiguous: true },
    principalArchitect: { label: "Principal architect", q: [0.3, 0.65], scale: 0.7, ambiguous: true },
    principal: { label: "Principal individual contributor", q: [0.5, 0.85], ambiguous: false },
    product: { label: "Product track", q: [0, 0.35], scale: 0.9, ambiguous: true },
    marketing: { label: "Marketing track", q: [0, 0.3], scale: 0.4, ambiguous: true },
    program: { label: "Program/project management track", q: [0, 0.3], scale: 0.35, ambiguous: true },
    sales: { label: "Sales track (pay is mostly cash)", q: [0, 0.25], scale: 0.3, ambiguous: true },
    recruiting: { label: "Recruiting track", q: [0, 0.2], scale: 0.25, ambiguous: true },
    design: { label: "Design track", q: [0, 0.35], scale: 0.5, ambiguous: true },
    prompt: { label: "Prompt-engineering track", q: [0, 0.25], scale: 0.6, ambiguous: true },
    datasci: { label: "Data-science track", q: [0.05, 0.4], scale: 0.7, ambiguous: true },
    noc: { label: "Network-operations engineer", q: [0, 0.1], scale: 0.2, ambiguous: true },
    bizops: { label: "Strategy and operations manager", q: [0, 0.25], scale: 0.4, ambiguous: true },
    researchLead: { label: "Research lead or manager", q: [0.4, 0.7], ambiguous: true },
    researchSenior: { label: "Research scientist with 5+ years", q: [0.4, 0.75], ambiguous: true },
    research: { label: "Research scientist", q: [0.2, 0.5], ambiguous: true },
    gm: { label: "General manager", q: [0.3, 0.65], scale: 0.8, ambiguous: true },
    countryManager: { label: "Country manager", q: [0.8, 1], ambiguous: true },
    engmanager: { label: "Engineering or technical manager", q: [0.45, 0.75], ambiguous: true },
    fieldManager: { label: "Field-engineering manager (sales-engineering track)", q: [0, 0.3], scale: 0.5, ambiguous: true },
    manager: { label: "Manager, function unclear", q: [0, 0.3], scale: 0.5, ambiguous: true },
    icSenior: { label: "Senior engineer", q: [0.3, 0.6], ambiguous: true },
    icTenured: { label: "Engineer with 5+ years", q: [0.2, 0.7], ambiguous: true },
    ic: { label: "Engineer", q: [0, 0.5], ambiguous: true }
  };

  function ruleKeyFor(p, role, tenure) {
    const t = p.title.toLowerCase();
    switch (role) {
      case "director": return isTechnicalTrack(p) ? "directorTech" : "directorBusiness";
      case "architect": return /\bprincipal\b/.test(t) ? "principalArchitect" : "architect";
      case "research": return /lead|manager/.test(t) ? "researchLead" : tenure >= 5 ? "researchSenior" : "research";
      case "gm": return /country manager/.test(t) ? "countryManager" : "gm";
      case "engmanager": return /field engineering/.test(t) ? "fieldManager" : "engmanager";
      case "manager": return /field engineering/.test(t) ? "fieldManager" : "manager";
      case "ic": return /\b(senior|sr\.?)\b/.test(t) ? "icSenior" : tenure >= 5 ? "icTenured" : "ic";
      default: return role;
    }
  }

  function stockBand(p, profile) {
    const levels = profile.levels;
    const n = levels.length;
    const clampQ = (q) => Math.max(0, Math.min(1, q));
    const tier = (q) => {
      const pos = clampQ(q) * (n - 1);
      const lo = Math.floor(pos);
      const hi = Math.ceil(pos);
      if (lo === hi) return levels[lo].stock;
      const f = pos - lo;
      return Math.exp(Math.log(levels[lo].stock) * (1 - f) + Math.log(levels[hi].stock) * f);
    };
    const nameAt = (q) => levels[Math.round(clampQ(q) * (n - 1))].name;

    if (p.founder === true) {
      return band(tier(1) * 2, tier(1) * 8, "Flagged as a founder in the data; modeled as a heavily scaled-up employee grant (founder stakes are not public)", true);
    }
    const role = roleOf(p);
    const key = ruleKeyFor(p, role, p.tenure);
    const rule = RULES[key];
    const scale = rule.scale ?? 1;

    const override = profile.roleBands[key];
    if (override) return band(override[0], override[1], `${rule.label}: band set by the company profile`, true);

    /* A title that states a level on this company's ladder (for example "Software Engineer - L5") is used directly. */
    /* Only level names that contain a digit (L5, E4, IC3) count, so words like "Senior" or "Staff" in a title are not mistaken for levels. */
    const stated = levels.find((l) => /\d/.test(l.name) && new RegExp(`(^|[^A-Za-z0-9])${l.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`, "i").test(p.title));
    if (stated) {
      return band(stated.stock * scale * 0.85, stated.stock * scale * 1.15, `Title states level ${stated.name} on this company's ladder${scale < 1 ? `, scaled to ${Math.round(scale * 100)}% for a non-engineering track` : ""}`, key !== "ic" && key !== "icSenior" && key !== "icTenured" && key !== "principal");
    }

    const [qLo, qHi] = rule.q;
    const [mLo, mHi] = rule.mult || [1, 1];
    const where = qLo === qHi ? nameAt(qLo) : `${nameAt(qLo)} to ${nameAt(qHi)}`;
    const basis = `${rule.label}: about ${where} on this company's level ladder${scale < 1 ? `, scaled to ${Math.round(scale * 100)}% for a non-engineering track (estimate)` : ""}`;
    return band(tier(qLo) * scale * mLo, tier(qHi) * scale * mHi, basis, rule.ambiguous);
  }
  /* ------------------------------------------------------------------ date and price helpers */
  const DAY = 86400000;
  function yearsBetween(a, b) { return (b.getTime() - a.getTime()) / (365.25 * DAY); }
  function addMonths(d, m) {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + m, d.getUTCDate()));
  }

  function interpolate(curve, field, date) {
    const t = date.getTime();
    const first = curve[0];
    const last = curve[curve.length - 1];
    if (t <= first.time) return first[field];
    if (t >= last.time) return last[field];
    for (let i = 0; i < curve.length - 1; i++) {
      const a = curve[i];
      const b = curve[i + 1];
      if (t <= b.time) {
        const f = (t - a.time) / (b.time - a.time);
        return Math.exp(Math.log(a[field]) * (1 - f) + Math.log(b[field]) * f);
      }
    }
    return last[field];
  }
  const priceAt = (profile, date) => interpolate(profile.curve, "price", date);
  const valuationAt = (profile, date) => interpolate(profile.curve, "valuation", date);

  function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function mulberry32(seed) {
    let a = seed;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const uniform = (rng, lo, hi) => lo + (hi - lo) * rng();
  const logUniform = (rng, lo, hi) => Math.exp(uniform(rng, Math.log(lo), Math.log(hi)));
  function percentile(sorted, p) {
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }
  const summarize = (values) => {
    const sorted = values.slice().sort((a, b) => a - b);
    return { p10: percentile(sorted, 0.1), p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9) };
  };

  /* Pre-compute, per grant, the vested fraction and price-weighted vest value in each interval between tenders. */
  function gradeGrant(profile, grantDate, tenders, isInitial) {
    const cumulative = profile.cumulative;
    const intervals = Array.from({ length: tenders.length + 1 }, () => ({ F: 0, S: 0 }));
    let vestedFraction = 0;
    for (let m = 1; m <= profile.vesting.months; m++) {
      const when = addMonths(grantDate, m);
      if (when.getTime() > AS_OF.getTime()) break;
      const delta = cumulative(m) - cumulative(m - 1);
      if (delta <= 0) continue;
      const price = priceAt(profile, when);
      let j = 0;
      while (j < tenders.length && when.getTime() > tenders[j].when.getTime()) j++;
      intervals[j].F += delta;
      intervals[j].S += delta * price;
      vestedFraction += delta;
    }
    return {
      isInitial,
      valuation: valuationAt(profile, grantDate),
      price: priceAt(profile, grantDate),
      intervals,
      vestedFraction,
      unvestedFraction: Math.max(0, 1 - vestedFraction)
    };
  }

  function simulate(ctx, params) {
    const { grants, tenders, rates, single, vref, todayPrice } = ctx;
    const K = tenders.length;
    const units = new Array(K + 1).fill(0);
    const basis = new Array(K + 1).fill(0);
    let grossUnits = 0;
    let refreshGrossUnits = 0;
    let unvestedUnits = 0;
    let vestTaxValue = 0;

    for (const g of grants) {
      const scale = g.isInitial ? 1 : params.refresh;
      if (scale === 0) continue;
      const sizing = Math.min(1, Math.pow(g.valuation / vref, params.alpha));
      const shares = (INPUTS.vestYears * params.stock * sizing * scale) / g.price;
      for (let j = 0; j <= K; j++) {
        const f = g.intervals[j].F;
        const s = g.intervals[j].S;
        if (!f) continue;
        grossUnits += shares * f;
        if (!g.isInitial) refreshGrossUnits += shares * f;
        if (single) {
          units[j] += shares * f * (1 - rates.ordinary);
          basis[j] += shares * s * (1 - rates.ordinary);
          vestTaxValue += shares * s * rates.ordinary;
        } else {
          units[j] += shares * f;
        }
      }
      unvestedUnits += shares * g.unvestedFraction;
    }

    let tenderGross = 0;
    let tenderNet = 0;
    let tenderTax = 0;
    for (let k = 0; k < K; k++) {
      const tender = tenders[k];
      if (!tender.eligible) continue;
      let available = 0;
      let availableBasis = 0;
      for (let j = 0; j <= k; j++) { available += units[j]; availableBasis += basis[j]; }
      if (available <= 0) continue;
      const wanted = uniform(params.rng, tender.participation[0], tender.participation[1]);
      const capFraction = tender.cap ? tender.cap / (tender.price * available) : Infinity;
      const phi = Math.min(wanted, capFraction, 1);
      if (phi <= 0) continue;
      const proceeds = phi * available * tender.price;
      const tax = single
        ? rates.capitalGains * Math.max(0, proceeds - phi * availableBasis)
        : rates.ordinary * proceeds;
      tenderGross += proceeds;
      tenderTax += tax;
      tenderNet += proceeds - tax;
      for (let j = 0; j <= k; j++) { units[j] *= 1 - phi; basis[j] *= 1 - phi; }
    }

    let remainingUnits = 0;
    let remainingBasis = 0;
    for (let j = 0; j <= K; j++) { remainingUnits += units[j]; remainingBasis += basis[j]; }
    const remainingGross = remainingUnits * todayPrice;
    const liquidationTax = single
      ? rates.capitalGains * Math.max(0, remainingGross - remainingBasis)
      : rates.ordinary * remainingGross;
    const remainingNet = remainingGross - liquidationTax;

    return {
      net: tenderNet + remainingNet,
      gross: grossUnits * todayPrice,
      unvested: unvestedUnits * todayPrice,
      taxes: vestTaxValue + tenderTax + liquidationTax,
      tenderGross,
      tenderNet,
      remainingNet,
      refreshShare: grossUnits > 0 ? refreshGrossUnits / grossUnits : 0
    };
  }

  function roundSig(n, sig) {
    if (!isFinite(n) || n === 0) return 0;
    return Number(n.toPrecision(sig));
  }

  function formatUSD(n) {
    const v = roundSig(n, 2);
    if (v >= 1e9) return `$${(v / 1e9).toFixed(v >= 1e10 ? 0 : 1).replace(/\.0$/, "")}B`;
    if (v >= 1e6) return `$${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, "")}M`;
    if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
    return `$${Math.round(v)}`;
  }

  const ZERO = { p10: 0, p50: 0, p90: 0 };
  const NO_PROFILE_STRUCTURE = { type: "double", short: "n/a", trigger: "", liquidity: "" };
  const NO_PRICE_REF = { low: 0, high: 0, lowLabel: "", highLabel: "" };

  /* Returns a message when the start date cannot be right, otherwise null. */
  function startDateIssue(profile, company, start) {
    if (Number.isNaN(start.getTime())) return "Start date is missing or unreadable in the source data.";
    if (start.getUTCFullYear() < profile.foundedYear) {
      return `Source start date (${start.toISOString().slice(0, 10)}) is before ${company} was founded (${profile.foundedYear}), so the record is unreliable and no estimate is produced.`;
    }
    if (start.getTime() > AS_OF.getTime()) return "Start date is in the future relative to the model date; no estimate is produced.";
    return null;
  }

  function notEstimated({ issue, tenure, rates, profile }) {
    return {
      estimated: false,
      dataIssue: issue,
      net: ZERO, gross: ZERO, unvested: ZERO, taxes: ZERO, tenderNet: ZERO, tenderGross: ZERO, remainingNet: ZERO,
      refreshShare: 0,
      confidence: "n/a",
      width: 0,
      band: { low: 0, high: 0, basis: "Not estimated (data issue)", ambiguous: false },
      tenure: Number.isFinite(tenure) ? tenure : 0,
      flags: [issue],
      priceRef: profile ? profile.priceRef : NO_PRICE_REF,
      structure: profile ? profile.structure : NO_PROFILE_STRUCTURE,
      schedule: profile ? profile.vesting.label : "n/a",
      tax: rates,
      tenders: [],
      hasTenders: Boolean(profile && profile.tenders.length)
    };
  }

  function estimate(person) {
    const company = String(person.company ?? "").trim();
    const start = new Date(`${person.startDate}T00:00:00Z`);
    const tenure = yearsBetween(start, AS_OF);
    const rates = taxRates(person.taxProfile);
    const profile = getProfile(company);

    if (!profile) {
      return notEstimated({
        issue: `No company profile for "${company}", so no equity estimate is produced. Add a profile for this company to your data file (see the template) to estimate its prospects.`,
        tenure,
        rates,
        profile: null
      });
    }
    const issue = startDateIssue(profile, company, start);
    if (issue) return notEstimated({ issue, tenure, rates, profile });

    const b = stockBand({ ...person, tenure }, profile);
    const rng = mulberry32(hashString(`${company}:${person.name}`));

    const tenders = profile.tenders.map((t) => {
      const when = new Date(`${t.date}T00:00:00Z`);
      return {
        ...t,
        when,
        price: t.price === "interp" ? priceAt(profile, when) : t.price,
        eligible: yearsBetween(start, when) >= TENDER_ELIGIBLE_AFTER_YEARS
      };
    });

    const grants = [gradeGrant(profile, start, tenders, true)];
    for (let j = 1; j <= Math.floor(tenure); j++) {
      grants.push(gradeGrant(profile, addMonths(start, 12 * j), tenders, false));
    }

    const ctx = {
      grants,
      tenders,
      rates,
      single: profile.structure.type === "single",
      vref: profile.referenceValuationB
    };

    const refs = profile.priceRef;
    const draws = { net: [], gross: [], unvested: [], taxes: [], tenderGross: [], tenderNet: [], remainingNet: [], refreshShare: [] };
    for (let i = 0; i < SCENARIOS; i++) {
      const todayPrice = logUniform(rng, refs.low, refs.high);
      const out = simulate(
        { ...ctx, todayPrice },
        {
          stock: logUniform(rng, b.low, b.high),
          alpha: uniform(rng, INPUTS.alphaRange[0], INPUTS.alphaRange[1]),
          refresh: uniform(rng, INPUTS.refreshRange[0], INPUTS.refreshRange[1]),
          rng
        }
      );
      for (const key of Object.keys(draws)) draws[key].push(out[key]);
    }

    const net = summarize(draws.net);
    const gross = summarize(draws.gross);
    const unvested = summarize(draws.unvested);
    const taxes = summarize(draws.taxes);
    const tenderNet = summarize(draws.tenderNet);
    const tenderGross = summarize(draws.tenderGross);
    const remainingNet = summarize(draws.remainingNet);
    const refreshShare = summarize(draws.refreshShare);

    const flags = [];
    const hireValuation = valuationAt(profile, start);
    const beforeFirstRound = start.getTime() < profile.curve[0].time;
    if (beforeFirstRound) {
      flags.push("Joined before the first priced round on record; grant priced at the earliest known round, which likely understates share count.");
    }
    if (b.ambiguous) flags.push("Role mapping is approximate (title does not map cleanly to one pay level).");
    if (profile.earlyHireValuationB > 0 && hireValuation < profile.earlyHireValuationB) {
      flags.push(`Very early hire (company valued at about $${hireValuation < 1 ? hireValuation.toFixed(2) : hireValuation.toFixed(1)}B at hire): early grants were often larger than pay-level benchmarks imply (upside skew).`);
    }
    if (!person.department) flags.push("No department data in source data.");
    if (/country manager/i.test(person.title)) flags.push("Title suggests a possible non-US base; US federal/state taxes are assumed as requested.");
    const founder = person.founder === true;
    if (founder) flags.push("Flagged as a founder: the founder stake is not captured by pay bands, so this figure is a placeholder and probably well below actual holdings.");

    const width = net.p90 / Math.max(net.p10, 1);
    let confidence = width <= 6 && flags.length <= 1 ? "Medium" : "Low";
    if (founder) confidence = "Low";

    /* Identity-quality notes do not affect the financial model, so they are added after confidence is rated. */
    if (person.nameIncomplete) {
      flags.push("Name is incomplete in the source data (initial or single name), so identity and sanctions screening are unreliable until the full legal name is confirmed.");
    }

    return {
      estimated: true,
      net,
      gross,
      unvested,
      taxes,
      tenderNet,
      tenderGross,
      remainingNet,
      refreshShare: refreshShare.p50,
      confidence,
      width,
      band: b,
      tenure,
      flags,
      priceRef: refs,
      structure: profile.structure,
      schedule: profile.vesting.label,
      tax: rates,
      tenders: tenders.map((t) => ({ label: t.label, note: t.note, verified: t.verified, eligible: t.eligible, price: t.price, cap: t.cap })),
      hasTenders: tenders.length > 0
    };
  }

  return {
    estimate,
    formatUSD,
    roundSig,
    validateProfile,
    registerProfiles,
    resetProfiles,
    getProfile,
    hasProfile,
    profileNames,
    ROLE_BAND_KEYS,
    TAX_PROFILES,
    INPUTS,
    AS_OF,
    SCENARIOS
  };
});
