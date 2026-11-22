// Trip animation: a 3D plane, car, train or ferry travels city to city — flights on great-circle
// arcs, everything else along its real road / railway / shipping-lane route — with the camera
// following. Optionally recorded to a .webm video of the sky, the globe and the overlay.
import { slerp, angle, toVec, fromVec, centroid, distanceKm } from "./geo.js";
import { MODES } from "./visits.js";
import { makeVehicle, THREE } from "./models.js";

const FLIGHT_STEPS = 72;
// Camera framing per travel mode: distance from the vehicle (globe radii) and tilt away from
// looking straight down (degrees). Ground travel is close and tilted so the models read as 3D;
// flights sit further back. Long legs pull back further; the trip ends on an overview.
const SHORT_KM = 1500;
const VIEW = {
  car:    { dist: 0.09, tilt: 45 },
  train:  { dist: 0.12, tilt: 45 },
  boat:   { dist: 0.13, tilt: 45 },
  flight: { dist: 0.32, tilt: 28 },
};
const longFlightDist = (w) => Math.min(2.0, Math.max(0.8, 0.6 + w * 1.1));
// Travel time on screen: seconds = base + km / (km per second), capped. Car ≈ boat < train < plane.
const SPEED = { car: [2, 200, 11], boat: [2, 230, 12], train: [1.8, 360, 9], flight: [1.6, 2500, 7] };
// Tile detail while playing: enough for the close follow view, capped to avoid load stutter.
const PLAY_TILE_LEVEL_CLOSE = 6, PLAY_TILE_LEVEL_FAR = 3;
// On-screen length of each vehicle model, in CSS pixels, whatever the zoom.
const VEHICLE_PX = { flight: 56, car: 34, train: 72, boat: 54 };
const GROUND_ALT = 0.0005;                     // ground routes sit on the surface
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const clamp01 = (t) => Math.min(1, Math.max(0, t));
const easeOut = (t) => 1 - (1 - t) ** 3;
const easeOutBack = (t) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;   // slight overshoot "pop"
// Arrival / departure timing (ms)
const TAKEOFF_MS = 350, LAND_MS = 380, POP_MS = 480, PULSE_MS = 1300;

/** Resample a [[lat, lng], ...] route into `n` evenly spaced [lat, lng, alt] points. */
function resample(route, n, alt) {
  const cum = [0];
  for (let i = 1; i < route.length; i++) {
    cum.push(cum[i - 1] + distanceKm(route[i - 1][0], route[i - 1][1], route[i][0], route[i][1]));
  }
  const total = cum[cum.length - 1] || 1, out = [];
  let j = 1;
  for (let k = 0; k <= n; k++) {
    const d = (k / n) * total;
    while (j < route.length - 1 && cum[j] < d) j++;
    const seg = cum[j] - cum[j - 1] || 1, t = clamp01((d - cum[j - 1]) / seg);
    const a = { lat: route[j - 1][0], lng: route[j - 1][1] }, b = { lat: route[j][0], lng: route[j][1] };
    const p = slerp(a, b, t);
    out.push([p.lat, p.lng, alt]);
  }
  return { points: out, km: total };
}

// ---- route smoothing: keep the general line of a road/railway, not every bend -------------

/** Make longitudes continuous (no ±360° jumps across the antimeridian). */
function unwrap(route) {
  const out = [[route[0][0], route[0][1]]];
  for (let i = 1; i < route.length; i++) {
    let lng = route[i][1];
    const prev = out[i - 1][1];
    while (lng - prev > 180) lng -= 360;
    while (lng - prev < -180) lng += 360;
    out.push([route[i][0], lng]);
  }
  return out;
}

/** Douglas–Peucker simplification with a tolerance in km. */
function simplify(pts, tolKm) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const k = Math.cos(((pts[a][0] + pts[b][0]) / 2) * Math.PI / 180) * 111.32;
    const ax = pts[a][1] * k, ay = pts[a][0] * 110.57, bx = pts[b][1] * k, by = pts[b][0] * 110.57;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-9;
    let worst = -1, worstD = tolKm;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][1] * k, py = pts[i][0] * 110.57;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > worstD) { worstD = d; worst = i; }
    }
    if (worst > 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Chaikin corner cutting: rounds the remaining corners into gentle curves. */
function chaikin(pts, iterations = 3) {
  for (let n = 0; n < iterations; n++) {
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [a, b] = [pts[i], pts[i + 1]];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

function smoothRoute(route) {
  const pts = unwrap(route);
  let km = 0;
  for (let i = 1; i < pts.length; i++) km += distanceKm(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  const tol = Math.min(25, Math.max(1.5, km / 250));
  return chaikin(simplify(pts, tol)).map(([lat, lng]) => [lat, ((lng + 540) % 360) - 180]);
}

function legPath(leg) {
  const a = leg.from, b = leg.to;
  const w = angle(a.lat, a.lng, b.lat, b.lng);
  let points, km = w * 6371;
  if (leg.mode === "flight" || !leg.route) {
    // flights (and ground legs with no known route) follow the great circle;
    // flights stay inside the atmosphere: at most 0.09 globe radii up, lower for short hops
    const peak = leg.mode === "flight" ? Math.min(0.09, Math.max(0.012, w * 0.06)) : GROUND_ALT;
    points = [];
    for (let i = 0; i <= FLIGHT_STEPS; i++) {
      const t = i / FLIGHT_STEPS, p = slerp(a, b, t);
      points.push([p.lat, p.lng, leg.mode === "flight" ? peak * Math.sin(Math.PI * t) : peak]);
    }
  } else {
    const r = resample(smoothRoute(leg.route), 500, GROUND_ALT);
    points = r.points; km = r.km;
  }
  const [base, kmPerSec, cap] = SPEED[leg.mode] || SPEED.flight;
  const short = w * 6371 <= SHORT_KM;
  const view = VIEW[leg.mode] || VIEW.flight;
  // how far back the camera sits: per mode, further for long legs so the motion stays readable
  const dist = leg.mode === "flight"
    ? (short ? view.dist : longFlightDist(w))
    : Math.max(view.dist, Math.min(1.2, km / 20000));
  const tilt = leg.mode === "flight" && !short ? 15 : view.tilt;
  return { points, w, km, short, dist, tilt, duration: Math.min(cap, base + km / kmPerSec) * 1000 };
}

/** Point at fraction t along a polyline of [lat, lng, alt] samples. */
function along(points, t) {
  const f = Math.min(points.length - 1.0001, Math.max(0, t * (points.length - 1)));
  const i = Math.floor(f), k = f - i, p = points[i], q = points[i + 1];
  let dl = q[1] - p[1];
  if (dl > 180) dl -= 360; else if (dl < -180) dl += 360;
  return [p[0] + (q[0] - p[0]) * k, p[1] + dl * k, p[2] + (q[2] - p[2]) * k];
}

export class Player {
  constructor(globeApi, overlay) {
    this.g = globeApi; this.overlay = overlay; this.playing = false;
    this.routes = [];            // finished routes, kept on screen after playback until cleared
    this.models = {};            // one 3D model per travel mode, created on first use
    // keep the finished routes glued to the globe as the camera moves
    globeApi.onCamera(() => { if (!this.playing) this.drawOverlay([], ""); });
  }

  stop() { this.cancelled = true; }

  /**
   * @param legs   [{from, to, mode, route?}] in travel order
   * @param title  caption drawn in the corner (e.g. "2025")
   * @param record when true, resolves with a webm Blob
   */
  async play(legs, { title = "", record = false } = {}) {
    if (this.playing || !legs.length) return null;
    this.playing = true; this.cancelled = false;
    const { globe } = this.g;
    const el = globe.renderer().domElement;
    const controls = globe.controls();
    const damping = controls.enableDamping;
    controls.enableDamping = false;   // leftover drag momentum would fight the scripted camera
    controls.enabled = false;
    this.g.setSpin(false);
    this.g.showMarkers(false);

    const plans = legs.map((l) => ({ ...l, ...legPath(l) }));
    // Cap tile detail for the whole playback (fewer tile loads = no stutter).
    globe.globeTileEngineMaxLevel(plans.some((p) => p.short) ? PLAY_TILE_LEVEL_CLOSE : PLAY_TILE_LEVEL_FAR);
    const done = [];
    this.routes = done;
    const cities = [plans[0].from];

    // recording: composite the sky, the WebGL canvas and the overlay into one canvas each frame
    let rec = null, recCtx = null, recorder = null, chunks = [];
    if (record) {
      rec = document.createElement("canvas");
      rec.width = el.width; rec.height = el.height;
      recCtx = rec.getContext("2d");
      const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
        .find((m) => MediaRecorder.isTypeSupported(m));
      recorder = new MediaRecorder(rec.captureStream(30), { mimeType: mime, videoBitsPerSecond: 8e6 });
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.start(250);
    }

    // One continuous chase camera. Each frame it eases toward a target: the point it looks at,
    // its distance, its tilt and its heading (it sits behind the vehicle, looking ahead).
    // globe.gl's own loop is paused meanwhile so it can't re-aim the camera at the globe's centre.
    globe.pauseAnimation();
    const camera = globe.camera();
    const pov0 = globe.pointOfView();
    const vec = (o) => [o.x, o.y, o.z];
    const northAt = (n) => { const pole = norm(vec(globe.getCoords(90, 0, 0)));
      const d = dot(pole, n); return norm([pole[0] - n[0] * d, pole[1] - n[1] * d, pole[2] - n[2] * d]); };
    const cam = { v: toVec(pov0.lat, pov0.lng), alt: pov0.altitude, tilt: 0,
                  h: northAt(norm(vec(globe.getCoords(pov0.lat, pov0.lng, 0)))) };
    let target = { lat: pov0.lat, lng: pov0.lng, alt: pov0.altitude, tilt: 0, h: null }, lastT = performance.now();
    let tauPos = 0.6;          // how tightly the camera tracks its target point (s)
    const tauAlt = 0.9, tauTilt = 1.0, tauHeading = 1.1;   // framing always changes gently
    const steer = (now) => {
      const dt = Math.min(0.1, Math.max(0, (now - lastT) / 1000)); lastT = now;
      const k = (tau) => 1 - Math.exp(-dt / tau);
      const tv = toVec(target.lat, target.lng);
      cam.v = cam.v.map((c, i) => c + (tv[i] - c) * k(tauPos));
      cam.alt += (target.alt - cam.alt) * k(tauAlt);
      cam.tilt += (target.tilt - cam.tilt) * k(tauTilt);
      const c = fromVec(cam.v);
      // tell globe.gl (tile loading) where we're looking, then place the tilted camera ourselves
      globe.pointOfView({ lat: c.lat, lng: c.lng, altitude: cam.alt }, 0);
      const T = vec(globe.getCoords(c.lat, c.lng, 0)), R = Math.hypot(...T), n = T.map((x) => x / R);
      const wantH = target.h || northAt(n);
      let h = cam.h.map((x, i) => x + (wantH[i] - x) * k(tauHeading));
      const hn = dot(h, n);
      h = norm([h[0] - n[0] * hn, h[1] - n[1] * hn, h[2] - n[2] * hn]);
      cam.h = h;
      const t = cam.tilt * Math.PI / 180, D = cam.alt * R;
      const dir = n.map((x, i) => x * Math.cos(t) - h[i] * Math.sin(t));
      camera.position.set(T[0] + dir[0] * D, T[1] + dir[1] * D, T[2] + dir[2] * D);
      camera.up.set(...n.map((x, i) => x * Math.sin(t) + h[i] * Math.cos(t)));
      camera.lookAt(T[0], T[1], T[2]);
      camera.updateMatrixWorld();
      this.g.drawSky();
    };

    const frame = (draw) => new Promise((resolve) => requestAnimationFrame((now) => {
      draw(now);
      this.placeVehicle(now);
      if (this.heading) target.h = this.heading;     // the camera settles in behind the vehicle
      steer(now);
      this.sizeVehicle();                            // keep its on-screen size at the new camera distance
      // render the globe now so the WebGL frame matches the overlay drawn for this camera
      globe.renderer().render(globe.scene(), globe.camera());
      this.drawOverlay(cities, title);
      if (recCtx) {
        recCtx.drawImage(this.g.sky, 0, 0, rec.width, rec.height);
        recCtx.drawImage(el, 0, 0);
        recCtx.drawImage(this.overlay, 0, 0, rec.width, rec.height);
      }
      resolve(now);
    }));
    const hold = async (ms) => { const t0 = performance.now(); let now = t0;
      while (now - t0 < ms && !this.cancelled) now = await frame(() => {}); };

    try {
      const first = plans[0].from;
      // start already facing along the first leg
      const p0 = plans[0].points, i1 = Math.min(p0.length - 1, Math.ceil(p0.length * 0.05));
      const A0 = vec(globe.getCoords(p0[0][0], p0[0][1], 0)), A1 = vec(globe.getCoords(p0[i1][0], p0[i1][1], 0));
      const n0 = norm(A0), f0 = A1.map((x, i) => x - A0[i]), d0 = dot(f0, n0);
      target = { lat: first.lat, lng: first.lng, alt: plans[0].dist, tilt: plans[0].tilt,
                 h: norm(f0.map((x, i) => x - n0[i] * d0)) };
      this.heading = null; this.fwdSmooth = null;
      tauPos = 0.55;
      this.marks = new Map();
      this.arrive(first, performance.now());
      this.caption = `${first.name}`;
      await hold(2600);

      for (const leg of plans) {
        if (this.cancelled) break;
        const color = MODES[leg.mode]?.color || "#fff";
        tauPos = leg.mode === "flight" && !leg.short ? 0.5 : 0.25;
        // look a little way down the road when turning, so the vehicle doesn't twitch at every bend
        const lookAhead = Math.max(0.002, Math.min(0.05, 15 / Math.max(leg.km, 1)));
        this.fwdSmooth = null;
        this.caption = `${leg.from.name} → ${leg.to.name}`;
        const t0 = performance.now();
        let e = 0;
        while (e < 1 && !this.cancelled) {
          await frame((now) => {
            e = Math.min(1, (now - t0) / leg.duration);
            const k = ease(e);
            const n = Math.max(1, Math.floor(k * (leg.points.length - 1)) + 1);
            this.trail = { points: [...leg.points.slice(0, n), along(leg.points, k)], color };
            const pos = along(leg.points, k);
            target = { ...target, lat: pos[0], lng: pos[1], alt: leg.dist, tilt: leg.tilt };
            const ahead = along(leg.points, Math.min(1, k + lookAhead));
            const behind = along(leg.points, Math.max(0, k - lookAhead));
            // the vehicle grows out of the departure marker
            this.vehicle = { pos, ahead, behind, mode: leg.mode, scale: easeOut(clamp01((now - t0) / TAKEOFF_MS)) };
          });
        }
        done.push({ points: leg.points, color });
        const landedAt = performance.now();
        this.landing = this.vehicle && { ...this.vehicle, t: landedAt };
        this.vehicle = null; this.trail = null;
        cities.push(leg.to);
        this.arrive(leg.to, landedAt);
        this.caption = leg.to.name;
        await hold(1000);
        this.landing = null;
      }
      // finale: pull back to show the whole trip
      if (!this.cancelled) {
        const stops = [plans[0].from, ...plans.map((p) => p.to)];
        const c = centroid(stops);
        const spread = Math.max(...stops.map((p) => angle(c.lat, c.lng, p.lat, p.lng)));
        target = { lat: c.lat, lng: c.lng, alt: Math.min(2.6, Math.max(0.5, 0.35 + spread * 2.4)), tilt: 0, h: null };
        this.heading = null;   // level out and turn north-up again before handing back to globe.gl
        tauPos = 0.9;
        this.caption = "";
        await hold(3200);
      }
    } finally {
      // hand the camera back to globe.gl: north-up, looking at the globe's centre
      const c = fromVec(cam.v);
      camera.up.set(0, 1, 0);
      globe.pointOfView({ lat: c.lat, lng: c.lng, altitude: Math.max(cam.alt, 0.2) }, 0);
      globe.resumeAnimation();
      controls.enabled = true;
      controls.enableDamping = damping;
      globe.globeTileEngineMaxLevel(this.g.maxTileLevel);
      this.vehicle = null; this.trail = null; this.landing = null; this.caption = "";
      this.placeVehicle(performance.now());
      if (recorder) await new Promise((r) => { recorder.onstop = r; recorder.stop(); });
      this.g.showMarkers(true);
      this.g.setSpin(true);
      this.playing = false;
      this.drawOverlay([], "");
    }
    return recorder && !this.cancelled ? new Blob(chunks, { type: "video/webm" }) : null;
  }

  /** Record an arrival: a first visit pops the city's marker in; every arrival sends out a pulse. */
  arrive(city, t) {
    const m = this.marks.get(city.cityId);
    if (m) m.last = t; else this.marks.set(city.cityId, { first: t, last: t });
  }

  clearPaths() { this.routes = []; this.drawOverlay([], ""); }

  /** Position, orient and size the 3D model for the current (or landing) vehicle. */
  placeVehicle(now) {
    let v = this.vehicle;
    if (!v && this.landing) {
      const k = clamp01((now - this.landing.t) / LAND_MS);
      v = k < 1 ? { ...this.landing, scale: 1 - easeOut(k) } : null;
    }
    for (const [mode, m] of Object.entries(this.models)) m.group.visible = !!v && v.mode === mode && v.scale > 0.01;
    if (!v || v.scale <= 0.01) return;

    const { globe } = this.g;
    const m = this.models[v.mode] ||= this.addModel(v.mode);
    const P = globe.getCoords(v.pos[0], v.pos[1], v.pos[2]);
    let A = globe.getCoords(v.ahead[0], v.ahead[1], v.ahead[2]);
    let B = P;
    if (Math.hypot(A.x - P.x, A.y - P.y, A.z - P.z) < 1e-6) { A = P; B = globe.getCoords(v.behind[0], v.behind[1], v.behind[2]); }
    // local frame: up = away from the globe's centre, forward = along the route
    const up = norm([P.x, P.y, P.z]);
    let fwd = [A.x - B.x, A.y - B.y, A.z - B.z];
    const d = dot(fwd, up);
    fwd = norm([fwd[0] - up[0] * d, fwd[1] - up[1] * d, fwd[2] - up[2] * d]);
    // smooth the heading over time as well, so small kinks in the route don't jerk the model
    if (this.fwdSmooth && v.mode === this.fwdMode) {
      const a = 0.22;
      let f = this.fwdSmooth.map((x, i) => x + (fwd[i] - x) * a);
      const fd = dot(f, up);
      f = norm([f[0] - up[0] * fd, f[1] - up[1] * fd, f[2] - up[2] * fd]);
      fwd = f;
    }
    this.fwdSmooth = fwd; this.fwdMode = v.mode;
    if (this.vehicle) this.heading = fwd;
    const side = cross(fwd, up);
    const basis = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(...fwd), new THREE.Vector3(...up), new THREE.Vector3(...side));
    m.group.quaternion.setFromRotationMatrix(basis);
    m.group.position.set(P.x, P.y, P.z);
    this.shown = { m, mode: v.mode, scale: v.scale };
    this.sizeVehicle();
    m.group.visible = this.facing(v.pos[0], v.pos[1], v.pos[2]);
  }

  /** Constant on-screen size: world units per pixel at the model's distance from the camera. */
  sizeVehicle() {
    if (!this.shown?.m.group.visible) return;
    const { m, mode, scale } = this.shown, { globe } = this.g, camera = globe.camera();
    const dist = camera.position.distanceTo(m.group.position);
    const unitsPerPx = (2 * dist * Math.tan((camera.fov * Math.PI) / 360)) / globe.renderer().domElement.clientHeight;
    m.group.scale.setScalar((VEHICLE_PX[mode] * unitsPerPx / m.length) * scale);
  }

  addModel(mode) {
    const m = makeVehicle(mode);
    this.g.globe.scene().add(m.group);
    return m;
  }

  sizeOverlay() {
    const el = this.g.globe.renderer().domElement, c = this.overlay;
    if (c.width !== el.width || c.height !== el.height) { c.width = el.width; c.height = el.height; }
    return el.width / el.clientWidth;
  }

  drawOverlay(cities, title) {
    const { globe } = this.g;
    const dpr = this.sizeOverlay();
    const ctx = this.overlay.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '400 11px "Space Mono", monospace';
    ctx.textBaseline = "middle";
    const now = performance.now();

    // Routes are projected from their real positions every frame, at a fixed pixel width,
    // so they stay locked to the map at any zoom.
    const vehicleAt = this.vehicle && globe.getScreenCoords(...this.vehicle.pos);
    const gap = this.vehicle ? VEHICLE_PX[this.vehicle.mode] * 0.45 : 0;
    for (const route of [...this.routes, ...(this.trail ? [this.trail] : [])]) {
      const isTrail = route === this.trail;
      const pts = [];
      for (const [la, ln, alt] of route.points) {
        const s = this.facing(la, ln, alt) && globe.getScreenCoords(la, ln, alt);
        pts.push(s || null);
      }
      // stop the line just behind the moving vehicle so it doesn't draw over the model
      if (isTrail && vehicleAt) {
        while (pts.length && (!pts[pts.length - 1] ||
          Math.hypot(pts[pts.length - 1].x - vehicleAt.x, pts[pts.length - 1].y - vehicleAt.y) < gap)) pts.pop();
      }
      ctx.beginPath();
      let pen = false;
      for (const s of pts) {
        if (!s) { pen = false; continue; }
        if (pen) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y);
        pen = true;
      }
      // dark casing under a coloured line, so routes read on any terrain
      ctx.lineJoin = ctx.lineCap = "round";
      ctx.strokeStyle = "rgba(3,5,10,.6)"; ctx.lineWidth = 4.5; ctx.stroke();
      ctx.strokeStyle = route.color; ctx.lineWidth = 2.2; ctx.stroke();
    }

    // visited cities so far: markers pop in on first arrival and pulse on every arrival
    const seen = new Set();
    for (const c of cities) {
      if (seen.has(c.cityId)) continue; seen.add(c.cityId);
      const s = globe.getScreenCoords(c.lat, c.lng, 0);
      if (!s || !this.facing(c.lat, c.lng)) continue;
      const m = this.marks?.get(c.cityId) || { first: -1e9, last: -1e9 };
      const pop = easeOutBack(clamp01((now - m.first) / POP_MS));
      const pulse = (now - m.last) / PULSE_MS;
      if (pulse >= 0 && pulse < 1) {
        ctx.strokeStyle = `rgba(240,195,142,${0.85 * (1 - pulse)})`; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(s.x, s.y, 5 + 20 * easeOut(pulse), 0, Math.PI * 2); ctx.stroke();
      }
      ctx.fillStyle = "#f0c38e";
      ctx.beginPath(); ctx.arc(s.x, s.y, 4 * Math.max(0, pop), 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = clamp01((now - m.first) / POP_MS);
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(3,5,10,.75)"; ctx.fillStyle = "#e8e4dc";
      ctx.strokeText(c.name, s.x + 8, s.y); ctx.fillText(c.name, s.x + 8, s.y);
      ctx.globalAlpha = 1;
    }

    // captions, bottom left (clear of the page's top bar)
    const H = this.overlay.height / dpr;
    ctx.textAlign = "left";
    ctx.lineWidth = 4; ctx.strokeStyle = "rgba(3,5,10,.6)"; ctx.fillStyle = "#e8e4dc";
    if (title) {
      ctx.font = '500 13px "Space Grotesk", sans-serif';
      const t = title.toUpperCase().split("").join(" ");
      ctx.strokeText(t, 24, H - 58); ctx.fillText(t, 24, H - 58);
    }
    if (this.caption) {
      ctx.font = '400 20px "Space Grotesk", sans-serif';
      ctx.strokeText(this.caption, 24, H - 32); ctx.fillText(this.caption, 24, H - 32);
    }
  }

  /** Is this point (at `alt` globe radii up) on the side of the globe facing the camera? */
  facing(lat, lng, alt = 0) {
    const { globe } = this.g;
    const pov = globe.pointOfView();
    const camR = 1 + pov.altitude, r = 1 + alt;
    // visible if the point lies in front of the horizon as seen from the camera…
    if (Math.cos(angle(lat, lng, pov.lat, pov.lng)) * r * camR <= 1) return false;
    // …and in front of the camera, not behind it (the chase camera is tilted)
    const p = globe.getCoords(lat, lng, alt);
    return TMP.set(p.x, p.y, p.z).applyMatrix4(globe.camera().matrixWorldInverse).z < 0;
  }
}

const TMP = new THREE.Vector3();
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const n = Math.hypot(...a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };
