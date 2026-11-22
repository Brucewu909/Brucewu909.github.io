// Small spherical-geometry helpers shared by the lookup, clustering and animation code.
export const EARTH_KM = 6371;
const RAD = Math.PI / 180;

export function toVec(lat, lng) {
  const p = lat * RAD, l = lng * RAD;
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
}

export function fromVec([x, y, z]) {
  const n = Math.hypot(x, y, z) || 1;
  return { lat: Math.asin(z / n) / RAD, lng: Math.atan2(y, x) / RAD };
}

/** Central angle between two points, in radians. */
export function angle(aLat, aLng, bLat, bLng) {
  const dp = (bLat - aLat) * RAD, dl = (bLng - aLng) * RAD;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin(dl / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function distanceKm(aLat, aLng, bLat, bLng) {
  return angle(aLat, aLng, bLat, bLng) * EARTH_KM;
}

/** Point a fraction t of the way along the great circle from a to b. */
export function slerp(a, b, t) {
  const w = angle(a.lat, a.lng, b.lat, b.lng);
  if (w < 1e-9) return { lat: a.lat, lng: a.lng };
  const va = toVec(a.lat, a.lng), vb = toVec(b.lat, b.lng);
  const s = Math.sin(w), ka = Math.sin((1 - t) * w) / s, kb = Math.sin(t * w) / s;
  return fromVec([va[0] * ka + vb[0] * kb, va[1] * ka + vb[1] * kb, va[2] * ka + vb[2] * kb]);
}

/** Mean position of several lat/lng points (vector average). */
export function centroid(points) {
  let x = 0, y = 0, z = 0;
  for (const p of points) { const v = toVec(p.lat, p.lng); x += v[0]; y += v[1]; z += v[2]; }
  return fromVec([x, y, z]);
}
