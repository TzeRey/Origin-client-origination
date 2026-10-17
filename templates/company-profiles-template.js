/*
 * ORIGIN COMPANY PROFILES TEMPLATE
 * -------------------------------------------------------------------------------------------------
 * Use this file as a starting point for the company details the equity model needs. On the dashboard, choose it in the
 * "2 Company profiles" upload section. Your list of people goes in a separate file (see templates/prospects-template.js)
 * and is loaded in the "1 Prospects" section.
 *
 * HOW IT IS READ
 *   The file is read as DATA. It is never run as code, so only the object below is used. Everything else in this file
 *   (including these comments) is ignored. The object must be valid JSON: double-quoted keys and text, no expressions
 *   or functions. Trailing commas are tolerated.
 *
 * WHAT A PROFILE IS
 *   One profile per employer, keyed by the EXACT company name used in your prospects file. The numbers below are
 *   ILLUSTRATIVE PLACEHOLDERS. Replace them with figures you can source and check, such as funding-round prices and
 *   pay benchmarks from providers you are licensed to use. The app checks every profile and tells you what is wrong.
 *
 * FIELDS
 *    foundedYear           year the company was founded; earlier start dates are rejected as data errors
 *    referenceValuationB   valuation in billions that your pay benchmarks reflect (earlier hires are scaled down from it)
 *    earlyHireValuationB   people hired when the company was valued below this (billions) get an "early hire" flag; 0 turns it off
 *    curve                 funding rounds, oldest first: [date, price per share, post-money valuation in billions]
 *    priceRef              the price range used to value equity today: low, high and a short label for each
 *    vesting               yearlyPercent: share vesting in each year (adds up to 100), cliffMonths: months before anything vests
 *    structure             type "single" (taxed at vest) or "double" (taxed at a tender or IPO), plus plain-English descriptions
 *    tenders               employee tender offers: date, price (number or "interp" to use the round curve), per-person cap
 *                          (number or null), participation [low, high] share of vested units sold, label, note
 *    levels                pay ladder, lowest first: average stock value per YEAR of a 4-year grant at each level
 *    roleBands (optional)  override the band for a role: { "marketing": [30000, 90000] }. Keys: vp, directorTech,
 *                          directorBusiness, architect, principalArchitect, principal, product, marketing, program, sales,
 *                          recruiting, design, prompt, datasci, noc, bizops, researchLead, researchSenior, research, gm,
 *                          countryManager, engmanager, fieldManager, manager, icSenior, icTenured, ic
 *
 * A prospect whose company has no profile here is still listed, but shown as n/a, because inventing numbers would be misleading.
 */
window.COMPANY_PROFILES = {
  "Example Corp": {
    "foundedYear": 2016,
    "referenceValuationB": 50,
    "earlyHireValuationB": 1,
    "curve": [
      ["2018-01-01", 3.0, 1.0],
      ["2020-06-01", 12.0, 6.0],
      ["2022-09-01", 40.0, 22.0],
      ["2025-03-01", 95.0, 60.0],
      ["2026-05-01", 140.0, 90.0]
    ],
    "priceRef": {
      "low": 140,
      "high": 170,
      "lowLabel": "$140: latest priced round",
      "highLabel": "$170: about 20% above the latest round"
    },
    "vesting": { "yearlyPercent": [25, 25, 25, 25], "cliffMonths": 12 },
    "structure": {
      "type": "double",
      "trigger": "Double-trigger RSUs: time-vested units settle at a tender or IPO",
      "liquidity": "Units settle and are taxed as ordinary income at a tender offer or an IPO."
    },
    "tenders": [
      {
        "date": "2026-02-01",
        "price": 110,
        "cap": 10000000,
        "participation": [0.1, 0.35],
        "label": "Tender offer, early 2026",
        "note": "Per-person cap of $10M assumed",
        "verified": false
      }
    ],
    "levels": [
      { "name": "L3", "stockPerYear": 60000 },
      { "name": "L4", "stockPerYear": 130000 },
      { "name": "L5", "stockPerYear": 240000 },
      { "name": "L6", "stockPerYear": 520000 }
    ]
  }
};
