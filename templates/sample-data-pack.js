/*
 * ORIGIN SAMPLE DATA PACK: entirely fictional.
 * -------------------------------------------------------------------------------------------------
 * "Try the sample data" on the dashboard loads this file. Every person and company below is made up, and every company
 * figure (funding rounds, tenders, pay ladders) is an invented placeholder, not market data. Any resemblance to a real
 * person or company is coincidental.
 *
 * It is written in the same format you use for your own data (see templates/prospects-template.js and templates/company-profiles-template.js):
 *   window.RAW_PROSPECTS     one object per person
 *   window.COMPANY_PROFILES  the facts the equity model needs for each employer
 * and it is read as data, never run as code.
 *
 * The sample is small on purpose, and includes a few cases so every feature has something to show:
 *   - Demo Person 7:  joined before the company's first priced round (an early-hire flag)
 *   - Demo Person 8:  a flagged founder (a low-confidence placeholder estimate)
 *   - Demo Person 14: a start date before the company existed (shown as n/a, never estimated)
 *   - Demo Company A uses double-trigger RSUs with a 1-year cliff and a tender offer;
 *     Demo Company B uses single-trigger RSUs on a 40/30/20/10 schedule and has no tender.
 */
window.RAW_PROSPECTS = [
  { "name": "Demo Person 1", "company": "Demo Company A", "title": "Software Engineer", "seniority": "entry", "department": "Engineering/Technical", "subDepartment": "Engineering; Software Dev", "startDate": "2023-02-01" },
  { "name": "Demo Person 2", "company": "Demo Company A", "title": "Senior Software Engineer", "seniority": "senior", "department": "Engineering/Technical", "subDepartment": "Engineering; Software Dev", "startDate": "2021-06-01" },
  { "name": "Demo Person 3", "company": "Demo Company A", "title": "Principal Engineer", "seniority": "senior", "department": "Engineering/Technical", "subDepartment": "Engineering", "startDate": "2019-09-01" },
  { "name": "Demo Person 4", "company": "Demo Company A", "title": "Research Scientist", "seniority": "entry", "department": "Engineering/Technical", "subDepartment": "R&D", "startDate": "2020-04-01" },
  { "name": "Demo Person 5", "company": "Demo Company A", "title": "Engineering Manager", "seniority": "manager", "department": "Engineering/Technical", "subDepartment": "Engineering", "startDate": "2021-01-01" },
  { "name": "Demo Person 6", "company": "Demo Company A", "title": "Product Manager", "seniority": "manager", "department": "Product Mgmt", "subDepartment": "Product Mgmt", "startDate": "2022-05-01" },
  { "name": "Demo Person 7", "company": "Demo Company A", "title": "Director of Engineering", "seniority": "director", "department": "Engineering/Technical", "subDepartment": "Engineering", "startDate": "2017-09-01" },
  { "name": "Demo Person 8", "company": "Demo Company A", "title": "Co-founder, Engineering", "seniority": "founder", "department": "Engineering/Technical", "subDepartment": "Engineering", "startDate": "2016-03-01", "founder": true },
  { "name": "Demo Person 9", "company": "Demo Company B", "title": "Software Engineer", "seniority": "entry", "department": "Engineering/Technical", "subDepartment": "Engineering; Software Dev", "startDate": "2022-08-01" },
  { "name": "Demo Person 10", "company": "Demo Company B", "title": "Data Engineer", "seniority": "entry", "department": "Engineering/Technical", "subDepartment": "Data Science; Engineering", "startDate": "2021-11-01" },
  { "name": "Demo Person 11", "company": "Demo Company B", "title": "Sales Manager", "seniority": "manager", "department": "Sales", "subDepartment": "Sales", "startDate": "2020-02-01" },
  { "name": "Demo Person 12", "company": "Demo Company B", "title": "Vice President, Operations", "seniority": "vp", "department": "Operations", "subDepartment": "Operations", "startDate": "2019-06-01" },
  { "name": "Demo Person 13", "company": "Demo Company B", "title": "Marketing Manager", "seniority": "manager", "department": "Marketing", "subDepartment": "Marketing", "startDate": "2023-01-01" },
  { "name": "Demo Person 14", "company": "Demo Company B", "title": "Senior Director, Strategy", "seniority": "director", "department": "Operations", "subDepartment": "Corporate Strategy", "startDate": "2005-01-01" }
];

window.COMPANY_PROFILES = {
  "Demo Company A": {
    "foundedYear": 2016,
    "referenceValuationB": 25,
    "earlyHireValuationB": 1,
    "curve": [
      ["2018-01-01", 2.0, 0.4],
      ["2020-03-01", 8.0, 3],
      ["2022-06-01", 25.0, 15],
      ["2024-09-01", 60.0, 40],
      ["2026-03-01", 110.0, 80]
    ],
    "priceRef": {
      "low": 110,
      "high": 140,
      "lowLabel": "$110: latest priced round (invented)",
      "highLabel": "$140: optimistic mark, about 25% above the latest round (invented)"
    },
    "vesting": { "yearlyPercent": [25, 25, 25, 25], "cliffMonths": 12 },
    "structure": {
      "type": "double",
      "trigger": "Double-trigger RSUs: time-vested units settle at a tender or IPO",
      "liquidity": "Invented example: units settle and are taxed as ordinary income at a tender offer or an IPO. No IPO date is assumed."
    },
    "tenders": [
      {
        "date": "2025-11-01",
        "price": "interp",
        "cap": 5000000,
        "participation": [0.1, 0.3],
        "label": "Tender offer, late 2025 (invented)",
        "note": "Invented per-person cap of $5M",
        "verified": false
      }
    ],
    "levels": [
      { "name": "L3", "stockPerYear": 70000 },
      { "name": "L4", "stockPerYear": 150000 },
      { "name": "L5", "stockPerYear": 280000 },
      { "name": "L6", "stockPerYear": 600000 }
    ]
  },
  "Demo Company B": {
    "foundedYear": 2012,
    "referenceValuationB": 15,
    "earlyHireValuationB": 1,
    "curve": [
      ["2012-06-01", 0.5, 0.03],
      ["2015-01-01", 3.0, 0.4],
      ["2018-05-01", 9.0, 2],
      ["2021-09-01", 30.0, 10],
      ["2024-06-01", 48.0, 18],
      ["2026-05-01", 70.0, 28]
    ],
    "priceRef": {
      "low": 70,
      "high": 78,
      "lowLabel": "$70: latest priced round (invented)",
      "highLabel": "$78: modest premium on the latest round (invented)"
    },
    "vesting": { "yearlyPercent": [40, 30, 20, 10], "cliffMonths": 0 },
    "structure": {
      "type": "single",
      "trigger": "Single-trigger RSUs: taxed at vest; 40/30/20/10 schedule",
      "liquidity": "Invented example: taxed as ordinary income when each tranche vests (shares withheld or sold to cover); later sales are capital gains. No tender is assumed."
    },
    "tenders": [],
    "levels": [
      { "name": "IC1", "stockPerYear": 40000 },
      { "name": "IC2", "stockPerYear": 100000 },
      { "name": "IC3", "stockPerYear": 220000 },
      { "name": "IC4", "stockPerYear": 480000 }
    ]
  }
};
