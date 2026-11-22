// Low-poly 3D vehicles, built from three.js geometry (no downloaded model files).
// Convention: length along +X (front at +X), height along +Y (base at y = 0), width along Z.
// Lengths are in model units; the animation scales them to a steady on-screen size.
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.185.0/build/three.module.min.js";

export { THREE };

const mat = (color, opts = {}) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...opts });
const M = {
  white: mat(0xf4f5f7), grey: mat(0xb8bfc9), dark: mat(0x2a313b), glass: mat(0x24364d),
  accent: mat(0xf0c38e), red: mat(0xd9543f), redDark: mat(0x9c3424), tyre: mat(0x15181d),
  green: mat(0x2f9c80), hull: mat(0x2c568a), deck: mat(0xe9ecef), light: mat(0xfff1c4),
};

function mesh(geo, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  return m;
}

/** A flat outline in the X/Z plane (as [x, z] pairs), extruded upward by `h`, base at `y`. */
function slab(points, h, material, y = 0) {
  const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, -z)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);           // shape plane -> X/Z, extrusion -> +Y
  return mesh(geo, material, 0, y, 0);
}

/** A side profile in the X/Y plane (as [x, y] pairs), extruded across the width `w` (centred). */
function profile(points, w, material) {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false });
  geo.translate(0, 0, -w / 2);
  return mesh(geo, material);
}

function plane() {
  const g = new THREE.Group();
  // fuselage along X
  const body = new THREE.CylinderGeometry(0.55, 0.55, 7.2, 12); body.rotateZ(Math.PI / 2);
  g.add(mesh(body, M.white, -0.2, 0, 0));
  const nose = new THREE.SphereGeometry(0.55, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2); nose.rotateZ(-Math.PI / 2); nose.scale(1.9, 1, 1);
  g.add(mesh(nose, M.white, 3.4, 0, 0));
  const tailCone = new THREE.ConeGeometry(0.55, 1.6, 12); tailCone.rotateZ(Math.PI / 2);
  g.add(mesh(tailCone, M.white, -4.6, 0.1, 0));
  // cockpit windows and livery stripe
  g.add(mesh(new THREE.BoxGeometry(0.5, 0.22, 0.8), M.glass, 4.15, 0.25, 0));
  g.add(mesh(new THREE.BoxGeometry(7, 0.12, 1.12), M.accent, -0.3, -0.1, 0));
  // swept wings and tailplane (thin slabs)
  for (const s of [1, -1]) {
    g.add(slab([[1.3, 0.4 * s], [-0.9, 5.2 * s], [-1.9, 5.2 * s], [-0.9, 0.4 * s]], 0.14, M.grey, -0.25));
    g.add(slab([[-3.7, 0.3 * s], [-4.9, 2.0 * s], [-5.4, 2.0 * s], [-5.0, 0.3 * s]], 0.1, M.grey, 0.05));
    const eng = new THREE.CylinderGeometry(0.28, 0.28, 1.1, 10); eng.rotateZ(Math.PI / 2);
    g.add(mesh(eng, M.dark, 0.6, -0.5, 1.8 * s));
  }
  // tail fin
  g.add(profile([[-3.7, 0.4], [-5.2, 2.2], [-5.7, 2.2], [-5.2, 0.4]], 0.12, M.accent));
  return { group: g, length: 10, lift: 0 };
}

function car() {
  const g = new THREE.Group();
  // body: lower shell with a sloped bonnet, and a cabin
  g.add(profile([[-2.1, 0.35], [2.1, 0.35], [2.2, 0.75], [1.9, 1.0], [-2.0, 1.05], [-2.2, 0.75]], 1.8, M.red));
  g.add(profile([[-1.3, 1.0], [0.6, 1.0], [0.05, 1.6], [-1.15, 1.6]], 1.6, M.redDark));
  // windows (slightly proud of the cabin)
  g.add(profile([[0.48, 1.05], [0.08, 1.55], [-0.05, 1.55], [0.35, 1.05]], 1.5, M.glass));
  g.add(mesh(new THREE.BoxGeometry(1.1, 0.42, 1.62), M.glass, -0.55, 1.3, 0));
  // wheels
  const wheel = new THREE.CylinderGeometry(0.38, 0.38, 0.3, 12); wheel.rotateX(Math.PI / 2);
  for (const x of [1.3, -1.3]) for (const z of [0.85, -0.85]) g.add(mesh(wheel, M.tyre, x, 0.38, z));
  // lights
  for (const z of [0.55, -0.55]) g.add(mesh(new THREE.BoxGeometry(0.08, 0.18, 0.35), M.light, 2.18, 0.72, z));
  return { group: g, length: 4.5, lift: 0 };
}

function train() {
  const g = new THREE.Group();
  const W = 1.3;
  // power car with a raked nose, then a trailing carriage
  g.add(profile([[-3, 0.25], [2.2, 0.25], [3.6, 0.6], [3.4, 1.05], [2.0, 1.75], [-3, 1.75]], W, M.white));
  g.add(profile([[2.2, 1.0], [3.3, 0.95], [2.0, 1.65], [1.7, 1.65]], W * 0.9, M.glass));
  g.add(mesh(new THREE.BoxGeometry(6.2, 1.5, W), M.white, -6.4, 1.0, 0));
  // stripes and windows along both carriages
  g.add(mesh(new THREE.BoxGeometry(6, 0.18, W + 0.02), M.green, -0.2, 0.55, 0));
  g.add(mesh(new THREE.BoxGeometry(6, 0.18, W + 0.02), M.green, -6.4, 0.55, 0));
  g.add(mesh(new THREE.BoxGeometry(4.4, 0.32, W + 0.03), M.glass, -0.6, 1.25, 0));
  g.add(mesh(new THREE.BoxGeometry(5.4, 0.32, W + 0.03), M.glass, -6.4, 1.25, 0));
  // bogies and pantograph
  for (const x of [1.5, -2.2, -4.2, -8.6]) g.add(mesh(new THREE.BoxGeometry(1.0, 0.25, W * 0.8), M.dark, x, 0.13, 0));
  g.add(mesh(new THREE.BoxGeometry(0.9, 0.08, 0.5), M.dark, -1.5, 1.95, 0));
  g.add(mesh(new THREE.BoxGeometry(0.1, 0.3, 0.1), M.dark, -1.5, 1.8, 0));
  g.position.x = 2.4;    // centre the two-car set on the route point
  const wrap = new THREE.Group(); wrap.add(g);
  return { group: wrap, length: 13, lift: 0 };
}

function boat() {
  const g = new THREE.Group();
  const hullOutline = [[4.6, 0], [3.4, 1.15], [-3.6, 1.2], [-3.9, 0.9], [-3.9, -0.9], [-3.6, -1.2], [3.4, -1.15]];
  g.add(slab(hullOutline, 0.9, M.hull, 0));
  g.add(slab([[4.2, 0], [3.2, 1.0], [-3.5, 1.05], [-3.5, -1.05], [3.2, -1.0]], 0.12, M.deck, 0.9));
  // superstructure, bridge windows, funnel, lifeboats
  g.add(mesh(new THREE.BoxGeometry(4.2, 0.9, 1.5), M.white, -0.6, 1.47, 0));
  g.add(mesh(new THREE.BoxGeometry(1.6, 0.6, 1.3), M.white, 0.3, 2.2, 0));
  g.add(mesh(new THREE.BoxGeometry(0.05, 0.3, 1.2), M.glass, 1.12, 2.25, 0));
  const funnel = new THREE.CylinderGeometry(0.32, 0.38, 0.9, 10);
  g.add(mesh(funnel, M.accent, -1.7, 2.3, 0));
  for (const x of [-1.2, 0.4]) for (const z of [0.85, -0.85]) g.add(mesh(new THREE.BoxGeometry(0.7, 0.22, 0.25), M.red, x, 1.95, z));
  return { group: g, length: 8.5, lift: 0 };
}

const BUILDERS = { flight: plane, car, train, boat };

/** A fresh model for a travel mode: { group, length }. */
export function makeVehicle(mode) {
  return (BUILDERS[mode] || plane)();
}
