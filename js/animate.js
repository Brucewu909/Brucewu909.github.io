// Trip animation: a 3D plane, car, train or ferry travels city to city — flights on great-circle
// arcs, everything else along its real road / railway / shipping-lane route — with the camera
// following. Optionally recorded to a .webm video of the sky, the globe and the overlay.
import { slerp, angle, toVec, fromVec, centroid, distanceKm } from "./geo.js";
import { MODES } from "./visits.js";
import { makeVehicle, THREE } from "./models.js";

const FLIGHT_STEPS = 72;
// Camera framing. Short legs (e.g. within Europe) are followed closely at one steady height;
// long legs pull back; the trip ends on a view of every place visited.
const SHORT_KM = 1500;
const FOLLOW_ALT = 0.35;                       // globe radii above the surface
const longAlt = (w) => Math.min(2.0, Math.max(0.8, 0.6 + w * 1.1));
// Tile detail while playing: enough for the close follow view, capped to avoid load stutter.
const PLAY_TILE_LEVEL_CLOSE = 4, PLAY_TILE_LEVEL_FAR = 3;
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
    const r = resample(leg.route, Math.min(700, Math.max(80, Math.round(leg.route.length * 1.5))), GROUND_ALT);
    points = r.points; km = r.km;
  }
  return { points, w, short: w * 6371 <= SHORT_KM, duration: Math.min(7, Math.max(2.4, 1.6 + km / 2500)) * 1000 };
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

    // One continuous camera: each frame it eases toward a target (exponential smoothing on the
    // sphere), so changes of leg, altitude or framing glide instead of jumping.
    const pov0 = globe.pointOfView();
    const cam = { v: toVec(pov0.lat, pov0.lng), alt: pov0.altitude };
    let target = { lat: pov0.lat, lng: pov0.lng, alt: pov0.altitude }, lastT = performance.now();
    let tauPos = 0.6;          // how tightly the camera tracks its target position (s)
    const tauAlt = 0.9;        // height always changes gently
    const steer = (now) => {
      const dt = Math.min(0.1, Math.max(0, (now - lastT) / 1000)); lastT = now;
      const a = 1 - Math.exp(-dt / tauPos), b = 1 - Math.exp(-dt / tauAlt);
      const tv = toVec(target.lat, target.lng);
      cam.v = cam.v.map((c, i) => c + (tv[i] - c) * a);
      cam.alt += (target.alt - cam.alt) * b;
      const p = fromVec(cam.v);
      globe.pointOfView({ lat: p.lat, lng: p.lng, altitude: cam.alt }, 0);
    };
    const legAlt = (leg) => (leg.short ? FOLLOW_ALT : longAlt(leg.w));

    const frame = (draw) => new Promise((resolve) => requestAnimationFrame((now) => {
      draw(now);
      steer(now);
      this.placeVehicle(now);
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
      target = { lat: first.lat, lng: first.lng, alt: legAlt(plans[0]) };
      tauPos = 0.55;
      this.marks = new Map();
      this.arrive(first, performance.now());
      this.caption = `${first.name}`;
      await hold(2600);

      for (const leg of plans) {
        if (this.cancelled) break;
        const color = MODES[leg.mode]?.color || "#fff";
        const camAlt = legAlt(leg);
        tauPos = leg.short ? 0.3 : 0.5;
        // long flights: look from a little to one side (fixed per leg) so the arc reads as a curve
        const mid = slerp(leg.from, leg.to, 0.5);
        const sideSign = mid.lat > 50 ? 1 : -1;
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
            if (leg.short || leg.mode !== "flight") {
              // follow the vehicle itself (ground routes bend, so the straight midpoint is no use)
              target = { lat: pos[0], lng: pos[1], alt: camAlt };
            } else {
              const c = slerp(leg.from, leg.to, k);
              const side = sideSign * Math.min(10, leg.w * 12) * Math.sin(Math.PI * k);
              target = { lat: Math.max(-80, Math.min(80, c.lat + side)), lng: c.lng, alt: camAlt };
            }
            const ahead = along(leg.points, Math.min(1, k + 0.004));
            const behind = along(leg.points, Math.max(0, k - 0.004));
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
        target = { lat: c.lat, lng: c.lng, alt: Math.min(2.6, Math.max(0.5, 0.35 + spread * 2.4)) };
        tauPos = 0.9;
        this.caption = "";
        await hold(3200);
      }
    } finally {
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
    const side = cross(fwd, up);
    const basis = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(...fwd), new THREE.Vector3(...up), new THREE.Vector3(...side));
    m.group.quaternion.setFromRotationMatrix(basis);
    m.group.position.set(P.x, P.y, P.z);
    // constant on-screen size: world units per pixel at this distance from the camera
    const camera = globe.camera();
    const dist = camera.position.distanceTo(m.group.position);
    const unitsPerPx = (2 * dist * Math.tan((camera.fov * Math.PI) / 360)) / globe.renderer().domElement.clientHeight;
    const s = (VEHICLE_PX[v.mode] * unitsPerPx / m.length) * v.scale;
    m.group.scale.setScalar(s);
    m.group.visible = this.facing(v.pos[0], v.pos[1], v.pos[2]);
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
    const pov = this.g.globe.pointOfView();
    const camR = 1 + pov.altitude, r = 1 + alt;
    // visible if the point lies in front of the horizon as seen from the camera
    return Math.cos(angle(lat, lng, pov.lat, pov.lng)) * r * camR > 1;
  }
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const n = Math.hypot(...a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };
