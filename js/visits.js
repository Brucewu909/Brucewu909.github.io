// The travel data model: visits to cities, plus how you travelled between them.
// A visit keeps only the city (id, name, country, the city's own coordinates) and dates,
// never the exact GPS position from a photo.

const MERGE_GAP_DAYS = 2;   // photos in the same city within 2 days of each other = one visit
const DAY = 86400000;

export const emptyData = () => ({ version: 1, visits: [], legModes: {}, unplaced: [] });

export const isoDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dayNum = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY;
const newId = () => crypto.randomUUID();

/** Add a stay in `city` from start to end (ISO dates). Merges with a nearby visit to the same city. */
export function addStay(data, city, start, end = start, { source = "manual", photos = 0 } = {}) {
  if (end < start) [start, end] = [end, start];
  let visit = data.visits.find((v) => v.cityId === city.id &&
    dayNum(start) <= dayNum(v.end) + MERGE_GAP_DAYS && dayNum(end) >= dayNum(v.start) - MERGE_GAP_DAYS);
  if (visit) {
    if (start < visit.start) visit.start = start;
    if (end > visit.end) visit.end = end;
    visit.photos += photos;
    if (visit.source !== source) visit.source = "mixed";
    // Growing one visit may now touch another visit to the same city.
    for (const other of data.visits) {
      if (other === visit || other.cityId !== city.id) continue;
      if (dayNum(other.start) <= dayNum(visit.end) + MERGE_GAP_DAYS && dayNum(other.end) >= dayNum(visit.start) - MERGE_GAP_DAYS) {
        visit.start = other.start < visit.start ? other.start : visit.start;
        visit.end = other.end > visit.end ? other.end : visit.end;
        visit.photos += other.photos;
        data.visits.splice(data.visits.indexOf(other), 1);
        break;
      }
    }
  } else {
    visit = { id: newId(), cityId: city.id, name: city.name, cc: city.cc,
              lat: city.lat, lng: city.lng, start, end, source, photos };
    data.visits.push(visit);
  }
  sortVisits(data);
  return visit;
}

export function sortVisits(data) {
  data.visits.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
}

export function removeVisit(data, id) {
  data.visits = data.visits.filter((v) => v.id !== id);
}

/** Unique cities among `visits`, each with its visits, for the globe markers. */
export function placesOf(visits) {
  const map = new Map();
  for (const v of visits) {
    if (!map.has(v.cityId)) map.set(v.cityId, { id: v.cityId, name: v.name, cc: v.cc, lat: v.lat, lng: v.lng, visits: [] });
    map.get(v.cityId).visits.push(v);
  }
  return [...map.values()].map((p) => ({ ...p, weight: p.visits.length }));
}

// ---- time filter ----------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const lastDay = (y, m) => new Date(y, m, 0).getDate(); // m is 1-based

/** Filter presets built from the data: All time, each year, each month with a visit. */
export function filterPresets(visits) {
  const years = new Map();
  for (const v of visits) {
    // a visit spanning months counts for every month it touches
    let y = +v.start.slice(0, 4), m = +v.start.slice(5, 7);
    const ey = +v.end.slice(0, 4), em = +v.end.slice(5, 7);
    while (y < ey || (y === ey && m <= em)) {
      if (!years.has(y)) years.set(y, new Set());
      years.get(y).add(m);
      if (++m > 12) { m = 1; y++; }
    }
  }
  const out = [{ id: "all", label: "All time", range: null }];
  for (const y of [...years.keys()].sort((a, b) => b - a)) {
    out.push({ id: `${y}`, label: `${y}`, range: { from: `${y}-01-01`, to: `${y}-12-31` } });
    for (const m of [...years.get(y)].sort((a, b) => a - b)) {
      const mm = String(m).padStart(2, "0");
      out.push({ id: `${y}-${mm}`, label: `${MONTHS[m - 1]} ${y}`, month: true,
                 range: { from: `${y}-${mm}-01`, to: `${y}-${mm}-${lastDay(y, m)}` } });
    }
  }
  return out;
}

export const inRange = (v, range) => !range || (v.start <= range.to && v.end >= range.from);

// ---- legs between consecutive visits (for the animation) ------------------------

export const MODES = {
  flight: { label: "Flight", color: "#f0c38e" },
  train:  { label: "Train",  color: "#8fd3b6" },
  car:    { label: "Car",    color: "#e8836f" },
  boat:   { label: "Boat",   color: "#8fb4e0" },
};

export function legsOf(data, visits) {
  const legs = [];
  for (let i = 1; i < visits.length; i++) {
    const from = visits[i - 1], to = visits[i];
    if (from.cityId === to.cityId) continue;
    const key = `${from.id}>${to.id}`;
    legs.push({ key, from, to, mode: data.legModes[key] || "flight" });
  }
  return legs;
}

export function formatRange(v) {
  const f = (iso) => new Date(iso + "T00:00:00").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  return v.end && v.end !== v.start ? `${f(v.start)} – ${f(v.end)}` : f(v.start);
}
