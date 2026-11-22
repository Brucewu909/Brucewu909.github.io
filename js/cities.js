// Offline city lookup over data/cities.json (GeoNames cities with population >= 15,000).
// Nothing here talks to the network beyond loading that one local file.
import { distanceKm } from "./geo.js";

const SNAP_KM = 75;
let cities = [];          // [{id, name, cc, lat, lng, pop, key}]
const byId = new Map();
const grid = new Map();   // "latCell,lngCell" -> [city]

const cellKey = (la, ln) => `${la},${ln}`;
export const normalize = (s) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

let regionNames = null;
export function countryName(cc) {
  try {
    regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
    return regionNames.of(cc) || cc;
  } catch { return cc; }
}

/** Load from parsed cities.json content (also used by the Node checks). */
export function loadCities(json) {
  cities = json.rows.map(([id, name, ascii, cc, lat, lng, pop]) => ({
    id, name, cc, lat, lng, pop, key: normalize(ascii || name),
  }));
  byId.clear(); grid.clear();
  for (const c of cities) {
    byId.set(c.id, c);
    const k = cellKey(Math.floor(c.lat), Math.floor(c.lng));
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(c);
  }
  return cities.length;
}

export async function fetchCities(url = "data/cities.json") {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url}: ${res.status}`);
  return loadCities(await res.json());
}

export const cityById = (id) => byId.get(id);

/**
 * The city a photo taken at (lat, lng) belongs to, or null if none is within SNAP_KM.
 * Bigger cities pull harder (population / distance^2.5), so a photo in central Paris
 * snaps to Paris rather than a 20k suburb a kilometre away, while a photo taken in a
 * town far from a big city stays with that town.
 */
export function nearestCity(lat, lng) {
  const la0 = Math.floor(lat), ln0 = Math.floor(lng);
  const lngSpan = Math.min(180, Math.ceil(1 / Math.max(0.05, Math.cos(lat * Math.PI / 180))));
  let best = null, bestScore = -1;
  for (let dla = -1; dla <= 1; dla++) {
    for (let dln = -lngSpan; dln <= lngSpan; dln++) {
      let ln = ln0 + dln;
      if (ln < -180) ln += 360; else if (ln >= 180) ln -= 360;
      const bucket = grid.get(cellKey(la0 + dla, ln));
      if (!bucket) continue;
      for (const c of bucket) {
        const d = distanceKm(lat, lng, c.lat, c.lng);
        if (d > SNAP_KM) continue;
        const score = Math.max(c.pop, 1) / (d + 5) ** 2.5;
        if (score > bestScore) { bestScore = score; best = c; }
      }
    }
  }
  return best;
}

/** Name search for the manual "Add city" box: prefix matches first, then substring, by population. */
export function searchCities(query, limit = 8) {
  const q = normalize(query);
  if (q.length < 2) return [];
  const prefix = [], inner = [];
  for (const c of cities) {          // cities are sorted by population, largest first
    if (c.key.startsWith(q)) { prefix.push(c); if (prefix.length >= limit) break; }
    else if (inner.length < limit && c.key.includes(q)) inner.push(c);
  }
  return prefix.concat(inner).slice(0, limit);
}
