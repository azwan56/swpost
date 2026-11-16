/* SPDX-License-Identifier: GPL-3.0-or-later */
import { EDGE_PRINT_MAP } from './catalog.js';

export const EDGE_FORMATS = {
  '135': { id: '135', label: '135 标准', w: 36, h: 24, gauge: '135', desc: '35mm 经典 3:2' },
  '135_half': { id: '135_half', label: '135 半格', w: 18, h: 24, gauge: '135', desc: '半格竖构图 3:4' },
  'xpan': { id: 'xpan', label: 'XPan 宽幅', w: 65, h: 24, gauge: '135', desc: '65×24 宽银幕' },
  '120_645': { id: '120_645', label: '120 · 645', w: 56, h: 41.5, gauge: '120', desc: '中画幅 4:3' },
  '120_6x6': { id: '120_6x6', label: '120 · 6×6', w: 56, h: 56, gauge: '120', desc: '哈苏 1:1 正方' },
  '120_6x7': { id: '120_6x7', label: '120 · 6×7', w: 69.5, h: 56, gauge: '120', desc: 'RB67 经典比例' }
};

const LCD_SEGMENTS = {
  '0': 'abcdef',
  '1': 'bc',
  '2': 'abged',
  '3': 'abgcd',
  '4': 'fgbc',
  '5': 'afgcd',
  '6': 'afgecd',
  '7': 'abc',
  '8': 'abcdefg',
  '9': 'abfgcd',
  '-': 'g'
};

const SEGMENT_RECTS = {
  a: [1, 0, 3.6, 0.95],
  b: [4.65, 0.95, 0.95, 3.6],
  c: [4.65, 5.65, 0.95, 3.6],
  d: [1, 9.25, 3.6, 0.95],
  e: [0, 5.65, 0.95, 3.6],
  f: [0, 0.95, 0.95, 3.6],
  g: [1, 4.6, 3.6, 0.95]
};

const DOT_MATRIX_GLYPHS = {
  '0': '111101101101111',
  '1': '010110010010111',
  '2': '111001111100111',
  '3': '111001111001111',
  '4': '101101111001001',
  '5': '111100111001111',
  '6': '111100111101111',
  '7': '111001001001001',
  '8': '111101111101111',
  '9': '111101111001111',
  '-': '000000111000000',
  '.': '000000000000010',
  ':': '000010000010000',
  "'": '010010000000000',
  ' ': '000000000000000'
};

export function parseExifDateParts(exif) {
  const raw = exif?.dateTime ? String(exif.dateTime).trim() : '';
  const match = raw.match(/(\d{4})[:\-/](\d{1,2})[:\-/](\d{1,2})/);
  if (match) {
    return {
      yyyy: match[1],
      yy: match[1].slice(-2),
      mm: match[2].padStart(2, '0'),
      dd: match[3].padStart(2, '0'),
      fromExif: true
    };
  }
  const now = new Date();
  const yyyy = String(now.getFullYear());
  return {
    yyyy,
    yy: yyyy.slice(-2),
    mm: String(now.getMonth() + 1).padStart(2, '0'),
    dd: String(now.getDate()).padStart(2, '0'),
    fromExif: false
  };
}

export function resolveStampText(params, exif) {
  const parts = parseExifDateParts(exif);
  let formattedDate = `'${parts.yy} ${parts.mm} ${parts.dd}`;
  if (params.dateFormat === 'ymd_dot') {
    formattedDate = `${parts.yyyy}.${parts.mm}.${parts.dd}`;
  } else if (params.dateFormat === 'ymd_dash') {
    formattedDate = `${parts.yyyy}-${parts.mm}-${parts.dd}`;
  }

  if (params.dateStyle === 'data') {
    if (params.dateSource === 'custom' && params.dateText?.trim()) {
      return params.dateText.trim();
    }
    let gpsStr = '';
    if (exif?.gps) {
      const lat = parseFloat(exif.gps.lat);
      const lon = parseFloat(exif.gps.lon);
      if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
        gpsStr = `${lat.toFixed(2)}°${exif.gps.latRef || 'N'} ${lon.toFixed(2)}°${exif.gps.lonRef || 'E'}`;
      }
    }
    const items = [exif?.device || exif?.make, formattedDate, gpsStr].filter(Boolean);
    return items.join(' · ') || formattedDate;
  }

  if (params.dateSource === 'custom' && params.dateText?.trim()) {
    return params.dateText.trim();
  }
  return formattedDate;
}

function drawLcdChar(ctx, ch, x, y, s) {
  if (ch === "'") {
    ctx.fillRect(x + 2.1 * s, y + 0.2 * s, 1.15 * s, 2.9 * s);
    return 4.5 * s;
  }
  if (ch === '.' || ch === ',') {
    ctx.fillRect(x + 0.8 * s, y + 8.8 * s, 1.3 * s, 1.4 * s);
    return 3.4 * s;
  }
  if (ch === ':') {
    ctx.fillRect(x + 0.8 * s, y + 2.8 * s, 1.2 * s, 1.2 * s);
    ctx.fillRect(x + 0.8 * s, y + 6.4 * s, 1.2 * s, 1.2 * s);
    return 3.4 * s;
  }
  if (ch === ' ') {
    return 4.2 * s;
  }
  if (ch === '/') {
    ctx.save();
    ctx.lineWidth = 1.0 * s;
    ctx.strokeStyle = ctx.fillStyle;
    ctx.beginPath();
    ctx.moveTo(x + 4.4 * s, y + 0.6 * s);
    ctx.lineTo(x + 1.0 * s, y + 9.6 * s);
    ctx.stroke();
    ctx.restore();
    return 6.2 * s;
  }
  const segs = LCD_SEGMENTS[ch];
  if (segs) {
    for (const key of segs) {
      const [dx, dy, w, h] = SEGMENT_RECTS[key];
      ctx.fillRect(x + dx * s, y + dy * s, w * s, h * s);
    }
    return 7.3 * s;
  }
  ctx.font = `700 ${9.8 * s}px ui-monospace, "SF Mono", Menlo, monospace`;
  ctx.fillText(ch, x, y);
  return 7.2 * s;
}

function measureLcdWidth(text, s) {
  let width = 0;
  for (const ch of text) {
    if (ch === "'") width += 4.5 * s;
    else if (ch === '.' || ch === ',' || ch === ':') width += 3.4 * s;
    else if (ch === ' ') width += 4.2 * s;
    else if (ch === '/') width += 6.2 * s;
    else width += 7.3 * s;
  }
  return Math.max(0, width - 1.5 * s);
}

export function stampDate(canvas, params, exif = null) {
  if (!params?.dateOn) return canvas;
  const text = resolveStampText(params, exif);
  if (!text) return canvas;

  const ctx = canvas.getContext('2d');
  const baseDim = Math.min(canvas.width, canvas.height);
  const s = Math.max(0.7, (baseDim / 540) * (params.dateSize || 1));
  const h = 10.5 * s;
  const style = params.dateStyle || 'lcd';

  let textW = 0;
  if (style === 'data') {
    ctx.save();
    ctx.font = `700 ${10 * s}px ui-monospace, "SF Mono", Menlo, monospace`;
    textW = Math.min(canvas.width * 0.84, ctx.measureText(text).width);
    ctx.restore();
  } else if (style === 'dots') {
    textW = text.length * 7.2 * s;
  } else {
    textW = measureLcdWidth(text, s);
  }

  const corner = params.dateCorner || 'br';
  const marginX = canvas.width * 0.055;
  const marginY = canvas.height * 0.065;
  const x = corner.endsWith('l') ? marginX : Math.max(marginX, canvas.width - marginX - textW);
  const y = corner.startsWith('t') ? marginY : Math.max(marginY, canvas.height - marginY - h);
  const alpha = Math.min(1, Math.max(0.15, (params.dateExposure || 1) * 0.78));

  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.textBaseline = 'top';

  const drawPass = (fill, blur, blurColor) => {
    ctx.fillStyle = fill;
    ctx.shadowColor = blurColor;
    ctx.shadowBlur = blur;
    if (style === 'data') {
      ctx.font = `700 ${10 * s}px ui-monospace, "SF Mono", Menlo, monospace`;
      ctx.fillText(text, x, y, canvas.width * 0.84);
    } else if (style === 'dots') {
      let curX = x;
      for (const ch of text) {
        const bits = DOT_MATRIX_GLYPHS[ch];
        if (bits) {
          for (let j = 0; j < 15; j++) {
            if (bits[j] === '1') {
              ctx.beginPath();
              ctx.arc(curX + (j % 3) * 2.0 * s, y + Math.floor(j / 3) * 2.1 * s, s * 0.75, 0, Math.PI * 2);
              ctx.fill();
            }
          }
          curX += (ch === ' ' || ch === "'" || ch === '.') ? 5.2 * s : 7.4 * s;
        } else {
          ctx.font = `700 ${9.5 * s}px ui-monospace, monospace`;
          ctx.fillText(ch, curX, y);
          curX += 7.2 * s;
        }
      }
    } else {
      let curX = x;
      for (const ch of text) {
        curX += drawLcdChar(ctx, ch, curX, y, s);
      }
    }
  };

  // Outer warm film-halation bloom + crisp LED core
  drawPass(`rgba(255, 76, 16, ${(alpha * 0.65).toFixed(3)})`, 4.2 * s, '#ff3300');
  drawPass(`rgba(255, 148, 62, ${alpha.toFixed(3)})`, 1.2 * s, '#ff6e24');

  ctx.restore();
  return canvas;
}

export function applyExposureLeaks(canvas, params) {
  const leaks = Number(params?.edgeLeaks || 0);
  if (leaks <= 0) return canvas;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = Math.min(1, leaks / 100);
  const spots = [
    [0, h * 0.72, w * 0.46],
    [w, h * 0.16, w * 0.28]
  ];
  for (const [cx, cy, r] of spots) {
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, '#ffb347');
    grad.addColorStop(0.38, 'rgba(220, 68, 22, 0.65)');
    grad.addColorStop(1, 'rgba(200, 50, 18, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.restore();
  return canvas;
}

export function isVerticalStrip(imgW, imgH, params) {
  const orient = params?.edgeOrientation || 'auto';
  if (orient === 'vertical') return true;
  if (orient === 'horizontal') return false;
  const fmt = params?.edgeFormat || '135';
  const f = EDGE_FORMATS[fmt] || EDGE_FORMATS['135'];
  // Portrait photo on naturally landscape formats runs vertically so portrait composition stays upright
  return imgH > imgW && f.w > f.h;
}

export function prepareFilmGateCanvas(img, params, maxEdge = 1280) {
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  const f = EDGE_FORMATS[params?.edgeFormat || '135'] || EDGE_FORMATS['135'];
  const vertical = isVerticalStrip(srcW, srcH, params);

  let cropW = srcW;
  let cropH = srcH;
  if (params?.border && params?.edgeCropMode === 'gate') {
    const targetRatio = vertical ? f.h / f.w : f.w / f.h;
    const srcRatio = srcW / srcH;
    if (srcRatio > targetRatio) {
      cropW = Math.max(1, Math.round(srcH * targetRatio));
      cropH = srcH;
    } else {
      cropW = srcW;
      cropH = Math.max(1, Math.round(srcW / targetRatio));
    }
  }

  const sx = Math.floor((srcW - cropW) / 2);
  const sy = Math.floor((srcH - cropH) / 2);
  const scale = Math.min(1, maxEdge / Math.max(cropW, cropH));
  const outW = Math.max(2, Math.round(cropW * scale));
  const outH = Math.max(2, Math.round(cropH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, cropW, cropH, 0, 0, outW, outH);
  return canvas;
}

function drawRoundedRectPath(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, rad);
    return;
  }
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

function gatePath(ctx, x, y, w, h, gateStyle) {
  ctx.beginPath();
  if (gateStyle === 'rounded') {
    drawRoundedRectPath(ctx, x, y, w, h, Math.min(w, h) * 0.018);
  } else if (gateStyle === 'eared') {
    const r = Math.min(w, h) * 0.018;
    drawRoundedRectPath(ctx, x, y, w, h, r);
    ctx.rect(x + w * 0.18, y - r, w * 0.09, h + 2 * r);
    ctx.rect(x + w * 0.73, y - r, w * 0.09, h + 2 * r);
  } else if (gateStyle === 'kicked') {
    const r = Math.min(w, h) * 0.014;
    ctx.rect(x + r, y, w - r * 2, h);
    ctx.rect(x, y + r, w, h - r * 2);
    ctx.rect(x, y, w * 0.11, h * 0.065);
    ctx.rect(x + w * 0.89, y + h * 0.935, w * 0.11, h * 0.065);
  } else {
    ctx.rect(x, y, w, h);
  }
}

export function decorateFilmEdge(imageCanvas, params, filmId, isMonochrome = false, frameOffset = 0) {
  if (!params?.border) return imageCanvas;

  const f = EDGE_FORMATS[params.edgeFormat || '135'] || EDGE_FORMATS['135'];
  const vertical = isVerticalStrip(imageCanvas.width, imageCanvas.height, params);
  const longPx = Math.max(imageCanvas.width, imageCanvas.height);
  const longMm = Math.max(f.w, f.h);
  const px = longPx / longMm;

  const narrow = params.edgeStyle === 'filed';
  const stripMarginMm = narrow ? 1.15 : (f.gauge === '135' ? 5.5 : 2.6);
  const gapMarginMm = narrow ? 0.75 : (f.gauge === '135' ? 1.8 : 1.3);

  const sidePad = Math.round(px * (vertical ? stripMarginMm : gapMarginMm));
  const topPad = Math.round(px * (vertical ? gapMarginMm : stripMarginMm));

  const out = document.createElement('canvas');
  out.width = imageCanvas.width + sidePad * 2;
  out.height = imageCanvas.height + topPad * 2;
  const ctx = out.getContext('2d');

  // Carrier / outer mask
  ctx.fillStyle = params.edgeCarrier === 'open' ? '#e6e4d9' : '#060706';
  ctx.fillRect(0, 0, out.width, out.height);

  const carrierRim = params.edgeCarrier === 'none' ? 0 : Math.max(1.5, px * 0.35);
  const fog = Number(params.edgeFog ?? 0.8);
  ctx.fillStyle = `rgb(${Math.round(9 + 14 * fog)}, ${Math.round(9 + 8 * fog)}, ${Math.round(6 + 3 * fog)})`;
  ctx.fillRect(carrierRim, carrierRim, out.width - carrierRim * 2, out.height - carrierRim * 2);

  // 35mm Sprocket Perforations
  if (f.gauge === '135' && !narrow) {
    const step = px * 4.75;
    const holeLong = px * 2.0;
    const holeAcross = px * 2.8;
    const holeRadius = Math.max(1.2, px * 0.38);
    const holeEdgeOffset = px * 0.85;
    const whiteHoles = (params.edgeHoles || 'white') === 'white';

    ctx.fillStyle = whiteHoles ? '#f3f1ea' : '#020302';
    ctx.strokeStyle = whiteHoles ? 'rgba(0, 0, 0, 0.16)' : 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = Math.max(1, px * 0.08);

    if (!vertical) {
      const topY = holeEdgeOffset;
      const botY = out.height - holeEdgeOffset - holeAcross;
      const startX = (out.width % step) * 0.5 + px * 0.5;
      for (let x = startX; x + holeLong < out.width - px * 0.3; x += step) {
        for (const y of [topY, botY]) {
          ctx.beginPath();
          drawRoundedRectPath(ctx, x, y, holeLong, holeAcross, holeRadius);
          ctx.fill();
          ctx.stroke();
        }
      }
    } else {
      const leftX = holeEdgeOffset;
      const rightX = out.width - holeEdgeOffset - holeAcross;
      const startY = (out.height % step) * 0.5 + px * 0.5;
      for (let y = startY; y + holeLong < out.height - px * 0.3; y += step) {
        for (const x of [leftX, rightX]) {
          ctx.beginPath();
          drawRoundedRectPath(ctx, x, y, holeAcross, holeLong, holeRadius);
          ctx.fill();
          ctx.stroke();
        }
      }
    }
  }

  // Draw developed picture inside gate
  ctx.save();
  gatePath(ctx, sidePad, topPad, imageCanvas.width, imageCanvas.height, params.edgeGate || 'rounded');
  ctx.clip();
  ctx.drawImage(imageCanvas, sidePad, topPad);
  ctx.restore();

  // Authentic film edge lettering & frame numbers
  const frameNo = Math.max(1, ((Number(params.frameNumber || 24) - 1 + frameOffset) % 36) + 1);
  const frameStr = String(frameNo).padStart(2, '0');
  const stockEdgeText = EDGE_PRINT_MAP[filmId] || 'SPEKTRA FILM';
  const fontPx = Math.max(8, px * 0.88);

  ctx.save();
  ctx.fillStyle = isMonochrome ? '#bcc1b8' : '#d29c4c';
  ctx.font = `700 ${fontPx}px ui-monospace, "SF Mono", Menlo, monospace`;
  ctx.textBaseline = 'middle';

  if (!vertical) {
    const holeClearance = f.gauge === '135' && !narrow ? px * 3.65 : carrierRim;
    const topBandY = (holeClearance + topPad) * 0.5;
    const botBandY = out.height - (holeClearance + (out.height - topPad - imageCanvas.height + holeClearance)) * 0.5;
    const botBandMid = topPad + imageCanvas.height + (out.height - holeClearance - (topPad + imageCanvas.height)) * 0.5;
    const safeBotY = f.gauge === '135' && !narrow ? botBandMid : (topPad + imageCanvas.height + out.height - carrierRim) * 0.5;
    void botBandY;

    ctx.textAlign = 'left';
    ctx.fillText(stockEdgeText, sidePad, topBandY, imageCanvas.width * 0.72);
    ctx.fillText(`${frameStr}   ▶   ${frameNo}A`, sidePad, safeBotY, imageCanvas.width * 0.45);
    ctx.textAlign = 'right';
    ctx.fillText(`${frameStr}A`, sidePad + imageCanvas.width, safeBotY, imageCanvas.width * 0.3);
  } else {
    const holeClearance = f.gauge === '135' && !narrow ? px * 3.65 : carrierRim;
    const leftBandX = (holeClearance + sidePad) * 0.5;
    const rightBandX = sidePad + imageCanvas.width + (out.width - holeClearance - (sidePad + imageCanvas.width)) * 0.5;

    ctx.save();
    ctx.translate(leftBandX, topPad + imageCanvas.height);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'left';
    ctx.fillText(stockEdgeText, 0, 0, imageCanvas.height * 0.72);
    ctx.restore();

    ctx.save();
    ctx.translate(rightBandX, topPad + imageCanvas.height);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'left';
    ctx.fillText(`${frameStr}   ▶   ${frameNo}A`, 0, 0, imageCanvas.height * 0.45);
    ctx.textAlign = 'right';
    ctx.fillText(`${frameStr}A`, imageCanvas.height, 0, imageCanvas.height * 0.25);
    ctx.restore();
  }
  ctx.restore();

  return out;
}
