/*
 * "Start a conversation": collects the sender's sign-off details, asks the local server (Claude Sonnet) for a warm
 * first-touch email based on the dossier's outreach strategy, lets the user review it, then opens the email app.
 *
 * Privacy: the sender's name, pronouns, job title, email and phone are only used here in the browser to build the signature.
 * They are never sent to the server or the AI model. The request contains the dossier and the employer name only
 * (the employer is mentioned in the message body).
 */
(() => {
  "use strict";

  const STORE_KEY = "origin.sender.v1";
  const FIELD_MAX = { firstName: 60, lastName: 60, pronouns: 30, jobTitle: 120, employer: 80, email: 120, phone: 40 };
  const EMPLOYER_RE = /^[\p{L}\p{N} &.,'\u2019()\/+-]+$/u;
  const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const oneLine = (value, max) => String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

  /* Transparency and opt-out line, appended below the signature of every email. It tells the recipient how they were found,
   * how to stop hearing from you, and that you will erase their details (see "Data retention and deletion" in the README:
   * npm run audit -- delete --name "..."). Keep it short: some email apps truncate very long mailto links.
   * Edit this text if it is not accurate for how YOUR firm obtained the prospect's details. */
  const OPT_OUT_FOOTER = 'Why you\'re hearing from me: I found your name via public professional information. Not interested? Reply "no thanks" and I won\'t contact you again and will delete your details. Happy to share what I hold about you.';
  const OPT_OUT_PATTERN = /no thanks|unsubscribe|opt[- ]?out/i;

  /* ---------------------------------------------------------------- pure helpers (also unit-tested) */
  function cleanDetails(raw) {
    const out = {};
    for (const key of Object.keys(FIELD_MAX)) out[key] = oneLine(raw?.[key], FIELD_MAX[key]);
    out.pronouns = out.pronouns.replace(/^\(+|\)+$/g, "").trim();
    return out;
  }

  function validateDetails(d) {
    const errors = {};
    if (!d.firstName) errors.firstName = "Enter your first name";
    if (!d.lastName) errors.lastName = "Enter your last name";
    if (!d.jobTitle) errors.jobTitle = "Enter your job title";
    if (!d.employer) errors.employer = "Enter your employer name";
    else if (!EMPLOYER_RE.test(d.employer)) errors.employer = "Use letters, numbers and basic punctuation only";
    if (!d.email) errors.email = "Enter your email address";
    else if (!EMAIL_RE.test(d.email)) errors.email = "Enter a valid email address";
    return errors;
  }

  /* Exact sign-off format requested:
   *   First name last name (pronouns)
   *   Job title
   *   Phone number
   *   Email address
   * Blank optional lines (pronouns, phone) are left out. */
  function signature(d) {
    const nameLine = `${d.firstName} ${d.lastName}${d.pronouns ? ` (${d.pronouns})` : ""}`;
    return [nameLine, d.jobTitle, d.phone, d.email].filter(Boolean).join("\n");
  }

  /* The full message body: the AI-written text, then the exact signature, then the opt-out and transparency line. */
  function assembleBody(draftBody, details) {
    return `${String(draftBody).trimEnd()}\n\n${signature(details)}\n\n${OPT_OUT_FOOTER}`;
  }

  function buildMailto({ to, subject, body }) {
    const recipient = EMAIL_RE.test(String(to || "").trim()) ? String(to).trim() : "";
    const crlf = String(body ?? "").replace(/\r?\n/g, "\r\n");
    return `mailto:${recipient ? encodeURIComponent(recipient).replace(/%40/g, "@") : ""}?subject=${encodeURIComponent(String(subject ?? ""))}&body=${encodeURIComponent(crlf)}`;
  }

  function loadSaved() {
    try {
      return JSON.parse(window.localStorage.getItem(STORE_KEY) || "null");
    } catch {
      return null;
    }
  }
  function save(details, remember) {
    try {
      if (remember) window.localStorage.setItem(STORE_KEY, JSON.stringify(details));
      else window.localStorage.removeItem(STORE_KEY);
    } catch {
      /* storage can be unavailable (private mode); the feature still works */
    }
  }

  /* ---------------------------------------------------------------- dialog */
  let dialog = null;
  const state = { dossier: null, details: null, variant: 0, draft: null, acknowledged: false, controller: null, remember: true };

  function shell() {
    if (dialog) return dialog;
    dialog = document.querySelector("#composeDialog");
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "composeDialog";
      dialog.className = "compose-dialog";
      document.body.appendChild(dialog);
    }
    dialog.setAttribute("aria-labelledby", "composeTitle");
    dialog.addEventListener("close", () => state.controller?.abort());
    dialog.addEventListener("click", onClick);
    dialog.addEventListener("submit", onSubmit);
    dialog.addEventListener("input", onInput);
    return dialog;
  }

  const closeButton = '<button class="dialog-close" type="button" data-compose="close" aria-label="Close">x</button>';

  function fieldHTML(name, label, { required = false, type = "text", placeholder = "", autocomplete = "", value = "", wide = false } = {}) {
    return `<label class="c-field${wide ? " c-wide" : ""}"><span>${esc(label)}${required ? "" : ' <em>(optional)</em>'}</span>
      <input class="c-input" name="${name}" type="${type}" maxlength="${FIELD_MAX[name]}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="${autocomplete}"${required ? " required" : ""} />
      <small class="c-error" data-error-for="${name}" role="alert"></small></label>`;
  }

  function renderDetails(errors = {}) {
    const saved = state.details || loadSaved() || {};
    const risk = state.dossier?.complianceRisk;
    const needsAck = risk && risk !== "clear";
    const name = esc(state.dossier?.subject?.name || "this prospect");
    dialog.innerHTML = `
      ${closeButton}
      <span class="d-kicker">Start a conversation</span>
      <h2 id="composeTitle">Your sign-off details</h2>
      <p class="compose-lede">We will write a warm, low-key invitation to <b>${name}</b> and sign it with the details below. Your name, title, email and phone are used only for the signature: they stay in this browser and are not sent to the AI. Your employer name is shared with the AI so it can be mentioned in the message.</p>
      <form id="composeForm" novalidate>
        <div class="c-grid">
          ${fieldHTML("firstName", "First name", { required: true, autocomplete: "given-name", value: saved.firstName })}
          ${fieldHTML("lastName", "Last name", { required: true, autocomplete: "family-name", value: saved.lastName })}
          ${fieldHTML("pronouns", "Pronouns", { placeholder: "e.g. she/her", value: saved.pronouns })}
          ${fieldHTML("jobTitle", "Job title", { required: true, autocomplete: "organization-title", value: saved.jobTitle })}
          ${fieldHTML("employer", "Employer name", { required: true, autocomplete: "organization", placeholder: "e.g. the name of your bank", value: saved.employer, wide: true })}
          ${fieldHTML("email", "Email address", { required: true, type: "email", autocomplete: "email", value: saved.email })}
          ${fieldHTML("phone", "Phone number", { type: "tel", autocomplete: "tel", value: saved.phone })}
        </div>
        ${needsAck ? `<label class="c-check c-ack"><input type="checkbox" name="ack" /><span>${risk === "review" ? "This dossier is flagged for compliance review." : "This prospect was not fully screened."} I confirm I have clearance to contact them.</span></label><small class="c-error" data-error-for="ack" role="alert"></small>` : ""}
        <label class="c-check"><input type="checkbox" name="remember" ${state.remember ? "checked" : ""} /><span>Remember these details on this device</span></label>
        <p class="c-form-error" id="composeFormError" role="alert" hidden></p>
        <div class="c-actions">
          <button class="c-btn" type="button" data-compose="close">Cancel</button>
          <button class="c-btn c-btn-primary" type="submit">Generate email <span aria-hidden="true">&rarr;</span></button>
        </div>
      </form>`;
    for (const [field, message] of Object.entries(errors)) showError(field, message);
    dialog.querySelector('input[name="firstName"]')?.focus();
  }

  function showError(field, message) {
    const slot = dialog.querySelector(`[data-error-for="${field}"]`);
    if (slot) slot.textContent = message;
    dialog.querySelector(`[name="${field}"]`)?.setAttribute("aria-invalid", "true");
  }

  function renderGenerating() {
    dialog.innerHTML = `
      ${closeButton}
      <span class="d-kicker">Start a conversation</span>
      <h2 id="composeTitle">Drafting your email</h2>
      <div class="c-working" role="status"><span class="btn-spinner" aria-hidden="true"></span><p>Writing a friendly note for ${esc(state.dossier.subject.name)} from the outreach strategy. This takes a few seconds.</p></div>
      <div class="c-actions"><button class="c-btn" type="button" data-compose="cancel">Cancel</button></div>`;
  }

  function renderError(message) {
    dialog.innerHTML = `
      ${closeButton}
      <span class="d-kicker">Start a conversation</span>
      <h2 id="composeTitle">We could not draft the email</h2>
      <p class="c-form-error">${esc(message)}</p>
      <div class="c-actions">
        <button class="c-btn" type="button" data-compose="back">Back</button>
        <button class="c-btn c-btn-primary" type="button" data-compose="regenerate">Try again</button>
      </div>`;
  }

  function renderPreview(draft, { to = "", notice = "" } = {}) {
    const body = assembleBody(draft.body, state.details);
    const basis = draft.referenced?.length
      ? `Personalised with: ${draft.referenced.map(esc).join("; ")}.`
      : draft.personalized ? "Based on the dossier's outreach strategy." : "Written from the person's role and field; no specific public item was cited.";
    dialog.innerHTML = `
      ${closeButton}
      <span class="d-kicker">Start a conversation</span>
      <h2 id="composeTitle">Review your email</h2>
      <p class="compose-lede">Drafted by ${esc(draft.model === "demo" ? "the demo generator" : "Claude Sonnet")}. ${basis} Read it through and change anything you like before sending.</p>
      <label class="c-field"><span>To <em>(optional, add their address if you have it)</em></span><input class="c-input" id="composeTo" type="email" value="${esc(to)}" placeholder="name@company.com" autocomplete="off" /></label>
      <label class="c-field"><span>Subject</span><input class="c-input" id="composeSubject" type="text" value="${esc(draft.subject)}" maxlength="140" /></label>
      <label class="c-field"><span>Message</span><textarea class="c-input c-textarea" id="composeBody" rows="15">${esc(body)}</textarea></label>
      <p class="c-hint" id="composeHint">${esc(notice)}</p>
      <div class="c-actions c-actions-wrap">
        <button class="c-btn" type="button" data-compose="back">Back</button>
        <button class="c-btn" type="button" data-compose="regenerate">Write another version</button>
        <button class="c-btn" type="button" data-compose="copy">Copy email</button>
        <button class="c-btn c-btn-primary" type="button" data-compose="open">Open in email app <span aria-hidden="true">&nearr;</span></button>
      </div>
      <small class="c-foot">The note under your signature explains how you found them and how to opt out; keep it unless it is inaccurate for your firm. AI-drafted text can contain mistakes. If nothing opens, your computer may have no default email app: use Copy email.</small>`;
    updateHint();
    dialog.querySelector("#composeBody")?.focus();
  }

  function currentMessage() {
    return {
      to: dialog.querySelector("#composeTo")?.value.trim() || "",
      subject: dialog.querySelector("#composeSubject")?.value.trim() || "",
      body: dialog.querySelector("#composeBody")?.value || ""
    };
  }

  function updateHint() {
    const hint = dialog.querySelector("#composeHint");
    if (!hint) return;
    const message = currentMessage();
    const long = buildMailto(message).length > 1900;
    const badTo = message.to && !EMAIL_RE.test(message.to);
    const noOptOut = !OPT_OUT_PATTERN.test(message.body);
    hint.textContent = [
      noOptOut ? "This message no longer has an opt-out line. Most marketing and privacy rules expect one." : "",
      badTo ? "The To address does not look valid, so it will be left blank." : "",
      long ? "This message is long. If your email app cuts it off, use Copy email instead." : ""
    ].filter(Boolean).join(" ");
  }

  /* ---------------------------------------------------------------- flow */
  async function generate() {
    state.controller?.abort();
    state.controller = new AbortController();
    const { signal } = state.controller;
    renderGenerating();
    try {
      const res = await fetch("/api/email-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "origin-app" },
        body: JSON.stringify({ dossier: state.dossier, variant: state.variant, acknowledgeCompliance: state.acknowledged, employer: state.details.employer }),
        signal
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `The email service returned ${res.status}`);
      if (signal.aborted) return;
      state.draft = json;
      renderPreview(json);
    } catch (error) {
      if (signal.aborted) return;
      renderError(error instanceof TypeError ? "Could not reach the local server. Make sure it is running (npm start)." : error.message);
    }
  }

  function onSubmit(event) {
    if (event.target.id !== "composeForm") return;
    event.preventDefault();
    const form = event.target;
    const details = cleanDetails(Object.fromEntries(new FormData(form)));
    const errors = validateDetails(details);
    const needsAck = state.dossier?.complianceRisk && state.dossier.complianceRisk !== "clear";
    const acknowledged = form.elements.ack?.checked === true;
    if (needsAck && !acknowledged) errors.ack = "Please confirm clearance to continue";
    if (Object.keys(errors).length) {
      renderDetailsErrors(form, errors);
      return;
    }
    state.details = details;
    state.acknowledged = needsAck ? acknowledged : false;
    state.variant = 0;
    state.remember = form.elements.remember?.checked === true;
    save(details, state.remember);
    generate();
  }

  function renderDetailsErrors(form, errors) {
    form.querySelectorAll(".c-error").forEach((el) => { el.textContent = ""; });
    form.querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
    for (const [field, message] of Object.entries(errors)) showError(field, message);
    const first = form.querySelector('[aria-invalid="true"]');
    first?.focus();
    const slot = form.querySelector("#composeFormError");
    if (slot) { slot.hidden = false; slot.textContent = "Please complete the highlighted fields."; }
  }

  function onInput(event) {
    if (event.target.matches("#composeTo, #composeBody, #composeSubject")) updateHint();
    if (event.target.matches(".c-input[aria-invalid]")) {
      event.target.removeAttribute("aria-invalid");
      const slot = dialog.querySelector(`[data-error-for="${event.target.name}"]`);
      if (slot) slot.textContent = "";
    }
    /* hide the summary banner once nothing is flagged any more */
    const banner = dialog.querySelector("#composeFormError");
    if (banner && !banner.hidden && !dialog.querySelector("[aria-invalid=true]") && !dialog.querySelector(".c-error:not(:empty)")) banner.hidden = true;
  }

  async function copyEmail(button) {
    const { to, subject, body } = currentMessage();
    const text = `${to ? `To: ${to}\n` : ""}Subject: ${subject}\n\n${body}`;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Copy failed";
    }
    window.setTimeout(() => { button.textContent = "Copy email"; }, 1800);
  }

  function openMailApp() {
    const message = currentMessage();
    const anchor = document.createElement("a");
    anchor.href = buildMailto(message);
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  function onClick(event) {
    const action = event.target.closest("[data-compose]")?.dataset.compose;
    if (!action) return;
    if (action === "close") dialog.close();
    else if (action === "cancel") { state.controller?.abort(); renderDetails(); }
    else if (action === "back") renderDetails();
    else if (action === "regenerate") { state.variant = (state.variant + 1) % 10; generate(); }
    else if (action === "copy") copyEmail(event.target.closest("button"));
    else if (action === "open") openMailApp();
  }

  function open(dossier) {
    shell();
    state.dossier = dossier;
    state.draft = null;
    state.variant = 0;
    if (dossier?.complianceRisk === "hold") {
      dialog.innerHTML = `${closeButton}<span class="d-kicker">Start a conversation</span><h2 id="composeTitle">Compliance hold</h2>
        <p class="c-form-error">This dossier is on compliance hold, so no email can be drafted until compliance has reviewed it.</p>
        <div class="c-actions"><button class="c-btn" type="button" data-compose="close">Close</button></div>`;
    } else {
      renderDetails();
    }
    if (!dialog.open) dialog.showModal();
  }

  window.Compose = { open, signature, assembleBody, buildMailto, cleanDetails, validateDetails, OPT_OUT_FOOTER };
})();
