import React, { useState, useRef, useEffect } from 'react';
import piexif from 'piexifjs';
import ExifReader from 'exifreader';
import { FilmDarkroomPanel } from './spektra/FilmDarkroomPanel.jsx';
import { SPEKTRA_UI_DEFAULTS } from './spektra/defaults.js';
import { isRawFile, decodeRawFile } from './spektra/rawDecoder.js';
import { renderSpektraImage } from './spektra/spektraClient.js';
import './spektra/spektra.css';
import { ImageEditPanel } from './editor/ImageEditPanel.jsx';
import './editor/editor.css';

const getPiexif = () => (piexif?.load ? piexif : (piexif?.default || piexif));

// Helper: Extract raw APP1 segment from JPEG base64 for lossless EXIF preservation
const extractRawExifClient = (base64) => {
  try {
    const clean = base64.replace(/^data:image\/\w+;base64,/, '');
    const binary = atob(clean);
    if (binary.charCodeAt(0) !== 0xFF || binary.charCodeAt(1) !== 0xD8) return null;
    
    let offset = 2;
    while (offset < binary.length) {
      const marker = (binary.charCodeAt(offset) << 8) | binary.charCodeAt(offset + 1);
      if ((marker & 0xFF00) !== 0xFF00) break;
      const length = (binary.charCodeAt(offset + 2) << 8) | binary.charCodeAt(offset + 3);
      if (marker === 0xFFE1) {
        if (binary.slice(offset + 4, offset + 10) === 'Exif\x00\x00') {
          return binary.slice(offset + 4, offset + 2 + length);
        }
      }
      offset += 2 + length;
    }
  } catch (e) {
    console.warn('[EXIF] Failed to extract raw APP1 segment:', e);
  }
  return null;
};

// Helper: Resize and compress base64 image if it exceeds maxDim or is too large to prevent backend payload issues
const resizeImageBase64 = (dataUrl, maxDim = 1600, quality = 0.85) => {
  return new Promise((resolve) => {
    if (!dataUrl || dataUrl.length < 1500000) {
      resolve(dataUrl);
      return;
    }
    const img = new Image();
    if (dataUrl && !dataUrl.startsWith('data:')) {
      img.crossOrigin = 'anonymous';
    }
    img.onload = () => {
      let width = img.width;
      let height = img.height;
      if (width <= maxDim && height <= maxDim && dataUrl.length < 2500000) {
        resolve(dataUrl);
        return;
      }
      if (width > height) {
        if (width > maxDim) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        }
      } else {
        if (height > maxDim) {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      
      const compressed = canvas.toDataURL('image/jpeg', quality);
      console.log(`[Resize] Compressed image from ${img.width}x${img.height} (len: ${dataUrl.length}) to ${width}x${height} (len: ${compressed.length})`);
      resolve(compressed);
    };
    img.onerror = () => {
      resolve(dataUrl);
    };
    img.src = dataUrl;
  });
};

// Helper: Extract Date, Time, Location, Device from EXIF data on client side using ExifReader & piexifjs
const extractExifClient = async (fileOrBase64) => {
  if (!fileOrBase64) return null;
  const piexifLib = getPiexif();

  let dateTime = null;
  let device = null;
  let make = null;
  let gps = null;
  let rawBytes = null;
  let arrayBuffer = null;
  let base64String = null;

  try {
    if (typeof fileOrBase64 === 'object' && (fileOrBase64 instanceof File || fileOrBase64 instanceof Blob || typeof fileOrBase64.arrayBuffer === 'function')) {
      arrayBuffer = await fileOrBase64.arrayBuffer();
    } else if (fileOrBase64 instanceof ArrayBuffer) {
      arrayBuffer = fileOrBase64;
    } else if (typeof fileOrBase64 === 'string') {
      base64String = fileOrBase64;
      const clean = fileOrBase64.replace(/^data:image\/\w+;base64,/, '');
      const binary = atob(clean);
      const len = binary.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      arrayBuffer = bytes.buffer;
    }
  } catch (convErr) {
    console.warn('[extractExifClient] Failed to obtain ArrayBuffer:', convErr);
  }

  // 1. Try ExifReader on ArrayBuffer (industry standard, handles File/Blob ArrayBuffer, Base64, HEIC, PNG, TIFF, JPEG)
  if (arrayBuffer) {
    try {
      const tags = ExifReader.load(arrayBuffer);
      if (tags) {
        if (tags['DateTimeOriginal']?.description) {
          dateTime = tags['DateTimeOriginal'].description;
        } else if (tags['DateTime']?.description) {
          dateTime = tags['DateTime'].description;
        }

        if (tags['Model']?.description) {
          device = tags['Model'].description;
        }
        if (tags['Make']?.description) {
          make = tags['Make'].description;
          if (!device) device = make;
        }

        if (tags['GPSLatitude'] && tags['GPSLongitude']) {
          let latVal = typeof tags['GPSLatitude'].description === 'number' 
            ? tags['GPSLatitude'].description 
            : parseFloat(tags['GPSLatitude'].description);
          let lonVal = typeof tags['GPSLongitude'].description === 'number' 
            ? tags['GPSLongitude'].description 
            : parseFloat(tags['GPSLongitude'].description);

          // Fallback for rational DMS arrays if description is not a direct number
          if (isNaN(latVal) && Array.isArray(tags['GPSLatitude'].value) && tags['GPSLatitude'].value.length >= 3) {
            const v = tags['GPSLatitude'].value;
            latVal = (v[0][0]/v[0][1]) + (v[1][0]/v[1][1])/60 + (v[2][0]/v[2][1])/3600;
          }
          if (isNaN(lonVal) && Array.isArray(tags['GPSLongitude'].value) && tags['GPSLongitude'].value.length >= 3) {
            const v = tags['GPSLongitude'].value;
            lonVal = (v[0][0]/v[0][1]) + (v[1][0]/v[1][1])/60 + (v[2][0]/v[2][1])/3600;
          }

          const latRefVal = tags['GPSLatitudeRef']?.value?.[0] || tags['GPSLatitudeRef']?.description || (latVal >= 0 ? 'N' : 'S');
          const lonRefVal = tags['GPSLongitudeRef']?.value?.[0] || tags['GPSLongitudeRef']?.description || (lonVal >= 0 ? 'E' : 'W');
          const latRef = String(latRefVal).toUpperCase().startsWith('S') ? 'S' : 'N';
          const lonRef = String(lonRefVal).toUpperCase().startsWith('W') ? 'W' : 'E';

          if (!isNaN(latVal) && !isNaN(lonVal)) {
            gps = {
              lat: latVal.toString(),
              lon: lonVal.toString(),
              latRef,
              lonRef
            };
          }
        }
      }
    } catch (exifReaderErr) {
      console.warn('[ExifReader] Error parsing EXIF:', exifReaderErr);
    }

    // Extract raw APP1 segment for JPEG lossless preservation
    try {
      const view = new Uint8Array(arrayBuffer);
      if (view.length > 4 && view[0] === 0xFF && view[1] === 0xD8) {
        let offset = 2;
        while (offset < view.length) {
          const marker = (view[offset] << 8) | view[offset + 1];
          const length = (view[offset + 2] << 8) | view[offset + 3];
          if (marker === 0xFFE1) {
            if (view[offset + 4] === 69 && view[offset + 5] === 120 && view[offset + 6] === 105 && view[offset + 7] === 102 && view[offset + 8] === 0 && view[offset + 9] === 0) {
              let exifStr = '';
              for (let i = offset + 4; i < offset + 2 + length; i++) {
                exifStr += String.fromCharCode(view[i]);
              }
              rawBytes = exifStr;
              break;
            }
          }
          if ((marker & 0xFF00) !== 0xFF00) break;
          offset += 2 + length;
        }
      }
    } catch (rawErr) {
      console.warn('[extractExifClient] Error extracting rawBytes:', rawErr);
    }
  }

  // 2. Fallback to piexif.load if anything is missing and rawBytes or JPEG base64 is available
  if ((!dateTime || !gps || !device) && piexifLib?.load) {
    try {
      const exifObj = rawBytes 
        ? piexifLib.load(rawBytes) 
        : (base64String && base64String.startsWith('data:image/jpeg') ? piexifLib.load(base64String) : null);
      if (exifObj) {
        if (!dateTime) {
          if (exifObj["Exif"] && exifObj["Exif"][piexifLib.ExifIFD.DateTimeOriginal]) {
            dateTime = exifObj["Exif"][piexifLib.ExifIFD.DateTimeOriginal];
          } else if (exifObj["0th"] && exifObj["0th"][piexifLib.ImageIFD.DateTime]) {
            dateTime = exifObj["0th"][piexifLib.ImageIFD.DateTime];
          }
        }
        if (!device) {
          const m = exifObj["0th"] && exifObj["0th"][piexifLib.ImageIFD.Make];
          const md = exifObj["0th"] && exifObj["0th"][piexifLib.ImageIFD.Model];
          device = md || m || null;
          make = m || null;
        }
        if (!gps && exifObj["GPS"]) {
          const lat = exifObj["GPS"][piexifLib.GPSIFD.GPSLatitude];
          const latRef = exifObj["GPS"][piexifLib.GPSIFD.GPSLatitudeRef];
          const lon = exifObj["GPS"][piexifLib.GPSIFD.GPSLongitude];
          const lonRef = exifObj["GPS"][piexifLib.GPSIFD.GPSLongitudeRef];
          
          if (lat && lon && lat.length >= 3 && lon.length >= 3) {
            const convertDMS = (dms) => {
              const d = dms[0][0] / dms[0][1];
              const m = dms[1][0] / dms[1][1];
              const s = dms[2][0] / dms[2][1];
              return d + m / 60 + s / 3600;
            };
            const latVal = convertDMS(lat);
            const lonVal = convertDMS(lon);
            gps = {
              lat: latVal.toString(),
              lon: lonVal.toString(),
              latRef: latRef || (latVal >= 0 ? 'N' : 'S'),
              lonRef: lonRef || (lonVal >= 0 ? 'E' : 'W')
            };
          }
        }
      }
    } catch (piexifErr) {
      // ignore
    }
  }

  if (dateTime || gps || device || rawBytes) {
    return {
      dateTime,
      gps,
      device,
      make,
      rawBytes
    };
  }
  return null;
};

function App() {
  // API base path — adapts automatically to Vite's base setting
  const API_BASE = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');

  // WeChat Environment & Device Detection
  const isWeChat = typeof navigator !== 'undefined' && /micromessenger/i.test(navigator.userAgent);

  // App States
  const [showWelcome, setShowWelcome] = useState(true);
  const [uploadedImages, setUploadedImages] = useState([]); // [{ id, file, src, styledSrc, activeStyle }]
  const [activeIdx, setActiveIdx] = useState(0); 
  const [activeTab, setActiveTab] = useState('photos'); // 'photos' | 'edit' | 'style' | 'cover' | 'copy'
  const [editSubTab, setEditSubTab] = useState('expand'); // 'expand' | 'erase' | 'bokeh' | 'basic'
  const [coverSubTab, setCoverSubTab] = useState('template'); // 'template' | 'text' | 'depth'
  const [h5FrameMode, setH5FrameMode] = useState(true); // Mobile H5 shell preview on desktop

  // WeChat Save Modal & Toast States
  const [wechatSaveModal, setWechatSaveModal] = useState({
    isOpen: false,
    imageSrc: '',
    title: '',
    fileName: ''
  });
  const [toastMsg, setToastMsg] = useState('');

  const showToast = (msg, duration = 2500) => {
    setToastMsg(msg);
    setTimeout(() => {
      setToastMsg((cur) => (cur === msg ? '' : cur));
    }, duration);
  };

  const copyToClipboard = async (text, successMsg = '文案已复制到剪贴板！') => {
    if (!text) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        showToast(successMsg);
        return;
      }
    } catch (e) {
      console.warn('Clipboard API failed, using fallback', e);
    }
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      textarea.style.pointerEvents = 'none';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const success = document.execCommand('copy');
      document.body.removeChild(textarea);
      if (success) {
        showToast(successMsg);
      } else {
        prompt('请长按复制文案：', text);
      }
    } catch (err) {
      console.error('Fallback copy failed', err);
      prompt('请长按复制文案：', text);
    }
  };

  const handleSaveOrDownloadImage = (imageSrc, fileName, title = '高清图片') => {
    if (!imageSrc) return;
    if (isWeChat) {
      setWechatSaveModal({
        isOpen: true,
        imageSrc,
        title,
        fileName
      });
    } else {
      const link = document.createElement('a');
      link.href = imageSrc;
      link.download = fileName;
      link.click();
      showToast('已开始下载文件！');
    }
  };
  
  // AI Copywriting States
  const [copyStyle, setCopyStyle] = useState('探店'); // '探店', '旅行心情', '自定义'
  const [customCopyStyle, setCustomCopyStyle] = useState('');
  const [copyKeywords, setCopyKeywords] = useState('');
  const [generatedCopyOptions, setGeneratedCopyOptions] = useState([]);
  const [activeCopyOptionIdx, setActiveCopyOptionIdx] = useState(0);
  const [isGeneratingCopy, setIsGeneratingCopy] = useState(false);
  const [aiTitle, setAiTitle] = useState('');
  const [aiBody, setAiBody] = useState('');
  const [cachedVisualDescriptions, setCachedVisualDescriptions] = useState(null);

  // Cover Title Card States
  const [coverImageIdx, setCoverImageIdx] = useState(0);
  const [coverStyle, setCoverStyle] = useState('giant'); // 'giant' | 'magazine' | 'minimal' | 'sticker' | 'cinema' | 'collage'
  const [coverTag, setCoverTag] = useState('⚡ BREAKING 速报');
  const [coverTitle, setCoverTitle] = useState('氛围感彻底封神');
  const [coverSubtitle, setCoverSubtitle] = useState('2026 视觉精选指南 · 建议先马后看');
  const [coverPosition, setCoverPosition] = useState('top'); // 'bottom' | 'center' | 'top'
  const [coverAlign, setCoverAlign] = useState('left'); // 'left' | 'center' | 'right'
  const [subjectOcclusion, setSubjectOcclusion] = useState(true); // 3D Depth Layering: title behind subject
  const [coverCandidates, setCoverCandidates] = useState([]);
  const [isGeneratingCoverTitles, setIsGeneratingCoverTitles] = useState(false);
  const [coverPreviewUri, setCoverPreviewUri] = useState('');
  const [activePreviewTab, setActivePreviewTab] = useState('styled'); // 'styled' | 'cover'

  // Subject Outline & Doodle States
  const [outlineEnabled, setOutlineEnabled] = useState(false);
  const [outlineType, setOutlineType] = useState('dashed'); // 'dashed' | 'smooth' | 'glow'
  const [outlineColor, setOutlineColor] = useState('#FFFFFF'); // '#FFFFFF', '#FFE600', '#FF2E93', '#00F0FF', '#A3E635'
  const [outlineWidth, setOutlineWidth] = useState(10); // 6 | 10 | 16
  const [outlineMasks, setOutlineMasks] = useState({}); // { [imageIndex]: HTMLCanvasElement }
  const [isDetectingOutline, setIsDetectingOutline] = useState(false);
  const [isDoodleMode, setIsDoodleMode] = useState(false);
  const [doodleStrokes, setDoodleStrokes] = useState({}); // { [imageIndex]: Array of strokes }

  // General UI States
  const [isLoading, setIsLoading] = useState(false);
  const [aiOperationName, setAiOperationName] = useState(''); 
  const [errorMsg, setErrorMsg] = useState('');

  // SpektraLab Film Darkroom States
  const [styleMode, setStyleMode] = useState('spektra'); // 'spektra' | 'ai'
  const [spektraParams, setSpektraParams] = useState(() => ({ ...SPEKTRA_UI_DEFAULTS }));
  const [isRenderingSpektra, setIsRenderingSpektra] = useState(false);
  const [isBatchSpektra, setIsBatchSpektra] = useState(false);
  const [isComparingOriginal, setIsComparingOriginal] = useState(false);

  // Image Edit Studio Interactive States
  const [editLivePreviewUri, setEditLivePreviewUri] = useState('');
  const [isEraseBrushMode, setIsEraseBrushMode] = useState(false);
  const [eraseBrushSize, setEraseBrushSize] = useState(28);
  const [eraseBrushStrokes, setEraseBrushStrokes] = useState([]);
  const [bokehFocusPoint, setBokehFocusPoint] = useState({ x: 0.5, y: 0.5 });
  const [isBokehTapFocusActive, setIsBokehTapFocusActive] = useState(false);

  // Refs
  const fileInputRef = useRef(null);
  const previewImgRef = useRef(null);
  const doodleCanvasRef = useRef(null);
  const eraseImgRef = useRef(null);
  const eraseCanvasRef = useRef(null);
  const isErasingRef = useRef(false);
  const currentEraseStrokeRef = useRef(null);
  const isDrawingRef = useRef(false);
  const currentStrokeRef = useRef(null);
  const spektraLiveTimerRef = useRef(null);
  const spektraPreviewReqIdRef = useRef(0);

  // Helper: Dynamically load MediaPipe SelfieSegmentation from CDN
  const loadMediaPipe = () => {
    return new Promise((resolve, reject) => {
      if (window.SelfieSegmentation) {
        resolve(window.SelfieSegmentation);
        return;
      }
      const existing = document.getElementById('mediapipe-selfie-script');
      if (existing) {
        existing.addEventListener('load', () => resolve(window.SelfieSegmentation));
        existing.addEventListener('error', (e) => reject(e));
        return;
      }
      const script = document.createElement('script');
      script.id = 'mediapipe-selfie-script';
      script.crossOrigin = 'anonymous';
      script.src = 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/selfie_segmentation.js';
      script.onload = () => resolve(window.SelfieSegmentation);
      script.onerror = (err) => reject(err);
      document.head.appendChild(script);
    });
  };

  // High-Precision AI Subject Mask Refinement (人像抠图高精边缘平滑与智能收边算法)
  // 1. Bicubic Upscaling: smooth scaling from 256x256 MediaPipe probability map to target canvas resolution
  // 2. Anti-Aliasing Pre-blur: removes 256-grid piecewise blockiness and staircase artifacts
  // 3. Fast Separable 1D Morphological Erosion (收边/Defringe): contracts boundary by ~1.5-2px to eliminate background halos (grass/stone/white fringe)
  // 4. Hermite Smoothstep Sigmoid (low=0.38, high=0.60): guarantees 100% solid opacity inside the subject (no text ghosting)
  // 5. Final Sub-Pixel Feathering: gives silky-smooth anti-aliased contours conforming to the person's true silhouette
  const refineSubjectSegmentationMask = (sourceMask, targetW, targetH) => {
    if (!sourceMask || !targetW || !targetH) return sourceMask;

    try {
      // 1. Upscale to target dimensions with high smoothing
      const scaleCanvas = document.createElement('canvas');
      scaleCanvas.width = targetW;
      scaleCanvas.height = targetH;
      const sctx = scaleCanvas.getContext('2d');
      sctx.imageSmoothingEnabled = true;
      sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(sourceMask, 0, 0, targetW, targetH);

      // 2. Anti-aliasing pre-blur to round out 256-grid piecewise discontinuities
      const scale = Math.max(0.7, targetW / 1000);
      const blurCanvas = document.createElement('canvas');
      blurCanvas.width = targetW;
      blurCanvas.height = targetH;
      const bctx = blurCanvas.getContext('2d');
      bctx.filter = `blur(${Math.max(1.5, Math.round(2.0 * scale))}px)`;
      bctx.drawImage(scaleCanvas, 0, 0);

      const bData = bctx.getImageData(0, 0, targetW, targetH);
      const bd = bData.data;

      // Extract raw confidence channel into compact array
      const rawA = new Uint8Array(targetW * targetH);
      for (let i = 0; i < rawA.length; i++) {
        rawA[i] = Math.max(bd[i * 4], bd[i * 4 + 3]);
      }

      // 3. Fast 1D Separable Erosion (Radius ~1.8*scale)
      // Contracts boundary strictly inside subject to eliminate background fringe (grass/stone/white halo)
      const rad = Math.max(1, Math.round(1.8 * scale));
      const erodedH = new Uint8Array(targetW * targetH);
      for (let y = 0; y < targetH; y++) {
        const row = y * targetW;
        for (let x = 0; x < targetW; x++) {
          let min = rawA[row + x];
          for (let dx = 1; dx <= rad; dx++) {
            const xL = x >= dx ? x - dx : 0;
            const xR = x + dx < targetW ? x + dx : targetW - 1;
            if (rawA[row + xL] < min) min = rawA[row + xL];
            if (rawA[row + xR] < min) min = rawA[row + xR];
          }
          erodedH[row + x] = min;
        }
      }

      const eroded = new Uint8Array(targetW * targetH);
      for (let y = 0; y < targetH; y++) {
        const row = y * targetW;
        for (let x = 0; x < targetW; x++) {
          let min = erodedH[row + x];
          for (let dy = 1; dy <= rad; dy++) {
            const yT = y >= dy ? y - dy : 0;
            const yB = y + dy < targetH ? y + dy : targetH - 1;
            const rT = yT * targetW;
            const rB = yB * targetW;
            if (erodedH[rT + x] < min) min = erodedH[rT + x];
            if (erodedH[rB + x] < min) min = erodedH[rB + x];
          }
          eroded[row + x] = min;
        }
      }

      // 4. Hermite Smoothstep Sigmoid with Calibrated Range
      const outCanvas = document.createElement('canvas');
      outCanvas.width = targetW;
      outCanvas.height = targetH;
      const octx = outCanvas.getContext('2d');
      const outData = octx.createImageData(targetW, targetH);
      const od = outData.data;

      const low = 0.38 * 255;  // ~97
      const high = 0.60 * 255; // ~153

      for (let i = 0; i < eroded.length; i++) {
        const val = eroded[i];
        let a = 0;
        if (val >= high) {
          a = 255;
        } else if (val <= low) {
          a = 0;
        } else {
          const t = (val - low) / (high - low);
          a = Math.round(t * t * (3 - 2 * t) * 255);
        }
        const idx = i * 4;
        od[idx] = 255;
        od[idx + 1] = 255;
        od[idx + 2] = 255;
        od[idx + 3] = a;
      }
      octx.putImageData(outData, 0, 0);

      // 5. Final Sub-pixel Feathering for vector-smooth edge anti-aliasing
      const finalCanvas = document.createElement('canvas');
      finalCanvas.width = targetW;
      finalCanvas.height = targetH;
      const fctx = finalCanvas.getContext('2d');
      fctx.filter = `blur(${Math.max(0.8, 1.0 * scale)}px)`;
      fctx.drawImage(outCanvas, 0, 0);

      return finalCanvas;
    } catch (e) {
      console.warn('Mask refinement fallback:', e);
      return sourceMask;
    }
  };

  // Run AI Portrait Segmentation for subject outline, 3D occlusion, and local bokeh
  const handleDetectSubjectOutline = async (targetIdx = coverImageIdx, enableOutline = false, options = {}) => {
    const { switchToCover = true, silent = false } = options;
    const target = uploadedImages[targetIdx] || uploadedImages[activeIdx] || uploadedImages[0];
    if (!target) return null;

    setIsDetectingOutline(true);
    try {
      const SelfieSegmentationClass = await loadMediaPipe();
      const segmenter = new SelfieSegmentationClass({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`
      });
      // Use Model 0 (General model: higher resolution, superior for full-body, outdoor scenes, and stylized anime/cartoon characters)
      segmenter.setOptions({ modelSelection: 0 });

      const actualSrc = switchToCover ? (target.styledSrc || target.src) : target.src;
      const img = new Image();
      if (!actualSrc.startsWith('data:')) {
        img.crossOrigin = 'anonymous';
      }
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = actualSrc;
      });

      const maskCanvas = await new Promise((resolve, reject) => {
        let finished = false;
        const timer = setTimeout(() => {
          if (!finished) reject(new Error('Segmentation timeout'));
        }, 12000);

        segmenter.onResults((results) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          if (results.segmentationMask) {
            const targetW = img.naturalWidth || img.width || 1024;
            const targetH = img.naturalHeight || img.height || 1024;
            const refinedMask = refineSubjectSegmentationMask(results.segmentationMask, targetW, targetH);
            resolve(refinedMask);
          } else {
            reject(new Error('No mask returned'));
          }
        });
        segmenter.send({ image: img }).catch(reject);
      });

      setOutlineMasks(prev => ({ ...prev, [targetIdx]: maskCanvas }));
      if (enableOutline) {
        setOutlineEnabled(true);
      }
      if (switchToCover) {
        setActivePreviewTab('cover');
      }
      return maskCanvas;
    } catch (err) {
      console.error('Subject outline detection error:', err);
      if (!silent) {
        alert('未能自动检测到人像主体，您可以开启「自由手绘涂鸦」在画面上直接绘制轮廓或箭头标记哦！');
      }
      return null;
    } finally {
      setIsDetectingOutline(false);
    }
  };

  const ensurePortraitMaskForEdit = async (targetIdx = activeIdx, { silent = true } = {}) => {
    if (outlineMasks[targetIdx]) return outlineMasks[targetIdx];
    return await handleDetectSubjectOutline(targetIdx, false, { switchToCover: false, silent });
  };

  // Handle pointer events on doodle overlay canvas
  const handleDoodlePointerDown = (e) => {
    isDrawingRef.current = true;
    const canvas = doodleCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    currentStrokeRef.current = {
      color: outlineColor,
      width: outlineWidth,
      type: outlineType,
      points: [{ x, y }]
    };
  };

  const handleDoodlePointerMove = (e) => {
    if (!isDrawingRef.current || !currentStrokeRef.current) return;
    const canvas = doodleCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    currentStrokeRef.current.points.push({ x, y });

    // Live draw on overlay canvas for instant feedback
    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = outlineColor;
    ctx.lineWidth = Math.max(3, outlineWidth * (canvas.width / 1000));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (outlineType === 'dashed') {
      ctx.setLineDash([12, 8]);
    } else {
      ctx.setLineDash([]);
    }
    const pts = currentStrokeRef.current.points;
    if (pts.length > 1) {
      const p1 = pts[pts.length - 2];
      const p2 = pts[pts.length - 1];
      ctx.beginPath();
      ctx.moveTo(p1.x * canvas.width, p1.y * canvas.height);
      ctx.lineTo(p2.x * canvas.width, p2.y * canvas.height);
      ctx.stroke();
    }
  };

  const handleDoodlePointerUp = () => {
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    if (currentStrokeRef.current && currentStrokeRef.current.points.length > 1) {
      const stroke = currentStrokeRef.current;
      setDoodleStrokes(prev => {
        const curList = prev[coverImageIdx] || [];
        return {
          ...prev,
          [coverImageIdx]: [...curList, stroke]
        };
      });
    }
    currentStrokeRef.current = null;
  };

  const clearDoodles = () => {
    setDoodleStrokes(prev => ({ ...prev, [coverImageIdx]: [] }));
    const canvas = doodleCanvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  };

  const undoLastDoodle = () => {
    setDoodleStrokes(prev => {
      const curList = prev[coverImageIdx] || [];
      if (curList.length === 0) return prev;
      return {
        ...prev,
        [coverImageIdx]: curList.slice(0, -1)
      };
    });
  };

  // Live update cover preview whenever parameters change
  useEffect(() => {
    if (uploadedImages.length === 0) {
      setCoverPreviewUri('');
      return;
    }
    const target = uploadedImages[coverImageIdx] || uploadedImages[activeIdx] || uploadedImages[0];
    if (!target) return;

    let isMounted = true;
    const timer = setTimeout(async () => {
      try {
        const src = target.styledSrc || target.src;
        const preview = await renderCoverCanvas(src, {
          tag: coverTag,
          title: coverTitle,
          subtitle: coverSubtitle,
          style: coverStyle,
          position: coverPosition,
          align: coverAlign,
          subjectOcclusion,
          outlineEnabled,
          outlineType,
          outlineColor,
          outlineWidth,
          outlineMask: outlineMasks[coverImageIdx] || null,
          doodleStrokes: doodleStrokes[coverImageIdx] || [],
          exif: target.exif
        });
        if (isMounted) {
          setCoverPreviewUri(preview);
        }
      } catch (err) {
        console.warn('Cover preview render error:', err);
      }
    }, 120);

    return () => {
      isMounted = false;
      clearTimeout(timer);
    };
  }, [uploadedImages, coverImageIdx, activeIdx, coverStyle, coverTag, coverTitle, coverSubtitle, coverPosition, coverAlign, subjectOcclusion, outlineEnabled, outlineType, outlineColor, outlineWidth, outlineMasks, doodleStrokes]);

  // Handle multiple photos upload
  const handlePhotosUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    setErrorMsg('');
    setCachedVisualDescriptions(null); // Clear description cache on new upload
    const availableSlots = 4 - uploadedImages.length;
    if (availableSlots <= 0) {
      setErrorMsg('最多支持上传 4 张图片！');
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (e.target) e.target.value = '';
      return;
    }
    const filesToProcess = files.slice(0, availableSlots);
    const newImages = [];
    const hasRaw = filesToProcess.some(isRawFile);
    if (hasRaw) {
      setIsLoading(true);
      setAiOperationName('正在 16 位线性解码 RAW 原片');
    }

    try {
      for (const file of filesToProcess) {
        try {
          const id = Math.random().toString(36).substring(2, 9);

          if (isRawFile(file)) {
            setAiOperationName(`正在 16 位线性解码 RAW 原片 (${file.name})`);
            const decoded = await decodeRawFile(file, {
              full: false,
              baseUrl: import.meta.env.BASE_URL || '/'
            });
            let readerExif = null;
            try {
              readerExif = await extractExifClient(file);
            } catch {
              // ignore ExifReader fallback failure on proprietary RAW
            }
            const mergedExif = {
              ...(readerExif || {}),
              ...(decoded.exif || {}),
              dateTime: decoded.exif?.dateTime || readerExif?.dateTime || null,
              device: decoded.exif?.device || readerExif?.device || null,
              make: decoded.exif?.make || readerExif?.make || null,
              gps: readerExif?.gps || decoded.exif?.gps || null
            };
            newImages.push({
              id,
              file,
              src: decoded.previewSrc,
              styledSrc: null,
              activeStyle: null,
              width: decoded.width,
              height: decoded.height,
              exif: mergedExif,
              isRaw: true,
              rawData: decoded.rawData
            });
            continue;
          }

          const src = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (event) => resolve(event.target.result);
            reader.onerror = (err) => reject(err);
            reader.readAsDataURL(file);
          });

          const dimensions = await new Promise((resolve) => {
            const tempImg = new Image();
            tempImg.onload = () => resolve({ w: tempImg.width, h: tempImg.height });
            tempImg.onerror = () => resolve({ w: 1024, h: 1024 });
            tempImg.src = src;
          });

          // Extract EXIF directly from the File object (supports HEIC, JPEG, PNG, TIFF)
          let exif = null;
          try {
            exif = (await extractExifClient(file)) || (await extractExifClient(src));
          } catch (exifErr) {
            console.warn('[Upload] Failed to parse EXIF for image:', exifErr);
          }

          newImages.push({
            id,
            file,
            src,
            styledSrc: null,
            activeStyle: null,
            width: dimensions.w,
            height: dimensions.h,
            exif,
            isRaw: false,
            rawData: null
          });
        } catch (fileErr) {
          console.error('[Upload] Error processing file:', file?.name, fileErr);
          setErrorMsg(fileErr?.message || '部分图片处理失败，请重试');
        }
      }
    } finally {
      if (hasRaw) {
        setIsLoading(false);
        setAiOperationName('');
      }
    }

    if (newImages.length > 0) {
      setUploadedImages(prev => [...prev, ...newImages]);
      setActiveIdx(uploadedImages.length);
      setShowWelcome(false);
      if (activeTab === 'photos' && uploadedImages.length === 0) {
        setActiveTab('style');
      }
      showToast(`✨ 已添加 ${newImages.length} 张照片`);
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    if (e.target) {
      e.target.value = '';
    }
  };

  // Generate a high-resolution sample portrait/travel photo + mask + EXIF + sample AI copy for 1-tap H5 Demo
  const handleLoadDemoPhoto = () => {
    const w = 900;
    const h = 1200;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');

    // 1. Sunset golden hour sky gradient
    const skyGrad = ctx.createLinearGradient(0, 0, 0, h);
    skyGrad.addColorStop(0, '#1e3a5f');
    skyGrad.addColorStop(0.35, '#d97757');
    skyGrad.addColorStop(0.65, '#f6bd60');
    skyGrad.addColorStop(1, '#2b2d42');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, w, h);

    // 2. Glowing sun disk
    const sunGrad = ctx.createRadialGradient(w * 0.72, h * 0.34, 10, w * 0.72, h * 0.34, 240);
    sunGrad.addColorStop(0, 'rgba(255, 248, 220, 0.95)');
    sunGrad.addColorStop(0.4, 'rgba(255, 183, 3, 0.45)');
    sunGrad.addColorStop(1, 'rgba(255, 183, 3, 0)');
    ctx.fillStyle = sunGrad;
    ctx.fillRect(0, 0, w, h);

    // 3. Distant layered mountains
    ctx.fillStyle = 'rgba(61, 64, 91, 0.75)';
    ctx.beginPath();
    ctx.moveTo(0, h * 0.66);
    ctx.lineTo(w * 0.25, h * 0.52);
    ctx.lineTo(w * 0.55, h * 0.61);
    ctx.lineTo(w * 0.85, h * 0.49);
    ctx.lineTo(w, h * 0.57);
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fill();

    // 4. Foreground hiker/traveler portrait silhouette & mask for 3D depth occlusion demo
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = w;
    maskCanvas.height = h;
    const mctx = maskCanvas.getContext('2d');

    const drawTraveler = (c, isMask) => {
      c.save();
      c.fillStyle = isMask ? '#FFFFFF' : '#1b263b';
      // Head & sun hat
      c.beginPath();
      c.arc(w * 0.48, h * 0.42, 68, 0, Math.PI * 2);
      c.fill();
      c.beginPath();
      c.ellipse(w * 0.48, h * 0.41, 118, 26, -0.08, 0, Math.PI * 2);
      c.fill();
      // Shoulders & jacket torso
      c.beginPath();
      c.moveTo(w * 0.31, h);
      c.quadraticCurveTo(w * 0.33, h * 0.53, w * 0.48, h * 0.50);
      c.quadraticCurveTo(w * 0.64, h * 0.53, w * 0.67, h);
      c.closePath();
      c.fill();
      // Camera held up
      c.beginPath();
      c.roundRect(w * 0.54, h * 0.54, 86, 62, 12);
      c.fill();
      if (!isMask) {
        // Warm rim light accent on traveler
        c.strokeStyle = 'rgba(255, 214, 102, 0.75)';
        c.lineWidth = 5;
        c.stroke();
      }
      c.restore();
    };

    drawTraveler(ctx, false);
    drawTraveler(mctx, true);

    const demoDataUrl = canvas.toDataURL('image/jpeg', 0.92);
    const demoExif = {
      dateTime: '2026:10:05 17:42:18',
      device: 'iPhone 16 Pro',
      make: 'Apple',
      gps: {
        lat: '31.2304',
        lon: '121.4737',
        latRef: 'N',
        lonRef: 'E'
      }
    };

    const demoItem = {
      id: 'demo-h5-photo',
      file: null,
      src: demoDataUrl,
      styledSrc: null,
      activeStyle: null,
      selected: true,
      width: w,
      height: h,
      exif: demoExif
    };

    const sampleCopy = [
      {
        title: '日落时分的浪漫出逃🌅这组巨幕封面直接封神！',
        body: '趁着周末好天气去追了一场橘子海日落✨\n随手拍的原图用 AI 一键生成了 3D 穿插大字封面，氛围感直接拉满！\n\n📍 打卡坐标：31.2304°N, 121.4737°E\n📷 拍摄设备：iPhone 16 Pro 原图直出\n💡 拍照机位建议：下午五点半逆光侧拍，开启人像描边超出片！',
        tags: '#小红书爆款封面 #落日氛围感 #旅行随手拍 #你拍照我生文 #OOTD穿搭'
      },
      {
        title: '被问爆的胶片感封面！3秒搞定大刊排版📸',
        body: '不用熬夜修图排版啦！上传原图自动读取拍摄时间与地点，无论是东方国风浅绛山水，还是杂志速报风封面，一键就能搞定～',
        tags: '#拍照姿势不重样 #手机摄影技巧 #小红书排版 #周末去哪儿'
      },
      {
        title: '秋日山野徒步日记⛰️把风景装进画里',
        body: '山野的风吹散了一周的疲惫，用白描与没骨画风重绘照片，每一帧都像东方美学的诗意留白。',
        tags: '#徒步丈量世界 #户外运动日常 #国风插画 #治愈系风景'
      }
    ];

    const sampleCovers = [
      { tag: '⚡ 落日速报', title: '氛围感彻底封神', subtitle: '2026 追光机位指南 · 建议先马后看' },
      { tag: '📸 机位实测', title: '橘子海日落大片', subtitle: 'iPhone 原图直出 · 零门槛出片' },
      { tag: '🏔️ 周末出逃', title: '旷野追风日记', subtitle: '31.23°N 城市边缘私藏观景台' }
    ];

    setUploadedImages([demoItem]);
    setActiveIdx(0);
    setCoverImageIdx(0);
    setOutlineMasks({ 0: maskCanvas });
    setGeneratedCopyOptions(sampleCopy);
    setActiveCopyOptionIdx(0);
    setAiTitle(sampleCopy[0].title);
    setAiBody(`${sampleCopy[0].body}\n\n${sampleCopy[0].tags}`);
    setCoverCandidates(sampleCovers);
    setCoverTag(sampleCovers[0].tag);
    setCoverTitle(sampleCovers[0].title);
    setCoverSubtitle(sampleCovers[0].subtitle);
    setShowWelcome(false);
    setActivePreviewTab('cover');
    setActiveTab('cover');
    showToast('✨ 已载入示例大片与 3D 人像蒙版，可自由切换体验！');
  };

  // Remove uploaded image
  const removeUploadedImage = (id, e) => {
    e.stopPropagation();
    const filtered = uploadedImages.filter(img => img.id !== id);
    setUploadedImages(filtered);
    setCachedVisualDescriptions(null); // Clear description cache
    
    if (activeIdx >= filtered.length) {
      setActiveIdx(Math.max(0, filtered.length - 1));
    }
  };

  // Clear all images
  const clearAllImages = () => {
    setUploadedImages([]);
    setActiveIdx(0);
    setGeneratedCopyOptions([]);
    setAiTitle('');
    setAiBody('');
    setCachedVisualDescriptions(null); // Clear description cache
    setCoverCandidates([]);
    setCoverPreviewUri('');
    setCoverImageIdx(0);
    setActiveTab('photos');
  };

  // Call Doubao style transfer model via backend (supporting multi-image parallel processing)
  const handleAIStyleTransfer = async (styleName) => {
    let targets = uploadedImages.filter(img => img.selected !== false);
    if (targets.length === 0) {
      const activeImage = uploadedImages[activeIdx];
      if (activeImage) targets = [activeImage];
    }
    
    if (targets.length === 0) return;
    
    setIsLoading(true);
    const styleLabelMap = {
      'cartoon': '吉卜力卡通化',
      'clay': '泥塑黏土化',
      'japanese-film': '日式胶片风',
      'oriental-tale': '东方故事风（建筑）',
      'baimiao': '传统白描风（建筑）',
      'qianjiang': '浅绛山水风（风景）',
      'mogu': '没骨画风（风景）'
    };
    const styleLabel = styleLabelMap[styleName] || '画风重绘';
    setAiOperationName(`画风重绘 · ${styleLabel} (${targets.length}张)`);
    setErrorMsg('');

    try {
      await Promise.all(targets.map(async (targetImage) => {
        // Use styledSrc as input if styled already, or fallback to original src
        const inputSrc = targetImage.styledSrc || targetImage.src;
        const compressedImage = await resizeImageBase64(inputSrc, 1024, 0.85);

        // Measure dimensions of original image to send to server for aspect ratio preservation
        let originalWidth = targetImage.width;
        let originalHeight = targetImage.height;
        if (!originalWidth || !originalHeight) {
          const dims = await new Promise((resolve) => {
            const tempImg = new Image();
            tempImg.onload = () => resolve({ w: tempImg.width, h: tempImg.height });
            tempImg.onerror = () => resolve({ w: 1024, h: 1024 });
            tempImg.src = targetImage.src;
          });
          originalWidth = dims.w;
          originalHeight = dims.h;
        }

        const res = await fetch(`${API_BASE}/api/ai/style-transfer`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            image: compressedImage,
            style: styleName,
            width: originalWidth,
            height: originalHeight
          })
        });

        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || '风格化重绘失败');
        }

        const result = await res.json();
        
        // Draw premium Leica-style visual watermark on the canvas before updating styledSrc
        const watermarkedImage = await applyVisualWatermark(result.image, styleName, result.model, targetImage.exif);
        
        // Update the image with the styled result
        setUploadedImages(prev => prev.map((img) => {
          if (img.id === targetImage.id) {
            return { 
              ...img, 
              aiRawSrc: result.image,
              styledSrc: watermarkedImage,
              activeStyle: styleName,
              activeStyleLabel: null,
              spektraApplied: false
            };
          }
          return img;
        }));

        // Invalidate cached outline mask for this image so it re-detects precisely on the new styled image
        const targetImgIdx = uploadedImages.findIndex(img => img.id === targetImage.id);
        if (targetImgIdx !== -1) {
          setOutlineMasks(prev => {
            const next = { ...prev };
            delete next[targetImgIdx];
            return next;
          });
        }
      }));

    } catch (err) {
      console.error(err);
      setErrorMsg(err.message || `AI 风格化（${styleLabel}）失败，请检查服务配置。`);
    } finally {
      setIsLoading(false);
      setAiOperationName('');
    }
  };

  // Restore styled image to original
  const restoreToOriginal = () => {
    clearTimeout(spektraLiveTimerRef.current);
    spektraPreviewReqIdRef.current += 1;
    let targets = uploadedImages.filter(img => img.selected !== false);
    if (targets.length === 0) {
      targets = [uploadedImages[activeIdx]].filter(Boolean);
    }
    const targetIds = targets.map(t => t.id);
    setUploadedImages(prev => prev.map((img) => {
      if (targetIds.includes(img.id)) {
        return { 
          ...img, 
          styledSrc: null,
          activeStyle: null,
          activeStyleLabel: null,
          spektraApplied: false,
          spektraRenderedEdge: 0
        };
      }
      return img;
    }));

    // Invalidate outline masks for restored images
    setOutlineMasks(prev => {
      const next = { ...prev };
      uploadedImages.forEach((img, idx) => {
        if (targetIds.includes(img.id)) {
          delete next[idx];
        }
      });
      return next;
    });
  };

  // Clear transient edit overlays when switching photo, main tab, or edit sub-tab
  useEffect(() => {
    setEditLivePreviewUri('');
    setEraseBrushStrokes([]);
    if (activeTab !== 'edit' || editSubTab !== 'erase') {
      setIsEraseBrushMode(false);
    }
    if (activeTab !== 'edit' || editSubTab !== 'bokeh') {
      setIsBokehTapFocusActive(false);
    }
  }, [activeIdx, activeTab, editSubTab]);

  // Redraw erase brush canvas whenever strokes or active canvas size update
  const redrawEraseCanvas = (strokesToDraw = eraseBrushStrokes) => {
    const canvas = eraseCanvasRef.current;
    const imgEl = eraseImgRef.current;
    if (!canvas || !imgEl) return;
    const w = imgEl.clientWidth || 400;
    const h = imgEl.clientHeight || 533;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255, 36, 66, 0.56)';
    ctx.fillStyle = 'rgba(255, 36, 66, 0.56)';

    for (const stroke of strokesToDraw) {
      const pts = stroke?.points || [];
      if (pts.length === 0) continue;
      ctx.lineWidth = stroke.size || eraseBrushSize;
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0].x * w, pts[0].y * h, ctx.lineWidth / 2, 0, Math.PI * 2);
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
  };

  useEffect(() => {
    if (activeTab === 'edit' && editSubTab === 'erase' && isEraseBrushMode) {
      const id = requestAnimationFrame(() => redrawEraseCanvas(eraseBrushStrokes));
      return () => cancelAnimationFrame(id);
    }
  }, [activeTab, editSubTab, isEraseBrushMode, eraseBrushStrokes]);

  const handleErasePointerDown = (e) => {
    const canvas = eraseCanvasRef.current;
    const imgEl = eraseImgRef.current;
    if (!canvas || !imgEl) return;
    const w = imgEl.clientWidth || 400;
    const h = imgEl.clientHeight || 533;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const rect = canvas.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    isErasingRef.current = true;
    currentEraseStrokeRef.current = { size: eraseBrushSize, points: [{ x, y }] };
    redrawEraseCanvas([...eraseBrushStrokes, currentEraseStrokeRef.current]);
  };

  const handleErasePointerMove = (e) => {
    if (!isErasingRef.current || !currentEraseStrokeRef.current) return;
    const canvas = eraseCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    const pts = currentEraseStrokeRef.current.points;
    const prev = pts[pts.length - 1];
    pts.push({ x, y });

    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = 'rgba(255, 36, 66, 0.56)';
    ctx.lineWidth = currentEraseStrokeRef.current.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(prev.x * canvas.width, prev.y * canvas.height);
    ctx.lineTo(x * canvas.width, y * canvas.height);
    ctx.stroke();
  };

  const handleErasePointerUp = () => {
    if (!isErasingRef.current) return;
    isErasingRef.current = false;
    if (currentEraseStrokeRef.current && currentEraseStrokeRef.current.points.length > 0) {
      const finalized = currentEraseStrokeRef.current;
      setEraseBrushStrokes((prev) => [...prev, finalized]);
    }
    currentEraseStrokeRef.current = null;
  };

  // Commit an image edit cleanly with undo history & original backup
  const commitImageEdit = (targetId, { dataUrl, width, height, label }) => {
    const targetIdx = uploadedImages.findIndex((img) => img.id === targetId);
    setUploadedImages((prev) =>
      prev.map((img) => {
        if (img.id !== targetId) return img;
        const snapshot = {
          src: img.src,
          width: img.width,
          height: img.height,
          editTag: img.editTag || null,
          isRaw: img.isRaw || false,
          rawData: img.rawData || null
        };
        const nextHistory = [...(img.editHistory || []), snapshot].slice(-8);
        return {
          ...img,
          originalSrc: img.originalSrc || img.src,
          originalWidth: img.originalWidth || img.width,
          originalHeight: img.originalHeight || img.height,
          originalRawData: img.originalRawData !== undefined ? img.originalRawData : (img.rawData || null),
          editHistory: nextHistory,
          src: dataUrl,
          width: width || img.width,
          height: height || img.height,
          styledSrc: null,
          activeStyle: null,
          activeStyleLabel: null,
          editTag: label || '✨ 已修图',
          spektraApplied: false,
          spektraRenderedEdge: 0,
          isRaw: false,
          rawData: null
        };
      })
    );
    if (targetIdx !== -1) {
      setOutlineMasks((prev) => {
        if (!prev[targetIdx]) return prev;
        const next = { ...prev };
        delete next[targetIdx];
        return next;
      });
    }
    setCachedVisualDescriptions(null);
    setActivePreviewTab('styled');
  };

  const handleUndoImageEdit = (targetId) => {
    const targetIdx = uploadedImages.findIndex((img) => img.id === targetId);
    setUploadedImages((prev) =>
      prev.map((img) => {
        if (img.id !== targetId) return img;
        const hist = img.editHistory || [];
        if (hist.length === 0) return img;
        const last = hist[hist.length - 1];
        return {
          ...img,
          src: last.src,
          width: last.width,
          height: last.height,
          editTag: last.editTag,
          isRaw: last.isRaw,
          rawData: last.rawData,
          editHistory: hist.slice(0, -1),
          styledSrc: null,
          activeStyle: null,
          activeStyleLabel: null,
          spektraApplied: false,
          spektraRenderedEdge: 0
        };
      })
    );
    if (targetIdx !== -1) {
      setOutlineMasks((prev) => {
        if (!prev[targetIdx]) return prev;
        const next = { ...prev };
        delete next[targetIdx];
        return next;
      });
    }
    setCachedVisualDescriptions(null);
    showToast('↩️ 已撤销上一步修图');
  };

  const handleResetImageToOriginal = (targetId) => {
    const targetIdx = uploadedImages.findIndex((img) => img.id === targetId);
    setUploadedImages((prev) =>
      prev.map((img) => {
        if (img.id !== targetId || !img.originalSrc) return img;
        return {
          ...img,
          src: img.originalSrc,
          width: img.originalWidth || img.width,
          height: img.originalHeight || img.height,
          rawData: img.originalRawData || null,
          isRaw: Boolean(img.originalRawData),
          editHistory: [],
          editTag: null,
          styledSrc: null,
          activeStyle: null,
          activeStyleLabel: null,
          spektraApplied: false,
          spektraRenderedEdge: 0
        };
      })
    );
    if (targetIdx !== -1) {
      setOutlineMasks((prev) => {
        if (!prev[targetIdx]) return prev;
        const next = { ...prev };
        delete next[targetIdx];
        return next;
      });
    }
    setCachedVisualDescriptions(null);
    showToast('↩️ 已恢复至初始上传原图');
  };

  // Shared helper: develop a single photo via SpektraLab (handles full-sensor RAW upgrade for HD export)
  const developSingleSpektraTarget = async (targetImage, paramsSnapshot, targetEdge, frameOffset = 0) => {
    const useAiInput = paramsSnapshot.sourceType === 'ai' && targetImage.aiRawSrc;
    let activeRawData = useAiInput ? null : (targetImage.rawData || null);

    if (
      !useAiInput &&
      targetImage.isRaw &&
      targetImage.file &&
      targetEdge > Math.max(activeRawData?.width || 0, activeRawData?.height || 0) &&
      !activeRawData?.isFullRaw
    ) {
      const fullDecoded = await decodeRawFile(targetImage.file, {
        full: true,
        baseUrl: import.meta.env.BASE_URL || '/'
      });
      activeRawData = fullDecoded.rawData;
    }

    const inputSrc = useAiInput ? targetImage.aiRawSrc : targetImage.src;
    const res = await renderSpektraImage(inputSrc, paramsSnapshot, targetImage.exif, {
      maxEdge: targetEdge,
      frameOffset,
      rawData: activeRawData
    });

    let finalImage = res.dataUrl;
    if (!paramsSnapshot.border && paramsSnapshot.withLeicaWatermark) {
      finalImage = await applyVisualWatermark(
        res.dataUrl,
        paramsSnapshot.film,
        'SpektraLab Spectral',
        targetImage.exif
      );
    }

    return {
      finalImage,
      filmLabel: res.filmLabel,
      renderedEdge: res.renderedMaxEdge || targetEdge,
      upgradedRawData: activeRawData && activeRawData !== targetImage.rawData ? activeRawData : null
    };
  };

  // Live preview SpektraLab film simulation / edge perforations / date back on active image
  const triggerLiveSpektraPreview = async (nextParams, targetImage) => {
    if (!targetImage) return;
    const reqId = ++spektraPreviewReqIdRef.current;
    setIsRenderingSpektra(true);
    setErrorMsg('');

    try {
      const result = await developSingleSpektraTarget(targetImage, nextParams, 1600, 0);
      if (reqId !== spektraPreviewReqIdRef.current) return;

      const targetIdx = uploadedImages.findIndex((img) => img.id === targetImage.id);
      setUploadedImages((prev) =>
        prev.map((img) => {
          if (img.id === targetImage.id) {
            return {
              ...img,
              styledSrc: result.finalImage,
              activeStyle: `spektra:${nextParams.film}`,
              activeStyleLabel: result.filmLabel,
              spektraApplied: true,
              spektraRenderedEdge: result.renderedEdge
            };
          }
          return img;
        })
      );

      if (targetIdx !== -1) {
        setOutlineMasks((prev) => {
          if (!prev[targetIdx]) return prev;
          const next = { ...prev };
          delete next[targetIdx];
          return next;
        });
      }
    } catch (err) {
      if (reqId === spektraPreviewReqIdRef.current) {
        console.error('[SpektraPreview]', err);
        setErrorMsg(`胶片显影预览失败: ${err.message}`);
      }
    } finally {
      if (reqId === spektraPreviewReqIdRef.current) {
        setIsRenderingSpektra(false);
      }
    }
  };

  const handleUpdateSpektraParams = (patch) => {
    const nextParams = { ...spektraParams, ...patch };
    setSpektraParams(nextParams);
    const keys = Object.keys(patch);
    if (keys.length === 1 && keys[0] === 'exportMaxEdge') {
      return;
    }
    setActivePreviewTab('styled');
    const target = uploadedImages[activeIdx];
    if (!target) return;
    clearTimeout(spektraLiveTimerRef.current);
    spektraLiveTimerRef.current = setTimeout(() => {
      triggerLiveSpektraPreview(nextParams, target);
    }, 180);
  };

  const handleBatchSpektraDevelop = async () => {
    let targets = uploadedImages.filter((img) => img.selected !== false);
    if (targets.length === 0) {
      const current = uploadedImages[activeIdx];
      if (current) targets = [current];
    }
    if (targets.length === 0) return;

    const targetEdge = spektraParams.exportMaxEdge || 3600;
    clearTimeout(spektraLiveTimerRef.current);
    spektraPreviewReqIdRef.current += 1;
    setIsBatchSpektra(true);
    setIsLoading(true);
    setAiOperationName(`SpektraLab 物理胶片冲印 ${targetEdge}px (${targets.length}张)`);
    setErrorMsg('');
    setActivePreviewTab('styled');

    try {
      const updates = new Map();
      const indicesToInvalidate = [];

      for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        const result = await developSingleSpektraTarget(target, spektraParams, targetEdge, i);

        updates.set(target.id, {
          styledSrc: result.finalImage,
          activeStyle: `spektra:${spektraParams.film}`,
          activeStyleLabel: result.filmLabel,
          spektraRenderedEdge: result.renderedEdge,
          ...(result.upgradedRawData
            ? {
                rawData: result.upgradedRawData,
                width: result.upgradedRawData.width,
                height: result.upgradedRawData.height
              }
            : {})
        });

        const idx = uploadedImages.findIndex((img) => img.id === target.id);
        if (idx !== -1) indicesToInvalidate.push(idx);
      }

      setUploadedImages((prev) =>
        prev.map((img) => {
          const patch = updates.get(img.id);
          return patch ? { ...img, ...patch, spektraApplied: true } : img;
        })
      );

      if (indicesToInvalidate.length > 0) {
        setOutlineMasks((prev) => {
          const next = { ...prev };
          for (const idx of indicesToInvalidate) delete next[idx];
          return next;
        });
      }

      showToast(`🎞️ 已完成 ${targets.length} 张照片的 ${targetEdge}px 高清暗房冲印！`);
    } catch (err) {
      console.error('[SpektraBatch]', err);
      setErrorMsg(`胶片冲印失败: ${err.message}`);
    } finally {
      setIsBatchSpektra(false);
      setIsLoading(false);
      setAiOperationName('');
    }
  };

  // Ensure export / long-press save uses full exportMaxEdge rather than 1600px live preview
  const ensureHighResSpektraImage = async (targetImage, frameOffset = 0) => {
    if (!targetImage) return '';
    const targetEdge = spektraParams.exportMaxEdge || 3600;
    const origLong = Math.max(targetImage.width || 0, targetImage.height || 0);
    const alreadyFullNative = !targetImage.isRaw && origLong > 0 && origLong <= (targetImage.spektraRenderedEdge || 0);
    if (!targetImage.spektraApplied || alreadyFullNative || (targetImage.spektraRenderedEdge || 0) >= targetEdge) {
      return targetImage.styledSrc || targetImage.src;
    }

    setIsLoading(true);
    setAiOperationName(`正在生成 ${targetEdge}px 超清胶片成片`);
    try {
      const result = await developSingleSpektraTarget(targetImage, spektraParams, targetEdge, frameOffset);
      setUploadedImages((prev) =>
        prev.map((img) =>
          img.id === targetImage.id
            ? {
                ...img,
                styledSrc: result.finalImage,
                activeStyle: `spektra:${spektraParams.film}`,
                activeStyleLabel: result.filmLabel,
                spektraApplied: true,
                spektraRenderedEdge: result.renderedEdge,
                ...(result.upgradedRawData
                  ? {
                      rawData: result.upgradedRawData,
                      width: result.upgradedRawData.width,
                      height: result.upgradedRawData.height
                    }
                  : {})
              }
            : img
        )
      );
      return result.finalImage;
    } finally {
      setIsLoading(false);
      setAiOperationName('');
    }
  };

  // Generate copywriting via backend LLM
  const handleGenerateAICopy = async () => {
    const selectedStyle = copyStyle;

    setIsGeneratingCopy(true);
    setErrorMsg('');

    try {
      // Prioritize the currently active image at index 0 so its EXIF and visual content are primary
      const orderedImages = [
        uploadedImages[activeIdx],
        ...uploadedImages.filter((_, idx) => idx !== activeIdx)
      ].filter(Boolean);

      // Compress all images to 512px low quality in parallel to speed up vision analysis
      const compressedImagesForCopy = await Promise.all(
        orderedImages.map(async (img) => {
          const src = img.styledSrc || img.src;
          return await resizeImageBase64(src, 512, 0.7);
        })
      );

      // Send the pre-extracted EXIF data directly to the server (lightweight JSON list)
      const exifDataList = orderedImages.map(img => {
        if (!img.exif) return null;
        return {
          dateTime: img.exif.dateTime,
          gps: img.exif.gps,
          device: img.exif.device,
          make: img.exif.make
        };
      });

      const res = await fetch(`${API_BASE}/api/ai/generate-copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          style: selectedStyle,
          keywords: copyKeywords,
          images: compressedImagesForCopy,
          exifList: exifDataList,
          visualDescriptions: cachedVisualDescriptions
        })
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || '文案生成失败');
      }

      const result = await res.json();
      if (result.visualDescriptions) {
        setCachedVisualDescriptions(result.visualDescriptions);
      }

      if (result.options && result.options.length > 0) {
        setGeneratedCopyOptions(result.options);
        setActiveCopyOptionIdx(0);
        
        // Populate inputs
        const firstOpt = result.options[0];
        setAiTitle(firstOpt.title);
        const cleanTags = (firstOpt.tags && firstOpt.tags !== 'undefined') ? firstOpt.tags : '';
        setAiBody(firstOpt.body + (cleanTags && !firstOpt.body.includes(cleanTags) ? `\n\n${cleanTags}` : ''));

        // If coverOptions are returned, populate cover candidates & inputs!
        if (result.coverOptions && result.coverOptions.length > 0) {
          setCoverCandidates(result.coverOptions);
          const firstCover = result.coverOptions[0];
          if (firstCover.tag) setCoverTag(firstCover.tag);
          if (firstCover.title) setCoverTitle(firstCover.title);
          if (firstCover.subtitle) setCoverSubtitle(firstCover.subtitle);
        }
      } else {
        throw new Error('未返回有效的文案选项');
      }
    } catch (err) {
      console.error('AICopy error:', err);
      setErrorMsg(err.message || 'AI 文案生成失败，请检查后端服务配置。');
    } finally {
      setIsGeneratingCopy(false);
    }
  };

  const applyCopyOption = (idx) => {
    if (!generatedCopyOptions[idx]) return;
    setActiveCopyOptionIdx(idx);
    const opt = generatedCopyOptions[idx];
    setAiTitle(opt.title);
    const cleanTags = (opt.tags && opt.tags !== 'undefined') ? opt.tags : '';
    setAiBody(opt.body + (cleanTags && !opt.body.includes(cleanTags) ? `\n\n${cleanTags}` : ''));

    // If matching cover option exists, sync it
    if (coverCandidates[idx]) {
      const cand = coverCandidates[idx];
      if (cand.tag) setCoverTag(cand.tag);
      if (cand.title) setCoverTitle(cand.title);
      if (cand.subtitle) setCoverSubtitle(cand.subtitle);
    }
  };

  // Generate punchy cover titles via AI
  const handleGenerateCoverTitles = async () => {
    if (uploadedImages.length === 0) {
      setErrorMsg('请先上传图片！');
      return;
    }
    setIsGeneratingCoverTitles(true);
    setErrorMsg('');

    try {
      const res = await fetch(`${API_BASE}/api/ai/generate-cover-titles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          style: copyStyle,
          keywords: copyKeywords,
          noteTitle: aiTitle,
          noteBody: aiBody,
          visualDescriptions: cachedVisualDescriptions
        })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || '生成封面标题失败');
      }

      const data = await res.json();
      if (data.coverOptions && data.coverOptions.length > 0) {
        setCoverCandidates(data.coverOptions);
        const firstCover = data.coverOptions[0];
        if (firstCover.tag) setCoverTag(firstCover.tag);
        if (firstCover.title) setCoverTitle(firstCover.title);
        if (firstCover.subtitle) setCoverSubtitle(firstCover.subtitle);
        setActivePreviewTab('cover');
      }
    } catch (err) {
      console.error(err);
      setErrorMsg(err.message || '生成封面标题失败，请检查网络配置');
    } finally {
      setIsGeneratingCoverTitles(false);
    }
  };

  // Download high-resolution cover image with EXIF preserved
  const downloadCoverImage = async () => {
    const target = uploadedImages[coverImageIdx] || uploadedImages[activeIdx];
    if (!target) return;

    try {
      setIsLoading(true);
      setAiOperationName('正在导出高清封面标题图');

      const src = target.styledSrc || target.src;
      const dataUri = await renderCoverCanvas(src, {
        tag: coverTag,
        title: coverTitle,
        subtitle: coverSubtitle,
        style: coverStyle,
        position: coverPosition,
        align: coverAlign,
        subjectOcclusion,
        outlineEnabled,
        outlineType,
        outlineColor,
        outlineWidth,
        outlineMask: outlineMasks[coverImageIdx] || null,
        doodleStrokes: doodleStrokes[coverImageIdx] || [],
        exif: target.exif
      });

      const fileName = `xhs-cover-${coverStyle}-${Date.now()}.jpg`;
      handleSaveOrDownloadImage(dataUri, fileName, `小红书封面 (${coverStyle})`);
    } catch (err) {
      console.error('Download cover image failed:', err);
      setErrorMsg('导出封面标题图失败，请重试');
    } finally {
      setIsLoading(false);
      setAiOperationName('');
    }
  };

  // Helper: Clean text from emojis, formatting, and hashtags for a clean TTS read
  // Helper: Export full multi-modal analysis report (copywriting + original images + EXIF details) as a beautiful card image
  const exportReportCard = async () => {
    if (uploadedImages.length === 0) return;
    const opt = generatedCopyOptions[activeCopyOptionIdx];
    if (!opt) {
      alert('请先生成 AI 文案后再导出报告卡片！');
      return;
    }

    setIsLoading(true);
    setAiOperationName('正在生成分析报告图片...');

    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const width = 800;

      // Load all uploaded/styled images
      const loadedImages = await Promise.all(uploadedImages.map(img => {
        return new Promise((resolve) => {
          const imageObj = new Image();
          imageObj.crossOrigin = 'anonymous';
          imageObj.onload = () => resolve(imageObj);
          imageObj.onerror = () => resolve(null);
          imageObj.src = img.styledSrc || img.src;
        });
      }));

      const validImages = loadedImages.filter(Boolean);

      // Determine heights
      let imagesHeight = 0;
      if (validImages.length > 0) {
        imagesHeight = validImages.length === 1 ? 400 : (validImages.length === 2 ? 300 : 580);
      }
      
      const exifHeight = 120;
      const contentWidth = width - 80; // 40px padding on each side

      // Measure copywriting body wrapping height
      ctx.font = '16px "Inter", sans-serif';
      const bodyLines = (aiBody || '').split('\n');
      let bodyLinesCount = 0;
      bodyLines.forEach(lineText => {
        const words = Array.from(lineText);
        let currentLine = '';
        bodyLinesCount++;
        for (let i = 0; i < words.length; i++) {
          let testLine = currentLine + words[i];
          let metrics = ctx.measureText(testLine);
          if (metrics.width > contentWidth && i > 0) {
            bodyLinesCount++;
            currentLine = words[i];
          } else {
            currentLine = testLine;
          }
        }
      });
      const bodyHeight = bodyLinesCount * 26 + 30;

      const titleHeight = 45;
      const footerHeight = 80;
      const totalHeight = 120 + imagesHeight + exifHeight + titleHeight + bodyHeight + footerHeight + 40;

      canvas.width = width;
      canvas.height = totalHeight;

      // 1. Draw Background
      ctx.fillStyle = '#FAF9F6';
      ctx.fillRect(0, 0, width, totalHeight);

      // 2. Draw outer borders
      ctx.strokeStyle = '#D1CFC7';
      ctx.lineWidth = 1;
      ctx.strokeRect(20, 20, width - 40, totalHeight - 40);
      ctx.strokeRect(24, 24, width - 48, totalHeight - 48);

      // 3. Draw Header
      ctx.fillStyle = '#1A1A1A';
      ctx.textAlign = 'left';
      ctx.font = 'bold 26px sans-serif';
      ctx.fillText('闪贴 AI', 40, 75);

      ctx.fillStyle = '#6366F1';
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText('· 智能图文分析报告 ·', 150, 70);

      ctx.fillStyle = '#666666';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'right';
      const nowStr = new Date().toLocaleString('zh-CN', { hour12: false });
      ctx.fillText(nowStr, width - 40, 72);

      // Divider
      ctx.strokeStyle = '#E2E0D9';
      ctx.beginPath();
      ctx.moveTo(40, 100);
      ctx.lineTo(width - 40, 100);
      ctx.stroke();

      let currentY = 120;

      // 4. Draw Image Grid (using contain style with light background frame to prevent cropping)
      if (validImages.length > 0) {
        const gap = 15;
        const drawContainImage = (context, img, x, y, w, h) => {
          context.save();
          // Draw a clean light background for the frame
          context.fillStyle = '#EAE8E4';
          context.beginPath();
          context.roundRect(x, y, w, h, 8);
          context.fill();

          context.beginPath();
          context.roundRect(x, y, w, h, 8);
          context.clip();

          const imgRatio = img.width / img.height;
          const targetRatio = w / h;
          let dx, dy, dWidth, dHeight;

          if (imgRatio > targetRatio) {
            dWidth = w;
            dHeight = w / imgRatio;
            dx = x;
            dy = y + (h - dHeight) / 2;
          } else {
            dHeight = h;
            dWidth = h * imgRatio;
            dx = x + (w - dWidth) / 2;
            dy = y;
          }

          context.drawImage(img, dx, dy, dWidth, dHeight);
          context.restore();
        };

        if (validImages.length === 1) {
          drawContainImage(ctx, validImages[0], 40, currentY, 720, 400);
          currentY += 400 + 20;
        } else if (validImages.length === 2) {
          const imgW = 350;
          const imgH = 300;
          drawContainImage(ctx, validImages[0], 40, currentY, imgW, imgH);
          drawContainImage(ctx, validImages[1], 40 + imgW + gap, currentY, imgW, imgH);
          currentY += imgH + 20;
        } else {
          const imgW = 350;
          const imgH = 260;
          // Row 1
          drawContainImage(ctx, validImages[0], 40, currentY, imgW, imgH);
          if (validImages[1]) drawContainImage(ctx, validImages[1], 40 + imgW + gap, currentY, imgW, imgH);
          currentY += imgH + gap;
          // Row 2
          if (validImages[2]) drawContainImage(ctx, validImages[2], 40, currentY, imgW, imgH);
          if (validImages[3]) drawContainImage(ctx, validImages[3], 40 + imgW + gap, currentY, imgW, imgH);
          currentY += imgH + 20;
        }
      }

      // 5. Draw EXIF Meta Information Box
      ctx.fillStyle = '#EAE8E4';
      ctx.beginPath();
      ctx.roundRect(40, currentY, width - 80, 100, 6);
      ctx.fill();

      ctx.fillStyle = '#1A1A1A';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('📸 照片 EXIF 元数据分析', 60, currentY + 30);

      ctx.fillStyle = '#444444';
      ctx.font = '13px sans-serif';

      const activeImage = uploadedImages[activeIdx];
      const activeExif = activeImage?.exif;
      const deviceName = activeExif?.device || '未知设备 (无EXIF元数据)';
      const dateText = activeExif?.dateTime || '未知时间 (无EXIF元数据)';
      let gpsText = '无位置信息';
      if (activeExif?.gps) {
        const lat = parseFloat(activeExif.gps.lat) || 0;
        const lon = parseFloat(activeExif.gps.lon) || 0;
        gpsText = `${lat.toFixed(4)}° ${activeExif.gps.latRef || 'N'}, ${lon.toFixed(4)}° ${activeExif.gps.lonRef || 'E'}`;
      }

      ctx.fillText(`拍摄设备: ${deviceName}`, 60, currentY + 55);
      ctx.fillText(`拍摄日期: ${dateText}`, 60, currentY + 75);
      ctx.fillText(`拍摄地点: ${gpsText}`, 400, currentY + 55);
      ctx.fillText(`分析图集: 共包含 ${uploadedImages.length} 张照片的组合分析`, 400, currentY + 75);

      currentY += 120;

      // 6. Draw Copywriting Block
      ctx.fillStyle = '#6366F1';
      ctx.fillRect(40, currentY, 4, bodyHeight + titleHeight);

      // Title
      ctx.fillStyle = '#1A1A1A';
      ctx.font = 'bold 20px sans-serif';
      ctx.fillText(`【${aiTitle || '未命名标题'}】`, 60, currentY + 25);

      // Wrapped Body Text
      ctx.fillStyle = '#2D2D2D';
      ctx.font = '16px "Inter", sans-serif';
      
      const drawWrappedText = (context, text, x, y, maxWidth, lineHeight) => {
        const lines = text.split('\n');
        let tempY = y;
        lines.forEach(lineText => {
          const chars = Array.from(lineText);
          let currentLine = '';
          for (let n = 0; n < chars.length; n++) {
            let testLine = currentLine + chars[n];
            let metrics = context.measureText(testLine);
            if (metrics.width > maxWidth && n > 0) {
              context.fillText(currentLine, x, tempY);
              currentLine = chars[n];
              tempY += lineHeight;
            } else {
              currentLine = testLine;
            }
          }
          context.fillText(currentLine, x, tempY);
          tempY += lineHeight;
        });
      };

      drawWrappedText(ctx, aiBody || '', 60, currentY + 60, contentWidth - 30, 26);
      currentY += bodyHeight + titleHeight;

      // 7. Draw Footer
      ctx.strokeStyle = '#E2E0D9';
      ctx.beginPath();
      ctx.moveTo(40, currentY);
      ctx.lineTo(width - 40, currentY);
      ctx.stroke();

      currentY += 30;

      ctx.fillStyle = '#888888';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('本报告由 闪贴AI 平台多模态智能服务分析生成', 40, currentY);

      ctx.textAlign = 'right';
      ctx.fillText('你拍照 · 我生文 · 记录美好生活', width - 40, currentY);

      // Trigger download or save modal
      const dataUri = canvas.toDataURL('image/jpeg', 0.95);
      const fileName = `shantie-ai-report-${Date.now()}.jpg`;
      handleSaveOrDownloadImage(dataUri, fileName, '智能图文分析报告');
    } catch (err) {
      console.error('Failed to export report card:', err);
      showToast('导出报告卡片失败，请重试');
    } finally {
      setIsLoading(false);
      setAiOperationName('');
    }
  };

  // Helper: Draw visual photography watermark (Leica-style white border at bottom)
  const applyVisualWatermark = (base64Image, styleName, modelName, exif) => {
    return new Promise((resolve) => {
      const img = new Image();
      if (base64Image && !base64Image.startsWith('data:')) {
        img.crossOrigin = 'anonymous';
      }
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        // We add an 8% height white border at the bottom for the watermark strip
        const watermarkHeight = Math.round(img.height * 0.08);
        canvas.width = img.width;
        canvas.height = img.height + watermarkHeight;
        
        // Fill background white
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        // Draw original styled image
        ctx.drawImage(img, 0, 0);
        
        // Draw Watermark text
        ctx.fillStyle = '#1a1a1a';
        
        // Left text: Brand & Style
        const leftTitle = '闪贴 AI';
        
        let leftSubtitle = '吉卜力动漫风 | Ghibli Style';
        if (styleName === 'clay') {
          leftSubtitle = '泥塑黏土风 | Clay Style';
        } else if (styleName === 'japanese-film') {
          leftSubtitle = '日式胶片风 | Retro Film';
        } else if (styleName === 'polaroid') {
          leftSubtitle = '经典拍立得风 | Polaroid';
        } else if (styleName === 'oriental-tale') {
          leftSubtitle = '东方故事风 | Oriental Tale';
        } else if (styleName === 'baimiao') {
          leftSubtitle = '传统白描风 | Baimiao Line Art';
        } else if (styleName === 'qianjiang') {
          leftSubtitle = '浅绛山水风 | Qianjiang Landscape';
        } else if (styleName === 'mogu') {
          leftSubtitle = '没骨画风 | Boneless Painting';
        }
        
        const fontSizeMain = Math.round(watermarkHeight * 0.28);
        const fontSizeSub = Math.round(watermarkHeight * 0.18);
        const paddingX = Math.round(canvas.width * 0.04);
        
        // Align left texts
        ctx.textAlign = 'left';
        ctx.font = `bold ${fontSizeMain}px sans-serif`;
        ctx.fillText(leftTitle, paddingX, img.height + watermarkHeight * 0.42);
        
        ctx.fillStyle = '#666666';
        ctx.font = `${fontSizeSub}px sans-serif`;
        ctx.fillText(leftSubtitle, paddingX, img.height + watermarkHeight * 0.72);
        
        // Right text: Model & Date/Location info
        ctx.textAlign = 'right';
        ctx.fillStyle = '#1a1a1a';
        ctx.font = `bold ${fontSizeMain}px sans-serif`;
        
        let rightTitle = 'AI Style Studio';
        if (modelName === 'dashscope-wanx') {
          rightTitle = 'DashScope Wanx 2.1';
        } else if (modelName === 'SpektraLab Spectral') {
          rightTitle = 'SpektraLab Spectral';
        }
        ctx.fillText(rightTitle, canvas.width - paddingX, img.height + watermarkHeight * 0.42);
        
        // Extract date/time and GPS coords
        let dateStr = '';
        if (exif && exif.dateTime) {
          // Reformat "2026:07:11 10:15:30" to "2026.07.11 10:15"
          const parts = exif.dateTime.split(' ');
          if (parts[0]) {
            dateStr = parts[0].replace(/:/g, '.');
          }
        }
        
        let locStr = '';
        if (exif && exif.gps) {
          const lat = parseFloat(exif.gps.lat) || 0;
          const lon = parseFloat(exif.gps.lon) || 0;
          locStr = `${lat.toFixed(4)}° ${exif.gps.latRef || 'N'}  ${lon.toFixed(4)}° ${exif.gps.lonRef || 'E'}`;
        } else if (exif && exif.device) {
          locStr = exif.device;
        }
        
        ctx.fillStyle = '#666666';
        ctx.font = `${fontSizeSub}px sans-serif`;
        const rightSubtitle = `${dateStr}  ${locStr}`.trim() || 'AI 智能创作';
        ctx.fillText(rightSubtitle, canvas.width - paddingX, img.height + watermarkHeight * 0.72);
        
        const watermarkedDataUri = canvas.toDataURL('image/jpeg', 0.95);
        try {
          const piexifLib = getPiexif();
          let exifObj = null;

          // 1. Try loading raw bytes if available and reset Orientation to 1
          if (exif && exif.rawBytes) {
            try {
              exifObj = piexifLib.load(exif.rawBytes);
              exifObj["0th"] = exifObj["0th"] || {};
              exifObj["0th"][piexifLib.ImageIFD.Orientation] = 1; // CRITICAL: Reset orientation to 1 (upright) since canvas already oriented the pixels
              exifObj["0th"][piexifLib.ImageIFD.Software] = "Shantie AI";
              delete exifObj["thumbnail"];
            } catch (rawErr) {
              console.warn('[Watermark EXIF] Failed to modify raw EXIF, fallback to structured EXIF:', rawErr);
              exifObj = null;
            }
          }

          // 2. Build structured EXIF object if raw EXIF wasn't usable
          if (!exifObj) {
            exifObj = { 
              "0th": {
                [piexifLib.ImageIFD.Orientation]: 1, // CRITICAL: Reset to normal orientation
                [piexifLib.ImageIFD.Software]: "Shantie AI"
              }, 
              "Exif": {}, 
              "GPS": {}, 
              "Interop": {}, 
              "1st": {}, 
              "thumbnail": null 
            };
            
            if (exif) {
              if (exif.dateTime) {
                exifObj["0th"][piexifLib.ImageIFD.DateTime] = String(exif.dateTime);
                exifObj["Exif"][piexifLib.ExifIFD.DateTimeOriginal] = String(exif.dateTime);
                exifObj["Exif"][piexifLib.ExifIFD.DateTimeDigitized] = String(exif.dateTime);
              }
              
              if (exif.device) {
                exifObj["0th"][piexifLib.ImageIFD.Model] = String(exif.device);
              }
              if (exif.make) {
                exifObj["0th"][piexifLib.ImageIFD.Make] = String(exif.make);
              }
              
              if (exif.gps) {
                const latVal = parseFloat(exif.gps.lat);
                const lonVal = parseFloat(exif.gps.lon);
                if (!isNaN(latVal) && !isNaN(lonVal)) {
                  const latAbs = Math.abs(latVal);
                  const lonAbs = Math.abs(lonVal);
                  const latDeg = Math.floor(latAbs);
                  const latMin = Math.floor((latAbs - latDeg) * 60);
                  const latSec = Math.round(((latAbs - latDeg) * 60 - latMin) * 60 * 100);
                  const lonDeg = Math.floor(lonAbs);
                  const lonMin = Math.floor((lonAbs - lonDeg) * 60);
                  const lonSec = Math.round(((lonAbs - lonDeg) * 60 - lonMin) * 60 * 100);
                  
                  exifObj["GPS"][piexifLib.GPSIFD.GPSVersionID] = [2, 2, 0, 0];
                  exifObj["GPS"][piexifLib.GPSIFD.GPSLatitude] = [[latDeg, 1], [latMin, 1], [latSec, 100]];
                  exifObj["GPS"][piexifLib.GPSIFD.GPSLatitudeRef] = exif.gps.latRef || (latVal >= 0 ? "N" : "S");
                  exifObj["GPS"][piexifLib.GPSIFD.GPSLongitude] = [[lonDeg, 1], [lonMin, 1], [lonSec, 100]];
                  exifObj["GPS"][piexifLib.GPSIFD.GPSLongitudeRef] = exif.gps.lonRef || (lonVal >= 0 ? "E" : "W");
                }
              }
            }
          } else {
            // Ensure GPS is populated if raw EXIF lacked it but ExifReader found it
            if (exif && exif.gps && (!exifObj["GPS"] || !exifObj["GPS"][piexifLib.GPSIFD.GPSLatitude])) {
              exifObj["GPS"] = exifObj["GPS"] || {};
              const latVal = parseFloat(exif.gps.lat);
              const lonVal = parseFloat(exif.gps.lon);
              if (!isNaN(latVal) && !isNaN(lonVal)) {
                const latAbs = Math.abs(latVal);
                const lonAbs = Math.abs(lonVal);
                const latDeg = Math.floor(latAbs);
                const latMin = Math.floor((latAbs - latDeg) * 60);
                const latSec = Math.round(((latAbs - latDeg) * 60 - latMin) * 60 * 100);
                const lonDeg = Math.floor(lonAbs);
                const lonMin = Math.floor((lonAbs - lonDeg) * 60);
                const lonSec = Math.round(((lonAbs - lonDeg) * 60 - lonMin) * 60 * 100);
                
                exifObj["GPS"][piexifLib.GPSIFD.GPSVersionID] = [2, 2, 0, 0];
                exifObj["GPS"][piexifLib.GPSIFD.GPSLatitude] = [[latDeg, 1], [latMin, 1], [latSec, 100]];
                exifObj["GPS"][piexifLib.GPSIFD.GPSLatitudeRef] = exif.gps.latRef || (latVal >= 0 ? "N" : "S");
                exifObj["GPS"][piexifLib.GPSIFD.GPSLongitude] = [[lonDeg, 1], [lonMin, 1], [lonSec, 100]];
                exifObj["GPS"][piexifLib.GPSIFD.GPSLongitudeRef] = exif.gps.lonRef || (lonVal >= 0 ? "E" : "W");
              }
            }
          }
          
          const exifBytes = piexifLib.dump(exifObj);
          const finalDataUri = piexifLib.insert(exifBytes, watermarkedDataUri);
          console.log('[Watermark EXIF] ✅ Successfully injected clean EXIF (Orientation: 1, GPS included)');
          resolve(finalDataUri);
        } catch (exifErr) {
          console.warn('[Watermark EXIF] Failed to inject EXIF into watermarked image:', exifErr);
          resolve(watermarkedDataUri);
        }
      };
      img.onerror = () => {
        resolve(base64Image); // fallback
      };
      img.src = base64Image;
    });
  };

  // Helper: Draw round rectangle compatible across all browsers
  const drawRoundRect = (ctx, x, y, width, height, radius) => {
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(x, y, width, height, radius);
      return;
    }
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  };

  // Helper: Measure and wrap text into multiple lines
  const wrapCanvasTextLines = (ctx, text, maxWidth) => {
    if (!text) return [];
    const chars = Array.from(text);
    const lines = [];
    let currentLine = '';

    for (let i = 0; i < chars.length; i++) {
      const char = chars[i];
      if (char === '\n') {
        if (currentLine) lines.push(currentLine);
        currentLine = '';
        continue;
      }
      const testLine = currentLine + char;
      const metrics = ctx.measureText(testLine);
      if (metrics.width > maxWidth && currentLine.length > 0) {
        lines.push(currentLine);
        currentLine = char;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) {
      lines.push(currentLine);
    }
    return lines;
  };

  // Helper: Render high-impact Xiaohongshu Cover Title Card on Canvas (6 styles: giant, magazine, minimal, sticker, cinema, collage)
  const renderCoverCanvas = (imageSrc, {
    tag = '⚡ BREAKING 速报',
    title = '氛围感彻底封神',
    subtitle = '2026 视觉精选指南 · 建议先马后看',
    style = 'giant',
    position = 'top',
    align = 'left',
    subjectOcclusion = true,
    outlineEnabled = false,
    outlineType = 'dashed',
    outlineColor = '#FFFFFF',
    outlineWidth = 10,
    outlineMask = null,
    doodleStrokes = [],
    exif = null
  }) => {
    return new Promise((resolve, reject) => {
      if (!imageSrc) {
        reject(new Error('No image source provided'));
        return;
      }

      const img = new Image();
      if (!imageSrc.startsWith('data:')) {
        img.crossOrigin = 'anonymous';
      }

      img.onload = () => {
        try {
          const w = img.width;
          const h = img.height;
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');

          // 1. Draw base image
          ctx.drawImage(img, 0, 0, w, h);

          const scale = Math.max(0.65, w / 1000);

          // Helper: Draw Hand-drawn Outline around person
          const renderOutline = () => {
            if (!outlineEnabled || !outlineMask) return;
            try {
              const strokeCanvas = document.createElement('canvas');
              strokeCanvas.width = w;
              strokeCanvas.height = h;
              const sctx = strokeCanvas.getContext('2d');

              const strokeW = Math.max(4, Math.round((outlineWidth || 10) * scale));
              const numSteps = 36;

              for (let i = 0; i < numSteps; i++) {
                const angle = (i / numSteps) * Math.PI * 2;
                const dx = Math.cos(angle) * strokeW;
                const dy = Math.sin(angle) * strokeW;
                sctx.drawImage(outlineMask, dx, dy, w, h);
              }

              sctx.globalCompositeOperation = 'source-in';
              sctx.fillStyle = outlineColor || '#FFFFFF';
              sctx.fillRect(0, 0, w, h);

              sctx.globalCompositeOperation = 'destination-out';
              sctx.drawImage(outlineMask, 0, 0, w, h);
              sctx.globalCompositeOperation = 'source-over';

              if (outlineType === 'dashed') {
                const dashCanvas = document.createElement('canvas');
                dashCanvas.width = w;
                dashCanvas.height = h;
                const dctx = dashCanvas.getContext('2d');
                dctx.drawImage(strokeCanvas, 0, 0);

                dctx.globalCompositeOperation = 'destination-out';
                const stripeCanvas = document.createElement('canvas');
                stripeCanvas.width = Math.round(26 * scale);
                stripeCanvas.height = Math.round(26 * scale);
                const spCtx = stripeCanvas.getContext('2d');
                spCtx.fillStyle = '#000000';
                spCtx.fillRect(0, 0, Math.round(11 * scale), Math.round(26 * scale));

                const pattern = dctx.createPattern(stripeCanvas, 'repeat');
                dctx.fillStyle = pattern;
                dctx.fillRect(0, 0, w, h);

                ctx.drawImage(dashCanvas, 0, 0);
              } else if (outlineType === 'glow') {
                ctx.save();
                ctx.shadowColor = outlineColor || '#FFFFFF';
                ctx.shadowBlur = Math.round(strokeW * 1.6);
                ctx.drawImage(strokeCanvas, 0, 0);
                ctx.drawImage(strokeCanvas, 0, 0);
                ctx.restore();
              } else {
                ctx.drawImage(strokeCanvas, 0, 0);
              }
            } catch (maskErr) {
              console.warn('[renderCoverCanvas] Subject outline render error:', maskErr);
            }
          };

          // Helper: Draw User Freehand Doodles
          const renderDoodles = () => {
            if (!doodleStrokes || doodleStrokes.length === 0) return;
            doodleStrokes.forEach(st => {
              if (st.points && st.points.length > 1) {
                ctx.save();
                ctx.strokeStyle = st.color || '#FFFFFF';
                ctx.lineWidth = Math.max(3, Math.round((st.width || 8) * scale));
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                if (st.type === 'dashed') {
                  ctx.setLineDash([12 * scale, 8 * scale]);
                }
                ctx.beginPath();
                ctx.moveTo(st.points[0].x * w, st.points[0].y * h);
                for (let j = 1; j < st.points.length; j++) {
                  ctx.lineTo(st.points[j].x * w, st.points[j].y * h);
                }
                ctx.stroke();
                ctx.restore();
              }
            });
          };

          // Helper: Subject Occlusion (Person cutout drawn on top of background & text)
          const renderSubjectOcclusion = () => {
            if (!subjectOcclusion || !outlineMask) return;
            try {
              const personCanvas = document.createElement('canvas');
              personCanvas.width = w;
              personCanvas.height = h;
              const pctx = personCanvas.getContext('2d');
              pctx.imageSmoothingEnabled = true;
              pctx.imageSmoothingQuality = 'high';

              // Ensure the mask matches target canvas dimensions with high-precision anti-aliasing
              let solidMaskCanvas;
              if (outlineMask.width === w && outlineMask.height === h) {
                solidMaskCanvas = outlineMask;
              } else {
                solidMaskCanvas = refineSubjectSegmentationMask(outlineMask, w, h);
              }

              // Clip the 100% solid person cutout from the source image
              pctx.drawImage(solidMaskCanvas, 0, 0, w, h);
              pctx.globalCompositeOperation = 'source-in';
              pctx.drawImage(img, 0, 0, w, h);

              // Draw the solid person cutout on top of background & giant text
              ctx.drawImage(personCanvas, 0, 0);
            } catch (occErr) {
              console.warn('[renderCoverCanvas] Subject occlusion error:', occErr);
            }
          };

          // If subjectOcclusion is NOT active, draw outline and doodles on base image directly
          if (!subjectOcclusion) {
            renderOutline();
            renderDoodles();
          }

          const tagText = (tag || '').trim();
          const titleText = (title || '').trim();
          const subText = (subtitle || '').trim();

          const titleFontSize = Math.round(54 * scale);
          const subFontSize = Math.round(24 * scale);
          const tagFontSize = Math.round(22 * scale);

          // Pre-calculate wrapped lines for default styles
          ctx.font = `900 ${titleFontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif`;
          const maxTitleWidth = style === 'minimal' ? w * 0.78 : (style === 'sticker' ? w * 0.82 : w * 0.86);
          const titleLines = wrapCanvasTextLines(ctx, titleText || '点击输入号召力大标题', maxTitleWidth);

          // 2. Render according to selected style
          if (style === 'giant') {
            // --- STYLE 6: 巨幕穿插风 (Giant Typography & Depth Occlusion) ---
            // Main title occupies ~40% - 46% of the canvas vertical screen area (~15% larger than original)
            const padX = 36 * scale;

            // 1. Split title into punchy lines (typically 2-3 lines of 2-5 characters)
            let giantLines = [];
            if (titleText.length <= 4) {
              giantLines = [titleText];
            } else if (titleText.length <= 8) {
              const half = Math.ceil(titleText.length / 2);
              giantLines = [titleText.slice(0, half), titleText.slice(half)];
            } else if (titleText.length <= 15) {
              const chunk = Math.ceil(titleText.length / 3);
              giantLines = [
                titleText.slice(0, chunk),
                titleText.slice(chunk, chunk * 2),
                titleText.slice(chunk * 2)
              ].filter(Boolean);
            } else {
              giantLines = wrapCanvasTextLines(ctx, titleText, w * 0.90);
            }

            // 2. Dynamically calculate font size: ~15% larger than previous baseline
            const maxLineChars = Math.max(...giantLines.map(l => l.length), 1);
            const targetBlockH = h * 0.44; // Target ~44% of canvas height (increased by 15% from 0.38)
            const maxFontByWidth = (w * 1.02) / maxLineChars;
            const fontByTargetHeight = targetBlockH / (giantLines.length * 1.12);
            const giantTitleFontSize = Math.round(Math.min(maxFontByWidth, fontByTargetHeight, 300 * scale));
            const lineH = giantTitleFontSize * 1.12;
            const totalTitleH = giantLines.length * lineH;

            // Determine vertical position:
            // 'top': upper 10%-54% of screen (behind head/shoulders)
            // 'center': middle ~26%-70% of screen
            // 'bottom': lower half
            let blockY = position === 'top' 
              ? h * 0.10 
              : (position === 'center' ? (h - totalTitleH) / 2 : h - totalTitleH - h * 0.10);

            // Soft contrast scrim behind the giant text (gentle to avoid dark horizontal bands)
            const scrimGrad = ctx.createLinearGradient(0, Math.max(0, blockY - 50 * scale), 0, blockY + totalTitleH + 50 * scale);
            scrimGrad.addColorStop(0, 'rgba(0, 0, 0, 0)');
            scrimGrad.addColorStop(0.35, 'rgba(0, 0, 0, 0.15)');
            scrimGrad.addColorStop(0.65, 'rgba(0, 0, 0, 0.15)');
            scrimGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
            ctx.fillStyle = scrimGrad;
            ctx.fillRect(0, Math.max(0, blockY - 50 * scale), w, totalTitleH + 100 * scale);

            // Render Giant Title Typography (Layer: Behind Subject)
            ctx.save();
            ctx.font = `900 ${giantTitleFontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';

            // Multi-tier deep soft shadow + clean subtle dark contour
            ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
            ctx.shadowBlur = 26 * scale;
            ctx.shadowOffsetY = 9 * scale;

            let textY = blockY;
            const maxAllowW = w - padX * 2;

            giantLines.forEach((line) => {
              const rawW = ctx.measureText(line).width;
              // Subtle condensed scaling if line exceeds margins, ensuring characters stay cleanly framed
              const scaleX = rawW > maxAllowW ? maxAllowW / rawW : 1.0;
              const lineW = rawW * scaleX;

              let lineX = padX;
              if (align === 'center') {
                lineX = (w - lineW) / 2;
              } else if (align === 'right') {
                lineX = w - padX - lineW;
              }

              ctx.save();
              ctx.translate(lineX, textY);
              if (scaleX !== 1.0) {
                ctx.scale(scaleX, 1.0);
              }

              // Subtle dark contour
              ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
              ctx.lineWidth = 3.5 * scale;
              ctx.strokeText(line, 0, 0);

              // Pure Chalk White main text
              ctx.fillStyle = '#FFFFFF';
              ctx.fillText(line, 0, 0);
              ctx.restore();

              textY += lineH;
            });
            ctx.restore();

          } else if (style === 'magazine') {
            // --- STYLE 1: 杂志大片速报风 ---
            const padX = 52 * scale;
            const titleLineH = titleFontSize * 1.25;
            const totalTitleH = titleLines.length * titleLineH;
            const tagH = tagText ? tagFontSize * 1.85 : 0;
            const tagMarginB = tagText ? 18 * scale : 0;
            const subH = subText ? subFontSize * 1.3 : 0;
            const subMarginT = subText ? 12 * scale : 0;
            const totalContentH = tagH + tagMarginB + totalTitleH + subMarginT + subH;

            let blockY = position === 'top' 
              ? h * 0.12 
              : (position === 'center' ? (h - totalContentH) / 2 : h - totalContentH - h * 0.10);

            // Deep gradient scrim for 100% legibility over any background
            const scrimGrad = ctx.createLinearGradient(
              0,
              position === 'top' ? 0 : (position === 'center' ? blockY - 50 * scale : blockY - 90 * scale),
              0,
              position === 'top' ? blockY + totalContentH + 90 * scale : (position === 'center' ? blockY + totalContentH + 50 * scale : h)
            );

            if (position === 'top') {
              scrimGrad.addColorStop(0, 'rgba(0, 0, 0, 0.88)');
              scrimGrad.addColorStop(0.65, 'rgba(0, 0, 0, 0.55)');
              scrimGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
              ctx.fillStyle = scrimGrad;
              ctx.fillRect(0, 0, w, blockY + totalContentH + 90 * scale);
            } else if (position === 'center') {
              scrimGrad.addColorStop(0, 'rgba(0, 0, 0, 0)');
              scrimGrad.addColorStop(0.2, 'rgba(0, 0, 0, 0.65)');
              scrimGrad.addColorStop(0.8, 'rgba(0, 0, 0, 0.65)');
              scrimGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
              ctx.fillStyle = scrimGrad;
              ctx.fillRect(0, blockY - 50 * scale, w, totalContentH + 100 * scale);
            } else {
              scrimGrad.addColorStop(0, 'rgba(0, 0, 0, 0)');
              scrimGrad.addColorStop(0.35, 'rgba(0, 0, 0, 0.55)');
              scrimGrad.addColorStop(1, 'rgba(0, 0, 0, 0.88)');
              ctx.fillStyle = scrimGrad;
              ctx.fillRect(0, blockY - 90 * scale, w, h - (blockY - 90 * scale));
            }

            let curY = blockY;

            // Capsule Tag: Vibrant Yellow
            if (tagText) {
              ctx.font = `bold ${tagFontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
              const tagMetrics = ctx.measureText(tagText);
              const pillW = tagMetrics.width + 36 * scale;
              const pillH = tagFontSize * 1.85;
              let pillX = padX;
              if (align === 'center') pillX = (w - pillW) / 2;
              else if (align === 'right') pillX = w - padX - pillW;

              drawRoundRect(ctx, pillX, curY, pillW, pillH, pillH / 2);
              ctx.fillStyle = '#FFE600'; // High-visibility Neon Yellow
              ctx.fill();

              ctx.fillStyle = '#111111';
              ctx.textAlign = 'left';
              ctx.textBaseline = 'middle';
              ctx.fillText(tagText, pillX + 18 * scale, curY + pillH / 2);
              curY += pillH + tagMarginB;
            }

            // Main Title: Big Bold Sans-serif with soft shadow
            ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
            ctx.shadowBlur = 14 * scale;
            ctx.shadowOffsetY = 4 * scale;
            ctx.fillStyle = '#FFFFFF';
            ctx.font = `900 ${titleFontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';

            titleLines.forEach(line => {
              const lineW = ctx.measureText(line).width;
              let lineX = padX;
              if (align === 'center') lineX = (w - lineW) / 2;
              else if (align === 'right') lineX = w - padX - lineW;
              ctx.fillText(line, lineX, curY);
              curY += titleLineH;
            });

            // Subtitle
            if (subText) {
              curY += subMarginT;
              ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
              ctx.shadowBlur = 8 * scale;
              ctx.shadowOffsetY = 2 * scale;
              ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
              ctx.font = `600 ${subFontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
              const subW = ctx.measureText(subText).width;
              let subX = padX;
              if (align === 'center') subX = (w - subW) / 2;
              else if (align === 'right') subX = w - padX - subW;
              ctx.fillText(subText, subX, curY);
            }

            // Reset shadow
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
            ctx.shadowOffsetY = 0;

            // Header branding at the top
            ctx.font = `800 ${18 * scale}px sans-serif`;
            ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
            const brandText = '⚡ XIAOHONGSHU PICKS • 2026';
            const brandW = ctx.measureText(brandText).width;
            let brandX = padX;
            if (align === 'center') brandX = (w - brandW) / 2;
            else if (align === 'right') brandX = w - padX - brandW;
            ctx.fillText(brandText, brandX, 46 * scale);

          } else if (style === 'minimal') {
            // --- STYLE 2: 极简质感风 ---
            const cardPad = 40 * scale;
            const cardW = w - cardPad * 2;
            const cardInnerPadX = 36 * scale;
            const cardInnerPadY = 32 * scale;

            const titleLineH = titleFontSize * 1.35;
            const innerTitleH = titleLines.length * titleLineH;
            const tagH = tagText ? tagFontSize * 1.8 + 14 * scale : 0;
            const subH = subText ? subFontSize * 1.3 + 14 * scale : 0;
            const dividerH = (titleText && subText) ? 18 * scale : 0;
            const cardH = cardInnerPadY * 2 + tagH + innerTitleH + dividerH + subH;

            const cardY = position === 'top' 
              ? 52 * scale 
              : (position === 'center' ? (h - cardH) / 2 : h - cardH - 52 * scale);

            // Frosted Glass Floating Card
            ctx.save();
            ctx.shadowColor = 'rgba(0, 0, 0, 0.18)';
            ctx.shadowBlur = 32 * scale;
            ctx.shadowOffsetY = 8 * scale;

            drawRoundRect(ctx, cardPad, cardY, cardW, cardH, 20 * scale);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.93)';
            ctx.fill();

            ctx.shadowColor = 'transparent';
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
            ctx.lineWidth = 2 * scale;
            ctx.stroke();

            let curY = cardY + cardInnerPadY;

            // Tag: Subtle amber/indigo outline capsule
            if (tagText) {
              ctx.font = `700 ${tagFontSize}px sans-serif`;
              const tagMetrics = ctx.measureText(tagText);
              const pillW = tagMetrics.width + 32 * scale;
              const pillH = tagFontSize * 1.7;
              let tagX = cardPad + cardInnerPadX;
              if (align === 'center') tagX = cardPad + (cardW - pillW) / 2;
              else if (align === 'right') tagX = cardPad + cardW - cardInnerPadX - pillW;

              drawRoundRect(ctx, tagX, curY, pillW, pillH, pillH / 2);
              ctx.fillStyle = 'rgba(245, 158, 11, 0.12)';
              ctx.fill();
              ctx.strokeStyle = 'rgba(217, 119, 6, 0.4)';
              ctx.lineWidth = 1.5 * scale;
              ctx.stroke();

              ctx.fillStyle = '#B45309'; // Warm amber
              ctx.textAlign = 'left';
              ctx.textBaseline = 'middle';
              ctx.fillText(tagText, tagX + 16 * scale, curY + pillH / 2);
              curY += pillH + 16 * scale;
            }

            // Title: Elegant serif font with bracket quotation
            ctx.fillStyle = '#111827';
            ctx.font = `800 ${titleFontSize}px "Songti SC", "Noto Serif SC", "PingFang SC", serif, sans-serif`;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';

            titleLines.forEach((line, idx) => {
              const displayLine = (idx === 0 && titleLines.length === 1) ? `「 ${line} 」` : line;
              const lineW = ctx.measureText(displayLine).width;
              let lineX = cardPad + cardInnerPadX;
              if (align === 'center') lineX = cardPad + (cardW - lineW) / 2;
              else if (align === 'right') lineX = cardPad + cardW - cardInnerPadX - lineW;
              ctx.fillText(displayLine, lineX, curY);
              curY += titleLineH;
            });

            // Hairline Divider
            if (subText) {
              curY += 8 * scale;
              ctx.strokeStyle = 'rgba(0, 0, 0, 0.08)';
              ctx.lineWidth = 1 * scale;
              ctx.beginPath();
              ctx.moveTo(cardPad + cardInnerPadX, curY);
              ctx.lineTo(cardPad + cardW - cardInnerPadX, curY);
              ctx.stroke();
              curY += 14 * scale;

              // Subtitle
              ctx.fillStyle = '#4B5563';
              ctx.font = `600 ${subFontSize}px sans-serif`;
              const fullSub = `CITY GUIDE · ${subText}`;
              const subW = ctx.measureText(fullSub).width;
              let subX = cardPad + cardInnerPadX;
              if (align === 'center') subX = cardPad + (cardW - subW) / 2;
              else if (align === 'right') subX = cardPad + cardW - cardInnerPadX - subW;
              ctx.fillText(fullSub, subX, curY);
            }
            ctx.restore();

          } else if (style === 'sticker') {
            // --- STYLE 3: 潮酷贴纸风 ---
            const padX = 46 * scale;
            const titleLineH = titleFontSize * 1.35;
            const totalTitleH = titleLines.length * titleLineH;
            const tagH = tagText ? tagFontSize * 1.9 + 18 * scale : 0;
            const subH = subText ? subFontSize * 1.8 + 14 * scale : 0;
            const totalH = tagH + totalTitleH + subH;

            let curY = position === 'top' 
              ? 60 * scale 
              : (position === 'center' ? (h - totalH) / 2 : h - totalH - 60 * scale);

            // 1. Slanted Sticker Tag
            if (tagText) {
              ctx.save();
              ctx.font = `900 ${tagFontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
              const tagMetrics = ctx.measureText(tagText);
              const badgeW = tagMetrics.width + 36 * scale;
              const badgeH = tagFontSize * 1.8;
              let badgeX = padX;
              if (align === 'center') badgeX = (w - badgeW) / 2;
              else if (align === 'right') badgeX = w - padX - badgeW;

              ctx.translate(badgeX, curY);
              ctx.rotate((-3.5 * Math.PI) / 180);

              ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
              ctx.shadowBlur = 14 * scale;
              ctx.shadowOffsetY = 5 * scale;

              drawRoundRect(ctx, 0, 0, badgeW, badgeH, 6 * scale);
              ctx.fillStyle = '#FF2442'; // Signature Red
              ctx.fill();

              ctx.shadowColor = 'transparent';
              ctx.strokeStyle = '#FFFFFF';
              ctx.lineWidth = 3 * scale;
              ctx.stroke();

              ctx.fillStyle = '#FFFFFF';
              ctx.textAlign = 'left';
              ctx.textBaseline = 'middle';
              ctx.fillText(tagText, 18 * scale, badgeH / 2);
              ctx.restore();

              curY += badgeH + 22 * scale;
            }

            // 2. Fluorescent Yellow Ribbon Banners behind each title line
            titleLines.forEach(line => {
              ctx.font = `900 ${titleFontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif`;
              const lineMetrics = ctx.measureText(line);
              const ribbonW = lineMetrics.width + 28 * scale;
              const ribbonH = titleFontSize * 1.25;
              let ribbonX = padX;
              if (align === 'center') ribbonX = (w - ribbonW) / 2;
              else if (align === 'right') ribbonX = w - padX - ribbonW;

              ctx.save();
              ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
              ctx.shadowBlur = 10 * scale;
              ctx.shadowOffsetY = 4 * scale;

              drawRoundRect(ctx, ribbonX, curY, ribbonW, ribbonH, 4 * scale);
              ctx.fillStyle = '#FFE600'; // Fluorescent Yellow
              ctx.fill();

              ctx.shadowColor = 'transparent';
              ctx.fillStyle = '#000000'; // Pure Black font
              ctx.textAlign = 'left';
              ctx.textBaseline = 'middle';
              ctx.fillText(line, ribbonX + 14 * scale, curY + ribbonH / 2);
              ctx.restore();

              curY += ribbonH + 8 * scale;
            });

            // 3. Dark pill subtitle underneath
            if (subText) {
              curY += 10 * scale;
              ctx.font = `700 ${subFontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
              const subMetrics = ctx.measureText(subText);
              const subPillW = subMetrics.width + 28 * scale;
              const subPillH = subFontSize * 1.75;
              let subPillX = padX;
              if (align === 'center') subPillX = (w - subPillW) / 2;
              else if (align === 'right') subPillX = w - padX - subPillW;

              ctx.save();
              ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
              ctx.shadowBlur = 8 * scale;
              drawRoundRect(ctx, subPillX, curY, subPillW, subPillH, 6 * scale);
              ctx.fillStyle = 'rgba(17, 24, 39, 0.9)';
              ctx.fill();

              ctx.shadowColor = 'transparent';
              ctx.fillStyle = '#FFFFFF';
              ctx.textAlign = 'left';
              ctx.textBaseline = 'middle';
              ctx.fillText(subText, subPillX + 14 * scale, curY + subPillH / 2);
              ctx.restore();
            }
          } else if (style === 'cinema') {
            // --- STYLE 4: 电影大片风 (Cinematic Impact) ---
            // Ultra-large headline, Klein Blue + Ivory Warm White + Carbon Black
            const padX = 48 * scale;
            const cinemaTitleFontSize = Math.round(72 * scale); // Much larger headline
            const cinemaSubFontSize = Math.round(24 * scale);
            const cinemaTagFontSize = Math.round(20 * scale);

            ctx.font = `900 ${cinemaTitleFontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif`;
            const cinemaTitleLines = wrapCanvasTextLines(ctx, titleText || '点击输入号召力大标题', w * 0.88);

            const titleLineH = cinemaTitleFontSize * 1.18;
            const totalTitleH = cinemaTitleLines.length * titleLineH;
            const tagH = tagText ? cinemaTagFontSize * 1.7 : 0;
            const tagMarginB = tagText ? 16 * scale : 0;
            const subH = subText ? cinemaSubFontSize * 1.3 : 0;
            const subMarginT = subText ? 14 * scale : 0;
            const totalContentH = tagH + tagMarginB + totalTitleH + subMarginT + subH;

            let blockY = position === 'top' 
              ? h * 0.10 
              : (position === 'center' ? (h - totalContentH) / 2 : h - totalContentH - h * 0.08);

            // Cinematic Letterbox / Backdrop with deep night tint
            const scrimGrad = ctx.createLinearGradient(
              0,
              position === 'top' ? 0 : (position === 'center' ? blockY - 60 * scale : blockY - 110 * scale),
              0,
              position === 'top' ? blockY + totalContentH + 110 * scale : (position === 'center' ? blockY + totalContentH + 60 * scale : h)
            );

            if (position === 'top') {
              scrimGrad.addColorStop(0, 'rgba(11, 14, 20, 0.94)');
              scrimGrad.addColorStop(0.7, 'rgba(11, 14, 20, 0.65)');
              scrimGrad.addColorStop(1, 'rgba(11, 14, 20, 0)');
              ctx.fillStyle = scrimGrad;
              ctx.fillRect(0, 0, w, blockY + totalContentH + 110 * scale);
            } else if (position === 'center') {
              scrimGrad.addColorStop(0, 'rgba(11, 14, 20, 0)');
              scrimGrad.addColorStop(0.2, 'rgba(11, 14, 20, 0.78)');
              scrimGrad.addColorStop(0.8, 'rgba(11, 14, 20, 0.78)');
              scrimGrad.addColorStop(1, 'rgba(11, 14, 20, 0)');
              ctx.fillStyle = scrimGrad;
              ctx.fillRect(0, blockY - 60 * scale, w, totalContentH + 120 * scale);
            } else {
              scrimGrad.addColorStop(0, 'rgba(11, 14, 20, 0)');
              scrimGrad.addColorStop(0.3, 'rgba(11, 14, 20, 0.65)');
              scrimGrad.addColorStop(1, 'rgba(8, 10, 16, 0.94)');
              ctx.fillStyle = scrimGrad;
              ctx.fillRect(0, blockY - 110 * scale, w, h - (blockY - 110 * scale));
            }

            // Top header metadata: Cinema Issue Bar
            ctx.save();
            ctx.font = `800 ${16 * scale}px sans-serif`;
            ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
            ctx.fillText('CINEMATIC FOCUS · VOL.26', padX, 42 * scale);

            ctx.textAlign = 'right';
            ctx.fillStyle = '#0052FF'; // Klein Blue
            ctx.fillText('★ SPECIAL ISSUE', w - padX, 42 * scale);
            ctx.restore();

            let curY = blockY;

            // Tag Badge: High-luxury Klein Blue Pill with Amber highlight dot
            if (tagText) {
              ctx.font = `bold ${cinemaTagFontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
              const tagMetrics = ctx.measureText(tagText);
              const pillW = tagMetrics.width + 46 * scale;
              const pillH = cinemaTagFontSize * 1.8;
              let pillX = padX;
              if (align === 'center') pillX = (w - pillW) / 2;
              else if (align === 'right') pillX = w - padX - pillW;

              drawRoundRect(ctx, pillX, curY, pillW, pillH, 4 * scale);
              ctx.fillStyle = '#002FA7'; // International Klein Blue
              ctx.fill();

              ctx.strokeStyle = '#3874FF';
              ctx.lineWidth = 1.5 * scale;
              ctx.stroke();

              // Amber dot
              ctx.beginPath();
              ctx.arc(pillX + 14 * scale, curY + pillH / 2, 4 * scale, 0, Math.PI * 2);
              ctx.fillStyle = '#FFB703'; // Warm amber dot
              ctx.fill();

              ctx.fillStyle = '#FFFFFF';
              ctx.textAlign = 'left';
              ctx.textBaseline = 'middle';
              ctx.fillText(tagText, pillX + 26 * scale, curY + pillH / 2);
              curY += pillH + tagMarginB;
            }

            // Huge Master Title: Solid Ivory Cream text with heavy presence
            ctx.save();
            ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
            ctx.shadowBlur = 18 * scale;
            ctx.shadowOffsetY = 6 * scale;
            ctx.fillStyle = '#FAF8F5'; // Ivory Cream
            ctx.font = `900 ${cinemaTitleFontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif`;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';

            cinemaTitleLines.forEach(line => {
              const lineW = ctx.measureText(line).width;
              let lineX = padX;
              if (align === 'center') lineX = (w - lineW) / 2;
              else if (align === 'right') lineX = w - padX - lineW;
              ctx.fillText(line, lineX, curY);
              curY += titleLineH;
            });
            ctx.restore();

            // Subtitle: Film Subtitle with vertical accent bar
            if (subText) {
              curY += subMarginT;
              ctx.save();
              ctx.font = `600 ${cinemaSubFontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
              const subW = ctx.measureText(subText).width + 18 * scale;
              let subX = padX;
              if (align === 'center') subX = (w - subW) / 2;
              else if (align === 'right') subX = w - padX - subW;

              ctx.fillStyle = '#0052FF';
              ctx.fillRect(subX, curY + 2 * scale, 4 * scale, cinemaSubFontSize * 1.15);

              ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
              ctx.shadowBlur = 8 * scale;
              ctx.shadowOffsetY = 2 * scale;
              ctx.fillStyle = '#E2E8F0';
              ctx.textBaseline = 'top';
              ctx.fillText(subText, subX + 14 * scale, curY);
              ctx.restore();
            }

          } else if (style === 'collage') {
            // --- STYLE 5: 撞色拼贴风 (Neo-Chic Color Blocking) ---
            // Avocado Mustard Green + Carbon Black + Coral Orange, tilted overlapping paper tapes
            const padX = 42 * scale;
            const collageTitleFontSize = Math.round(68 * scale);
            const collageSubFontSize = Math.round(22 * scale);
            const collageTagFontSize = Math.round(20 * scale);

            ctx.font = `900 ${collageTitleFontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif`;
            const collageTitleLines = wrapCanvasTextLines(ctx, titleText || '点击输入号召力大标题', w * 0.82);

            const titleLineH = collageTitleFontSize * 1.32;
            const totalTitleH = collageTitleLines.length * titleLineH;
            const tagH = tagText ? collageTagFontSize * 1.9 : 0;
            const tagMarginB = tagText ? 16 * scale : 0;
            const subH = subText ? collageSubFontSize * 1.5 : 0;
            const subMarginT = subText ? 16 * scale : 0;
            const totalContentH = tagH + tagMarginB + totalTitleH + subMarginT + subH;

            let blockY = position === 'top' 
              ? h * 0.10 
              : (position === 'center' ? (h - totalContentH) / 2 : h - totalContentH - h * 0.08);

            let curY = blockY;

            // 1. Tag: Pin / Tape with Coral Red background
            if (tagText) {
              ctx.save();
              ctx.font = `900 ${collageTagFontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
              const fullTagStr = tagText.startsWith('📌') ? tagText : `📌 ${tagText}`;
              const tagMetrics = ctx.measureText(fullTagStr);
              const padH = Math.round(18 * scale);
              const tagW = Math.round(tagMetrics.width + padH * 2);
              const tagHReal = Math.round(collageTagFontSize * 1.95);
              let tagX = padX;
              if (align === 'center') tagX = (w - tagW) / 2;
              else if (align === 'right') tagX = w - padX - tagW;

              ctx.translate(tagX, curY);
              ctx.rotate((-3 * Math.PI) / 180);

              ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
              ctx.shadowBlur = 12 * scale;
              ctx.shadowOffsetY = 4 * scale;

              drawRoundRect(ctx, 0, 0, tagW, tagHReal, 4 * scale);
              ctx.fillStyle = '#FF4D6D'; // Vibrant Coral
              ctx.fill();

              ctx.shadowColor = 'transparent';
              ctx.strokeStyle = '#FFFFFF';
              ctx.lineWidth = 2 * scale;
              ctx.stroke();

              ctx.fillStyle = '#FFFFFF';
              ctx.textAlign = 'left';
              ctx.textBaseline = 'middle';
              ctx.fillText(fullTagStr, padH, tagHReal / 2);
              ctx.restore();

              curY += tagHReal + tagMarginB + 10 * scale;
            }

            // 2. Alternating Tilted Color-Block Banners for Title
            collageTitleLines.forEach((line, idx) => {
              ctx.save();
              ctx.font = `900 ${collageTitleFontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif`;
              const lineMetrics = ctx.measureText(line);
              const bannerW = lineMetrics.width + 36 * scale;
              const bannerH = collageTitleFontSize * 1.25;
              let bannerX = padX;
              if (align === 'center') bannerX = (w - bannerW) / 2;
              else if (align === 'right') bannerX = w - padX - bannerW;

              // Alternate tilt: line 0: +2°, line 1: -1.8°, line 2: +1.5°
              const angleDeg = idx % 2 === 0 ? 2 : -1.8;
              const angleRad = (angleDeg * Math.PI) / 180;

              ctx.translate(bannerX, curY);
              ctx.rotate(angleRad);

              ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
              ctx.shadowBlur = 14 * scale;
              ctx.shadowOffsetY = 5 * scale;

              drawRoundRect(ctx, 0, 0, bannerW, bannerH, 4 * scale);

              if (idx % 2 === 0) {
                ctx.fillStyle = '#A3E635'; // Avocado Lime
                ctx.fill();
                ctx.shadowColor = 'transparent';
                ctx.fillStyle = '#18181B'; // Carbon Black font
              } else {
                ctx.fillStyle = '#18181B'; // Carbon Black
                ctx.fill();
                ctx.shadowColor = 'transparent';
                ctx.strokeStyle = '#A3E635';
                ctx.lineWidth = 2 * scale;
                ctx.stroke();
                ctx.fillStyle = '#FFFDF7'; // Crisp White font
              }

              ctx.textAlign = 'left';
              ctx.textBaseline = 'middle';
              ctx.fillText(line, 18 * scale, bannerH / 2);
              ctx.restore();

              curY += bannerH + 10 * scale;
            });

            // 3. Subtitle: Milk White Sticker with Dashed Border
            if (subText) {
              curY += subMarginT;
              ctx.save();
              ctx.font = `800 ${collageSubFontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
              const subMetrics = ctx.measureText(subText);
              const subPillW = subMetrics.width + 32 * scale;
              const subPillH = collageSubFontSize * 1.7;
              let subPillX = padX;
              if (align === 'center') subPillX = (w - subPillW) / 2;
              else if (align === 'right') subPillX = w - padX - subPillW;

              ctx.shadowColor = 'rgba(0, 0, 0, 0.22)';
              ctx.shadowBlur = 10 * scale;
              ctx.shadowOffsetY = 3 * scale;

              drawRoundRect(ctx, subPillX, curY, subPillW, subPillH, 6 * scale);
              ctx.fillStyle = '#FFFDF7'; // Milk white
              ctx.fill();

              ctx.shadowColor = 'transparent';
              ctx.strokeStyle = '#18181B';
              ctx.lineWidth = 1.5 * scale;
              ctx.setLineDash([4 * scale, 3 * scale]);
              ctx.stroke();

              ctx.fillStyle = '#18181B';
              ctx.textAlign = 'left';
              ctx.textBaseline = 'middle';
              ctx.fillText(subText, subPillX + 16 * scale, curY + subPillH / 2);
              ctx.restore();
            }
          }

          // 3. Subject Occlusion Layer (Foreground Cutout)
          if (subjectOcclusion) {
            renderSubjectOcclusion();
            renderOutline();
            renderDoodles();
          }

          // 4. Foreground UI / Masthead Overlays for Giant Style
          if (style === 'giant') {
            const padX = 36 * scale;
            // Top Magazine Masthead
            ctx.save();
            ctx.font = `800 ${16 * scale}px -apple-system, BlinkMacSystemFont, sans-serif`;
            ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
            ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
            ctx.shadowBlur = 6 * scale;
            ctx.fillText('EDITORIAL ISSUE // VOL.08', padX, 42 * scale);

            ctx.textAlign = 'right';
            ctx.fillStyle = '#FFE600'; // Fluorescent Yellow highlight
            ctx.fillText('★ 3D DEPTH COVER', w - padX, 42 * scale);
            ctx.restore();

            // Bottom Subtitle & Tag Pill
            if (subText || tagText) {
              const displaySub = tagText ? `${tagText} ｜ ${subText || '2026 视觉精选指南'}` : subText;
              const giantSubFontSize = Math.round(22 * scale);
              ctx.save();
              ctx.font = `700 ${giantSubFontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
              const subMetrics = ctx.measureText(displaySub);
              const pillW = Math.min(w - padX * 2, subMetrics.width + 36 * scale);
              const pillH = giantSubFontSize * 1.8;
              const pillY = position === 'bottom' ? h * 0.08 : h - pillH - 46 * scale;
              let pillX = padX;
              if (align === 'center') {
                pillX = (w - pillW) / 2;
              } else if (align === 'right') {
                pillX = w - padX - pillW;
              }

              ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
              ctx.shadowBlur = 12 * scale;
              ctx.shadowOffsetY = 4 * scale;

              drawRoundRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
              ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
              ctx.fill();

              ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
              ctx.lineWidth = 1 * scale;
              ctx.stroke();

              ctx.shadowColor = 'transparent';
              ctx.fillStyle = '#FFFFFF';
              ctx.textAlign = 'left';
              ctx.textBaseline = 'middle';
              ctx.fillText(displaySub, pillX + 18 * scale, pillY + pillH / 2);
              ctx.restore();
            }
          }

          // Export as JPEG with 0.95 quality
          const watermarkedDataUri = canvas.toDataURL('image/jpeg', 0.95);

          // Inject EXIF if present to preserve metadata
          try {
            const piexifLib = getPiexif();
            if (piexifLib && piexifLib.load && piexifLib.dump && piexifLib.insert) {
              let exifObj = null;
              if (exif && exif.rawBytes) {
                try {
                  exifObj = piexifLib.load(exif.rawBytes);
                  exifObj["0th"] = exifObj["0th"] || {};
                  exifObj["0th"][piexifLib.ImageIFD.Orientation] = 1;
                  exifObj["0th"][piexifLib.ImageIFD.Software] = "Shantie AI Cover";
                  delete exifObj["thumbnail"];
                } catch (rawErr) {
                  exifObj = null;
                }
              }

              if (!exifObj && exif) {
                exifObj = {
                  "0th": {
                    [piexifLib.ImageIFD.Orientation]: 1,
                    [piexifLib.ImageIFD.Software]: "Shantie AI Cover"
                  },
                  "Exif": {},
                  "GPS": {},
                  "Interop": {},
                  "1st": {},
                  "thumbnail": null
                };
                if (exif.dateTime) {
                  exifObj["0th"][piexifLib.ImageIFD.DateTime] = String(exif.dateTime);
                  exifObj["Exif"][piexifLib.ExifIFD.DateTimeOriginal] = String(exif.dateTime);
                }
              }

              if (exifObj) {
                const exifBytes = piexifLib.dump(exifObj);
                const finalDataUri = piexifLib.insert(exifBytes, watermarkedDataUri);
                resolve(finalDataUri);
                return;
              }
            }
          } catch (exifErr) {
            console.warn('[Cover EXIF] Failed to inject EXIF:', exifErr);
          }

          resolve(watermarkedDataUri);
        } catch (err) {
          reject(err);
        }
      };

      img.onerror = (err) => reject(err);
      img.src = imageSrc;
    });
  };



  // Download the currently displayed styled (or original) active image at full HD resolution
  const downloadActiveImage = async () => {
    const activeImage = uploadedImages[activeIdx];
    if (!activeImage) return;

    try {
      const displaySrc = await ensureHighResSpektraImage(activeImage, activeIdx);
      const fileName = `xhs-style-${activeImage.activeStyle || 'original'}-${activeIdx + 1}-${Date.now()}.jpg`;
      handleSaveOrDownloadImage(displaySrc, fileName, `风格化效果图 (${activeImage.activeStyleLabel || activeImage.activeStyle || '原图'})`);
    } catch (err) {
      console.error('Export image failed:', err);
      setErrorMsg(`高清导出失败: ${err.message}`);
    }
  };

  const activeImage = uploadedImages[activeIdx];
  const selectedBatchCount = uploadedImages.filter(img => img.selected !== false).length;

  const styleNameBadgeMap = {
    'oriental-tale': '🏮 东方故事风',
    'baimiao': '✒️ 传统白描风',
    'qianjiang': '🏔️ 浅绛山水风',
    'mogu': '🪷 没骨画风',
    'cartoon': '🎨 治愈吉卜力',
    'clay': '🧸 软萌泥塑风',
    'japanese-film': '🎞️ 日式胶片风'
  };

  const coverStyleBadgeMap = {
    'giant': '💥 巨幕穿插风',
    'cinema': '🎬 电影大片风',
    'collage': '🎨 撞色拼贴风',
    'magazine': '📸 杂志速报风',
    'minimal': '🖼️ 极简质感风',
    'sticker': '⚡ 潮酷贴纸风'
  };

  if (showWelcome) {
    return (
      <div className={`h5-outer-backdrop ${h5FrameMode ? 'framed-mode' : 'full-mode'}`}>
        {/* Hidden global file input so Welcome Screen can trigger upload directly */}
        <input
          type="file"
          ref={fileInputRef}
          style={{ display: 'none' }}
          accept="image/*,.dng,.arw,.cr2,.cr3,.nef,.nrw,.raf,.rw2,.orf,.pef,.srw,.raw"
          multiple
          onChange={handlePhotosUpload}
        />

        <div className="h5-device-shell welcome-shell">
          {/* iOS / H5 Top Status Pill Bar */}
          <div className="h5-status-bar">
            <span className="h5-status-time">SHANTIE AI</span>
            <div className="h5-dynamic-island">
              <span className="island-dot" />
              <span>小红书爆款图文 H5</span>
            </div>
            <button
              type="button"
              className="h5-frame-toggle-mini"
              onClick={() => setH5FrameMode(!h5FrameMode)}
              title="切换手机壳/全屏视图"
            >
              {h5FrameMode ? '📲 全屏' : '📱 手机壳'}
            </button>
          </div>

          <div className="h5-welcome-scroll">
            {/* Hero Visual Banner */}
            <div className="h5-welcome-hero">
              <div className="h5-hero-glow" />
              <div className="h5-logo-wrap">
                <img
                  src={`${(import.meta.env.BASE_URL || '/').replace(/\/$/, '')}/logo.jpg`}
                  alt="闪贴 AI"
                  className="h5-welcome-logo"
                />
                <span className="h5-brand-tag">✨ 2026 视觉创作工作台</span>
              </div>

              <h1 className="h5-welcome-title">你拍照 · 我生文</h1>
              <p className="h5-welcome-subtitle">
                随手拍 1–4 张日常照片，AI 自动解析拍摄时空，一键生成国风插画、3D 穿插巨幕封面与高赞笔记文案
              </p>

              {/* Floating Feature Pills */}
              <div className="h5-feature-pills">
                <span className="h5-pill">📐 生成式扩图</span>
                <span className="h5-pill">🧹 AI 去杂物</span>
                <span className="h5-pill">📷 前后景虚化</span>
                <span className="h5-pill">🎞️ 物理胶片暗房</span>
                <span className="h5-pill">👤 3D人物穿插大字</span>
              </div>
            </div>

            {/* 4-Step H5 Bento Grid */}
            <div className="h5-steps-section">
              <div className="h5-section-header">
                <span className="h5-section-title">⚡ 四步成片工作流</span>
                <span className="h5-section-sub">拍 · 变 · 标 · 生</span>
              </div>

              <div className="h5-bento-grid">
                <div className="h5-bento-card">
                  <div className="h5-bento-top">
                    <span className="h5-bento-icon">📸</span>
                    <span className="h5-bento-step">STEP 01</span>
                  </div>
                  <h3>原图时空解析</h3>
                  <p>支持 1–4 张连传，自动提取拍摄时间、机型与 GPS 打卡坐标</p>
                </div>

                <div className="h5-bento-card">
                  <div className="h5-bento-top">
                    <span className="h5-bento-icon">🎞️</span>
                    <span className="h5-bento-step">STEP 02</span>
                  </div>
                  <h3>物理胶片暗房 &amp; AI 重绘</h3>
                  <p>SpektraLab 81波段胶片模拟、135/120齿孔片边、EXIF日期戳及7大AI画风</p>
                </div>

                <div className="h5-bento-card">
                  <div className="h5-bento-top">
                    <span className="h5-bento-icon">🏷️</span>
                    <span className="h5-bento-step">STEP 03</span>
                  </div>
                  <h3>3D 巨幕标题大片</h3>
                  <p>AI 识别人像前景遮挡大字，6 款大刊封面版式 + 自由荧光手绘涂鸦</p>
                </div>

                <div className="h5-bento-card">
                  <div className="h5-bento-top">
                    <span className="h5-bento-icon">✍️</span>
                    <span className="h5-bento-step">STEP 04</span>
                  </div>
                  <h3>多模态爆款文案</h3>
                  <p>融合画面细节与真实地点，生成 3 套小红书高互动标题、正文与标签</p>
                </div>
              </div>
            </div>
          </div>

          {/* Sticky Bottom Launch Dock */}
          <div className="h5-welcome-dock">
            <button
              type="button"
              className="h5-cta-primary"
              onClick={() => {
                setShowWelcome(false);
                setActiveTab('photos');
              }}
            >
              <span>🚀 进入 H5 创作工作台</span>
            </button>
            <div className="h5-welcome-subactions">
              <button
                type="button"
                className="h5-cta-ghost"
                onClick={() => fileInputRef.current?.click()}
              >
                📸 直接从相册选图
              </button>
              <button
                type="button"
                className="h5-cta-demo"
                onClick={handleLoadDemoPhoto}
              >
                ✨ 载入示例大片体验
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`h5-outer-backdrop ${h5FrameMode ? 'framed-mode' : 'full-mode'}`}>
      {/* Global Hidden File Input */}
      <input
        type="file"
        ref={fileInputRef}
        style={{ display: 'none' }}
        accept="image/*,.dng,.arw,.cr2,.cr3,.nef,.nrw,.raf,.rw2,.orf,.pef,.srw,.raw"
        multiple
        onChange={handlePhotosUpload}
      />

      <div className="h5-device-shell studio-shell">
        {/* 1. Native H5 Top Status & Navigation Bar */}
        <header className="h5-topbar">
          <div className="h5-topbar-left">
            <button
              type="button"
              className="h5-back-btn"
              onClick={() => setShowWelcome(true)}
              title="返回首页"
            >
              ‹
            </button>
            <div className="h5-brand-group" onClick={() => setShowWelcome(true)}>
              <div className="h5-logo-badge">书</div>
              <div className="h5-brand-titles">
                <h1>你拍照我生文</h1>
                <span>
                  {activeTab === 'photos' && 'Step 1/5 · 原图与时空元数据'}
                  {activeTab === 'edit' && 'Step 2/5 · AI 智能修图工作台'}
                  {activeTab === 'style' && 'Step 3/5 · 物理胶片暗房 & AI 画风'}
                  {activeTab === 'cover' && 'Step 4/5 · 3D 巨幕封面大片'}
                  {activeTab === 'copy' && 'Step 5/5 · 爆款笔记文案'}
                </span>
              </div>
            </div>
          </div>

          <div className="h5-topbar-right">
            {uploadedImages.length === 0 ? (
              <button
                type="button"
                className="h5-top-pill accent"
                onClick={handleLoadDemoPhoto}
              >
                ✨ 示例图
              </button>
            ) : (
              <>
                {uploadedImages.length < 4 && (
                  <button
                    type="button"
                    className="h5-top-pill"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    ➕ 加图 ({uploadedImages.length}/4)
                  </button>
                )}
                <button
                  type="button"
                  className="h5-top-pill danger"
                  onClick={clearAllImages}
                  title="清空全部图片"
                >
                  🧹 重置
                </button>
              </>
            )}
            <button
              type="button"
              className="h5-frame-toggle-mini"
              onClick={() => setH5FrameMode(!h5FrameMode)}
              title="切换手机壳/全屏模式"
            >
              {h5FrameMode ? '📲' : '📱'}
            </button>
          </div>
        </header>

        {/* Global Loading Overlay */}
        {isLoading && (
          <div className="h5-loading-modal">
            <div className="h5-loading-card">
              <div className="spinner" />
              <div className="h5-loading-title">{aiOperationName || 'AI 正在创作中'}...</div>
              <div className="h5-loading-sub">请稍候，正在为您生成高清视觉大片</div>
            </div>
          </div>
        )}

        {/* Main Scrollable H5 Content Area */}
        <main className="h5-main-scroll">
          {errorMsg && (
            <div className="h5-error-banner">
              <span>⚠️ {errorMsg}</span>
              <button type="button" onClick={() => setErrorMsg('')}>✕</button>
            </div>
          )}

          {/* 2. Interactive H5 Canvas Stage (Always visible when photos exist) */}
          {uploadedImages.length > 0 && activeImage && (
            <section id="preview-panel-anchor" className="h5-stage-section">
              {/* Stage Mode Switcher & Save Bar */}
              <div className="h5-stage-topbar">
                <div className="h5-segmented-control">
                  <button
                    type="button"
                    className={`h5-seg-btn ${activePreviewTab === 'styled' ? 'active' : ''}`}
                    onClick={() => setActivePreviewTab('styled')}
                  >
                    🖼️ 画风预览
                  </button>
                  <button
                    type="button"
                    className={`h5-seg-btn ${activePreviewTab === 'cover' ? 'active' : ''}`}
                    onClick={() => setActivePreviewTab('cover')}
                  >
                    🏷️ 封面大片
                  </button>
                </div>

                <div className="h5-stage-actions">
                  <button
                    type="button"
                    className="h5-stage-action-btn"
                    onClick={async () => {
                      if (activePreviewTab === 'cover') {
                        if (coverPreviewUri) {
                          setWechatSaveModal({
                            isOpen: true,
                            imageSrc: coverPreviewUri,
                            title: `小红书封面图 (${coverStyle})`,
                            fileName: `xhs-cover-${coverStyle}-${Date.now()}.jpg`
                          });
                        } else {
                          downloadCoverImage();
                        }
                      } else {
                        try {
                          const src = await ensureHighResSpektraImage(activeImage, activeIdx);
                          if (src) {
                            setWechatSaveModal({
                              isOpen: true,
                              imageSrc: src,
                              title: `风格化效果图 (${activeImage?.activeStyleLabel || activeImage?.activeStyle || '原图'})`,
                              fileName: `xhs-style-${activeImage?.activeStyle || 'original'}-${activeIdx + 1}-${Date.now()}.jpg`
                            });
                          }
                        } catch (err) {
                          console.error('Prepare high-res save failed:', err);
                          setErrorMsg(`高清存图失败: ${err.message}`);
                        }
                      }
                    }}
                  >
                    📱 长按存图
                  </button>
                  <button
                    type="button"
                    className="h5-stage-action-btn primary"
                    onClick={() => {
                      if (activePreviewTab === 'cover') {
                        downloadCoverImage();
                      } else {
                        downloadActiveImage();
                      }
                    }}
                  >
                    📥 导出
                  </button>
                </div>
              </div>

              {/* Main Interactive Canvas Viewport */}
              <div className="h5-canvas-viewport">
                {/* Floating Mode Status Chip */}
                <div className="h5-canvas-chip top-left">
                  {activePreviewTab === 'cover' ? (
                    <>
                      <span>{coverStyleBadgeMap[coverStyle] || '🏷️ 封面大片'}</span>
                      {subjectOcclusion && <span className="chip-accent">3D穿插</span>}
                    </>
                  ) : (
                    <span>
                      {editLivePreviewUri
                        ? '✨ 实时修图预览'
                        : (activeImage.activeStyleLabel ||
                          (activeImage.activeStyle
                            ? (styleNameBadgeMap[activeImage.activeStyle] || '🎨 已重绘')
                            : (activeImage.editTag || '📷 原始实拍图')))}
                    </span>
                  )}
                </div>

                {/* Floating Doodle Mode Indicator */}
                {activePreviewTab === 'cover' && isDoodleMode && (
                  <div className="h5-canvas-chip top-right active-doodle" onClick={() => setIsDoodleMode(false)}>
                    ✍️ 手绘涂鸦中 · 点击完成
                  </div>
                )}

                {/* Press-and-hold Original Comparison Button */}
                {activePreviewTab === 'styled' &&
                  (activeImage.styledSrc || editLivePreviewUri || (activeImage.originalSrc && activeImage.originalSrc !== activeImage.src)) &&
                  !(activeTab === 'edit' && editSubTab === 'erase' && isEraseBrushMode) && (
                  <button
                    type="button"
                    className={`spk-compare-btn ${isComparingOriginal ? 'active' : ''}`}
                    onPointerDown={() => setIsComparingOriginal(true)}
                    onPointerUp={() => setIsComparingOriginal(false)}
                    onPointerLeave={() => setIsComparingOriginal(false)}
                    onPointerCancel={() => setIsComparingOriginal(false)}
                  >
                    {isComparingOriginal ? '📷 原图对比中' : '👁️ 按住看原图'}
                  </button>
                )}

                {activePreviewTab === 'styled' && isRenderingSpektra && (
                  <div className="spk-preview-badge">⏳ 光谱显影中…</div>
                )}

                {activePreviewTab === 'cover' ? (
                  coverPreviewUri ? (
                    <div className="h5-canvas-img-wrap">
                      <img
                        ref={previewImgRef}
                        src={coverPreviewUri}
                        alt="Cover Preview"
                        className="h5-stage-img"
                      />
                      {isDoodleMode && (
                        <canvas
                          ref={doodleCanvasRef}
                          onPointerDown={handleDoodlePointerDown}
                          onPointerMove={handleDoodlePointerMove}
                          onPointerUp={handleDoodlePointerUp}
                          onPointerLeave={handleDoodlePointerUp}
                          width={previewImgRef.current ? previewImgRef.current.clientWidth : 400}
                          height={previewImgRef.current ? previewImgRef.current.clientHeight : 533}
                          className="h5-doodle-canvas"
                        />
                      )}
                    </div>
                  ) : (
                    <div className="spinner" />
                  )
                ) : (
                  <div
                    className="h5-canvas-img-wrap"
                    style={activeTab === 'edit' && editSubTab === 'bokeh' && isBokehTapFocusActive ? { cursor: 'crosshair' } : undefined}
                    onClick={(e) => {
                      if (activeTab !== 'edit' || editSubTab !== 'bokeh' || !isBokehTapFocusActive) return;
                      const rect = e.currentTarget.getBoundingClientRect();
                      if (!rect.width || !rect.height) return;
                      const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
                      const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
                      setBokehFocusPoint({ x, y });
                    }}
                  >
                    <img
                      ref={eraseImgRef}
                      src={
                        isComparingOriginal
                          ? (activeImage.originalSrc || activeImage.src)
                          : (editLivePreviewUri || activeImage.styledSrc || activeImage.src)
                      }
                      alt="Styled Preview"
                      className="h5-stage-img"
                    />
                    {activeTab === 'edit' && editSubTab === 'erase' && isEraseBrushMode && (
                      <canvas
                        ref={eraseCanvasRef}
                        onPointerDown={handleErasePointerDown}
                        onPointerMove={handleErasePointerMove}
                        onPointerUp={handleErasePointerUp}
                        onPointerLeave={handleErasePointerUp}
                        onPointerCancel={handleErasePointerUp}
                        className="h5-erase-brush-canvas"
                      />
                    )}
                    {activeTab === 'edit' && editSubTab === 'bokeh' && isBokehTapFocusActive && (
                      <div
                        className="h5-focus-reticle"
                        style={{
                          left: `${bokehFocusPoint.x * 100}%`,
                          top: `${bokehFocusPoint.y * 100}%`
                        }}
                      />
                    )}
                  </div>
                )}

                {/* Bottom EXIF Quick Pill */}
                {activeImage.exif && (
                  <div className="h5-canvas-chip bottom-left">
                    {activeImage.exif.device && <span>📱 {activeImage.exif.device}</span>}
                    {activeImage.exif.gps && <span>📍 含GPS坐标</span>}
                    {activeImage.exif.dateTime && (
                      <span>🕒 {String(activeImage.exif.dateTime).split(' ')[0].replace(/:/g, '.')}</span>
                    )}
                  </div>
                )}
              </div>

              {/* Horizontal Filmstrip Thumbnail Bar */}
              <div className="h5-filmstrip-bar">
                <div className="h5-filmstrip-thumbs">
                  {uploadedImages.map((img, idx) => {
                    const isSelected = activePreviewTab === 'cover' ? coverImageIdx === idx : activeIdx === idx;
                    return (
                      <div
                        key={img.id}
                        className={`h5-thumb-item ${isSelected ? 'active' : ''}`}
                        onClick={() => {
                          setActiveIdx(idx);
                          setCoverImageIdx(idx);
                          if (activePreviewTab === 'cover' && subjectOcclusion && !outlineMasks[idx] && !isDetectingOutline) {
                            handleDetectSubjectOutline(idx);
                          }
                        }}
                      >
                        <img src={img.styledSrc || img.src} alt={`照片 ${idx + 1}`} />
                        <button
                          type="button"
                          className={`h5-thumb-check ${img.selected !== false ? 'checked' : ''}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setUploadedImages(prev => prev.map((item) =>
                              item.id === img.id ? { ...item, selected: item.selected === false ? true : false } : item
                            ));
                          }}
                          title="勾选参与批量画风重绘"
                        >
                          ✓
                        </button>
                        <button
                          type="button"
                          className="h5-thumb-del"
                          onClick={(e) => removeUploadedImage(img.id, e)}
                          title="移除此图"
                        >
                          ✕
                        </button>
                        <span className="h5-thumb-index">{idx + 1}</span>
                      </div>
                    );
                  })}

                  {uploadedImages.length < 4 && (
                    <button
                      type="button"
                      className="h5-thumb-add"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <span>＋</span>
                      <small>加图</small>
                    </button>
                  )}
                </div>

                <div className="h5-filmstrip-meta">
                  <span>已勾 <strong>{selectedBatchCount}</strong> 张重绘</span>
                </div>
              </div>
            </section>
          )}

          {/* 3. Tabbed H5 Workbench Panels */}
          <section className="h5-workbench">
            {/* TAB 1: PHOTOS & EXIF */}
            {(activeTab === 'photos' || uploadedImages.length === 0) && (
              <div className="h5-panel-card">
                <div className="h5-panel-header">
                  <div>
                    <h2 className="h5-panel-title">📸 照片管理与时空解析</h2>
                    <p className="h5-panel-desc">支持上传 1–4 张照片，自动提取 EXIF 拍摄时间与 GPS 经纬度</p>
                  </div>
                  <span className="h5-badge-count">{uploadedImages.length}/4 张</span>
                </div>

                {/* WeChat EXIF Tip */}
                <div className="wechat-exif-banner">
                  <div className="wechat-exif-badge">💡 微信 H5 选图小贴士</div>
                  <div className="wechat-exif-desc">
                    在微信相册选图时请勾选底部<strong>【原图】</strong>，完整保留拍摄时间与 GPS 地点，AI 才能为您生成真实打卡坐标文案！
                  </div>
                </div>

                {uploadedImages.length < 4 && (
                  <div
                    className="h5-upload-dropzone"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <div className="h5-upload-icon">📤</div>
                    <div className="h5-upload-title">点击从手机相册选择照片</div>
                    <div className="h5-upload-sub">支持 JPG / PNG / HEIC / RAW 原片（DNG·ARW·CR2·NEF 等）· 最多 4 张</div>
                  </div>
                )}

                {uploadedImages.length === 0 && (
                  <button
                    type="button"
                    className="h5-demo-banner-btn"
                    onClick={handleLoadDemoPhoto}
                  >
                    <span>✨ 还没选好照片？点击一键载入示例大片体验全流程</span>
                    <span>立即体验 ➔</span>
                  </button>
                )}

                {/* Active Image EXIF Inspector Bento */}
                {activeImage && (
                  <div className="h5-exif-inspector">
                    <div className="h5-sub-label">🔍 当前选中照片 (第 {activeIdx + 1} 张) EXIF 元数据</div>
                    <div className="h5-exif-grid">
                      <div className="h5-exif-cell">
                        <span className="exif-k">📱 拍摄设备</span>
                        <span className="exif-v">{activeImage.exif?.device || '未检测到机型'}</span>
                      </div>
                      <div className="h5-exif-cell">
                        <span className="exif-k">🕒 拍摄时间</span>
                        <span className="exif-v">
                          {activeImage.exif?.dateTime
                            ? String(activeImage.exif.dateTime).replace(/:/g, '.').slice(0, 16)
                            : '未含时间信息'}
                        </span>
                      </div>
                      <div className="h5-exif-cell">
                        <span className="exif-k">📍 GPS 坐标</span>
                        <span className="exif-v">
                          {activeImage.exif?.gps
                            ? `${parseFloat(activeImage.exif.gps.lat).toFixed(3)}°${activeImage.exif.gps.latRef || 'N'}, ${parseFloat(activeImage.exif.gps.lon).toFixed(3)}°${activeImage.exif.gps.lonRef || 'E'}`
                            : '未含位置坐标'}
                        </span>
                      </div>
                      <div className="h5-exif-cell">
                        <span className="exif-k">📐 图像尺寸</span>
                        <span className="exif-v">{activeImage.width || 1024} × {activeImage.height || 1024}</span>
                      </div>
                    </div>

                    <div className="h5-next-step-row" style={{ display: 'flex', gap: '8px' }}>
                      <button
                        type="button"
                        className="h5-primary-action-btn indigo"
                        style={{ flex: 1 }}
                        onClick={() => {
                          setActiveTab('edit');
                          setActivePreviewTab('styled');
                        }}
                      >
                        ✨ 智能修图（扩图/去杂物/虚化）
                      </button>
                      <button
                        type="button"
                        className="h5-primary-action-btn"
                        style={{ flex: 1 }}
                        onClick={() => {
                          setActiveTab('style');
                          setActivePreviewTab('styled');
                        }}
                      >
                        🎨 胶片暗房 &amp; 画风 ➔
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* TAB 2: AI & BASIC IMAGE EDITING WORKBENCH */}
            {uploadedImages.length > 0 && activeImage && activeTab === 'edit' && (
              <ImageEditPanel
                activeImage={activeImage}
                activeIdx={activeIdx}
                apiBase={API_BASE}
                subTab={editSubTab}
                onChangeSubTab={setEditSubTab}
                hasSubjectMask={Boolean(outlineMasks[activeIdx])}
                onRequestSubjectMask={ensurePortraitMaskForEdit}
                isDetectingMask={isDetectingOutline}
                bokehFocusPoint={bokehFocusPoint}
                isBokehTapFocusActive={isBokehTapFocusActive}
                onSetBokehTapFocusActive={setIsBokehTapFocusActive}
                isEraseBrushMode={isEraseBrushMode}
                onSetEraseBrushMode={setIsEraseBrushMode}
                eraseBrushSize={eraseBrushSize}
                onSetEraseBrushSize={setEraseBrushSize}
                eraseBrushStrokes={eraseBrushStrokes}
                onUndoEraseStroke={() => setEraseBrushStrokes((prev) => prev.slice(0, -1))}
                onClearEraseStrokes={() => setEraseBrushStrokes([])}
                onSetLivePreview={setEditLivePreviewUri}
                onCommitEdit={commitImageEdit}
                onUndoEdit={handleUndoImageEdit}
                onResetOriginal={handleResetImageToOriginal}
                onStartLoading={(label) => {
                  setIsLoading(true);
                  setAiOperationName(label || 'AI 正在处理图像');
                }}
                onStopLoading={() => {
                  setIsLoading(false);
                  setAiOperationName('');
                }}
                onError={setErrorMsg}
                onToast={showToast}
              />
            )}

            {/* TAB 2: SPEKTRALAB FILM DARKROOM & AI ART STYLE TRANSFER */}
            {uploadedImages.length > 0 && activeImage && activeTab === 'style' && (
              <>
                <div className="spk-mode-switcher">
                  <button
                    type="button"
                    className={`spk-mode-btn ${styleMode === 'spektra' ? 'active' : ''}`}
                    onClick={() => {
                      setStyleMode('spektra');
                      setActivePreviewTab('styled');
                    }}
                  >
                    <span>🎞️ 物理胶片暗房</span>
                    <span className="spk-mode-badge">SpektraLab</span>
                  </button>
                  <button
                    type="button"
                    className={`spk-mode-btn ai-tab ${styleMode === 'ai' ? 'active' : ''}`}
                    onClick={() => {
                      setStyleMode('ai');
                      setActivePreviewTab('styled');
                    }}
                  >
                    <span>🎨 画风重绘</span>
                  </button>
                </div>

                {styleMode === 'spektra' ? (
                  <FilmDarkroomPanel
                    params={spektraParams}
                    onUpdateParams={handleUpdateSpektraParams}
                    activeImage={activeImage}
                    selectedBatchCount={selectedBatchCount}
                    isRenderingPreview={isRenderingSpektra}
                    isBatchProcessing={isBatchSpektra}
                    onBatchDevelop={handleBatchSpektraDevelop}
                    onRestoreOriginal={restoreToOriginal}
                  />
                ) : (
              <div className="h5-panel-card">
                <div className="h5-panel-header">
                  <div>
                    <h2 className="h5-panel-title">🎨 画风重绘</h2>
                    <p className="h5-panel-desc">点击任意画风即可对已勾选的 <strong>{selectedBatchCount}</strong> 张照片同步重绘并叠加徕卡白边水印</p>
                  </div>
                  {activeImage.styledSrc && (
                    <button
                      type="button"
                      className="h5-mini-outline-btn"
                      onClick={restoreToOriginal}
                    >
                      ↩️ 恢复原图
                    </button>
                  )}
                </div>

                {/* Category 1: Oriental Aesthetics */}
                <div className="h5-style-group">
                  <div className="h5-group-label-row">
                    <span className="h5-group-title">🇨🇳 东方国风意境</span>
                    <span className="h5-group-tag gold">建筑 / 风景特调</span>
                  </div>

                  <div className="h5-oriental-grid">
                    {[
                      {
                        id: 'oriental-tale',
                        icon: '🏮',
                        name: '东方故事风',
                        scene: '建筑',
                        sceneColor: '#b45309',
                        sceneBg: '#fef3c7',
                        highlight: '暖象牙白 · 朱砂青蓝',
                        desc: '现代建筑包裹暖调诗意留白'
                      },
                      {
                        id: 'baimiao',
                        icon: '✒️',
                        name: '传统白描风',
                        scene: '建筑',
                        sceneColor: '#374151',
                        sceneBg: '#f3f4f6',
                        highlight: '极简墨线 · 书法韵律',
                        desc: '纯粹工笔线条勾勒飞檐轮廓'
                      },
                      {
                        id: 'qianjiang',
                        icon: '🏔️',
                        name: '浅绛山水风',
                        scene: '风景',
                        sceneColor: '#047857',
                        sceneBg: '#d1fae5',
                        highlight: '水墨为骨 · 赭石花青',
                        desc: '文人画淡雅设色，清秀宁静'
                      },
                      {
                        id: 'mogu',
                        icon: '🪷',
                        name: '没骨画风格',
                        scene: '风景',
                        sceneColor: '#0369a1',
                        sceneBg: '#e0f2fe',
                        highlight: '无骨晕染 · 晨雾温润',
                        desc: '直接色彩渲染，如晨雾山峦'
                      }
                    ].map((s) => {
                      const isActive = activeImage.activeStyle === s.id;
                      return (
                        <button
                          key={s.id}
                          type="button"
                          className={`h5-style-card oriental ${isActive ? 'active' : ''}`}
                          disabled={isLoading}
                          onClick={() => {
                            setActivePreviewTab('styled');
                            handleAIStyleTransfer(s.id);
                          }}
                        >
                          <div className="h5-style-card-top">
                            <span className="h5-style-emoji">{s.icon}</span>
                            <span
                              className="h5-style-scene"
                              style={{ background: s.sceneBg, color: s.sceneColor }}
                            >
                              {s.scene}
                            </span>
                          </div>
                          <div className="h5-style-name">{s.name}</div>
                          <div className="h5-style-hi">{s.highlight}</div>
                          <div className="h5-style-desc">{s.desc}</div>
                          {isActive && <span className="h5-style-check">✓</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Category 2: Pop & Film Styles */}
                <div className="h5-style-group">
                  <div className="h5-group-label-row">
                    <span className="h5-group-title">✨ 经典潮流画风</span>
                    <span className="h5-group-tag">人像 / 日常百搭</span>
                  </div>

                  <div className="h5-pop-grid">
                    {[
                      { id: 'cartoon', icon: '🎨', name: '治愈吉卜力', desc: '宫崎骏水彩光影', gradient: 'linear-gradient(135deg, #4f46e5, #6366f1)' },
                      { id: 'clay', icon: '🧸', name: '软萌泥塑风', desc: '3D定格黏土质感', gradient: 'linear-gradient(135deg, #ec4899, #d946ef)' },
                      { id: 'japanese-film', icon: '🎞️', name: '日式胶片风', desc: '富士颗粒复古感', gradient: 'linear-gradient(135deg, #d97706, #92400e)' }
                    ].map((s) => {
                      const isActive = activeImage.activeStyle === s.id;
                      return (
                        <button
                          key={s.id}
                          type="button"
                          className={`h5-pop-card ${isActive ? 'active' : ''}`}
                          style={{ background: s.gradient }}
                          disabled={isLoading}
                          onClick={() => {
                            setActivePreviewTab('styled');
                            handleAIStyleTransfer(s.id);
                          }}
                        >
                          <span className="h5-pop-icon">{s.icon}</span>
                          <span className="h5-pop-name">{s.name}</span>
                          <span className="h5-pop-desc">{s.desc}</span>
                          {isActive && <span className="h5-pop-active-dot">✓</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
                )}
              </>
            )}

            {/* TAB 3: COVER TITLE GENERATOR */}
            {uploadedImages.length > 0 && activeTab === 'cover' && (
              <div className="h5-panel-card">
                <div className="h5-panel-header">
                  <div>
                    <h2 className="h5-panel-title">🏷️ 爆款封面标题图工作台</h2>
                    <p className="h5-panel-desc">6 款高点击率封面版式 · 支持 AI 人像前景 3D 穿插大字</p>
                  </div>
                  <button
                    type="button"
                    className="h5-ai-sparkle-btn"
                    onClick={handleGenerateCoverTitles}
                    disabled={isGeneratingCoverTitles}
                  >
                    {isGeneratingCoverTitles ? '⏳ 提炼中...' : '✨ AI 提炼标题'}
                  </button>
                </div>

                {/* H5 Sub-Navigation Pills inside Cover Studio */}
                <div className="h5-subtab-bar">
                  {[
                    { id: 'template', label: '🎨 封面版式' },
                    { id: 'text', label: '✍️ 标题排版' },
                    { id: 'depth', label: '👤 3D穿插/描边' }
                  ].map((st) => (
                    <button
                      key={st.id}
                      type="button"
                      className={`h5-subtab-pill ${coverSubTab === st.id ? 'active' : ''}`}
                      onClick={() => {
                        setCoverSubTab(st.id);
                        setActivePreviewTab('cover');
                      }}
                    >
                      {st.label}
                    </button>
                  ))}
                </div>

                {/* Sub-tab 1: 6 Cover Templates & AI Candidates */}
                {coverSubTab === 'template' && (
                  <div className="h5-subtab-content">
                    <div className="h5-cover-style-grid">
                      {[
                        { id: 'giant', name: '巨幕穿插', desc: '44%巨字·人物遮挡', icon: '💥' },
                        { id: 'cinema', name: '电影大片', desc: '克莱因蓝·大刊感', icon: '🎬' },
                        { id: 'collage', name: '撞色拼贴', desc: '牛油果绿·纸带风', icon: '🎨' },
                        { id: 'magazine', name: '杂志速报', desc: '荧光黄标·暗角感', icon: '📸' },
                        { id: 'minimal', name: '极简质感', desc: '毛玻璃卡·呼吸留白', icon: '🖼️' },
                        { id: 'sticker', name: '潮酷贴纸', desc: '斜角徽章·荧光条', icon: '⚡' }
                      ].map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          className={`h5-cover-tpl-card ${coverStyle === s.id ? 'active' : ''}`}
                          onClick={() => {
                            setCoverStyle(s.id);
                            setActivePreviewTab('cover');
                            if (s.id === 'giant') {
                              setSubjectOcclusion(true);
                              if (!outlineMasks[coverImageIdx] && !isDetectingOutline) {
                                handleDetectSubjectOutline(coverImageIdx);
                              }
                            }
                          }}
                        >
                          <span className="tpl-icon">{s.icon}</span>
                          <span className="tpl-name">{s.name}</span>
                          <span className="tpl-desc">{s.desc}</span>
                        </button>
                      ))}
                    </div>

                    {/* AI Recommended Cover Titles */}
                    {coverCandidates.length > 0 && (
                      <div className="h5-candidates-box">
                        <div className="h5-sub-label">🔥 点击一键套用 AI 爆款封面文案：</div>
                        <div className="h5-candidates-list">
                          {coverCandidates.map((cand, cIdx) => (
                            <button
                              key={cIdx}
                              type="button"
                              className={`h5-candidate-item ${coverTitle === cand.title ? 'active' : ''}`}
                              onClick={() => {
                                if (cand.tag) setCoverTag(cand.tag);
                                if (cand.title) setCoverTitle(cand.title);
                                if (cand.subtitle) setCoverSubtitle(cand.subtitle);
                                setActivePreviewTab('cover');
                              }}
                            >
                              <div className="cand-main">
                                <span className="cand-tag">[{cand.tag}]</span>
                                <span className="cand-title">{cand.title}</span>
                              </div>
                              <span className="cand-apply">套用 ➔</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Sub-tab 2: Text Inputs & Position Pills */}
                {coverSubTab === 'text' && (
                  <div className="h5-subtab-content">
                    <div className="h5-form-stack">
                      <div className="h5-field">
                        <label>🏷️ 胶囊角标</label>
                        <input
                          type="text"
                          className="h5-input"
                          value={coverTag}
                          onChange={(e) => setCoverTag(e.target.value)}
                          placeholder="如：⚡ BREAKING 速报"
                        />
                      </div>

                      <div className="h5-field">
                        <label>🔥 号召力主标题（醒目大字）</label>
                        <input
                          type="text"
                          className="h5-input bold"
                          value={coverTitle}
                          onChange={(e) => setCoverTitle(e.target.value)}
                          placeholder="如：氛围感彻底封神"
                        />
                      </div>

                      <div className="h5-field">
                        <label>📝 关键副标题（补充说明）</label>
                        <input
                          type="text"
                          className="h5-input"
                          value={coverSubtitle}
                          onChange={(e) => setCoverSubtitle(e.target.value)}
                          placeholder="如：2026 视觉精选指南 · 建议先马后看"
                        />
                      </div>

                      <div className="h5-pos-grid">
                        <div className="h5-field">
                          <label>↕️ 纵向位置</label>
                          <div className="h5-pill-group">
                            {[
                              { id: 'top', label: '⬆️ 顶部' },
                              { id: 'center', label: '⏺️ 居中' },
                              { id: 'bottom', label: '⬇️ 底部' }
                            ].map((p) => (
                              <button
                                key={p.id}
                                type="button"
                                className={`h5-choice-pill ${coverPosition === p.id ? 'active' : ''}`}
                                onClick={() => setCoverPosition(p.id)}
                              >
                                {p.label}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="h5-field">
                          <label>↔️ 横向对齐</label>
                          <div className="h5-pill-group">
                            {[
                              { id: 'left', label: '⬅️ 居左' },
                              { id: 'center', label: '⏺️ 居中' },
                              { id: 'right', label: '➡️ 居右' }
                            ].map((a) => (
                              <button
                                key={a.id}
                                type="button"
                                className={`h5-choice-pill ${coverAlign === a.id ? 'active' : ''}`}
                                onClick={() => setCoverAlign(a.id)}
                              >
                                {a.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Sub-tab 3: 3D Subject Occlusion & Hand-drawn Outline / Doodle */}
                {coverSubTab === 'depth' && (
                  <div className="h5-subtab-content">
                    {/* 3D Subject Occlusion Card */}
                    <div className={`h5-feature-toggle-card ${subjectOcclusion ? 'active-indigo' : ''}`}>
                      <div className="h5-toggle-row">
                        <div className="h5-toggle-info">
                          <div className="h5-toggle-title">
                            <span>👤 画面主人公遮挡大字</span>
                            <span className="h5-mini-badge indigo">3D穿插</span>
                          </div>
                          <p>超大标题位于人物身后，营造杂志大刊空间穿插层次感</p>
                        </div>
                        <button
                          type="button"
                          className={`h5-switch-pill ${subjectOcclusion ? 'on' : 'off'}`}
                          onClick={() => {
                            const next = !subjectOcclusion;
                            setSubjectOcclusion(next);
                            if (next && !outlineMasks[coverImageIdx] && !isDetectingOutline) {
                              handleDetectSubjectOutline(coverImageIdx);
                            }
                          }}
                        >
                          <span className="switch-dot" />
                          <span>{subjectOcclusion ? '已开启' : '已关闭'}</span>
                        </button>
                      </div>

                      {subjectOcclusion && !outlineMasks[coverImageIdx] && (
                        <div className="h5-occlusion-hint">
                          <span>{isDetectingOutline ? '⏳ 正在提取高精度人像蒙版...' : '💡 需识别人像主体以开启 3D 遮挡效果'}</span>
                          {!isDetectingOutline && (
                            <button
                              type="button"
                              onClick={() => handleDetectSubjectOutline(coverImageIdx)}
                            >
                              立即识别
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Subject Outline & Doodle Card */}
                    <div className={`h5-feature-toggle-card ${outlineEnabled ? 'active-emerald' : ''}`}>
                      <div className="h5-toggle-row">
                        <div className="h5-toggle-info">
                          <div className="h5-toggle-title">
                            <span>✨ 主人公手绘外轮廓线</span>
                          </div>
                          <p>支持 AI 自动人像描边与自由荧光手绘涂鸦</p>
                        </div>
                        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                          <button
                            type="button"
                            className="h5-ai-mini-btn"
                            disabled={isDetectingOutline}
                            onClick={() => handleDetectSubjectOutline(coverImageIdx, true)}
                          >
                            {isDetectingOutline ? '⏳ 识别中' : '🤖 AI 描边'}
                          </button>
                          <button
                            type="button"
                            className={`h5-switch-pill emerald ${outlineEnabled ? 'on' : 'off'}`}
                            onClick={() => setOutlineEnabled(!outlineEnabled)}
                          >
                            <span className="switch-dot" />
                            <span>{outlineEnabled ? '已开启' : '已关闭'}</span>
                          </button>
                        </div>
                      </div>

                      {outlineEnabled && (
                        <div className="h5-outline-controls">
                          <div className="h5-control-line">
                            <span className="ctrl-label">线条质感</span>
                            <div className="h5-pill-group">
                              {[
                                { id: 'dashed', name: '涂鸦虚线' },
                                { id: 'smooth', name: '实线手绘' },
                                { id: 'glow', name: '霓虹发光' }
                              ].map((t) => (
                                <button
                                  key={t.id}
                                  type="button"
                                  className={`h5-choice-pill ${outlineType === t.id ? 'active' : ''}`}
                                  onClick={() => setOutlineType(t.id)}
                                >
                                  {t.name}
                                </button>
                              ))}
                            </div>
                          </div>

                          <div className="h5-control-line">
                            <span className="ctrl-label">轮廓配色</span>
                            <div className="h5-color-swatches">
                              {[
                                { color: '#FFFFFF', name: '经典白', border: '#cbd5e1' },
                                { color: '#FFE600', name: '荧光黄', border: '#eab308' },
                                { color: '#FF2E93', name: '芭比粉', border: '#db2777' },
                                { color: '#00F0FF', name: '电光蓝', border: '#06b6d4' },
                                { color: '#A3E635', name: '牛油果绿', border: '#84cc16' }
                              ].map((c) => (
                                <button
                                  key={c.color}
                                  type="button"
                                  title={c.name}
                                  className={`h5-swatch ${outlineColor === c.color ? 'active' : ''}`}
                                  style={{ backgroundColor: c.color, borderColor: c.border }}
                                  onClick={() => setOutlineColor(c.color)}
                                />
                              ))}
                            </div>
                          </div>

                          <div className="h5-control-line">
                            <span className="ctrl-label">线条粗细</span>
                            <div className="h5-pill-group">
                              {[
                                { val: 6, label: '细 6px' },
                                { val: 10, label: '中 10px' },
                                { val: 16, label: '粗 16px' }
                              ].map((w) => (
                                <button
                                  key={w.val}
                                  type="button"
                                  className={`h5-choice-pill ${outlineWidth === w.val ? 'active' : ''}`}
                                  onClick={() => setOutlineWidth(w.val)}
                                >
                                  {w.label}
                                </button>
                              ))}
                            </div>
                          </div>

                          <div className="h5-doodle-bar">
                            <button
                              type="button"
                              className={`h5-doodle-toggle ${isDoodleMode ? 'active' : ''}`}
                              onClick={() => {
                                setIsDoodleMode(!isDoodleMode);
                                setActivePreviewTab('cover');
                              }}
                            >
                              {isDoodleMode ? '✍️ 涂鸦绘制中 (点击完成)' : '✍️ 开启自由手绘画笔'}
                            </button>
                            <button type="button" className="h5-doodle-sub" onClick={undoLastDoodle}>↩️ 撤销</button>
                            <button type="button" className="h5-doodle-sub" onClick={clearDoodles}>🧹 清空</button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                <button
                  type="button"
                  className="h5-primary-action-btn"
                  style={{ marginTop: '0.75rem' }}
                  onClick={() => {
                    setActivePreviewTab('cover');
                    downloadCoverImage();
                  }}
                >
                  📥 立即导出高清封面标题图
                </button>
              </div>
            )}

            {/* TAB 4: AI XIAOHONGSHU COPYWRITING */}
            {uploadedImages.length > 0 && activeTab === 'copy' && (
              <div className="h5-panel-card">
                <div className="h5-panel-header">
                  <div>
                    <h2 className="h5-panel-title">✍️ 小红书爆款笔记生成</h2>
                    <p className="h5-panel-desc">结合照片视觉细节与 EXIF 真实坐标，智能撰写 3 套高赞笔记</p>
                  </div>
                </div>

                <div className="h5-copy-controls">
                  <div className="h5-field">
                    <label>笔记风格定位</label>
                    <div className="h5-pill-group">
                      {[
                        { id: '探店', label: '🛍️ 探店打卡' },
                        { id: '旅行心情', label: '✈️ 旅行心情' },
                        { id: '运动', label: '🏃 户外运动' }
                      ].map((st) => (
                        <button
                          key={st.id}
                          type="button"
                          className={`h5-choice-pill ${copyStyle === st.id ? 'active' : ''}`}
                          onClick={() => setCopyStyle(st.id)}
                        >
                          {st.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="h5-field">
                    <label>补充亮点或心情关键词（选填）</label>
                    <textarea
                      className="h5-textarea"
                      rows={2}
                      placeholder="例如：周末看海、偶遇绝美日落、出片机位分享..."
                      value={copyKeywords}
                      onChange={(e) => setCopyKeywords(e.target.value)}
                    />
                  </div>

                  <button
                    type="button"
                    className="h5-primary-action-btn indigo"
                    onClick={handleGenerateAICopy}
                    disabled={isGeneratingCopy}
                  >
                    {isGeneratingCopy ? '🤖 多模态视觉分析撰写中...' : '✨ 一键生成 3 套小红书爆款文案'}
                  </button>
                </div>

                {/* Generated Copywriting Note Card */}
                {generatedCopyOptions.length > 0 && (
                  <div className="h5-xhs-note-card">
                    <div className="h5-note-card-header">
                      <div className="h5-note-tabs">
                        {generatedCopyOptions.map((opt, idx) => (
                          <button
                            key={idx}
                            type="button"
                            className={`h5-note-tab ${activeCopyOptionIdx === idx ? 'active' : ''}`}
                            onClick={() => applyCopyOption(idx)}
                          >
                            方案 {idx + 1}
                          </button>
                        ))}
                      </div>

                      <div className="h5-note-actions">
                        <button
                          type="button"
                          className="h5-note-act-btn primary"
                          onClick={() => {
                            const opt = generatedCopyOptions[activeCopyOptionIdx];
                            const fullText = `【${aiTitle || opt.title}】\n\n${aiBody || opt.body}\n\n${opt.tags}`;
                            copyToClipboard(fullText, '✅ 爆款文案已复制，可直接去小红书粘贴发布！');
                          }}
                        >
                          📋 复制全文
                        </button>
                        <button
                          type="button"
                          className="h5-note-act-btn"
                          onClick={exportReportCard}
                        >
                          📸 导出报告卡
                        </button>
                      </div>
                    </div>

                    <div className="h5-note-editor">
                      <div className="h5-note-title-row">
                        <span className="note-tag-badge">标题</span>
                        <input
                          type="text"
                          value={aiTitle}
                          onChange={(e) => setAiTitle(e.target.value)}
                          placeholder="在此编辑笔记标题..."
                        />
                      </div>
                      <textarea
                        value={aiBody}
                        onChange={(e) => setAiBody(e.target.value)}
                        rows={8}
                        placeholder="在此编辑笔记正文与话题标签..."
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        </main>

        {/* 4. Fixed Native H5 Bottom Navigation & Action Dock */}
        <nav className="h5-bottom-dock">
          <div className="h5-dock-tabs">
            <button
              type="button"
              className={`h5-dock-tab ${activeTab === 'photos' ? 'active' : ''}`}
              onClick={() => setActiveTab('photos')}
            >
              <span className="dock-icon">📸</span>
              <span className="dock-label">选图</span>
              {uploadedImages.length > 0 && (
                <span className="dock-badge">{uploadedImages.length}</span>
              )}
            </button>

            <button
              type="button"
              className={`h5-dock-tab ${activeTab === 'edit' ? 'active' : ''}`}
              onClick={() => {
                if (uploadedImages.length === 0) {
                  showToast('请先上传或载入示例照片哦！');
                  setActiveTab('photos');
                  return;
                }
                setActiveTab('edit');
                setActivePreviewTab('styled');
              }}
            >
              <span className="dock-icon">✨</span>
              <span className="dock-label">修图</span>
              {activeImage?.editTag && <span className="dock-dot" />}
            </button>

            <button
              type="button"
              className={`h5-dock-tab ${activeTab === 'style' ? 'active' : ''}`}
              onClick={() => {
                if (uploadedImages.length === 0) {
                  showToast('请先上传或载入示例照片哦！');
                  setActiveTab('photos');
                  return;
                }
                setActiveTab('style');
                setActivePreviewTab('styled');
              }}
            >
              <span className="dock-icon">🎨</span>
              <span className="dock-label">画风</span>
              {activeImage?.activeStyle && <span className="dock-dot" />}
            </button>

            <button
              type="button"
              className={`h5-dock-tab ${activeTab === 'cover' ? 'active' : ''}`}
              onClick={() => {
                if (uploadedImages.length === 0) {
                  showToast('请先上传或载入示例照片哦！');
                  setActiveTab('photos');
                  return;
                }
                setActiveTab('cover');
                setActivePreviewTab('cover');
              }}
            >
              <span className="dock-icon">🏷️</span>
              <span className="dock-label">封面</span>
            </button>

            <button
              type="button"
              className={`h5-dock-tab ${activeTab === 'copy' ? 'active' : ''}`}
              onClick={() => {
                if (uploadedImages.length === 0) {
                  showToast('请先上传或载入示例照片哦！');
                  setActiveTab('photos');
                  return;
                }
                setActiveTab('copy');
              }}
            >
              <span className="dock-icon">✍️</span>
              <span className="dock-label">文案</span>
              {generatedCopyOptions.length > 0 && (
                <span className="dock-badge">{generatedCopyOptions.length}</span>
              )}
            </button>
          </div>

          <button
            type="button"
            className="h5-dock-cta"
            onClick={() => {
              if (uploadedImages.length === 0) {
                fileInputRef.current?.click();
                return;
              }
              if (activePreviewTab === 'cover') {
                downloadCoverImage();
              } else {
                downloadActiveImage();
              }
            }}
          >
            {uploadedImages.length === 0
              ? '📤 上传照片'
              : (activePreviewTab === 'cover' ? '📥 存封面' : '📥 存美图')}
          </button>
        </nav>

        {/* WeChat Long-Press Save Modal */}
        {wechatSaveModal.isOpen && (
          <div
            className="wechat-modal-overlay"
            onClick={() => setWechatSaveModal({ isOpen: false, imageSrc: '', title: '', fileName: '' })}
          >
            <div className="wechat-modal-card" onClick={(e) => e.stopPropagation()}>
              <div className="wechat-modal-header">
                <div className="wechat-modal-title">
                  <span>📱 {wechatSaveModal.title || '保存图片'}</span>
                </div>
                <button
                  type="button"
                  className="wechat-modal-close"
                  onClick={() => setWechatSaveModal({ isOpen: false, imageSrc: '', title: '', fileName: '' })}
                >
                  ✕
                </button>
              </div>

              <div className="wechat-save-tip-pulse">
                <span className="tip-hand">👆</span>
                <span>长按下方图片，选择<strong>【保存到手机 / 存储图像】</strong></span>
              </div>

              <div className="wechat-modal-img-wrapper">
                <img
                  src={wechatSaveModal.imageSrc}
                  alt={wechatSaveModal.title}
                  className="wechat-modal-img"
                />
              </div>

              <div className="wechat-modal-actions">
                {generatedCopyOptions.length > 0 && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ flex: 1, padding: '0.6rem', fontSize: '0.82rem', fontWeight: 600 }}
                    onClick={() => {
                      const opt = generatedCopyOptions[activeCopyOptionIdx];
                      const fullText = `【${aiTitle || opt.title}】\n\n${aiBody || opt.body}\n\n${opt.tags}`;
                      copyToClipboard(fullText, '✅ 文案已复制！可直接粘贴发布');
                    }}
                  >
                    📋 复制发文文案
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ flex: 1, padding: '0.6rem', fontSize: '0.82rem', fontWeight: 600 }}
                  onClick={() => {
                    const link = document.createElement('a');
                    link.href = wechatSaveModal.imageSrc;
                    link.download = wechatSaveModal.fileName || `xhs-${Date.now()}.jpg`;
                    link.click();
                    showToast('已开始下载文件！');
                  }}
                >
                  📥 直接下载文件
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Floating Toast Notification */}
        {toastMsg && (
          <div className="toast-notification">
            {toastMsg}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
