/* SPDX-License-Identifier: GPL-3.0-or-later */

export const SPEKTRA_FULL_WIRE_DEFAULTS = {
  film: 'kodak_portra_400',
  paper: 'kodak_portra_endura',
  filmExposure: 0,
  filmGamma: 1,
  paperGamma: 1,
  printExposure: 0,
  yFilter: 0,
  mFilter: 0,
  preflash: 0,
  paperGrade: '2',
  illuminant: '3200',
  cameraFilter: 'none',
  couplers: 1,
  printEffects: true,
  edr: false,
  cameraExposure: 0,
  cameraExposureAsShot: false,
  cameraTemperatureAsShot: true,
  cameraTintAsShot: true,
  grainActive: true,
  halationActive: true,
  glareActive: true,
  filmScaleEdge: 'short',
  cameraTemperature: 5500,
  cameraTint: 0,
  metering: 'average',
  sceneHighlights: 0,
  sceneShadows: 0,
  lensBlur: 0,
  diffusion: 0,
  headroom: 0,
  halationRadius: 1,
  antihalationRemoved: false,
  grainSize: 1,
  grainChroma: 35,
  glare: 0,
  sharpen: 70,
  contrastMaskHighlights: 0,
  contrastMaskShadows: 0,
  postTint: 0,
  curveShadows: 0,
  curveMid: 0,
  curveHighlights: 0,
  balanceR: 0,
  balanceG: 0,
  balanceB: 0,
  shadowR: 0,
  shadowG: 0,
  shadowB: 0,
  highlightR: 0,
  highlightG: 0,
  highlightB: 0,
  exposure: 0,
  temperature: 0,
  contrast: 0,
  saturation: 0,
  grain: 65,
  halation: 65,
  vignette: 12,
  format: '135',
  filmLongMm: 36,
  crop: 'original',
  rotation: 0,
  border: false
};

export const SPEKTRA_UI_DEFAULTS = {
  film: 'kodak_portra_400',
  paper: 'kodak_portra_endura',
  exposure: 0,
  temperature: 0,
  contrast: 0,
  saturation: 0,
  grain: 65,
  halation: 65,
  vignette: 12,
  border: true,
  edgeFormat: '135',
  edgeOrientation: 'auto', // 'auto' | 'horizontal' | 'vertical'
  edgeCropMode: 'keep', // 'keep' | 'gate'
  edgeStyle: 'strip', // 'strip' | 'filed'
  edgeGate: 'rounded', // 'rounded' | 'square' | 'eared' | 'kicked'
  edgeHoles: 'white', // 'white' | 'black'
  edgeCarrier: 'none', // 'none' | 'black' | 'open'
  frameNumber: 24,
  edgeFog: 0.8,
  edgeLeaks: 0,
  dateOn: true,
  dateSource: 'exif', // 'exif' | 'custom'
  dateFormat: 'classic_yy', // 'classic_yy' | 'ymd_dot' | 'ymd_dash'
  dateText: '',
  dateStyle: 'lcd', // 'lcd' | 'dots' | 'data'
  dateCorner: 'br', // 'br' | 'bl' | 'tr' | 'tl'
  dateSize: 1.0,
  dateExposure: 1.0,
  withLeicaWatermark: false,
  sourceType: 'original' // 'original' | 'ai'
};

export const MATERIAL_OPTION_KEYS = [
  'filmExposure',
  'filmGamma',
  'paperGamma',
  'printExposure',
  'yFilter',
  'mFilter',
  'preflash',
  'paperGrade',
  'illuminant',
  'cameraFilter',
  'couplers',
  'printEffects',
  'edr'
];

export function extractMaterialOptions(params) {
  const out = {};
  for (const key of MATERIAL_OPTION_KEYS) {
    out[key] = params[key] !== undefined ? params[key] : SPEKTRA_FULL_WIRE_DEFAULTS[key];
  }
  return out;
}

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));

export function blackbody(kelvin) {
  const t = kelvin / 100;
  const r = t <= 66 ? 255 : 329.698727446 * ((t - 60) ** -0.1332047592);
  const g = t <= 66
    ? 99.4708025861 * Math.log(t) - 161.1195681661
    : 288.1221695283 * ((t - 60) ** -0.0755148492);
  const b = t >= 66 ? 255 : (t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307);
  return [r, g, b].map((v) => clamp(v / 255, 0.025, 1));
}

export function cameraGains(p) {
  const bb = blackbody(p.cameraTemperature || 5500);
  const ref = blackbody(5500);
  const g = ref.map((v, k) => v / bb[k]);
  g[1] *= 2 ** (-(p.cameraTint || 0) / 150);
  return g;
}

export function buildEngineParams(uiParams, width, height, stockInfo) {
  const isMedium = String(uiParams.edgeFormat || '135').startsWith('120');
  const merged = {
    ...SPEKTRA_FULL_WIRE_DEFAULTS,
    ...uiParams,
    format: isMedium ? '120' : '135',
    filmLongMm: isMedium ? 56 : 36,
    border: false, // Border & perforations are composited post-render in presentation.js
    grainActive: (uiParams.grain ?? 0) > 0,
    halationActive: (uiParams.halation ?? 0) > 0,
    antihalationRemoved: uiParams.film === 'cinestill_800t' || Boolean(uiParams.antihalationRemoved),
    grainChroma: stockInfo?.monochrome ? 0 : (uiParams.grainChroma ?? SPEKTRA_FULL_WIRE_DEFAULTS.grainChroma)
  };
  const longEdge = Math.max(width || 1, height || 1);
  return {
    ...merged,
    cameraGains: cameraGains(merged),
    sourceColorSpace: 'sRGB',
    sourceEncoded: true,
    sourceLongEdge: longEdge,
    frameLongEdge: longEdge,
    targetColorSpace: 'sRGB',
    displayOutput: true
  };
}
