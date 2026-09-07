import React, { useState, useRef, useEffect } from 'react';
import piexif from 'piexifjs';
import ExifReader from 'exifreader';

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

  // App States
  const [showWelcome, setShowWelcome] = useState(true);
  const [uploadedImages, setUploadedImages] = useState([]); // [{ id, file, src, styledSrc, activeStyle }]
  const [activeIdx, setActiveIdx] = useState(0); 
  const [activeTab, setActiveTab] = useState('style'); // 'style', 'ai-copy'
  
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
  const [coverStyle, setCoverStyle] = useState('magazine'); // 'magazine' | 'minimal' | 'sticker'
  const [coverTag, setCoverTag] = useState('⚡ BREAKING 速报');
  const [coverTitle, setCoverTitle] = useState('3秒极限绝杀！');
  const [coverSubtitle, setCoverSubtitle] = useState('2026 视觉精选指南 · 建议先马后看');
  const [coverPosition, setCoverPosition] = useState('bottom'); // 'bottom' | 'center' | 'top'
  const [coverCandidates, setCoverCandidates] = useState([]);
  const [isGeneratingCoverTitles, setIsGeneratingCoverTitles] = useState(false);
  const [coverPreviewUri, setCoverPreviewUri] = useState('');
  const [activePreviewTab, setActivePreviewTab] = useState('styled'); // 'styled' | 'cover'

  // General UI States
  const [isLoading, setIsLoading] = useState(false);
  const [aiOperationName, setAiOperationName] = useState(''); 
  const [errorMsg, setErrorMsg] = useState('');

  // Refs
  const fileInputRef = useRef(null);

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
  }, [uploadedImages, coverImageIdx, activeIdx, coverStyle, coverTag, coverTitle, coverSubtitle, coverPosition]);

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
    
    for (const file of filesToProcess) {
      try {
        const id = Math.random().toString(36).substring(2, 9);
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
          exif
        });
      } catch (fileErr) {
        console.error('[Upload] Error processing file:', file?.name, fileErr);
        setErrorMsg('部分图片处理失败，请重试');
      }
    }

    if (newImages.length > 0) {
      setUploadedImages(prev => [...prev, ...newImages]);
      setActiveIdx(uploadedImages.length);
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    if (e.target) {
      e.target.value = '';
    }
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
    const styleLabel = styleName === 'clay' ? '泥塑黏土化' : styleName === 'japanese-film' ? '日式胶片风' : '吉卜力卡通化';
    setAiOperationName(`豆包模型 ${styleLabel} (${targets.length}张)`);
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
              styledSrc: watermarkedImage,
              activeStyle: styleName
            };
          }
          return img;
        }));
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
          activeStyle: null
        };
      }
      return img;
    }));
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
        exif: target.exif
      });

      const link = document.createElement('a');
      link.href = dataUri;
      link.download = `xhs-cover-${coverStyle}-${Date.now()}.jpg`;
      link.click();
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

      // Trigger download
      const link = document.createElement('a');
      link.href = canvas.toDataURL('image/jpeg', 0.95);
      link.download = `shantie-ai-report-${Date.now()}.jpg`;
      link.click();
    } catch (err) {
      console.error('Failed to export report card:', err);
      alert('导出报告卡片失败，请重试');
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
        
        let rightTitle = 'Doubao Seedream 5.0';
        if (modelName === 'dashscope-wanx') {
          rightTitle = 'DashScope Wanx 2.1';
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

  // Helper: Render high-impact Xiaohongshu Cover Title Card on Canvas (3 styles: magazine, minimal, sticker)
  const renderCoverCanvas = (imageSrc, {
    tag = '⚡ BREAKING 速报',
    title = '3秒极限绝杀！',
    subtitle = '2026 UTMB OCC 女子前三',
    style = 'magazine',
    position = 'bottom',
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
          const tagText = (tag || '').trim();
          const titleText = (title || '').trim();
          const subText = (subtitle || '').trim();

          const titleFontSize = Math.round(54 * scale);
          const subFontSize = Math.round(24 * scale);
          const tagFontSize = Math.round(22 * scale);

          // Pre-calculate wrapped lines for title
          ctx.font = `900 ${titleFontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif`;
          const maxTitleWidth = style === 'minimal' ? w * 0.78 : (style === 'sticker' ? w * 0.82 : w * 0.86);
          const titleLines = wrapCanvasTextLines(ctx, titleText || '点击输入号召力大标题', maxTitleWidth);

          // 2. Render according to selected style
          if (style === 'magazine') {
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
              const pillW = tagMetrics.width + 30 * scale;
              const pillH = tagFontSize * 1.85;

              drawRoundRect(ctx, padX, curY, pillW, pillH, pillH / 2);
              ctx.fillStyle = '#FFE600'; // High-visibility Neon Yellow
              ctx.fill();

              ctx.fillStyle = '#111111';
              ctx.textAlign = 'left';
              ctx.textBaseline = 'middle';
              ctx.fillText(tagText, padX + 15 * scale, curY + pillH / 2);
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
              ctx.fillText(line, padX, curY);
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
              ctx.fillText(subText, padX, curY);
            }

            // Reset shadow
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
            ctx.shadowOffsetY = 0;

            // Header branding at the top
            ctx.font = `800 ${18 * scale}px sans-serif`;
            ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
            ctx.fillText('⚡ XIAOHONGSHU PICKS • 2026', padX, 46 * scale);

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
              const pillW = tagMetrics.width + 24 * scale;
              const pillH = tagFontSize * 1.7;

              drawRoundRect(ctx, cardPad + cardInnerPadX, curY, pillW, pillH, pillH / 2);
              ctx.fillStyle = 'rgba(245, 158, 11, 0.12)';
              ctx.fill();
              ctx.strokeStyle = 'rgba(217, 119, 6, 0.4)';
              ctx.lineWidth = 1.5 * scale;
              ctx.stroke();

              ctx.fillStyle = '#B45309'; // Warm amber
              ctx.textAlign = 'left';
              ctx.textBaseline = 'middle';
              ctx.fillText(tagText, cardPad + cardInnerPadX + 12 * scale, curY + pillH / 2);
              curY += pillH + 16 * scale;
            }

            // Title: Elegant serif font with bracket quotation
            ctx.fillStyle = '#111827';
            ctx.font = `800 ${titleFontSize}px "Songti SC", "Noto Serif SC", "PingFang SC", serif, sans-serif`;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';

            titleLines.forEach((line, idx) => {
              const displayLine = (idx === 0 && titleLines.length === 1) ? `「 ${line} 」` : line;
              ctx.fillText(displayLine, cardPad + cardInnerPadX, curY);
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
              ctx.fillText(`CITY GUIDE · ${subText}`, cardPad + cardInnerPadX, curY);
            }
            ctx.restore();

          } else {
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
              ctx.translate(padX, curY);
              ctx.rotate((-3.5 * Math.PI) / 180);

              ctx.font = `900 ${tagFontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
              const tagMetrics = ctx.measureText(tagText);
              const badgeW = tagMetrics.width + 30 * scale;
              const badgeH = tagFontSize * 1.8;

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
              ctx.fillText(tagText, 15 * scale, badgeH / 2);
              ctx.restore();

              curY += badgeH + 22 * scale;
            }

            // 2. Fluorescent Yellow Ribbon Banners behind each title line
            titleLines.forEach(line => {
              ctx.font = `900 ${titleFontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif`;
              const lineMetrics = ctx.measureText(line);
              const ribbonW = lineMetrics.width + 28 * scale;
              const ribbonH = titleFontSize * 1.25;

              ctx.save();
              ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
              ctx.shadowBlur = 10 * scale;
              ctx.shadowOffsetY = 4 * scale;

              drawRoundRect(ctx, padX, curY, ribbonW, ribbonH, 4 * scale);
              ctx.fillStyle = '#FFE600'; // Fluorescent Yellow
              ctx.fill();

              ctx.shadowColor = 'transparent';
              ctx.fillStyle = '#000000'; // Pure Black font
              ctx.textAlign = 'left';
              ctx.textBaseline = 'middle';
              ctx.fillText(line, padX + 14 * scale, curY + ribbonH / 2);
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

              ctx.save();
              ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
              ctx.shadowBlur = 8 * scale;
              drawRoundRect(ctx, padX, curY, subPillW, subPillH, 6 * scale);
              ctx.fillStyle = 'rgba(17, 24, 39, 0.9)';
              ctx.fill();

              ctx.shadowColor = 'transparent';
              ctx.fillStyle = '#FFFFFF';
              ctx.textAlign = 'left';
              ctx.textBaseline = 'middle';
              ctx.fillText(subText, padX + 14 * scale, curY + subPillH / 2);
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



  // Download the currently displayed styled (or original) active image
  const downloadActiveImage = () => {
    const activeImage = uploadedImages[activeIdx];
    if (!activeImage) return;

    const displaySrc = activeImage.styledSrc || activeImage.src;
    const link = document.createElement('a');
    link.href = displaySrc;
    link.download = `xhs-style-${activeImage.activeStyle || 'original'}-${activeIdx + 1}-${Date.now()}.jpg`;
    link.click();
  };

  const activeImage = uploadedImages[activeIdx];

  if (showWelcome) {
    return (
      <div className="welcome-screen">
        <div className="welcome-container">
          <div className="welcome-logo-section">
            <img src={`${(import.meta.env.BASE_URL || '/').replace(/\/$/, '')}/logo.jpg`} alt="闪贴 AI" className="welcome-logo-img" />
          </div>
          <h1 className="welcome-title">你拍照我生文</h1>
          <p className="welcome-subtitle">AI 智能画风转换与爆款文案助手</p>
          
          <div className="welcome-workflow">
            <h3 className="workflow-title" style={{ textAlign: 'center', justifyContent: 'center' }}>✨ 四步体验：拍、生、变、标！</h3>
            <div className="workflow-steps">
              <div className="workflow-step">
                <span className="step-num">1</span>
                <div className="step-content">
                  <strong>📸 上传照片（拍）</strong>
                  <span>随手添加 1-4 张照片，系统自动解析并提取 EXIF 拍摄时间与 GPS 地点。</span>
                </div>
              </div>
              <div className="workflow-step">
                <span className="step-num">2</span>
                <div className="step-content">
                  <strong>✍️ 一键生成（生）</strong>
                  <span>AI 结合画面时空智能撰写 3 款不同风格的社交爆款文案，复制即可去发文！</span>
                </div>
              </div>
              <div className="workflow-step">
                <span className="step-num">3</span>
                <div className="step-content">
                  <strong>🎨 艺术重绘（变）</strong>
                  <span>一键转换为治愈吉卜力、软萌泥塑或复古日式胶片风，保存高清原图。</span>
                </div>
              </div>
              <div className="workflow-step">
                <span className="step-num">4</span>
                <div className="step-content">
                  <strong>🏷️ 标题大片（标）</strong>
                  <span>智能提炼高号召力大字，提供杂志速报、极简质感、潮酷贴纸 3 种爆款封面！</span>
                </div>
              </div>
            </div>
          </div>
          
          <button className="btn btn-primary welcome-enter-btn" onClick={() => setShowWelcome(false)}>
            开始体验 🚀
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <div className="logo-section">
          <div className="logo-badge">书</div>
          <div className="logo-text">
            <h1>你拍照我生文</h1>
            <p>AI 一键卡通化 / 泥塑风 / 胶片风 · 智能爆款文案生成</p>
          </div>
        </div>
        
        {uploadedImages.length > 0 && (
          <button 
            className="btn btn-secondary"
            style={{ fontWeight: 600, fontSize: '0.85rem' }}
            onClick={clearAllImages}
          >
            🧹 清空全部
          </button>
        )}
      </header>

      {/* Loading Overlay */}
      {isLoading && (
        <div className="loading-overlay" style={{ position: 'fixed', width: '100vw', height: '100vh', top: 0, left: 0, zIndex: 1000 }}>
          <div className="spinner"></div>
          <div className="loading-text" style={{ fontSize: '1.2rem', fontWeight: 600 }}>{aiOperationName}... 请稍候...</div>
        </div>
      )}

      {/* Main Workspace */}
      <main className={`workspace ${uploadedImages.length > 0 ? 'has-images' : ''}`}>
        
        {/* Left Control Panel */}
        <section className="editor-panel">
          {errorMsg && (
            <div className="error-banner">
              <span>⚠️ {errorMsg}</span>
              <span className="error-close" onClick={() => setErrorMsg('')}>×</span>
            </div>
          )}

          {/* 1. Upload Section */}
          <div className="card">
            <h2 className="card-title">📸 上传照片 (最多4张)</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {uploadedImages.length < 4 && (
                <div 
                  className="upload-zone"
                  onClick={() => fileInputRef.current?.click()}
                  style={{ padding: '1.5rem 1rem' }}
                >
                  <div className="upload-icon" style={{ fontSize: '2rem' }}>📤</div>
                  <p style={{ fontSize: '0.9rem' }}>添加 1-4 张图片</p>
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
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>勾选需要重绘的图片（支持多选同时处理，点击图片可预览）：</p>
                  <div className="uploaded-images-list">
                    {uploadedImages.map((img, idx) => (
                      <div 
                        key={img.id}
                        className={`uploaded-image-thumbnail ${activeIdx === idx ? 'active' : ''}`}
                        onClick={() => setActiveIdx(idx)}
                        style={{ position: 'relative' }}
                      >
                        {/* Checkbox overlay for batch style-transfer selection */}
                        <input 
                          type="checkbox"
                          checked={img.selected !== false}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            setUploadedImages(prev => prev.map((item) => 
                              item.id === img.id ? { ...item, selected: e.target.checked } : item
                            ));
                          }}
                          style={{
                            position: 'absolute',
                            top: '6px',
                            left: '6px',
                            zIndex: 10,
                            cursor: 'pointer',
                            width: '18px',
                            height: '18px',
                            accentColor: 'var(--primary-color)'
                          }}
                        />
                        <img src={img.styledSrc || img.src} alt={`Thumbnail ${idx}`} />
                        <button 
                          className="uploaded-image-remove"
                          onClick={(e) => removeUploadedImage(img.id, e)}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 2. AI Copy Generator Tab */}
          {uploadedImages.length > 0 && (
            <div className="card">
              <h2 className="card-title">✍️ 第二步：小红书爆款文案生成</h2>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
                让 AI 智能识别内容风格，撰写文案与热门标签：
              </p>

              <div style={{ marginBottom: '0.75rem' }}>
                <label className="form-label" style={{ fontSize: '0.8rem', display: 'block', marginBottom: '0.25rem', fontWeight: 600 }}>文案风格：</label>
                <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                  {['探店', '旅行心情', '运动'].map((style) => (
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
                      }}
                      onClick={() => setCopyStyle(style)}
                    >
                      {style === '探店' && '🛍️ 探店'}
                      {style === '旅行心情' && '✈️ 旅行心情'}
                      {style === '运动' && '🏃 运动'}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ marginBottom: '0.75rem' }}>
                <label className="form-label" style={{ fontSize: '0.8rem', display: 'block', marginBottom: '0.25rem', fontWeight: 600 }}>亮点描述（选填）：</label>
                <textarea
                  className="form-control"
                  placeholder="可简述图片拍摄的主题、天气或想表达的亮点描述..."
                  rows="2"
                  style={{ width: '100%', padding: '0.4rem 0.5rem', fontSize: '0.8rem', resize: 'none', boxSizing: 'border-box' }}
                  value={copyKeywords}
                  onChange={(e) => setCopyKeywords(e.target.value)}
                />
              </div>

              <button
                className="btn btn-primary"
                style={{ width: '100%', background: 'linear-gradient(135deg, #6366f1, #4f46e5)' }}
                onClick={handleGenerateAICopy}
                disabled={isGeneratingCopy}
              >
                {isGeneratingCopy ? '🤖 智能撰写中...' : '一键生成小红书文案'}
              </button>
            </div>
          )}

          {/* 3. Image Style Control Tab */}
          {uploadedImages.length > 0 && activeImage && (
            <div className="card">
              <h2 className="card-title">🎨 第三步：豆包 AI 画风重绘</h2>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
                选择一种艺术画风，同时重绘所勾选的 **{uploadedImages.filter(img => img.selected !== false).length}** 张图片：
              </p>
              
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem', marginBottom: '1rem' }}>
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

              {activeImage.styledSrc && (
                <button
                  className="btn btn-secondary"
                  style={{ width: '100%', fontSize: '0.8rem', padding: '0.5rem' }}
                  onClick={restoreToOriginal}
                >
                  ↩️ 恢复原图
                </button>
              )}
            </div>
          )}

          {/* 4. Cover Title Card Generator Tab */}
          {uploadedImages.length > 0 && (
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <h2 className="card-title" style={{ margin: 0 }}>🏷️ 第四步：爆款封面标题图</h2>
                <button
                  className="btn"
                  style={{
                    fontSize: '0.72rem',
                    padding: '0.25rem 0.6rem',
                    borderRadius: '14px',
                    background: 'linear-gradient(135deg, #ff2442, #ff6584)',
                    color: '#fff',
                    border: 'none',
                    fontWeight: 700,
                    cursor: 'pointer'
                  }}
                  onClick={handleGenerateCoverTitles}
                  disabled={isGeneratingCoverTitles}
                >
                  {isGeneratingCoverTitles ? '✨ 生成中...' : '✨ AI 提炼标题'}
                </button>
              </div>

              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
                选择底图与风格，生成醒目有吸引力的高号召力文字封面：
              </p>

              {/* 1. Pick Base Image */}
              <div style={{ marginBottom: '0.75rem' }}>
                <label className="form-label" style={{ fontSize: '0.78rem', display: 'block', marginBottom: '0.35rem', fontWeight: 600 }}>
                  1. 选择封面底图：
                </label>
                <div style={{ display: 'flex', gap: '0.5rem', overflowX: 'auto', paddingBottom: '0.25rem' }}>
                  {uploadedImages.map((img, idx) => (
                    <div
                      key={img.id}
                      onClick={() => {
                        setCoverImageIdx(idx);
                        setActivePreviewTab('cover');
                      }}
                      style={{
                        position: 'relative',
                        width: '56px',
                        height: '56px',
                        borderRadius: '8px',
                        overflow: 'hidden',
                        cursor: 'pointer',
                        border: coverImageIdx === idx ? '2.5px solid var(--xhs-red)' : '1.5px solid var(--border-color)',
                        boxShadow: coverImageIdx === idx ? '0 0 0 2px rgba(255, 36, 66, 0.25)' : 'none',
                        flexShrink: 0
                      }}
                    >
                      <img src={img.styledSrc || img.src} alt={`Cover base ${idx}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      {coverImageIdx === idx && (
                        <span style={{ position: 'absolute', bottom: '2px', right: '2px', background: 'var(--xhs-red)', color: '#fff', fontSize: '9px', padding: '0 3px', borderRadius: '4px', fontWeight: 800 }}>
                          底图
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* 2. Choose 3 Styles */}
              <div style={{ marginBottom: '0.75rem' }}>
                <label className="form-label" style={{ fontSize: '0.78rem', display: 'block', marginBottom: '0.35rem', fontWeight: 600 }}>
                  2. 选择封面风格（3款不同版式）：
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.4rem' }}>
                  {[
                    { id: 'magazine', name: '杂志速报', desc: '渐变暗角·亮黄胶囊标', icon: '📸' },
                    { id: 'minimal', name: '极简质感', desc: '白底卡片·质感留白', icon: '🖼️' },
                    { id: 'sticker', name: '潮酷贴纸', desc: '荧光纸胶带·斜角徽章', icon: '⚡' }
                  ].map((s) => (
                    <button
                      key={s.id}
                      onClick={() => {
                        setCoverStyle(s.id);
                        setActivePreviewTab('cover');
                      }}
                      style={{
                        padding: '0.5rem 0.25rem',
                        borderRadius: '10px',
                        border: coverStyle === s.id ? '2px solid var(--xhs-red)' : '1px solid var(--border-color)',
                        background: coverStyle === s.id ? 'var(--xhs-red-light)' : 'var(--bg-card)',
                        color: coverStyle === s.id ? 'var(--xhs-red)' : 'var(--text-primary)',
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: '2px'
                      }}
                    >
                      <span style={{ fontSize: '1.1rem' }}>{s.icon}</span>
                      <span style={{ fontSize: '0.75rem', fontWeight: 700 }}>{s.name}</span>
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', textAlign: 'center', lineHeight: 1.2 }}>
                        {s.desc}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* 3. AI Generated Candidates Chips (if available) */}
              {coverCandidates.length > 0 && (
                <div style={{ marginBottom: '0.75rem', padding: '0.5rem', background: 'var(--bg-main)', borderRadius: '8px' }}>
                  <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '0.35rem' }}>
                    ✨ 点击快速套用推荐文案：
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                    {coverCandidates.map((cand, cIdx) => (
                      <div
                        key={cIdx}
                        onClick={() => {
                          if (cand.tag) setCoverTag(cand.tag);
                          if (cand.title) setCoverTitle(cand.title);
                          if (cand.subtitle) setCoverSubtitle(cand.subtitle);
                          setActivePreviewTab('cover');
                        }}
                        style={{
                          padding: '0.35rem 0.5rem',
                          borderRadius: '6px',
                          background: (coverTitle === cand.title) ? 'rgba(255, 36, 66, 0.1)' : 'var(--bg-card)',
                          border: (coverTitle === cand.title) ? '1px solid var(--xhs-red)' : '1px solid var(--border-color)',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          fontSize: '0.75rem'
                        }}
                      >
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          <span style={{ fontWeight: 800, color: 'var(--xhs-red)', marginRight: '4px' }}>[{cand.tag}]</span>
                          <span style={{ fontWeight: 600 }}>{cand.title}</span>
                        </div>
                        <span style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', marginLeft: '6px', flexShrink: 0 }}>套用 ➔</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 4. Title Customization Inputs */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '0.75rem' }}>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '2px' }}>
                      🏷️ 胶囊角标
                    </label>
                    <input
                      type="text"
                      className="form-control"
                      value={coverTag}
                      onChange={(e) => setCoverTag(e.target.value)}
                      placeholder="如：⚡ BREAKING 速报"
                      style={{ width: '100%', fontSize: '0.78rem', padding: '0.35rem 0.5rem', boxSizing: 'border-box' }}
                    />
                  </div>
                  <div style={{ width: '105px' }}>
                    <label style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '2px' }}>
                      📍 文字位置
                    </label>
                    <select
                      className="form-control"
                      value={coverPosition}
                      onChange={(e) => setCoverPosition(e.target.value)}
                      style={{ width: '100%', fontSize: '0.78rem', padding: '0.35rem 0.25rem', boxSizing: 'border-box' }}
                    >
                      <option value="bottom">⬇️ 底部（推荐）</option>
                      <option value="center">⏺️ 居中</option>
                      <option value="top">⬆️ 顶部</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '2px' }}>
                    ✍️ 号召力主标题（醒目大字）
                  </label>
                  <input
                    type="text"
                    className="form-control"
                    value={coverTitle}
                    onChange={(e) => setCoverTitle(e.target.value)}
                    placeholder="如：3秒极限绝杀！/ 辛芷蕾同款装备"
                    style={{ width: '100%', fontSize: '0.82rem', fontWeight: 700, padding: '0.35rem 0.5rem', boxSizing: 'border-box' }}
                  />
                </div>

                <div>
                  <label style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '2px' }}>
                    📝 关键副标题（补充说明）
                  </label>
                  <input
                    type="text"
                    className="form-control"
                    value={coverSubtitle}
                    onChange={(e) => setCoverSubtitle(e.target.value)}
                    placeholder="如：2026 UTMB OCC 女子前三 / 亲测不踩雷"
                    style={{ width: '100%', fontSize: '0.78rem', padding: '0.35rem 0.5rem', boxSizing: 'border-box' }}
                  />
                </div>
              </div>

              <button
                className="btn btn-primary"
                style={{ width: '100%', padding: '0.55rem', fontSize: '0.82rem', background: 'linear-gradient(135deg, #ff2442, #e01b38)', border: 'none', fontWeight: 700 }}
                onClick={() => {
                  setActivePreviewTab('cover');
                  downloadCoverImage();
                }}
              >
                📥 立即导出高清封面标题图
              </button>
            </div>
          )}
        </section>

        {/* Right Preview & Result Column */}
        <section className="preview-panel" style={{ flex: '1.4' }}>
          {uploadedImages.length > 0 && activeImage ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', width: '100%' }}>

              {/* View Switcher Tabs */}
              <div style={{ display: 'flex', gap: '0.5rem', background: 'var(--bg-card)', padding: '0.35rem', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
                <button
                  className={`btn ${activePreviewTab === 'styled' ? 'btn-primary' : 'btn-secondary'}`}
                  style={{
                    flex: 1,
                    padding: '0.45rem',
                    fontSize: '0.82rem',
                    fontWeight: 700,
                    borderRadius: '8px',
                    background: activePreviewTab === 'styled' ? 'linear-gradient(135deg, #4f46e5, #6366f1)' : 'transparent',
                    border: 'none',
                    color: activePreviewTab === 'styled' ? '#fff' : 'var(--text-secondary)'
                  }}
                  onClick={() => setActivePreviewTab('styled')}
                >
                  🖼️ 画风重绘预览
                </button>
                <button
                  className={`btn ${activePreviewTab === 'cover' ? 'btn-primary' : 'btn-secondary'}`}
                  style={{
                    flex: 1,
                    padding: '0.45rem',
                    fontSize: '0.82rem',
                    fontWeight: 700,
                    borderRadius: '8px',
                    background: activePreviewTab === 'cover' ? 'linear-gradient(135deg, #ff2442, #ff4d66)' : 'transparent',
                    border: 'none',
                    color: activePreviewTab === 'cover' ? '#fff' : 'var(--text-secondary)'
                  }}
                  onClick={() => setActivePreviewTab('cover')}
                >
                  🏷️ 封面标题图预览
                </button>
              </div>

              {activePreviewTab === 'cover' ? (
                /* Cover Title Card Preview Card */
                <div className="card" style={{ padding: '1rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                    <div>
                      <h3 style={{ fontSize: '1rem', fontWeight: 700, display: 'inline-block', marginRight: '8px' }}>🏷️ 封面标题图效果</h3>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        ({coverStyle === 'magazine' ? '📸 杂志速报风' : coverStyle === 'minimal' ? '🖼️ 极简质感风' : '⚡ 潮酷贴纸风'})
                      </span>
                    </div>
                    <button 
                      className="btn btn-primary" 
                      style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem', background: 'linear-gradient(135deg, #ff2442, #ff4d66)', border: 'none', fontWeight: '600' }} 
                      onClick={downloadCoverImage}
                    >
                      📥 导出高清封面图
                    </button>
                  </div>
                  
                  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', background: '#0e1117', borderRadius: 'var(--radius-md)', overflow: 'hidden', padding: '0.75rem', minHeight: '380px' }}>
                    {coverPreviewUri ? (
                      <img 
                        src={coverPreviewUri} 
                        alt="Cover Preview" 
                        style={{ maxWidth: '100%', maxHeight: '520px', objectFit: 'contain', borderRadius: 'var(--radius-sm)', boxShadow: '0 8px 24px rgba(0,0,0,0.35)' }}
                      />
                    ) : (
                      <div className="spinner"></div>
                    )}
                  </div>
                </div>
              ) : (
                /* Image Preview Card (Style Transfer) */
                <div className="card" style={{ padding: '1rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                    <h3 style={{ fontSize: '1rem', fontWeight: 700 }}>🖼️ 风格化效果预览</h3>
                    <button 
                      className="btn btn-primary" 
                      style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem', background: 'linear-gradient(135deg, #ff2442, #ff4d66)', border: 'none', fontWeight: '600' }} 
                      onClick={downloadActiveImage}
                    >
                      📥 导出当前图片
                    </button>
                  </div>
                  
                  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', background: '#f3f4f6', borderRadius: 'var(--radius-md)', overflow: 'hidden', padding: '1rem', minHeight: '300px' }}>
                    <img 
                      src={activeImage.styledSrc || activeImage.src} 
                      alt="Preview" 
                      style={{ maxWidth: '100%', maxHeight: '500px', objectFit: 'contain', borderRadius: 'var(--radius-sm)', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}
                    />
                  </div>
                </div>
              )}

              {/* Copywriting Result Card */}
              {generatedCopyOptions.length > 0 && (
                <div className="card" style={{ padding: '1rem' }}>
                  <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '0.75rem' }}>✍️ AI 生成文案</h3>
                  
                  <div style={{ display: 'flex', gap: '0.25rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem', marginBottom: '0.75rem' }}>
                    {generatedCopyOptions.map((opt, idx) => (
                      <button
                        key={idx}
                        className={`btn ${activeCopyOptionIdx === idx ? 'btn-primary' : 'btn-secondary'}`}
                        style={{ flex: 1, padding: '0.4rem 0.25rem', fontSize: '0.75rem' }}
                        onClick={() => applyCopyOption(idx)}
                      >
                        方案 {idx + 1}
                      </button>
                    ))}
                  </div>

                  <div style={{ background: 'var(--bg-main)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', position: 'relative', marginBottom: '0.75rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                      <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-secondary)' }}>
                        ✨ 效果预览：
                      </span>
                      <div style={{ display: 'flex', gap: '0.4rem' }}>
                        <button
                          className="btn btn-secondary"
                          style={{ padding: '0.2rem 0.5rem', fontSize: '0.7rem' }}
                          onClick={() => {
                            const opt = generatedCopyOptions[activeCopyOptionIdx];
                            const fullText = `【${opt.title}】\n\n${opt.body}\n\n${opt.tags}`;
                            navigator.clipboard.writeText(fullText);
                            alert('文案已复制！');
                          }}
                        >
                          📋 复制文案
                        </button>
                        <button
                          className="btn btn-secondary"
                          style={{ padding: '0.2rem 0.5rem', fontSize: '0.7rem' }}
                          onClick={exportReportCard}
                        >
                          📸 导出报告卡片
                        </button>

                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', marginBottom: '0.5rem', paddingBottom: '0.5rem', borderBottom: '1px dotted var(--border-color)' }}>
                      <span style={{ fontSize: '0.85rem', fontWeight: 800, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>标题：</span>
                      <input 
                        type="text" 
                        value={aiTitle} 
                        onChange={(e) => setAiTitle(e.target.value)}
                        style={{
                          flex: 1,
                          border: 'none',
                          outline: 'none',
                          background: 'transparent',
                          fontFamily: 'inherit',
                          fontSize: '0.85rem',
                          fontWeight: 800,
                          color: 'var(--text-primary)',
                          padding: '2px 4px',
                          borderRadius: '4px',
                          transition: 'background 0.2s',
                          borderBottom: '1px dashed transparent'
                        }}
                        placeholder="在此输入标题..."
                        onMouseEnter={(e) => e.target.style.borderBottom = '1px dashed var(--text-secondary)'}
                        onMouseLeave={(e) => e.target.style.borderBottom = '1px dashed transparent'}
                        onFocus={(e) => {
                          e.target.style.backgroundColor = 'var(--bg-main)';
                          e.target.style.borderBottom = '1px dashed var(--text-secondary)';
                        }}
                        onBlur={(e) => {
                          e.target.style.backgroundColor = 'transparent';
                          e.target.style.borderBottom = '1px dashed transparent';
                        }}
                      />
                    </div>
                    <div style={{ position: 'relative' }}>
                      <textarea 
                        value={aiBody} 
                        onChange={(e) => setAiBody(e.target.value)}
                        rows={10}
                        style={{
                          width: '100%',
                          outline: 'none',
                          background: 'transparent',
                          fontFamily: 'inherit',
                          fontSize: '0.8rem',
                          color: 'var(--text-primary)',
                          lineHeight: '1.5',
                          resize: 'vertical',
                          padding: '4px',
                          boxSizing: 'border-box',
                          borderRadius: '4px',
                          transition: 'background 0.2s',
                          border: '1px dashed transparent'
                        }}
                        placeholder="在此输入文案正文与标签..."
                        onMouseEnter={(e) => e.target.style.border = '1px dashed var(--text-secondary)'}
                        onMouseLeave={(e) => e.target.style.border = '1px dashed transparent'}
                        onFocus={(e) => {
                          e.target.style.backgroundColor = 'var(--bg-main)';
                          e.target.style.border = '1px dashed var(--text-secondary)';
                        }}
                        onBlur={(e) => {
                          e.target.style.backgroundColor = 'transparent';
                          e.target.style.border = '1px dashed transparent';
                        }}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="card" style={{ width: '100%', height: '350px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6c757d' }}>
              <span>🌅 请先在左侧上传并选择照片进行风格重绘</span>
            </div>
          )}
        </section>

      </main>


    </div>
  );
}

export default App;
