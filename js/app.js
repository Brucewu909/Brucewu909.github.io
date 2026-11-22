import { fetchCities, searchCities, countryName } from "./cities.js";
import { createGlobe } from "./globe.js";
import { readPhotos } from "./photos.js";
import { Vault } from "./store.js";
import { Player } from "./animate.js";
import {
  emptyData, addStay, removeVisit, placesOf, filterPresets, inRange, legsOf, MODES, formatRange, sortVisits,
} from "./visits.js";

const $ = (id) => document.getElementById(id);
const vault = new Vault();
let data = emptyData();
let presetId = "all";
let customRange = null;

// ---------------------------------------------------------------- globe ----
const globeApi = createGlobe($("globe"), { onPlaceClick: showPlace });
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
}

function renderPresets() {
  const presets = filterPresets(data.visits);
  if (presetId !== "custom" && !presets.some((p) => p.id === presetId)) presetId = "all";
  const sel = $("filter-preset");
  sel.replaceChildren(...presets.map((p) => new Option(p.month ? `  ${p.label}` : p.label, p.id)),
    new Option("Custom range…", "custom"));
  sel.value = presetId;
  $("filter-custom").hidden = presetId !== "custom";
}

function renderVisits(visits) {
  const list = $("visit-list");
  $("visit-count").textContent = visits.length ? `· ${visits.length}` : "";
  if (!visits.length) {
    list.replaceChildren(li("empty", data.visits.length ? "No places in this time range." : "No places yet. Upload photos or add a city."));
    return;
  }
  list.replaceChildren(...[...visits].reverse().map((v) => {
    const item = document.createElement("li");
    item.dataset.city = v.cityId;
    const name = document.createElement("span");
    name.className = "name"; name.textContent = `${v.name}, ${countryName(v.cc)}`;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = formatRange(v) + (v.photos ? ` · ${v.photos} photo${v.photos > 1 ? "s" : ""}` : "");
    const rm = document.createElement("button");
    rm.type = "button"; rm.className = "icon-btn remove"; rm.textContent = "✕";
    rm.title = `Remove this visit to ${v.name}`;
    rm.onclick = (e) => { e.stopPropagation(); removeVisit(data, v.id); changed(); };
    item.onclick = () => globeApi.flyTo(v.lat, v.lng, 0.6);
    item.append(name, rm, meta);
    return item;
  }));
}

function renderLegs(visits) {
  const legs = legsOf(data, visits);
  const list = $("leg-list");
  $("play").disabled = $("record").disabled = !legs.length || player.playing;
  if (!legs.length) {
    list.replaceChildren(li("empty", "Add at least two places in this range to animate."));
    return;
  }
  list.replaceChildren(...legs.map((leg) => {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${leg.from.name} → ${leg.to.name}`;
    const sel = document.createElement("select");
    sel.setAttribute("aria-label", `How you travelled from ${leg.from.name} to ${leg.to.name}`);
    for (const [id, m] of Object.entries(MODES)) sel.add(new Option(`${m.icon} ${m.label}`, id));
    sel.value = leg.mode;
    sel.onchange = () => {
      if (sel.value === "flight") delete data.legModes[leg.key]; else data.legModes[leg.key] = sel.value;
      persist();
    };
    item.append(label, sel);
    return item;
  }));
}

function renderUnplaced() {
  const byDate = new Map();
  for (const u of data.unplaced) byDate.set(u.date, (byDate.get(u.date) || 0) + 1);
  $("unplaced").hidden = byDate.size === 0;
  $("unplaced-list").replaceChildren(...[...byDate].sort().map(([date, n]) => {
    const item = document.createElement("li");
    const t = document.createElement("span");
    t.textContent = `${date} · ${n} photo${n > 1 ? "s" : ""}`;
    const pick = document.createElement("button");
    pick.type = "button"; pick.className = "icon-btn"; pick.textContent = "Choose city";
    pick.onclick = () => {
      assigningDate = date;
      $("city-from").value = $("city-to").value = date;
      $("add-city").open = true;
      $("city-search").focus();
      updateAddButton();
    };
    const drop = document.createElement("button");
    drop.type = "button"; drop.className = "icon-btn"; drop.textContent = "✕";
    drop.title = "Ignore these photos";
    drop.onclick = () => { data.unplaced = data.unplaced.filter((u) => u.date !== date); changed(); };
    const actions = document.createElement("span");
    actions.append(pick, drop);
    item.append(t, actions);
    return item;
  }));
}

function li(cls, text) { const e = document.createElement("li"); e.className = cls; e.textContent = text; return e; }

function showPlace(place) {
  globeApi.flyTo(place.lat, place.lng, Math.min(globeApi.globe.pointOfView().altitude, 0.8));
  const item = $("visit-list").querySelector(`[data-city="${place.id}"]`);
  if (item) {
    item.scrollIntoView({ behavior: "smooth", block: "center" });
    item.animate([{ background: "rgba(255,209,102,.25)" }, { background: "transparent" }], { duration: 1400 });
  }
}

// ------------------------------------------------------------- saving ------
let saveTimer = null;
function persist() {
  updateBadge();
  if (!vault.enabled) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => vault.save(data).catch((e) => alert(`Could not save: ${e.message}`)), 300);
}
function changed() { render(); persist(); }
function updateBadge() {
  const b = $("save-badge");
  b.textContent = vault.enabled ? "Saved · encrypted" : "Not saved";
  b.classList.toggle("saved", vault.enabled);
  $("store-toggle").checked = vault.enabled;
}

/**
 * Ask for a passphrase. `check(pass)` may throw to show an error and keep the dialog open.
 * Resolves with the passphrase, null on cancel, or "forget" if that link was used.
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

$("store-toggle").onchange = async (e) => {
  if (e.target.checked) {
    // An earlier saved copy exists (unlock was skipped): open it rather than overwrite it.
    if (await vault.hasSaved()) { await unlockSaved(); updateBadge(); render(); return; }
    const pass = await askPass({
      title: "Store on this device",
      text: "Choose a passphrase (8+ characters). Your places are encrypted with it and kept only in this browser. You'll need it each time you open the page; it can't be recovered if you forget it.",
      confirm: true,
    });
    if (pass) await vault.enable(pass, data);
  } else if (confirm("Stop storing and delete the saved copy from this browser? Your places stay on screen until you close the page.")) {
    await vault.disable();
  }
  updateBadge();
};

$("export").onclick = async () => {
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
  if (data.visits.length && !confirm("Replace the places on screen with the ones in this backup?")) return;
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
async function addPhotos(files) {
  files = [...files].filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name));
  if (!files.length) return;
  const status = $("photo-status");
  const { placed, unplaced, failed } = await readPhotos(files, (n, total) => { status.textContent = `Reading ${n} of ${total}…`; });
  let last = null;
  for (const p of placed) last = addStay(data, p.city, p.date, p.date, { source: "photo", photos: 1 });
  for (const u of unplaced) data.unplaced.push({ date: u.date });
  const parts = [`${placed.length} photo${placed.length === 1 ? "" : "s"} placed`];
  if (unplaced.length) parts.push(`${unplaced.length} without a location`);
  if (failed) parts.push(`${failed} couldn't be read`);
  if (placed.some((p) => p.approx) || unplaced.some((u) => u.approx)) parts.push("some dates are file dates, not capture dates");
  status.textContent = parts.join(" · ") + ".";
  changed();
  if (last) globeApi.flyTo(last.lat, last.lng, 1.2);
}

$("photo-input").onchange = (e) => { addPhotos(e.target.files); e.target.value = ""; };
let dragDepth = 0;
addEventListener("dragenter", (e) => { if (e.dataTransfer?.types.includes("Files")) { dragDepth++; $("drop-hint").hidden = false; } });
addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("drop-hint").hidden = true; } });
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => {
  e.preventDefault(); dragDepth = 0; $("drop-hint").hidden = true;
  if (e.dataTransfer?.files.length) addPhotos(e.dataTransfer.files);
});

// ----------------------------------------------------------- add a city ----
let selectedCity = null, assigningDate = null, activeIndex = -1;
function updateAddButton() { $("city-add").disabled = !(selectedCity && $("city-from").value); }

$("city-search").oninput = () => {
  selectedCity = null; updateAddButton();
  const results = searchCities($("city-search").value);
  activeIndex = -1;
  $("city-results").replaceChildren(...results.map((c, i) => {
    const item = document.createElement("li");
    item.setAttribute("role", "option");
    item.innerHTML = `<span></span> <small></small>`;
    item.firstChild.textContent = c.name;
    item.lastChild.textContent = countryName(c.cc);
    item.onclick = () => pickCity(c);
    item.dataset.i = i;
    return item;
  }));
  $("city-results")._results = results;
};
$("city-search").onkeydown = (e) => {
  const results = $("city-results")._results || [];
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
  selectedCity = c;
  $("city-search").value = `${c.name}, ${countryName(c.cc)}`;
  $("city-results").replaceChildren(); $("city-results")._results = [];
  if (!$("city-from").value) $("city-from").focus();
  updateAddButton();
}
$("city-from").oninput = () => { if (!$("city-to").value || $("city-to").value < $("city-from").value) $("city-to").value = $("city-from").value; updateAddButton(); };
$("city-to").oninput = updateAddButton;
$("city-add").onclick = () => {
  const from = $("city-from").value, to = $("city-to").value || from;
  let photos = 0;
  if (assigningDate && assigningDate >= from && assigningDate <= to) {
    photos = data.unplaced.filter((u) => u.date === assigningDate).length;
    data.unplaced = data.unplaced.filter((u) => u.date !== assigningDate);
  }
  const v = addStay(data, selectedCity, from, to, { source: photos ? "photo" : "manual", photos });
  assigningDate = null; selectedCity = null;
  $("city-search").value = ""; $("city-from").value = $("city-to").value = "";
  updateAddButton();
  changed();
  globeApi.flyTo(v.lat, v.lng, 1.2);
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
  for (const id of ["play", "record"]) $(id).disabled = true;
  $("stop").hidden = false; $("clear-paths").hidden = true;
  $("filter-preset").disabled = true;
  try {
    const video = await player.play(legs, { title: rangeLabel(), record });
    if (video) download(video, `travels-${rangeLabel().replace(/[^\w-]+/g, "-")}.webm`);
  } catch (e) {
    alert(`The animation stopped: ${e.message}`);
  } finally {
    $("stop").hidden = true; $("clear-paths").hidden = false;
    $("filter-preset").disabled = false;
    render();
  }
}
$("play").onclick = () => runAnimation(false);
$("record").onclick = () => runAnimation(true);
$("stop").onclick = () => player.stop();
$("clear-paths").onclick = () => { player.clearPaths(); $("clear-paths").hidden = true; };

// ---------------------------------------------------------------- start ----
async function start() {
  render();
  try {
    await fetchCities();
  } catch (e) {
    $("photo-status").textContent = `City list failed to load (${e.message}). Serve this folder over http, not file://.`;
  }
  try {
    if (await vault.hasSaved()) await unlockSaved();
  } catch (e) {
    console.warn("Storage unavailable", e);
  }
  updateBadge();
  render();
}

/** Open the encrypted copy saved in this browser. Places already on screen are merged in. */
async function unlockSaved() {
  let unlocked = null;
  const pass = await askPass({
    title: "Unlock your travels",
    text: "Your places are stored encrypted in this browser. Enter your passphrase to open them.",
    forget: true,
    check: async (p) => { unlocked = await vault.unlock(p); },
  });
  if (pass === "forget") {
    if (confirm("Delete the saved places from this browser? This can't be undone.")) await vault.disable();
    return false;
  }
  if (!unlocked) return false;
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
