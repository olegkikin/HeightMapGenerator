/** Colour spectra (ramps) for rendering elevation. t is 0 (lowest) .. 1 (highest). */

export type RampName = 'grayscale' | 'terrain' | 'viridis' | 'inferno' | 'rainbow';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

type Stop = [number, Rgb];

const rgb = (r: number, g: number, b: number): Rgb => ({ r, g, b });

const RAMPS: Record<Exclude<RampName, 'grayscale'>, Stop[]> = {
  // Hypsometric tint: deep water green -> lowland green -> tan -> rock -> snow
  terrain: [
    [0.0, rgb(38, 92, 52)],
    [0.22, rgb(88, 148, 72)],
    [0.42, rgb(168, 180, 104)],
    [0.6, rgb(198, 172, 112)],
    [0.78, rgb(168, 132, 92)],
    [0.92, rgb(205, 195, 185)],
    [1.0, rgb(248, 248, 250)],
  ],
  // Viridis (perceptually uniform)
  viridis: [
    [0.0, rgb(68, 1, 84)],
    [0.25, rgb(59, 82, 139)],
    [0.5, rgb(33, 144, 140)],
    [0.75, rgb(93, 201, 98)],
    [1.0, rgb(253, 231, 37)],
  ],
  // Inferno
  inferno: [
    [0.0, rgb(0, 0, 4)],
    [0.25, rgb(87, 16, 110)],
    [0.5, rgb(188, 55, 84)],
    [0.75, rgb(249, 142, 9)],
    [1.0, rgb(252, 255, 164)],
  ],
  // Rainbow / jet-style
  rainbow: [
    [0.0, rgb(0, 0, 143)],
    [0.2, rgb(0, 110, 255)],
    [0.4, rgb(0, 210, 190)],
    [0.55, rgb(90, 220, 60)],
    [0.7, rgb(250, 230, 0)],
    [0.85, rgb(245, 120, 0)],
    [1.0, rgb(160, 0, 0)],
  ],
};

function sampleStops(stops: Stop[], t: number): Rgb {
  const x = Math.min(1, Math.max(0, t));
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const f = t1 > t0 ? (x - t0) / (t1 - t0) : 0;
      return {
        r: Math.round(c0.r + f * (c1.r - c0.r)),
        g: Math.round(c0.g + f * (c1.g - c0.g)),
        b: Math.round(c0.b + f * (c1.b - c0.b)),
      };
    }
  }
  return stops[stops.length - 1][1];
}

/** Sample a named ramp at t in [0,1]. Grayscale is a pure linear ramp. */
export function sampleRamp(name: RampName, t: number): Rgb {
  if (name === 'grayscale') {
    const v = Math.round(Math.min(1, Math.max(0, t)) * 255);
    return { r: v, g: v, b: v };
  }
  return sampleStops(RAMPS[name], t);
}

/** Build a 256-entry lookup table for fast per-pixel rendering. */
export function buildLut(name: RampName): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const c = sampleRamp(name, i / 255);
    lut[i * 3] = c.r;
    lut[i * 3 + 1] = c.g;
    lut[i * 3 + 2] = c.b;
  }
  return lut;
}
