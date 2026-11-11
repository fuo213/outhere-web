/**
 * Place search box (top of the map). Matching lives in place-search.js; this
 * file is the DOM, the lazy index loading and the fly-to.
 *
 * The box exists only when the active region has a place index in the
 * catalog (`place_index`). Without one it stays hidden and nothing is fetched,
 * which is the state of production until the pipeline publishes indexes.
 *
 * Place names are untrusted OSM text: everything is set with textContent,
 * never innerHTML, and attribute values here are fixed strings or integers.
 */

import { map } from "./app.js"; // circular with app.js; only used at runtime
import { getActiveRegion, getCatalogRegions } from "./region-picker.js";
import {
  describeEntry, describeText, highlightRanges, indexesForRegion, loadPlaceIndex,
  mergeEntries, parseDevPlaces, search, zoomFor,
} from "./place-search.js";

const DEV_PLACES = parseDevPlaces(location.search, location.href, location.hostname);
const MAX_RESULTS = 8;
const MAX_QUERY_LEN = 80;
const PARK_LIKE = new Set(["park", "district"]);

const $ = (id) => document.getElementById(id);
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

let els = null;
let sources = [];           // [{ regionId, regionName, info }] for the active region
let sourceKey = "";
let entries = null;         // merged decoded records, null until loaded
let loadState = "idle";     // idle | loading | ready | failed
let loadToken = 0;
let results = [];
let activeIdx = -1;
let pin = null;             // maplibregl.Marker for the last chosen place
const cache = new Map();    // index version/url -> decoded records (in memory only)

// ---------------------------------------------------------------------------
// Which indexes apply
// ---------------------------------------------------------------------------

function refreshSources() {
  const active = getActiveRegion();
  const next = indexesForRegion(active, getCatalogRegions(), DEV_PLACES);
  const key = next.map((s) => `${s.regionId}@${s.info.version || s.info.url}`).join("|");
  sources = next;
  els.root.hidden = next.length === 0;
  if (key === sourceKey) return;
  sourceKey = key;
  entries = null;
  loadState = "idle";
  loadToken++;
  results = [];
  closePanel();
  if (!next.length) {
    els.input.value = "";
    els.clear.hidden = true;
    removePin();
  } else if (document.activeElement === els.input) {
    ensureLoaded();
  }
  els.input.setAttribute(
    "aria-label",
    active?.name ? `Search places in ${active.name}` : "Search places",
  );
}

async function ensureLoaded() {
  if (loadState !== "idle" || !sources.length) return;
  loadState = "loading";
  const token = ++loadToken;
  const lists = await Promise.all(sources.map(async (s) => {
    const k = s.info.version || s.info.url;
    if (!cache.has(k)) {
      const list = await loadPlaceIndex(s);
      if (!list) return null;
      cache.set(k, list);
    }
    return cache.get(k);
  }));
  if (token !== loadToken) return; // region changed while loading
  const ok = lists.filter(Boolean);
  if (!ok.length) {
    // Could not load (offline, 404): degrade quietly (no panel, no "Loading…"
    // forever, no refetch per keystroke); retry on next focus.
    loadState = "failed";
    entries = null;
    render();
    return;
  }
  entries = mergeEntries(ok);
  loadState = "ready";
  render();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function appendHighlighted(parent, text, query) {
  let at = 0;
  for (const [s, e] of highlightRanges(text, query)) {
    if (s > at) parent.append(text.slice(at, s));
    const m = document.createElement("mark");
    m.textContent = text.slice(s, e);
    parent.append(m);
    at = e;
  }
  if (at < text.length) parent.append(text.slice(at));
}

function buildOption(e, i, query) {
  const li = document.createElement("li");
  li.className = "place-opt";
  li.id = `placeOpt${i}`;
  li.setAttribute("role", "option");
  li.setAttribute("aria-selected", i === activeIdx ? "true" : "false");
  li.dataset.index = String(i);
  const fallback = PARK_LIKE.has(e.kind) ? "" : e.regionName;
  li.setAttribute("aria-label", describeText(e, { fallbackPlace: fallback }));

  const name = document.createElement("span");
  name.className = "place-opt-name";
  appendHighlighted(name, e.name, query);

  const d = describeEntry(e, { fallbackPlace: fallback });
  const meta = document.createElement("span");
  meta.className = "place-opt-meta";
  meta.append(d.kind);
  for (const num of d.numbers) {
    meta.append(" · ");
    const n = document.createElement("span");
    n.className = "place-opt-num";
    n.textContent = num;
    meta.append(n);
  }
  if (d.where) meta.append(` · ${d.where}`);

  li.append(name, meta);
  return li;
}

function render() {
  const query = els.input.value.slice(0, MAX_QUERY_LEN);
  els.list.replaceChildren();
  els.empty.hidden = true;
  if (!query.trim()) {
    results = [];
    activeIdx = -1;
    closePanel();
    return;
  }
  if (loadState === "failed") {
    results = [];
    activeIdx = -1;
    closePanel();
    return;
  }
  openPanel();
  if (loadState !== "ready") {
    results = [];
    activeIdx = -1;
    els.empty.textContent = "Loading places…";
    els.empty.hidden = false;
    els.input.removeAttribute("aria-activedescendant");
    return;
  }
  results = search(entries, query, { limit: MAX_RESULTS });
  activeIdx = results.length ? 0 : -1;
  results.forEach((e, i) => els.list.append(buildOption(e, i, query)));
  if (!results.length) {
    const region = getActiveRegion()?.name;
    els.empty.textContent = `No place called “${query.trim()}”${region ? ` in ${region}` : ""}. Try a trail, peak, creek or park name.`;
    els.empty.hidden = false;
  }
  syncActive();
}

function syncActive() {
  els.list.querySelectorAll(".place-opt").forEach((li, i) => {
    li.setAttribute("aria-selected", i === activeIdx ? "true" : "false");
  });
  if (activeIdx >= 0) {
    els.input.setAttribute("aria-activedescendant", `placeOpt${activeIdx}`);
    els.list.children[activeIdx]?.scrollIntoView({ block: "nearest" });
  } else {
    els.input.removeAttribute("aria-activedescendant");
  }
}

function openPanel() {
  els.panel.hidden = false;
  els.input.setAttribute("aria-expanded", "true");
}

function closePanel() {
  els.panel.hidden = true;
  els.input.setAttribute("aria-expanded", "false");
  els.input.removeAttribute("aria-activedescendant");
}

// ---------------------------------------------------------------------------
// Choosing a place
// ---------------------------------------------------------------------------

function removePin() {
  pin?.remove();
  pin = null;
}

function dropPin(e) {
  removePin();
  const el = document.createElement("div");
  el.className = "place-pin";
  const ring = document.createElement("span");
  ring.className = "place-pin-ring";
  const tag = document.createElement("span");
  tag.className = "place-pin-tag";
  tag.textContent = e.name;
  el.append(ring, tag);
  pin = new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([e.lon, e.lat]).addTo(map);
  // Gone on the next touch of the map: it points at the answer, then steps aside.
  map.once("mousedown", removePin);
  map.once("touchstart", removePin);
}

function choose(i) {
  const e = results[i];
  if (!e) return;
  els.input.value = e.name;
  els.clear.hidden = false;
  closePanel();
  els.input.blur();
  dropPin(e);
  map.flyTo({
    center: [e.lon, e.lat],
    zoom: zoomFor(e),
    duration: reducedMotion() ? 0 : 1400,
    essential: true,
  });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function onInput() {
  els.clear.hidden = !els.input.value;
  els.key.hidden = !!els.input.value;
  ensureLoaded();
  render();
}

function onKeydown(ev) {
  const open = !els.panel.hidden;
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    if (!results.length) return;
    ev.preventDefault();
    if (!open) openPanel();
    const step = ev.key === "ArrowDown" ? 1 : -1;
    activeIdx = (activeIdx + step + results.length) % results.length;
    syncActive();
  } else if (ev.key === "Enter") {
    if (open && activeIdx >= 0) {
      ev.preventDefault();
      choose(activeIdx);
    }
  } else if (ev.key === "Escape") {
    ev.preventDefault();
    if (open) {
      closePanel();
    } else {
      els.input.value = "";
      els.clear.hidden = true;
      els.key.hidden = false;
      removePin();
      els.input.blur();
    }
  }
}

function clear() {
  els.input.value = "";
  els.clear.hidden = true;
  els.key.hidden = false;
  results = [];
  closePanel();
  removePin();
  els.input.focus();
}

export function initPlaceSearch() {
  els = {
    root: $("placeSearch"), input: $("placeSearchInput"), key: $("placeSearchKey"),
    clear: $("placeSearchClear"), panel: $("placeSearchPanel"),
    list: $("placeSearchList"), empty: $("placeSearchEmpty"),
  };
  if (!els.root || !els.input) return;

  els.input.addEventListener("input", onInput);
  els.input.addEventListener("keydown", onKeydown);
  els.input.addEventListener("focus", () => {
    if (loadState === "failed") loadState = "idle";
    ensureLoaded();
    if (els.input.value.trim()) render();
    els.input.select();
  });
  els.clear.addEventListener("click", clear);
  // mousedown (not click) so the input keeps focus until the choice lands
  els.list.addEventListener("mousedown", (ev) => ev.preventDefault());
  els.list.addEventListener("click", (ev) => {
    const li = ev.target.closest(".place-opt");
    if (li) choose(Number(li.dataset.index));
  });
  els.list.addEventListener("mousemove", (ev) => {
    const li = ev.target.closest(".place-opt");
    if (!li) return;
    const i = Number(li.dataset.index);
    if (i !== activeIdx) { activeIdx = i; syncActive(); }
  });
  document.addEventListener("mousedown", (ev) => {
    if (!els.root.contains(ev.target)) closePanel();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "/" || ev.metaKey || ev.ctrlKey || ev.altKey || els.root.hidden) return;
    const t = ev.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    ev.preventDefault();
    els.input.focus();
  });

  // Catalog and region events fire before the picker has updated its own
  // state, so look at it on the next tick.
  const later = () => setTimeout(refreshSources, 0);
  document.addEventListener("outhere:catalog", later);
  document.addEventListener("outhere:region", later);
  refreshSources();

  window.__outhere = Object.assign(window.__outhere || {}, {
    places: { get entries() { return entries; }, get sources() { return sources; }, search: (q) => (entries ? search(entries, q) : []) },
  });
}
