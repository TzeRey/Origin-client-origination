"use strict";
/* Test helper: serves the real app plus /test-app.html, which auto-clicks through to a finished dossier. Mock mode only. */
process.env.OUTREACH_MOCK = "1";
process.env.OUTREACH_MOCK_FAST = process.env.OUTREACH_MOCK_FAST || "1";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { server } = require("../server/server");

const HOOK = `<script>
addEventListener("load", () => setTimeout(() => {
  document.querySelector("#sampleButton").click(); // load the fictional sample; the loading animation plays for about 5 s
  const wait = setInterval(() => {
    if (document.querySelector("#discoveryResults").hidden) return;
    clearInterval(wait);
    const index = Number(new URLSearchParams(location.search).get("card") || 0);
    document.querySelectorAll(".details-button")[index].click();
    setTimeout(() => document.querySelector("#initiateOutreach").click(), 250);
  }, 100);
}, 100));
</script>`;

const wrapper = http.createServer((req, res) => {
  if (req.url.startsWith("/test-app.html")) {
    const html = fs.readFileSync(path.join(__dirname, "..", "app.html"), "utf8").replace("</body>", `${HOOK}</body>`);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }
  return server.emit("request", req, res);
});
wrapper.listen(Number(process.env.TEST_PORT) || 8788, "127.0.0.1", () => console.log("test harness ready"));