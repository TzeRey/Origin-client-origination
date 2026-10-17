const PAGE_SIZE = 24;
const fmt = (value) => EquityModel.formatUSD(value);
const pct = (value) => `${Number((value * 100).toFixed(2))}%`;

function initialsOf(name) {
  return name.split(" ").filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join("");
}
function firstSegment(value) {
  if (!value) return "";
  return value.split(";")[0].trim();
}
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}
function slugEmail(name) {
  return `${name.toLowerCase().replace(/\s+/g, ".")}@example.com`;
}

let prospects = [];

function buildProspects(raw) {
  return raw.map((person) => {
    const equity = EquityModel.estimate(person);
    const tags = [
      person.company,
      firstSegment(person.subDepartment || person.department),
      equity.estimated ? equity.structure.short : "Data issue"
    ].filter((tag, index, all) => tag && all.indexOf(tag) === index);
    return {
      ...person,
      city: person.city || "San Francisco, CA",
      initials: initialsOf(person.name),
      equity,
      tags,
      description: equity.estimated
        ? `${person.title}. ${person.tenure} years at ${person.company}, joined ${person.startDate}.`
        : `${person.title}. No equity estimate: open Details to see why.`,
      email: slugEmail(person.name)
    };
  });
}

/* Records with a data issue (no estimate) always sort last, whatever the sort mode. */
const estimatedFirst = (compare) => (a, b) =>
  (b.equity.estimated - a.equity.estimated) || compare(a, b);
const sortModes = [
  { label: "Net equity", compare: estimatedFirst((a, b) => b.equity.net.p50 - a.equity.net.p50) },
  { label: "Tenure", compare: estimatedFirst((a, b) => b.tenure - a.tenure) },
  { label: "Prospect name", compare: estimatedFirst((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })) }
];

const grid = document.querySelector("#cardGrid");
const pagination = document.querySelector("#pagination");
const searchInput = document.querySelector("#searchInput");
const thresholdSelect = document.querySelector("#thresholdSelect");
const resultText = document.querySelector("#resultsText");
const matchCount = document.querySelector("#matchCount");
const emptyState = document.querySelector("#emptyState");
const dialog = document.querySelector("#companyDialog");
const cardLoading = document.querySelector("#cardLoading");
const discoveryResults = document.querySelector("#discoveryResults");
const filterList = document.querySelector(".filter-list");
const dataPrompt = document.querySelector("#dataPrompt");
const discoveryToolbar = document.querySelector("#discoveryToolbar");
let activeFilter = "All";
let sortIndex = 0;
let currentPage = 0;
let loadingTimer;
let currentProspect = null;
let outreachController = null;
let lastDossier = null;
const dossierCard = document.querySelector("#dossierCard");
const initiateButton = document.querySelector("#initiateOutreach");

/* Position on a log scale from $1M to $1B, as a percentage. */
function logPosition(value) {
  const position = ((Math.log10(Math.max(value, 1e6)) - 6) / 3) * 100;
  return Math.max(0, Math.min(100, position));
}

function taxLine(eq) {
  const ordinary = pct(eq.tax.ordinary);
  const gains = pct(eq.tax.capitalGains);
  return eq.structure.type === "single"
    ? `Taxed as ordinary income (${ordinary}) at vest, then ${gains} on gains at sale.`
    : `Taxed as ordinary income (${ordinary}) when units settle at a tender or IPO.`;
}

function taxShort(eq) {
  const ordinary = pct(eq.tax.ordinary);
  return eq.structure.type === "single"
    ? `Taxed at vest (${ordinary}), ${pct(eq.tax.capitalGains)} on gains at sale.`
    : `Taxed when units settle (${ordinary}).`;
}

function tenderShort(eq) {
  if (!eq.hasTenders) return "No tender assumed.";
  return `Tender cash ≈ ${fmt(eq.tenderNet.p50)} net.`;
}

function tenderLine(eq) {
  if (!eq.hasTenders) return "No verified tender found; none assumed.";
  return `Tender cash ≈ ${fmt(eq.tenderNet.p50)} net across ${eq.tenders.filter((t) => t.eligible).length} eligible tender${eq.tenders.filter((t) => t.eligible).length === 1 ? "" : "s"}.`;
}

function makeCard(prospect, index) {
  const card = document.createElement("article");
  card.className = "company-card card-container perspective-1000";
  card.style.animationDelay = `${Math.min(index * 70, 560)}ms`;

  const eq = prospect.equity;
  const locationIcon = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13 6.7c0 3.6-5 7.1-5 7.1S3 10.3 3 6.7a5 5 0 1 1 10 0Z" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="6.5" r="1.5" stroke="currentColor" stroke-width="1.2"/></svg>';
  const tags = prospect.tags.map((tag, tagIndex) =>
    `<span class="industry-tag${tagIndex > 0 ? " industry-tag-secondary" : ""}">${esc(tag)}</span>`
  ).join("");
  const ok = eq.estimated;
  const rangeText = ok ? `${fmt(eq.net.p10)} – ${fmt(eq.net.p90)}` : "n/a";
  const left = logPosition(eq.net.p10);
  const width = Math.max(2.5, logPosition(eq.net.p90) - left);
  const confidenceClass = `confidence-${eq.confidence.toLowerCase().replace("/", "")}`;
  const headline = ok ? fmt(eq.net.p50) : "n/a";
  const name = esc(prospect.name);
  const company = esc(prospect.company);
  card.classList.toggle("is-unestimated", !ok);

  card.innerHTML = `
    <div class="card-inner">
      <div class="card-face card-front">
        <div class="card-front-content">
          <div class="card-top">
            <div class="company-identity">
              <div class="company-logo" aria-hidden="true">${esc(prospect.initials)}</div>
              <div>
                <h3 class="company-name">${name}</h3>
                <div class="company-location">${locationIcon}<span>${company} · ${esc(prospect.city.split(",")[0])}</span></div>
              </div>
            </div>
            <div class="fit-badge equity-badge" aria-label="${ok ? `Estimated net equity after tax about ${fmt(eq.net.p50)}, range ${rangeText}` : "No equity estimate: start date in the source data is invalid"}"><span class="fit-score">${headline}</span><span class="fit-label">net equity</span></div>
          </div>
          <p class="card-description">${esc(prospect.description)}</p>
          <div class="card-tags">${tags}</div>
          <div class="equity-range" title="After-tax, log scale $1M to $1B">
            <div class="equity-range-head"><span>Net range (P10–P90)</span><strong>${rangeText}</strong></div>
            <div class="range-track" aria-hidden="true">${ok ? `<span class="range-fill" style="left:${left}%;width:${width}%"></span><span class="range-mid" style="left:${logPosition(eq.net.p50)}%"></span>` : ""}</div>
            <div class="equity-range-foot"><span>Confidence: <b class="${confidenceClass}">${eq.confidence}</b></span><span>${ok ? `Pre-tax ≈ ${fmt(eq.gross.p50)}` : "Data issue: see Details"}</span></div>
          </div>
        </div>
        <div class="card-footer">
          <div class="contact-preview"><span class="contact-avatar">${esc(prospect.initials)}</span><span class="contact-preview-name">${company}</span></div>
          <div class="card-actions">
            <button class="flip-button" type="button" data-action="flip" aria-pressed="false" title="Show model assumptions">Assumptions <span aria-hidden="true">⟳</span></button>
            <button class="details-button" type="button" data-action="details" aria-label="Open details for ${name}">Details <span aria-hidden="true">↗</span></button>
          </div>
        </div>
      </div>
      <div class="card-face card-back">
        <div class="back-heading"><span>${company.toUpperCase()} · EQUITY MODEL</span><button type="button" data-action="flip" aria-label="Flip card back">×</button></div>
        <div class="back-copy"><h3>${name}</h3><p>${esc(eq.structure.short)} · ${esc(eq.schedule)}</p></div>
        <div class="equity-grid">
          <div class="equity-stat"><span class="back-label">NET OF TAX (EST.)</span><strong>${headline}</strong><small>${rangeText}</small></div>
          <div class="equity-stat"><span class="back-label">PRE-TAX VESTED</span><strong>${ok ? fmt(eq.gross.p50) : "n/a"}</strong><small>${ok ? `unvested ≈ ${fmt(eq.unvested.p50)}` : "not estimated"}</small></div>
        </div>
        <ul class="assumption-list">
          ${ok ? `<li><b>Tax &amp; tenders:</b> ${taxShort(eq)} ${tenderShort(eq)}</li>` : ""}
          <li class="clamp-2"><b>Confidence:</b> <span class="${confidenceClass}">${eq.confidence}</span>${eq.flags.length ? ` · ${esc(eq.flags[0])}` : ""}</li>
        </ul>
        <div class="back-footer"><span class="back-contact"><span class="contact-avatar">${esc(prospect.initials)}</span><span><strong>${company}</strong><small>${prospect.tenure} yrs tenure</small></span></span><button type="button" class="report-button" data-action="details">Details <span aria-hidden="true">↗</span></button></div>
      </div>
    </div>
  `;

  const front = card.querySelector(".card-front");
  const back = card.querySelector(".card-back");
  back.inert = true;
  back.setAttribute("aria-hidden", "true");

  card.querySelectorAll('[data-action="flip"]').forEach((button) => {
    button.addEventListener("click", () => {
      const isFlipped = card.classList.toggle("flipped");
      front.inert = isFlipped;
      front.setAttribute("aria-hidden", String(isFlipped));
      back.inert = !isFlipped;
      back.setAttribute("aria-hidden", String(!isFlipped));
      card.querySelectorAll('[data-action="flip"]').forEach((flipButton) => {
        flipButton.setAttribute("aria-pressed", String(isFlipped));
      });
      if (!isFlipped) card.querySelector(".flip-button")?.focus();
    });
  });
  card.querySelectorAll('[data-action="details"]').forEach((button) => {
    button.addEventListener("click", () => openProspect(prospect));
  });
  return card;
}

function getFilteredProspects() {
  const query = searchInput.value.trim().toLowerCase();
  const minimum = Number(thresholdSelect.value) || 0;
  const filtered = prospects.filter((prospect) => {
    const matchesCategory = activeFilter === "All" || prospect.company === activeFilter;
    const matchesThreshold = prospect.equity.net.p50 >= minimum;
    const searchable = [
      prospect.name, prospect.company, prospect.title, prospect.seniority,
      prospect.department, prospect.subDepartment, prospect.city, prospect.description, ...prospect.tags
    ].join(" ").toLowerCase();
    return matchesCategory && matchesThreshold && (!query || searchable.includes(query));
  });
  return filtered.sort(sortModes[sortIndex].compare);
}

function renderPagination(total, totalPages) {
  if (!pagination) return;
  if (totalPages <= 1) {
    pagination.hidden = true;
    pagination.innerHTML = "";
    return;
  }
  const first = currentPage * PAGE_SIZE + 1;
  const last = Math.min(total, (currentPage + 1) * PAGE_SIZE);
  const numbers = Array.from({ length: totalPages }, (_, index) =>
    `<button type="button" class="page-num${index === currentPage ? " is-active" : ""}" data-page="${index}" aria-label="Page ${index + 1}"${index === currentPage ? ' aria-current="page"' : ""}>${index + 1}</button>`
  ).join("");
  pagination.hidden = false;
  pagination.innerHTML = `
    <button type="button" class="page-btn" data-page="prev"${currentPage === 0 ? " disabled" : ""}><span aria-hidden="true">←</span> Previous</button>
    <div class="page-numbers">${numbers}</div>
    <button type="button" class="page-btn" data-page="next"${currentPage === totalPages - 1 ? " disabled" : ""}>Next <span aria-hidden="true">→</span></button>
    <span class="page-meta">Showing ${first}–${last} of ${total}</span>`;
}

function renderCards() {
  const visibleProspects = getFilteredProspects();
  const totalPages = Math.max(1, Math.ceil(visibleProspects.length / PAGE_SIZE));
  currentPage = Math.min(currentPage, totalPages - 1);
  const pageItems = visibleProspects.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  grid.replaceChildren(...pageItems.map(makeCard));
  grid.hidden = visibleProspects.length === 0;
  emptyState.hidden = visibleProspects.length !== 0;
  resultText.textContent = `${String(visibleProspects.length).padStart(2, "0")} ${visibleProspects.length === 1 ? "qualified prospect" : "qualified prospects"}`;
  matchCount.textContent = String(visibleProspects.length).padStart(2, "0");
  document.querySelector(".filter-chip.is-active")?.append(matchCount);
  renderPagination(visibleProspects.length, totalPages);
}

function goToPage(page) {
  currentPage = page;
  renderCards();
  document.querySelector("#opportunities").scrollIntoView({ behavior: "smooth", block: "start" });
}

function dialogEquityHTML(prospect) {
  const eq = prospect.equity;
  if (!eq.estimated) {
    return `
    <div class="data-issue" role="alert">
      <strong>No equity estimate: data issue</strong>
      <p>${esc(eq.dataIssue)}</p>
    </div>
    <ul class="assumption-list dialog-assumptions">
      ${prospect.nameIncomplete ? `<li class="assumption-flag"><b>Flag:</b> ${esc(eq.flags[eq.flags.length - 1])}</li>` : ""}
    </ul>`;
  }
  const confidenceClass = `confidence-${eq.confidence.toLowerCase()}`;
  const tenderItems = eq.hasTenders
    ? eq.tenders.map((tender) => `<li><b>${esc(tender.label)}:</b> ${tender.eligible ? "eligible" : "not eligible (joined too recently)"}; ${esc(tender.note)}${tender.verified ? "" : " (assumption)"}.</li>`).join("")
    : "<li><b>Tender offers:</b> no verified employee tender found, so none is assumed.</li>";
  const flags = eq.flags.map((flag) => `<li class="assumption-flag"><b>Flag:</b> ${esc(flag)}</li>`).join("");
  return `
    <div class="dialog-stats">
      <div class="dialog-stat"><span>Net equity, after tax (median)</span><strong>${fmt(eq.net.p50)}</strong><small>${fmt(eq.net.p10)} – ${fmt(eq.net.p90)}</small></div>
      <div class="dialog-stat"><span>Pre-tax vested value</span><strong>${fmt(eq.gross.p50)}</strong><small>unvested ≈ ${fmt(eq.unvested.p50)}</small></div>
      <div class="dialog-stat"><span>Confidence</span><strong class="${confidenceClass}">${eq.confidence}</strong><small>range ${eq.width.toFixed(1)}× wide</small></div>
    </div>
    <ul class="assumption-list dialog-assumptions">
      <li><b>Net breakdown:</b> tender cash ≈ ${fmt(eq.tenderNet.p50)} (after tax) + remaining equity ≈ ${fmt(eq.remainingNet.p50)} (after hypothetical liquidation tax).</li>
      <li><b>Tax dollars:</b> ≈ ${fmt(eq.taxes.p50)} in total. Net is below pre-tax value minus tax because units sold in tenders or withheld for tax lose later appreciation.</li>
      <li><b>Refresh grants:</b> ≈ ${Math.round(eq.refreshShare * 100)}% of vested value (annual refresh of 0–50% of the initial grant).</li>
      <li><b>Level basis:</b> ${esc(eq.band.basis)}; ${fmt(eq.band.low)}–${fmt(eq.band.high)} stock per year.</li>
      <li><b>Vesting:</b> ${esc(eq.schedule)}.</li>
      <li><b>Structure:</b> ${esc(eq.structure.trigger)}. ${taxLine(eq)}</li>
      <li><b>Taxes:</b> ${eq.tax.label}: ${eq.tax.note}</li>
      <li><b>Share price range:</b> ${esc(eq.priceRef.lowLabel)} to ${esc(eq.priceRef.highLabel)}.</li>
      <li><b>Liquidity:</b> ${esc(eq.structure.liquidity)}</li>
      ${tenderItems}
      ${flags}
    </ul>
    <p class="dialog-caveat">Modeled from public data (title, start date, market prices). Not verified holdings, income or net worth. Tax assumes a US resident at the top marginal bracket; QSBS, AMT, charitable gifts and cash reinvestment are not modeled.</p>`;
}

function openProspect(prospect) {
  document.querySelector("#dialogMark").textContent = prospect.initials;
  document.querySelector("#dialogIndustry").textContent = `${prospect.company} · ${prospect.city}`;
  document.querySelector("#dialogName").textContent = prospect.name;
  document.querySelector("#dialogDescription").textContent = prospect.description;
  document.querySelector("#dialogEquity").innerHTML = dialogEquityHTML(prospect);
  document.querySelector("#dialogContact").innerHTML = `
    <span class="contact-avatar">${esc(prospect.initials)}</span>
    <span><span class="dialog-contact-name">${esc(prospect.name)}</span><br /><span class="dialog-contact-role">${esc(prospect.title)}</span></span>`;
  currentProspect = prospect;
  resetOutreach();
  dialog.showModal();
}

/* ---------- Outreach agent (runs only when "Initiate outreach" is pressed) ---------- */
function resetOutreach() {
  if (outreachController) outreachController.abort();
  outreachController = null;
  lastDossier = null;
  dossierCard.hidden = true;
  dossierCard.innerHTML = "";
  dialog.classList.remove("dossier-open");
  initiateButton.disabled = false;
  initiateButton.innerHTML = 'Initiate outreach <span aria-hidden="true">↗</span>';
}

function outreachPayload(prospect) {
  const eq = prospect.equity;
  return {
    name: prospect.name,
    company: prospect.company,
    title: prospect.title,
    startDate: prospect.startDate,
    department: prospect.department,
    equity: {
      netP50: eq.net.p50,
      netP10: eq.net.p10,
      netP90: eq.net.p90,
      structure: eq.structure.trigger,
      liquidity: eq.structure.liquidity,
      confidence: eq.confidence
    }
  };
}

async function startOutreach() {
  if (!currentProspect) return;
  const prospect = currentProspect;
  if (outreachController) outreachController.abort();
  outreachController = new AbortController();
  const controller = outreachController;
  const steps = new Map();
  const toolHealth = await Dossier.health();

  initiateButton.disabled = true;
  initiateButton.innerHTML = 'Researching… <span class="btn-spinner" aria-hidden="true"></span>';
  dossierCard.hidden = false;
  dialog.classList.add("dossier-open");
  dossierCard.innerHTML = Dossier.progressHTML(steps, prospect, toolHealth);
  dossierCard.scrollIntoView({ behavior: "smooth", block: "start" });

  try {
    let result = null;
    await Dossier.run(outreachPayload(prospect), {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "step") {
          steps.set(event.id, event);
          dossierCard.innerHTML = Dossier.progressHTML(steps, prospect, toolHealth);
        } else if (event.type === "result") {
          result = event.dossier;
        } else if (event.type === "error") {
          throw new Error(event.message);
        }
      }
    });
    if (controller.signal.aborted) return;
    if (!result) throw new Error("The research service finished without returning a dossier.");
    lastDossier = result;
    dossierCard.innerHTML = Dossier.renderDossier(result, toolHealth);
    initiateButton.innerHTML = 'Re-run research <span aria-hidden="true">↻</span>';
  } catch (error) {
    if (controller.signal.aborted) return;
    const message = error instanceof TypeError ? "Could not reach the local research service." : error.message;
    dossierCard.innerHTML = Dossier.errorHTML(message, prospect);
    initiateButton.innerHTML = 'Try again <span aria-hidden="true">↻</span>';
  } finally {
    if (outreachController === controller) initiateButton.disabled = false;
  }
}

dossierCard.addEventListener("click", async (event) => {
  const action = event.target.closest("[data-dossier]")?.dataset.dossier;
  if (!action || !lastDossier) return;
  if (action === "copy") {
    try {
      await navigator.clipboard.writeText(Dossier.briefText(lastDossier));
      event.target.textContent = "Copied";
    } catch {
      event.target.textContent = "Copy failed";
    }
    window.setTimeout(() => { event.target.textContent = "Copy brief"; }, 1800);
  } else if (action === "converse") {
    Compose.open(lastDossier);
  } else if (action === "pdf") {
    const button = event.target.closest("[data-dossier]");
    const original = "Download dossier (PDF)";
    button.disabled = true;
    button.textContent = "Preparing PDF…";
    try {
      await DossierPDF.save(lastDossier);
      button.textContent = "Downloaded";
    } catch (error) {
      console.error(error);
      button.textContent = "PDF failed. Try again";
    }
    window.setTimeout(() => { button.textContent = original; button.disabled = false; }, 2200);
  } else if (action === "download") {
    const blob = new Blob([JSON.stringify(lastDossier, null, 2)], { type: "application/json" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `${lastDossier.subject.name.replace(/\W+/g, "-").toLowerCase()}-dossier.json`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }
});

initiateButton.addEventListener("click", startOutreach);
dialog.addEventListener("close", resetOutreach);

function renderSnapshot() {
  const snapshot = document.querySelector("#snapshot");
  if (!snapshot) return;
  const estimatedOnly = prospects.filter((prospect) => prospect.equity.estimated);
  const skipped = prospects.length - estimatedOnly.length;
  const values = estimatedOnly.map((prospect) => prospect.equity.net.p50).sort((a, b) => a - b);
  if (!values.length) {
    snapshot.innerHTML = `
    <div class="snapshot-head"><span>Shortlist snapshot</span><em>No data loaded</em></div>
    <p class="snapshot-empty">${skipped ? `None of the ${skipped} prospects could be estimated (see Details on each card).` : "Upload your prospects, or try the sample data, to see the spread of estimated net equity here."}</p>`;
    return;
  }
  const count = values.length;
  const median = count % 2 ? values[(count - 1) / 2] : (values[count / 2 - 1] + values[count / 2]) / 2;
  const aboveThreshold = values.filter((value) => value >= 10e6).length;
  const binCount = 12;
  const bins = new Array(binCount).fill(0);
  values.forEach((value) => {
    const index = Math.floor(((Math.log10(value) - 6) / 3) * binCount);
    bins[Math.max(0, Math.min(binCount - 1, index))] += 1;
  });
  const peak = Math.max(...bins);
  const bars = bins.map((binValue, index) => binValue
    ? `<i style="height:${Math.max(16, (binValue / peak) * 100)}%;animation-delay:${index * 45}ms" title="${binValue} prospect${binValue === 1 ? "" : "s"}"></i>`
    : `<i class="empty" style="height:4px;animation-delay:${index * 45}ms"></i>`).join("");
  snapshot.innerHTML = `
    <div class="snapshot-head"><span>Shortlist snapshot</span><em>Modeled · not verified</em></div>
    <div class="snapshot-stats">
      <div><strong>${count}</strong><span>prospects estimated${skipped ? ` · ${skipped} not estimated` : ""}</span></div>
      <div><strong>${fmt(median)}</strong><span>median est. net equity</span></div>
      <div><strong>${aboveThreshold}</strong><span>above $10M</span></div>
    </div>
    <div class="snapshot-chart" role="img" aria-label="Distribution of estimated net equity across the shortlist">${bars}</div>
    <div class="snapshot-foot"><span>$1M</span><span>Est. net equity, after tax · log scale</span><span>$1B</span></div>`;
}

function openMethodology(event) {
  if (event) event.preventDefault();
  const details = document.querySelector("#methodology");
  details.open = true;
  details.scrollIntoView({ behavior: "smooth", block: "start" });
}

filterList.addEventListener("click", (event) => {
  const button = event.target.closest(".filter-chip");
  if (!button || !filterList.contains(button)) return;
  activeFilter = button.dataset.filter;
  currentPage = 0;
  document.querySelector(".filter-chip.is-active")?.classList.remove("is-active");
  button.classList.add("is-active");
  renderCards();
});

pagination?.addEventListener("click", (event) => {
  const target = event.target.closest("[data-page]");
  if (!target || target.disabled) return;
  const value = target.dataset.page;
  if (value === "prev") goToPage(Math.max(0, currentPage - 1));
  else if (value === "next") goToPage(currentPage + 1);
  else goToPage(Number(value));
});

searchInput.addEventListener("input", () => { currentPage = 0; renderCards(); });
thresholdSelect.addEventListener("change", () => { currentPage = 0; renderCards(); });
document.querySelector("#sortButton").addEventListener("click", (event) => {
  sortIndex = (sortIndex + 1) % sortModes.length;
  currentPage = 0;
  event.currentTarget.innerHTML = `${sortModes[sortIndex].label} <span aria-hidden="true">⌄</span>`;
  renderCards();
});
document.querySelector("#resetButton").addEventListener("click", () => {
  searchInput.value = "";
  thresholdSelect.value = "0";
  activeFilter = "All";
  currentPage = 0;
  document.querySelector(".filter-chip.is-active")?.classList.remove("is-active");
  document.querySelector('[data-filter="All"]').classList.add("is-active");
  renderCards();
});
document.querySelector("#dialogClose").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    searchInput.focus();
  }
});

const SESSION_KEY = "origin.userdata.v2";
let currentRaw = []; // the prospects (from the prospects file)
let currentProfiles = null; // the raw company profiles (from the company profiles file)
let sources = { prospects: null, profiles: null }; // { label, sample } for each of the two
let continued = false; // the user chose to continue without company profiles
let currentView = "empty";

/* The space under the toolbar is in one of three states: ask for data, play the loading animation, or show the results. */
function showView(view) {
  currentView = view;
  dataPrompt.hidden = view !== "empty";
  cardLoading.hidden = view !== "loading";
  discoveryResults.hidden = view !== "results";
  discoveryToolbar.hidden = view !== "results";
  renderPromptStatus();
}

function startLoading() {
  window.clearTimeout(loadingTimer);
  showView("loading");
  loadingTimer = window.setTimeout(finishLoading, 5000);
}

function finishLoading() {
  window.clearTimeout(loadingTimer);
  showView(prospects.length ? "results" : "empty");
}

function renderFilterChips() {
  filterList.querySelectorAll('.filter-chip:not([data-filter="All"])').forEach((chip) => chip.remove());
  const companies = [...new Set(prospects.map((prospect) => prospect.company))];
  for (const company of companies) {
    const button = document.createElement("button");
    button.className = "filter-chip";
    button.type = "button";
    button.dataset.filter = company;
    button.textContent = company;
    filterList.append(button);
  }
  if (activeFilter !== "All" && !companies.includes(activeFilter)) activeFilter = "All";
  filterList.querySelectorAll(".filter-chip").forEach((chip) => chip.classList.toggle("is-active", chip.dataset.filter === activeFilter));
}

function renderDataNotice() {
  discoveryResults.querySelector(".data-notice")?.remove();
  if (!sources.prospects) return;
  const notice = document.createElement("p");
  notice.className = "data-notice";
  const profileCount = EquityModel.profileNames().length;
  if (sources.prospects.sample && sources.profiles?.sample) {
    notice.textContent = `Sample data: ${prospects.length} fictional prospects at made-up companies, with invented company figures. `;
  } else {
    const profiles = sources.profiles
      ? `company profiles from ${sources.profiles.label} (${profileCount})`
      : "no company profiles loaded, so estimates show n/a";
    notice.textContent = `Your data: ${prospects.length} prospects from ${sources.prospects.label}; ${profiles}. Kept in this browser tab only. `;
  }
  const change = document.createElement("button");
  change.type = "button";
  change.className = "data-notice-action";
  change.textContent = "Load different data";
  change.addEventListener("click", clearData);
  notice.append(change);
  discoveryResults.prepend(notice);
}

/* What each upload section on the prompt says about its file, and whether to offer "continue without profiles". */
function renderPromptStatus() {
  const setSlot = (slotId, statusId, text) => {
    const slot = document.querySelector(slotId);
    const status = document.querySelector(statusId);
    if (!slot || !status) return;
    slot.classList.toggle("is-done", Boolean(text));
    status.hidden = !text;
    status.textContent = text || "";
  };
  const names = EquityModel.profileNames();
  setSlot("#slotProspects", "#statusProspects", currentRaw.length ? `Loaded ${currentRaw.length} prospect${currentRaw.length === 1 ? "" : "s"} from ${sources.prospects?.label || "your file"}` : "");
  setSlot("#slotProfiles", "#statusProfiles", currentProfiles ? `Loaded ${names.length} company profile${names.length === 1 ? "" : "s"} from ${sources.profiles?.label || "your file"}${names.length ? `: ${names.join(", ")}` : ""}` : "");
  const continueButton = document.querySelector("#continueButton");
  if (continueButton) continueButton.hidden = !(currentRaw.length && !currentProfiles && currentView === "empty");
}

/* Re-estimates everything with the current prospects and company profiles and redraws the page. */
function applyData() {
  EquityModel.resetProfiles();
  const registration = currentProfiles ? EquityModel.registerProfiles(currentProfiles) : { registered: [], errors: {} };
  prospects = buildProspects(currentRaw);
  currentPage = 0;
  renderFilterChips();
  renderDataNotice();
  renderSnapshot();
  renderCards();
  renderPromptStatus();
  return registration;
}

function persistSession() {
  try {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ prospects: currentRaw, profiles: currentProfiles, sources, continued }));
    return true;
  } catch {
    return false; // too large or storage unavailable: it still works until the tab is reloaded
  }
}

/* After a file is loaded: replacing data while looking at results replays the animation right away; on the
 * first visit the animation starts once both files are in (or the user chose to continue without profiles). */
function advance() {
  if (currentRaw.length && (currentView !== "empty" || currentProfiles || continued)) startLoading();
  else showView("empty");
}

function resetControls() {
  searchInput.value = "";
  thresholdSelect.value = "0";
}

/* rows = validated prospects from DataLoader. Returns { registration, persisted }. */
function loadProspects(rows, label) {
  currentRaw = rows;
  sources.prospects = { label, sample: false };
  resetControls();
  const registration = applyData();
  const persisted = persistSession();
  advance();
  return { registration, persisted };
}

/* profiles = the COMPANY_PROFILES object from a file. Returns { registration, persisted }. */
function loadProfiles(profiles, label) {
  currentProfiles = profiles;
  sources.profiles = { label, sample: false };
  const registration = applyData();
  const persisted = persistSession();
  advance();
  return { registration, persisted };
}

/* The built-in fictional sample: both parts at once. */
function loadSample(pack) {
  currentRaw = pack.prospects;
  currentProfiles = pack.profiles;
  sources = { prospects: { label: "Sample data", sample: true }, profiles: { label: "Sample data", sample: true } };
  continued = false;
  resetControls();
  applyData();
  persistSession();
  startLoading();
}

/* "Continue without company profiles": every prospect will show n/a, but they are listed. */
function continueWithoutProfiles() {
  if (!currentRaw.length) return;
  continued = true;
  persistSession();
  startLoading();
}

/* "Load different data": forget everything and ask again. */
function clearData() {
  try { window.sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  window.clearTimeout(loadingTimer);
  currentRaw = [];
  currentProfiles = null;
  sources = { prospects: null, profiles: null };
  continued = false;
  resetControls();
  activeFilter = "All";
  applyData();
  showView("empty");
  document.querySelector("#opportunities")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* A saved session is re-validated like a fresh upload, never trusted. */
function restoreSession() {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(SESSION_KEY) || "null");
    if (!saved || typeof DataLoader === "undefined") return false;
    const pack = DataLoader.parsePack(JSON.stringify({ prospects: saved.prospects || [], companyProfiles: saved.profiles || undefined }), { asOf: EquityModel.AS_OF });
    if (pack.fatal) return false;
    const label = (source) => ({ label: String(source?.label || "your file").slice(0, 80), sample: source?.sample === true });
    currentRaw = pack.prospects;
    currentProfiles = pack.profiles;
    sources = { prospects: pack.prospects.length ? label(saved.sources?.prospects) : null, profiles: pack.profiles ? label(saved.sources?.profiles) : null };
    continued = saved.continued === true;
    return true;
  } catch {
    return false;
  }
}

window.Origin = {
  loadProspects,
  loadProfiles,
  loadSample,
  continueWithoutProfiles,
  clearData,
  profileNames: () => EquityModel.profileNames(),
  companyCounts: () => prospects.reduce((acc, p) => ({ ...acc, [p.company]: (acc[p.company] || 0) + 1 }), {}),
  state: () => ({ view: currentView, prospects: prospects.length, profiles: EquityModel.profileNames(), companies: [...new Set(prospects.map((p) => p.company))], notEstimated: prospects.filter((p) => !p.equity.estimated).length })
};

/* In demo mode (the hosted demo, or npm run start:mock) say so, so nobody mistakes the placeholder results for research. */
if (typeof Dossier !== "undefined") {
  Dossier.health().then((health) => {
    if (health?.mock) document.querySelector("#demoBanner").hidden = false;
  });
}

document.querySelector("#methodNavLink").addEventListener("click", openMethodology);
document.querySelector("#methodHeroLink").addEventListener("click", openMethodology);
document.querySelector("#promptMethod")?.addEventListener("click", openMethodology);
document.querySelector("#continueButton")?.addEventListener("click", continueWithoutProfiles);

restoreSession();
applyData();
if (currentRaw.length && (currentProfiles || continued)) startLoading();
else showView("empty");
if (window.location.hash === "#methodology") window.setTimeout(() => openMethodology(), 60);
