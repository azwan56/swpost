import React, { useState, useRef, useEffect } from 'react';
import ExifReader from 'exifreader';
import html2canvas from 'html2canvas';

// SVG Stickers Definition
const STICKER_TEMPLATES = {
  heart: (
    <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 40 C12 18, 45 15, 50 35 C55 15, 88 18, 88 40 C88 65, 58 82, 50 88 C42 82, 12 65, 12 40 Z" fill="#fff0f2" stroke="#ff2442" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  arrow: (
    <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M20 20 C40 30, 60 30, 75 75" stroke="#ff2442" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M50 72 L75 75 L73 50" stroke="#ff2442" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  sparkle: (
    <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M50 10 L58 38 L86 38 L64 54 L72 82 L50 66 L28 82 L36 54 L14 38 L42 38 Z" fill="#fffde7" stroke="#ffeb3b" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  speech: (
    <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M15 50 C15 30, 35 15, 50 15 C65 15, 85 30, 85 50 C85 70, 65 80, 50 80 C42 80, 35 84, 25 88 C28 80, 15 70, 15 50 Z" fill="white" stroke="#222222" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="40" cy="50" r="3" fill="#222222"/>
      <circle cx="50" cy="50" r="3" fill="#222222"/>
      <circle cx="60" cy="50" r="3" fill="#222222"/>
    </svg>
  ),
  highlight: (
    <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="50" cy="50" rx="40" ry="25" transform="rotate(-8 50 50)" stroke="#ff2442" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
};

const BRUSH_COLORS = ['#ff2442', '#3b82f6', '#10b981', '#f59e0b', '#000000', '#ffffff'];
const TEXT_COLORS = ['#ffffff', '#ffeb3b', '#ff2442', '#ff6584', '#000000'];
const TEXT_SUGGESTIONS = ['元气满满', '好治愈', '运动日常', '夏日清晨', '冲鸭', 'Vibe', '大自然', '好美', '开心'];

// Helper: Physically crops the image using canvas, caps resolution at 1600px for high quality and optimized payload
const cropImagePhysically = (src, cropBox) => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      
      // Convert percentage coordinates to pixels
      const origX = (cropBox.xmin / 100) * img.naturalWidth;
      const origY = (cropBox.ymin / 100) * img.naturalHeight;
      const origWidth = ((cropBox.xmax - cropBox.xmin) / 100) * img.naturalWidth;
      const origHeight = ((cropBox.ymax - cropBox.ymin) / 100) * img.naturalHeight;
      
      // Limit resolution to max 1600px width/height to make style transfer & network payloads highly optimized
      const MAX_CROP_DIM = 1600;
      let width = origWidth;
      let height = origHeight;
      let scale = 1;
      
      if (width > MAX_CROP_DIM || height > MAX_CROP_DIM) {
        if (width > height) {
          scale = MAX_CROP_DIM / width;
        } else {
          scale = MAX_CROP_DIM / height;
        }
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      
      canvas.width = width;
      canvas.height = height;

      // Fill background with solid white
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      
      // Calculate intersection bounds
      const sX = Math.max(0, origX);
      const sY = Math.max(0, origY);
      const sW = Math.min(img.naturalWidth, origX + origWidth) - sX;
      const sH = Math.min(img.naturalHeight, origY + origHeight) - sY;

      if (sW > 0 && sH > 0) {
        const dX = (sX - origX) * (width / origWidth);
        const dY = (sY - origY) * (height / origHeight);
        const dW = sW * (width / origWidth);
        const dH = sH * (height / origHeight);
        
        ctx.drawImage(img, sX, sY, sW, sH, dX, dY, dW, dH);
      }
      
      resolve(canvas.toDataURL('image/jpeg', 0.95));
    };
    img.onerror = (err) => reject(new Error('Failed to load image for physical cropping: ' + err));
    img.src = src;
  });
};

// Helper: Resize and compress base64 image if it exceeds maxDim or is too large to prevent backend payload issues
const resizeImageBase64 = (dataUrl, maxDim = 1600, quality = 0.85) => {
  return new Promise((resolve) => {
    if (!dataUrl || dataUrl.length < 1500000) {
      resolve(dataUrl);
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
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

// Helper: Compress/downscale original image files to max 1024px before uploading to backend for layout analysis
const compressImageForAnalysis = (file) => {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        const MAX_DIM = 1024;
        let width = img.width;
        let height = img.height;
        
        if (width > height) {
          if (width > MAX_DIM) {
            height = Math.round((height * MAX_DIM) / width);
            width = MAX_DIM;
          }
        } else {
          if (height > MAX_DIM) {
            width = Math.round((width * MAX_DIM) / height);
            height = MAX_DIM;
          }
        }
        
        canvas.width = width;
        canvas.height = height;
        ctx.drawImage(img, 0, 0, width, height);
        
        canvas.toBlob((blob) => {
          resolve(blob || file);
        }, 'image/jpeg', 0.85); // 85% JPEG is perfect for model vision analysis
      };
      img.onerror = () => resolve(file); // fallback to original if image load fails
      img.src = e.target.result;
    };
    reader.onerror = () => resolve(file); // fallback to original if read fails
    reader.readAsDataURL(file);
  });
};

function App() {
  // API base path — adapts automatically to Vite's base setting
  // Local dev: '' (proxy handles /api), Production subpath: '/swpost'
  const API_BASE = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');

  // App States
  const [uploadedImages, setUploadedImages] = useState([]); // [{ id, file, src, croppedSrc, metadata: { time, location }, cropBox, stickers: [], texts: [], drawings: null }]
  const [activeIdx, setActiveIdx] = useState(0); 
  const [globalMetadata, setGlobalMetadata] = useState({ time: '', location: '' });
  const [activeTab, setActiveTab] = useState('frame'); // 'frame', 'sticker', 'text', 'erase'
  
  // Camera Frame & EXIF parameters states
  const [selectedFrame, setSelectedFrame] = useState('none'); // 'none', 'leica-white', 'leica-black', 'hasselblad', 'polaroid'
  const [exifParams, setExifParams] = useState({
    make: 'FUJIFILM',
    model: 'X-T5',
    fNumber: 'f/2.8',
    iso: 'ISO 200',
    focal: '35mm',
    shutter: '1/250s',
    date: '2026.07.06'
  });

  const handleUpdateExif = (field, value) => {
    setExifParams(prev => ({ ...prev, [field]: value }));
    setUploadedImages(prev => prev.map((img, idx) => {
      if (idx === activeIdx) {
        return {
          ...img,
          exif: {
            ...(img.exif || {}),
            [field]: value
          }
        };
      }
      return img;
    }));
  };
  
  // Cinematic Subtitle States
  const [movieSubtitleCn, setMovieSubtitleCn] = useState('“生活没有标准答案，每个人都在走自己的路。”');
  const [movieSubtitleEn, setMovieSubtitleEn] = useState('There are no standard answers in life, everyone is on their own way.');
  
  // Movie Subtitle AI States
  const [isGeneratingSubtitle, setIsGeneratingSubtitle] = useState(false);
  const [movieTheme, setMovieTheme] = useState('生活');
  const [isGeneratingTags, setIsGeneratingTags] = useState(false);
  
  // AI Copywriting States
  const [generatedCopyOptions, setGeneratedCopyOptions] = useState([]);
  const [activeCopyOptionIdx, setActiveCopyOptionIdx] = useState(0);
  const [isGeneratingCopy, setIsGeneratingCopy] = useState(false);
  
  // Drawing Canvas States
  const [isDrawing, setIsDrawing] = useState(false);
  const [brushColor, setBrushColor] = useState('#ff2442');
  const [brushWidth, setBrushWidth] = useState(4);
  
  // Erase (Inpainting Mask) Brush States
  const [isErasing, setIsErasing] = useState(false);
  const [eraseWidth, setEraseWidth] = useState(24);
  const [hasEraseMarks, setHasEraseMarks] = useState(false);

  // Active selection states
  const [selectedStickerId, setSelectedStickerId] = useState(null);
  const [selectedTextId, setSelectedTextId] = useState(null);
  const [selectedTagId, setSelectedTagId] = useState(null);
  
  // Custom Inputs & Overlays
  const [customTextContent, setCustomTextContent] = useState('');
  const [customTextColor, setCustomTextColor] = useState('#ffffff');
  const [customTagText, setCustomTagText] = useState('');
  
  // AI Generation & Processing Loading States
  const [aiTitle, setAiTitle] = useState('');
  const [aiBody, setAiBody] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [aiOperationName, setAiOperationName] = useState(''); // "大模型分析", "AI 消除", "吉卜力动漫化"
  const [errorMsg, setErrorMsg] = useState('');
  const [copyStyle, setCopyStyle] = useState('探店'); // '探店', '心情故事', '攻略', '自定义'
  const [customCopyStyle, setCustomCopyStyle] = useState('');
  const [selectedExportIds, setSelectedExportIds] = useState([]);
  const [copyKeywords, setCopyKeywords] = useState('');
  const [contextMenu, setContextMenu] = useState(null); // { x, y, visible }
  const [mobilePreviewImages, setMobilePreviewImages] = useState([]); // Array of data URLs
  const longPressTimerRef = useRef(null);

  useEffect(() => {
    const handleGlobalClick = () => {
      if (contextMenu && contextMenu.visible) {
        setContextMenu(null);
      }
    };
    window.addEventListener('click', handleGlobalClick);
    return () => window.removeEventListener('click', handleGlobalClick);
  }, [contextMenu]);

  
  // Refs
  const fileInputRef = useRef(null);
  const drawingCanvasRef = useRef(null);
  const drawingCtxRef = useRef(null);
  const eraseCanvasRef = useRef(null);
  const eraseCtxRef = useRef(null);
  const posterRef = useRef(null);
  
  // Interactive gesture drag/rotate refs
  const stickerDragRef = useRef(null);
  const stickerRotateScaleRef = useRef(null);
  const textDragRef = useRef(null);
  const textRotateScaleRef = useRef(null);
  const tagDragRef = useRef(null);
  
  // Image Panning / Framing Adjust States & Refs
  const editorImageContainerRef = useRef(null);
  const [panZoom, setPanZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });

  // Initialize panning state when switching to 'pan' tab
  const handleEnterPanTab = () => {
    setActiveTab('pan');
    const activeImage = uploadedImages[activeIdx];
    if (!activeImage || !editorImageContainerRef.current) return;
    
    // Get container size
    const rect = editorImageContainerRef.current.getBoundingClientRect();
    const W_c = rect.width;
    const H_c = rect.height;

    // Load original image to get dimensions
    const img = new Image();
    img.src = activeImage.src;
    img.onload = () => {
      const W = img.naturalWidth;
      const H = img.naturalHeight;
      const targetRatio = W_c / H_c;

      // Extract current cropBox percentages
      const cb = activeImage.cropBox || { xmin: 0, ymin: 0, xmax: 100, ymax: 100 };
      const cropWidthPercent = cb.xmax - cb.xmin;
      const cropHeightPercent = cb.ymax - cb.ymin;

      // Calculate panZoom
      let zoom = 1;
      if (W / H > targetRatio) {
        zoom = 100 / cropHeightPercent;
      } else {
        zoom = 100 / cropWidthPercent;
      }
      setPanZoom(zoom);

      // Calculate focus point percentages
      const W_crop = (cropWidthPercent / 100) * W;
      const H_crop = (cropHeightPercent / 100) * H;
      const xmin = (cb.xmin / 100) * W;
      const ymin = (cb.ymin / 100) * H;

      const focusX = W > W_crop ? (xmin / (W - W_crop)) * 100 : 50;
      const focusY = H > H_crop ? (ymin / (H - H_crop)) * 100 : 50;

      // Calculate rendered dimensions
      let W_r = W_c;
      let H_r = H_c;
      if (W / H > targetRatio) {
        H_r = H_c;
        W_r = H_c * (W / H);
      } else {
        W_r = W_c;
        H_r = W_c * (H / W);
      }
      const W_v = W_r * zoom;
      const H_v = H_r * zoom;

      // Calculate panOffset
      const offsetX = W_v > W_c ? ((50 - focusX) / 100) * (W_v - W_c) : 0;
      const offsetY = H_v > H_c ? ((50 - focusY) / 100) * (H_v - H_c) : 0;

      setPanOffset({ x: offsetX, y: offsetY });
    };
  };

  const startPanning = (e) => {
    e.preventDefault();
    setIsPanning(true);
    setPanStart({ x: e.clientX - panOffset.x, y: e.clientY - panOffset.y });
  };

  const pan = (e) => {
    const activeImage = uploadedImages[activeIdx];
    if (!isPanning || !activeImage || !editorImageContainerRef.current) return;
    e.preventDefault();
    
    // Get container size
    const rect = editorImageContainerRef.current.getBoundingClientRect();
    const W_c = rect.width;
    const H_c = rect.height;

    // Get image dimensions from target
    const imgElement = e.target;
    const W = imgElement.naturalWidth;
    const H = imgElement.naturalHeight;

    let W_r = W_c;
    let H_r = H_c;
    if (W / H > W_c / H_c) {
      H_r = H_c;
      W_r = H_c * (W / H);
    } else {
      W_r = W_c;
      H_r = W_c * (H / W);
    }

    const W_v = W_r * panZoom;
    const H_v = H_r * panZoom;

    // Calculate maximum drag values
    const maxDx = W_v > W_c ? (W_v - W_c) / 2 : 0;
    const maxDy = H_v > H_c ? (H_v - H_c) / 2 : 0;

    // Calculate new raw drag offsets
    let newX = e.clientX - panStart.x;
    let newY = e.clientY - panStart.y;

    // Constrain within boundaries so no black background is visible
    newX = Math.max(-maxDx, Math.min(maxDx, newX));
    newY = Math.max(-maxDy, Math.min(maxDy, newY));

    setPanOffset({ x: newX, y: newY });
  };

  const autoSavePanCrop = async (zoomVal = panZoom, offsetVal = panOffset) => {
    const activeImage = uploadedImages[activeIdx];
    if (!activeImage || !editorImageContainerRef.current) return;

    try {
      const rect = editorImageContainerRef.current.getBoundingClientRect();
      const W_c = rect.width;
      const H_c = rect.height;

      const img = new Image();
      img.src = activeImage.src;
      
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
      });

      const W = img.naturalWidth;
      const H = img.naturalHeight;

      let W_r = W_c;
      let H_r = H_c;
      if (W / H > W_c / H_c) {
        H_r = H_c;
        W_r = H_c * (W / H);
      } else {
        W_r = W_c;
        H_r = W_c * (H / W);
      }

      const W_v = W_r * zoomVal;
      const H_v = H_r * zoomVal;

      const focusX = W_v > W_c ? (50 - (offsetVal.x / (W_v - W_c)) * 100) : 50;
      const focusY = H_v > H_c ? (50 - (offsetVal.y / (H_v - H_c)) * 100) : 50;

      const targetRatio = W_c / H_c;
      let W_crop, H_crop;
      if (W / H > targetRatio) {
        H_crop = H / zoomVal;
        W_crop = H_crop * targetRatio;
      } else {
        W_crop = W / zoomVal;
        H_crop = W_crop / targetRatio;
      }

      const xmin = (focusX / 100) * (W - W_crop);
      const ymin = (focusY / 100) * (H - H_crop);
      const xmax = xmin + W_crop;
      const ymax = ymin + H_crop;

      const newCropBox = {
        xmin: (xmin / W) * 100,
        ymin: (ymin / H) * 100,
        xmax: (xmax / W) * 100,
        ymax: (ymax / H) * 100
      };

      const newCroppedSrc = await cropImagePhysically(activeImage.src, newCropBox);

      setUploadedImages(prev => prev.map((item, idx) => {
        if (idx === activeIdx) {
          return {
            ...item,
            cropBox: newCropBox,
            croppedSrc: newCroppedSrc,
            isAIEdited: false
          };
        }
        return item;
      }));
    } catch (err) {
      console.error('Silent auto crop failed:', err);
    }
  };

  const stopPanning = () => {
    setIsPanning(false);
    autoSavePanCrop();
  };

  const handleSavePanCrop = async () => {
    const activeImage = uploadedImages[activeIdx];
    if (!activeImage || !editorImageContainerRef.current) return;
    setIsLoading(true);
    setAiOperationName('重新裁切');

    try {
      const rect = editorImageContainerRef.current.getBoundingClientRect();
      const W_c = rect.width;
      const H_c = rect.height;

      // Load original image to get dimensions
      const img = new Image();
      img.src = activeImage.src;
      
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
      });

      const W = img.naturalWidth;
      const H = img.naturalHeight;

      let W_r = W_c;
      let H_r = H_c;
      if (W / H > W_c / H_c) {
        H_r = H_c;
        W_r = H_c * (W / H);
      } else {
        W_r = W_c;
        H_r = W_c * (H / W);
      }

      const W_v = W_r * panZoom;
      const H_v = H_r * panZoom;

      const focusX = W_v > W_c ? (50 - (panOffset.x / (W_v - W_c)) * 100) : 50;
      const focusY = H_v > H_c ? (50 - (panOffset.y / (H_v - H_c)) * 100) : 50;

      const targetRatio = W_c / H_c;
      let W_crop, H_crop;
      if (W / H > targetRatio) {
        H_crop = H / panZoom;
        W_crop = H_crop * targetRatio;
      } else {
        W_crop = W / panZoom;
        H_crop = W_crop / targetRatio;
      }

      const xmin = (focusX / 100) * (W - W_crop);
      const ymin = (focusY / 100) * (H - H_crop);
      const xmax = xmin + W_crop;
      const ymax = ymin + H_crop;

      const newCropBox = {
        xmin: (xmin / W) * 100,
        ymin: (ymin / H) * 100,
        xmax: (xmax / W) * 100,
        ymax: (ymax / H) * 100
      };

      // Perform physical crop
      const newCroppedSrc = await cropImagePhysically(activeImage.src, newCropBox);

      setUploadedImages(prev => prev.map((item, idx) => {
        if (idx === activeIdx) {
          return {
            ...item,
            cropBox: newCropBox,
            croppedSrc: newCroppedSrc,
            isAIEdited: false // Allow re-cartoonization/eliminating on new crop
          };
        }
        return item;
      }));

      // Switch back to drawing tab
      setActiveTab('draw');
    } catch (err) {
      console.error(err);
      setErrorMsg('调整裁剪位置失败：' + err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const getActiveCellAspectRatio = () => {
    if (selectedFrame === 'film-roll') {
      return '3/2';
    }
    const count = uploadedImages.length;
    if (count === 0) return '3/4';
    if (count === 1) return '3/4';
    if (count === 2) return '3/8';
    if (count === 4) return '3/4';
    if (count === 3) {
      if (activeIdx === 0) return '9/22';
      return '15/22';
    }
    return '3/4';
  };

  // 1. Handle Multiple Photos Upload
  const handlePhotosUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    setErrorMsg('');
    const availableSlots = 4 - uploadedImages.length;
    if (availableSlots <= 0) {
      setErrorMsg('最多支持上传 4 张图片！');
      return;
    }
    const filesToProcess = files.slice(0, availableSlots);
    const newImages = [];
    
    for (const file of filesToProcess) {
      const id = Math.random().toString(36).substring(2, 9);
      
      const src = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (event) => resolve(event.target.result);
        reader.readAsDataURL(file);
      });

      let time = '';
      let location = '';
      let lat = null;
      let lon = null;
      let exif = {
        make: '',
        model: '',
        fNumber: '',
        iso: '',
        focal: '',
        shutter: '',
        date: ''
      };

      try {
        const tags = await ExifReader.load(file);
        if (tags.DateTimeOriginal) {
          const rawDate = tags.DateTimeOriginal.description;
          const dateParts = rawDate.split(' ')[0].split(':');
          if (dateParts.length === 3) {
            time = `${dateParts[0]}.${dateParts[1]}.${dateParts[2]}`;
          } else {
            time = rawDate;
          }
          exif.date = time;
        }
        
        if (tags.GPSLatitude && tags.GPSLongitude) {
          const latNum = parseFloat(tags.GPSLatitude.description);
          const lonNum = parseFloat(tags.GPSLongitude.description);
          if (!isNaN(latNum) && !isNaN(lonNum)) {
            const latRef = tags.GPSLatitudeRef?.description || 'N';
            const lonRef = tags.GPSLongitudeRef?.description || 'E';
            lat = latRef.includes('S') ? -Math.abs(latNum) : Math.abs(latNum);
            lon = lonRef.includes('W') ? -Math.abs(lonNum) : Math.abs(lonNum);
          }
        }

        // Camera EXIF data
        exif.make = tags.Make?.description || '';
        exif.model = tags.Model?.description || '';
        
        if (tags.FNumber?.value) {
          exif.fNumber = `f/${parseFloat(tags.FNumber.value).toFixed(1)}`;
        } else if (tags.FNumber?.description) {
          exif.fNumber = tags.FNumber.description.startsWith('f/') ? tags.FNumber.description : `f/${tags.FNumber.description}`;
        }

        const rawIso = tags.ISOSpeedRatings?.value || tags.ISOSpeedRatings?.description;
        if (rawIso) {
          exif.iso = `ISO ${rawIso}`;
        }

        const rawFocal = tags.FocalLength?.value || tags.FocalLength?.description;
        if (rawFocal) {
          const numFocal = parseFloat(rawFocal);
          exif.focal = !isNaN(numFocal) ? `${Math.round(numFocal)}mm` : rawFocal;
        }

        const rawShutter = tags.ExposureTime?.description;
        if (rawShutter) {
          exif.shutter = rawShutter;
        } else if (tags.ExposureTime?.value) {
          const s = parseFloat(tags.ExposureTime.value);
          if (s >= 1) {
            exif.shutter = `${s.toFixed(1)}s`;
          } else {
            exif.shutter = `1/${Math.round(1 / s)}s`;
          }
        }
      } catch (err) {
        console.warn('Metadata parsing failed:', err);
      }

      newImages.push({
        id,
        file,
        src,
        croppedSrc: src, // initially full image
        metadata: { time, location, lat, lon },
        cropBox: { ymin: 0, xmin: 0, ymax: 100, xmax: 100 },
        stickers: [],
        texts: [],
        drawings: null,
        exif
      });
    }

    const updatedImages = [...uploadedImages, ...newImages];
    setUploadedImages(updatedImages);
    setSelectedExportIds(prev => [...prev, ...newImages.map(img => img.id)]);
    setActiveIdx(uploadedImages.length);
    
    let detectedTime = globalMetadata.time;
    let firstLat = null, firstLon = null;

    updatedImages.forEach(img => {
      if (!detectedTime && img.metadata.time) detectedTime = img.metadata.time;
      if (firstLat === null && img.metadata.lat !== null) {
        firstLat = img.metadata.lat;
        firstLon = img.metadata.lon;
      }
    });

    if (!detectedTime) {
      detectedTime = new Date().toISOString().split('T')[0];
    }
    setGlobalMetadata(prev => ({ ...prev, time: detectedTime }));

    if (firstLat !== null && firstLon !== null && !globalMetadata.location) {
      try {
        const res = await fetch(`${API_BASE}/api/geocode?lat=${firstLat}&lon=${firstLon}`);
        if (res.ok) {
          const data = await res.json();
          if (data.address) {
            setGlobalMetadata(prev => ({ ...prev, location: data.address }));
          }
        }
      } catch (err) {
        console.error('Failed to geocode coordinates:', err);
      }
    }
  };

  const removeUploadedImage = (id, e) => {
    e.stopPropagation();
    const filtered = uploadedImages.filter(img => img.id !== id);
    setUploadedImages(filtered);
    setSelectedExportIds(prev => prev.filter(item => item !== id));
    
    if (activeIdx >= filtered.length) {
      setActiveIdx(Math.max(0, filtered.length - 1));
    }
  };

  // Synchronize EXIF parameters when active image changes
  useEffect(() => {
    if (uploadedImages.length > 0 && uploadedImages[activeIdx]) {
      const activeImg = uploadedImages[activeIdx];
      if (activeImg.exif) {
        setExifParams({
          make: activeImg.exif.make || 'FUJIFILM',
          model: activeImg.exif.model || 'X-T5',
          fNumber: activeImg.exif.fNumber || 'f/2.8',
          iso: activeImg.exif.iso || 'ISO 200',
          focal: activeImg.exif.focal || '35mm',
          shutter: activeImg.exif.shutter || '1/250s',
          date: activeImg.exif.date || new Date().toLocaleDateString('zh-CN').replace(/\//g, '.')
        });
      }
    }
  }, [activeIdx, uploadedImages]);

  // 2. Local drawing & erase canvases initialization
  useEffect(() => {
    if (uploadedImages.length > 0 && activeIdx < uploadedImages.length) {
      const activeImg = uploadedImages[activeIdx];

      // Draw Canvas Setup
      if (activeTab === 'draw' && drawingCanvasRef.current) {
        const canvas = drawingCanvasRef.current;
        const ctx = canvas.getContext('2d');
        drawingCtxRef.current = ctx;

        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width;
        canvas.height = rect.height;

        ctx.strokeStyle = brushColor;
        ctx.lineWidth = brushWidth;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        if (activeImg.drawings) {
          const img = new Image();
          img.onload = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          };
          img.src = activeImg.drawings;
        } else {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
      }

      // Erase Canvas Setup
      if (activeTab === 'erase' && eraseCanvasRef.current) {
        const canvas = eraseCanvasRef.current;
        const ctx = canvas.getContext('2d');
        eraseCtxRef.current = ctx;

        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width;
        canvas.height = rect.height;

        ctx.strokeStyle = 'rgba(255, 36, 66, 0.45)'; // Semi-transparent red erase highlighter
        ctx.lineWidth = eraseWidth;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        setHasEraseMarks(false);
      }
    }
  }, [activeIdx, uploadedImages.length, activeTab]);

  useEffect(() => {
    if (drawingCtxRef.current) {
      drawingCtxRef.current.strokeStyle = brushColor;
      drawingCtxRef.current.lineWidth = brushWidth;
    }
  }, [brushColor, brushWidth]);

  useEffect(() => {
    if (eraseCtxRef.current) {
      eraseCtxRef.current.lineWidth = eraseWidth;
    }
  }, [eraseWidth]);

  const saveCurrentDrawings = () => {
    if (!drawingCanvasRef.current || uploadedImages.length === 0 || activeIdx >= uploadedImages.length) return;
    const dataUrl = drawingCanvasRef.current.toDataURL();
    setUploadedImages(prev => prev.map((img, idx) => {
      if (idx === activeIdx) {
        return { ...img, drawings: dataUrl };
      }
      return img;
    }));
  };

  // Brush drawing events
  const startDrawing = (e) => {
    if (activeTab !== 'draw' || uploadedImages.length === 0) return;
    const canvas = drawingCanvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    drawingCtxRef.current.beginPath();
    drawingCtxRef.current.moveTo(x, y);
    setIsDrawing(true);
  };

  const draw = (e) => {
    if (!isDrawing || activeTab !== 'draw' || uploadedImages.length === 0) return;
    const canvas = drawingCanvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    drawingCtxRef.current.lineTo(x, y);
    drawingCtxRef.current.stroke();
  };

  const stopDrawing = () => {
    if (isDrawing) {
      setIsDrawing(false);
      saveCurrentDrawings();
    }
  };

  const clearDrawings = () => {
    const canvas = drawingCanvasRef.current;
    if (!canvas || !drawingCtxRef.current) return;
    drawingCtxRef.current.clearRect(0, 0, canvas.width, canvas.height);
    
    setUploadedImages(prev => prev.map((img, idx) => {
      if (idx === activeIdx) {
        return { ...img, drawings: null };
      }
      return img;
    }));
  };

  // Erase drawing events (Object Removal)
  const startErasing = (e) => {
    if (activeTab !== 'erase' || uploadedImages.length === 0) return;
    const canvas = eraseCanvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    eraseCtxRef.current.beginPath();
    eraseCtxRef.current.moveTo(x, y);
    setIsErasing(true);
    setHasEraseMarks(true);
  };

  const drawEraseMark = (e) => {
    if (!isErasing || activeTab !== 'erase' || uploadedImages.length === 0) return;
    const canvas = eraseCanvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    eraseCtxRef.current.lineTo(x, y);
    eraseCtxRef.current.stroke();
  };

  const stopErasing = () => {
    setIsErasing(false);
  };

  const clearEraseMarks = () => {
    const canvas = eraseCanvasRef.current;
    if (!canvas || !eraseCtxRef.current) return;
    eraseCtxRef.current.clearRect(0, 0, canvas.width, canvas.height);
    setHasEraseMarks(false);
  };

  // Touch Helpers for Mobile Devices
  const getTouchCoords = (e, canvas) => {
    if (!e.touches || e.touches.length === 0) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const touch = e.touches[0];
    return {
      x: touch.clientX - rect.left,
      y: touch.clientY - rect.top,
      clientX: touch.clientX,
      clientY: touch.clientY
    };
  };

  // Drawing Canvas Touch Handlers
  const handleTouchStartDrawing = (e) => {
    if (activeTab !== 'draw' || uploadedImages.length === 0) return;
    e.preventDefault();
    const canvas = drawingCanvasRef.current;
    if (!canvas) return;

    const coords = getTouchCoords(e, canvas);
    drawingCtxRef.current.beginPath();
    drawingCtxRef.current.moveTo(coords.x, coords.y);
    setIsDrawing(true);
  };

  const handleTouchMoveDrawing = (e) => {
    if (!isDrawing || activeTab !== 'draw' || uploadedImages.length === 0) return;
    e.preventDefault();
    const canvas = drawingCanvasRef.current;
    if (!canvas) return;

    const coords = getTouchCoords(e, canvas);
    drawingCtxRef.current.lineTo(coords.x, coords.y);
    drawingCtxRef.current.stroke();
  };

  const handleTouchEndDrawing = (e) => {
    e.preventDefault();
    stopDrawing();
  };

  // Erasing Canvas Touch Handlers
  const handleTouchStartErasing = (e) => {
    if (activeTab !== 'erase' || uploadedImages.length === 0) return;
    e.preventDefault();
    const canvas = eraseCanvasRef.current;
    if (!canvas) return;

    const coords = getTouchCoords(e, canvas);
    eraseCtxRef.current.beginPath();
    eraseCtxRef.current.moveTo(coords.x, coords.y);
    setIsErasing(true);
    setHasEraseMarks(true);
  };

  const handleTouchMoveErasing = (e) => {
    if (!isErasing || activeTab !== 'erase' || uploadedImages.length === 0) return;
    e.preventDefault();
    const canvas = eraseCanvasRef.current;
    if (!canvas) return;

    const coords = getTouchCoords(e, canvas);
    eraseCtxRef.current.lineTo(coords.x, coords.y);
    eraseCtxRef.current.stroke();
  };

  const handleTouchEndErasing = (e) => {
    e.preventDefault();
    stopErasing();
  };

  // Panning Touch Handlers
  const handleTouchStartPanning = (e) => {
    if (!editorImageContainerRef.current) return;
    e.preventDefault();
    const touch = e.touches[0];
    setIsPanning(true);
    setPanStart({ x: touch.clientX - panOffset.x, y: touch.clientY - panOffset.y });
  };

  const handleTouchMovePanning = (e) => {
    const activeImage = uploadedImages[activeIdx];
    if (!isPanning || !activeImage || !editorImageContainerRef.current) return;
    e.preventDefault();
    
    const touch = e.touches[0];
    const rect = editorImageContainerRef.current.getBoundingClientRect();
    const W_c = rect.width;
    const H_c = rect.height;

    // Get image dimensions from target
    const imgElement = e.target;
    const W = imgElement.naturalWidth;
    const H = imgElement.naturalHeight;

    let W_r = W_c;
    let H_r = H_c;
    if (W / H > W_c / H_c) {
      H_r = H_c;
      W_r = H_c * (W / H);
    } else {
      W_r = W_c;
      H_r = W_c * (H / W);
    }

    const W_v = W_r * panZoom;
    const H_v = H_r * panZoom;

    // Calculate maximum drag values
    const maxDx = W_v > W_c ? (W_v - W_c) / 2 : 0;
    const maxDy = H_v > H_c ? (H_v - H_c) / 2 : 0;

    // Calculate new raw drag offsets
    let newX = touch.clientX - panStart.x;
    let newY = touch.clientY - panStart.y;

    // Constrain within boundaries so no black background is visible
    newX = Math.max(-maxDx, Math.min(maxDx, newX));
    newY = Math.max(-maxDy, Math.min(maxDy, newY));

    setPanOffset({ x: newX, y: newY });
  };

  const handleTouchEndPanning = (e) => {
    e.preventDefault();
    stopPanning();
  };

  // 3. Stickers Operations
  const addSticker = (type) => {
    if (uploadedImages.length === 0) return;
    const newSticker = {
      id: `sticker-${Date.now()}`,
      type,
      x: 75, 
      y: 15,
      scale: 0.7, 
      rotation: 0,
      width: 70,
      height: 70,
      text: type === 'speech' ? '哇哦!' : ''
    };
    setUploadedImages(prev => prev.map((img, idx) => {
      if (idx === activeIdx) {
        return { ...img, stickers: [...img.stickers, newSticker] };
      }
      return img;
    }));
    setSelectedStickerId(newSticker.id);
    setSelectedTextId(null);
    setActiveTab('sticker');
  };

  // 4. Handwritten Text Operations
  const addHandwrittenText = (content) => {
    if (uploadedImages.length === 0 || !content.trim()) return;
    const newText = {
      id: `text-${Date.now()}`,
      content: content.trim(),
      x: 50,
      y: 80,
      scale: 1.3,
      rotation: -6,
      color: customTextColor
    };
    setUploadedImages(prev => prev.map((img, idx) => {
      if (idx === activeIdx) {
        return { ...img, texts: [...(img.texts || []), newText] };
      }
      return img;
    }));
    setSelectedTextId(newText.id);
    setSelectedStickerId(null);
    setCustomTextContent('');
  };

  // Tag mouse handlers
  const handleTagMouseDown = (e, tagObj) => {
    if (activeTab !== 'sticker') return;
    e.stopPropagation();
    setSelectedTagId(tagObj.id);
    setSelectedStickerId(null);
    setSelectedTextId(null);

    tagDragRef.current = {
      id: tagObj.id,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: tagObj.x,
      startTop: tagObj.y
    };
  };

  const handleTagTouchStart = (e, tagObj) => {
    if (activeTab !== 'sticker') return;
    if (!e.touches || e.touches.length === 0) return;
    e.stopPropagation();
    setSelectedTagId(tagObj.id);
    setSelectedStickerId(null);
    setSelectedTextId(null);

    const touch = e.touches[0];
    tagDragRef.current = {
      id: tagObj.id,
      startX: touch.clientX,
      startY: touch.clientY,
      startLeft: tagObj.x,
      startTop: tagObj.y
    };
  };

  const addDotTag = (text = '今日穿搭 ✨') => {
    if (uploadedImages.length === 0 || !activeImage) return;
    const newTag = {
      id: 'tag-' + Date.now(),
      x: 50,
      y: 50,
      text: text,
      direction: 'right'
    };
    setUploadedImages(prev => prev.map((img, idx) => {
      if (idx === activeIdx) {
        return {
          ...img,
          tags: [...(img.tags || []), newTag]
        };
      }
      return img;
    }));
    setSelectedTagId(newTag.id);
    setCustomTagText('');
  };

  const deleteDotTag = (tagId, e) => {
    if (e) e.stopPropagation();
    setUploadedImages(prev => prev.map((img, idx) => {
      if (idx === activeIdx) {
        return {
          ...img,
          tags: (img.tags || []).filter(t => t.id !== tagId)
        };
      }
      return img;
    }));
    if (selectedTagId === tagId) setSelectedTagId(null);
  };

  const toggleTagDirection = (tagId, e) => {
    if (e) e.stopPropagation();
    setUploadedImages(prev => prev.map((img, idx) => {
      if (idx === activeIdx) {
        return {
          ...img,
          tags: (img.tags || []).map(t => t.id === tagId ? { ...t, direction: t.direction === 'right' ? 'left' : 'right' } : t)
        };
      }
      return img;
    }));
  };

  const updateTagText = (tagId, newText) => {
    setUploadedImages(prev => prev.map((img, idx) => {
      if (idx === activeIdx) {
        return {
          ...img,
          tags: (img.tags || []).map(t => t.id === tagId ? { ...t, text: newText } : t)
        };
      }
      return img;
    }));
  };

  // Sticker mouse handlers
  const handleStickerMouseDown = (e, sticker) => {
    if (activeTab !== 'sticker') return;
    e.stopPropagation();
    setSelectedStickerId(sticker.id);
    setSelectedTextId(null);

    stickerDragRef.current = {
      id: sticker.id,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: sticker.x,
      startTop: sticker.y
    };
  };

  const handleRotateScaleMouseDown = (e, sticker) => {
    if (activeTab !== 'sticker') return;
    e.stopPropagation();
    e.preventDefault();

    const element = document.getElementById(`sticker-${sticker.id}`);
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    stickerRotateScaleRef.current = {
      id: sticker.id,
      centerX,
      centerY,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startAngle: sticker.rotation,
      startScale: sticker.scale
    };
  };

  // Text mouse handlers
  const handleTextMouseDown = (e, textObj) => {
    if (activeTab !== 'text') return;
    e.stopPropagation();
    setSelectedTextId(textObj.id);
    setSelectedStickerId(null);

    textDragRef.current = {
      id: textObj.id,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: textObj.x,
      startTop: textObj.y
    };
  };

  const handleTextRotateScaleMouseDown = (e, textObj) => {
    if (activeTab !== 'text') return;
    e.stopPropagation();
    e.preventDefault();

    const element = document.getElementById(`text-${textObj.id}`);
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    textRotateScaleRef.current = {
      id: textObj.id,
      centerX,
      centerY,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startAngle: textObj.rotation,
      startScale: textObj.scale
    };
  };

  // Sticker touch start handlers
  const handleStickerTouchStart = (e, sticker) => {
    if (activeTab !== 'sticker') return;
    if (!e.touches || e.touches.length === 0) return;
    e.stopPropagation();
    setSelectedStickerId(sticker.id);
    setSelectedTextId(null);

    const touch = e.touches[0];
    stickerDragRef.current = {
      id: sticker.id,
      startX: touch.clientX,
      startY: touch.clientY,
      startLeft: sticker.x,
      startTop: sticker.y
    };
  };

  const handleRotateScaleTouchStart = (e, sticker) => {
    if (activeTab !== 'sticker') return;
    if (!e.touches || e.touches.length === 0) return;
    e.stopPropagation();
    e.preventDefault();

    const element = document.getElementById(`sticker-${sticker.id}`);
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const touch = e.touches[0];
    stickerRotateScaleRef.current = {
      id: sticker.id,
      centerX,
      centerY,
      startMouseX: touch.clientX,
      startMouseY: touch.clientY,
      startAngle: sticker.rotation,
      startScale: sticker.scale
    };
  };

  // Text touch start handlers
  const handleTextTouchStart = (e, textObj) => {
    if (activeTab !== 'text') return;
    if (!e.touches || e.touches.length === 0) return;
    e.stopPropagation();
    setSelectedTextId(textObj.id);
    setSelectedStickerId(null);

    const touch = e.touches[0];
    textDragRef.current = {
      id: textObj.id,
      startX: touch.clientX,
      startY: touch.clientY,
      startLeft: textObj.x,
      startTop: textObj.y
    };
  };

  const handleTextRotateScaleTouchStart = (e, textObj) => {
    if (activeTab !== 'text') return;
    if (!e.touches || e.touches.length === 0) return;
    e.stopPropagation();
    e.preventDefault();

    const element = document.getElementById(`text-${textObj.id}`);
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const touch = e.touches[0];
    textRotateScaleRef.current = {
      id: textObj.id,
      centerX,
      centerY,
      startMouseX: touch.clientX,
      startMouseY: touch.clientY,
      startAngle: textObj.rotation,
      startScale: textObj.scale
    };
  };

  // Global mouse/touch move listeners
  useEffect(() => {
    const handleMove = (clientX, clientY) => {
      const container = document.querySelector('.annotation-wrapper');
      if (!container) return;
      const cRect = container.getBoundingClientRect();

      if (stickerDragRef.current) {
        const { id, startX, startY, startLeft, startTop } = stickerDragRef.current;
        const dx = clientX - startX;
        const dy = clientY - startY;
        const px = (dx / cRect.width) * 100;
        const py = (dy / cRect.height) * 100;

        setUploadedImages(prev => prev.map((img, idx) => {
          if (idx === activeIdx) {
            return {
              ...img,
              stickers: img.stickers.map(s => s.id === id ? { ...s, x: startLeft + px, y: startTop + py } : s)
            };
          }
          return img;
        }));
      }

      if (stickerRotateScaleRef.current) {
        const { id, centerX, centerY, startMouseX, startMouseY, startAngle, startScale } = stickerRotateScaleRef.current;
        const startDx = startMouseX - centerX;
        const startDy = startMouseY - centerY;
        const startDist = Math.sqrt(startDx * startDx + startDy * startDy);
        const startRad = Math.atan2(startDy, startDx);

        const dx = clientX - centerX;
        const dy = clientY - centerY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const rad = Math.atan2(dy, dx);
        const angleDiff = (rad - startRad) * (180 / Math.PI);
        const scaleFactor = dist / startDist;

        setUploadedImages(prev => prev.map((img, idx) => {
          if (idx === activeIdx) {
            return {
              ...img,
              stickers: img.stickers.map(s => s.id === id ? {
                ...s,
                rotation: startAngle + angleDiff,
                scale: Math.max(0.2, Math.min(2.5, startScale * scaleFactor))
              } : s)
            };
          }
          return img;
        }));
      }

      if (textDragRef.current) {
        const { id, startX, startY, startLeft, startTop } = textDragRef.current;
        const dx = clientX - startX;
        const dy = clientY - startY;
        const px = (dx / cRect.width) * 100;
        const py = (dy / cRect.height) * 100;

        setUploadedImages(prev => prev.map((img, idx) => {
          if (idx === activeIdx) {
            return {
              ...img,
              texts: (img.texts || []).map(t => t.id === id ? { ...t, x: startLeft + px, y: startTop + py } : t)
            };
          }
          return img;
        }));
      }

      if (textRotateScaleRef.current) {
        const { id, centerX, centerY, startMouseX, startMouseY, startAngle, startScale } = textRotateScaleRef.current;
        const startDx = startMouseX - centerX;
        const startDy = startMouseY - centerY;
        const startDist = Math.sqrt(startDx * startDx + startDy * startDy);
        const startRad = Math.atan2(startDy, startDx);

        const dx = clientX - centerX;
        const dy = clientY - centerY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const rad = Math.atan2(dy, dx);
        const angleDiff = (rad - startRad) * (180 / Math.PI);
        const scaleFactor = dist / startDist;

        setUploadedImages(prev => prev.map((img, idx) => {
          if (idx === activeIdx) {
            return {
              ...img,
              texts: (img.texts || []).map(t => t.id === id ? {
                ...t,
                rotation: startAngle + angleDiff,
                scale: Math.max(0.5, Math.min(3, startScale * scaleFactor))
              } : t)
            };
          }
          return img;
        }));
      }

      if (tagDragRef.current) {
        const { id, startX, startY, startLeft, startTop } = tagDragRef.current;
        const dx = clientX - startX;
        const dy = clientY - startY;
        const px = (dx / cRect.width) * 100;
        const py = (dy / cRect.height) * 100;

        setUploadedImages(prev => prev.map((img, idx) => {
          if (idx === activeIdx) {
            return {
              ...img,
              tags: (img.tags || []).map(t => t.id === id ? { ...t, x: Math.max(0, Math.min(100, startLeft + px)), y: Math.max(0, Math.min(100, startTop + py)) } : t)
            };
          }
          return img;
        }));
      }
    };

    const handleMouseMove = (e) => {
      handleMove(e.clientX, e.clientY);
    };

    const handleTouchMove = (e) => {
      if (e.touches && e.touches.length > 0) {
        if (stickerDragRef.current || stickerRotateScaleRef.current || textDragRef.current || textRotateScaleRef.current || tagDragRef.current) {
          e.preventDefault();
        }
        handleMove(e.touches[0].clientX, e.touches[0].clientY);
      }
    };

    const handleEnd = () => {
      stickerDragRef.current = null;
      stickerRotateScaleRef.current = null;
      textDragRef.current = null;
      textRotateScaleRef.current = null;
      tagDragRef.current = null;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleEnd);
    window.addEventListener('touchmove', handleTouchMove, { passive: false });
    window.addEventListener('touchend', handleEnd);
    
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleEnd);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleEnd);
    };
  }, [activeIdx]);

  const deleteSticker = (id, e) => {
    e.stopPropagation();
    setUploadedImages(prev => prev.map((img, idx) => {
      if (idx === activeIdx) {
        return { ...img, stickers: img.stickers.filter(s => s.id !== id) };
      }
      return img;
    }));
    if (selectedStickerId === id) {
      setSelectedStickerId(null);
    }
  };

  const updateStickerText = (id, text) => {
    setUploadedImages(prev => prev.map((img, idx) => {
      if (idx === activeIdx) {
        return {
          ...img,
          stickers: img.stickers.map(s => s.id === id ? { ...s, text } : s)
        };
      }
      return img;
    }));
  };

  const deleteText = (id, e) => {
    e.stopPropagation();
    setUploadedImages(prev => prev.map((img, idx) => {
      if (idx === activeIdx) {
        return { ...img, texts: (img.texts || []).filter(t => t.id !== id) };
      }
      return img;
    }));
    if (selectedTextId === id) {
      setSelectedTextId(null);
    }
  };

  const updateTextContent = (id, content) => {
    setUploadedImages(prev => prev.map((img, idx) => {
      if (idx === activeIdx) {
        return {
          ...img,
          texts: (img.texts || []).map(t => t.id === id ? { ...t, content } : t)
        };
      }
      return img;
    }));
  };

  const updateTextColor = (id, color) => {
    setUploadedImages(prev => prev.map((img, idx) => {
      if (idx === activeIdx) {
        return {
          ...img,
          texts: (img.texts || []).map(t => t.id === id ? { ...t, color } : t)
        };
      }
      return img;
    }));
  };

  // 6. Call Backend to Generate AI layouts, crops, stickers, and texts
  const handleAIGeneration = async () => {
    if (uploadedImages.length === 0) {
      setErrorMsg('请先上传至少一张日常照片！');
      return;
    }

    setIsLoading(true);
    setAiOperationName('大模型分析并设计排版');
    setErrorMsg('');
    saveCurrentDrawings();

    try {
      // Compress/downscale original image files for the layout analyzer to save massive upload bandwidth
      const formData = new FormData();
      const compressedBlobs = await Promise.all(
        uploadedImages.map(img => compressImageForAnalysis(img.file))
      );
      compressedBlobs.forEach((blob, idx) => {
        formData.append('images', blob, `image-${idx}.jpg`);
      });
      formData.append('metadata', JSON.stringify(globalMetadata));

      const res = await fetch(`${API_BASE}/api/generate`, {
        method: 'POST',
        body: formData
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'AI 排版与文案生成失败');
      }

      const data = await res.json();
      
      setAiTitle(data.title || '日常小确幸 ✨');
      setAiBody(data.body || '');

      if (data.images_config && Array.isArray(data.images_config)) {
        // We will perform physical cropping for all images asynchronously
        const updatedImages = await Promise.all(
          uploadedImages.map(async (img, idx) => {
            const config = data.images_config.find(c => c.index === idx);
            if (config) {
              const cropBox = config.crop_box || { ymin: 0, xmin: 0, ymax: 100, xmax: 100 };
              
              // 1. Crop the image physically if NOT already edited/cartoonized by AI
              let croppedSrc = img.croppedSrc || img.src;
              if (!img.isAIEdited) {
                try {
                  croppedSrc = await cropImagePhysically(img.src, cropBox);
                } catch (cropErr) {
                  console.error('Physical cropping failed for index', idx, cropErr);
                }
              }

              // 2. Map AI generated stickers
              const mappedStickers = (config.stickers || []).map((s, sIdx) => ({
                id: `ai-sticker-${idx}-${sIdx}-${Date.now()}`,
                type: s.type,
                x: s.x ?? 75,
                y: s.y ?? 15,
                scale: s.scale ? Math.min(s.scale, 0.7) : 0.7, 
                rotation: s.rotation ?? 0,
                width: 70,
                height: 70,
                text: s.text || ''
              }));

              // 3. Map AI generated texts
              const mappedTexts = (config.texts || []).map((t, tIdx) => ({
                id: `ai-text-${idx}-${tIdx}-${Date.now()}`,
                content: t.content || '美好',
                x: t.x ?? 50,
                y: t.y ?? 85,
                scale: t.scale ?? 1.2,
                rotation: t.rotation ?? -5,
                color: t.color || '#ffffff'
              }));

              return {
                ...img,
                cropBox: img.isAIEdited ? img.cropBox : cropBox, // keep existing cropBox if edited
                croppedSrc, // Set physically cropped image URL
                stickers: mappedStickers,
                texts: mappedTexts
              };
            }
            return img;
          })
        );

        setUploadedImages(updatedImages);
      }

      setSelectedStickerId(null);
      setSelectedTextId(null);
      setActiveIdx(0);
      setActiveTab('text'); 

    } catch (err) {
      console.error(err);
      setErrorMsg(err.message || '生成文案及裁剪失败，请稍后重试。');
    } finally {
      setIsLoading(false);
      setAiOperationName('');
    }
  };

  // 7. AI Image Tool: Object Removal (Inpainting)
  const handleAIObjectRemoval = async () => {
    if (uploadedImages.length === 0 || !activeImage || !hasEraseMarks) return;
    
    setIsLoading(true);
    setAiOperationName('AI 消除杂物行人');
    setErrorMsg('');

    try {
      // 0. Compress the source image first if it's too large to prevent payload size errors
      const compressedImage = await resizeImageBase64(activeImage.croppedSrc, 1600, 0.85);

      // 1. Load the source image to get its actual pixel dimensions
      const sourceImg = new Image();
      sourceImg.crossOrigin = 'anonymous';
      await new Promise((resolve, reject) => {
        sourceImg.onload = resolve;
        sourceImg.onerror = reject;
        sourceImg.src = compressedImage;
      });
      const imgW = sourceImg.naturalWidth;
      const imgH = sourceImg.naturalHeight;

      // 2. Create a mask canvas at the SAME dimensions as the source image
      const eraseCanvas = eraseCanvasRef.current;
      const maskCanvas = document.createElement('canvas');
      maskCanvas.width = imgW;
      maskCanvas.height = imgH;
      
      const mCtx = maskCanvas.getContext('2d');
      // Start with all black (unmasked area)
      mCtx.fillStyle = '#000000';
      mCtx.fillRect(0, 0, imgW, imgH);
      
      // Scale the erase strokes from display size to actual image size
      const scaleX = imgW / eraseCanvas.width;
      const scaleY = imgH / eraseCanvas.height;
      mCtx.save();
      mCtx.scale(scaleX, scaleY);
      mCtx.drawImage(eraseCanvas, 0, 0);
      mCtx.restore();
      
      // Convert any non-black pixel (the red brush strokes) to solid white
      const imgData = mCtx.getImageData(0, 0, imgW, imgH);
      const data = imgData.data;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 0 && (data[i] > 0 || data[i + 1] > 0 || data[i + 2] > 0)) {
          data[i] = 255;     // R
          data[i + 1] = 255; // G
          data[i + 2] = 255; // B
          data[i + 3] = 255; // A
        } else {
          data[i] = 0;
          data[i + 1] = 0;
          data[i + 2] = 0;
          data[i + 3] = 255;
        }
      }
      mCtx.putImageData(imgData, 0, 0);
      
      const maskBase64 = maskCanvas.toDataURL('image/png');

      // 2. Call backend
      const res = await fetch(`${API_BASE}/api/ai/remove-objects`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          image: compressedImage,
          mask: maskBase64
        })
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'AI 局部重绘失败');
      }

      const result = await res.json();
      
      // 3. Update the base src and croppedSrc with cleaned image and reset crop parameters
      setUploadedImages(prev => prev.map((img, idx) => {
        if (idx === activeIdx) {
          return { 
            ...img, 
            src: result.image, 
            croppedSrc: result.image, 
            cropBox: { xmin: 0, ymin: 0, xmax: 100, ymax: 100 },
            isAIEdited: true 
          };
        }
        return img;
      }));

      // Reset panning offsets for the new base image
      setPanOffset({ x: 0, y: 0 });
      setPanZoom(1);

      // Clear erase marks
      clearEraseMarks();

    } catch (err) {
      console.error(err);
      setErrorMsg(err.message || 'AI 消除失败，请确保阿里云百炼通义万相接口可用。');
    } finally {
      setIsLoading(false);
      setAiOperationName('');
    }
  };

  // 8. AI Image Tool: Style Transfer (Ghibli, Claymation, Sketch)
  const handleAIStyleTransfer = async (styleName) => {
    if (uploadedImages.length === 0 || !activeImage) return;
    
    setIsLoading(true);
    const styleLabel = styleName === 'clay' ? '泥塑黏土化' : styleName === 'japanese-film' ? '日式胶片风' : '吉卜力卡通化';
    setAiOperationName(styleLabel);
    setErrorMsg('');

    try {
      // 0. Compress the image first if it's too large to prevent payload size errors
      const compressedImage = await resizeImageBase64(activeImage.croppedSrc, 1600, 0.85);

      const res = await fetch(`${API_BASE}/api/ai/style-transfer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          image: compressedImage,
          style: styleName
        })
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || '风格化重绘失败');
      }

      const result = await res.json();
      
      // Log which model was used
      const modelUsed = result.model || 'unknown';
      console.log(`[StyleTransfer] 使用引擎: ${modelUsed}`);
      
      // If DashScope fallback was used, show a subtle notice
      if (modelUsed === 'dashscope-wanx') {
        setErrorMsg('⚠️ 当前使用备用引擎（万相），画质可能不如 Seedream。请检查火山引擎配置。');
      }
      
      // Update base src and croppedSrc with the style-transferred version and reset crop parameters
      setUploadedImages(prev => prev.map((img, idx) => {
        if (idx === activeIdx) {
          return { 
            ...img, 
            src: result.image, 
            croppedSrc: result.image, 
            cropBox: { xmin: 0, ymin: 0, xmax: 100, ymax: 100 },
            isAIEdited: true 
          };
        }
        return img;
      }));

      // Reset panning offsets for the new styled base image
      setPanOffset({ x: 0, y: 0 });
      setPanZoom(1);

    } catch (err) {
      console.error(err);
      setErrorMsg(err.message || `AI 风格化（${styleLabel}）失败，请确保接口正常配置或可用。`);
    } finally {
      setIsLoading(false);
      setAiOperationName('');
    }
  };

  // AI Copywriting Generator (text-prompt based)
  const handleGenerateAICopy = async () => {
    const selectedStyle = copyStyle === '自定义' ? customCopyStyle.trim() : copyStyle;
    if (copyStyle === '自定义' && !selectedStyle) {
      setErrorMsg('请输入您自定义的文案风格，例如“数码测评”');
      return;
    }

    setIsGeneratingCopy(true);
    setErrorMsg('');

    try {
      const res = await fetch(`${API_BASE}/api/ai/generate-copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          style: selectedStyle,
          keywords: copyKeywords
        })
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || '文案生成失败');
      }

      const result = await res.json();
      if (result.options && result.options.length > 0) {
        setGeneratedCopyOptions(result.options);
        setActiveCopyOptionIdx(0);
        
        // Auto apply the first option to the poster text areas
        setAiTitle(result.options[0].title);
        setAiBody(`${result.options[0].body}\n\n${result.options[0].tags}`);
      } else {
        throw new Error('未返回有效的文案选项');
      }
    } catch (err) {
      console.error('AICopy error:', err);
      setErrorMsg(err.message || 'AI 文案生成失败，请检查火山引擎接口可用性。');
    } finally {
      setIsGeneratingCopy(false);
    }
  };

  const applyCopyOption = (idx) => {
    if (!generatedCopyOptions[idx]) return;
    setActiveCopyOptionIdx(idx);
    const opt = generatedCopyOptions[idx];
    setAiTitle(opt.title);
    setAiBody(`${opt.body}\n\n${opt.tags}`);
  };

  // AI Movie Subtitle Generator
  const handleGenerateMovieSubtitle = async (themeWord) => {
    setIsGeneratingSubtitle(true);
    setErrorMsg('');

    try {
      const res = await fetch(`${API_BASE}/api/ai/generate-subtitles`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          theme: themeWord || movieTheme
        })
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || '台词生成失败');
      }

      const result = await res.json();
      if (result.cn && result.en) {
        setMovieSubtitleCn(result.cn);
        setMovieSubtitleEn(result.en);
      } else {
        throw new Error('未返回有效的双语台词');
      }
    } catch (err) {
      console.error('Subtitle AI error:', err);
      setErrorMsg(err.message || 'AI 台词生成失败，请检查火山引擎 DeepSeek 接口可用性。');
    } finally {
      setIsGeneratingSubtitle(false);
    }
  };

  // AI Dot Tags Recommender
  const handleRecommendDotTags = async () => {
    if (uploadedImages.length === 0 || !activeImage) return;

    setIsGeneratingTags(true);
    setErrorMsg('');

    try {
      const res = await fetch(`${API_BASE}/api/ai/recommend-tags`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          image: activeImage.croppedSrc
        })
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || '推荐标签失败');
      }

      const result = await res.json();
      if (result.tags && result.tags.length > 0) {
        setUploadedImages(prev => prev.map((img, idx) => {
          if (idx === activeIdx) {
            const currentTags = img.tags || [];
            const mappedNewTags = result.tags.map((t, tIdx) => ({
              id: 'tag-ai-' + Date.now() + '-' + tIdx,
              x: t.x || 50,
              y: t.y || 50,
              text: t.text || '新标签',
              direction: t.direction || 'right'
            }));
            return {
              ...img,
              tags: [...currentTags, ...mappedNewTags]
            };
          }
          return img;
        }));
      } else {
        throw new Error('未返回有效的推荐标签');
      }
    } catch (err) {
      console.error('RecommendTags AI error:', err);
      setErrorMsg(err.message || 'AI 标签推荐失败，请检查火山引擎 Vision 接口可用性。');
    } finally {
      setIsGeneratingTags(false);
    }
  };

  // 9. Export Poster JPG
  const exportPosterJPG = async () => {
    if (!posterRef.current || uploadedImages.length === 0) return;
    
    setSelectedStickerId(null);
    setSelectedTextId(null);

    setTimeout(async () => {
      try {
        const canvas = await html2canvas(posterRef.current, {
          useCORS: true,
          scale: 3.5,
          allowTaint: true,
          backgroundColor: '#ffffff',
          logging: false
        });

        const imageURL = canvas.toDataURL('image/jpeg', 0.95);
        const link = document.createElement('a');
        link.download = `xiaohongshu-poster-${Date.now()}.jpg`;
        link.href = imageURL;
        link.click();
      } catch (err) {
        console.error('Failed to export poster image:', err);
        setErrorMsg('图片生成失败，请稍后重试。');
      }
    }, 150);
  };

  // 9.5 Export only the collage image (no text)
  const exportCollageImageOnly = async () => {
    if (!posterRef.current || uploadedImages.length === 0) return;
    
    const targetElement = posterRef.current.querySelector('.poster-image-area');
    if (!targetElement) return;

    setSelectedStickerId(null);
    setSelectedTextId(null);

    setTimeout(async () => {
      try {
        const canvas = await html2canvas(targetElement, {
          useCORS: true,
          scale: 3.5,
          allowTaint: true,
          backgroundColor: '#ffffff',
          logging: false
        });

        const imageURL = canvas.toDataURL('image/jpeg', 0.95);
        const link = document.createElement('a');
        link.download = `xiaohongshu-collage-${Date.now()}.jpg`;
        link.href = imageURL;
        link.click();
      } catch (err) {
        console.error('Failed to export collage image:', err);
        setErrorMsg('图片生成失败，请稍后重试。');
      }
    }, 150);
  };

  // 9.6 Toggle individual image selection for export
  const toggleExportSelection = (id, e) => {
    e.stopPropagation();
    setSelectedExportIds(prev => 
      prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]
    );
  };

  // 9.7 Export selected individual images sequentially
  const exportSelectedSingleImages = async () => {
    if (selectedExportIds.length === 0) {
      alert('请先勾选需要导出的单张图片！');
      return;
    }

    // Save current drawings before starting export
    saveCurrentDrawings();

    setSelectedStickerId(null);
    setSelectedTextId(null);

    setIsLoading(true);
    setAiOperationName('正在批量导出图片');

    try {
      const originalActiveIdx = activeIdx;
      const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
      const newExportedUrls = [];

      for (let i = 0; i < uploadedImages.length; i++) {
        const img = uploadedImages[i];
        if (!selectedExportIds.includes(img.id)) continue;

        // Switch active index to render this image in the workspace editor
        setActiveIdx(i);
        // Wait for React to update and render the DOM
        await new Promise(resolve => setTimeout(resolve, 300));

        // Get the workspace wrapper containing the active image and frame
        const workspaceElement = document.querySelector('.editor-canvas-container .grid-cell-frame-wrapper');
        if (!workspaceElement) continue;

        const editorWidth = workspaceElement.offsetWidth || 400;
        const targetWidth = 1600;
        const scaleRatio = targetWidth / editorWidth;

        // Clone the element
        const clone = workspaceElement.cloneNode(true);
        
        // Style the clone to have explicit size and be offscreen
        clone.style.position = 'fixed';
        clone.style.top = '-9999px';
        clone.style.left = '-9999px';
        clone.style.width = `${targetWidth}px`;
        clone.style.height = 'auto';
        clone.style.display = 'flex';
        clone.style.flexDirection = 'column';
        clone.style.boxShadow = 'none';

        // Scale EXIF frame paddings
        if (selectedFrame === 'leica-white' || selectedFrame === 'leica-black') {
          clone.style.setProperty('padding', `${10 * scaleRatio}px ${10 * scaleRatio}px ${38 * scaleRatio}px ${10 * scaleRatio}px`, 'important');
        } else if (selectedFrame === 'hasselblad') {
          clone.style.setProperty('padding', `${12 * scaleRatio}px ${12 * scaleRatio}px ${42 * scaleRatio}px ${12 * scaleRatio}px`, 'important');
        } else if (selectedFrame === 'polaroid') {
          clone.style.setProperty('padding', `${10 * scaleRatio}px ${10 * scaleRatio}px ${42 * scaleRatio}px ${10 * scaleRatio}px`, 'important');
        } else if (selectedFrame === 'film-roll') {
          clone.style.setProperty('padding', `${15 * scaleRatio}px ${38 * scaleRatio}px`, 'important');
        }

        // Adjust stickers inside the clone
        const stickers = clone.querySelectorAll('.sticker-item');
        stickers.forEach(s => {
          s.classList.remove('selected');
          const deleteBtn = s.querySelector('.sticker-delete-btn');
          if (deleteBtn) deleteBtn.remove();
          const rotateBtn = s.querySelector('.sticker-rotate-btn');
          if (rotateBtn) rotateBtn.remove();
          const editBtn = s.querySelector('.sticker-edit-btn');
          if (editBtn) editBtn.remove();

          const origWidth = parseFloat(s.style.width) || 70;
          const origHeight = parseFloat(s.style.height) || 70;
          s.style.width = `${origWidth * scaleRatio}px`;
          s.style.height = `${origHeight * scaleRatio}px`;

          const speechText = s.querySelector('div');
          if (speechText) {
            const origFontSize = parseFloat(speechText.style.fontSize) || 12;
            speechText.style.setProperty('font-size', `${origFontSize * scaleRatio}px`, 'important');
          }
        });

        // Adjust handwritten texts inside the clone
        const texts = clone.querySelectorAll('.handwritten-text-item');
        texts.forEach(t => {
          t.classList.remove('selected');
          const deleteBtn = t.querySelector('.text-delete-btn');
          if (deleteBtn) deleteBtn.remove();
          const rotateBtn = t.querySelector('.text-rotate-btn');
          if (rotateBtn) rotateBtn.remove();

          const origFontSize = parseFloat(t.style.fontSize) || 20;
          t.style.fontSize = `${origFontSize * scaleRatio}px`;
        });

        // Adjust EXIF bar height and font size inside the clone
        const exifBar = clone.querySelector('.exif-frame-bar');
        if (exifBar) {
          exifBar.style.setProperty('height', `${34 * scaleRatio}px`, 'important');
          exifBar.style.setProperty('font-size', `${8 * scaleRatio}px`, 'important');
          exifBar.style.setProperty('padding', `0 ${12 * scaleRatio}px`, 'important');
          

          const dateText = exifBar.querySelector('.exif-date-sub');
          if (dateText) {
            dateText.style.setProperty('font-size', `${6 * scaleRatio}px`, 'important');
          }
          const leftParams = exifBar.querySelector('.exif-left-params');
          if (leftParams) {
            leftParams.style.setProperty('gap', `${6 * scaleRatio}px`, 'important');
          }
          const redDot = exifBar.querySelector('.leica-red-dot');
          if (redDot) {
            redDot.style.setProperty('font-size', `${7 * scaleRatio}px`, 'important');
            redDot.style.setProperty('padding', `${1 * scaleRatio}px ${3 * scaleRatio}px`, 'important');
            redDot.style.setProperty('border-radius', `${2 * scaleRatio}px`, 'important');
            redDot.style.setProperty('height', `${14 * scaleRatio}px`, 'important');
            redDot.style.setProperty('line-height', `${12 * scaleRatio}px`, 'important');
          }
          const hassLogo = exifBar.querySelector('.hasselblad-logo-text');
          if (hassLogo) {
            hassLogo.style.setProperty('font-size', `${6 * scaleRatio}px`, 'important');
            hassLogo.style.setProperty('letter-spacing', `${1 * scaleRatio}px`, 'important');
          }
        }

        // Adjust Film Roll sprockets inside the clone
        const filmRollStripTop = clone.querySelector('.film-sprocket-strip.top');
        const filmRollStripBottom = clone.querySelector('.film-sprocket-strip.bottom');
        if (filmRollStripTop) {
          filmRollStripTop.style.setProperty('height', `${15 * scaleRatio}px`, 'important');
          filmRollStripTop.style.setProperty('padding', `0 ${10 * scaleRatio}px`, 'important');
          filmRollStripTop.querySelectorAll('.film-sprocket-hole').forEach(hole => {
            hole.style.setProperty('width', `${7 * scaleRatio}px`, 'important');
            hole.style.setProperty('height', `${10 * scaleRatio}px`, 'important');
            hole.style.setProperty('border-radius', `${1.5 * scaleRatio}px`, 'important');
          });
        }
        if (filmRollStripBottom) {
          filmRollStripBottom.style.setProperty('height', `${15 * scaleRatio}px`, 'important');
          filmRollStripBottom.style.setProperty('padding', `0 ${10 * scaleRatio}px`, 'important');
          filmRollStripBottom.querySelectorAll('.film-sprocket-hole').forEach(hole => {
            hole.style.setProperty('width', `${7 * scaleRatio}px`, 'important');
            hole.style.setProperty('height', `${10 * scaleRatio}px`, 'important');
            hole.style.setProperty('border-radius', `${1.5 * scaleRatio}px`, 'important');
          });
        }
        const filmMarkTextTop = clone.querySelector('.film-marking-text.top');
        if (filmMarkTextTop) {
          filmMarkTextTop.style.setProperty('font-size', `${9 * scaleRatio}px`, 'important');
          filmMarkTextTop.style.setProperty('height', `${15 * scaleRatio}px`, 'important');
          filmMarkTextTop.style.setProperty('padding', `0 ${20 * scaleRatio}px`, 'important');
        }
        const filmMarkTextBottom = clone.querySelector('.film-marking-text.bottom');
        if (filmMarkTextBottom) {
          filmMarkTextBottom.style.setProperty('font-size', `${9 * scaleRatio}px`, 'important');
          filmMarkTextBottom.style.setProperty('height', `${15 * scaleRatio}px`, 'important');
          filmMarkTextBottom.style.setProperty('padding', `0 ${20 * scaleRatio}px`, 'important');
          const barcode = filmMarkTextBottom.querySelector('.film-barcode-mark');
          if (barcode) {
            barcode.style.setProperty('font-size', `${10 * scaleRatio}px`, 'important');
            barcode.style.setProperty('letter-spacing', `${0.5 * scaleRatio}px`, 'important');
          }
        }

        // Adjust Location and Date Bar overlay inside the clone
        const metaBar = clone.querySelector('.poster-meta-bar');
        if (metaBar) {
          metaBar.style.setProperty('padding', `${8 * scaleRatio}px ${12 * scaleRatio}px`, 'important');
          metaBar.style.setProperty('font-size', `${9 * scaleRatio}px`, 'important');
        }

        // Append clone to body
        document.body.appendChild(clone);

        // Small delay to allow layout to settle
        await new Promise(resolve => setTimeout(resolve, 150));

        const bg = selectedFrame === 'leica-white' ? '#fff' : selectedFrame === 'leica-black' ? '#0c0c0c' : selectedFrame === 'hasselblad' ? '#121212' : selectedFrame === 'polaroid' ? '#fcfbf9' : 'transparent';

        const canvas = await html2canvas(clone, {
          useCORS: true,
          scale: 1, // Sized to 1600px width natively
          allowTaint: true,
          backgroundColor: bg === 'transparent' ? '#ffffff' : bg,
          logging: false
        });

        // Clean up
        document.body.removeChild(clone);

        const imageURL = canvas.toDataURL('image/jpeg', 0.95);
        if (isMobile) {
          newExportedUrls.push(imageURL);
        } else {
          const link = document.createElement('a');
          link.download = `xiaohongshu-photo-${i + 1}-${Date.now()}.jpg`;
          link.href = imageURL;
          link.click();
        }
      }

      // Restore original active photo index in editor
      setActiveIdx(originalActiveIdx);

      if (isMobile && newExportedUrls.length > 0) {
        setMobilePreviewImages(newExportedUrls);
      }
    } catch (err) {
      console.error('Failed to batch export images:', err);
      setErrorMsg('部分图片导出失败，请重试。');
    } finally {
      setIsLoading(false);
    }
  };

  const handleContextMenu = (e) => {
    if (activeTab === 'draw' || activeTab === 'erase') return;
    e.preventDefault();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      visible: true
    });
  };

  const handleTouchStartLongPress = (e) => {
    if (activeTab === 'draw' || activeTab === 'erase') return;
    
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
    }
    
    const touch = e.touches[0];
    const startX = touch.clientX;
    const startY = touch.clientY;

    longPressTimerRef.current = setTimeout(() => {
      setContextMenu({
        x: startX,
        y: startY,
        visible: true
      });
    }, 600); // 600ms long press
  };

  const handleTouchMoveLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const handleTouchEndLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const downloadActiveImageHD = async () => {
    if (uploadedImages.length === 0 || !activeImage) return;

    saveCurrentDrawings();
    setSelectedStickerId(null);
    setSelectedTextId(null);

    setIsLoading(true);
    setAiOperationName('正在导出当前高清图片');

    try {
      const workspaceElement = document.querySelector('.editor-canvas-container .grid-cell-frame-wrapper');
      if (!workspaceElement) return;

      const editorWidth = workspaceElement.offsetWidth || 400;
      const targetWidth = 1600;
      const scaleRatio = targetWidth / editorWidth;

      const clone = workspaceElement.cloneNode(true);
      
      clone.style.position = 'fixed';
      clone.style.top = '-9999px';
      clone.style.left = '-9999px';
      clone.style.width = `${targetWidth}px`;
      clone.style.height = 'auto';
      clone.style.display = 'flex';
      clone.style.flexDirection = 'column';
      clone.style.boxShadow = 'none';

      if (selectedFrame === 'leica-white' || selectedFrame === 'leica-black') {
        clone.style.setProperty('padding', `${10 * scaleRatio}px ${10 * scaleRatio}px ${38 * scaleRatio}px ${10 * scaleRatio}px`, 'important');
      } else if (selectedFrame === 'hasselblad') {
        clone.style.setProperty('padding', `${12 * scaleRatio}px ${12 * scaleRatio}px ${42 * scaleRatio}px ${12 * scaleRatio}px`, 'important');
      } else if (selectedFrame === 'polaroid') {
        clone.style.setProperty('padding', `${10 * scaleRatio}px ${10 * scaleRatio}px ${42 * scaleRatio}px ${10 * scaleRatio}px`, 'important');
      } else if (selectedFrame === 'film-roll') {
        clone.style.setProperty('padding', `${15 * scaleRatio}px ${38 * scaleRatio}px`, 'important');
      }

      const stickers = clone.querySelectorAll('.sticker-item');
      stickers.forEach(s => {
        s.classList.remove('selected');
        const deleteBtn = s.querySelector('.sticker-delete-btn');
        if (deleteBtn) deleteBtn.remove();
        const rotateBtn = s.querySelector('.sticker-rotate-btn');
        if (rotateBtn) rotateBtn.remove();
        const editBtn = s.querySelector('.sticker-edit-btn');
        if (editBtn) editBtn.remove();

        const origWidth = parseFloat(s.style.width) || 70;
        const origHeight = parseFloat(s.style.height) || 70;
        s.style.width = `${origWidth * scaleRatio}px`;
        s.style.height = `${origHeight * scaleRatio}px`;

        const speechText = s.querySelector('div');
        if (speechText) {
          const origFontSize = parseFloat(speechText.style.fontSize) || 12;
          speechText.style.setProperty('font-size', `${origFontSize * scaleRatio}px`, 'important');
        }
      });

      const texts = clone.querySelectorAll('.handwritten-text-item');
      texts.forEach(t => {
        t.classList.remove('selected');
        const deleteBtn = t.querySelector('.text-delete-btn');
        if (deleteBtn) deleteBtn.remove();
        const rotateBtn = t.querySelector('.text-rotate-btn');
        if (rotateBtn) rotateBtn.remove();

        const origFontSize = parseFloat(t.style.fontSize) || 20;
        t.style.fontSize = `${origFontSize * scaleRatio}px`;
      });

      const exifBar = clone.querySelector('.exif-frame-bar');
      if (exifBar) {
        exifBar.style.setProperty('height', `${34 * scaleRatio}px`, 'important');
        exifBar.style.setProperty('font-size', `${8 * scaleRatio}px`, 'important');
        exifBar.style.setProperty('padding', `0 ${12 * scaleRatio}px`, 'important');
        
        const dateText = exifBar.querySelector('.exif-date-sub');
        if (dateText) {
          dateText.style.setProperty('font-size', `${6 * scaleRatio}px`, 'important');
        }
        const leftParams = exifBar.querySelector('.exif-left-params');
        if (leftParams) {
          leftParams.style.setProperty('gap', `${6 * scaleRatio}px`, 'important');
        }
        const redDot = exifBar.querySelector('.leica-red-dot');
        if (redDot) {
          redDot.style.setProperty('font-size', `${7 * scaleRatio}px`, 'important');
          redDot.style.setProperty('padding', `${1 * scaleRatio}px ${3 * scaleRatio}px`, 'important');
          redDot.style.setProperty('border-radius', `${2 * scaleRatio}px`, 'important');
          redDot.style.setProperty('height', `${14 * scaleRatio}px`, 'important');
          redDot.style.setProperty('line-height', `${12 * scaleRatio}px`, 'important');
        }
        const hassLogo = exifBar.querySelector('.hasselblad-logo-text');
        if (hassLogo) {
          hassLogo.style.setProperty('font-size', `${6 * scaleRatio}px`, 'important');
          hassLogo.style.setProperty('letter-spacing', `${1 * scaleRatio}px`, 'important');
        }
      }

      const filmRollStripTop = clone.querySelector('.film-sprocket-strip.top');
      const filmRollStripBottom = clone.querySelector('.film-sprocket-strip.bottom');
      if (filmRollStripTop) {
        filmRollStripTop.style.setProperty('height', `${15 * scaleRatio}px`, 'important');
        filmRollStripTop.style.setProperty('padding', `0 ${10 * scaleRatio}px`, 'important');
        filmRollStripTop.querySelectorAll('.film-sprocket-hole').forEach(hole => {
          hole.style.setProperty('width', `${7 * scaleRatio}px`, 'important');
          hole.style.setProperty('height', `${10 * scaleRatio}px`, 'important');
          hole.style.setProperty('border-radius', `${1.5 * scaleRatio}px`, 'important');
        });
      }
      if (filmRollStripBottom) {
        filmRollStripBottom.style.setProperty('height', `${15 * scaleRatio}px`, 'important');
        filmRollStripBottom.style.setProperty('padding', `0 ${10 * scaleRatio}px`, 'important');
        filmRollStripBottom.querySelectorAll('.film-sprocket-hole').forEach(hole => {
          hole.style.setProperty('width', `${7 * scaleRatio}px`, 'important');
          hole.style.setProperty('height', `${10 * scaleRatio}px`, 'important');
          hole.style.setProperty('border-radius', `${1.5 * scaleRatio}px`, 'important');
        });
      }
      const filmMarkTextTop = clone.querySelector('.film-marking-text.top');
      if (filmMarkTextTop) {
        filmMarkTextTop.style.setProperty('font-size', `${9 * scaleRatio}px`, 'important');
        filmMarkTextTop.style.setProperty('height', `${15 * scaleRatio}px`, 'important');
        filmMarkTextTop.style.setProperty('padding', `0 ${20 * scaleRatio}px`, 'important');
      }
      const filmMarkTextBottom = clone.querySelector('.film-marking-text.bottom');
      if (filmMarkTextBottom) {
        filmMarkTextBottom.style.setProperty('font-size', `${9 * scaleRatio}px`, 'important');
        filmMarkTextBottom.style.setProperty('height', `${15 * scaleRatio}px`, 'important');
        filmMarkTextBottom.style.setProperty('padding', `0 ${20 * scaleRatio}px`, 'important');
        const barcode = filmMarkTextBottom.querySelector('.film-barcode-mark');
        if (barcode) {
          barcode.style.setProperty('font-size', `${10 * scaleRatio}px`, 'important');
          barcode.style.setProperty('letter-spacing', `${0.5 * scaleRatio}px`, 'important');
        }
      }

      const metaBar = clone.querySelector('.poster-meta-bar');
      if (metaBar) {
        metaBar.style.setProperty('padding', `${8 * scaleRatio}px ${12 * scaleRatio}px`, 'important');
        metaBar.style.setProperty('font-size', `${9 * scaleRatio}px`, 'important');
      }

      document.body.appendChild(clone);
      await new Promise(resolve => setTimeout(resolve, 150));

      const bg = selectedFrame === 'leica-white' ? '#fff' : selectedFrame === 'leica-black' ? '#0c0c0c' : selectedFrame === 'hasselblad' ? '#121212' : selectedFrame === 'polaroid' ? '#fcfbf9' : 'transparent';

      const canvas = await html2canvas(clone, {
        useCORS: true,
        scale: 1,
        allowTaint: true,
        backgroundColor: bg === 'transparent' ? '#ffffff' : bg,
        logging: false
      });

      document.body.removeChild(clone);

      const imageURL = canvas.toDataURL('image/jpeg', 0.95);
      const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
      if (isMobile) {
        setMobilePreviewImages([imageURL]);
      } else {
        const link = document.createElement('a');
        link.download = `xiaohongshu-photo-${activeIdx + 1}-${Date.now()}.jpg`;
        link.href = imageURL;
        link.click();
      }
    } catch (err) {
      console.error('Failed to export active image:', err);
      setErrorMsg('导出高清图片失败，请重试。');
    } finally {
      setIsLoading(false);
    }
  };

  const activeImage = uploadedImages[activeIdx];

  return (
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <div className="logo-section">
          <div className="logo-badge">书</div>
          <div className="logo-text">
            <h1>小红书智能拼图海报生成器</h1>
            <p>防变形物理剪裁 · AI消除行人/杂物 · AI一键吉卜力卡通化</p>
          </div>
        </div>
        
        <div className="app-actions" style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <a 
            href="https://vanpower.net" 
            className="btn btn-secondary" 
            style={{ 
              display: 'inline-flex', 
              alignItems: 'center', 
              textDecoration: 'none', 
              fontWeight: 600,
              fontSize: '0.9rem',
              padding: '0.6rem 1rem',
              backgroundColor: '#f3f4f6',
              border: '1px solid #d1d5db',
              borderRadius: 'var(--radius-sm)',
              color: '#374151'
            }}
          >
            🏠 返回主页
          </a>
          {uploadedImages.length > 0 && (
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button 
                className="btn btn-primary" 
                style={{ background: 'linear-gradient(135deg, #ff2442, #ff4d66)', color: 'white', border: 'none', display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontWeight: '600' }} 
                onClick={exportSelectedSingleImages}
              >
                ⚡ 批量导出已选单图 ({selectedExportIds.length})
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Loading Overlay */}
      {isLoading && (
        <div className="loading-overlay" style={{ position: 'fixed', width: '100vw', height: '100vh', top: 0, left: 0, zIndex: 1000 }}>
          <div className="spinner"></div>
          <div className="loading-text" style={{ fontSize: '1.2rem', fontWeight: 600 }}>{aiOperationName}中... 请稍候...</div>
        </div>
      )}

      {/* Main Workspace */}
      <main className={`workspace ${uploadedImages.length > 0 ? 'has-images' : ''}`}>
        
        {/* Left editor side */}
        <section className="editor-panel">
          
          {errorMsg && (
            <div className="error-banner">
              <span>⚠️ {errorMsg}</span>
              <span className="error-close" onClick={() => setErrorMsg('')}>×</span>
            </div>
          )}

          {/* 1. Upload */}
          <div className="card">
            <h2 className="card-title">📸 第一步：上传拼图照片 (1-4张)</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {uploadedImages.length < 4 && (
                <div 
                  className="upload-zone"
                  onClick={() => fileInputRef.current?.click()}
                  style={{ padding: '1.5rem 1rem' }}
                >
                  <div className="upload-icon" style={{ fontSize: '2rem' }}>📤</div>
                  <p style={{ fontSize: '0.9rem' }}>添加 1-4 张图片 (支持多选，拼图绝不拉伸变形)</p>
                  <input 
                    type="file" 
                    ref={fileInputRef} 
                    style={{ display: 'none' }} 
                    accept="image/*"
                    multiple
                    onChange={handlePhotosUpload}
                  />
                </div>
              )}

              {/* Uploaded Thumbnails Manager */}
              {uploadedImages.length > 0 && (
                <div>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>点击选中某张照片，进行 AI 去除杂物/吉卜力动漫化/手绘文字；勾选左上角选择导出该单图：</p>
                  <div className="uploaded-images-list">
                    {uploadedImages.map((img, idx) => (
                      <div 
                        key={img.id}
                        className={`uploaded-image-thumbnail ${activeIdx === idx ? 'active' : ''}`}
                        onClick={() => {
                          saveCurrentDrawings();
                          setActiveIdx(idx);
                        }}
                      >
                        {/* Checkbox for single image export selection */}
                        <div 
                          className={`uploaded-image-checkbox ${selectedExportIds.includes(img.id) ? 'checked' : ''}`}
                          onClick={(e) => toggleExportSelection(img.id, e)}
                          style={{
                            position: 'absolute',
                            top: '4px',
                            left: '4px',
                            width: '16px',
                            height: '16px',
                            borderRadius: '4px',
                            backgroundColor: selectedExportIds.includes(img.id) ? '#ff2442' : 'rgba(0,0,0,0.5)',
                            border: '1.5px solid white',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: 'white',
                            fontSize: '10px',
                            fontWeight: 'bold',
                            zIndex: 10,
                            cursor: 'pointer',
                            transition: 'all 0.2s ease',
                            userSelect: 'none'
                          }}
                        >
                          {selectedExportIds.includes(img.id) ? '✓' : ''}
                        </div>

                        <img src={img.croppedSrc} alt={`Uploaded ${idx}`} />
                        <button 
                          className="uploaded-image-remove"
                          onClick={(e) => removeUploadedImage(img.id, e)}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                  
                  {/* Select Actions */}
                  <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
                    <button
                      className="btn"
                      style={{
                        flex: 1,
                        padding: '0.4rem 0.5rem',
                        fontSize: '0.75rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '0.25rem',
                        border: '1px solid var(--border-color)',
                        backgroundColor: 'var(--bg-main)',
                        color: 'var(--text-secondary)',
                        cursor: 'pointer',
                        borderRadius: 'var(--radius-sm)'
                      }}
                      onClick={() => setSelectedExportIds(uploadedImages.map(img => img.id))}
                      disabled={selectedExportIds.length === uploadedImages.length}
                    >
                      ☑️ 全选图片
                    </button>
                    <button
                      className="btn"
                      style={{
                        flex: 1,
                        padding: '0.4rem 0.5rem',
                        fontSize: '0.75rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '0.25rem',
                        border: '1px solid var(--border-color)',
                        backgroundColor: 'var(--bg-main)',
                        color: 'var(--text-secondary)',
                        cursor: 'pointer',
                        borderRadius: 'var(--radius-sm)'
                      }}
                      onClick={() => setSelectedExportIds([])}
                      disabled={selectedExportIds.length === 0}
                    >
                      ☐ 全清选择
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 2. Photo Fine-Tuning & Drawings/Stickers */}
          {uploadedImages.length > 0 && activeImage && (
            <div className="card">
              <div className="canvas-tabs">
                <button 
                  className={`canvas-tab-btn ${activeTab === 'style' ? 'active' : ''}`}
                  onClick={() => setActiveTab('style')}
                >
                  🎨 AI 画风
                </button>
                <button 
                  className={`canvas-tab-btn ${activeTab === 'frame' ? 'active' : ''}`}
                  onClick={() => setActiveTab('frame')}
                >
                  📷 经典画框
                </button>
                <button 
                  className={`canvas-tab-btn ${activeTab === 'erase' ? 'active' : ''}`}
                  onClick={() => setActiveTab('erase')}
                >
                  🪄 AI 消除
                </button>
                <button 
                  className={`canvas-tab-btn ${activeTab === 'sticker' ? 'active' : ''}`}
                  onClick={() => setActiveTab('sticker')}
                >
                  ✨ 贴纸标签
                </button>
                <button 
                  className={`canvas-tab-btn ${activeTab === 'text' ? 'active' : ''}`}
                  onClick={() => setActiveTab('text')}
                >
                  ✍️ 手写字
                </button>
                <button 
                  className={`canvas-tab-btn ${activeTab === 'ai-copy' ? 'active' : ''}`}
                  onClick={() => setActiveTab('ai-copy')}
                >
                  📝 AI文案
                </button>
              </div>

              {/* AI Filter / Style Transfer Tab */}
              {activeTab === 'style' && (
                <div>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
                    🎨 对选中的图 {activeIdx + 1} 进行 AI 艺术化风格重绘（高清 Seedream 5.0 引擎）：
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem', marginBottom: '0.5rem' }}>
                    <button 
                      className="btn btn-primary" 
                      style={{ padding: '0.6rem 0.25rem', fontSize: '0.8rem', background: 'linear-gradient(135deg, #4f46e5, #6366f1)', border: 'none' }}
                      onClick={() => handleAIStyleTransfer('cartoon')}
                    >
                      🎨 治愈吉卜力
                    </button>
                    <button 
                      className="btn btn-primary" 
                      style={{ padding: '0.6rem 0.25rem', fontSize: '0.8rem', background: 'linear-gradient(135deg, #ec4899, #d946ef)', border: 'none' }}
                      onClick={() => handleAIStyleTransfer('clay')}
                    >
                      🧸 软萌泥塑风
                    </button>
                    <button 
                      className="btn btn-primary" 
                      style={{ padding: '0.6rem 0.25rem', fontSize: '0.8rem', background: 'linear-gradient(135deg, #d97706, #92400e)', border: 'none' }}
                      onClick={() => handleAIStyleTransfer('japanese-film')}
                    >
                      🎞️ 日式胶片风
                    </button>
                  </div>
                </div>
              )}

              {/* Frame Tab (Camera Borders) */}
              {activeTab === 'frame' && (
                <div>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
                    选择一款高质感相机 EXIF 水印边框，照片参数支持手动修改：
                  </p>
                  
                  {/* Select Frame Type */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.4rem', marginBottom: '1rem' }}>
                    {[
                      { id: 'none', name: '🚫 无边框' },
                      { id: 'leica-white', name: '📸 徕卡白' },
                      { id: 'leica-black', name: '📸 徕卡黑' },
                      { id: 'hasselblad', name: '🌌 哈苏黑' },
                      { id: 'polaroid', name: '🎞️ 宝丽来' },
                      { id: 'film-roll', name: '🎞️ 胶卷底片' }
                    ].map(f => (
                      <button
                        key={f.id}
                        className={`btn ${selectedFrame === f.id ? 'btn-primary' : 'btn-secondary'}`}
                        style={{ padding: '0.4rem 0.25rem', fontSize: '0.75rem', whiteSpace: 'nowrap' }}
                        onClick={() => setSelectedFrame(f.id)}
                      >
                        {f.name}
                      </button>
                    ))}
                  </div>

                  {/* Manual EXIF parameters editing */}
                  {selectedFrame !== 'none' && selectedFrame !== 'film-roll' && (
                    <div style={{ background: 'var(--bg-main)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>🏷️ 编辑相机参数：</span>
                      
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                        <div>
                          <label className="form-label" style={{ fontSize: '0.75rem' }}>相机品牌</label>
                          <input 
                            type="text" 
                            className="form-control" 
                            style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem' }}
                            value={exifParams.make}
                            onChange={(e) => handleUpdateExif('make', e.target.value)}
                          />
                        </div>
                        <div>
                          <label className="form-label" style={{ fontSize: '0.75rem' }}>相机型号</label>
                          <input 
                            type="text" 
                            className="form-control" 
                            style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem' }}
                            value={exifParams.model}
                            onChange={(e) => handleUpdateExif('model', e.target.value)}
                          />
                        </div>
                      </div>

                      {selectedFrame !== 'polaroid' && (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '0.4rem' }}>
                          <div>
                            <label className="form-label" style={{ fontSize: '0.7rem' }}>焦距</label>
                            <input 
                              type="text" 
                              className="form-control" 
                              style={{ padding: '0.25rem 0.25rem', fontSize: '0.75rem' }}
                              value={exifParams.focal}
                              onChange={(e) => handleUpdateExif('focal', e.target.value)}
                            />
                          </div>
                          <div>
                            <label className="form-label" style={{ fontSize: '0.7rem' }}>光圈</label>
                            <input 
                              type="text" 
                              className="form-control" 
                              style={{ padding: '0.25rem 0.25rem', fontSize: '0.75rem' }}
                              value={exifParams.fNumber}
                              onChange={(e) => handleUpdateExif('fNumber', e.target.value)}
                            />
                          </div>
                          <div>
                            <label className="form-label" style={{ fontSize: '0.7rem' }}>快门</label>
                            <input 
                              type="text" 
                              className="form-control" 
                              style={{ padding: '0.25rem 0.25rem', fontSize: '0.75rem' }}
                              value={exifParams.shutter}
                              onChange={(e) => handleUpdateExif('shutter', e.target.value)}
                            />
                          </div>
                          <div>
                            <label className="form-label" style={{ fontSize: '0.7rem' }}>ISO</label>
                            <input 
                              type="text" 
                              className="form-control" 
                              style={{ padding: '0.25rem 0.25rem', fontSize: '0.75rem' }}
                              value={exifParams.iso}
                              onChange={(e) => handleUpdateExif('iso', e.target.value)}
                            />
                          </div>
                        </div>
                      )}

                      <div>
                        <label className="form-label" style={{ fontSize: '0.75rem' }}>拍摄日期/文字说明</label>
                        <input 
                          type="text" 
                          className="form-control" 
                          style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem' }}
                          value={exifParams.date}
                          onChange={(e) => handleUpdateExif('date', e.target.value)}
                        />
                      </div>
                    </div>
                  )}

                  {/* Film Roll info panel */}
                  {selectedFrame === 'film-roll' && (
                    <div style={{ background: 'var(--bg-main)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>🎞️ 胶卷底片边框已启用：</span>
                      <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>
                        当前已选择高质感胶卷底片边框。底片代号已设为 <strong>FUJI FILM RDPIII</strong> 并在底部显示 <strong>ISO 100</strong>。图片裁剪比率已自动调整为 35mm 胶卷底片经典的 <strong>3:2</strong> 比例。
                      </p>
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'ai-copy' && (
                <div>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
                    🤖 AI 一键生成文案，轻松创作爆款标题与小红书文章：
                  </p>

                  <div style={{ marginBottom: '1rem' }}>
                    <label className="form-label" style={{ fontSize: '0.8rem', display: 'block', marginBottom: '0.5rem', color: 'var(--text-primary)', fontWeight: 600 }}>
                      ✍️ 选择文章风格：
                    </label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.75rem' }}>
                      {['探店', '旅行心情', '自定义'].map((style) => (
                        <button
                          key={style}
                          className="btn"
                          style={{
                            padding: '0.35rem 0.75rem',
                            fontSize: '0.75rem',
                            borderRadius: '20px',
                            border: copyStyle === style ? 'none' : '1px solid var(--border-color)',
                            background: copyStyle === style ? 'linear-gradient(135deg, #ff2442, #ff4d66)' : 'var(--bg-card)',
                            color: copyStyle === style ? '#fff' : 'var(--text-secondary)',
                            fontWeight: copyStyle === style ? '600' : 'normal',
                            cursor: 'pointer',
                            boxShadow: copyStyle === style ? '0 2px 6px rgba(255, 36, 66, 0.2)' : 'none',
                            transition: 'all 0.2s ease',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.25rem'
                          }}
                          onClick={() => setCopyStyle(style)}
                        >
                          {style === '探店' && '🛍️ 探店'}
                          {style === '旅行心情' && '✈️ 旅行心情'}
                          {style === '自定义' && '⚙️ 自定义'}
                        </button>
                      ))}
                    </div>

                    {copyStyle === '自定义' && (
                      <div style={{ animation: 'fadeIn 0.2s ease', marginBottom: '0.75rem' }}>
                        <input
                          type="text"
                          className="form-control"
                          placeholder="例如：科技测评、好物推荐、搞笑幽默..."
                          style={{
                            width: '100%',
                            padding: '0.5rem 0.75rem',
                            fontSize: '0.8rem',
                            borderRadius: 'var(--radius-sm)',
                            border: '1px solid var(--border-color)',
                            backgroundColor: 'var(--bg-card)',
                            color: 'var(--text-primary)',
                            outline: 'none',
                            boxSizing: 'border-box'
                          }}
                          value={customCopyStyle}
                          onChange={(e) => setCustomCopyStyle(e.target.value)}
                        />
                      </div>
                    )}

                    <div style={{ marginTop: '0.75rem' }}>
                      <label className="form-label" style={{ fontSize: '0.8rem', display: 'block', marginBottom: '0.5rem', color: 'var(--text-primary)', fontWeight: 600 }}>
                        📝 输入主题/亮点描述（选填）：
                      </label>
                      <textarea
                        className="form-control"
                        placeholder="例如：在杭州西湖骑行看日落，天气非常晴朗，橙红色的夕阳倒映在水面上，极其治愈温馨..."
                        rows="3"
                        style={{
                          width: '100%',
                          padding: '0.5rem 0.75rem',
                          fontSize: '0.8rem',
                          borderRadius: 'var(--radius-sm)',
                          border: '1px solid var(--border-color)',
                          backgroundColor: 'var(--bg-card)',
                          color: 'var(--text-primary)',
                          outline: 'none',
                          boxSizing: 'border-box',
                          resize: 'none',
                          fontFamily: 'inherit'
                        }}
                        value={copyKeywords}
                        onChange={(e) => setCopyKeywords(e.target.value)}
                      />
                    </div>
                  </div>
                  
                  <button
                    className="btn btn-primary"
                    style={{ width: '100%', marginBottom: '1rem', background: 'linear-gradient(135deg, #6366f1, #4f46e5)' }}
                    onClick={handleGenerateAICopy}
                    disabled={isGeneratingCopy}
                  >
                    {isGeneratingCopy ? '🤖 正在撰写文案中...' : `🚀 生成【${copyStyle === '自定义' ? (customCopyStyle || '自定义') : copyStyle}】文案 (3款)`}
                  </button>

                  {generatedCopyOptions.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                      {/* Copy options selector tabs */}
                      <div style={{ display: 'flex', gap: '0.25rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem' }}>
                        {generatedCopyOptions.map((opt, idx) => (
                          <button
                            key={idx}
                            className={`btn ${activeCopyOptionIdx === idx ? 'btn-primary' : 'btn-secondary'}`}
                            style={{ flex: 1, padding: '0.4rem 0.25rem', fontSize: '0.75rem' }}
                            onClick={() => applyCopyOption(idx)}
                          >
                            {opt.styleName}
                          </button>
                        ))}
                      </div>

                      {/* Content Card */}
                      <div style={{ background: 'var(--bg-main)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', position: 'relative' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                          <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-secondary)' }}>
                            ✨ {generatedCopyOptions[activeCopyOptionIdx].styleName}
                          </span>
                          <button
                            className="btn btn-secondary"
                            style={{ padding: '0.2rem 0.5rem', fontSize: '0.7rem' }}
                            onClick={() => {
                              const opt = generatedCopyOptions[activeCopyOptionIdx];
                              const fullText = `【${opt.title}】\n\n${opt.body}\n\n${opt.tags}`;
                              navigator.clipboard.writeText(fullText);
                              alert('文案已复制到剪贴板！');
                            }}
                          >
                            📋 复制全部文案
                          </button>
                        </div>

                        <div style={{ fontSize: '0.85rem', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '0.5rem', paddingBottom: '0.5rem', borderBottom: '1px dotted var(--border-color)' }}>
                          标题：{generatedCopyOptions[activeCopyOptionIdx].title}
                        </div>
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-primary)', whiteSpace: 'pre-wrap', lineHeight: '1.5' }}>
                          {generatedCopyOptions[activeCopyOptionIdx].body}
                        </div>
                        <div style={{ fontSize: '0.8rem', color: '#4f46e5', fontWeight: 600, marginTop: '0.5rem' }}>
                          {generatedCopyOptions[activeCopyOptionIdx].tags}
                        </div>
                      </div>

                      {/* Manual adjustment section */}
                      <div style={{ marginTop: '0.5rem', borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem' }}>
                        <label className="form-label" style={{ fontSize: '0.8rem', display: 'block', marginBottom: '0.5rem', color: 'var(--text-primary)', fontWeight: 600 }}>
                          ✍️ 微调文案内容：
                        </label>
                        <div className="form-group" style={{ marginBottom: '0.75rem' }}>
                          <label className="form-label" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>编辑标题</label>
                          <input 
                            type="text" 
                            className="form-control" 
                            style={{ width: '100%', padding: '0.4rem 0.5rem', fontSize: '0.8rem', boxSizing: 'border-box' }}
                            value={aiTitle} 
                            onChange={(e) => setAiTitle(e.target.value)}
                          />
                        </div>
                        <div className="form-group">
                          <label className="form-label" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>编辑正文与标签</label>
                          <textarea 
                            className="form-control" 
                            rows="6"
                            style={{ width: '100%', padding: '0.4rem 0.5rem', fontSize: '0.8rem', resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit' }}
                            value={aiBody} 
                            onChange={(e) => setAiBody(e.target.value)}
                          />
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div style={{ textAlign: 'center', padding: '1.5rem', color: 'var(--text-secondary)', border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-sm)' }}>
                      💡 点击上方按钮，让 AI 帮您写文案吧！
                    </div>
                  )}
                </div>
              )}


              {/* Erase (Inpainting Mask) Tab */}
              {activeTab === 'erase' && (
                <div>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
                    使用画笔涂抹覆盖照片中不需要的**行人、杂物或垃圾桶**，然后点击下方按钮一键将其抹去：
                  </p>
                  
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', background: 'var(--bg-main)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', marginBottom: '0.75rem' }}>
                    <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>涂抹粗细:</span>
                    <input 
                      type="range" 
                      min="10" 
                      max="50" 
                      value={eraseWidth} 
                      onChange={(e) => setEraseWidth(parseInt(e.target.value))}
                      style={{ flex: 1, accentColor: 'var(--xhs-red)' }}
                    />
                    <button className="btn btn-secondary" style={{ padding: '0.25rem 0.75rem', fontSize: '0.8rem' }} onClick={clearEraseMarks}>
                      清空标记
                    </button>
                  </div>

                  <button 
                    className="btn btn-primary"
                    style={{ width: '100%', background: 'linear-gradient(135deg, #4f46e5, #818cf8)' }}
                    onClick={handleAIObjectRemoval}
                    disabled={!hasEraseMarks}
                  >
                    🪄 AI 一键消除涂抹标记区域
                  </button>
                </div>
              )}

              {/* Sticker Tab */}
              {activeTab === 'sticker' && (
                <div style={{ marginTop: '0.5rem' }}>
                  <p style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.5rem' }}>添加趣味贴纸 (已进行防人物遮挡设计)：</p>
                  <div className="sticker-library">
                    <div className="sticker-option" onClick={() => addSticker('heart')} title="爱心">{STICKER_TEMPLATES.heart}</div>
                    <div className="sticker-option" onClick={() => addSticker('arrow')} title="箭头">{STICKER_TEMPLATES.arrow}</div>
                    <div className="sticker-option" onClick={() => addSticker('sparkle')} title="闪烁">{STICKER_TEMPLATES.sparkle}</div>
                    <div className="sticker-option" onClick={() => addSticker('speech')} title="气泡框">{STICKER_TEMPLATES.speech}</div>
                    <div className="sticker-option" onClick={() => addSticker('highlight')} title="圈圈">{STICKER_TEMPLATES.highlight}</div>
                  </div>

                  {selectedStickerId && activeImage.stickers.find(s => s.id === selectedStickerId)?.type === 'speech' && (
                    <div className="form-group" style={{ marginTop: '1rem' }}>
                      <label className="form-label">✍️ 修改气泡框文字</label>
                      <input 
                        type="text"
                        maxLength="6"
                        className="form-control"
                        placeholder="输入气泡短句"
                        value={activeImage.stickers.find(s => s.id === selectedStickerId)?.text || ''}
                        onChange={(e) => updateStickerText(selectedStickerId, e.target.value)}
                      />
                    </div>
                  )}

                  {/* Interactive Dot Tags Section */}
                  <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '1rem', marginTop: '1rem' }}>
                    <p style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.5rem' }}>📍 仿小红书「智能圆点标签」：</p>
                    
                    <button
                      className="btn btn-primary"
                      style={{ width: '100%', marginBottom: '0.75rem', background: 'linear-gradient(135deg, #10b981, #059669)', fontSize: '0.8rem', padding: '0.5rem', border: 'none' }}
                      onClick={handleRecommendDotTags}
                      disabled={isGeneratingTags}
                    >
                      {isGeneratingTags ? '🤖 正在分析画面并打标...' : '🤖 AI 一键智能图像识别打标'}
                    </button>

                    <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
                      在图片上方双击标签可切换左右指针，按住可自由拖拽调整，或手动输入添加：
                    </p>
                    
                    <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
                      <input 
                        type="text" 
                        className="form-control" 
                        placeholder="标签内容，如: 今日穿搭 #ootd" 
                        style={{ padding: '0.4rem', fontSize: '0.8rem' }}
                        value={customTagText}
                        onChange={(e) => setCustomTagText(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && addDotTag(customTagText)}
                      />
                      <button 
                        className="btn btn-primary" 
                        style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem', whiteSpace: 'nowrap' }}
                        onClick={() => addDotTag(customTagText)}
                        disabled={!customTagText.trim()}
                      >
                        添加标签
                      </button>
                    </div>

                    {/* Show select edit tag info */}
                    {selectedTagId && activeImage.tags && activeImage.tags.find(t => t.id === selectedTagId) && (
                      <div style={{ background: 'var(--bg-main)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-primary)' }}>📝 修改选中标签：</span>
                        <input 
                          type="text" 
                          className="form-control" 
                          style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem' }}
                          value={activeImage.tags.find(t => t.id === selectedTagId)?.text || ''}
                          onChange={(e) => updateTagText(selectedTagId, e.target.value)}
                        />
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                          <button 
                            className="btn btn-secondary" 
                            style={{ flex: 1, padding: '0.25rem 0.5rem', fontSize: '0.7rem' }}
                            onClick={(e) => toggleTagDirection(selectedTagId, e)}
                          >
                            🔄 切换指针
                          </button>
                          <button 
                            className="btn btn-secondary" 
                            style={{ flex: 1, padding: '0.25rem 0.5rem', fontSize: '0.7rem', color: '#ef4444' }}
                            onClick={(e) => deleteDotTag(selectedTagId, e)}
                          >
                            🗑️ 删除标签
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Handwritten Text Tab */}
              {activeTab === 'text' && (
                <div style={{ marginTop: '0.5rem' }}>
                  <div className="form-group">
                    <label className="form-label" style={{ fontWeight: 600 }}>✍️ 自定义添加手写文案</label>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <input 
                        type="text" 
                        className="form-control" 
                        placeholder="例如：夏日午后" 
                        value={customTextContent}
                        onChange={(e) => setCustomTextContent(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && addHandwrittenText(customTextContent)}
                      />
                      <button 
                        className="btn btn-primary" 
                        onClick={() => addHandwrittenText(customTextContent)}
                        disabled={!customTextContent.trim()}
                      >
                        添加
                      </button>
                    </div>
                  </div>

                  <div className="form-group" style={{ marginTop: '0.5rem' }}>
                    <label className="form-label">手写字颜色</label>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      {TEXT_COLORS.map(c => (
                        <div 
                          key={c}
                          className={`color-dot ${customTextColor === c ? 'active' : ''}`}
                          style={{ backgroundColor: c, border: c === '#ffffff' ? '1px solid #ddd' : 'none' }}
                          onClick={() => {
                            setCustomTextColor(c);
                            if (selectedTextId) updateTextColor(selectedTextId, c);
                          }}
                        />
                      ))}
                    </div>
                  </div>

                  <div style={{ marginTop: '1rem' }}>
                    <label className="form-label">✨ 常用手写词推荐：</label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                      {TEXT_SUGGESTIONS.map(word => (
                        <button 
                          key={word}
                          className="ratio-btn" 
                          style={{ flex: 'none', padding: '0.25rem 0.75rem', borderRadius: '12px' }}
                          onClick={() => addHandwrittenText(word)}
                        >
                          + {word}
                        </button>
                      ))}
                    </div>
                  </div>

                  {selectedTextId && (
                    <div className="form-group" style={{ marginTop: '1.25rem', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
                      <label className="form-label">📝 编辑选中文字</label>
                      <input 
                        type="text"
                        className="form-control"
                        value={activeImage.texts?.find(t => t.id === selectedTextId)?.content || ''}
                        onChange={(e) => updateTextContent(selectedTextId, e.target.value)}
                      />
                    </div>
                  )}
                </div>
              )}

            </div>
          )}

          {/* 3. Metadata */}
          {uploadedImages.length > 0 && (
            <div className="card">
              <h2 className="card-title">📍 第二步：确认全局属性</h2>
              <div className="form-group">
                <label className="form-label">发布日期</label>
                <input 
                  type="date" 
                  className="form-control" 
                  value={globalMetadata.time} 
                  onChange={(e) => setGlobalMetadata({ ...globalMetadata, time: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label className="form-label">显示地点</label>
                <input 
                  type="text" 
                  className="form-control" 
                  placeholder="可手动填入显示地点" 
                  value={globalMetadata.location} 
                  onChange={(e) => setGlobalMetadata({ ...globalMetadata, location: e.target.value })}
                />
              </div>
            </div>
          )}



        </section>

        {/* Right Canvas Workspace Column */}
        <section className="preview-panel" style={{ flex: '1.4' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center', marginBottom: '0.5rem' }}>
            <h2 className="card-title" style={{ margin: 0 }}>🎨 高清画布编辑与预览</h2>
            {uploadedImages.length > 0 && (
              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                <button 
                  className="btn btn-primary" 
                  style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem', background: 'linear-gradient(135deg, #ff2442, #ff4d66)', border: 'none', color: '#fff', fontWeight: '600' }} 
                  onClick={exportSelectedSingleImages}
                >
                  ⚡ 批量导出已选单图 ({selectedExportIds.length})
                </button>
              </div>
            )}
          </div>

          {uploadedImages.length > 0 && activeImage ? (
            <div className="card" style={{ width: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '1.5rem', boxSizing: 'border-box' }}>
              <div 
                className="editor-canvas-container" 
                style={{ overflow: 'visible', margin: '0', width: '100%', maxWidth: '600px' }}
              >
                <div 
                  className={`grid-cell-frame-wrapper ${selectedFrame !== 'none' ? `frame-${selectedFrame}` : ''}`}
                  onContextMenu={handleContextMenu}
                  onTouchStart={handleTouchStartLongPress}
                  onTouchMove={handleTouchMoveLongPress}
                  onTouchEnd={handleTouchEndLongPress}
                  style={{ 
                    position: 'relative', 
                    width: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    boxSizing: 'border-box',
                    backgroundColor: selectedFrame === 'leica-white' ? '#fff' : selectedFrame === 'leica-black' ? '#0c0c0c' : selectedFrame === 'hasselblad' ? '#121212' : selectedFrame === 'polaroid' ? '#fcfbf9' : 'transparent'
                  }}
                >
                  <div 
                    className="annotation-wrapper" 
                    style={{ position: 'relative', width: '100%' }}
                    onClick={() => { setSelectedStickerId(null); setSelectedTextId(null); setSelectedTagId(null); }}
                  >
                    <div 
                      ref={editorImageContainerRef}
                      className="grid-image-container" 
                      style={{ 
                        width: '100%', 
                        borderRadius: selectedFrame !== 'none' ? '0' : 'var(--radius-md)', 
                        overflow: 'hidden',
                        position: 'relative'
                      }}
                    >
                      {/* Image - rendered full size, no cropping */}
                      <img 
                        src={activeImage.croppedSrc} 
                        className="base-image" 
                        alt="Active Editor"
                        style={{ width: '100%', display: 'block', height: 'auto' }}
                      />

                      {/* Brush drawing canvas layer */}
                      <canvas
                        ref={drawingCanvasRef}
                        className="drawing-canvas"
                        style={{ pointerEvents: activeTab === 'draw' ? 'auto' : 'none', zIndex: 14 }}
                        onMouseDown={startDrawing}
                        onMouseMove={draw}
                        onMouseUp={stopDrawing}
                        onMouseLeave={stopDrawing}
                        onTouchStart={handleTouchStartDrawing}
                        onTouchMove={handleTouchMoveDrawing}
                        onTouchEnd={handleTouchEndDrawing}
                      />

                      {/* Erase (Inpainting Mask) brush canvas layer */}
                      <canvas
                        ref={eraseCanvasRef}
                        className="drawing-canvas"
                        style={{ pointerEvents: activeTab === 'erase' ? 'auto' : 'none', zIndex: 12, opacity: 0.8 }}
                        onMouseDown={startErasing}
                        onMouseMove={drawEraseMark}
                        onMouseUp={stopErasing}
                        onMouseLeave={stopErasing}
                        onTouchStart={handleTouchStartErasing}
                        onTouchMove={handleTouchMoveErasing}
                        onTouchEnd={handleTouchEndErasing}
                      />
                    </div>

                    {/* Stickers Overlay */}
                    <div
                      className="stickers-container"
                      style={{ pointerEvents: 'none', zIndex: 15 }}
                    >
                      {activeImage.stickers.map((s) => (
                        <div
                          key={s.id}
                          id={`sticker-${s.id}`}
                          className={`sticker-item ${selectedStickerId === s.id ? 'selected' : ''}`}
                          style={{
                            left: `${s.x}%`,
                            top: `${s.y}%`,
                            transform: `translate(-50%, -50%) rotate(${s.rotation}deg) scale(${s.scale})`,
                            width: `${s.width}px`,
                            height: `${s.height}px`,
                            pointerEvents: activeTab === 'sticker' ? 'auto' : 'none'
                          }}
                          onMouseDown={(e) => handleStickerMouseDown(e, s)}
                          onTouchStart={(e) => handleStickerTouchStart(e, s)}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {STICKER_TEMPLATES[s.type]}
                          
                          {s.type === 'speech' && (
                            <div style={{
                                position: 'absolute',
                                top: '25%',
                                left: '12%',
                                width: '76%',
                                height: '40%',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: '12px',
                                fontWeight: '600',
                                color: '#222',
                                textAlign: 'center',
                                overflow: 'hidden',
                                wordBreak: 'break-all'
                              }}>
                                {s.text}
                              </div>
                          )}

                          {selectedStickerId === s.id && activeTab === 'sticker' && (
                            <>
                              <div className="sticker-delete-btn" onClick={(e) => deleteSticker(s.id, e)}>✕</div>
                              <div className="sticker-rotate-btn" onMouseDown={(e) => handleRotateScaleMouseDown(e, s)} onTouchStart={(e) => handleRotateScaleTouchStart(e, s)} onClick={(e) => e.stopPropagation()}>⟳</div>
                              {s.type === 'speech' && (
                                <div 
                                  className="sticker-edit-btn" 
                                  style={{ position: 'absolute', bottom: '-20px', left: '50%', transform: 'translateX(-50%)', backgroundColor: '#4f46e5', color: 'white', borderRadius: '3px', padding: '1px 4px', fontSize: '9px', cursor: 'pointer', zIndex: 100, pointerEvents: 'auto', whiteSpace: 'nowrap' }}
                                  onMouseDown={(e) => e.stopPropagation()}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const txt = prompt('输入气泡文字:', s.text || '');
                                    if (txt !== null) updateStickerText(s.id, txt);
                                  }}
                                >
                                  ✍️ 文字
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Handwritten Texts Overlay */}
                    <div
                      className="stickers-container"
                      style={{ pointerEvents: 'none', zIndex: 18 }}
                    >
                      {(activeImage.texts || []).map((t) => (
                        <div
                          key={t.id}
                          id={`text-${t.id}`}
                          className={`handwritten-text-item ${selectedTextId === t.id ? 'selected' : ''}`}
                          style={{
                            left: `${t.x}%`,
                            top: `${t.y}%`,
                            transform: `translate(-50%, -50%) rotate(${t.rotation}deg) scale(${t.scale})`,
                            color: t.color,
                            fontSize: '20px',
                            pointerEvents: activeTab === 'text' ? 'auto' : 'none'
                          }}
                          onMouseDown={(e) => handleTextMouseDown(e, t)}
                          onTouchStart={(e) => handleTextTouchStart(e, t)}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {t.content}

                          {selectedTextId === t.id && activeTab === 'text' && (
                            <>
                              <div className="text-delete-btn" onClick={(e) => deleteText(t.id, e)}>✕</div>
                              <div className="text-rotate-btn" onMouseDown={(e) => handleTextRotateScaleMouseDown(e, t)} onTouchStart={(e) => handleTextRotateScaleTouchStart(e, t)} onClick={(e) => e.stopPropagation()}>⟳</div>
                            </>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Smart Dot Tags Overlay */}
                    <div
                      className="stickers-container"
                      style={{ pointerEvents: 'none', zIndex: 19 }}
                    >
                      {(activeImage.tags || []).map((tag) => (
                        <div
                          key={tag.id}
                          className={`xhs-tag-container tag-direction-${tag.direction} ${selectedTagId === tag.id ? 'selected' : ''}`}
                          style={{
                            left: `${tag.x}%`,
                            top: `${tag.y}%`,
                            pointerEvents: activeTab === 'sticker' ? 'auto' : 'none'
                          }}
                          onMouseDown={(e) => handleTagMouseDown(e, tag)}
                          onTouchStart={(e) => handleTagTouchStart(e, tag)}
                          onClick={(e) => e.stopPropagation()}
                          title="拖动位置，双击切换指向"
                          onDoubleClick={(e) => toggleTagDirection(tag.id, e)}
                        >
                          {tag.direction === 'left' ? (
                            <>
                              <div className="xhs-tag-label">{tag.text}</div>
                              <div className="xhs-tag-dot"><div className="xhs-tag-dot-pulse"></div></div>
                            </>
                          ) : (
                            <>
                              <div className="xhs-tag-dot"><div className="xhs-tag-dot-pulse"></div></div>
                              <div className="xhs-tag-label">{tag.text}</div>
                            </>
                          )}

                          {selectedTagId === tag.id && activeTab === 'sticker' && (
                            <div 
                              className="sticker-delete-btn" 
                              style={{ top: '-15px', right: '-15px' }}
                              onClick={(e) => deleteDotTag(tag.id, e)}
                            >
                              ✕
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* EXIF Camera Info Watermark Overlay (applied inside cell) */}
                  {selectedFrame !== 'none' && selectedFrame !== 'film-roll' && (
                    <div className="exif-frame-bar">
                      {selectedFrame === 'polaroid' ? (
                        <div style={{ width: '100%', textAlign: 'center', letterSpacing: '1px' }}>
                          {activeImage.exif?.date || exifParams.date}
                        </div>
                      ) : (
                        <>
                          <div className="exif-left-params">
                            <span>{activeImage.exif?.focal || exifParams.focal}</span>
                            <span>{activeImage.exif?.fNumber || exifParams.fNumber}</span>
                            <span>{activeImage.exif?.shutter || exifParams.shutter}</span>
                            <span>{activeImage.exif?.iso || exifParams.iso}</span>
                          </div>
                          
                          {selectedFrame.startsWith('leica') ? (
                            <div className="leica-red-dot">LEICA</div>
                          ) : selectedFrame === 'hasselblad' ? (
                            <div className="hasselblad-logo-text">HASSELBLAD</div>
                          ) : null}

                          <div className="exif-right-model">
                            <span className="exif-date-sub">{activeImage.exif?.date || exifParams.date}</span>
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  {/* Film Roll Sprockets & Markings (applied inside cell) */}
                  {selectedFrame === 'film-roll' && (
                    <>
                      <div className="film-sprocket-strip top">
                        {Array.from({ length: 9 }).map((_, i) => (
                          <div key={i} className="film-sprocket-hole" />
                        ))}
                      </div>
                      <div className="film-marking-text top">
                        <span>▲ {24 + activeIdx * 2}</span>
                        <span>FUJI FILM RDPIII</span>
                        <span>{24 + activeIdx * 2}A</span>
                      </div>
                      
                      <div className="film-sprocket-strip bottom">
                        {Array.from({ length: 9 }).map((_, i) => (
                          <div key={i} className="film-sprocket-hole" />
                        ))}
                      </div>
                      <div className="film-marking-text bottom">
                        <span className="film-barcode-mark">||| | || || |||</span>
                        <span>ISO 100</span>
                        <span>{25 + activeIdx * 2}</span>
                      </div>
                    </>
                  )}
                </div>
                
                {/* Location and Date Bar overlay */}
                {selectedFrame === 'none' && (globalMetadata.location || globalMetadata.time) && (
                  <div className="poster-meta-bar" style={{ position: 'absolute', bottom: 0, left: 0, width: '100%' }}>
                    <div className="poster-meta-item">
                      {globalMetadata.location && `📍 ${globalMetadata.location}`}
                    </div>
                    <div className="poster-meta-item">
                      {globalMetadata.time && `📅 ${globalMetadata.time}`}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="card" style={{ width: '100%', height: '350px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6c757d' }}>
              <span>🌅 请先在左侧上传并选择照片进行编辑</span>
            </div>
          )}
        </section>

      </main>

      {/* Mobile Image Save Preview Modal */}
      {mobilePreviewImages.length > 0 && (
        <div 
          className="mobile-preview-overlay"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            backgroundColor: 'rgba(10, 10, 10, 0.92)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            zIndex: 99999,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '1.5rem 1rem',
            boxSizing: 'border-box',
            overflowY: 'auto'
          }}
          onClick={() => setMobilePreviewImages([])}
        >
          {/* Header instructions */}
          <div style={{ textAlign: 'center', color: '#fff', width: '100%', marginBottom: '1rem' }}>
            <h3 style={{ fontSize: '1.1rem', margin: '0 0 0.5rem 0', fontWeight: '700', color: '#ff2442' }}>💡 长按下方图片保存到相册</h3>
            <p style={{ fontSize: '0.8rem', color: '#ccc', margin: 0, padding: '0 0.5rem', lineHeight: '1.4' }}>
              由于手机系统安全限制，网页无法直接保存图片到相册。请长按图片呼出菜单并选择“保存图片”或“添加到照片”。
            </p>
          </div>

          {/* Image(s) display container */}
          <div 
            style={{ 
              flex: 1, 
              display: 'flex', 
              flexDirection: 'column', 
              gap: '1.5rem', 
              alignItems: 'center', 
              justifyContent: 'center', 
              width: '100%',
              margin: '1rem 0'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {mobilePreviewImages.map((url, idx) => (
              <div 
                key={idx} 
                style={{ 
                  position: 'relative', 
                  width: '100%', 
                  maxWidth: '360px', 
                  borderRadius: 'var(--radius-md)', 
                  boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
                  backgroundColor: '#222',
                  padding: '4px',
                  boxSizing: 'border-box'
                }}
              >
                <img 
                  src={url} 
                  alt={`Preview ${idx + 1}`} 
                  style={{ 
                    width: '100%', 
                    height: 'auto', 
                    display: 'block', 
                    borderRadius: 'var(--radius-sm)'
                  }} 
                />
                {mobilePreviewImages.length > 1 && (
                  <div style={{
                    position: 'absolute',
                    top: '10px',
                    right: '10px',
                    backgroundColor: 'rgba(0,0,0,0.7)',
                    color: '#fff',
                    padding: '2px 8px',
                    borderRadius: '10px',
                    fontSize: '0.75rem',
                    fontWeight: 'bold'
                  }}>
                    第 {idx + 1} 张 / 共 {mobilePreviewImages.length} 张
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Close button */}
          <button 
            style={{
              width: '100%',
              maxWidth: '280px',
              padding: '0.8rem 1.5rem',
              backgroundColor: '#ff2442',
              color: 'white',
              border: 'none',
              borderRadius: '30px',
              fontSize: '0.95rem',
              fontWeight: 'bold',
              cursor: 'pointer',
              boxShadow: '0 4px 15px rgba(255, 36, 66, 0.4)',
              marginTop: '1rem'
            }}
            onClick={() => setMobilePreviewImages([])}
          >
            ✕ 关闭预览
          </button>
        </div>
      )}

      {/* Custom Context Menu overlay */}
      {contextMenu && contextMenu.visible && (
        <div 
          className="custom-context-menu"
          style={{
            position: 'fixed',
            left: `${contextMenu.x}px`,
            top: `${contextMenu.y}px`,
            zIndex: 9999,
            backgroundColor: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-sm)',
            boxShadow: 'var(--shadow-lg)',
            padding: '0.4rem 0',
            minWidth: '160px',
            userSelect: 'none'
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            style={{
              width: '100%',
              padding: '0.6rem 1rem',
              textAlign: 'left',
              background: 'none',
              border: 'none',
              color: 'var(--text-primary)',
              fontSize: '0.85rem',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              fontWeight: 500
            }}
            onClick={async (e) => {
              e.stopPropagation();
              setContextMenu(null);
              await downloadActiveImageHD();
            }}
          >
            📥 下载高清图片
          </button>
        </div>
      )}
    </div>
  );
}

export default App;
