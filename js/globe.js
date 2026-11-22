// The Earth globe (globe.gl, loaded as a global from the CDN), its slow spin, and the city markers.
import { cluster } from "./cluster.js";
import { countryName } from "./cities.js";

const TEX = "https://cdn.jsdelivr.net/npm/three-globe@2.45.6/example/img/";
// Esri World Imagery: satellite tiles that load in at higher detail as you zoom in.
const TILE = (x, y, level) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${level}/${y}/${x}`;
const MAX_TILE_LEVEL = 18;
const IDLE_RESUME_MS = 5000;
const SKY_PX_PER_DEG = 0.5; // the star background drifts only slightly as the globe turns
const SPIN_FEEL = 0.6;   // drag-to-spin speed relative to globe.gl's default
const ZOOM_FEEL = 1.8;   // wheel/pinch zoom speed relative to globe.gl's default

export function createGlobe(el, { onPlaceClick, sky }) {
  const globe = new Globe(el, { rendererConfig: { preserveDrawingBuffer: true, antialias: true, alpha: true } })
    .globeTileEngineUrl(TILE)
    .globeTileEngineMaxLevel(MAX_TILE_LEVEL)
    .backgroundColor("rgba(0,0,0,0)")   // stars are drawn on a separate, nearly still canvas behind
    .showAtmosphere(true)
    .atmosphereColor("#8fb4e0")
    .atmosphereAltitude(0.15)
    .htmlTransitionDuration(0)
    .htmlAltitude(0)            // markers sit on the surface, so they stay put at any viewing angle
    .htmlElement(markerEl)
    .pathPoints("points")
    .pathPointLat((p) => p[0]).pathPointLng((p) => p[1]).pathPointAlt((p) => p[2])
    .pathColor((d) => d.color)
    .pathStroke(1.6)
    .pathTransitionDuration(0);

  const controls = globe.controls();
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.35;
  controls.enableDamping = true;
  controls.minDistance = 100.3; // globe radius is 100: close enough for street-level tiles
  controls.maxDistance = 380;   // the starting view is fully zoomed out

  // globe.gl re-tunes spin and zoom speed to the altitude on every camera change; scale its values
  // (this listener is added after globe.gl's own, so it runs second)
  const tune = () => { controls.rotateSpeed *= SPIN_FEEL; controls.zoomSpeed *= ZOOM_FEEL; };
  controls.addEventListener("change", tune);

  // Scrolling: wheel zooms the globe, but once it is fully zoomed out (or the page is already
  // scrolled) the wheel scrolls the page instead, pulling the travel log up over the globe.
  el.addEventListener("wheel", (e) => {
    const zoomedOut = controls.getDistance() >= controls.maxDistance - 0.5;
    if (window.scrollY > 0 || (e.deltaY > 0 && zoomedOut)) e.stopPropagation();
  }, { capture: true, passive: true });

  let idleTimer = null, spinAllowed = true;
  controls.addEventListener("start", () => { controls.autoRotate = false; clearTimeout(idleTimer); });
  controls.addEventListener("end", () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (spinAllowed) controls.autoRotate = true; }, IDLE_RESUME_MS);
  });

  const fit = () => globe.width(el.clientWidth).height(el.clientHeight);
  new ResizeObserver(fit).observe(el);
  fit();
  globe.pointOfView({ lat: 25, lng: 10, altitude: 2.8 });

  // ---- markers: re-cluster whenever the zoom level changes enough to matter ----
  let places = [], lastAlt = null, lastKeys = "", markersOn = true;

  function render(force = false) {
    const alt = globe.pointOfView().altitude;
    if (!force && lastAlt !== null && Math.abs(Math.log(alt / lastAlt)) < 0.08) return;
    lastAlt = alt;
    const groups = markersOn ? cluster(places, alt) : [];
    const keys = groups.map((g) => g.key).join("|");
    if (!force && keys === lastKeys) return;
    lastKeys = keys;
    globe.htmlElementsData(groups);
  }

  function markerEl(group) {
    const el = document.createElement("button");
    el.type = "button";
    if (group.members.length === 1) {
      const p = group.members[0];
      el.className = "poi";
      el.innerHTML = `<span class="dot"></span><span class="label"></span>`;
      el.querySelector(".label").textContent = p.name;
      el.title = `${p.name}, ${countryName(p.cc)} · ${p.visits.length} visit${p.visits.length > 1 ? "s" : ""}`;
      el.onclick = (e) => { e.stopPropagation(); onPlaceClick(p); };
    } else {
      el.className = "poi cluster";
      el.textContent = group.members.length;
      el.title = group.members.map((m) => m.name).join(", ");
      el.onclick = (e) => {
        e.stopPropagation();
        const alt = globe.pointOfView().altitude;
        globe.pointOfView({ lat: group.lat, lng: group.lng, altitude: Math.max(0.15, alt * 0.4) }, 900);
      };
    }
    // let drags that start on a marker still spin the globe
    el.style.pointerEvents = "auto";
    return el;
  }

  // ---- star background: its own canvas behind the globe, drifting at a fraction of the spin ----
  const stars = new Image();
  stars.crossOrigin = "anonymous";       // keeps the canvas usable for video recording
  stars.onload = () => drawSky();
  stars.src = TEX + "night-sky.png";
  function drawSky() {
    if (!stars.complete || !stars.naturalWidth) return;
    const dpr = devicePixelRatio || 1, W = sky.clientWidth * dpr, H = sky.clientHeight * dpr;
    if (sky.width !== W || sky.height !== H) { sky.width = W; sky.height = H; }
    const ctx = sky.getContext("2d");
    const scale = Math.max(H / stars.naturalHeight, 1) * 1.2;
    const tw = stars.naturalWidth * scale, th = stars.naturalHeight * scale;
    const pov = globe.pointOfView();
    const shift = ((pov.lng * SKY_PX_PER_DEG * dpr) % tw + tw) % tw;
    const y = (H - th) / 2 + pov.lat * SKY_PX_PER_DEG * dpr * 0.5;
    ctx.fillStyle = "#03050a"; ctx.fillRect(0, 0, W, H);
    for (let x = -shift; x < W; x += tw) ctx.drawImage(stars, x, y, tw, th);
  }
  new ResizeObserver(drawSky).observe(sky);

  const cameraListeners = [];
  globe.onZoom(() => { render(); drawSky(); cameraListeners.forEach((fn) => fn()); });
  new ResizeObserver(() => cameraListeners.forEach((fn) => fn())).observe(el);

  return {
    globe,
    sky,
    maxTileLevel: MAX_TILE_LEVEL,
    setPlaces(next) { places = next; render(true); },
    onCamera(fn) { cameraListeners.push(fn); },
    showMarkers(on) { markersOn = on; render(true); },
    setSpin(on) { spinAllowed = on; controls.autoRotate = on; clearTimeout(idleTimer); },
    flyTo(lat, lng, altitude = 0.8, ms = 1200) {
      controls.autoRotate = false;
      clearTimeout(idleTimer);
      globe.pointOfView({ lat, lng, altitude }, ms);
      idleTimer = setTimeout(() => { if (spinAllowed) controls.autoRotate = true; }, ms + IDLE_RESUME_MS);
    },
    canvas: () => globe.renderer().domElement,
  };
}
