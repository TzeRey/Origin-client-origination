/*
 * Getting data into the page. There are two separate upload sections, one for the PROSPECTS file and one for the
 * COMPANY PROFILES file, plus a button that loads a small fictional sample.
 *
 * Files are read as TEXT inside the browser and parsed by DataLoader, which never executes them. Nothing is uploaded.
 * Everything that comes from a file is written to the page with textContent, never as HTML.
 *
 * Each section reads only its own part of a file. A file that has both parts (like the sample) works in either section.
 */
(() => {
  "use strict";

  if (typeof DataLoader === "undefined") return;

  const SAMPLE_URL = "templates/sample-data-pack.js";
  const KINDS = {
    prospects: {
      title: "Load your prospects",
      kicker: "1 Prospects",
      lede: "A file with your list of people: name, company, title and start date.",
      template: "templates/prospects-template.js",
      templateName: "prospects-template.js",
      templateLabel: "Download the prospects template",
      dropLabel: "Choose a prospects file"
    },
    profiles: {
      title: "Load company profiles",
      kicker: "2 Company profiles",
      lede: "A file with the company details the equity model needs for each employer: funding rounds, vesting, tender offers and pay levels.",
      template: "templates/company-profiles-template.js",
      templateName: "company-profiles-template.js",
      templateLabel: "Download the company profiles template",
      dropLabel: "Choose a company profiles file"
    }
  };

  const dialog = document.createElement("dialog");
  dialog.id = "dataDialog";
  dialog.className = "compose-dialog data-dialog";
  dialog.setAttribute("aria-labelledby", "dataTitle");
  document.body.appendChild(dialog);

  /* tiny safe element builder: text goes in as text, never as HTML */
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    for (const child of children) if (child) node.append(child);
    return node;
  }

  /* replaceChildren turns a null argument into the text "null", so empty slots are dropped first. */
  const show = (...nodes) => dialog.replaceChildren(...nodes.filter(Boolean));
  const closeButton = () => el("button", { class: "dialog-close", type: "button", "aria-label": "Close", text: "x", onclick: () => dialog.close() });
  const kb = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  function wireDrop(zone, onFile) {
    zone.addEventListener("dragover", (event) => { event.preventDefault(); zone.classList.add("is-over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("is-over"));
    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      zone.classList.remove("is-over");
      if (event.dataTransfer.files[0]) onFile(event.dataTransfer.files[0]);
    });
  }

  /* ---------------------------------------------------------------- the dialog (one kind of file at a time) */
  function showStart(kind, message = "") {
    const k = KINDS[kind];
    const input = el("input", { type: "file", id: "dataFile", accept: ".js,.json,.txt,text/javascript,application/json", class: "dz-input" });
    input.addEventListener("change", () => input.files[0] && handleFile(input.files[0], kind));
    const zone = el("label", { class: "dz", for: "dataFile" },
      el("strong", { text: k.dropLabel }),
      el("span", { text: "or drop it here (.js or .json, up to 5 MB)" }),
      input
    );
    wireDrop(zone, (file) => handleFile(file, kind));

    show(
      closeButton(),
      el("span", { class: "d-kicker", text: k.kicker }),
      el("h2", { id: "dataTitle", text: k.title }),
      el("p", { class: "compose-lede", text: `${k.lede} It replaces the ${kind === "prospects" ? "prospects" : "company profiles"} currently on the page.` }),
      message ? el("p", { class: "c-form-error", role: "alert", text: message }) : null,
      zone,
      el("ul", { class: "data-points" },
        el("li", {}, el("b", { text: "Your file is read as data, never run as code. " }), "So it can contain nothing but the lists described in the template."),
        el("li", {}, el("b", { text: "It stays in this tab. " }), "Nothing is uploaded. It is forgotten when you close the tab or choose Load different data."),
        el("li", {}, el("b", { text: "Only load data you may process. " }), "When you press Initiate outreach for one person, that person's name, company and title go to your local server and the research services you enabled.")
      ),
      el("p", { class: "c-hint-line" },
        el("a", { href: k.template, download: k.templateName, text: k.templateLabel }),
        " (a .js file with comments explaining every field)"
      ),
      el("div", { class: "c-actions" }, el("button", { class: "c-btn", type: "button", text: "Cancel", onclick: () => dialog.close() }))
    );
  }

  function openDialog(kind) {
    showStart(kind);
    if (!dialog.open) dialog.showModal();
  }

  async function handleFile(file, kind) {
    const k = KINDS[kind];
    if (!dialog.open) dialog.showModal();
    show(
      closeButton(),
      el("span", { class: "d-kicker", text: k.kicker }),
      el("h2", { id: "dataTitle", text: "Reading your file" }),
      el("p", { class: "compose-lede", text: `${file.name} (${kb(file.size)})` })
    );
    if (file.size > DataLoader.MAX_BYTES) return showStart(kind, `That file is ${kb(file.size)}. The limit is 5 MB.`);
    let text;
    try {
      text = await file.text();
    } catch {
      return showStart(kind, "The file could not be read.");
    }
    const pack = DataLoader.parsePack(text, { asOf: EquityModel.AS_OF });
    const profileNames = pack.profiles ? Object.keys(pack.profiles) : [];

    if (kind === "prospects") {
      if (pack.fatal && !/^No prospects found/.test(pack.fatal)) return showStart(kind, pack.fatal);
      if (pack.fatal || !pack.prospects.length) {
        return showStart(kind, profileNames.length
          ? "This file has company profiles but no prospects. Use the Company profiles section for it."
          : "No prospects found. The file should contain window.RAW_PROSPECTS = [ ... ]; See the prospects template.");
      }
      return showProspectsPreview(file, pack, profileNames);
    }
    if (pack.fatal && !/^No prospects found/.test(pack.fatal)) return showStart(kind, pack.fatal);
    if (pack.fatal || !profileNames.length) {
      return showStart(kind, pack.prospects?.length
        ? "This file has prospects but no company profiles. Use the Prospects section for it."
        : "No company profiles found. The file should contain window.COMPANY_PROFILES = { ... }; See the company profiles template.");
    }
    return showProfilesPreview(file, pack, profileNames);
  }

  const summaryTable = (headings, rows) => el("table", { class: "data-table" },
    el("thead", {}, el("tr", {}, ...headings.map((h) => el("th", { text: h })))),
    el("tbody", {}, ...rows.map((cells) => el("tr", {}, ...cells.map((c) => el("td", c.tone ? { class: `tone-${c.tone}`, text: c.text } : { text: c.text })))))
  );
  const problemsBox = (items) => (items.length ? el("div", { class: "data-problems", role: "status" }, el("strong", { text: "Things to know" }), el("ul", {}, ...items.map((m) => el("li", { text: m })))) : null);

  /* ---- prospects preview */
  function showProspectsPreview(file, pack, profileNames) {
    const k = KINDS.prospects;
    const counts = new Map();
    for (const p of pack.prospects) counts.set(p.company, (counts.get(p.company) || 0) + 1);
    const known = new Set(window.Origin.profileNames());
    const rows = [...counts].map(([company, count]) => [
      { text: company },
      { text: String(count) },
      known.has(company)
        ? { text: "Company profile loaded", tone: "ok" }
        : { text: "No company profile yet: add one in section 2, or these will show n/a", tone: "warn" }
    ]);

    const problems = [];
    for (const e of pack.errors.slice(0, 5)) problems.push(e.message);
    if (pack.counts.skipped > 5) problems.push(`...and ${pack.counts.skipped - 5} more rows with problems.`);
    for (const w of pack.warnings) problems.push(w);
    if (profileNames.length) problems.push(`This file also contains ${plural(profileNames.length, "company profile")}. They are not loaded from here: use the Company profiles section (this same file works there).`);

    show(
      closeButton(),
      el("span", { class: "d-kicker", text: k.kicker }),
      el("h2", { id: "dataTitle", text: "Check your prospects" }),
      el("p", { class: "compose-lede", text: `${file.name} (${kb(file.size)}). ${plural(pack.counts.valid, "prospect")} found${pack.counts.skipped ? `, ${pack.counts.skipped} skipped because of problems` : ""}.` }),
      summaryTable(["Company", "Prospects", "Equity model"], rows),
      problemsBox(problems),
      el("div", { class: "c-actions" },
        el("button", { class: "c-btn", type: "button", text: "Back", onclick: () => showStart("prospects") }),
        el("button", { class: "c-btn c-btn-primary", type: "button", text: `Load ${plural(pack.counts.valid, "prospect")}`, onclick: () => commit("prospects", file, pack) })
      )
    );
  }

  /* ---- company profiles preview */
  function showProfilesPreview(file, pack, profileNames) {
    const k = KINDS.profiles;
    const covered = window.Origin.companyCounts();
    const results = profileNames.map((name) => ({ name, errors: EquityModel.validateProfile(String(name).trim(), pack.profiles[name]).errors }));
    const valid = results.filter((r) => r.errors.length === 0);
    const rows = results.map((r) => {
      const prospects = covered[r.name.trim()] || 0;
      return [
        { text: r.name },
        r.errors.length ? { text: `Has ${plural(r.errors.length, "problem")}: will be skipped`, tone: "bad" } : { text: "Valid", tone: "ok" },
        { text: prospects ? `${plural(prospects, "loaded prospect")}` : "No loaded prospects yet" }
      ];
    });

    const problems = [];
    for (const r of results) for (const message of r.errors.slice(0, 3)) problems.push(`Profile "${r.name}": ${message}`);
    const loadedCompanies = Object.keys(covered);
    const uncovered = loadedCompanies.filter((c) => !results.some((r) => r.name.trim() === c && r.errors.length === 0));
    if (uncovered.length) problems.push(`Loaded prospects at companies with no valid profile in this file: ${uncovered.join(", ")}. They will show n/a.`);
    if (pack.prospects.length) problems.push(`This file also contains ${plural(pack.prospects.length, "prospect")}. They are not loaded from here: use the Prospects section (this same file works there).`);

    const load = el("button", {
      class: "c-btn c-btn-primary",
      type: "button",
      text: `Load ${plural(valid.length, "company profile")}`,
      onclick: () => commit("profiles", file, pack)
    });
    if (!valid.length) load.disabled = true;

    show(
      closeButton(),
      el("span", { class: "d-kicker", text: k.kicker }),
      el("h2", { id: "dataTitle", text: "Check your company profiles" }),
      el("p", { class: "compose-lede", text: `${file.name} (${kb(file.size)}). ${plural(results.length, "company profile")} found, ${valid.length} valid.` }),
      summaryTable(["Company", "Profile", "Prospects covered"], rows),
      problemsBox(problems),
      el("div", { class: "c-actions" },
        el("button", { class: "c-btn", type: "button", text: "Back", onclick: () => showStart("profiles") }),
        load
      )
    );
  }

  /* Loads the file. The page plays its loading animation (once both parts are in), then shows the results. */
  function commit(kind, file, pack) {
    const { persisted } = kind === "prospects"
      ? window.Origin.loadProspects(pack.prospects, file.name)
      : window.Origin.loadProfiles(pack.profiles, file.name);
    dialog.close();
    if (!persisted) document.querySelector(".data-notice")?.append(" (Too large to keep after a reload.)");
    document.querySelector("#opportunities")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ---------------------------------------------------------------- the two sections on the prompt */
  const promptError = document.querySelector("#promptError");
  const setPromptError = (message) => {
    if (!promptError) return;
    promptError.hidden = !message;
    promptError.textContent = message || "";
  };

  for (const [kind, inputId, dropId] of [["prospects", "#fileProspects", "#dropProspects"], ["profiles", "#fileProfiles", "#dropProfiles"]]) {
    const input = document.querySelector(inputId);
    input?.addEventListener("change", () => {
      const file = input.files[0];
      input.value = ""; // so choosing the same file again still triggers a change
      setPromptError("");
      if (file) handleFile(file, kind);
    });
    const drop = document.querySelector(dropId);
    if (drop) wireDrop(drop, (file) => { setPromptError(""); handleFile(file, kind); });
  }

  /* ---------------------------------------------------------------- the sample data */
  async function loadSample() {
    const button = document.querySelector("#sampleButton");
    setPromptError("");
    if (button) button.disabled = true;
    try {
      const res = await fetch(SAMPLE_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(`The sample data could not be loaded (${res.status}).`);
      const pack = DataLoader.parsePack(await res.text(), { asOf: EquityModel.AS_OF });
      if (pack.fatal) throw new Error(pack.fatal);
      window.Origin.loadSample(pack);
    } catch (error) {
      setPromptError(error instanceof TypeError ? "The sample data could not be loaded. Make sure the app is opened through the local server (npm start)." : error.message);
    } finally {
      if (button) button.disabled = false;
    }
  }
  document.querySelector("#sampleButton")?.addEventListener("click", loadSample);

  /* ---------------------------------------------------------------- the toolbar buttons (replace one part at a time) */
  document.querySelector("#replaceProspects")?.addEventListener("click", () => openDialog("prospects"));
  document.querySelector("#replaceProfiles")?.addEventListener("click", () => openDialog("profiles"));

  window.DataUpload = { handleFile, loadSample, openDialog };
})();
