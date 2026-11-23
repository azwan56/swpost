/* SPDX-License-Identifier: GPL-3.0-or-later */
import piexif from 'piexifjs';
import { findFilm, loadSpektraCatalog, normalizeBaseUrl } from './catalog.js';
import { buildEngineParams } from './defaults.js';
import {
  applyExposureLeaks,
  applyLinearOverlayFromCanvas,
  decorateFilmEdge,
  prepareFilmGateCanvas,
  resampleRawGate,
  stampDate
} from './presentation.js';

const getPiexif = () => (piexif?.load ? piexif : (piexif?.default || piexif));

let worker = null;
let jobCounter = 0;
const pendingJobs = new Map();
let engineStatus = 'idle'; // 'idle' | 'loading' | 'wasm' | 'js-spectral' | 'error'
const statusListeners = new Set();
let initTriggered = false;

function getAbsBaseUrl() {
  const base = normalizeBaseUrl(import.meta.env.BASE_URL || '/');
  if (typeof window !== 'undefined' && window.location?.origin) {
    return new URL(base, window.location.origin).href;
  }
  return base;
}

function notifyStatus(next) {
  engineStatus = next;
  for (const fn of statusListeners) fn(next);
}

export function subscribeEngineStatus(listener) {
  statusListeners.add(listener);
  listener(engineStatus);
  return () => statusListeners.delete(listener);
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./spektra.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const job = pendingJobs.get(data.id);
    if (!job) return;
    clearTimeout(job.timer);
    pendingJobs.delete(data.id);
    if (data.error) {
      job.reject(new Error(data.error));
    } else {
      job.resolve(data);
    }
  };
  worker.onerror = (err) => {
    const msg = err?.message || '暗房渲染线程出错';
    for (const job of pendingJobs.values()) {
      clearTimeout(job.timer);
      job.reject(new Error(msg));
    }
    pendingJobs.clear();
    notifyStatus('error');
  };
  return worker;
}

function callWorker(message, transfer = [], timeoutMs = 120000) {
  const w = ensureWorker();
  return new Promise((resolve, reject) => {
    const id = ++jobCounter;
    const timer = setTimeout(() => {
      pendingJobs.delete(id);
      reject(new Error('胶片处理超时，请稍后重试'));
    }, timeoutMs);
    pendingJobs.set(id, { resolve, reject, timer });
    w.postMessage({ ...message, id }, transfer);
  });
}

export async function initSpektraEngine() {
  if (initTriggered && (engineStatus === 'wasm' || engineStatus === 'js-spectral')) {
    return engineStatus;
  }
  initTriggered = true;
  notifyStatus('loading');
  try {
    const absBaseUrl = getAbsBaseUrl();
    const [res] = await Promise.all([
      callWorker({ type: 'init', baseUrl: absBaseUrl }, [], 120000),
      loadSpektraCatalog(import.meta.env.BASE_URL || '/')
    ]);
    notifyStatus(res.engine || 'wasm');
    return res.engine;
  } catch (err) {
    console.warn('[SpektraClient] init failed:', err);
    notifyStatus('error');
    throw err;
  }
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (src && !src.startsWith('data:') && !src.startsWith('blob:')) {
      img.crossOrigin = 'anonymous';
    }
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('无法读取源图像'));
    img.src = src;
  });
}

function injectExifToDataUrl(dataUrl, exif) {
  try {
    const piexifLib = getPiexif();
    if (!piexifLib?.load || !piexifLib?.dump || !piexifLib?.insert) return dataUrl;
    let exifObj = null;

    if (exif?.rawBytes) {
      try {
        exifObj = piexifLib.load(exif.rawBytes);
        exifObj['0th'] = exifObj['0th'] || {};
        exifObj['0th'][piexifLib.ImageIFD.Orientation] = 1;
        exifObj['0th'][piexifLib.ImageIFD.Software] = 'Shantie AI · SpektraLab';
        delete exifObj.thumbnail;
      } catch {
        exifObj = null;
      }
    }

    if (!exifObj) {
      exifObj = {
        '0th': {
          [piexifLib.ImageIFD.Orientation]: 1,
          [piexifLib.ImageIFD.Software]: 'Shantie AI · SpektraLab'
        },
        Exif: {},
        GPS: {},
        Interop: {},
        '1st': {},
        thumbnail: null
      };
      if (exif) {
        if (exif.dateTime) {
          exifObj['0th'][piexifLib.ImageIFD.DateTime] = String(exif.dateTime);
          exifObj['Exif'][piexifLib.ExifIFD.DateTimeOriginal] = String(exif.dateTime);
          exifObj['Exif'][piexifLib.ExifIFD.DateTimeDigitized] = String(exif.dateTime);
        }
        if (exif.device) exifObj['0th'][piexifLib.ImageIFD.Model] = String(exif.device);
        if (exif.make) exifObj['0th'][piexifLib.ImageIFD.Make] = String(exif.make);
      }
    }

    if (exif?.gps && (!exifObj.GPS || !exifObj.GPS[piexifLib.GPSIFD.GPSLatitude])) {
      exifObj.GPS = exifObj.GPS || {};
      const latVal = parseFloat(exif.gps.lat);
      const lonVal = parseFloat(exif.gps.lon);
      if (!Number.isNaN(latVal) && !Number.isNaN(lonVal)) {
        const latAbs = Math.abs(latVal);
        const lonAbs = Math.abs(lonVal);
        const latDeg = Math.floor(latAbs);
        const latMin = Math.floor((latAbs - latDeg) * 60);
        const latSec = Math.round(((latAbs - latDeg) * 60 - latMin) * 60 * 100);
        const lonDeg = Math.floor(lonAbs);
        const lonMin = Math.floor((lonAbs - lonDeg) * 60);
        const lonSec = Math.round(((lonAbs - lonDeg) * 60 - lonMin) * 60 * 100);
        exifObj.GPS[piexifLib.GPSIFD.GPSVersionID] = [2, 2, 0, 0];
        exifObj.GPS[piexifLib.GPSIFD.GPSLatitude] = [[latDeg, 1], [latMin, 1], [latSec, 100]];
        exifObj.GPS[piexifLib.GPSIFD.GPSLatitudeRef] = exif.gps.latRef || (latVal >= 0 ? 'N' : 'S');
        exifObj.GPS[piexifLib.GPSIFD.GPSLongitude] = [[lonDeg, 1], [lonMin, 1], [lonSec, 100]];
        exifObj.GPS[piexifLib.GPSIFD.GPSLongitudeRef] = exif.gps.lonRef || (lonVal >= 0 ? 'E' : 'W');
      }
    }

    const bytes = piexifLib.dump(exifObj);
    return piexifLib.insert(bytes, dataUrl);
  } catch {
    return dataUrl;
  }
}

export async function renderSpektraImage(imageSrc, uiParams, exif = null, options = {}) {
  const {
    maxEdge = 1600,
    frameOffset = 0,
    preferInstant = false,
    quality = 0.96,
    rawData = null
  } = options;

  const catalog = await loadSpektraCatalog(import.meta.env.BASE_URL || '/');
  const stockInfo = findFilm(catalog, uiParams.film);

  let w;
  let h;
  let floatRGB;
  let sourceMeta;

  if (rawData?.rgb16) {
    const resampled = resampleRawGate(rawData, uiParams, maxEdge);
    w = resampled.width;
    h = resampled.height;
    floatRGB = resampled.floatRGB;
    applyLinearOverlayFromCanvas(floatRGB, w, h, uiParams, exif);
    sourceMeta = {
      sourceColorSpace: rawData.sourceColorSpace || 'ProPhoto RGB',
      sourceEncoded: rawData.sourceEncoded !== undefined ? rawData.sourceEncoded : false,
      origLongEdge: Math.max(rawData.width, rawData.height)
    };
  } else {
    const img = await loadImageElement(imageSrc);
    const gateCanvas = prepareFilmGateCanvas(img, uiParams, maxEdge);

    // Physical darkroom exposure order: expose date back & light leaks onto negative BEFORE film simulation
    stampDate(gateCanvas, uiParams, exif);
    applyExposureLeaks(gateCanvas, uiParams);

    w = gateCanvas.width;
    h = gateCanvas.height;
    const srcCtx = gateCanvas.getContext('2d', { willReadFrequently: true });
    const imgData = srcCtx.getImageData(0, 0, w, h).data;
    floatRGB = new Float32Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      floatRGB[i * 3] = imgData[i * 4] / 255;
      floatRGB[i * 3 + 1] = imgData[i * 4 + 1] / 255;
      floatRGB[i * 3 + 2] = imgData[i * 4 + 2] / 255;
    }
    sourceMeta = {
      sourceColorSpace: 'sRGB',
      sourceEncoded: true,
      origLongEdge: Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height)
    };
  }

  const engineParams = buildEngineParams(uiParams, w, h, stockInfo, sourceMeta);
  const absBaseUrl = getAbsBaseUrl();
  const res = await callWorker(
    {
      type: 'render',
      baseUrl: absBaseUrl,
      width: w,
      height: h,
      params: engineParams,
      pixels: floatRGB.buffer,
      preferInstant
    },
    [floatRGB.buffer]
  );

  if (res.engine === 'wasm' || res.engine === 'js-spectral') {
    notifyStatus(res.engine);
  }

  const outBytes = new Uint8ClampedArray(res.rgba);
  const developedCanvas = document.createElement('canvas');
  developedCanvas.width = w;
  developedCanvas.height = h;
  developedCanvas.getContext('2d').putImageData(new ImageData(outBytes, w, h), 0, 0);

  // Composite film strip rebate, sprocket perforations & edge print AFTER film simulation
  const framedCanvas = decorateFilmEdge(
    developedCanvas,
    uiParams,
    uiParams.film,
    Boolean(stockInfo?.monochrome),
    frameOffset
  );

  const rawDataUrl = framedCanvas.toDataURL('image/jpeg', quality);
  const dataUrl = injectExifToDataUrl(rawDataUrl, exif);

  return {
    dataUrl,
    engine: res.engine,
    width: framedCanvas.width,
    height: framedCanvas.height,
    renderedMaxEdge: maxEdge,
    filmLabel: stockInfo ? (stockInfo.id === 'none' ? '📷 胶片边框/日期' : `🎞️ ${stockInfo.shortName || stockInfo.name}`) : '🎞️ 胶片模拟'
  };
}
