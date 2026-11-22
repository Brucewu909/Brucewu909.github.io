// Real-world paths for ground and sea legs.
//   car   -> OSRM road routing (router.project-osrm.org, OpenStreetMap data)
//   train -> BRouter "rail" profile (brouter.de, OpenStreetMap railways); falls back to roads
//   boat  -> shortest path over the Eurostat SeaRoute shipping-lane network (searoute-js data)
// Flights stay great-circle arcs. Results are cached with the trip (encrypted when saved),
// so each leg is looked up once. Only the two cities' coordinates are sent to the routers.
import { distanceKm } from "./geo.js";

const OSRM = "https://router.project-osrm.org/route/v1/driving/";
const BROUTER = "https://brouter.de/brouter";
const SEA_NET = "https://cdn.jsdelivr.net/npm/searoute-js@0.1.0/data/marnet_densified.json";
const MAX_POINTS = 600;

async function getJson(url, ms = 25000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, referrerPolicy: "no-referrer", credentials: "omit" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

/** [[lng, lat], ...] -> [[lat, lng], ...], thinned to at most MAX_POINTS. */
function toLatLng(coords) {
  const step = Math.max(1, Math.ceil(coords.length / MAX_POINTS));
  const out = [];
  for (let i = 0; i < coords.length; i += step) out.push([coords[i][1], coords[i][0]]);
  const last = coords[coords.length - 1];
  if (out[out.length - 1][0] !== last[1] || out[out.length - 1][1] !== last[0]) out.push([last[1], last[0]]);
  return out;
}

async function roadRoute(a, b) {
  const j = await getJson(`${OSRM}${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`);
  if (j.code !== "Ok" || !j.routes?.length) throw new Error(j.code || "no road route");
  return toLatLng(j.routes[0].geometry.coordinates);
}

async function railRoute(a, b) {
  const j = await getJson(`${BROUTER}?lonlats=${a.lng},${a.lat}|${b.lng},${b.lat}&profile=rail&alternativeidx=0&format=geojson`, 40000);
  const coords = j.features?.[0]?.geometry?.coordinates;
  if (!coords?.length) throw new Error("no rail route");
  return toLatLng(coords);
}

// ---- sea lanes: Dijkstra over the shipping-lane network -------------------------
let seaGraph = null;
async function loadSeaGraph() {
  if (seaGraph) return seaGraph;
  const net = await getJson(SEA_NET);
  const ids = new Map(), nodes = [], adj = [];
  const node = ([lng, lat]) => {
    if (lng === -180) lng = 180;               // the network meets itself at the antimeridian
    const key = `${lng.toFixed(4)},${lat.toFixed(4)}`;
    let id = ids.get(key);
    if (id === undefined) { id = nodes.length; ids.set(key, id); nodes.push([lat, lng]); adj.push([]); }
    return id;
  };
  for (const f of net.features) {
    const c = f.geometry.coordinates;
    for (let i = 1; i < c.length; i++) {
      const u = node(c[i - 1]), v = node(c[i]);
      if (u === v) continue;
      const w = distanceKm(nodes[u][0], nodes[u][1], nodes[v][0], nodes[v][1]);
      adj[u].push([v, w]); adj[v].push([u, w]);
    }
  }
  return (seaGraph = { nodes, adj });
}

function nearestNode(g, p) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < g.nodes.length; i++) {
    const d = distanceKm(p.lat, p.lng, g.nodes[i][0], g.nodes[i][1]);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function dijkstra(g, s, t) {
  const n = g.nodes.length, dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
  const heap = [[0, s]]; dist[s] = 0;
  const push = (item) => { heap.push(item); let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop();
    if (heap.length) { heap[0] = last; let i = 0;
      for (;;) { const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } }
    return top; };
  while (heap.length) {
    const [d, u] = pop();
    if (u === t) break;
    if (d > dist[u]) continue;
    for (const [v, w] of g.adj[u]) if (d + w < dist[v]) { dist[v] = d + w; prev[v] = u; push([dist[v], v]); }
  }
  if (!isFinite(dist[t])) throw new Error("no sea route");
  const path = [];
  for (let u = t; u !== -1; u = prev[u]) path.push(g.nodes[u]);
  return path.reverse();
}

async function seaRoute(a, b) {
  const g = await loadSeaGraph();
  const path = dijkstra(g, nearestNode(g, a), nearestNode(g, b));
  return [[a.lat, a.lng], ...path, [b.lat, b.lng]];
}

/** A route must actually start and end near the two cities (routers snap to the nearest road). */
const reaches = (route, a, b) => route.length > 1 &&
  distanceKm(route[0][0], route[0][1], a.lat, a.lng) < 60 &&
  distanceKm(route.at(-1)[0], route.at(-1)[1], b.lat, b.lng) < 60;

const ROUTERS = {
  car: [roadRoute],
  train: [railRoute, roadRoute],
  boat: [seaRoute],
};

/**
 * Fill in `leg.route` ([[lat, lng], ...]) for every non-flight leg, using and updating `cache`
 * (an object keyed by leg + mode). Legs that can't be routed keep a straight line and are listed
 * in the returned `missing` array.
 */
export async function resolveRoutes(legs, cache, onProgress = () => {}) {
  const missing = [];
  const todo = legs.filter((l) => l.mode !== "flight");
  let n = 0;
  for (const leg of todo) {
    const key = `${leg.key}|${leg.mode}`;
    if (!cache[key]) {
      onProgress(++n, todo.length);
      for (const router of ROUTERS[leg.mode] || []) {
        try {
          const route = await router(leg.from, leg.to);
          if (reaches(route, leg.from, leg.to)) { cache[key] = route; break; }
        } catch { /* try the next router */ }
      }
    }
    if (cache[key]) leg.route = cache[key];
    else missing.push(leg);
  }
  return missing;
}
