/* SPDX-License-Identifier: GPL-3.0-or-later */
import { normalizeBaseUrl } from './catalog.js';

const RAW_FILE_RE = /\.(dng|arw|cr2|cr3|nef|nrw|raf|rw2|orf|pef|srw|raw)$/i;

export function isRawFile(file) {
  if (!file?.name) return false;
  return RAW_FILE_RE.test(file.name);
}

export function rawDecodeOptions(full = false) {
  // libraw-wasm 1.6.0 requires gamm length 6; [1,1,0,0,0,0] keeps linear scene output.
  return {
    useCameraWb: true,
    useAutoWb: false,
    useCameraMatrix: 1,
    outputColor: 4, // ProPhoto RGB
    outputBps: 16,
    halfSize: !full,
    userQual: 3,
    highlight: 0,
    gamm: [1, 1, 0, 0, 0, 0],
    noAutoBright: true,
    noAutoScale: false,
    adjustMaximumThr: 0,
    bright: 1,
    expCorrec: false,
    threshold: 0,
    medPasses: 0
  };
}

function getAbsBaseUrl(baseUrl) {
  const base = normalizeBaseUrl(baseUrl || import.meta.env.BASE_URL || '/');
  if (typeof window !== 'undefined' && window.location?.origin) {
    return new URL(base, window.location.origin).href;
  }
  return base;
}

function formatExifDateTime(ts) {
  if (!(ts instanceof Date) || Number.isNaN(ts.getTime())) return null;
  const yyyy = ts.getFullYear();
  const mm = String(ts.getMonth() + 1).padStart(2, '0');
  const dd = String(ts.getDate()).padStart(2, '0');
  const hh = String(ts.getHours()).padStart(2, '0');
  const mi = String(ts.getMinutes()).padStart(2, '0');
  const ss = String(ts.getSeconds()).padStart(2, '0');
  return `${yyyy}:${mm}:${dd} ${hh}:${mi}:${ss}`;
}

function formatShutter(shutter) {
  if (typeof shutter !== 'number' || !Number.isFinite(shutter) || shutter <= 0) return null;
  return shutter < 1 ? `1/${Math.round(1 / shutter)}s` : `${shutter.toFixed(1)}s`;
}

function buildDisplayPreviewFromProPhoto16(rgb16, width, height, channels, maxEdge = 1600) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(outW, outH);
  const dst = imgData.data;

  const encode = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * (c ** (1 / 2.4)) - 0.055);
  const shoulder = (v) => v / (1 + 0.35 * Math.max(0, v - 0.7));

  for (let y = 0; y < outH; y++) {
    const sy = Math.min(height - 1, Math.floor(((y + 0.5) / outH) * height));
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(width - 1, Math.floor(((x + 0.5) / outW) * width));
      const srcIdx = (sy * width + sx) * channels;
      const pr = rgb16[srcIdx] / 65535;
      const pg = rgb16[srcIdx + 1] / 65535;
      const pb = rgb16[srcIdx + 2] / 65535;

      // Linear ProPhoto RGB (D50) -> Linear sRGB (D65)
      const lr = Math.max(0, 2.034193 * pr - 0.727420 * pg - 0.306766 * pb);
      const lg = Math.max(0, -0.228811 * pr + 1.231729 * pg - 0.002922 * pb);
      const lb = Math.max(0, -0.008565 * pr - 0.153273 * pg + 1.161839 * pb);

      const dstIdx = (y * outW + x) * 4;
      dst[dstIdx] = Math.round(Math.min(1, Math.max(0, encode(shoulder(lr)))) * 255);
      dst[dstIdx + 1] = Math.round(Math.min(1, Math.max(0, encode(shoulder(lg)))) * 255);
      dst[dstIdx + 2] = Math.round(Math.min(1, Math.max(0, encode(shoulder(lb)))) * 255);
      dst[dstIdx + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.92);
}

export async function decodeRawFile(file, { full = false, baseUrl } = {}) {
  if (typeof window === 'undefined' || !window.crossOriginIsolated) {
    throw new Error('当前浏览环境未开启安全隔离，暂不支持直接解码 RAW 原片（建议使用 HTTPS 桌面浏览器或 Safari 打开）');
  }

  const absBaseUrl = getAbsBaseUrl(baseUrl);
  const { default: LibRaw } = await import(/* @vite-ignore */ `${absBaseUrl}spektra/vendor/libraw/index.js`);
  const raw = new LibRaw();
  const timer = setTimeout(() => raw.dispose(), 180000);

  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    await raw.open(buf, rawDecodeOptions(full));
    const [metadata, image] = await Promise.all([raw.metadata(), raw.imageData()]);

    if (!image?.data || image.colors < 3) {
      throw new Error('RAW 文件未返回有效的图像数据');
    }
    if (image.bits !== 16 || !(image.data instanceof Uint16Array)) {
      throw new Error('RAW 解码器未返回 16 位传感器数据');
    }

    const previewSrc = buildDisplayPreviewFromProPhoto16(
      image.data,
      image.width,
      image.height,
      image.colors,
      1600
    );

    const make = metadata?.make || metadata?.camera_make || '';
    const model = metadata?.model || metadata?.camera_model || '';
    const device = [make, model]
      .filter(Boolean)
      .join(' ')
      .replace(/^(\S+)\s+\1\b/i, '$1')
      .trim() || null;

    const exif = {
      dateTime: formatExifDateTime(metadata?.timestamp),
      device,
      make: make || null,
      iso: metadata?.iso_speed || null,
      aperture: metadata?.aperture ? `f/${metadata.aperture}` : null,
      shutter: formatShutter(metadata?.shutter),
      gps: null
    };

    return {
      previewSrc,
      width: image.width,
      height: image.height,
      exif,
      rawData: {
        rgb16: image.data,
        width: image.width,
        height: image.height,
        channels: image.colors,
        sourceColorSpace: 'ProPhoto RGB',
        sourceEncoded: false,
        isFullRaw: full
      }
    };
  } finally {
    clearTimeout(timer);
    raw.dispose();
  }
}
