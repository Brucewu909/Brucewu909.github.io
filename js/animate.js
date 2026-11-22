// Trip animation: a plane (or train, car, boat) travels city to city along great-circle paths,
// with the camera following. Optionally recorded to a .webm video of the globe + overlay.
import { slerp, angle, toVec, fromVec, centroid } from "./geo.js";
import { MODES } from "./visits.js";

const PATH_STEPS = 72;
// Camera framing. Short legs (e.g. within Europe) are followed closely at one steady height;
// long legs pull back so both ends fit; the trip ends on a view of every place visited.
const SHORT_KM = 1500;
const FOLLOW_ALT = 0.35;                       // globe radii above the surface
const longAlt = (w) => Math.min(2.0, Math.max(0.8, 0.6 + w * 1.1));
// Tile detail while playing: enough for the close follow view, capped to avoid load stutter.
const PLAY_TILE_LEVEL_CLOSE = 4, PLAY_TILE_LEVEL_FAR = 3;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const clamp01 = (t) => Math.min(1, Math.max(0, t));
const easeOut = (t) => 1 - (1 - t) ** 3;
const easeOutBack = (t) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;   // slight overshoot "pop"
// Arrival / departure timing (ms)
const TAKEOFF_MS = 350, LAND_MS = 380, POP_MS = 480, PULSE_MS = 1300;

function legPath(leg) {
  const a = leg.from, b = leg.to;
  const w = angle(a.lat, a.lng, b.lat, b.lng);
  // flights stay inside the atmosphere (0.15 globe radii): at most 0.09 up, lower for short hops
  const peak = leg.mode === "flight" ? Math.min(0.09, Math.max(0.012, w * 0.06)) : 0.002;
  const points = [];
  for (let i = 0; i <= PATH_STEPS; i++) {
    const t = i / PATH_STEPS, p = slerp(a, b, t);
    points.push([p.lat, p.lng, leg.mode === "flight" ? peak * Math.sin(Math.PI * t) : peak]);
  }
  const km = w * 6371;
  return { points, w, short: km <= SHORT_KM, duration: Math.min(6, Math.max(2.4, 1.6 + km / 2500)) * 1000 };
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
  }

  stop() { this.cancelled = true; }

  /**
   * @param legs   [{from, to, mode}] in travel order
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
    const done = [];        // finished path objects shown on the globe
    globe.pathsData([]);    // clear routes from an earlier playback before the camera starts moving
    const cities = [plans[0].from];

    // recording: composite the WebGL canvas and the overlay into one canvas each frame
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
    const hold = async (ms, extra) => { const t0 = performance.now(); let now = t0;
      while (now - t0 < ms && !this.cancelled) now = await frame(() => extra?.()); };

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
        // long legs: look from a little to one side (fixed per leg) so the arc reads as a curve
        const mid = slerp(leg.from, leg.to, 0.5);
        const sideSign = mid.lat > 50 ? 1 : -1;
        this.caption = `${leg.from.name} → ${leg.to.name}`;
        const t0 = performance.now();
        let e = 0;
        while (e < 1 && !this.cancelled) {
          await frame((now) => {
            e = Math.min(1, (now - t0) / leg.duration);
            const k = ease(e);
            // the leg in progress is drawn on the overlay, in step with the vehicle
            const n = Math.max(1, Math.floor(k * PATH_STEPS) + 1);
            this.trail = { points: [...leg.points.slice(0, n), along(leg.points, k)], color };
            const pos = along(leg.points, k);
            if (leg.short) {
              // follow the vehicle itself at a steady height
              target = { lat: pos[0], lng: pos[1], alt: camAlt };
            } else {
              const c = slerp(leg.from, leg.to, k);
              const side = sideSign * Math.min(10, leg.w * 12) * Math.sin(Math.PI * k);
              target = { lat: Math.max(-80, Math.min(80, c.lat + side)), lng: c.lng, alt: camAlt };
            }
            const ahead = along(leg.points, Math.min(1, k + 0.02));
            const behind = along(leg.points, Math.max(0, k - 0.02));
            // the vehicle grows out of the departure marker
            this.vehicle = { pos, ahead, behind, mode: leg.mode, scale: easeOut(clamp01((now - t0) / TAKEOFF_MS)) };
          });
        }
        // finished legs stay on the overlay while playing (rebuilding globe geometry mid-flight stutters)
        done.push({ points: leg.points.map((p) => [...p]), color });
        this.finished = done;
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
      this.finished = null;
      globe.pathsData(done);   // hand the routes to the globe once playback is over
      controls.enabled = true;
      controls.enableDamping = damping;
      globe.globeTileEngineMaxLevel(this.g.maxTileLevel);
      this.vehicle = null; this.trail = null; this.landing = null; this.caption = "";
      this.clearOverlay();
      if (recorder) await new Promise((r) => { recorder.onstop = r; recorder.stop(); });
      this.g.showMarkers(true);
      this.g.setSpin(true);
      this.playing = false;
    }
    return recorder && !this.cancelled ? new Blob(chunks, { type: "video/webm" }) : null;
  }

  /** Record an arrival: a first visit pops the city's marker in; every arrival sends out a pulse. */
  arrive(city, t) {
    const m = this.marks.get(city.cityId);
    if (m) m.last = t; else this.marks.set(city.cityId, { first: t, last: t });
  }

  clearPaths() { this.g.globe.pathsData([]); }

  sizeOverlay() {
    const el = this.g.globe.renderer().domElement, c = this.overlay;
    if (c.width !== el.width || c.height !== el.height) { c.width = el.width; c.height = el.height; }
    return el.width / el.clientWidth;
  }

  clearOverlay() {
    const c = this.overlay;
    c.getContext("2d").clearRect(0, 0, c.width, c.height);
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

    // routes: finished legs, then the leg in progress
    for (const route of [...(this.finished || []), ...(this.trail ? [this.trail] : [])]) {
      ctx.strokeStyle = route.color; ctx.lineWidth = 2; ctx.lineJoin = ctx.lineCap = "round";
      ctx.beginPath();
      let pen = false;
      for (const [la, ln, alt] of route.points) {
        const s = this.facing(la, ln, alt) && globe.getScreenCoords(la, ln, alt);
        if (!s) { pen = false; continue; }
        if (pen) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y);
        pen = true;
      }
      ctx.stroke();
    }

    // visited cities so far: markers pop in on first arrival and pulse on every arrival
    const seen = new Set();
    for (const c of cities) {
      if (seen.has(c.cityId)) continue; seen.add(c.cityId);
      const s = globe.getScreenCoords(c.lat, c.lng, 0.01);
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

    // the vehicle: in flight, or shrinking into the marker it just reached
    let v = this.vehicle;
    if (!v && this.landing) {
      const k = clamp01((now - this.landing.t) / LAND_MS);
      v = k < 1 ? { ...this.landing, scale: 1 - easeOut(k) } : null;
    }
    if (v && v.scale > 0.01) {
      const { pos, ahead, behind, mode } = v;
      const s = globe.getScreenCoords(pos[0], pos[1], pos[2]);
      const s2 = globe.getScreenCoords(ahead[0], ahead[1], ahead[2]);
      const s0 = globe.getScreenCoords(behind[0], behind[1], behind[2]);
      if (s) {
        ctx.save(); ctx.translate(s.x, s.y); ctx.scale(v.scale, v.scale);
        ctx.globalAlpha = Math.min(1, v.scale * 1.5);
        if (mode === "flight") {
          // heading from the path just ahead, or just behind at the very end of the leg
          const [ax, ay] = Math.hypot(s2.x - s.x, s2.y - s.y) > 0.5 ? [s2.x - s.x, s2.y - s.y] : [s.x - s0.x, s.y - s0.y];
          ctx.rotate(Math.atan2(ay, ax));
          drawPlane(ctx);
        } else {
          // ground travel: a ringed marker in the mode's colour
          ctx.fillStyle = "#03050a"; ctx.strokeStyle = MODES[mode].color; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          ctx.fillStyle = MODES[mode].color;
          ctx.beginPath(); ctx.arc(0, 0, 2.5, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
      }
    }

    // captions, bottom left (clear of the page's top bar)
    const H = this.overlay.height / dpr;
    ctx.textAlign = "left";
    ctx.lineWidth = 4; ctx.strokeStyle = "rgba(3,5,10,.6)"; ctx.fillStyle = "#e8e4dc";
    if (title) {
      ctx.font = '500 13px "Space Grotesk", sans-serif';
      const t = title.toUpperCase().split("").join(" ");
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

function drawPlane(ctx) {
  // simple top-down airliner pointing along +x
  ctx.fillStyle = "#e8e4dc"; ctx.strokeStyle = "rgba(3,5,10,.7)"; ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(13, 0); ctx.lineTo(9, -1.8); ctx.lineTo(2, -2); ctx.lineTo(-3, -11); ctx.lineTo(-6, -11);
  ctx.lineTo(-3, -2); ctx.lineTo(-9, -2); ctx.lineTo(-12, -6); ctx.lineTo(-14, -6); ctx.lineTo(-12, 0);
  ctx.lineTo(-14, 6); ctx.lineTo(-12, 6); ctx.lineTo(-9, 2); ctx.lineTo(-3, 2); ctx.lineTo(-6, 11);
  ctx.lineTo(-3, 11); ctx.lineTo(2, 2); ctx.lineTo(9, 1.8); ctx.closePath();
  ctx.fill(); ctx.stroke();
}
