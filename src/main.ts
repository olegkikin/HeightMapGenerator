import * as L from 'leaflet';
import { fetchElevation, type BBox, type ElevationGrid } from './terrain';
import { outputHeight, renderComposite, renderToCanvas, resample, downloadCanvas } from './render';
import type { RampName } from './ramps';

// ---------------------------------------------------------------- map setup
const map = L.map('map', { center: [39.5, -98.35], zoom: 4 }); // geographic centre of the US
// Basemap: standard OSM style served by the OpenStreetMap Deutschland
// mirror (tile.openstreetmap.de), free, no key. Do NOT use
// tile.openstreetmap.org directly: its tile usage policy answers app
// requests with an HTTP-200 placeholder PNG that says "Access blocked"
// (verified from the tile bytes, not the status code). CARTO basemaps
// are not a fallback either: keyless requests now get an
// "API KEY REQUIRED" placeholder tile (also verified from the bytes).
// If the mirror ever fails outright, fall back once to Esri World
// Street Map so the map is never left blank.
const ESRI_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}';
const basemap = L.tileLayer('https://tile.openstreetmap.de/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
});
let tilesLoaded = 0;
let tileErrors = 0;
let fellBack = false;
basemap.on('tileload', () => tilesLoaded++);
basemap.on('tileerror', () => {
  tileErrors++;
  if (!fellBack && tilesLoaded === 0 && tileErrors >= 4) {
    fellBack = true;
    map.removeLayer(basemap);
    L.tileLayer(ESRI_URL, {
      maxZoom: 18,
      attribution: 'Esri, OpenStreetMap contributors',
    }).addTo(map);
  }
});
basemap.addTo(map);

// ------------------------------------------------------------------- presets
const PRESETS: Record<string, BBox> = {
  apalachicola: { west: -85.1, south: 29.6, east: -84.6, north: 30.05 },
  everglades: { west: -81.4, south: 25.2, east: -80.4, north: 26.3 },
  'grand-canyon': { west: -112.35, south: 36.0, east: -111.75, north: 36.35 },
  denver: { west: -105.65, south: 39.45, east: -104.95, north: 40.05 },
  smokies: { west: -83.85, south: 35.45, east: -83.15, north: 35.85 },
};

// ------------------------------------------------------------------ elements
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const drawBtn = $<HTMLButtonElement>('drawBtn');
const clearBtn = $<HTMLButtonElement>('clearBtn');
const generateBtn = $<HTMLButtonElement>('generateBtn');
const opacityInput = $<HTMLInputElement>('opacity');
const opacityVal = $('opacityVal');
const resolutionSel = $<HTMLSelectElement>('resolution');
const spectrumSel = $<HTMLSelectElement>('spectrum');
const hillshadeChk = $<HTMLInputElement>('hillshade');
const logScaleChk = $<HTMLInputElement>('logScale');
const bboxLabel = $('bboxLabel');
const statusEl = $('status');
const statsEl = $('stats');
const progressWrap = $('progressWrap');
const progressEl = $<HTMLProgressElement>('progress');
const progressLabel = $('progressLabel');
const downloadsEl = $('downloads');

// --------------------------------------------------------------------- state
let selection: BBox | null = null;
let rectLayer: L.Rectangle | null = null;
let overlay: L.ImageOverlay | null = null;
let lastGrid: ElevationGrid | null = null;
let lastBbox: BBox | null = null;
let lastSpectrumCanvas: HTMLCanvasElement | null = null;
let lastGrayCanvas: HTMLCanvasElement | null = null;
let drawing = false;
let drawStart: L.LatLng | null = null;

function fmt(n: number): string {
  return n.toFixed(4);
}

function setSelection(bbox: BBox | null, fit = false): void {
  selection = bbox;
  if (rectLayer) {
    rectLayer.remove();
    rectLayer = null;
  }
  if (bbox) {
    const bounds = L.latLngBounds([bbox.south, bbox.west], [bbox.north, bbox.east]);
    rectLayer = L.rectangle(bounds, { color: '#f59e0b', weight: 2, fillOpacity: 0.05 }).addTo(map);
    bboxLabel.textContent =
      `W ${fmt(bbox.west)} · S ${fmt(bbox.south)} · E ${fmt(bbox.east)} · N ${fmt(bbox.north)}`;
    if (fit) map.fitBounds(bounds.pad(0.08));
  } else {
    bboxLabel.textContent = 'No area selected';
  }
}

// ------------------------------------------------------------ draw rectangle
function setDrawing(on: boolean): void {
  drawing = on;
  drawBtn.classList.toggle('active', on);
  drawBtn.textContent = on ? '✏️ Drag on the map…' : '✏️ Draw area on map';
  map.getContainer().classList.toggle('drawing-cursor', on);
  if (on) map.dragging.disable();
  else map.dragging.enable();
}

drawBtn.addEventListener('click', () => setDrawing(!drawing));
clearBtn.addEventListener('click', () => {
  setSelection(null);
  lastGrid = null;
  lastBbox = null;
  if (overlay) {
    overlay.remove();
    overlay = null;
  }
  downloadsEl.hidden = true;
  statsEl.textContent = '';
  statusEl.textContent = '';
});

map.on('mousedown', (e: L.LeafletMouseEvent) => {
  if (!drawing) return;
  drawStart = e.latlng;
  setSelection({
    west: e.latlng.lng,
    east: e.latlng.lng,
    south: e.latlng.lat,
    north: e.latlng.lat,
  });
});
map.on('mousemove', (e: L.LeafletMouseEvent) => {
  if (!drawing || !drawStart) return;
  setSelection({
    west: Math.min(drawStart.lng, e.latlng.lng),
    east: Math.max(drawStart.lng, e.latlng.lng),
    south: Math.min(drawStart.lat, e.latlng.lat),
    north: Math.max(drawStart.lat, e.latlng.lat),
  });
});
map.on('mouseup', () => {
  if (!drawing) return;
  drawStart = null;
  setDrawing(false);
  if (selection && (selection.east - selection.west < 0.005 || selection.north - selection.south < 0.005)) {
    statusEl.textContent = 'That area is too small — drag a bigger box.';
    setSelection(null);
  }
});

document.querySelectorAll<HTMLButtonElement>('#presets button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const p = PRESETS[btn.dataset.preset ?? ''];
    if (p) setSelection({ ...p }, true);
  });
});

// Default selection so Generate works immediately.
setSelection({ ...PRESETS['apalachicola'] }, true);

// ------------------------------------------------------- elevation tooltip
// Hovering the generated overlay shows the true elevation under the
// cursor, sampled from the cached native grid — unaffected by the
// spectrum or log mapping, which are display-only.
const elevTooltip = L.tooltip({ direction: 'top', offset: [0, -10], opacity: 0.95, className: 'elev-tooltip' });
let tooltipOpen = false;
function closeElevTooltip(): void {
  if (tooltipOpen) {
    map.closeTooltip(elevTooltip);
    tooltipOpen = false;
  }
}
map.on('mousemove', (e: L.LeafletMouseEvent) => {
  if (!lastGrid || !lastBbox || drawing) {
    closeElevTooltip();
    return;
  }
  const { lat, lng } = e.latlng;
  const b = lastBbox;
  if (lng < b.west || lng > b.east || lat < b.south || lat > b.north) {
    closeElevTooltip();
    return;
  }
  const gx = Math.round(((lng - b.west) / (b.east - b.west)) * (lastGrid.width - 1));
  const gy = Math.round(((b.north - lat) / (b.north - b.south)) * (lastGrid.height - 1));
  const m = lastGrid.data[gy * lastGrid.width + gx];
  const ft = m * 3.28084;
  elevTooltip.setLatLng(e.latlng).setContent(`${m.toFixed(1)} m · ${ft.toFixed(0)} ft`);
  if (!tooltipOpen) {
    elevTooltip.openOn(map);
    tooltipOpen = true;
  }
});
map.on('mouseout', closeElevTooltip);

// ------------------------------------------------------------------- opacity
function currentOpacity(): number {
  return Number(opacityInput.value) / 100;
}
opacityInput.addEventListener('input', () => {
  opacityVal.textContent = `${opacityInput.value}%`;
  if (overlay) overlay.setOpacity(currentOpacity());
});

// ------------------------------------------------- instant re-render (cached)
// Spectrum, resolution and hillshade changes re-render from the elevation
// grid already in memory — no re-download. Only Generate (or a new area)
// fetches data.
function applyRender(): void {
  if (!lastGrid || !lastBbox) return;
  const targetW = Number(resolutionSel.value);
  const spectrum = spectrumSel.value as RampName;
  const blend = hillshadeChk.checked ? 0.45 : 0;
  const outH = outputHeight(lastBbox, targetW);
  const outGrid = resample(lastGrid, targetW, outH);
  const logScale = logScaleChk.checked;
  lastSpectrumCanvas = renderToCanvas(outGrid, spectrum, blend, logScale);
  lastGrayCanvas = renderToCanvas(outGrid, 'grayscale', 0, logScale);
  const url = lastSpectrumCanvas.toDataURL('image/png');
  const bounds = L.latLngBounds([lastBbox.south, lastBbox.west], [lastBbox.north, lastBbox.east]);
  if (overlay) overlay.remove();
  overlay = L.imageOverlay(url, bounds, { opacity: currentOpacity(), interactive: false }).addTo(map);
  overlay.bringToFront();
  downloadsEl.hidden = false;
}
spectrumSel.addEventListener('change', applyRender);
resolutionSel.addEventListener('change', applyRender);
hillshadeChk.addEventListener('change', applyRender);
logScaleChk.addEventListener('change', applyRender);

// ------------------------------------------------------------------ generate
generateBtn.addEventListener('click', async () => {
  if (!selection) {
    statusEl.textContent = 'Select an area first (draw a box or pick a preset).';
    return;
  }
  const bbox: BBox = { ...selection };
  const targetW = Number(resolutionSel.value);

  generateBtn.disabled = true;
  downloadsEl.hidden = true;
  progressWrap.hidden = false;
  progressEl.value = 0;
  statusEl.textContent = '';
  statsEl.textContent = '';

  try {
    progressLabel.textContent = 'Fetching elevation tiles (AWS Terrain Tiles)…';
    const grid = await fetchElevation(bbox, targetW, (done, total) => {
      progressEl.value = Math.round((done / total) * 100);
      progressLabel.textContent = `Fetching elevation tiles… ${done}/${total}`;
    });
    lastGrid = grid;
    lastBbox = bbox;

    progressLabel.textContent = 'Rendering heightmap…';
    applyRender();
    const outH = outputHeight(bbox, targetW);

    statsEl.textContent =
      `Elevation ${grid.min.toFixed(1)} m to ${grid.max.toFixed(1)} m (mean ${grid.mean.toFixed(1)} m) · ` +
      `source zoom ${grid.zoom}, ${grid.tiles} tiles, native ${grid.width}×${grid.height} px · output ${targetW}×${outH} px`;
    statusEl.textContent = 'Done. The heightmap is overlaid on the map — drag the opacity slider to blend it.';
    downloadsEl.hidden = false;
  } catch (err) {
    statusEl.textContent = `Failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    progressWrap.hidden = true;
    generateBtn.disabled = false;
  }
});

// ----------------------------------------------------------------- downloads
$<HTMLButtonElement>('dlSpectrum').addEventListener('click', () => {
  if (lastSpectrumCanvas) downloadCanvas(lastSpectrumCanvas, 'heightmap-spectrum.png');
});
$<HTMLButtonElement>('dlGray').addEventListener('click', () => {
  if (lastGrayCanvas) downloadCanvas(lastGrayCanvas, 'heightmap-grayscale.png');
});
$<HTMLButtonElement>('dlComposite').addEventListener('click', async () => {
  if (!selection || !lastSpectrumCanvas) return;
  statusEl.textContent = 'Building composite (fetching OSM tiles)…';
  const composite = await renderComposite({ ...selection }, lastSpectrumCanvas, currentOpacity());
  downloadCanvas(composite, 'heightmap-composite.png');
  statusEl.textContent = 'Composite downloaded.';
});
