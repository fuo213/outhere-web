/**
 * "Fix the map": the report dialog, the pick-a-spot mode and the map control.
 * Logic (note text, notes API, duplicate check, reported-spots store) lives in
 * osm-report.js (pure, unit-tested). Everything user-visible from OSM (note
 * text, names) is set with textContent, never as HTML.
 */

import { OSM_API_BASE } from "./config.js";
import {
  PROBLEM_KINDS, ERROR_COPY, PRODUCTION_API,
  gapNoteText, problemNoteText, isUntouched, hasUserContent,
  fetchNearbyNotes, createNote, osmEditUrl, noteWebUrl,
  ReportedSpots, formatReportDate,
} from "./osm-report.js";

const store = (() => {
  let s = null;
  try { s = window.localStorage; } catch { /* blocked */ }
  return new ReportedSpots(s);
})();

/** The report already made for a spot, or null (card shows "Reported on ..."). */
export const reportedAt = (lat, lon) => store.find(lat, lon, OSM_API_BASE);

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null) node.append(kid);
  return node;
}

/** replaceChildren stringifies null, so drop empty slots. */
const setBody = (body, ...nodes) => body.replaceChildren(...nodes.filter(Boolean));

const extLink = (href, text, cls = "report-link") => el("a", { class: cls, href, target: "_blank", rel: "noopener", text });

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

let overlay = null;
let lastFocus = null;
let nearbyAbort = null;

function close() {
  nearbyAbort?.abort();
  overlay?.remove();
  overlay = null;
  document.removeEventListener("keydown", onKey, true);
  lastFocus?.focus?.();
}

function onKey(e) {
  if (e.key === "Escape") { e.stopPropagation(); close(); }
}

/**
 * Open the report dialog.
 * @param {{kind: "gap"|"problem", lat: number, lon: number,
 *          gap?: {ways?: object[], gapM?: number, legM?: number},
 *          nearby?: {osmId?, name?, highway?}|null}} spot
 */
export function openReportDialog(spot) {
  close();
  lastFocus = document.activeElement;
  const { kind, lat, lon } = spot;
  const isGap = kind === "gap";

  const body = el("div", { class: "report-body" });
  const modal = el("div", { class: "report-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "reportTitle" },
    el("button", { class: "modal-close-btn report-close", type: "button", "aria-label": "Close", onclick: close, text: "✕" }),
    el("h2", { class: "report-title", id: "reportTitle", text: isGap ? "Report this gap to OpenStreetMap" : "Report a map problem" }),
    body);
  overlay = el("div", { class: "report-overlay" }, modal);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  document.body.append(overlay);
  document.addEventListener("keydown", onKey, true);

  const done = reportedAt(lat, lon);
  if (done) return renderReported(body, done);

  renderChecking(body);
  nearbyAbort = new AbortController();
  const signal = nearbyAbort.signal;
  fetchNearbyNotes((u, i) => fetch(u, i), OSM_API_BASE, lat, lon, { signal })
    .then((notes) => (notes.length ? renderExisting(body, spot, notes) : renderForm(body, spot)))
    .catch((err) => { if (err?.name !== "AbortError") renderForm(body, spot, { checkFailed: true }); });
}

function renderChecking(body) {
  setBody(body, el("p", { class: "report-status", role: "status", text: "Checking for notes already filed here…" }));
}

function sandboxBanner() {
  if (OSM_API_BASE === PRODUCTION_API) return null;
  return el("p", { class: "report-test", text: `Test mode: notes go to ${new URL(OSM_API_BASE).host}, not the real map.` });
}

function renderReported(body, rep) {
  setBody(body, 
    sandboxBanner(),
    el("p", { class: "report-lead" }, "Reported on ", el("span", { class: "report-num", text: formatReportDate(rep.date) }), ". Mappers can see it, and replies show up on the note."),
    el("div", { class: "report-actions" }, extLink(rep.url, "View the note on OpenStreetMap", "btn btn--primary"), el("button", { class: "btn btn--quiet", type: "button", onclick: close, text: "Close" })),
  );
}

function renderExisting(body, spot, notes) {
  const list = el("ul", { class: "report-notes" }, notes.slice(0, 5).map((n) => {
    const excerpt = n.text.length > 220 ? `${n.text.slice(0, 220)}…` : n.text;
    return el("li", { class: "report-note" },
      el("p", { class: "report-note__text", text: excerpt }),
      el("p", { class: "report-note__meta" },
        `Filed ${n.created}, ${n.comments} ${n.comments === 1 ? "comment" : "comments"} · `,
        extLink(noteWebUrl(OSM_API_BASE, n.id), "Open note")));
  }));
  setBody(body, 
    sandboxBanner(),
    el("p", { class: "report-lead", text: notes.length === 1 ? "Someone already filed a note near here." : `${notes.length} open notes are already filed near here.` }),
    el("p", { class: "report-sub", text: "If one of these is your problem, add a comment there instead of filing a second note." }),
    list,
    el("div", { class: "report-actions" }, el("button", { class: "btn btn--quiet", type: "button", onclick: () => renderForm(body, spot), text: "Mine is a different problem" }), el("button", { class: "btn btn--ghost", type: "button", onclick: close, text: "Close" })),
  );
}

function renderForm(body, spot, { checkFailed = false } = {}) {
  const { kind, lat, lon } = spot;
  const isGap = kind === "gap";
  let probKind = "name";
  const initial = () => (isGap ? gapNoteText(spot.gap || {}) : problemNoteText({ kind: probKind, nearby: spot.nearby }));

  const ta = el("textarea", { class: "report-text input", id: "reportText", rows: "12", "aria-describedby": "reportPublic" });
  ta.value = initial();
  const status = el("p", { class: "report-error", role: "alert", hidden: true });
  const sendBtn = el("button", { class: "btn btn--primary", type: "button", id: "reportSend", text: "Send note to OpenStreetMap" });
  const cancelBtn = el("button", { class: "btn btn--ghost", type: "button", onclick: close, text: "Cancel" });

  let kindField = null;
  if (!isGap) {
    const sel = el("select", { class: "input report-kind", id: "reportKind" },
      PROBLEM_KINDS.map((k) => el("option", { value: k.id, text: k.label })));
    sel.addEventListener("change", () => {
      const untouched = isUntouched(ta.value, probKind, spot.nearby);
      probKind = sel.value;
      if (untouched) ta.value = initial();
    });
    kindField = el("div", { class: "field" }, el("label", { class: "field-label", for: "reportKind", text: "What's wrong?" }), sel);
  }

  const editLink = extLink(osmEditUrl({ lat, lon, wayId: isGap ? spot.gap?.ways?.[0]?.osmId : spot.nearby?.osmId }), "Open in the OSM editor instead", "report-link");

  sendBtn.addEventListener("click", async () => {
    const text = ta.value;
    if (!hasUserContent(text)) { showError(ERROR_COPY.invalid); return; }
    if (!isGap && isUntouched(text, probKind, spot.nearby)) { showError(ERROR_COPY.untouched); return; }
    sendBtn.disabled = true; sendBtn.textContent = "Sending…"; ta.readOnly = true;
    status.hidden = true;
    try {
      const note = await createNote((u, i) => fetch(u, i), OSM_API_BASE, { lat, lon, text });
      const rep = { lat, lon, noteId: note.id, api: OSM_API_BASE, date: new Date().toISOString() };
      store.add(rep);
      document.dispatchEvent(new CustomEvent("booot:osm-reported", { detail: rep }));
      renderSent(body, note);
    } catch (err) {
      showError(ERROR_COPY[err?.kind] || ERROR_COPY.api);
      sendBtn.disabled = false; sendBtn.textContent = "Try again"; ta.readOnly = false;
    }
  });
  function showError(msg) { status.textContent = msg; status.hidden = false; }

  setBody(body, 
    sandboxBanner(),
    el("p", { class: "report-lead", text: isGap ? "This will tell OpenStreetMap mappers about the gap. Edit the text first if you like." : "Describe what you saw. A volunteer mapper will read it." }),
    checkFailed ? el("p", { class: "report-sub", text: "Couldn’t check for notes already filed here, so it may be a duplicate." }) : null,
    kindField,
    el("div", { class: "field" }, el("label", { class: "field-label", for: "reportText", text: "Note text" }), ta),
    el("p", { class: "report-public", id: "reportPublic" },
      "Public on OpenStreetMap: anyone can read it and it stays there. It isn’t linked to a Booot account, but it isn’t private either, so leave out your name, contact details and where you’re staying."),
    status,
    el("div", { class: "report-actions" }, sendBtn, cancelBtn, el("span", { class: "report-spacer" }), editLink),
  );
  ta.focus({ preventScroll: true });
  const end = isGap ? ta.value.length : ta.value.indexOf("What I saw: ") + "What I saw: ".length;
  if (!isGap) ta.setSelectionRange(end, end);
  ta.scrollTop = isGap ? 0 : ta.scrollTop;
}

function renderSent(body, note) {
  setBody(body, 
    sandboxBanner(),
    el("p", { class: "report-lead", text: "Sent. Thank you for helping fix the map." }),
    el("p", { class: "report-sub", text: "Mappers will see it. Fixes show up in the map data after the next monthly rebuild." }),
    el("div", { class: "report-actions" }, extLink(note.url, "View your note", "btn btn--primary"), el("button", { class: "btn btn--quiet", type: "button", onclick: close, text: "Close" })),
  );
}

// ---------------------------------------------------------------------------
// Pick a spot (map control) and right-click
// ---------------------------------------------------------------------------

let picking = false;
let hintEl = null;
export const isReportPicking = () => picking;

function setPicking(map, on, btn) {
  picking = on;
  btn?.classList.toggle("active", on);
  btn?.setAttribute("aria-pressed", String(on));
  map.getCanvas().style.cursor = on ? "crosshair" : "";
  hintEl?.remove(); hintEl = null;
  if (on) {
    hintEl = el("div", { class: "report-pick-hint", role: "status", text: "Click where the problem is. Esc to cancel." });
    document.body.append(hintEl);
  }
}

/** Nearest rendered trail at a point (tile feature: name, osm_id), or null. */
function trailAt(map, point) {
  try {
    const r = 10;
    const f = map.queryRenderedFeatures([[point.x - r, point.y - r], [point.x + r, point.y + r]], { layers: ["trails"].filter((id) => map.getLayer(id)) })[0];
    if (!f) return null;
    const p = f.properties || {};
    const osmId = Number(p.osm_id ?? f.id);
    return { osmId: Number.isFinite(osmId) ? osmId : null, name: p.name || "", highway: p.highway || "path" };
  } catch { return null; }
}

/**
 * Wire the entry points on the map.
 * @param {maplibregl.Map} map
 * @param {{canReport: () => boolean}} hooks  false while drawing or deleting
 */
export function initReport(map, { canReport = () => true } = {}) {
  const btn = document.getElementById("reportBtn");
  const open = (e) => openReportDialog({ kind: "problem", lat: e.lngLat.lat, lon: e.lngLat.lng, nearby: trailAt(map, e.point) });

  btn?.addEventListener("click", () => {
    if (!picking && !canReport()) return;
    setPicking(map, !picking, btn);
  });
  map.on("click", (e) => {
    if (!picking) return;
    setPicking(map, false, btn);
    open(e);
  });
  map.on("contextmenu", (e) => {
    if (!canReport() || picking) return;
    e.preventDefault?.();
    open(e);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && picking) setPicking(map, false, btn); });
}
