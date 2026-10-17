"use strict";

/* Sign-off format and mailto link tests (pure functions from compose.js). */
const test = require("node:test");
const assert = require("node:assert/strict");

global.window = global.window || {};
require("../compose.js");
const { signature, assembleBody, buildMailto, cleanDetails, validateDetails, OPT_OUT_FOOTER } = global.window.Compose;

const FULL = { firstName: "Ada", lastName: "Lovelace", pronouns: "she/her", jobTitle: "Director, Private Banking", employer: "Harbor & Pine Private Bank", phone: "+1 415 555 0100", email: "ada@bank.example" };

test("signature has exactly the requested four-line format", () => {
  assert.ok(!signature(FULL).includes("Harbor"), "the employer name is not part of the signature");
  assert.equal(signature(FULL), "Ada Lovelace (she/her)\nDirector, Private Banking\n+1 415 555 0100\nada@bank.example");
});

test("blank optional fields (pronouns, phone) are left out cleanly", () => {
  assert.equal(signature({ ...FULL, pronouns: "" }), "Ada Lovelace\nDirector, Private Banking\n+1 415 555 0100\nada@bank.example");
  assert.equal(signature({ ...FULL, phone: "" }), "Ada Lovelace (she/her)\nDirector, Private Banking\nada@bank.example");
});

test("details are cleaned: whitespace collapsed, newlines removed, pronoun brackets normalised, lengths capped", () => {
  const d = cleanDetails({ firstName: "  Ada\n", lastName: "Love  lace", pronouns: "(she/her)", jobTitle: "Dir\r\nector", email: " ada@bank.example ", phone: "x".repeat(200) });
  assert.equal(d.firstName, "Ada");
  assert.equal(d.lastName, "Love lace");
  assert.equal(d.pronouns, "she/her");
  assert.equal(d.jobTitle, "Dir ector");
  assert.equal(d.email, "ada@bank.example");
  assert.equal(d.phone.length, 40);
  assert.ok(!/[\r\n]/.test(signature({ ...FULL, ...d })) || signature({ ...FULL, ...d }).split("\n").length === 4);
});

test("required fields and email format are validated", () => {
  assert.deepEqual(validateDetails(FULL), {});
  assert.deepEqual(Object.keys(validateDetails({ ...FULL, firstName: "", lastName: "", jobTitle: "", employer: "", email: "" })).sort(), ["email", "employer", "firstName", "jobTitle", "lastName"]);
  assert.ok(validateDetails({ ...FULL, email: "not-an-email" }).email);
  assert.ok(validateDetails({ ...FULL, email: "a b@c.com" }).email);
  assert.ok(validateDetails({ ...FULL, employer: "<script>" }).employer, "markup in the employer name is rejected");
  assert.ok(validateDetails({ ...FULL, employer: "https://x.example" }).employer);
  assert.deepEqual(validateDetails({ ...FULL, employer: "J.P. Morgan & Co. (Private)" }), {});
  assert.deepEqual(validateDetails({ ...FULL, pronouns: "", phone: "" }), {});
});

test("mailto link encodes subject/body safely and uses CRLF line breaks", () => {
  const href = buildMailto({ to: "jane@example.com", subject: "Hi & welcome? #1", body: "Line one\nLine two & more=1\n\nAda" });
  assert.ok(href.startsWith("mailto:jane@example.com?subject="));
  assert.ok(href.includes("subject=Hi%20%26%20welcome%3F%20%231"));
  assert.ok(href.includes("Line%20one%0D%0ALine%20two%20%26%20more%3D1%0D%0A%0D%0AAda"));
  assert.ok(!/[\r\n ]/.test(href));
});

test("a missing or invalid To address is left blank rather than breaking the link", () => {
  assert.ok(buildMailto({ to: "", subject: "s", body: "b" }).startsWith("mailto:?subject="));
  assert.ok(buildMailto({ to: "x@y.com?cc=evil@z.com", subject: "s", body: "b" }).startsWith("mailto:?subject="), "header injection via To is blocked");
  assert.ok(buildMailto({ to: "a b", subject: "s", body: "b" }).startsWith("mailto:?subject="));
});
test("every email ends with the signature, then a transparency and opt-out line", () => {
  const full = assembleBody("Hi Jane,\n\nA friendly note.\n\nWarm regards,", FULL);
  assert.ok(full.endsWith(`${signature(FULL)}\n\n${OPT_OUT_FOOTER}`), "order: body, signature, footer");
  assert.match(OPT_OUT_FOOTER, /how you|hearing from me/i, "says why they are being contacted");
  assert.match(OPT_OUT_FOOTER, /no thanks/i, "gives a simple way to opt out");
  assert.match(OPT_OUT_FOOTER, /won't contact you again/, "promises no further contact");
  assert.match(OPT_OUT_FOOTER, /delete your details/, "promises erasure");
  assert.match(OPT_OUT_FOOTER, /what I hold about you/, "offers access to what is held");
  assert.ok(!signature(FULL).includes("no thanks"), "the footer is not part of the signature");
  assert.equal(full.split(OPT_OUT_FOOTER).length, 2, "the footer appears exactly once");
});

test("a realistic email with signature and footer still fits in a mailto link", () => {
  const body = "Hi Priya,\n\nI work in private banking at Harbor & Pine Private Bank, mostly with people in tech, and I'm always keen to learn more about what they actually do day to day. Your post, \"Notes on making query planners explain themselves\", made me curious about what drew you to that problem.\n\nIf you'd be open to it, I'd enjoy a relaxed coffee, a short call or a video catch-up, whichever suits you, and you're very welcome to pick the time. I'd mostly be there to listen and learn.\n\nAnd if it's not a good moment, no worries at all.\n\nWarm regards,";
  const href = buildMailto({ to: "", subject: "A coffee chat about query engines?", body: assembleBody(body, FULL) });
  assert.ok(href.length < 1900, `mailto is ${href.length} characters`);
  assert.ok(decodeURIComponent(href).includes(OPT_OUT_FOOTER.replace(/\n/g, "\r\n")));
});