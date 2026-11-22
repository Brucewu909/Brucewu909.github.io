import { fetchCities, searchCities, countryName } from "./cities.js";
import { createGlobe } from "./globe.js";
import { readPhotos } from "./photos.js";
import { Vault } from "./store.js";
import { Player } from "./animate.js";
import {
  emptyData, addStay, removeVisit, placesOf, filterPresets, inRange, legsOf, MODES, sortVisits,
} from "./visits.js";

const $ = (id) => document.getElementById(id);
const vault = new Vault();
let data = emptyData();
let presetId = "all";
let customRange = null;
let declinedSaving = false;   // "Not now" on the save prompt: keep this session in memory only
let lockedSaved = false;      // a saved copy exists on this device but wasn't unlocked

const globeApi = createGlobe($("globe"), { onPlaceClick: showPlace, sky: $("sky") });
const player = new Player(globeApi, $("overlay"));

// ------------------------------------------------------------- rendering ----
function currentRange() {
  if (presetId === "custom") return customRange;
  return filterPresets(data.visits).find((p) => p.id === presetId)?.range ?? null;
}
function rangeLabel() {
  if (presetId === "custom") return customRange ? `${customRange.from} – ${customRange.to}` : "Custom";
  return filterPresets(data.visits).find((p) => p.id === presetId)?.label ?? "All time";
}
const filtered = () => data.visits.filter((v) => inRange(v, currentRange()));

function render() {
  renderPresets();
  const visits = filtered();
  globeApi.setPlaces(placesOf(visits));
  renderVisits(visits);
  renderLegs(visits);
  renderUnplaced();
  renderSettings();
}

function renderPresets() {
  const presets = filterPresets(data.visits);
  if (presetId !== "custom" && !presets.some((p) => p.id === presetId)) presetId = "all";
  const sel = $("filter-preset");
  sel.replaceChildren(...presets.map((p) => new Option(p.month ? ` ${p.label}` : p.label, p.id)),
    new Option("Custom range", "custom"));
  sel.value = presetId;
  $("filter-custom").hidden = presetId !== "custom";
}

const fmtDay = (iso, withYear = true) => new Date(iso + "T00:00:00")
  .toLocaleDateString(undefined, { day: "numeric", month: "short", ...(withYear && { year: "numeric" }) });
function when(v) {
  if (v.start === v.end) return fmtDay(v.start);
  const sameYear = v.start.slice(0, 4) === v.end.slice(0, 4);
  return `${fmtDay(v.start, !sameYear)} – ${fmtDay(v.end)}`;
}

function renderVisits(visits) {
  const list = $("visit-list");
  $("visit-count").textContent = visits.length ? String(visits.length).padStart(2, "0") : "";
  if (!visits.length) {
    list.replaceChildren(el("li", "empty", data.visits.length
      ? "Nothing in this period." : "No places yet. Use Add place to start."));
    return;
  }
  list.replaceChildren(...[...visits].reverse().map((v) => {
    const item = el("li");
    item.dataset.city = v.cityId;
    const city = el("span", "city", v.name);
    city.append(el("span", "country", countryName(v.cc)));
    const extra = el("span", "extra", v.photos ? `${v.photos} photo${v.photos > 1 ? "s" : ""}` : "");
    const rm = el("button", "remove", "Remove");
    rm.type = "button";
    rm.setAttribute("aria-label", `Remove this visit to ${v.name}`);
    rm.onclick = (e) => { e.stopPropagation(); removeVisit(data, v.id); changed(); };
    extra.append(rm);
    item.onclick = () => { scrollTo({ top: 0 }); globeApi.flyTo(v.lat, v.lng, 0.7); };
    item.append(el("span", "when", when(v)), city, extra);
    return item;
  }));
}

function renderLegs(visits) {
  const legs = legsOf(data, visits);
  $("play").disabled = $("record").disabled = !legs.length || player.playing;
  $("route-btn").disabled = !legs.length;
  if (!legs.length) {
    $("leg-list").replaceChildren(el("li", "empty", "Add at least two places in this period."));
    return;
  }
  $("leg-list").replaceChildren(...legs.map((leg) => {
    const sel = document.createElement("select");
    sel.setAttribute("aria-label", `How you travelled from ${leg.from.name} to ${leg.to.name}`);
    for (const [id, m] of Object.entries(MODES)) sel.add(new Option(m.label, id));
    sel.value = leg.mode;
    sel.onchange = () => {
      if (sel.value === "flight") delete data.legModes[leg.key]; else data.legModes[leg.key] = sel.value;
      persist();
    };
    const item = el("li", "", `${leg.from.name} → ${leg.to.name}`);
    item.append(sel);
    return item;
  }));
}

function renderUnplaced() {
  const byDate = new Map();
  for (const u of data.unplaced) byDate.set(u.date, (byDate.get(u.date) || 0) + 1);
  $("unplaced").hidden = byDate.size === 0;
  $("unplaced-list").replaceChildren(...[...byDate].sort().map(([date, n]) => {
    const item = el("li", date === assigningDate ? "active" : "", `${date} · ${n} photo${n > 1 ? "s" : ""}`);
    const actions = el("span");
    const pick = el("button", "", "Use");
    pick.type = "button";
    pick.onclick = () => {
      assigningDate = date;
      $("city-from").value = $("city-to").value = date;
      $("city-search").focus();
      updateAddButton(); renderUnplaced();
    };
    const drop = el("button", "", "  Ignore");
    drop.type = "button";
    drop.onclick = () => { data.unplaced = data.unplaced.filter((u) => u.date !== date); changed(); };
    actions.append(pick, drop);
    item.append(actions);
    return item;
  }));
}

function renderSettings() {
  $("set-pass").textContent = lockedSaved ? "Unlock saved places…" : "Save on this device…";
  $("save-state").textContent = vault.enabled
    ? "Saved on this device, encrypted with your passphrase."
    : lockedSaved
      ? "Your saved places are locked. Changes here aren't saved until you unlock them."
    : declinedSaving && data.visits.length
      ? "Not saved. These places disappear when you close the page."
      : "Places are saved on this device, encrypted, once you add one.";
  $("set-pass").hidden = vault.enabled || !(declinedSaving || lockedSaved);
  $("wipe").hidden = !vault.enabled;
}

function el(tag, cls = "", text = "") {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function showPlace(place) {
  globeApi.flyTo(place.lat, place.lng, Math.min(globeApi.globe.pointOfView().altitude, 0.9));
}

// ------------------------------------------------------------- saving ------
let saveTimer = null;
function persist() {
  renderSettings();
  if (!vault.enabled) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => vault.save(data).catch((e) => alert(`Could not save: ${e.message}`)), 300);
}
async function changed() {
  render();
  if (!vault.enabled && !declinedSaving && data.visits.length) await setUpSaving();
  persist();
}

/** Encrypted saving is the default: the first time there is something to save, ask for a passphrase. */
async function setUpSaving() {
  const pass = await askPass({
    title: "Keep your travels",
    text: "Your places are saved only on this device, encrypted with a passphrase (8+ characters). You'll enter it when you open the page. It can't be recovered if forgotten.",
    confirm: true,
  });
  if (pass) { await vault.enable(pass, data); declinedSaving = false; }
  else declinedSaving = true;
  render();
}

/**
 * Ask for a passphrase. `check(pass)` may throw to show an error and keep the dialog open.
 * Resolves with the passphrase, null on cancel, or "forget" if that button was used.
 */
function askPass({ title, text, confirm = false, forget = false, check = async () => {} }) {
  const dlg = $("pass-dialog"), p1 = $("pass-1"), p2 = $("pass-2"), err = $("pass-error");
  $("pass-title").textContent = title;
  $("pass-text").textContent = text;
  p1.value = p2.value = ""; err.textContent = "";
  p2.hidden = !confirm; p2.required = confirm;
  p1.autocomplete = confirm ? "new-password" : "current-password";
  $("pass-forget").hidden = !forget;
  dlg.showModal();
  p1.focus();
  return new Promise((resolve) => {
    const form = dlg.querySelector("form");
    const finish = (value) => {
      form.onsubmit = null; $("pass-cancel").onclick = null; $("pass-forget").onclick = null; dlg.oncancel = null;
      dlg.close(); p1.value = p2.value = ""; resolve(value);
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (confirm && p1.value !== p2.value) { err.textContent = "The passphrases don't match."; return; }
      $("pass-ok").disabled = true; err.textContent = confirm ? "" : "Checking…";
      try { await check(p1.value); finish(p1.value); }
      catch (ex) { err.textContent = ex.message; }
      finally { $("pass-ok").disabled = false; }
    };
    $("pass-cancel").onclick = () => finish(null);
    dlg.oncancel = (e) => { e.preventDefault(); finish(null); };
    $("pass-forget").onclick = () => finish("forget");
  });
}

$("set-pass").onclick = async () => {
  $("settings").hidePopover();
  if (lockedSaved) {               // a saved copy exists but wasn't unlocked: open it, never overwrite it
    if (await unlockSaved()) declinedSaving = false;
    render(); return;
  }
  declinedSaving = false; await setUpSaving(); persist();
};

$("wipe").onclick = async () => {
  $("settings").hidePopover();
  if (!confirm("Delete the saved places from this device? This can't be undone. They stay on screen until you close the page.")) return;
  await vault.disable();
  declinedSaving = true;
  render();
};

$("export").onclick = async () => {
  $("settings").hidePopover();
  let pass = null;
  if (!vault.enabled) {
    pass = await askPass({ title: "Export backup", text: "Choose a passphrase to encrypt this backup file.", confirm: true });
    if (!pass) return;
  }
  const blob = await vault.exportBlob(data, pass);
  download(new Blob([JSON.stringify(blob)], { type: "application/json" }),
    `travels-backup-${new Date().toISOString().slice(0, 10)}.json`);
};

$("import").onchange = async (e) => {
  $("settings").hidePopover();
  const file = e.target.files[0]; e.target.value = "";
  if (!file) return;
  let blob;
  try { blob = JSON.parse(await file.text()); } catch { alert("That file isn't a travels backup."); return; }
  let imported = null;
  const pass = await askPass({
    title: "Import backup", text: `Enter the passphrase for ${file.name}.`,
    check: async (p) => { imported = await vault.importBlob(blob, p); },
  });
  if (!pass || !imported) return;
  if (data.visits.length && !confirm("Replace your current places with the ones in this backup?")) return;
  data = { ...emptyData(), ...imported };
  sortVisits(data);
  changed();
};

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ------------------------------------------------------------- photos ------
let statusTimer = null;
function status(text, ms = 9000) {
  $("photo-status").textContent = text;
  clearTimeout(statusTimer);
  if (ms) statusTimer = setTimeout(() => { $("photo-status").textContent = ""; }, ms);
}

async function addPhotos(files) {
  files = [...files].filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name));
  if (!files.length) return;
  const { placed, unplaced, failed } = await readPhotos(files, (n, total) => status(`Reading ${n} / ${total}`, 0));
  let last = null;
  for (const p of placed) last = addStay(data, p.city, p.date, p.date, { source: "photo", photos: 1 });
  for (const u of unplaced) data.unplaced.push({ date: u.date });
  const parts = [`${placed.length} placed`];
  if (unplaced.length) parts.push(`${unplaced.length} without location (see Add place → Enter manually)`);
  if (failed) parts.push(`${failed} unreadable`);
  if (placed.some((p) => p.approx) || unplaced.some((u) => u.approx)) parts.push("some dates from file dates");
  status(parts.join(" · "));
  if (last) globeApi.flyTo(last.lat, last.lng, 1.2);
  await changed();
}

$("photo-input").onchange = (e) => { $("add-menu").hidePopover(); addPhotos(e.target.files); e.target.value = ""; };
let dragDepth = 0;
addEventListener("dragenter", (e) => { if (e.dataTransfer?.types.includes("Files")) { dragDepth++; $("drop-hint").hidden = false; } });
addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("drop-hint").hidden = true; } });
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => {
  e.preventDefault(); dragDepth = 0; $("drop-hint").hidden = true;
  if (e.dataTransfer?.files.length) addPhotos(e.dataTransfer.files);
});

// ------------------------------------------------------- manual add -------
let selectedCity = null, assigningDate = null, activeIndex = -1, results = [];
function updateAddButton() { $("city-add").disabled = !(selectedCity && $("city-from").value); }

$("open-manual").onclick = () => {
  $("add-menu").hidePopover();
  $("manual-dialog").showModal();
  $("city-search").focus();
};
$("manual-cancel").onclick = () => $("manual-dialog").close();
$("manual-dialog").addEventListener("close", () => {
  selectedCity = null; assigningDate = null; results = [];
  $("city-search").value = ""; $("city-from").value = $("city-to").value = "";
  $("city-results").replaceChildren();
  updateAddButton(); renderUnplaced();
});
$("manual-form").onsubmit = (e) => e.preventDefault();

$("city-search").oninput = () => {
  selectedCity = null; updateAddButton();
  results = searchCities($("city-search").value, 6);
  activeIndex = -1;
  $("city-results").replaceChildren(...results.map((c) => {
    const item = el("li", "", c.name);
    item.setAttribute("role", "option");
    item.append(el("small", "", countryName(c.cc)));
    item.onclick = () => pickCity(c);
    return item;
  }));
};
$("city-search").onkeydown = (e) => {
  if (!results.length) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    activeIndex = (activeIndex + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
    [...$("city-results").children].forEach((c, i) => c.setAttribute("aria-selected", i === activeIndex));
  } else if (e.key === "Enter" && activeIndex >= 0) {
    e.preventDefault(); pickCity(results[activeIndex]);
  }
};
function pickCity(c) {
  selectedCity = c; results = [];
  $("city-search").value = `${c.name}, ${countryName(c.cc)}`;
  $("city-results").replaceChildren();
  if (!$("city-from").value) $("city-from").focus();
  updateAddButton();
}
$("city-from").oninput = () => {
  if (!$("city-to").value || $("city-to").value < $("city-from").value) $("city-to").value = $("city-from").value;
  updateAddButton();
};
$("city-to").oninput = updateAddButton;
$("city-add").onclick = async () => {
  const from = $("city-from").value, to = $("city-to").value || from;
  let photos = 0;
  if (assigningDate && assigningDate >= from && assigningDate <= to) {
    photos = data.unplaced.filter((u) => u.date === assigningDate).length;
    data.unplaced = data.unplaced.filter((u) => u.date !== assigningDate);
  }
  const v = addStay(data, selectedCity, from, to, { source: photos ? "photo" : "manual", photos });
  $("manual-dialog").close();
  globeApi.flyTo(v.lat, v.lng, 1.2);
  await changed();
};

// --------------------------------------------------------------- filter ----
$("filter-preset").onchange = (e) => {
  presetId = e.target.value;
  if (presetId === "custom" && !customRange) {
    const today = new Date().toISOString().slice(0, 10);
    $("filter-from").value ||= data.visits[0]?.start || today;
    $("filter-to").value ||= today;
    customRange = { from: $("filter-from").value, to: $("filter-to").value };
  }
  render();
};
for (const id of ["filter-from", "filter-to"]) {
  $(id).oninput = () => {
    const from = $("filter-from").value, to = $("filter-to").value;
    if (from && to) { customRange = from <= to ? { from, to } : { from: to, to: from }; render(); }
  };
}

// ------------------------------------------------------------ animation ----
async function runAnimation(record) {
  const legs = legsOf(data, filtered());
  if (!legs.length) return;
  scrollTo({ top: 0 });
  document.body.classList.add("playing");
  for (const id of ["play", "record", "route-btn", "filter-preset"]) $(id).disabled = true;
  $("stop").hidden = false; $("clear-paths").hidden = true;
  $("play").hidden = $("record").hidden = true;
  try {
    const video = await player.play(legs, { title: rangeLabel(), record });
    if (video) download(video, `travels-${rangeLabel().replace(/[^\w-]+/g, "-")}.webm`);
  } catch (e) {
    alert(`The animation stopped: ${e.message}`);
  } finally {
    document.body.classList.remove("playing");
    $("stop").hidden = true; $("clear-paths").hidden = false;
    $("play").hidden = $("record").hidden = false;
    $("route-btn").disabled = $("filter-preset").disabled = false;
    render();
  }
}
$("play").onclick = () => runAnimation(false);
$("record").onclick = () => runAnimation(true);
$("stop").onclick = () => player.stop();
$("clear-paths").onclick = () => { player.clearPaths(); $("clear-paths").hidden = true; };

addEventListener("scroll", () => document.body.classList.toggle("scrolled", scrollY > 40), { passive: true });

$("log-handle").onclick = () => {
  const top = $("log").offsetTop;
  scrollTo({ top: scrollY < top / 2 ? top - 40 : 0 });
};

// ---------------------------------------------------------------- start ----
async function start() {
  render();
  try {
    await fetchCities();
  } catch (e) {
    status(`City list failed to load (${e.message}). Open this page through a local web server.`, 0);
  }
  try {
    if (await vault.hasSaved()) await unlockSaved();
  } catch (e) {
    console.warn("Storage unavailable", e);
  }
  render();
}

/** Open the encrypted copy saved on this device. Places already on screen are merged in. */
async function unlockSaved() {
  let unlocked = null;
  const pass = await askPass({
    title: "Unlock your travels",
    text: "Your places are saved on this device, encrypted. Enter your passphrase to open them.",
    forget: true,
    check: async (p) => { unlocked = await vault.unlock(p); },
  });
  if (pass === "forget") {
    if (confirm("Delete the saved places from this device? This can't be undone.")) { await vault.disable(); lockedSaved = false; }
    else { lockedSaved = true; declinedSaving = true; }
    return false;
  }
  if (!unlocked) { lockedSaved = true; declinedSaving = true; return false; }   // never overwrite a locked copy
  lockedSaved = false;
  const onScreen = data;
  data = { ...emptyData(), ...unlocked };
  for (const v of onScreen.visits) addStay(data, { id: v.cityId, name: v.name, cc: v.cc, lat: v.lat, lng: v.lng }, v.start, v.end, { source: v.source, photos: v.photos });
  Object.assign(data.legModes, onScreen.legModes);
  data.unplaced.push(...onScreen.unplaced);
  sortVisits(data);
  persist();
  return true;
}
start();
