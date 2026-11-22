// Trip animation: a plane (or train, car, boat) travels city to city along great-circle paths,
// with the camera following. Optionally recorded to a .webm video of the globe + overlay.
import { slerp, angle } from "./geo.js";
import { MODES } from "./visits.js";

const PATH_STEPS = 72;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

function legPath(leg) {
  const a = leg.from, b = leg.to;
  const w = angle(a.lat, a.lng, b.lat, b.lng);
  const peak = leg.mode === "flight" ? Math.min(0.25, Math.max(0.03, w * 0.18)) : 0.004;
  const points = [];
  for (let i = 0; i <= PATH_STEPS; i++) {
    const t = i / PATH_STEPS, p = slerp(a, b, t);
    points.push([p.lat, p.lng, leg.mode === "flight" ? peak * Math.sin(Math.PI * t) : peak]);
  }
  const km = w * 6371;
  return { points, w, duration: Math.min(6, Math.max(2.2, 1.6 + km / 2500)) * 1000 };
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
    this.g.setSpin(false);
    this.g.showMarkers(false);

    const plans = legs.map((l) => ({ ...l, ...legPath(l) }));
    const done = [];        // finished path objects shown on the globe
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

    const frame = (draw) => new Promise((resolve) => requestAnimationFrame((now) => {
      draw(now);
      // render the globe now so the WebGL frame matches the overlay drawn for this camera
      globe.renderer().render(globe.scene(), globe.camera());
      this.drawOverlay(cities, title);
      if (recCtx) { recCtx.drawImage(el, 0, 0); recCtx.drawImage(this.overlay, 0, 0, rec.width, rec.height); }
      resolve(now);
    }));
    const hold = async (ms, extra) => { const t0 = performance.now(); let now = t0;
      while (now - t0 < ms && !this.cancelled) now = await frame(() => extra?.()); };

    try {
      const first = plans[0].from;
      globe.pointOfView({ lat: first.lat, lng: first.lng, altitude: 1.6 }, 1200);
      this.caption = `${first.name}`;
      await hold(1500);

      for (const leg of plans) {
        if (this.cancelled) break;
        const color = MODES[leg.mode]?.color || "#fff";
        const camAlt = Math.min(2.2, Math.max(0.9, leg.w * 1.4));
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
            const cam = slerp(leg.from, leg.to, k);
            // look from a little to the side of the route so a long arc reads as a curve, not a line
            const side = Math.min(14, leg.w * 15) * Math.sin(Math.PI * k);
            const camLat = cam.lat > 50 ? cam.lat + side : cam.lat - side;
            globe.pointOfView({ lat: Math.max(-80, Math.min(80, camLat)), lng: cam.lng,
                                altitude: camAlt + 0.25 * Math.sin(Math.PI * k) }, 0);
            const ahead = along(leg.points, Math.min(1, k + 0.02));
            this.vehicle = { pos, ahead, mode: leg.mode };
          });
        }
        done.push({ points: leg.points.map((p) => [...p]), color });
        globe.pathsData([...done]);
        this.vehicle = null; this.trail = null;
        cities.push(leg.to);
        this.caption = leg.to.name;
        await hold(900);
      }
      await hold(800);
    } finally {
      this.vehicle = null; this.trail = null; this.caption = "";
      this.clearOverlay();
      if (recorder) await new Promise((r) => { recorder.onstop = r; recorder.stop(); });
      this.g.showMarkers(true);
      this.g.setSpin(true);
      this.playing = false;
    }
    return recorder && !this.cancelled ? new Blob(chunks, { type: "video/webm" }) : null;
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
    ctx.font = "600 13px system-ui, -apple-system, sans-serif";
    ctx.textBaseline = "middle";

    // visited cities so far
    const seen = new Set();
    for (const c of cities) {
      if (seen.has(c.cityId)) continue; seen.add(c.cityId);
      const s = globe.getScreenCoords(c.lat, c.lng, 0.01);
      if (!s || !this.facing(c.lat, c.lng)) continue;
      ctx.fillStyle = "#ffd166";
      ctx.beginPath(); ctx.arc(s.x, s.y, 4, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,.65)"; ctx.fillStyle = "#fff";
      ctx.strokeText(c.name, s.x + 8, s.y); ctx.fillText(c.name, s.x + 8, s.y);
    }

    // the leg in progress
    if (this.trail) {
      ctx.strokeStyle = this.trail.color; ctx.lineWidth = 2.2; ctx.lineJoin = ctx.lineCap = "round";
      ctx.beginPath();
      let pen = false;
      for (const [la, ln, alt] of this.trail.points) {
        const s = this.facing(la, ln, alt) && globe.getScreenCoords(la, ln, alt);
        if (!s) { pen = false; continue; }
        if (pen) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y);
        pen = true;
      }
      ctx.stroke();
    }

    // the vehicle
    if (this.vehicle) {
      const { pos, ahead, mode } = this.vehicle;
      const s = globe.getScreenCoords(pos[0], pos[1], pos[2]);
      const s2 = globe.getScreenCoords(ahead[0], ahead[1], ahead[2]);
      if (s) {
        ctx.save(); ctx.translate(s.x, s.y);
        if (mode === "flight") {
          ctx.rotate(Math.atan2(s2.y - s.y, s2.x - s.x));
          drawPlane(ctx);
        } else {
          ctx.font = "20px system-ui, sans-serif"; ctx.textAlign = "center";
          ctx.fillText(MODES[mode].icon, 0, 0);
        }
        ctx.restore();
      }
    }

    // captions
    ctx.textAlign = "left";
    ctx.font = "700 22px system-ui, -apple-system, sans-serif";
    ctx.lineWidth = 4; ctx.strokeStyle = "rgba(0,0,0,.6)"; ctx.fillStyle = "#fff";
    if (title) { ctx.strokeText(title, 20, 32); ctx.fillText(title, 20, 32); }
    if (this.caption) {
      ctx.font = "600 16px system-ui, -apple-system, sans-serif";
      ctx.strokeText(this.caption, 20, 60); ctx.fillText(this.caption, 20, 60);
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
  ctx.fillStyle = "#fff"; ctx.strokeStyle = "rgba(0,0,0,.6)"; ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(13, 0); ctx.lineTo(9, -1.8); ctx.lineTo(2, -2); ctx.lineTo(-3, -11); ctx.lineTo(-6, -11);
  ctx.lineTo(-3, -2); ctx.lineTo(-9, -2); ctx.lineTo(-12, -6); ctx.lineTo(-14, -6); ctx.lineTo(-12, 0);
  ctx.lineTo(-14, 6); ctx.lineTo(-12, 6); ctx.lineTo(-9, 2); ctx.lineTo(-3, 2); ctx.lineTo(-6, 11);
  ctx.lineTo(-3, 11); ctx.lineTo(2, 2); ctx.lineTo(9, 1.8); ctx.closePath();
  ctx.fill(); ctx.stroke();
}
