/**
 * Elevation data from AWS Terrain Tiles (Registry of Open Data on AWS).
 *
 * Tiles are Terrarium-encoded PNGs: elevation_m = R*256 + G + B/256 - 32768.
 * Over the continental US the source is USGS NED 1/3 arc-second (~10 m),
 * the seamless layer of the USGS 3D Elevation Program (3DEP).
 * Free, no API key, CORS-enabled (Access-Control-Allow-Origin: *).
 *
 * Tile URL: https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
 */

export interface BBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface ElevationGrid {
  /** Row-major elevations in metres, north row first. */
  data: Float32Array;
  width: number;
  height: number;
  min: number;
  max: number;
  mean: number;
  /** Zoom the tiles were fetched at. */
  zoom: number;
  /** Number of tiles fetched. */
  tiles: number;
}

const TILE_URL = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

export const MAX_ZOOM = 14; // source data is ~10 m; z15 would only oversample
const MAX_TILES = 120;

export function lonToTileX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

export function latToTileY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

export function tileXToLon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}

export function tileYToLat(y: number, z: number): number {
  const n = Math.PI * (1 - (2 * y) / 2 ** z);
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

/**
 * Pick the smallest zoom whose tile mosaic is at least `targetWidth` px
 * across the bbox, without exceeding MAX_TILES tiles.
 */
export function chooseZoom(bbox: BBox, targetWidth: number): number {
  for (let z = 10; z <= MAX_ZOOM; z++) {
    const cols = lonToTileX(bbox.east, z) - lonToTileX(bbox.west, z) + 1;
    const rows = latToTileY(bbox.south, z) - latToTileY(bbox.north, z) + 1;
    if (cols * 256 >= targetWidth && cols * rows <= MAX_TILES) return z;
    if (z === MAX_ZOOM) return z;
    if (cols * 256 >= targetWidth) return z; // can't do better within tile cap
  }
  return MAX_ZOOM;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // bucket sends CORS headers; keeps canvas untainted
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load tile ${url}`));
    img.src = url;
  });
}

/**
 * Fetch all Terrarium tiles covering `bbox` at the chosen zoom, decode them
 * into one elevation grid, and crop the grid to the exact bbox.
 */
export async function fetchElevation(
  bbox: BBox,
  targetWidth: number,
  onProgress?: (done: number, total: number) => void,
): Promise<ElevationGrid> {
  const zoom = chooseZoom(bbox, targetWidth);
  const x0 = lonToTileX(bbox.west, zoom);
  const x1 = lonToTileX(bbox.east, zoom);
  const y0 = latToTileY(bbox.north, zoom);
  const y1 = latToTileY(bbox.south, zoom);
  const cols = x1 - x0 + 1;
  const rows = y1 - y0 + 1;
  const total = cols * rows;
  if (total > MAX_TILES * 4) {
    throw new Error(`Area too large: needs ${total} tiles. Select a smaller area.`);
  }

  const mosaicW = cols * 256;
  const mosaicH = rows * 256;
  const mosaic = new Float32Array(mosaicW * mosaicH);

  let done = 0;
  const jobs: Promise<void>[] = [];
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const px = tx * 256;
      const py = ty * 256;
      jobs.push(
        loadImage(TILE_URL(zoom, x0 + tx, y0 + ty)).then((img) => {
          // Draw to a scratch canvas per job would race; decode via a
          // per-tile canvas instead (cheap at 256x256).
          const c = document.createElement('canvas');
          c.width = 256;
          c.height = 256;
          const cctx = c.getContext('2d', { willReadFrequently: true });
          if (!cctx) return;
          cctx.drawImage(img, 0, 0);
          const pxData = cctx.getImageData(0, 0, 256, 256).data;
          for (let i = 0; i < 256 * 256; i++) {
            const r = pxData[i * 4];
            const g = pxData[i * 4 + 1];
            const b = pxData[i * 4 + 2];
            const gx = px + (i % 256);
            const gy = py + Math.floor(i / 256);
            mosaic[gy * mosaicW + gx] = r * 256 + g + b / 256 - 32768;
          }
          done++;
          onProgress?.(done, total);
        }),
      );
    }
  }
  await Promise.all(jobs);

  // Crop the mosaic to the exact requested bbox.
  const lonW = tileXToLon(x0, zoom);
  const lonE = tileXToLon(x1 + 1, zoom);
  const latN = tileYToLat(y0, zoom);
  const latS = tileYToLat(y1 + 1, zoom);
  const cx0 = Math.max(0, Math.floor(((bbox.west - lonW) / (lonE - lonW)) * mosaicW));
  const cx1 = Math.min(mosaicW, Math.ceil(((bbox.east - lonW) / (lonE - lonW)) * mosaicW));
  const cy0 = Math.max(0, Math.floor(((latN - bbox.north) / (latN - latS)) * mosaicH));
  const cy1 = Math.min(mosaicH, Math.ceil(((latN - bbox.south) / (latN - latS)) * mosaicH));
  const w = Math.max(1, cx1 - cx0);
  const h = Math.max(1, cy1 - cy0);
  const data = new Float32Array(w * h);
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = mosaic[(cy0 + y) * mosaicW + (cx0 + x)];
      data[y * w + x] = v;
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
  }
  return { data, width: w, height: h, min, max, mean: sum / (w * h), zoom, tiles: total };
}
