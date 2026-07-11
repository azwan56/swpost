import React, { useState, useRef } from 'react';
import * as piexif from 'piexifjs';

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

// Helper: Extract Date, Time, Location, Device from EXIF data on client side using piexifjs
const extractExifClient = (base64Image) => {
  if (!base64Image) return null;
  try {
    const exifObj = piexif.load(base64Image);
    
    // Extract DateTime
    let dateTime = null;
    if (exifObj["Exif"] && exifObj["Exif"][piexif.ExifIFD.DateTimeOriginal]) {
      dateTime = exifObj["Exif"][piexif.ExifIFD.DateTimeOriginal];
    } else if (exifObj["0th"] && exifObj["0th"][piexif.ImageIFD.DateTime]) {
      dateTime = exifObj["0th"][piexif.ImageIFD.DateTime];
    }
    
    // Extract Device
    let device = null;
    const make = exifObj["0th"] && exifObj["0th"][piexif.ImageIFD.Make];
    const model = exifObj["0th"] && exifObj["0th"][piexif.ImageIFD.Model];
    if (model) {
      device = model;
    } else if (make) {
      device = make;
    }
    
    // Extract GPS Coordinates
    let gps = null;
    if (exifObj["GPS"]) {
      const lat = exifObj["GPS"][piexif.GPSIFD.GPSLatitude];
      const latRef = exifObj["GPS"][piexif.GPSIFD.GPSLatitudeRef];
      const lon = exifObj["GPS"][piexif.GPSIFD.GPSLongitude];
      const lonRef = exifObj["GPS"][piexif.GPSIFD.GPSLongitudeRef];
      
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
          latRef: latRef || 'N',
          lonRef: lonRef || 'E'
        };
      }
    }
    
    return {
      dateTime,
      gps,
      device
    };
  } catch (err) {
    console.log('[EXIF Client Extract] No EXIF found or failed to parse:', err.message);
    return null;
  }
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
  
  // Video States
  const [isGeneratingVideo, setIsGeneratingVideo] = useState(false);
  const [videoUrl, setVideoUrl] = useState(null);
  const [showVideoModal, setShowVideoModal] = useState(false);
  const [videoProgress, setVideoProgress] = useState('');

  // General UI States
  const [isLoading, setIsLoading] = useState(false);
  const [aiOperationName, setAiOperationName] = useState(''); 
  const [errorMsg, setErrorMsg] = useState('');

  // Refs
  const fileInputRef = useRef(null);

  // Handle multiple photos upload
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

      const dimensions = await new Promise((resolve) => {
        const tempImg = new Image();
        tempImg.onload = () => resolve({ w: tempImg.width, h: tempImg.height });
        tempImg.onerror = () => resolve({ w: 1024, h: 1024 });
        tempImg.src = src;
      });

      const exif = extractExifClient(src);

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
    }

    const updatedImages = [...uploadedImages, ...newImages];
    setUploadedImages(updatedImages);
    setActiveIdx(uploadedImages.length);
  };

  // Remove uploaded image
  const removeUploadedImage = (id, e) => {
    e.stopPropagation();
    const filtered = uploadedImages.filter(img => img.id !== id);
    setUploadedImages(filtered);
    
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
        const compressedImage = await resizeImageBase64(inputSrc, 2048, 0.9);

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
      // Compress all images to 512px low quality in parallel to speed up vision analysis
      const compressedImagesForCopy = await Promise.all(
        uploadedImages.map(async (img) => {
          const src = img.styledSrc || img.src;
          return await resizeImageBase64(src, 512, 0.7);
        })
      );

      // Send the pre-extracted EXIF data directly to the server (lightweight JSON list)
      const exifDataList = uploadedImages.map(img => img.exif);

      const res = await fetch(`${API_BASE}/api/ai/generate-copy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          style: selectedStyle,
          keywords: copyKeywords,
          images: compressedImagesForCopy,
          exifList: exifDataList
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
        
        // Populate inputs
        const firstOpt = result.options[0];
        setAiTitle(firstOpt.title);
        const cleanTags = (firstOpt.tags && firstOpt.tags !== 'undefined') ? firstOpt.tags : '';
        setAiBody(firstOpt.body + (cleanTags && !firstOpt.body.includes(cleanTags) ? `\n\n${cleanTags}` : ''));
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
  };

  // Helper: Clean text from emojis, formatting, and hashtags for a clean TTS read
  const cleanTextForTTS = (rawText) => {
    if (!rawText) return '';
    // Remove hashtags (e.g. #tag)
    let text = rawText.replace(/#[a-zA-Z0-9_\u4e00-\u9fa5]+/g, '');
    // Remove brackets like 【爆款标题】
    text = text.replace(/【[^】]+】/g, '');
    // Remove common emojis
    text = text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|\u200D|[\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDC00-\uDFFF]/g, '');
    // Clean spaces and special symbols
    text = text.replace(/[\s\r\n]+/g, '，').trim();
    // Dedup commas
    text = text.replace(/，+/g, '，').replace(/^，|，$/g, '');
    return text;
  };

  // Helper: Split copy text into count buckets (subtitles) matching each slide duration
  const splitTextIntoSegments = (text, count) => {
    if (!text) return Array(count).fill('');
    const sentences = text.split(/[，。！？；\n\r]/).map(s => s.trim()).filter(s => s.length > 0);
    if (sentences.length === 0) return Array(count).fill('');
    
    const result = Array(count).fill('');
    const sentencesPerBucket = Math.ceil(sentences.length / count);
    for (let i = 0; i < count; i++) {
      const start = i * sentencesPerBucket;
      const end = Math.min(start + sentencesPerBucket, sentences.length);
      result[i] = sentences.slice(start, end).join('，');
    }
    return result;
  };

  // Helper: Export full multi-modal analysis report (copywriting + original images + EXIF details) as a beautiful card image
  const exportReportCard = async () => {
    if (uploadedImages.length === 0) return;
    const opt = generatedCopyOptions[activeCopyOptionIdx];
    if (!opt) {
      alert('请先生成 AI 文案后再导出报告卡片！');
      return;
    }

    setIsGeneratingVideo(true);
    setVideoProgress('正在生成分析报告图片...');

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
        imagesHeight = validImages.length <= 2 ? 300 : 580;
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
      ctx.fillText('SHANTIE AI', 40, 75);

      ctx.fillStyle = '#6366F1';
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText('· 智能图文分析报告 ·', 210, 70);

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

      // 4. Draw Image Grid
      if (validImages.length > 0) {
        const gap = 15;
        const drawCoverImage = (context, img, x, y, w, h) => {
          context.save();
          context.beginPath();
          context.roundRect(x, y, w, h, 8);
          context.clip();

          const imgRatio = img.width / img.height;
          const targetRatio = w / h;
          let sx, sy, sWidth, sHeight;

          if (imgRatio > targetRatio) {
            sHeight = img.height;
            sWidth = img.height * targetRatio;
            sx = (img.width - sWidth) / 2;
            sy = 0;
          } else {
            sWidth = img.width;
            sHeight = img.width / targetRatio;
            sx = 0;
            sy = (img.height - sHeight) / 2;
          }

          context.drawImage(img, sx, sy, sWidth, sHeight, x, y, w, h);
          context.restore();
        };

        if (validImages.length === 1) {
          drawCoverImage(ctx, validImages[0], 40, currentY, 720, 270);
          currentY += 270 + 20;
        } else if (validImages.length === 2) {
          const imgW = 350;
          const imgH = 260;
          drawCoverImage(ctx, validImages[0], 40, currentY, imgW, imgH);
          drawCoverImage(ctx, validImages[1], 40 + imgW + gap, currentY, imgW, imgH);
          currentY += imgH + 20;
        } else {
          const imgW = 350;
          const imgH = 260;
          // Row 1
          drawCoverImage(ctx, validImages[0], 40, currentY, imgW, imgH);
          if (validImages[1]) drawCoverImage(ctx, validImages[1], 40 + imgW + gap, currentY, imgW, imgH);
          currentY += imgH + gap;
          // Row 2
          if (validImages[2]) drawCoverImage(ctx, validImages[2], 40, currentY, imgW, imgH);
          if (validImages[3]) drawCoverImage(ctx, validImages[3], 40 + imgW + gap, currentY, imgW, imgH);
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
      setIsGeneratingVideo(false);
      setVideoProgress('');
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
          // Build EXIF object from the structured exif data passed by the server
          // (We cannot piexif.load() from the styled image because AI models return PNG, not JPEG)
          const exifObj = { "0th": {}, "Exif": {}, "GPS": {}, "Interop": {}, "1st": {}, "thumbnail": null };
          
          // Software tag (ASCII only)
          exifObj["0th"][piexif.ImageIFD.Software] = "Shantie AI";
          
          if (exif) {
            // Write DateTime
            if (exif.dateTime) {
              exifObj["0th"][piexif.ImageIFD.DateTime] = exif.dateTime;
              exifObj["Exif"][piexif.ExifIFD.DateTimeOriginal] = exif.dateTime;
              exifObj["Exif"][piexif.ExifIFD.DateTimeDigitized] = exif.dateTime;
            }
            
            // Write Device/Camera
            if (exif.device) {
              exifObj["0th"][piexif.ImageIFD.Model] = exif.device;
            }
            
            // Write GPS coordinates
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
                
                exifObj["GPS"][piexif.GPSIFD.GPSLatitude] = [[latDeg, 1], [latMin, 1], [latSec, 100]];
                exifObj["GPS"][piexif.GPSIFD.GPSLatitudeRef] = exif.gps.latRef || (latVal >= 0 ? "N" : "S");
                exifObj["GPS"][piexif.GPSIFD.GPSLongitude] = [[lonDeg, 1], [lonMin, 1], [lonSec, 100]];
                exifObj["GPS"][piexif.GPSIFD.GPSLongitudeRef] = exif.gps.lonRef || (lonVal >= 0 ? "E" : "W");
              }
            }
          }
          
          const exifBytes = piexif.dump(exifObj);
          // watermarkedDataUri is 'data:image/jpeg;base64,...' from canvas — valid input for piexif.insert
          const finalDataUri = piexif.insert(exifBytes, watermarkedDataUri);
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

  // Main Canvas & Web Audio MediaRecorder short video generator
  const generateComicVideo = async () => {
    if (uploadedImages.length === 0) {
      setErrorMsg('请先上传至少一张图片进行漫画重绘！');
      return;
    }
    
    setIsGeneratingVideo(true);
    setVideoProgress('正在合成语音配音...');
    setErrorMsg('');

    let ttsAudioSource = null;
    let bgmAudioSource = null;
    let audioCtx = null;
    let animationFrameId = null;

    try {
      // 1. Get styled images list
      const imagesToUse = uploadedImages.map(img => img.styledSrc || img.src);
      const textToSpeak = (aiTitle ? `${aiTitle}，` : '') + aiBody;
      const cleanedText = cleanTextForTTS(textToSpeak);

      // 2. Fetch TTS audio stream from backend
      const ttsRes = await fetch(`${API_BASE}/api/ai/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: cleanedText, voice: 'longanhuan' })
      });

      if (!ttsRes.ok) {
        throw new Error('获取语音配音失败，请检查网络或后端配置');
      }

      const audioBlob = await ttsRes.blob();
      setVideoProgress('正在载入配音与背景音乐...');

      // 3. Setup AudioContext and decode TTS Audio
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const audioArrayBuffer = await audioBlob.arrayBuffer();
      const ttsAudioBuffer = await audioCtx.decodeAudioData(audioArrayBuffer);
      const totalDuration = ttsAudioBuffer.duration; // in seconds

      // 4. Fetch and decode BGM (with safe fallback for remote HTML/SPA routing)
      let bgmAudioBuffer = null;
      try {
        const bgmRes = await fetch('/bgm.mp3');
        if (bgmRes.ok) {
          const contentType = bgmRes.headers.get('content-type') || '';
          if (!contentType.includes('text/html')) {
            const bgmBlob = await bgmRes.blob();
            const bgmArrayBuffer = await bgmBlob.arrayBuffer();
            bgmAudioBuffer = await audioCtx.decodeAudioData(bgmArrayBuffer);
          } else {
            console.warn('[VideoGen] bgm.mp3 returned text/html (SPA fallback), skipping BGM.');
          }
        } else {
          console.warn('[VideoGen] bgm.mp3 returned HTTP ' + bgmRes.status + ', skipping BGM.');
        }
      } catch (bgmErr) {
        console.warn('[VideoGen] Background music failed to load or decode, continuing without BGM:', bgmErr);
      }

      // 5. Load HTML Images
      setVideoProgress('正在载入重绘图片...');
      const loadedImages = await Promise.all(
        imagesToUse.map((src) => {
          return new Promise((resolve, reject) => {
            const img = new Image();
            if (src && !src.startsWith('data:')) {
              img.crossOrigin = 'anonymous';
            }
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('部分图片载入失败'));
            img.src = src;
          });
        })
      );

      // 6. Initialize Audio Mixing Nodes
      ttsAudioSource = audioCtx.createBufferSource();
      ttsAudioSource.buffer = ttsAudioBuffer;

      const audioDest = audioCtx.createMediaStreamDestination();

      // Connect TTS voiceover nodes
      ttsAudioSource.connect(audioDest);
      ttsAudioSource.connect(audioCtx.destination);

      // Connect BGM nodes only if successfully loaded and decoded
      if (bgmAudioBuffer) {
        bgmAudioSource = audioCtx.createBufferSource();
        bgmAudioSource.buffer = bgmAudioBuffer;
        bgmAudioSource.loop = true;

        const bgmGain = audioCtx.createGain();
        bgmGain.gain.value = 0.15; // Set BGM volume to 15%

        bgmAudioSource.connect(bgmGain);
        bgmGain.connect(audioDest);
        bgmGain.connect(audioCtx.destination);
      }

      // 7. Setup Canvas Rendering
      setVideoProgress('正在合成与录制视频中...');
      const canvas = document.createElement('canvas');
      canvas.width = 720;
      canvas.height = 1280; // 9:16 portrait
      const ctx = canvas.getContext('2d');

      const slideDuration = totalDuration / loadedImages.length;
      const subtitleSegments = splitTextIntoSegments(aiBody, loadedImages.length);

      // 8. Capture streams and configure MediaRecorder
      const canvasStream = canvas.captureStream(30); // 30 FPS
      const mixedStream = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...audioDest.stream.getAudioTracks()
      ]);

      let selectedMime = 'video/webm;codecs=vp9';
      if (MediaRecorder.isTypeSupported('video/mp4;codecs=h264')) {
        selectedMime = 'video/mp4;codecs=h264';
      } else if (MediaRecorder.isTypeSupported('video/webm;codecs=h264')) {
        selectedMime = 'video/webm;codecs=h264';
      }

      const mediaRecorder = new MediaRecorder(mixedStream, {
        mimeType: selectedMime,
        videoBitsPerSecond: 2500000 // 2.5 Mbps
      });

      const videoChunks = [];
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) videoChunks.push(e.data);
      };

      // Create a promise to wait for recording completion
      const recordingPromise = new Promise((resolve) => {
        mediaRecorder.onstop = () => {
          const videoBlob = new Blob(videoChunks, { type: selectedMime.split(';')[0] });
          const url = URL.createObjectURL(videoBlob);
          resolve(url);
        };
      });

      // 9. Start synthesis loop and audio sources
      mediaRecorder.start();
      ttsAudioSource.start(0);
      if (bgmAudioSource) {
        bgmAudioSource.start(0);
      }

      const startTime = audioCtx.currentTime;

      // Subtitle wrap helper
      const drawWrappedText = (context, text, x, y, maxWidth, lineHeight) => {
        const words = text.split('');
        let line = '';
        let testLine = '';
        let currentY = y;

        for (let n = 0; n < words.length; n++) {
          testLine = line + words[n];
          const metrics = context.measureText(testLine);
          const testWidth = metrics.width;
          if (testWidth > maxWidth && n > 0) {
            context.fillText(line, x, currentY);
            line = words[n];
            currentY += lineHeight;
          } else {
            line = testLine;
          }
        }
        context.fillText(line, x, currentY);
      };

      // Synthesis frame render
      const drawFrame = () => {
        const elapsed = audioCtx.currentTime - startTime;
        
        if (elapsed >= totalDuration) {
          // Audio synthesis finished, stop everything
          mediaRecorder.stop();
          ttsAudioSource.stop();
          if (bgmAudioSource) {
            bgmAudioSource.stop();
          }
          audioCtx.close();
          return;
        }

        // Determine current slide
        const currentIdx = Math.min(Math.floor(elapsed / slideDuration), loadedImages.length - 1);
        const currentImg = loadedImages[currentIdx];
        const progressInSlide = (elapsed % slideDuration) / slideDuration;

        // Draw and zoom/pan image (Ken Burns Effect)
        ctx.fillStyle = '#0f0f12';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Aspect ratio cover calculation
        const scale = 1.05 + progressInSlide * 0.12; // Zoom-in from 1.05 to 1.17
        
        const canvasRatio = canvas.width / canvas.height;
        const imgRatio = currentImg.width / currentImg.height;
        let drawWidth, drawHeight;

        if (imgRatio > canvasRatio) {
          drawHeight = canvas.height * scale;
          drawWidth = drawHeight * imgRatio;
        } else {
          drawWidth = canvas.width * scale;
          drawHeight = drawWidth / imgRatio;
        }

        // Pan slightly downwards
        const xOffset = (canvas.width - drawWidth) / 2;
        const yOffset = (canvas.height - drawHeight) / 2 + (progressInSlide * 30); // 30px pan

        ctx.drawImage(currentImg, xOffset, yOffset, drawWidth, drawHeight);

        // Subtitle card background
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.fillRect(0, canvas.height - 240, canvas.width, 240);

        // Title text rendering
        ctx.font = 'bold 36px sans-serif';
        ctx.fillStyle = '#ff3366'; // Pinkish color for title
        ctx.textAlign = 'center';
        ctx.fillText(aiTitle || '你拍照我生文', canvas.width / 2, canvas.height - 180);

        // Caption text rendering
        ctx.font = '28px sans-serif';
        ctx.fillStyle = '#ffffff';
        const currentSubtitle = subtitleSegments[currentIdx] || '';
        drawWrappedText(ctx, currentSubtitle, canvas.width / 2, canvas.height - 120, canvas.width - 100, 38);

        // Loop next frame
        animationFrameId = requestAnimationFrame(drawFrame);
      };

      // Start drawing frames
      drawFrame();

      // Wait for output Blob URL
      const finalVideoUrl = await recordingPromise;
      setVideoUrl(finalVideoUrl);
      setShowVideoModal(true);

    } catch (err) {
      console.error('[VideoGen] Error generating video:', err);
      setErrorMsg(err.message || '视频生成出错，请重试');
      
      // Cleanup audio context if created
      if (audioCtx) {
        try { audioCtx.close(); } catch (_) {}
      }
    } finally {
      setIsGeneratingVideo(false);
      setVideoProgress('');
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
    }
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
            <h3 className="workflow-title" style={{ textAlign: 'center', justifyContent: 'center' }}>✨ 三步体验：拍、变、生！</h3>
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
                  <strong>🎨 艺术重绘（变）</strong>
                  <span>一键转换为治愈吉卜力、软萌泥塑或复古日式胶片风，并可保存高清原图。</span>
                </div>
              </div>
              <div className="workflow-step">
                <span className="step-num">3</span>
                <div className="step-content">
                  <strong>✍️ 一键生成（生）</strong>
                  <span>AI 结合画面时空智能撰写 3 款不同风格的社交爆款文案，复制即可去朋友圈、小红书、Ins 发文！</span>
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

          {/* 2. Image Style Control Tab */}
          {uploadedImages.length > 0 && activeImage && (
            <div className="card">
              <h2 className="card-title">🎨 豆包 AI 画风重绘</h2>
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

          {/* 3. AI Copy Generator Tab */}
          {uploadedImages.length > 0 && (
            <div className="card">
              <h2 className="card-title">✍️ 小红书爆款文案生成</h2>
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
        </section>

        {/* Right Preview & Result Column */}
        <section className="preview-panel" style={{ flex: '1.4' }}>
          {uploadedImages.length > 0 && activeImage ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', width: '100%' }}>
              
              {/* Image Preview Card */}
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
                        <button
                          className="btn"
                          disabled={isGeneratingVideo}
                          style={{ 
                            padding: '0.2rem 0.5rem', 
                            fontSize: '0.7rem', 
                            background: 'linear-gradient(135deg, #a855f7, #6366f1)', 
                            color: '#ffffff',
                            border: 'none',
                            cursor: isGeneratingVideo ? 'not-allowed' : 'pointer'
                          }}
                          onClick={generateComicVideo}
                        >
                          {isGeneratingVideo ? `🎬 ${videoProgress}` : '🎬 生成漫画视频'}
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
                          border: 'none',
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

      {/* Video Preview Modal */}
      {showVideoModal && videoUrl && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.85)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 9999,
          padding: '1rem',
          backdropFilter: 'blur(8px)'
        }}>
          <div className="card" style={{
            width: '100%',
            maxWidth: '420px',
            backgroundColor: 'var(--card-bg)',
            borderRadius: '16px',
            padding: '1.25rem',
            boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.3)',
            display: 'flex',
            flexDirection: 'column',
            gap: '1rem',
            alignItems: 'center',
            border: '1px solid var(--border-color)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
              <h3 style={{ fontSize: '1rem', margin: 0, fontWeight: 700 }}>🎬 漫画短视频预览</h3>
              <button 
                onClick={() => setShowVideoModal(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '1.25rem',
                  cursor: 'pointer',
                  color: 'var(--text-secondary)'
                }}
              >
                ✕
              </button>
            </div>
            
            <video 
              src={videoUrl} 
              controls 
              autoPlay 
              loop
              style={{
                width: '100%',
                borderRadius: '8px',
                aspectRatio: '9/16',
                objectFit: 'cover',
                backgroundColor: '#000000',
                boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)'
              }}
            />

            <div style={{ display: 'flex', gap: '0.75rem', width: '100%' }}>
              <button
                className="btn btn-secondary"
                style={{ flex: 1, padding: '0.5rem' }}
                onClick={() => setShowVideoModal(false)}
              >
                关闭
              </button>
              <a
                href={videoUrl}
                download={`${aiTitle || '漫画视频'}.mp4`}
                className="btn btn-primary"
                style={{ 
                  flex: 1, 
                  padding: '0.5rem', 
                  textAlign: 'center', 
                  textDecoration: 'none',
                  background: 'linear-gradient(135deg, #a855f7, #6366f1)',
                  color: '#ffffff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                📥 下载视频
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
