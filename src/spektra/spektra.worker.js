/* SPDX-License-Identifier: GPL-3.0-or-later */
import { extractMaterialOptions } from './defaults.js';
import { buildSpectralLUT, renderPassthrough, renderSpectralCPU } from './spectralFallback.js';

let absBaseUrl = '/';
let wasmState = 'idle'; // 'idle' | 'loading' | 'ready' | 'failed'
let wasmModule = null;
let wasmInitPromise = null;
const wasmFSLoaded = new Set();
let preparedWasmKey = null;

const rawProfileCache = new Map();
const mergedProfileCache = new Map();
const fallbackLutCache = new Map();

function ensureBase(url) {
  const s = String(url || '/');
  return s.endsWith('/') ? s : `${s}/`;
}

async function fetchRawProfile(id) {
  if (!/^[a-z0-9_]+$/.test(id)) throw new Error(`无效胶片/相纸编号: ${id}`);
  if (!rawProfileCache.has(id)) {
    const res = await fetch(`${absBaseUrl}spektra/profiles/${id}.json`);
    if (!res.ok) throw new Error(`无法读取配置 ${id} (${res.status})`);
    rawProfileCache.set(id, await res.json());
  }
  return rawProfileCache.get(id);
}

async function fetchMergedProfile(id, seen = new Set()) {
  if (mergedProfileCache.has(id)) return mergedProfileCache.get(id);
  if (seen.has(id)) throw new Error(`配置存在循环引用: ${id}`);
  seen.add(id);
  const raw = await fetchRawProfile(id);
  if (raw.derived_from) {
    const base = await fetchMergedProfile(raw.derived_from, seen);
    const merged = {
      ...base,
      info: { ...base.info, ...raw.info, stock: id },
      metadata: { base: base.metadata, alias: raw.metadata },
      data: base.data
    };
    mergedProfileCache.set(id, merged);
    return merged;
  }
  mergedProfileCache.set(id, raw);
  return raw;
}

async function ensureWasmProfileInFS(id, seen = new Set()) {
  if (wasmFSLoaded.has(id) || seen.has(id)) return;
  seen.add(id);
  const raw = await fetchRawProfile(id);
  if (raw.derived_from) {
    await ensureWasmProfileInFS(raw.derived_from, seen);
  }
  if (raw.info?.target_print) {
    await ensureWasmProfileInFS(raw.info.target_print, seen);
  }
  wasmModule.FS.writeFile(`/resources/profiles/${id}.json`, JSON.stringify(raw));
  wasmFSLoaded.add(id);
}

async function initWasmEngine() {
  if (wasmState === 'ready' && wasmModule) return wasmModule;
  if (wasmState === 'failed') return null;
  if (!wasmInitPromise) {
    wasmState = 'loading';
    wasmInitPromise = (async () => {
      try {
        const vendorBase = `${absBaseUrl}spektra/vendor/`;
        const [coreImport, wasmRes, binRes, filtersRes] = await Promise.all([
          import(/* @vite-ignore */ `${vendorBase}core.mjs`),
          fetch(`${vendorBase}core.wasm`),
          fetch(`${vendorBase}spektrafilm_constants.bin`),
          fetch(`${vendorBase}neutral_print_filters.json`)
        ]);
        if (!wasmRes.ok || !binRes.ok || !filtersRes.ok) {
          throw new Error('SpektraLab WASM 资源下载失败');
        }
        const [wasmBinary, constantsBin, filtersBuf] = await Promise.all([
          wasmRes.arrayBuffer(),
          binRes.arrayBuffer(),
          filtersRes.arrayBuffer()
        ]);
        const createCore = coreImport.default;
        const m = await createCore({
          wasmBinary: new Uint8Array(wasmBinary),
          locateFile: (file) => `${vendorBase}${file}`
        });
        m.FS.mkdir('/resources');
        m.FS.mkdir('/resources/profiles');
        m.FS.writeFile('/resources/spektrafilm_constants.bin', new Uint8Array(constantsBin));
        m.FS.writeFile('/resources/neutral_print_filters.json', new Uint8Array(filtersBuf));
        const ok = m.ccall('spk_init', 'number', ['string'], ['/resources']);
        if (!ok) {
          const msg = m.UTF8ToString(m._spk_error());
          throw new Error(msg || 'spk_init failed');
        }
        wasmModule = m;
        wasmState = 'ready';
        return m;
      } catch (err) {
        console.warn('[SpektraWorker] WASM init failed, using JS spectral fallback:', err);
        wasmState = 'failed';
        return null;
      }
    })();
  }
  return wasmInitPromise;
}

async function runWasmFrame(floatRGB, width, height, params) {
  const m = wasmModule;
  const film = params.film;
  const paper = params.paper || 'none';
  const matOpts = extractMaterialOptions(params);
  const prepKey = JSON.stringify([film, paper, matOpts]);

  if (preparedWasmKey !== prepKey) {
    await ensureWasmProfileInFS(film);
    const paperToLoad = ['none', 'di'].includes(paper) ? 'kodak_portra_endura' : paper;
    await ensureWasmProfileInFS(paperToLoad);
    const ok = m.ccall(
      'spk_prepare',
      'number',
      ['string', 'string', 'string', 'string'],
      ['/resources', film, paper, JSON.stringify(matOpts)]
    );
    if (!ok) {
      throw new Error(m.UTF8ToString(m._spk_error()) || 'spk_prepare failed');
    }
    preparedWasmKey = prepKey;
  }

  const len = width * height * 3;
  if (floatRGB.length !== len) throw new Error('像素输入尺寸不匹配');
  const ptr = m._malloc(len * 4);
  if (!ptr) throw new Error('WASM 内存不足');
  try {
    m.HEAPF32.set(floatRGB, ptr / 4);
    const ok = m.ccall(
      'spk_frame',
      'number',
      ['number', 'number', 'number', 'number', 'string'],
      [ptr, ptr, width, height, JSON.stringify(params)]
    );
    if (!ok) {
      throw new Error(m.UTF8ToString(m._spk_error()) || 'spk_frame failed');
    }
    const resultFloats = m.HEAPF32.subarray(ptr / 4, ptr / 4 + len);
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = Math.round(Math.min(1, Math.max(0, resultFloats[i * 3])) * 255);
      rgba[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, resultFloats[i * 3 + 1])) * 255);
      rgba[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, resultFloats[i * 3 + 2])) * 255);
      rgba[i * 4 + 3] = 255;
    }
    return rgba;
  } finally {
    m._free(ptr);
  }
}

async function runFallbackFrame(floatRGB, width, height, params) {
  const filmId = params.film;
  const paperId = params.paper || 'none';
  const matOpts = extractMaterialOptions(params);
  const key = JSON.stringify([filmId, paperId, matOpts]);

  if (!fallbackLutCache.has(key)) {
    const [filmProf, paperProf] = await Promise.all([
      fetchMergedProfile(filmId),
      ['none', 'di'].includes(paperId) ? Promise.resolve(null) : fetchMergedProfile(paperId)
    ]);
    const lut = buildSpectralLUT(filmProf, paperProf, matOpts);
    fallbackLutCache.set(key, lut);
    if (fallbackLutCache.size > 10) {
      fallbackLutCache.delete(fallbackLutCache.keys().next().value);
    }
  }
  const lut = fallbackLutCache.get(key);
  return renderSpectralCPU({ floatRGB, width, height, params, lut });
}

async function handleMessage(data) {
  if (data.type === 'init') {
    absBaseUrl = ensureBase(data.baseUrl);
    const mod = await initWasmEngine();
    return {
      id: data.id,
      type: 'init',
      engine: mod ? 'wasm' : 'js-spectral'
    };
  }

  if (data.type === 'convert') {
    if (data.baseUrl) absBaseUrl = ensureBase(data.baseUrl);
    if (wasmState === 'idle') {
      await initWasmEngine();
    } else if (wasmState === 'loading' && wasmInitPromise) {
      await wasmInitPromise;
    }
    const input = new Float32Array(data.pixels);
    const srcSpace = data.source || 'ProPhoto RGB';
    const dstSpace = data.target || 'sRGB';
    const encoded = Boolean(data.encoded);

    if (wasmState === 'ready' && wasmModule) {
      const m = wasmModule;
      const n = input.length;
      const p = m._malloc(n * 4);
      const q = m._malloc(n * 4);
      if (!p || !q) {
        if (p) m._free(p);
        if (q) m._free(q);
        throw new Error('色彩转换内存不足');
      }
      try {
        m.HEAPF32.set(input, p / 4);
        const ok = m.ccall(
          'spk_convert',
          'number',
          ['number', 'number', 'number', 'string', 'string', 'number'],
          [p, q, n / 3, srcSpace, dstSpace, +encoded]
        );
        if (!ok) {
          throw new Error(m.UTF8ToString(m._spk_error()) || 'spk_convert failed');
        }
        const out = m.HEAPF32.slice(q / 4, q / 4 + n);
        return {
          id: data.id,
          type: 'convert',
          pixels: out.buffer
        };
      } finally {
        m._free(p);
        m._free(q);
      }
    }

    // JS fallback ProPhoto linear -> sRGB encoded
    const out = new Float32Array(input.length);
    const enc = (c) => (c <= 0.0031308 ? 12.92 * Math.max(0, c) : 1.055 * (Math.max(0, c) ** (1 / 2.4)) - 0.055);
    for (let i = 0; i < input.length; i += 3) {
      const r = input[i];
      const g = input[i + 1];
      const b = input[i + 2];
      const sr = 2.034193 * r - 0.727420 * g - 0.306766 * b;
      const sg = -0.228811 * r + 1.231729 * g - 0.002922 * b;
      const sb = -0.008565 * r - 0.153273 * g + 1.161839 * b;
      out[i] = Math.min(1, Math.max(0, enc(sr)));
      out[i + 1] = Math.min(1, Math.max(0, enc(sg)));
      out[i + 2] = Math.min(1, Math.max(0, enc(sb)));
    }
    return {
      id: data.id,
      type: 'convert',
      pixels: out.buffer
    };
  }

  if (data.type === 'render') {
    if (data.baseUrl) absBaseUrl = ensureBase(data.baseUrl);
    const { width, height, params, pixels } = data;
    const floatRGB = new Float32Array(pixels);

    if (params.film === 'none') {
      const rgba = renderPassthrough({ floatRGB, width, height, params });
      return {
        id: data.id,
        type: 'render',
        engine: 'passthrough',
        width,
        height,
        rgba: rgba.buffer
      };
    }

    // Trigger WASM initialization in background if not started; if ready use WASM, else fallback cleanly
    if (wasmState === 'idle') {
      await initWasmEngine();
    } else if (wasmState === 'loading' && wasmInitPromise && !data.preferInstant) {
      await wasmInitPromise;
    }

    if (wasmState === 'ready' && wasmModule) {
      try {
        const rgba = await runWasmFrame(floatRGB, width, height, params);
        return {
          id: data.id,
          type: 'render',
          engine: 'wasm',
          width,
          height,
          rgba: rgba.buffer
        };
      } catch (wasmErr) {
        console.warn('[SpektraWorker] WASM frame failed, retrying JS spectral:', wasmErr);
      }
    }

    const rgba = await runFallbackFrame(floatRGB, width, height, params);
    return {
      id: data.id,
      type: 'render',
      engine: 'js-spectral',
      width,
      height,
      rgba: rgba.buffer
    };
  }

  throw new Error(`未知工作指令: ${data.type}`);
}

let queue = Promise.resolve();
self.onmessage = (event) => {
  const { data } = event;
  queue = queue
    .then(() => handleMessage(data))
    .then((result) => {
      const transfer = [];
      if (result.rgba) transfer.push(result.rgba);
      if (result.pixels) transfer.push(result.pixels);
      self.postMessage(result, transfer);
    })
    .catch((err) => {
      self.postMessage({
        id: data?.id,
        error: err?.message || String(err)
      });
    });
};
