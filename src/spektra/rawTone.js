/* SPDX-License-Identifier: GPL-3.0-or-later */

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));

export function decodeSRGB(x) {
  if (x <= 0) return 0;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

const proPhotoLum = (r, g, b) => Math.max(0, 0.28804 * r + 0.71187 * g + 0.00009 * b);
const srgbLum = (r, g, b) => Math.max(0, 0.2126 * r + 0.7152 * g + 0.0722 * b);

/**
 * Normalizes exposure, recovers deep shadows on high-DR linear scenes without lifting blacks,
 * and applies a smooth C1 hue-preserving highlight shoulder prior to spectral film simulation.
 * Modifies `floatRGB` in place.
 */
export function conditionLinearScene(floatRGB, width, height, options = {}) {
  const {
    colorSpace = 'ProPhoto RGB',
    isRaw = false,
    metering = 'auto',
    exposureEV = 0,
    highlightProtect = 35,
    shadowLift = 0,
    isPositive = false
  } = options;

  const n = Math.min(Math.floor(floatRGB.length / 3), Math.max(1, (width | 0) * (height | 0)));
  const getLum = colorSpace === 'ProPhoto RGB' ? proPhotoLum : srgbLum;

  // 1. Subsample luminance statistics (~12k pixels)
  const step = Math.max(1, Math.floor(n / 12000));
  const ys = [];
  let logSum = 0;
  let logCnt = 0;
  for (let i = 0; i < n; i += step) {
    const idx = i * 3;
    const y = getLum(floatRGB[idx], floatRGB[idx + 1], floatRGB[idx + 2]);
    if (y > 1e-6) {
      ys.push(y);
      logSum += Math.log(y);
      logCnt += 1;
    }
  }
  ys.sort((a, b) => a - b);
  const pct = (q) => (ys.length ? ys[Math.min(ys.length - 1, Math.floor(ys.length * q))] : 0.184);
  const yLogMean = logCnt ? Math.exp(logSum / logCnt) : 0.184;
  const yP05 = pct(0.05);
  const yP50 = pct(0.5);
  const yP98 = pct(0.98);
  const drStops = Math.log2(Math.max(1e-5, yP98) / Math.max(1e-5, yP05));

  // 2. Exposure normalization by metering mode
  let baseGain = 1.0;
  if (metering === 'auto') {
    if (isRaw) {
      const refMid = Math.sqrt(Math.max(1e-5, yLogMean) * Math.max(1e-5, yP50));
      const targetMid = isPositive ? 0.125 : 0.145;
      const gMid = targetMid / refMid;
      const gCap = 1.6 / Math.max(1e-4, yP98);
      baseGain = clamp(gMid <= gCap ? gMid : Math.sqrt(gMid * gCap), 0.25, 24);
    } else {
      baseGain = 1.0;
    }
  } else if (metering === 'highlight') {
    const gHi = 0.62 / Math.max(1e-4, yP98);
    if (isRaw) {
      const refMid = Math.sqrt(Math.max(1e-5, yLogMean) * Math.max(1e-5, yP50));
      const gFloor = 0.065 / refMid;
      baseGain = clamp(Math.max(gHi, Math.min(gFloor, gHi * 2.2)), 0.2, 24);
    } else {
      baseGain = clamp(Math.min(1.0, gHi), 0.25, 1.0);
    }
  } else if (metering === 'average') {
    const refMid = Math.sqrt(Math.max(1e-5, yLogMean) * Math.max(1e-5, yP50));
    const targetMid = isPositive ? 0.145 : 0.165;
    const gMid = targetMid / refMid;
    const gCap = 2.4 / Math.max(1e-4, yP98);
    baseGain = clamp(gMid <= gCap ? gMid : Math.sqrt(gMid * gCap), 0.25, 24);
  } else {
    baseGain = 1.0;
  }

  const totalGain = baseGain * (2 ** Number(exposureEV || 0));
  const scaledP98 = yP98 * totalGain;

  // 3. Adaptive shadow toe recovery & C1 highlight shoulder
  const autoShadow = (isRaw && metering !== 'off' && drStops > 5.2)
    ? Math.min(0.65, (drStops - 5.2) * 0.14) * (isPositive ? 1.15 : 0.7)
    : 0;
  const userShadow = clamp(Number(shadowLift || 0) / 100, -0.5, 1.0);
  const shadowFactor = autoShadow + userShadow;

  const hp = clamp(Number(highlightProtect ?? 35) / 100, 0, 1);
  const knee = isPositive ? (0.28 - 0.16 * hp) : (0.36 - 0.22 * hp);
  const maxOut = isPositive ? (0.76 - 0.42 * hp) : (1.05 - 0.65 * hp);
  const activeShoulder = hp > 0.01 || (isRaw && metering !== 'off' && scaledP98 > maxOut * 0.85);
  const span = Math.max(0.06, maxOut - knee);

  if (Math.abs(totalGain - 1) < 1e-6 && !activeShoulder && Math.abs(shadowFactor) <= 0.005) {
    return { baseEV: 0, drStops };
  }

  const hasShadowAdj = Math.abs(shadowFactor) > 0.005;

  for (let i = 0; i < n; i++) {
    const idx = i * 3;
    let r = floatRGB[idx] * totalGain;
    let g = floatRGB[idx + 1] * totalGain;
    let b = floatRGB[idx + 2] * totalGain;
    const y = getLum(r, g, b);

    if (y > 1e-7) {
      let yOut = y;
      if (hasShadowAdj && yOut < 0.16) {
        const t = 1 - yOut / 0.16;
        const mult = shadowFactor >= 0
          ? (1 + shadowFactor * t * t * 2.4)
          : Math.max(0.25, 1 + shadowFactor * t * t * 0.8);
        yOut *= mult;
      }
      if (activeShoulder && yOut > knee) {
        const d = yOut - knee;
        yOut = knee + (span * d) / (d + span);
      }
      const s = yOut / y;
      r *= s;
      g *= s;
      b *= s;
    }

    floatRGB[idx] = Math.max(0, r);
    floatRGB[idx + 1] = Math.max(0, g);
    floatRGB[idx + 2] = Math.max(0, b);
  }

  return {
    baseEV: Math.log2(baseGain),
    drStops
  };
}
