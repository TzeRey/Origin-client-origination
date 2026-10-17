/*
 * ORIGIN PROSPECTS TEMPLATE
 * -------------------------------------------------------------------------------------------------
 * Use this file as a starting point for your own list of prospects. On the dashboard, choose it in the
 * "1 Prospects" upload section. The company details the equity model needs go in a second file (see
 * templates/company-profiles-template.js) and are loaded in the "2 Company profiles" section.
 *
 * HOW IT IS READ
 *   The file is read as DATA. It is never run as code, so only the list below is used. Everything else in this file
 *   (including these comments) is ignored. The list must be valid JSON: double-quoted keys and text, no expressions
 *   or functions. Trailing commas are tolerated.
 *
 * WHAT STAYS WHERE
 *   Your file is read inside your browser and kept in this browser tab only (session storage). It is not uploaded
 *   anywhere. Only when you press "Initiate outreach" for ONE person are that person's name, company and title sent to
 *   your local server and the research services you have switched on.
 *
 * ONLY LOAD DATA YOU ARE ALLOWED TO PROCESS. See "Ethics and Intended Use" in the README.
 *
 * FIELDS (one object per person)
 *    REQUIRED   name        text   Full name. A single name or an initial is accepted but flagged as unreliable to screen.
 *               company     text   Must match a company name in your company profiles file.
 *                                  Prospects at a company with no profile are listed but not estimated (shown as n/a).
 *               title       text   Job title. It decides which pay track the person is placed on.
 *               startDate   text   YYYY-MM-DD. A date before the company's foundedYear is shown as n/a, not estimated.
 *    OPTIONAL   seniority   text   For example "entry", "senior", "manager", "director", "vp".
 *               department  text   For example "Engineering/Technical". Missing departments are flagged.
 *               subDepartment text
 *               tenure      number Years at the company. Worked out from startDate when left out.
 *               founder     true/false  Marks a founder. Founder stakes are not captured by pay bands, so the result is
 *                                  a low-confidence placeholder.
 *               city        text   Shown on the card. Taxes are modeled for a San Francisco resident either way.
 */
window.RAW_PROSPECTS = [
  {
    "name": "Example Person 1",
    "company": "Example Corp",
    "title": "Software Engineer",
    "seniority": "entry",
    "department": "Engineering/Technical",
    "subDepartment": "Engineering; Software Dev",
    "startDate": "2022-03-01"
  },
  {
    "name": "Example Person 2",
    "company": "Example Corp",
    "title": "Director of Engineering",
    "seniority": "director",
    "department": "Engineering/Technical",
    "startDate": "2019-09-01"
  },
  {
    "name": "Example Person 3",
    "company": "Example Corp",
    "title": "Product Manager",
    "seniority": "manager",
    "department": "Product Mgmt",
    "startDate": "2021-06-01"
  }
];
