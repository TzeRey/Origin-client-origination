"use strict";
/* GET /api/health: reports demo mode. See api/_demo.js. The setup runs when this file loads, so the function can never start in live mode. */
const demo = require("./_demo");

module.exports = (req, res) => demo.handle(req, res);
