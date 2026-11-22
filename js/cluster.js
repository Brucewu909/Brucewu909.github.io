// Zoom-aware merging of city POIs: the further out the camera, the wider the merge radius.
import { distanceKm, centroid } from "./geo.js";

/** Merge radius in km for a globe.gl camera altitude (in globe radii above the surface). */
export const mergeKm = (altitude) => Math.max(15, altitude * 650);

/**
 * Greedy clustering. `places` is [{id, lat, lng, weight}] (weight = visits, used to seed
 * clusters from the most-visited places). Returns [{key, lat, lng, members}].
 */
export function cluster(places, altitude) {
  const radius = mergeKm(altitude);
  const sorted = [...places].sort((a, b) => b.weight - a.weight || a.id - b.id);
  const groups = [];
  for (const p of sorted) {
    let home = null, homeD = Infinity;
    for (const g of groups) {
      const d = distanceKm(p.lat, p.lng, g.seed.lat, g.seed.lng);
      if (d <= radius && d < homeD) { home = g; homeD = d; }
    }
    if (home) home.members.push(p);
    else groups.push({ seed: p, members: [p] });
  }
  return groups.map((g) => {
    const c = g.members.length === 1 ? g.seed : centroid(g.members);
    return {
      key: g.members.map((m) => m.id).sort((a, b) => a - b).join("-"),
      lat: c.lat, lng: c.lng, members: g.members,
    };
  });
}
