import React, { useState } from 'react';
import Taro, { useLoad } from '@tarojs/taro';
import { View, Text, Image, Button, Input, Textarea, ScrollView, Canvas } from '@tarojs/components';
import './index.css';
import logoImg from '../../assets/logo.jpg';
import piexif from 'piexifjs';

// Helper: Resize and compress base64 image (Web only)
const resizeImageBase64 = (dataUrl, maxDim = 1600, quality = 0.85) => {
  return new Promise((resolve) => {
    if (Taro.getEnv() !== Taro.ENV_TYPE.WEB || !dataUrl || dataUrl.length < 1500000) {
      resolve(dataUrl);
      return;
    }
    const img = new global.Image();
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
      resolve(compressed);
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
};

// Helper: Read a selected media file as base64 (Unified for Web and Mini Program)
const readImageAsBase64 = (tempFile) => {
  return new Promise((resolve, reject) => {
    const path = tempFile.path || tempFile.tempFilePath || '';
    if (Taro.getEnv() === Taro.ENV_TYPE.WEB) {
      // H5 Web platform
      const fileObj = tempFile.originalFile || tempFile.file;
      if (fileObj) {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = (err) => reject(err);
        reader.readAsDataURL(fileObj);
      } else if (path && path.startsWith('data:')) {
        resolve(path);
      } else {
        fetch(path)
          .then(res => res.blob())
          .then(blob => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.readAsDataURL(blob);
          })
          .catch(reject);
      }
    } else {
      // WeChat Mini Program platform
      Taro.getFileSystemManager().readFile({
        filePath: path,
        encoding: 'base64',
        success: (res) => {
          let mime = 'image/jpeg';
          const pathLower = path.toLowerCase();
          if (pathLower.endsWith('.png')) mime = 'image/png';
          if (pathLower.endsWith('.gif')) mime = 'image/gif';
          resolve(`data:${mime};base64,${res.data}`);
        },
        fail: (err) => reject(err)
      });
    }
  });
};

// Helper: Save styled image to album (Mini Program) or download directly (Web)
const saveOrDownloadImage = async (base64OrFilePath, activeIdx, activeStyle) => {
  if (Taro.getEnv() === Taro.ENV_TYPE.WEB) {
    // Web environment: use anchor link download
    const link = document.createElement('a');
    link.href = base64OrFilePath;
    link.download = `styled-${activeStyle || 'original'}-${activeIdx + 1}-${Date.now()}.jpg`;
    link.click();
    Taro.showToast({ title: '已下载到本地', icon: 'success' });
  } else {
    // WeChat Mini Program environment
    // Check if it's already a local temp file path (e.g. wxfile://usr/...)
    const isLocalPath = typeof base64OrFilePath === 'string' && (
      base64OrFilePath.startsWith('wxfile://') ||
      base64OrFilePath.startsWith('http://usr/') ||
      base64OrFilePath.startsWith('https://usr/') ||
      base64OrFilePath.startsWith('/') ||
      base64OrFilePath.includes('temp') ||
      base64OrFilePath.includes('watermarked')
    );

    if (isLocalPath) {
      Taro.showLoading({ title: '正在保存...' });
      Taro.saveImageToPhotosAlbum({
        filePath: base64OrFilePath,
        success: () => {
          Taro.hideLoading();
          Taro.showToast({ title: '已保存至系统相册', icon: 'success' });
        },
        fail: (err) => {
          Taro.hideLoading();
          console.error('Save to album failed:', err);
          Taro.showModal({
            title: '保存失败',
            content: '需要您授权保存图片到相册权限，是否去开启？',
            success: (res) => {
              if (res.confirm) {
                Taro.openSetting();
              }
            }
          });
        }
      });
      return;
    }

    const matches = /data:image\/(\w+);base64,(.*)/.exec(base64OrFilePath);
    if (!matches) {
      Taro.showToast({ title: '数据格式错误', icon: 'none' });
      return;
    }
    let format = matches[1] || 'jpg';
    if (format === 'jpeg') format = 'jpg';
    const bodyData = matches[2];
    const filePath = `${Taro.env.USER_DATA_PATH}/temp_styled_${activeIdx}_${Date.now()}.${format}`;
    const fs = Taro.getFileSystemManager();
    
    Taro.showLoading({ title: '正在保存...' });
    fs.writeFile({
      filePath,
      data: bodyData,
      encoding: 'base64',
      success: () => {
        Taro.saveImageToPhotosAlbum({
          filePath,
          success: () => {
            Taro.hideLoading();
            Taro.showToast({ title: '已保存至系统相册', icon: 'success' });
          },
          fail: (err) => {
            Taro.hideLoading();
            console.error('Save to album failed:', err);
            // Request setting permission if denied
            Taro.showModal({
              title: '保存失败',
              content: '需要您授权保存图片到相册权限，是否去开启？',
              success: (res) => {
                if (res.confirm) {
                  Taro.openSetting();
                }
              }
            });
          }
        });
      },
      fail: (err) => {
        Taro.hideLoading();
        console.error('Write file failed:', err);
        Taro.showToast({ title: '保存图片失败', icon: 'none' });
      }
    });
  }
};

// Helper: Draw visual photography watermark (Leica-style white border at bottom)
const applyVisualWatermark = (base64Image, styleName, modelName, exif) => {
  return new Promise((resolve) => {
    let canvas, ctx;
    const isWeb = Taro.getEnv() === Taro.ENV_TYPE.WEB;
    
    if (isWeb) {
      const img = new global.Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        canvas = document.createElement('canvas');
        ctx = canvas.getContext('2d');
        drawWatermarkOnCanvas(canvas, ctx, img, styleName, modelName, exif, resolve, base64Image);
      };
      img.onerror = () => resolve(base64Image);
      img.src = base64Image;
    } else {
      try {
        const tempCanvas = Taro.createOffscreenCanvas({ type: '2d', width: 100, height: 100 });
        const img = tempCanvas.createImage();
        img.onload = () => {
          const w = img.width;
          const h = img.height;
          const watermarkHeight = Math.round(h * 0.08);
          
          canvas = Taro.createOffscreenCanvas({ type: '2d', width: w, height: h + watermarkHeight });
          canvas.width = w;
          canvas.height = h + watermarkHeight;
          ctx = canvas.getContext('2d');
          drawWatermarkOnCanvas(canvas, ctx, img, styleName, modelName, exif, resolve, base64Image);
        };
        img.onerror = (err) => {
          console.error('Image load failed in Mini Program offscreen canvas:', err);
          resolve(base64Image);
        };
        img.src = base64Image;
      } catch (err) {
        console.error('Failed to create offscreen canvas:', err);
        resolve(base64Image);
      }
    }
  });
};

const drawWatermarkOnCanvas = (canvas, ctx, img, styleName, modelName, exif, resolve, fallbackBase64) => {
  try {
    const isWeb = Taro.getEnv() === Taro.ENV_TYPE.WEB;
    const watermarkHeight = Math.round(img.height * 0.08);
    
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    ctx.drawImage(img, 0, 0);
    
    ctx.fillStyle = '#1a1a1a';
    
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
    
    ctx.textAlign = 'left';
    ctx.font = `bold ${fontSizeMain}px sans-serif`;
    ctx.fillText(leftTitle, paddingX, img.height + watermarkHeight * 0.42);
    
    ctx.fillStyle = '#666666';
    ctx.font = `${fontSizeSub}px sans-serif`;
    ctx.fillText(leftSubtitle, paddingX, img.height + watermarkHeight * 0.72);
    
    ctx.textAlign = 'right';
    ctx.fillStyle = '#1a1a1a';
    ctx.font = `bold ${fontSizeMain}px sans-serif`;
    
    let rightTitle = 'Doubao Seedream 5.0';
    if (modelName === 'dashscope-wanx') {
      rightTitle = 'DashScope Wanx 2.1';
    }
    ctx.fillText(rightTitle, canvas.width - paddingX, img.height + watermarkHeight * 0.42);
    
    let dateStr = '';
    if (exif && exif.dateTime) {
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
    
    if (isWeb) {
      const watermarkedDataUri = canvas.toDataURL('image/jpeg', 0.95);
      try {
        const exifObj = { "0th": {}, "Exif": {}, "GPS": {}, "Interop": {}, "1st": {}, "thumbnail": null };
        exifObj["0th"][piexif.ImageIFD.Software] = "Shantie AI";
        
        if (exif) {
          if (exif.dateTime) {
            exifObj["0th"][piexif.ImageIFD.DateTime] = exif.dateTime;
            exifObj["Exif"][piexif.ExifIFD.DateTimeOriginal] = exif.dateTime;
            exifObj["Exif"][piexif.ExifIFD.DateTimeDigitized] = exif.dateTime;
          }
          if (exif.device) {
            exifObj["0th"][piexif.ImageIFD.Model] = exif.device;
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
              
              exifObj["GPS"][piexif.GPSIFD.GPSLatitude] = [[latDeg, 1], [latMin, 1], [latSec, 100]];
              exifObj["GPS"][piexif.GPSIFD.GPSLatitudeRef] = exif.gps.latRef || (latVal >= 0 ? "N" : "S");
              exifObj["GPS"][piexif.GPSIFD.GPSLongitude] = [[lonDeg, 1], [lonMin, 1], [lonSec, 100]];
              exifObj["GPS"][piexif.GPSIFD.GPSLongitudeRef] = exif.gps.lonRef || (lonVal >= 0 ? "E" : "W");
            }
          }
        }
        
        const exifBytes = piexif.dump(exifObj);
        const finalDataUri = piexif.insert(exifBytes, watermarkedDataUri);
        resolve(finalDataUri);
      } catch (exifErr) {
        console.warn('[Watermark EXIF] Failed to inject EXIF:', exifErr);
        resolve(watermarkedDataUri);
      }
    } else {
      // === Mini Program EXIF-safe export pipeline ===
      // Problem: WeChat OffscreenCanvas.toDataURL('image/jpeg') often returns PNG
      // silently, and piexif can ONLY inject EXIF into JPEG format.
      // Solution: Write canvas output to temp file → force-convert to JPEG via
      // Taro.compressImage → read JPEG → inject EXIF → write final file.

      let rawDataUri;
      try {
        rawDataUri = canvas.toDataURL('image/jpeg', 0.95);
      } catch (e) {
        console.error('[Watermark] toDataURL failed:', e);
        resolve(fallbackBase64);
        return;
      }

      const rawMatch = /data:image\/([\w+]+);base64,(.+)/.exec(rawDataUri);
      if (!rawMatch) {
        console.error('[Watermark] Could not parse toDataURL output');
        resolve(fallbackBase64);
        return;
      }

      const rawFormat = rawMatch[1]; // 'jpeg' or 'png'
      const rawBody = rawMatch[2];
      const rawExt = (rawFormat === 'png') ? 'png' : 'jpg';
      const rawTempPath = `${Taro.env.USER_DATA_PATH}/raw_canvas_${Date.now()}.${rawExt}`;

      console.log(`[Watermark] toDataURL returned format: ${rawFormat}, writing to ${rawTempPath}`);

      try {
        const fs = Taro.getFileSystemManager();
        fs.writeFileSync(rawTempPath, rawBody, 'base64');

        // Force convert to JPEG using Taro.compressImage (works regardless of input format)
        Taro.compressImage({
          src: rawTempPath,
          quality: 95,
          success: (compRes) => {
            try {
              const jpegTempPath = compRes.tempFilePath;
              console.log('[Watermark] compressImage produced JPEG at:', jpegTempPath);

              // Read the guaranteed-JPEG file as base64
              const jpegBase64 = fs.readFileSync(jpegTempPath, 'base64');
              const jpegDataUri = `data:image/jpeg;base64,${jpegBase64}`;

              // Build and inject EXIF metadata
              let finalDataUri = jpegDataUri;
              if (exif) {
                try {
                  const exifObj = { "0th": {}, "Exif": {}, "GPS": {}, "Interop": {}, "1st": {}, "thumbnail": null };
                  exifObj["0th"][piexif.ImageIFD.Software] = "Shantie AI";

                  if (exif.dateTime) {
                    exifObj["0th"][piexif.ImageIFD.DateTime] = exif.dateTime;
                    exifObj["Exif"][piexif.ExifIFD.DateTimeOriginal] = exif.dateTime;
                    exifObj["Exif"][piexif.ExifIFD.DateTimeDigitized] = exif.dateTime;
                  }
                  if (exif.device) {
                    exifObj["0th"][piexif.ImageIFD.Model] = exif.device;
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

                      exifObj["GPS"][piexif.GPSIFD.GPSLatitude] = [[latDeg, 1], [latMin, 1], [latSec, 100]];
                      exifObj["GPS"][piexif.GPSIFD.GPSLatitudeRef] = exif.gps.latRef || (latVal >= 0 ? "N" : "S");
                      exifObj["GPS"][piexif.GPSIFD.GPSLongitude] = [[lonDeg, 1], [lonMin, 1], [lonSec, 100]];
                      exifObj["GPS"][piexif.GPSIFD.GPSLongitudeRef] = exif.gps.lonRef || (lonVal >= 0 ? "E" : "W");
                    }
                  }

                  const exifBytes = piexif.dump(exifObj);
                  finalDataUri = piexif.insert(exifBytes, jpegDataUri);
                  console.log('[Watermark EXIF] ✅ Successfully injected EXIF into JPEG');
                } catch (exifErr) {
                  console.warn('[Watermark EXIF] Failed to inject EXIF:', exifErr);
                }
              }

              // Write the EXIF-injected JPEG to a final local file
              const finalMatch = /data:image\/jpeg;base64,(.+)/.exec(finalDataUri);
              if (finalMatch) {
                const finalPath = `${Taro.env.USER_DATA_PATH}/watermarked_${Date.now()}.jpg`;
                fs.writeFileSync(finalPath, finalMatch[1], 'base64');
                console.log('[Watermark] ✅ Final EXIF image written to:', finalPath);
                resolve(finalPath);
              } else {
                console.warn('[Watermark] Final data URI parse failed, using compressImage output');
                resolve(jpegTempPath);
              }
            } catch (innerErr) {
              console.error('[Watermark] Post-compress processing failed:', innerErr);
              resolve(compRes.tempFilePath);
            }
          },
          fail: (compErr) => {
            console.warn('[Watermark] compressImage failed, using raw canvas output:', compErr);
            // Fallback: try direct EXIF injection if the raw output happens to be JPEG
            if (rawFormat === 'jpeg' && exif) {
              try {
                const exifObj = { "0th": {}, "Exif": {}, "GPS": {}, "Interop": {}, "1st": {}, "thumbnail": null };
                exifObj["0th"][piexif.ImageIFD.Software] = "Shantie AI";
                if (exif.dateTime) {
                  exifObj["0th"][piexif.ImageIFD.DateTime] = exif.dateTime;
                  exifObj["Exif"][piexif.ExifIFD.DateTimeOriginal] = exif.dateTime;
                }
                if (exif.device) exifObj["0th"][piexif.ImageIFD.Model] = exif.device;
                const exifBytes = piexif.dump(exifObj);
                const finalUri = piexif.insert(exifBytes, rawDataUri);
                const m = /data:image\/jpeg;base64,(.+)/.exec(finalUri);
                if (m) {
                  const fallbackPath = `${Taro.env.USER_DATA_PATH}/watermarked_fb_${Date.now()}.jpg`;
                  fs.writeFileSync(fallbackPath, m[1], 'base64');
                  resolve(fallbackPath);
                  return;
                }
              } catch (e) { /* ignore */ }
            }
            resolve(rawTempPath);
          }
        });
      } catch (writeErr) {
        console.error('[Watermark] Failed to write raw canvas temp file:', writeErr);
        resolve(fallbackBase64);
      }
    }
  } catch (err) {
    console.error('Error drawing watermark:', err);
    resolve(fallbackBase64);
  }
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

export default function Index() {
  // Define backend API endpoint. 
  // IMPORTANT: For WeChat Mini Program local debugging on real phones, 
  // replace 'localhost' with your computer's local IP address (e.g., 'http://192.168.1.100:5001').
  // For production, configure the HTTPS domain.
  let API_BASE = 'http://localhost:5001';
  if (Taro.getEnv() === Taro.ENV_TYPE.WEB) {
    API_BASE = (window.location.origin === 'http://localhost:3000' || window.location.origin === 'http://localhost:5173')
      ? 'http://localhost:5001'
      : window.location.origin;
  } else {
    // WeChat Mini Program default local fallback IP (replace with your developer computer IP)
    API_BASE = 'https://vanpower.net/swpost'; 
  }

  // App States
  const [uploadedImages, setUploadedImages] = useState([]); // [{ id, src, styledSrc, activeStyle }]
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
  
  // General UI States
  const [showWelcome, setShowWelcome] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [aiOperationName, setAiOperationName] = useState(''); 
  const [errorMsg, setErrorMsg] = useState('');
  const [isEditorExpanded, setIsEditorExpanded] = useState(false);

  useLoad(() => {
    console.log('Taro Page loaded. API Base set to:', API_BASE);
  });

  // Handle photos upload using Taro chooseImage API (Forces original selection to preserve EXIF)
  const handlePhotosUpload = () => {
    const availableSlots = 4 - uploadedImages.length;
    if (availableSlots <= 0) {
      Taro.showToast({ title: '最多支持上传 4 张图片！', icon: 'none' });
      return;
    }

    Taro.chooseImage({
      count: availableSlots,
      sizeType: ['original'], // Forced to original, otherwise WeChat strips EXIF
      sourceType: ['album', 'camera'],
      success: async (res) => {
        Taro.showLoading({ title: '加载图片中...' });
        setErrorMsg('');
        const newImages = [];
        for (const tempFile of res.tempFiles) {
          try {
            const id = Math.random().toString(36).substring(2, 9);
            const path = tempFile.path;
            
            // 1. Read original file as base64 to extract EXIF data before compression (since compression strips EXIF metadata)
            const originalBase64 = await readImageAsBase64(tempFile);
            const exif = extractExifClient(originalBase64);

            // 2. Native compress for WeChat Mini Program to avoid oversized payload and API failure
            let finalPath = path;
            if (Taro.getEnv() !== Taro.ENV_TYPE.WEB) {
              finalPath = await new Promise((resolve) => {
                Taro.compressImage({
                  src: path,
                  quality: 80,
                  success: (cRes) => resolve(cRes.tempFilePath),
                  fail: (err) => {
                    console.warn('Taro.compressImage failed, fallback to original:', err);
                    resolve(path);
                  }
                });
              });
            }

            const base64Src = await readImageAsBase64({ path: finalPath });
            newImages.push({
              id,
              src: base64Src,
              styledSrc: null,
              activeStyle: null,
              exif
            });
          } catch (err) {
            console.error('Failed to read image:', err);
            setErrorMsg('部分图片加载失败，请重试');
          }
        }
        setUploadedImages(prev => {
          const next = [...prev, ...newImages];
          setActiveIdx(prev.length);
          return next;
        });
        Taro.hideLoading();
        
        setTimeout(() => {
          const hasExifCount = newImages.filter(img => img.exif !== null).length;
          Taro.showToast({
            title: `已导入 ${newImages.length} 张图片，其中 ${hasExifCount} 张成功获取 EXIF`,
            icon: 'none',
            duration: 4000
          });
        }, 300);
      },
      fail: (err) => {
        console.warn('Choose image failed or cancelled:', err);
      }
    });
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
  };

  // Call Doubao style transfer model via backend
  const handleAIStyleTransfer = async (styleName) => {
    const activeImage = uploadedImages[activeIdx];
    if (!activeImage) return;
    
    setIsLoading(true);
    const styleLabel = styleName === 'clay' ? '泥塑黏土化' : styleName === 'japanese-film' ? '日式胶片风' : '吉卜力卡通化';
    setAiOperationName(`豆包模型 ${styleLabel}`);
    setErrorMsg('');

    try {
      // Always use the original base64 src for style transfer input.
      // styledSrc may be a local file path (wxfile://...) which cannot be sent to the backend.
      const inputSrc = activeImage.src;
      // Compress if on Web platform
      const compressedImage = await resizeImageBase64(inputSrc, 1600, 0.85);

      Taro.request({
        url: `${API_BASE}/api/ai/style-transfer`,
        method: 'POST',
        header: {
          'Content-Type': 'application/json'
        },
        data: {
          image: compressedImage,
          style: styleName
        },
        success: (res) => {
          if (res.statusCode !== 200) {
            const errData = res.data || {};
            setErrorMsg(errData.error || '风格化重绘失败');
            setIsLoading(false);
            return;
          }

          const result = res.data || {};
          
          Taro.showLoading({ title: '添加照片水印...' });
          applyVisualWatermark(result.image, styleName, result.model, activeImage.exif)
            .then(watermarkedImage => {
              setUploadedImages(prev => prev.map((img, idx) => {
                if (idx === activeIdx) {
                  return { 
                    ...img, 
                    styledSrc: watermarkedImage,
                    activeStyle: styleName
                  };
                }
                return img;
              }));
              Taro.hideLoading();
              setIsLoading(false);
            })
            .catch(err => {
              console.error('Watermark drawing failed, using fallback:', err);
              setUploadedImages(prev => prev.map((img, idx) => {
                if (idx === activeIdx) {
                  return { 
                    ...img, 
                    styledSrc: result.image,
                    activeStyle: styleName
                  };
                }
                return img;
              }));
              Taro.hideLoading();
              setIsLoading(false);
            });
        },
        fail: (err) => {
          console.error(err);
          setErrorMsg('连接后端接口失败，请检查网络或配置。');
          setIsLoading(false);
        }
      });
    } catch (err) {
      console.error(err);
      setErrorMsg(`AI 风格化（${styleLabel}）失败。`);
      setIsLoading(false);
    }
  };

  // Restore styled image to original
  const restoreToOriginal = () => {
    setUploadedImages(prev => prev.map((img, idx) => {
      if (idx === activeIdx) {
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
  const handleGenerateAICopy = () => {
    const selectedStyle = copyStyle;

    setIsGeneratingCopy(true);
    setErrorMsg('');

    Taro.request({
      url: `${API_BASE}/api/ai/generate-copy`,
      method: 'POST',
      header: {
        'Content-Type': 'application/json'
      },
      data: {
        style: selectedStyle,
        keywords: copyKeywords,
        images: uploadedImages.map(img => img.src),
        exifList: uploadedImages.map(img => img.exif),
        visualDescriptions: cachedVisualDescriptions
      },
      success: (res) => {
        setIsGeneratingCopy(false);
        if (res.statusCode !== 200) {
          const errData = res.data || {};
          setErrorMsg(errData.error || '文案生成失败');
          return;
        }

        const result = res.data || {};
        if (result.visualDescriptions) {
          setCachedVisualDescriptions(result.visualDescriptions);
        }

        if (result.options && result.options.length > 0) {
          setGeneratedCopyOptions(result.options);
          setActiveCopyOptionIdx(0);
          
          const firstOpt = result.options[0];
          setAiTitle(firstOpt.title);
          const cleanTags = (firstOpt.tags && firstOpt.tags !== 'undefined') ? firstOpt.tags : '';
          setAiBody(firstOpt.body + (cleanTags && !firstOpt.body.includes(cleanTags) ? `\n\n${cleanTags}` : ''));
        } else {
          setErrorMsg('未返回有效的文案选项');
        }
      },
      fail: (err) => {
        console.error('AICopy error:', err);
        setErrorMsg('连接后端接口失败，请检查网络与配置。');
        setIsGeneratingCopy(false);
      }
    });
  };

  const applyCopyOption = (idx) => {
    if (!generatedCopyOptions[idx]) return;
    setActiveCopyOptionIdx(idx);
    const opt = generatedCopyOptions[idx];
    setAiTitle(opt.title);
    const cleanTags = (opt.tags && opt.tags !== 'undefined') ? opt.tags : '';
    setAiBody(opt.body + (cleanTags && !opt.body.includes(cleanTags) ? `\n\n${cleanTags}` : ''));
  };

  // Copy copywriting to clipboard
  const handleCopyClipboard = () => {
    const opt = generatedCopyOptions[activeCopyOptionIdx];
    if (!opt) return;
    const fullText = `【${aiTitle}】\n\n${aiBody}`;
    
    Taro.setClipboardData({
      data: fullText,
      success: () => {
        Taro.showToast({ title: '文案已复制', icon: 'success' });
      }
    });
  };

  const activeImage = uploadedImages[activeIdx];

  if (showWelcome) {
    return (
      <View className="welcome-screen">
        <View className="welcome-container">
          <View className="welcome-logo-section">
            <Image src={logoImg} className="welcome-logo-img" mode="widthFix" />
          </View>
          <Text className="welcome-title">你拍照我生文</Text>
          <Text className="welcome-subtitle">AI 智能画风转换与爆款文案助手</Text>
          
          <View className="welcome-workflow">
            <Text className="workflow-title" style={{ textAlign: 'center', width: '100%', display: 'block' }}>✨ 三步体验：拍、变、生！</Text>
            <View className="workflow-steps">
              <View className="workflow-step">
                <Text className="step-num">1</Text>
                <View className="step-content">
                  <Text className="step-content-title">📸 上传照片（拍）</Text>
                  <Text className="step-content-desc">随手添加 1-4 张照片，系统自动解析读取 EXIF 时间与 GPS 位置。</Text>
                </View>
              </View>
              <View className="workflow-step">
                <Text className="step-num">2</Text>
                <View className="step-content">
                  <Text className="step-content-title">🎨 艺术重绘（变）</Text>
                  <Text className="step-content-desc">一键转换为治愈吉卜力、软萌泥塑或复古日式胶片风，并可保存高清原图。</Text>
                </View>
              </View>
              <View className="workflow-step">
                <Text className="step-num">3</Text>
                <View className="step-content">
                  <Text className="step-content-title">✍️ 一键生成（生）</Text>
                  <Text className="step-content-desc">AI 结合画面时空撰写 3 款不同风格的爆款文案，复制即可去朋友圈、小红书、Ins 发文！</Text>
                </View>
              </View>
            </View>
          </View>
          
          <Button className="welcome-enter-btn" onClick={() => setShowWelcome(false)}>
            开启灵感之旅 🚀
          </Button>
        </View>
      </View>
    );
  }

  return (
    <View className="app-container">

      {/* Loading Overlay */}
      {isLoading && (
        <View className="loading-overlay">
          <View className="spinner"></View>
          <View className="loading-text-wave">
            {(aiOperationName + '... 请稍候...').split('').map((char, index) => (
              <Text 
                key={index} 
                className="wave-char" 
                style={{ animationDelay: `${index * 0.08}s` }}
              >
                {char === ' ' ? '\u00A0' : char}
              </Text>
            ))}
          </View>
        </View>
      )}

      {/* Main Workspace - Using natural page scrolling */}
      <View className="workspace-scroll">
        <View className="workspace">
          


          {errorMsg && (
            <View className="error-banner">
              <Text>⚠️ {errorMsg}</Text>
              <Text className="error-close" onClick={() => setErrorMsg('')}>×</Text>
            </View>
          )}

          {/* Step 1: Upload & Thumbnail Manager */}
          <View className="card">
            <View style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
              <Text className="card-title">📸 第一步：管理您的图片</Text>
              {uploadedImages.length > 0 && (
                <Button 
                  className="btn-clear"
                  onClick={clearAllImages}
                >
                  🧹 清空全部
                </Button>
              )}
            </View>
            
            {uploadedImages.length === 0 ? (
              <View className="upload-zone" onClick={handlePhotosUpload}>
                <Text className="upload-icon">📤</Text>
                <Text style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>点击添加 1-4 张待转换图片</Text>
              </View>
            ) : (
              <View className="thumbnails-container">
                <View className="thumbnails-header">
                  <Text style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>已上传 {uploadedImages.length} 张图片（点击切换）：</Text>
                </View>
                <View className="thumbnails-list">
                  {uploadedImages.map((img, idx) => (
                    <View 
                      key={img.id}
                      className={`thumbnail-wrapper ${activeIdx === idx ? 'active' : ''}`}
                      onClick={() => setActiveIdx(idx)}
                    >
                      <Image className="thumbnail-img" src={img.styledSrc || img.src} mode="aspectFill" />
                      <View 
                        className="thumbnail-remove"
                        onClick={(e) => removeUploadedImage(img.id, e)}
                      >
                        ✕
                      </View>
                    </View>
                  ))}
                  {uploadedImages.length < 4 && (
                    <View className="thumbnail-add" onClick={handlePhotosUpload}>
                      <Text>+</Text>
                    </View>
                  )}
                </View>
              </View>
            )}
          </View>

          {/* Step 2: Preview & Style Selection */}
          {uploadedImages.length > 0 && activeImage && (
            <View className="card">
              <Text className="card-title">🖼️ 第二步：画面预览与风格化</Text>
              
              {/* Image preview */}
              <View className="preview-card">
                <Image
                  className="preview-image"
                  src={activeImage.styledSrc || activeImage.src}
                  mode="widthFix"
                  showMenuByLongpress
                />
                <View className="preview-actions-overlay">
                  {activeImage.styledSrc ? (
                    <Button className="preview-action-btn btn-restore" onClick={restoreToOriginal}>
                      ↩️ 恢复原图
                    </Button>
                  ) : (
                    <Text style={{ color: '#fff', fontSize: '0.65rem', fontWeight: 600 }}>原图预览</Text>
                  )}
                  <Button
                    className="preview-action-btn btn-export"
                    onClick={() => saveOrDownloadImage(activeImage.styledSrc || activeImage.src, activeIdx, activeImage.activeStyle)}
                  >
                    📥 导出图片
                  </Button>
                </View>
              </View>

              {Taro.getEnv() !== Taro.ENV_TYPE.WEB && (
                <View className="exif-tip-box">
                  <Text className="exif-tip-text">
                    💡 提示：微信系统“保存相册”按钮会过滤图片 EXIF 拍照参数。如需 100% 写入并保留 EXIF 信息，请【长按上方预览图】并选择【保存图片】。
                  </Text>
                </View>
              )}

              {/* Styled Picker Cards */}
              <View className="style-picker-grid">
                <View 
                  className={`style-picker-card ${activeImage.activeStyle === 'cartoon' ? 'active' : ''}`}
                  onClick={() => handleAIStyleTransfer('cartoon')}
                >
                  <Text className="style-picker-emoji">🎨</Text>
                  <Text className="style-picker-name">吉卜力</Text>
                  <Text className="style-picker-desc">温暖动漫色彩</Text>
                </View>
                
                <View 
                  className={`style-picker-card ${activeImage.activeStyle === 'clay' ? 'active' : ''}`}
                  onClick={() => handleAIStyleTransfer('clay')}
                >
                  <Text className="style-picker-emoji">🧸</Text>
                  <Text className="style-picker-name">泥塑黏土</Text>
                  <Text className="style-picker-desc">软萌立体质感</Text>
                </View>
                
                <View 
                  className={`style-picker-card ${activeImage.activeStyle === 'japanese-film' ? 'active' : ''}`}
                  onClick={() => handleAIStyleTransfer('japanese-film')}
                >
                  <Text className="style-picker-emoji">🎞️</Text>
                  <Text className="style-picker-name">日式胶片</Text>
                  <Text className="style-picker-desc">复古胶片颗粒</Text>
                </View>
              </View>
            </View>
          )}

          {/* Step 3: AI Copywriting Generator */}
          {uploadedImages.length > 0 && (
            <View className="card">
              <Text className="card-title">✍️ 第三步：生成爆款文案</Text>
              
              <View className="segmented-control">
                {['探店', '旅行心情', '运动'].map((style) => (
                  <View
                    key={style}
                    className={`segmented-item ${copyStyle === style ? 'active' : ''}`}
                    onClick={() => setCopyStyle(style)}
                  >
                    {style === '探店' && '🛍️ 探店'}
                    {style === '旅行心情' && '✈️ 旅行'}
                    {style === '运动' && '🏃 运动'}
                  </View>
                ))}
              </View>

              <Textarea
                className="modern-textarea"
                style={{ height: '80px', minHeight: '80px' }}
                placeholder="添加亮点描述（选填，如拍摄主题、天气或特定亮点）..."
                value={copyKeywords}
                onInput={(e) => setCopyKeywords(e.detail.value)}
              />

              <Button
                className="btn-pill"
                onClick={handleGenerateAICopy}
                disabled={isGeneratingCopy}
              >
                {isGeneratingCopy ? '🤖 智能撰写中...' : '一键生成爆款小红书文案'}
              </Button>
            </View>
          )}

          {/* Step 4: Copywriting Result Showcase */}
          {uploadedImages.length > 0 && generatedCopyOptions.length > 0 && (
            <View className="card">
              <Text className="card-title">✨ AI 生成结果</Text>
              
              <View className="result-tabs">
                {generatedCopyOptions.map((opt, idx) => (
                  <View
                    key={idx}
                    className={`result-tab-item ${activeCopyOptionIdx === idx ? 'active' : ''}`}
                    onClick={() => applyCopyOption(idx)}
                  >
                    方案 {idx + 1}
                  </View>
                ))}
              </View>

              <View className="paper-card">
                <View className="paper-header">
                  <Text className="paper-title">小红书格式预览</Text>
                  <Button className="btn-copy-action" onClick={handleCopyClipboard}>
                    📋 复制文案
                  </Button>
                </View>
                
                <View className="paper-content">
                  <Text style={{ fontWeight: 'bold', display: 'block', marginBottom: '0.4rem', borderBottom: '1px dotted var(--border-color)', paddingBottom: '0.3rem' }}>
                    标题：{aiTitle}
                  </Text>
                  <Text style={{ whiteSpace: 'pre-wrap', display: 'block' }}>
                    {aiBody}
                  </Text>
                </View>
              </View>



            </View>
          )}

        </View>
      </View>
    </View>
  );
}
