"use strict";
/* POST /api/outreach: streams a SYNTHETIC research dossier (demo mode only). See api/_demo.js. The setup runs when this file loads, so the function can never start in live mode. */
const demo = require("./_demo");

module.exports = (req, res) => demo.handle(req, res);
