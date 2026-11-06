import type { ElevationGrid, BBox } from './terrain';
import { lonToTileX, latToTileY } from './terrain';
import { buildLut, type RampName } from './ramps';

/** Resample a grid to (outW x outH) with bilinear interpolation. */
export function resample(grid: ElevationGrid, outW: number, outH: number): ElevationGrid {
  const { data, width: w, height: h } = grid;
  const out = new Float32Array(outW * outH);
  for (let y = 0; y < outH; y++) {
    const sy = (y / Math.max(1, outH - 1)) * (h - 1);
    const y0 = Math.floor(sy);
    const y1 = Math.min(h - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < outW; x++) {
      const sx = (x / Math.max(1, outW - 1)) * (w - 1);
      const x0 = Math.floor(sx);
      const x1 = Math.min(w - 1, x0 + 1);
      const fx = sx - x0;
      const v =
        data[y0 * w + x0] * (1 - fx) * (1 - fy) +
        data[y0 * w + x1] * fx * (1 - fy) +
        data[y1 * w + x0] * (1 - fx) * fy +
        data[y1 * w + x1] * fx * fy;
      out[y * outW + x] = v;
    }
  }
  return { ...grid, data: out, width: outW, height: outH };
}

/** Output height in px for a target width, preserving the bbox aspect
 *  (latitude-corrected, matching the Web Mercator map). */
export function outputHeight(bbox: BBox, outW: number): number {
  const midLat = ((bbox.north + bbox.south) / 2) * (Math.PI / 180);
  const aspect = (bbox.north - bbox.south) / ((bbox.east - bbox.west) * Math.cos(midLat));
  return Math.max(1, Math.round(outW * aspect));
}

/**
 * Render a grid to a canvas using a colour spectrum.
 * - `grayscale` is always a pure linear heightmap (no shading) so it can be
 *   used directly as a displacement/height map in game engines.
 * - Colour spectra can be blended with a hillshade for legibility.
 */
/**
 * Robust stretch range: a few glitch/void pixels in the source tiles can
 * sit hundreds of metres off and would otherwise poison a true min/max
 * stretch (the whole image washes out). Use the 0.1% / 99.9% percentiles
 * of a sample of the grid instead. True min/max stay on the grid object
 * for the stats line.
 */
export function stretchRange(grid: ElevationGrid): { lo: number; hi: number } {
  const { data } = grid;
  const stride = Math.max(1, Math.floor(data.length / 200_000));
  const samples: number[] = [];
  for (let i = 0; i < data.length; i += stride) samples.push(data[i]);
  samples.sort((a, b) => a - b);
  const lo = samples[Math.floor(0.001 * (samples.length - 1))];
  const hi = samples[Math.ceil(0.999 * (samples.length - 1))];
  return { lo, hi: Math.max(hi, lo + 1) };
}

export function renderToCanvas(
  grid: ElevationGrid,
  spectrum: RampName,
  hillshadeBlend: number, // 0..1, ignored for grayscale
  logScale = false,
): HTMLCanvasElement {
  const { data, width: w, height: h } = grid;
  const { lo: min, hi: max } = stretchRange(grid);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  const img = ctx.createImageData(w, h);
  const lut = buildLut(spectrum);
  const range = Math.max(1e-6, max - min);
  // Log mapping is log1p on the range-shifted height: t = ln(1 + h - min)
  // / ln(1 + range). Defined for below-sea-level pixels too (min maps to
  // 0, max to 1), and it expands detail in low terrain — most of Florida
  // sits in the bottom few percent of a linear stretch next to hills.
  const logDenom = Math.log1p(range);
  const useShade = spectrum !== 'grayscale' && hillshadeBlend > 0;

  // Pixel size in grid units is 1; slope from central differences.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const shifted = Math.max(0, data[i] - min);
      const t = logScale ? Math.log1p(shifted) / logDenom : shifted / range;
      const li = Math.min(255, Math.max(0, Math.round(t * 255))) * 3;
      let r = lut[li];
      let g = lut[li + 1];
      let b = lut[li + 2];
      if (useShade) {
        const xl = data[y * w + Math.max(0, x - 1)];
        const xr = data[y * w + Math.min(w - 1, x + 1)];
        const yu = data[Math.max(0, y - 1) * w + x];
        const yd = data[Math.min(h - 1, y + 1) * w + x];
        // Exaggerate: real slopes are tiny next to the elevation range.
        const dzdx = ((xr - xl) / range) * 6;
        const dzdy = ((yd - yu) / range) * 6;
        // Light from the NW (azimuth 315), altitude 45 degrees.
        const slope = Math.atan(Math.hypot(dzdx, dzdy));
        const aspect = Math.atan2(-dzdy, dzdx);
        let shade =
          Math.cos(Math.PI / 4) * Math.cos(slope) +
          Math.sin(Math.PI / 4) * Math.sin(slope) * Math.cos((315 * Math.PI) / 180 - aspect);
        shade = Math.min(1, Math.max(0, shade));
        const f = (1 - hillshadeBlend) + hillshadeBlend * shade;
        r = Math.min(255, r * f * (useShade ? 1.15 : 1));
        g = Math.min(255, g * f * (useShade ? 1.15 : 1));
        b = Math.min(255, b * f * (useShade ? 1.15 : 1));
      }
      img.data[i * 4] = r;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = b;
      img.data[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Composite export: draw the OSM basemap tiles for the bbox at the same
 * size, then draw the heightmap canvas over them at `opacity` (0..1).
 */
export async function renderComposite(
  bbox: BBox,
  heightCanvas: HTMLCanvasElement,
  opacity: number,
): Promise<HTMLCanvasElement> {
  const outW = heightCanvas.width;
  const outH = heightCanvas.height;
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.fillStyle = '#e8e4dc';
  ctx.fillRect(0, 0, outW, outH);

  // Pick an OSM zoom whose tiles cover the output size, then draw each
  // tile scaled into place using Web Mercator global-pixel coordinates
  // (exact alignment with both Leaflet and the heightmap crop).
  let zoom = 16;
  for (let z = 4; z <= 16; z++) {
    const cols = lonToTileX(bbox.east, z) - lonToTileX(bbox.west, z) + 1;
    if (cols * 256 >= outW) {
      zoom = z;
      break;
    }
  }
  const worldPx = 2 ** zoom * 256;
  const gx = (lon: number) => ((lon + 180) / 360) * worldPx;
  const gy = (lat: number) => {
    const r = (lat * Math.PI) / 180;
    return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * worldPx;
  };
  const bx0 = gx(bbox.west);
  const bx1 = gx(bbox.east);
  const by0 = gy(bbox.north);
  const by1 = gy(bbox.south);
  const sx = outW / (bx1 - bx0);
  const sy = outH / (by1 - by0);
  const x0 = lonToTileX(bbox.west, zoom);
  const x1 = lonToTileX(bbox.east, zoom);
  const y0 = latToTileY(bbox.north, zoom);
  const y1 = latToTileY(bbox.south, zoom);

  const jobs: Promise<void>[] = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const dx = (tx * 256 - bx0) * sx;
      const dy = (ty * 256 - by0) * sy;
      const dw = 256 * sx;
      const dh = 256 * sy;
      jobs.push(
        new Promise<void>((resolve) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            ctx.drawImage(img, dx, dy, dw + 1, dh + 1);
            resolve();
          };
          img.onerror = () => resolve();
          // Same basemap as the map: OSM style via the openstreetmap.de
          // mirror. tile.openstreetmap.org serves "Access blocked"
          // placeholder tiles to apps; see main.ts.
          img.src = `https://tile.openstreetmap.de/${zoom}/${tx}/${ty}.png`;
        }),
      );
    }
  }
  await Promise.all(jobs);

  ctx.globalAlpha = opacity;
  ctx.drawImage(heightCanvas, 0, 0);
  ctx.globalAlpha = 1;
  return canvas;
}

export function downloadCanvas(canvas: HTMLCanvasElement, filename: string): void {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, 'image/png');
}
