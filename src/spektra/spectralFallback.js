/* SPDX-License-Identifier: GPL-3.0-or-later */
import { cameraGains } from './defaults.js';

export const LUT_SIZE = 33;
export const SHAPER = Math.log2(257);

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const decodeSRGB = (x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
export const encodeSRGB = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * (Math.max(0, x) ** (1 / 2.4)) - 0.055);

const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const mv = (a, v) => a.map((row) => dot(row, v));
const mm = (a, b) => a.map((row) => b[0].map((_, c) => row.reduce((s, v, i) => s + v * b[i][c], 0)));

function inverse3x3(a) {
  const m = a.map((r, i) => [...r, ...[0, 1, 2].map((j) => (i === j ? 1 : 0))]);
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let j = i + 1; j < 3; j++) {
      if (Math.abs(m[j][i]) > Math.abs(m[p][i])) p = j;
    }
    [m[i], m[p]] = [m[p], m[i]];
    const d = m[i][i];
    if (Math.abs(d) < 1e-12) throw new Error('颜色矩阵不可逆');
    m[i] = m[i].map((v) => v / d);
    for (let j = 0; j < 3; j++) {
      if (i !== j) {
        const k = m[j][i];
        m[j] = m[j].map((v, c) => v - k * m[i][c]);
      }
    }
  }
  return m.map((r) => r.slice(3));
}

const RGB_XYZ = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.0721750],
  [0.0193339, 0.1191920, 0.9503041]
];
const XYZ_RGB = inverse3x3(RGB_XYZ);
const BRADFORD = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296]
];
const BRADFORD_INV = inverse3x3(BRADFORD);

function adaptation(from, to) {
  const s = mv(BRADFORD, from);
  const t = mv(BRADFORD, to);
  return mm(BRADFORD_INV, BRADFORD.map((row, i) => row.map((v) => (v * t[i]) / s[i])));
}

const gaussian = (x, mu, sigma) => Math.exp(-0.5 * (((x - mu) / sigma) ** 2));

function cmf(w) {
  const g = (mu, l, r) => Math.exp(-0.5 * ((w - mu) * (w < mu ? l : r)) ** 2);
  return [
    1.056 * g(599.8, 0.0264, 0.0323) + 0.362 * g(442, 0.0624, 0.0374) - 0.065 * g(501.1, 0.049, 0.0382),
    0.821 * g(568.8, 0.0213, 0.0247) + 0.286 * g(530.9, 0.0613, 0.0322),
    1.217 * g(437, 0.0845, 0.0278) + 0.681 * g(459, 0.0385, 0.0725)
  ];
}

function illuminant(w, t) {
  const m = w * 1e-9;
  return 1 / ((m ** 5) * Math.expm1(0.01438776877 / (m * t)));
}

function finite(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function sampleCurve(profile, x, c) {
  const d = profile.data;
  const axis = d.log_exposure;
  const n = axis.length;
  const f = clamp((x - axis[0]) / (axis[n - 1] - axis[0]), 0, 1) * (n - 1);
  const i = Math.min(n - 2, Math.floor(f));
  const t = f - i;
  return Math.max(0, finite(d.density_curves[i][c]) * (1 - t) + finite(d.density_curves[i + 1][c]) * t);
}

function spectralData(profile) {
  const d = profile.data;
  return d.wavelengths.map((w, i) => ({
    w,
    valid: d.channel_density[i].every(Number.isFinite) && Number.isFinite(d.base_density[i]),
    d: d.channel_density[i].map(finite),
    base: finite(d.base_density[i]),
    s: d.log_sensitivity[i].map((x) => (Number.isFinite(x) ? 10 ** x : 0))
  }));
}

export function createSpectralModel(film, paper, options = {}) {
  const o = {
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
    couplers: 0,
    printEffects: true,
    edr: false,
    ...options
  };

  const positive = film.info.type === 'positive';
  const mono = film.info.channel_model === 'bw';
  const f = spectralData(film);
  const p = paper ? spectralData(paper) : f;
  const n = f.length;

  const c = f.map((v) => cmf(v.w));
  const light = f.map((v) => illuminant(v.w, 5000));
  const norm = dot(light, c.map((v) => v[1]));
  for (let i = 0; i < n; i++) light[i] /= norm;

  const white = [0, 1, 2].map((k) => light.reduce((sum, v, i) => sum + v * c[i][k], 0));
  const scanM = mm(XYZ_RGB, adaptation(white, [0.95047, 1, 1.08883]));
  const scanWeights = c.map((v, i) => mv(scanM, v.map((x) => x * light[i])));

  const bases = f.map((v) => [gaussian(v.w, 610, 40), gaussian(v.w, 545, 33), gaussian(v.w, 450, 26)]);
  const basisXYZ = [0, 1, 2].map((k) =>
    [0, 1, 2].map((j) => bases.reduce((sum, v, i) => sum + v[j] * light[i] * c[i][k], 0))
  );
  const reconstruct = mm(inverse3x3(basisXYZ), mm(adaptation([0.95047, 1, 1.08883], white), RGB_XYZ));

  const filterWeight = (w) => {
    if (o.cameraFilter === 'yellow') return 0.02 + 0.98 / (1 + Math.exp(-(w - 490) / 15));
    if (o.cameraFilter === 'orange') return 0.02 + 0.98 / (1 + Math.exp(-(w - 545) / 18));
    if (o.cameraFilter === 'red') return 0.01 + 0.99 / (1 + Math.exp(-(w - 590) / 15));
    if (o.cameraFilter === 'green') return 0.02 + 0.98 * gaussian(w, 540, 40);
    if (o.cameraFilter === 'blue') return 0.02 + 0.98 * gaussian(w, 450, 35);
    return 1;
  };

  const sensitivity = [0, 1, 2].map((k) =>
    [0, 1, 2].map((j) => f.reduce((sum, v, i) => sum + v.s[k] * bases[i][j] * light[i], 0))
  );
  const filtered = [0, 1, 2].map((k) =>
    [0, 1, 2].map((j) => f.reduce((sum, v, i) => sum + v.s[k] * filterWeight(v.w) * bases[i][j] * light[i], 0))
  );
  const baseMatrix = mm(sensitivity, reconstruct);
  const filteredMatrix = mm(filtered, reconstruct);
  const factor = filteredMatrix[1].reduce((a, b) => a + b, 0) / baseMatrix[1].reduce((a, b) => a + b, 0);
  const fm = filteredMatrix.map((row, i) => {
    const sum = baseMatrix[i].reduce((a, b) => a + b, 0) * factor;
    return row.map((v) => v / sum);
  });

  function filmDensity(rgb, exp = o.filmExposure) {
    const raw = mv(fm, rgb);
    let d = raw.map((v, k) => sampleCurve(film, Math.log10(Math.max(1e-10, v * (2 ** exp)) / 0.184) * o.filmGamma, k));
    if (!mono && o.couplers > 0) {
      const mean = (d[0] + d[1] + d[2]) / 3;
      d = d.map((v) => Math.max(0, v + (v - mean) * o.couplers * 0.22));
    }
    return d;
  }

  function scanDensity(material, channels) {
    const data = material === film ? f : p;
    const acc = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      if (!data[i].valid) continue;
      const t = 10 ** (-dot(channels, data[i].d) - data[i].base);
      for (let k = 0; k < 3; k++) acc[k] += t * scanWeights[i][k];
    }
    if (mono) {
      const y = dot(acc, [0.2126, 0.7152, 0.0722]);
      return [y, y, y];
    }
    return acc;
  }

  function gamutMap(lin) {
    const y = clamp(dot(lin, [0.2126, 0.7152, 0.0722]));
    let t = 1;
    for (let k = 0; k < 3; k++) {
      const d = lin[k] - y;
      if (d > 0) t = Math.min(t, (1 - y) / d);
      if (d < 0) t = Math.min(t, -y / d);
    }
    return lin.map((v) => clamp(encodeSRGB(y + (v - y) * clamp(t))));
  }

  if (positive) {
    const gray = scanDensity(film, filmDensity([0.184, 0.184, 0.184], 0));
    const gain = gray.map((v) => 0.184 / Math.max(v, 1e-8));
    return {
      pixel: (rgb) => gamutMap(scanDensity(film, filmDensity(rgb)).map((v, k) => v * gain[k]))
    };
  }

  if (!paper) {
    return {
      pixel: (rgb) => {
        const d = filmDensity(rgb);
        return d.map((v, k) => {
          const axis = film.data.log_exposure;
          let lo = axis[0];
          let hi = axis[axis.length - 1];
          for (let it = 0; it < 15; it++) {
            const mid = (lo + hi) / 2;
            if (sampleCurve(film, mid, k) < v) lo = mid;
            else hi = mid;
          }
          return clamp(0.410 + ((lo + hi) / 2) * Math.LOG2E * Math.LN10 * 0.073);
        });
      }
    };
  }

  const temp = Number(o.illuminant) || 3200;
  const baseLamp = f.map((v) => illuminant(v.w, temp));
  const lm = Math.max(...baseLamp);
  for (let i = 0; i < n; i++) baseLamp[i] /= lm;

  const gradeTable = { '00': [0, 199], '0': [0, 137.9], '1': [0, 99.8], '2': [0, 68], '3': [0, 34.1], '4': [39.1, 0], '5': [151.7, 0] };
  const grade = gradeTable[o.paperGrade] || gradeTable['2'];

  function lampFor(y, m) {
    return baseLamp.map((v, i) => v * (10 ** (-0.01 * y / (1 + Math.exp((f[i].w - 490) / 16)) - 0.01 * m * gaussian(f[i].w, 545, 43))));
  }

  const neutralLamp = mono ? lampFor(68, 0) : baseLamp;
  const lamp = mono ? lampFor(grade[1] + o.yFilter, grade[0] + o.mFilter) : lampFor(o.yFilter, o.mFilter);

  function throughFilm(d, illum = lamp) {
    const acc = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      if (!f[i].valid) continue;
      const t = (10 ** (-dot(d, f[i].d) - f[i].base)) * illum[i];
      for (let k = 0; k < 3; k++) acc[k] += t * p[i].s[k];
    }
    return acc;
  }

  function scanPaper(log) {
    const d = log.map((v, k) => sampleCurve(paper, v * o.paperGamma, k));
    return scanDensity(paper, d);
  }

  const referenceDensity = filmDensity([0.184, 0.184, 0.184]);
  const anchor = throughFilm(referenceDensity, neutralLamp).map((v) => Math.log10(Math.max(v, 1e-12)));
  let mid = [0.1, 0.1, 0.1];
  const monoMean = anchor.reduce((a, b) => a + b, 0) / 3;

  if (mono) {
    const reference = throughFilm(referenceDensity).map((v) => Math.log10(Math.max(v, 1e-12)) - monoMean);
    let lo = -4;
    let hi = 4;
    for (let it = 0; it < 50; it++) {
      const t = (lo + hi) / 2;
      const y = scanPaper(reference.map((v) => v + t))[1];
      if (y > 0.184) lo = t;
      else hi = t;
    }
    const val = (lo + hi) / 2;
    mid = [val, val, val];
  } else {
    for (let it = 0; it < 18; it++) {
      const out = scanPaper(mid);
      const err = out.map((v) => 0.184 - v);
      if (Math.max(...err.map(Math.abs)) < 1e-7) break;
      const jac = [0, 1, 2].map((k) => {
        const a = [...mid];
        a[k] += 0.001;
        return scanPaper(a).map((v, j) => (v - out[j]) / 0.001);
      });
      const step = mv(inverse3x3(jac[0].map((_, i) => jac.map((r) => r[i]))), err);
      mid = mid.map((v, i) => clamp(v + clamp(step[i], -0.3, 0.3), -0.8, 1.5));
    }
  }

  return {
    pixel: (rgb) => {
      const raw = throughFilm(filmDensity(rgb));
      const log = raw.map((v, k) => {
        const a = Math.log10(Math.max(v, 1e-12)) - (mono ? monoMean : anchor[k]) + mid[k] + o.printExposure * Math.LOG10E * Math.LN2;
        return Math.log10((10 ** a) + (o.printEffects ? o.preflash : 0) + 1e-12);
      });
      let lin = scanPaper(log);
      if (o.edr && o.printEffects) {
        const y = dot(lin, [0.2126, 0.7152, 0.0722]);
        const mapped = y < 0.7 ? y : 0.7 + 0.3 * (1 - Math.exp(-(y - 0.7) / 0.3));
        if (y > 1e-8) lin = lin.map((v) => (v * mapped) / y);
      }
      return gamutMap(lin);
    }
  };
}

export function buildSpectralLUT(film, paper, options = {}, size = LUT_SIZE) {
  const model = createSpectralModel(film, paper, options);
  const out = new Float32Array((size ** 3) * 4);
  let offset = 0;
  const values = Array.from({ length: size }, (_, i) => (2 ** ((i / (size - 1)) * SHAPER) - 1) / 16);
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const rgb = model.pixel([values[r], values[g], values[b]]);
        out[offset++] = rgb[0];
        out[offset++] = rgb[1];
        out[offset++] = rgb[2];
        out[offset++] = 1;
      }
    }
  }
  return out;
}

function sampleLUT(lut, rgb, size = LUT_SIZE) {
  const q = rgb.map((v) => clamp(Math.log2(1 + Math.max(0, v) * 16) / SHAPER) * (size - 1));
  const lo = q.map((v) => Math.min(size - 2, Math.floor(v)));
  const f = q.map((v, i) => v - lo[i]);
  const out = [0, 0, 0];
  for (let z = 0; z < 2; z++) {
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 2; x++) {
        const w = (x ? f[0] : 1 - f[0]) * (y ? f[1] : 1 - f[1]) * (z ? f[2] : 1 - f[2]);
        const idx = (((lo[2] + z) * size + lo[1] + y) * size + lo[0] + x) * 4;
        for (let k = 0; k < 3; k++) out[k] += lut[idx + k] * w;
      }
    }
  }
  return out;
}

function postEffects(rgb, p) {
  let v = rgb.map((val, k) => {
    const tempScale = k === 0 ? 1 + (p.temperature || 0) * 0.002 : (k === 2 ? 1 - (p.temperature || 0) * 0.002 : 1);
    return encodeSRGB(decodeSRGB(Math.max(0, val)) * (2 ** (p.exposure || 0)) * tempScale);
  });
  v = v.map((x) => (x - 0.5) * (1 + (p.contrast || 0) / 100) + 0.5);
  const y = v[0] * 0.2126 + v[1] * 0.7152 + v[2] * 0.0722;
  v = v.map((x) => y + (x - y) * (1 + (p.saturation || 0) / 100));
  return v.map((x) => clamp(x));
}

function hash2D(x, y) {
  let a = Math.imul(x ^ 7321, 374761393) ^ Math.imul(y ^ 1987, 668265263);
  a = Math.imul(a ^ (a >>> 13), 1274126177);
  return ((a ^ (a >>> 16)) >>> 0) / 4294967295;
}

export function renderPassthrough({ floatRGB, width, height, params: p }) {
  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const x = i % width;
    const y = (i / width) | 0;
    const u = x / width;
    const v = y / height;
    const vig = 1 - ((p.vignette || 0) / 100) * clamp((((u - 0.5) ** 2) + ((v - 0.5) ** 2)) * 1.5);
    const rgb = postEffects([floatRGB[i * 3], floatRGB[i * 3 + 1], floatRGB[i * 3 + 2]], p);
    for (let k = 0; k < 3; k++) {
      out[i * 4 + k] = Math.round(clamp(rgb[k] * vig) * 255);
    }
    out[i * 4 + 3] = 255;
  }
  return out;
}

export function renderSpectralCPU({ floatRGB, width, height, params: p, lut }) {
  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  const gains = cameraGains(p);
  const mm = p.filmLongMm || 36;
  const dirs = Array.from({ length: 8 }, (_, i) => [Math.cos((i * Math.PI) / 4), Math.sin((i * Math.PI) / 4)]);
  const halationActive = (p.halation || 0) > 0;
  const halationRadius = width * 0.00185 * (35 / mm) * (p.antihalationRemoved ? 2.4 : 1);
  const grainAmount = ((p.grain || 0) / 100) * 0.085;
  const cell = (3200 / (p.format === '120' ? 1 : 1.8)) * (35 / mm);
  const chroma = (p.grainChroma || 0) / 100;

  const sampleLin = (sx, sy) => {
    const cx = clamp(Math.round(sx), 0, width - 1);
    const cy = clamp(Math.round(sy), 0, height - 1);
    const idx = (cy * width + cx) * 3;
    return [
      decodeSRGB(floatRGB[idx]) * gains[0],
      decodeSRGB(floatRGB[idx + 1]) * gains[1],
      decodeSRGB(floatRGB[idx + 2]) * gains[2]
    ];
  };

  for (let i = 0; i < n; i++) {
    const x = i % width;
    const y = (i / width) | 0;
    const u = x / width;
    const v = y / height;
    let lin = [
      decodeSRGB(floatRGB[i * 3]) * gains[0],
      decodeSRGB(floatRGB[i * 3 + 1]) * gains[1],
      decodeSRGB(floatRGB[i * 3 + 2]) * gains[2]
    ];

    if (halationActive) {
      const glow = [0, 0, 0];
      for (const [dx, dy] of dirs) {
        const s = sampleLin(x + dx * halationRadius, y + dy * halationRadius);
        for (let k = 0; k < 3; k++) glow[k] += Math.max(0, s[k] - 0.35) / 8;
      }
      const mult = (p.halation / 100) * (p.antihalationRemoved ? 3.5 : 1);
      lin = [
        lin[0] + glow[0] * 0.65 * mult,
        lin[1] + glow[1] * 0.12 * mult,
        lin[2] + glow[2] * 0.01 * mult
      ];
    }

    let rgb = sampleLUT(lut, lin, LUT_SIZE);
    rgb = postEffects(rgb, p);

    if (grainAmount > 0) {
      const nx = Math.floor(u * cell);
      const ny = Math.floor(v * cell * (height / width));
      const noise = hash2D(nx, ny) - 0.5;
      const ns = [
        noise,
        noise * (1 - chroma) + (hash2D(nx + 97, ny + 53) - 0.5) * chroma,
        noise * (1 - chroma) + (hash2D(nx + 31, ny + 17) - 0.5) * chroma
      ];
      rgb = rgb.map((c, k) => c + ns[k] * grainAmount);
    }

    const vig = 1 - ((p.vignette || 0) / 100) * clamp((((u - 0.5) ** 2) + ((v - 0.5) ** 2)) * 1.5);
    for (let k = 0; k < 3; k++) {
      out[i * 4 + k] = Math.round(clamp(rgb[k] * vig) * 255);
    }
    out[i * 4 + 3] = 255;
  }

  return out;
}
