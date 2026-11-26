import piexif from 'piexifjs';

const getPiexif = () => (piexif?.load ? piexif : (piexif?.default || piexif));

export const ASPECT_RATIOS = [
  { id: '3:4', label: '3:4', tag: '小红书竖图', w: 3, h: 4 },
  { id: '4:5', label: '4:5', tag: 'INS 竖版', w: 4, h: 5 },
  { id: '1:1', label: '1:1', tag: '经典方图', w: 1, h: 1 },
  { id: '9:16', label: '9:16', tag: '故事全屏', w: 9, h: 16 },
  { id: '4:3', label: '4:3', tag: '相机横图', w: 4, h: 3 },
  { id: '16:9', label: '16:9', tag: '电影宽屏', w: 16, h: 9 }
];

export const BASIC_ADJUST_DEFAULTS = {
  rotation: 0,
  flipH: false,
  flipV: false,
  straighten: 0,
  cropAspect: 'original',
  brightness: 0,
  contrast: 0,
  saturation: 0,
  warmth: 0,
  sharpen: 0,
  vignette: 0
};

export const CLUTTER_QUICK_PRESETS = [
  '背景路人',
  '天空电线',
  '桌面杂物',
  '垃圾桶/标识牌',
  '文字/水印',
  '玻璃反光'
];

export function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (src && !src.startsWith('data:')) {
      img.crossOrigin = 'anonymous';
    }
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(err || new Error('图片加载失败'));
    img.src = src;
  });
}

export function reinsertExifClient(dataUrl, exif) {
  if (!dataUrl || !exif) return dataUrl;
  const piexifLib = getPiexif();
  if (!piexifLib?.insert || !piexifLib?.load || !piexifLib?.dump) return dataUrl;
  if (!dataUrl.startsWith('data:image/jpeg')) return dataUrl;

  try {
    if (exif.rawBytes) {
      const exifObj = piexifLib.load(exif.rawBytes);
      exifObj['0th'] = exifObj['0th'] || {};
      exifObj['0th'][piexifLib.ImageIFD.Orientation] = 1;
      exifObj['0th'][piexifLib.ImageIFD.Software] = 'Shantie AI Studio';
      delete exifObj['thumbnail'];
      const dumped = piexifLib.dump(exifObj);
      return piexifLib.insert(dumped, dataUrl);
    }

    const exifObj = { '0th': {}, Exif: {}, GPS: {}, '1st': {}, thumbnail: null };
    exifObj['0th'][piexifLib.ImageIFD.Orientation] = 1;
    exifObj['0th'][piexifLib.ImageIFD.Software] = 'Shantie AI Studio';
    if (exif.device) exifObj['0th'][piexifLib.ImageIFD.Model] = String(exif.device);
    if (exif.make) exifObj['0th'][piexifLib.ImageIFD.Make] = String(exif.make);
    if (exif.dateTime) exifObj.Exif[piexifLib.ExifIFD.DateTimeOriginal] = String(exif.dateTime);

    if (exif.gps && !isNaN(parseFloat(exif.gps.lat)) && !isNaN(parseFloat(exif.gps.lon))) {
      const toDMS = (deg) => {
        const abs = Math.abs(deg);
        const d = Math.floor(abs);
        const minFloat = (abs - d) * 60;
        const m = Math.floor(minFloat);
        const s = Math.round((minFloat - m) * 60 * 100);
        return [[d, 1], [m, 1], [s, 100]];
      };
      const lat = parseFloat(exif.gps.lat);
      const lon = parseFloat(exif.gps.lon);
      exifObj.GPS[piexifLib.GPSIFD.GPSLatitude] = toDMS(lat);
      exifObj.GPS[piexifLib.GPSIFD.GPSLatitudeRef] = exif.gps.latRef || (lat >= 0 ? 'N' : 'S');
      exifObj.GPS[piexifLib.GPSIFD.GPSLongitude] = toDMS(lon);
      exifObj.GPS[piexifLib.GPSIFD.GPSLongitudeRef] = exif.gps.lonRef || (lon >= 0 ? 'E' : 'W');
    }

    const dumped = piexifLib.dump(exifObj);
    return piexifLib.insert(dumped, dataUrl);
  } catch (err) {
    console.warn('[EditExif] Failed to reinsert EXIF:', err);
    return dataUrl;
  }
}

export function parseAspectId(ratioId) {
  const found = ASPECT_RATIOS.find((r) => r.id === ratioId);
  if (found) return { w: found.w, h: found.h };
  const parts = String(ratioId || '3:4').split(':').map(Number);
  if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) {
    return { w: parts[0], h: parts[1] };
  }
  return { w: 3, h: 4 };
}

export function computeOutpaintLayout(origW, origH, targetRatioId, anchor = 'center', zoomOut = 1.0) {
  const safeW = Math.max(1, origW || 1000);
  const safeH = Math.max(1, origH || 1000);
  const origRatio = safeW / safeH;
  const { w: rw, h: rh } = parseAspectId(targetRatioId);
  const targetRatio = rw / rh;
  const zoom = Math.min(1.5, Math.max(1.0, Number(zoomOut) || 1.0));

  let baseInnerW;
  let baseInnerH;
  if (targetRatio > origRatio) {
    // Target is wider than original -> horizontal extension
    baseInnerH = 1.0;
    baseInnerW = origRatio / targetRatio;
  } else {
    // Target is taller than original -> vertical extension
    baseInnerW = 1.0;
    baseInnerH = targetRatio / origRatio;
  }

  const innerW = Math.min(1.0, baseInnerW / zoom);
  const innerH = Math.min(1.0, baseInnerH / zoom);

  const slackX = Math.max(0, 1.0 - innerW);
  const slackY = Math.max(0, 1.0 - innerH);

  let innerX = slackX / 2;
  let innerY = slackY / 2;
  if (anchor === 'top') innerY = 0;
  else if (anchor === 'bottom') innerY = slackY;
  else if (anchor === 'left') innerX = 0;
  else if (anchor === 'right') innerX = slackX;

  let axis = 'all';
  let directionLabel = '四周扩视野';
  if (zoom <= 1.02) {
    if (Math.abs(targetRatio - origRatio) < 0.03) {
      axis = 'all';
      directionLabel = '比例基本一致';
    } else if (targetRatio > origRatio) {
      axis = 'horizontal';
      directionLabel = '左右延展';
    } else {
      axis = 'vertical';
      directionLabel = '上下延展';
    }
  } else if (targetRatio > origRatio * 1.04) {
    axis = 'horizontal';
    directionLabel = '左右+四周延展';
  } else if (targetRatio < origRatio * 0.96) {
    axis = 'vertical';
    directionLabel = '上下+四周延展';
  }

  return {
    origRatio,
    targetRatio,
    innerX,
    innerY,
    innerW,
    innerH,
    axis,
    directionLabel
  };
}

export async function applyLocalAspectTransform(src, { targetAspect = '3:4', mode = 'crop', anchor = 'center', padBg = 'blur', exif = null } = {}) {
  const img = await loadImageElement(src);
  const origW = img.naturalWidth || img.width;
  const origH = img.naturalHeight || img.height;
  const origRatio = origW / origH;
  const { w: rw, h: rh } = parseAspectId(targetAspect);
  const targetRatio = rw / rh;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  if (mode === 'crop') {
    let sx = 0;
    let sy = 0;
    let sw = origW;
    let sh = origH;

    if (origRatio > targetRatio) {
      sw = Math.round(origH * targetRatio);
      const slack = origW - sw;
      sx = anchor === 'left' ? 0 : anchor === 'right' ? slack : Math.round(slack / 2);
    } else if (origRatio < targetRatio) {
      sh = Math.round(origW / targetRatio);
      const slack = origH - sh;
      sy = anchor === 'top' ? 0 : anchor === 'bottom' ? slack : Math.round(slack / 2);
    }

    canvas.width = Math.max(1, sw);
    canvas.height = Math.max(1, sh);
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  } else {
    // Pad / border fit mode
    let outW = origW;
    let outH = origH;
    if (origRatio > targetRatio) {
      outW = Math.round(origW * 1.06);
      outH = Math.round(outW / targetRatio);
    } else {
      outH = Math.round(origH * 1.06);
      outW = Math.round(outH * targetRatio);
    }
    const maxLong = 2400;
    if (Math.max(outW, outH) > maxLong) {
      const s = maxLong / Math.max(outW, outH);
      outW = Math.round(outW * s);
      outH = Math.round(outH * s);
    }

    canvas.width = Math.max(1, outW);
    canvas.height = Math.max(1, outH);

    if (padBg === 'white') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, outW, outH);
    } else if (padBg === 'dark') {
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, outW, outH);
    } else {
      // Blurred enlarged background
      ctx.save();
      const coverScale = Math.max(outW / origW, outH / origH) * 1.12;
      const bw = origW * coverScale;
      const bh = origH * coverScale;
      ctx.filter = `blur(${Math.max(18, Math.round(Math.max(outW, outH) * 0.025))}px) brightness(0.86)`;
      ctx.drawImage(img, (outW - bw) / 2, (outH - bh) / 2, bw, bh);
      ctx.restore();
    }

    const marginFactor = padBg === 'blur' ? 0.94 : 0.9;
    const fitScale = Math.min((outW * marginFactor) / origW, (outH * marginFactor) / origH);
    const dw = Math.round(origW * fitScale);
    const dh = Math.round(origH * fitScale);
    const dx = Math.round((outW - dw) / 2);
    const dy = Math.round((outH - dh) / 2);

    ctx.save();
    if (padBg === 'blur') {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.36)';
      ctx.shadowBlur = Math.round(Math.max(outW, outH) * 0.02);
      ctx.shadowOffsetY = Math.round(Math.max(outW, outH) * 0.008);
    }
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.restore();
  }

  const rawDataUrl = canvas.toDataURL('image/jpeg', 0.94);
  const dataUrl = reinsertExifClient(rawDataUrl, exif);
  return { dataUrl, width: canvas.width, height: canvas.height };
}

export function analyzeMaskCoverage(maskCanvas) {
  if (!maskCanvas || !maskCanvas.width || !maskCanvas.height) return 0;
  try {
    const sampleSize = 64;
    const tmp = document.createElement('canvas');
    tmp.width = sampleSize;
    tmp.height = sampleSize;
    const tctx = tmp.getContext('2d');
    tctx.drawImage(maskCanvas, 0, 0, sampleSize, sampleSize);
    const { data } = tctx.getImageData(0, 0, sampleSize, sampleSize);
    let fg = 0;
    const total = sampleSize * sampleSize;
    for (let i = 0; i < total; i++) {
      if (data[i * 4 + 3] > 128) fg++;
    }
    return fg / total;
  } catch {
    return 0;
  }
}

export async function renderLocalDepthBlur(src, options = {}) {
  const {
    mode = 'background', // 'background' | 'foreground' | 'tilt-shift'
    strength = 55,
    feather = 50,
    bokehHighlight = 25,
    focusX = 0.5,
    focusY = 0.5,
    focusSize = 0.34,
    usePortraitMask = true,
    subjectMask = null,
    maxEdge = 1600,
    exif = null
  } = options;

  const img = await loadImageElement(src);
  const origW = img.naturalWidth || img.width;
  const origH = img.naturalHeight || img.height;
  const scale = maxEdge && Math.max(origW, origH) > maxEdge
    ? maxEdge / Math.max(origW, origH)
    : 1;
  const w = Math.max(1, Math.round(origW * scale));
  const h = Math.max(1, Math.round(origH * scale));

  // 1. Sharp layer
  const sharpCanvas = document.createElement('canvas');
  sharpCanvas.width = w;
  sharpCanvas.height = h;
  const sharpCtx = sharpCanvas.getContext('2d');
  sharpCtx.drawImage(img, 0, 0, w, h);

  // 2. Optical blur layer
  const blurRadius = Math.max(1, (strength / 100) * Math.max(w, h) * 0.028);
  const blurCanvas = document.createElement('canvas');
  blurCanvas.width = w;
  blurCanvas.height = h;
  const blurCtx = blurCanvas.getContext('2d');
  blurCtx.save();
  // Slight scale-up on blurred layer avoids dark edge bleeding from canvas border
  blurCtx.filter = `blur(${blurRadius.toFixed(1)}px) brightness(${(1 + (bokehHighlight / 100) * 0.06).toFixed(3)}) saturate(${(1 + (bokehHighlight / 100) * 0.14).toFixed(3)})`;
  const pad = Math.ceil(blurRadius * 2);
  blurCtx.drawImage(img, -pad, -pad, w + pad * 2, h + pad * 2);
  blurCtx.restore();

  // Subtle specular highlight bloom on blurred layer
  if (bokehHighlight > 10) {
    blurCtx.save();
    blurCtx.globalCompositeOperation = 'lighter';
    blurCtx.globalAlpha = (bokehHighlight / 100) * 0.16;
    blurCtx.filter = `blur(${(blurRadius * 1.4).toFixed(1)}px) contrast(1.4)`;
    blurCtx.drawImage(img, -pad, -pad, w + pad * 2, h + pad * 2);
    blurCtx.restore();
  }

  // 3. Build Blur Mask (opaque white = show BLUR layer, transparent = show SHARP layer)
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = w;
  maskCanvas.height = h;
  const mctx = maskCanvas.getContext('2d');

  let usedPortraitMask = false;
  const coverage = subjectMask ? analyzeMaskCoverage(subjectMask) : 0;
  const portraitValid = Boolean(usePortraitMask && subjectMask && coverage >= 0.02 && coverage <= 0.92 && mode !== 'tilt-shift');

  if (portraitValid) {
    usedPortraitMask = true;
    const featherPx = Math.max(1, Math.round((feather / 100) * Math.max(w, h) * 0.022));
    if (mode === 'background') {
      // Blur background = opaque white everywhere EXCEPT subjectMask
      mctx.fillStyle = '#ffffff';
      mctx.fillRect(0, 0, w, h);
      mctx.save();
      mctx.globalCompositeOperation = 'destination-out';
      mctx.filter = `blur(${featherPx}px)`;
      mctx.drawImage(subjectMask, 0, 0, w, h);
      mctx.restore();
    } else {
      // Blur foreground = blur subjectMask, keep background sharp
      mctx.save();
      mctx.filter = `blur(${featherPx}px)`;
      mctx.drawImage(subjectMask, 0, 0, w, h);
      mctx.restore();
    }
  } else if (mode === 'tilt-shift') {
    const cy = focusY * h;
    const halfBand = Math.max(h * 0.08, focusSize * h * 0.55);
    const featherSpan = Math.max(h * 0.06, (feather / 100) * h * 0.38);
    const topEnd = Math.max(0, cy - halfBand);
    const topStart = Math.max(0, topEnd - featherSpan);
    const botStart = Math.min(h, cy + halfBand);
    const botEnd = Math.min(h, botStart + featherSpan);

    const grad = mctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(Math.min(1, topStart / h), 'rgba(255,255,255,1)');
    grad.addColorStop(Math.min(1, topEnd / h), 'rgba(255,255,255,0)');
    grad.addColorStop(Math.min(1, botStart / h), 'rgba(255,255,255,0)');
    grad.addColorStop(Math.min(1, botEnd / h), 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,1)');
    mctx.fillStyle = grad;
    mctx.fillRect(0, 0, w, h);
  } else {
    // Radial depth gradient centered at (focusX, focusY)
    const cx = focusX * w;
    const cy = focusY * h;
    const baseDim = Math.min(w, h);
    const innerR = Math.max(baseDim * 0.06, focusSize * baseDim * 0.6);
    const outerR = innerR + Math.max(baseDim * 0.08, (feather / 100) * baseDim * 0.58);

    const grad = mctx.createRadialGradient(cx, cy, innerR, cx, cy, outerR);
    if (mode === 'background') {
      // Center (focus point) is sharp (alpha 0), outer area is blurred (alpha 1)
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.55, 'rgba(255,255,255,0.55)');
      grad.addColorStop(1, 'rgba(255,255,255,1)');
    } else {
      // Foreground blur mode: focus point / foreground area is blurred (alpha 1), distant background stays sharp (alpha 0)
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.55, 'rgba(255,255,255,0.45)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
    }
    mctx.fillStyle = grad;
    mctx.fillRect(0, 0, w, h);
  }

  // Apply mask onto blur layer
  blurCtx.save();
  blurCtx.globalCompositeOperation = 'destination-in';
  blurCtx.drawImage(maskCanvas, 0, 0, w, h);
  blurCtx.restore();

  // Composite blurred masked layer over sharp base
  const outCanvas = document.createElement('canvas');
  outCanvas.width = w;
  outCanvas.height = h;
  const octx = outCanvas.getContext('2d');
  octx.drawImage(sharpCanvas, 0, 0);
  octx.drawImage(blurCanvas, 0, 0);

  const rawDataUrl = outCanvas.toDataURL('image/jpeg', 0.94);
  const dataUrl = maxEdge ? rawDataUrl : reinsertExifClient(rawDataUrl, exif);
  return { dataUrl, width: w, height: h, usedPortraitMask };
}

function applyUnsharpMask(ctx, w, h, amount) {
  if (amount <= 0) return;
  const imgData = ctx.getImageData(0, 0, w, h);
  const src = imgData.data;
  const out = new Uint8ClampedArray(src.length);
  const strength = (amount / 100) * 1.1;

  for (let y = 0; y < h; y++) {
    const yPrev = y > 0 ? y - 1 : 0;
    const yNext = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      const xPrev = x > 0 ? x - 1 : 0;
      const xNext = x < w - 1 ? x + 1 : w - 1;
      const idx = (y * w + x) * 4;
      const top = (yPrev * w + x) * 4;
      const bot = (yNext * w + x) * 4;
      const left = (y * w + xPrev) * 4;
      const right = (y * w + xNext) * 4;

      for (let c = 0; c < 3; c++) {
        const avg = (src[top + c] + src[bot + c] + src[left + c] + src[right + c]) * 0.25;
        const val = src[idx + c] + (src[idx + c] - avg) * strength;
        out[idx + c] = val < 0 ? 0 : val > 255 ? 255 : val;
      }
      out[idx + 3] = src[idx + 3];
    }
  }
  imgData.data.set(out);
  ctx.putImageData(imgData, 0, 0);
}

export async function renderBasicAdjustments(src, params = {}, { maxEdge = null, exif = null } = {}) {
  const {
    rotation = 0,
    flipH = false,
    flipV = false,
    straighten = 0,
    cropAspect = 'original',
    brightness = 0,
    contrast = 0,
    saturation = 0,
    warmth = 0,
    sharpen = 0,
    vignette = 0
  } = params;

  const img = await loadImageElement(src);
  const origW = img.naturalWidth || img.width;
  const origH = img.naturalHeight || img.height;

  // Step 1: 90-degree rotation + flip + straighten
  const normRot = ((rotation % 360) + 360) % 360;
  const swapAxes = normRot === 90 || normRot === 270;
  const rotW = swapAxes ? origH : origW;
  const rotH = swapAxes ? origW : origH;

  const scale = maxEdge && Math.max(rotW, rotH) > maxEdge
    ? maxEdge / Math.max(rotW, rotH)
    : 1;
  const workW = Math.max(1, Math.round(rotW * scale));
  const workH = Math.max(1, Math.round(rotH * scale));

  const geoCanvas = document.createElement('canvas');
  geoCanvas.width = workW;
  geoCanvas.height = workH;
  const gctx = geoCanvas.getContext('2d');

  // Inscribed zoom for straighten angle so corners never show black triangles
  const rad = (Number(straighten) || 0) * (Math.PI / 180);
  const absCos = Math.abs(Math.cos(rad));
  const absSin = Math.abs(Math.sin(rad));
  const autoZoom = rad === 0 ? 1 : Math.max(
    (workW * absCos + workH * absSin) / workW,
    (workW * absSin + workH * absCos) / workH
  );

  gctx.save();
  gctx.translate(workW / 2, workH / 2);
  gctx.scale(autoZoom, autoZoom);
  gctx.rotate(rad);
  gctx.rotate((normRot * Math.PI) / 180);
  gctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);

  const bPct = Math.max(20, 100 + brightness);
  const cPct = Math.max(20, 100 + contrast);
  const sPct = Math.max(0, 100 + saturation);
  gctx.filter = `brightness(${bPct}%) contrast(${cPct}%) saturate(${sPct}%)`;

  const drawW = Math.round(origW * scale);
  const drawH = Math.round(origH * scale);
  gctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
  gctx.restore();

  // Step 2: Optional aspect crop
  let finalW = workW;
  let finalH = workH;
  let sx = 0;
  let sy = 0;
  if (cropAspect && cropAspect !== 'original') {
    const { w: rw, h: rh } = parseAspectId(cropAspect);
    const targetRatio = rw / rh;
    const curRatio = workW / workH;
    if (curRatio > targetRatio) {
      finalW = Math.max(1, Math.round(workH * targetRatio));
      sx = Math.round((workW - finalW) / 2);
    } else if (curRatio < targetRatio) {
      finalH = Math.max(1, Math.round(workW / targetRatio));
      sy = Math.round((workH - finalH) / 2);
    }
  }

  const outCanvas = document.createElement('canvas');
  outCanvas.width = finalW;
  outCanvas.height = finalH;
  const octx = outCanvas.getContext('2d');
  octx.drawImage(geoCanvas, sx, sy, finalW, finalH, 0, 0, finalW, finalH);

  // Step 3: Warmth overlay
  if (warmth !== 0) {
    octx.save();
    octx.globalCompositeOperation = 'soft-light';
    octx.globalAlpha = Math.min(0.45, Math.abs(warmth) / 100);
    octx.fillStyle = warmth > 0 ? '#ffb347' : '#58a6ff';
    octx.fillRect(0, 0, finalW, finalH);
    octx.restore();
  }

  // Step 4: Sharpening
  if (sharpen > 0) {
    applyUnsharpMask(octx, finalW, finalH, sharpen);
  }

  // Step 5: Vignette
  if (vignette > 0) {
    const cx = finalW / 2;
    const cy = finalH / 2;
    const outerR = Math.hypot(cx, cy);
    const grad = octx.createRadialGradient(cx, cy, outerR * 0.38, cx, cy, outerR);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, `rgba(0,0,0,${Math.min(0.72, (vignette / 100) * 0.68)})`);
    octx.fillStyle = grad;
    octx.fillRect(0, 0, finalW, finalH);
  }

  const rawDataUrl = outCanvas.toDataURL('image/jpeg', 0.94);
  const dataUrl = maxEdge ? rawDataUrl : reinsertExifClient(rawDataUrl, exif);
  return { dataUrl, width: finalW, height: finalH };
}

export function buildBrushMaskDataUrl(strokes, width, height) {
  const w = Math.max(1, Math.round(width || 1024));
  const h = Math.max(1, Math.round(height || 1024));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const stroke of strokes || []) {
    const pts = stroke?.points || [];
    if (pts.length === 0) continue;
    // Slightly expand radius (+20%) relative to display stroke so edge artifacts are cleanly covered
    const baseSize = stroke.size || 28;
    const pxWidth = Math.max(10, baseSize * (Math.max(w, h) / 420) * 1.2);
    ctx.lineWidth = pxWidth;

    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x * w, pts[0].y * h, pxWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }

    ctx.beginPath();
    ctx.moveTo(pts[0].x * w, pts[0].y * h);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x * w, pts[i].y * h);
    }
    ctx.stroke();
  }

  return canvas.toDataURL('image/png');
}
