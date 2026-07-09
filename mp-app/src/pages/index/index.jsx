import React, { useState } from 'react';
import Taro, { useLoad } from '@tarojs/taro';
import { View, Text, Image, Button, Input, Textarea, ScrollView, Canvas } from '@tarojs/components';
import './index.css';

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
    if (Taro.getEnv() === Taro.ENV_TYPE.WEB) {
      // H5 Web platform
      const fileObj = tempFile.originalFile || tempFile.file;
      if (fileObj) {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = (err) => reject(err);
        reader.readAsDataURL(fileObj);
      } else if (tempFile.tempFilePath.startsWith('data:')) {
        resolve(tempFile.tempFilePath);
      } else {
        fetch(tempFile.tempFilePath)
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
        filePath: tempFile.tempFilePath,
        encoding: 'base64',
        success: (res) => {
          let mime = 'image/jpeg';
          const pathLower = tempFile.tempFilePath.toLowerCase();
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
const saveOrDownloadImage = async (base64, activeIdx, activeStyle) => {
  if (Taro.getEnv() === Taro.ENV_TYPE.WEB) {
    // Web environment: use anchor link download
    const link = document.createElement('a');
    link.href = base64;
    link.download = `styled-${activeStyle || 'original'}-${activeIdx + 1}-${Date.now()}.jpg`;
    link.click();
    Taro.showToast({ title: '已下载到本地', icon: 'success' });
  } else {
    // WeChat Mini Program environment
    const matches = /data:image\/(\w+);base64,(.*)/.exec(base64);
    if (!matches) {
      Taro.showToast({ title: '数据格式错误', icon: 'none' });
      return;
    }
    const format = matches[1] || 'jpg';
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
  
  // General UI States
  const [isLoading, setIsLoading] = useState(false);
  const [aiOperationName, setAiOperationName] = useState(''); 
  const [errorMsg, setErrorMsg] = useState('');
  const [isEditorExpanded, setIsEditorExpanded] = useState(false);

  useLoad(() => {
    console.log('Taro Page loaded. API Base set to:', API_BASE);
  });

  // Handle photos upload using Taro unified chooseMedia API
  const handlePhotosUpload = () => {
    const availableSlots = 4 - uploadedImages.length;
    if (availableSlots <= 0) {
      Taro.showToast({ title: '最多支持上传 4 张图片！', icon: 'none' });
      return;
    }

    Taro.chooseMedia({
      count: availableSlots,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: async (res) => {
        Taro.showLoading({ title: '加载图片中...' });
        setErrorMsg('');
        const newImages = [];
        for (const tempFile of res.tempFiles) {
          try {
            const id = Math.random().toString(36).substring(2, 9);
            const base64Src = await readImageAsBase64(tempFile);
            newImages.push({
              id,
              src: base64Src,
              styledSrc: null,
              activeStyle: null
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
      },
      fail: (err) => {
        console.warn('Choose media failed or cancelled:', err);
      }
    });
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

  // Call Doubao style transfer model via backend
  const handleAIStyleTransfer = async (styleName) => {
    const activeImage = uploadedImages[activeIdx];
    if (!activeImage) return;
    
    setIsLoading(true);
    const styleLabel = styleName === 'clay' ? '泥塑黏土化' : styleName === 'japanese-film' ? '日式胶片风' : '吉卜力卡通化';
    setAiOperationName(`豆包模型 ${styleLabel}`);
    setErrorMsg('');

    try {
      const inputSrc = activeImage.styledSrc || activeImage.src;
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
          setIsLoading(false);
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
    const selectedStyle = copyStyle === '自定义' ? customCopyStyle.trim() : copyStyle;
    if (copyStyle === '自定义' && !selectedStyle) {
      setErrorMsg('请输入自定义风格，例如“数码测评”');
      return;
    }

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
        keywords: copyKeywords
      },
      success: (res) => {
        setIsGeneratingCopy(false);
        if (res.statusCode !== 200) {
          const errData = res.data || {};
          setErrorMsg(errData.error || '文案生成失败');
          return;
        }

        const result = res.data || {};
        if (result.options && result.options.length > 0) {
          setGeneratedCopyOptions(result.options);
          setActiveCopyOptionIdx(0);
          
          setAiTitle(result.options[0].title);
          setAiBody(`${result.options[0].body}\n\n${result.options[0].tags}`);
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
    setAiBody(`${opt.body}\n\n${opt.tags}`);
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
                {['探店', '旅行心情', '自定义'].map((style) => (
                  <View
                    key={style}
                    className={`segmented-item ${copyStyle === style ? 'active' : ''}`}
                    onClick={() => setCopyStyle(style)}
                  >
                    {style === '探店' && '🛍️ 探店'}
                    {style === '旅行心情' && '✈️ 旅行'}
                    {style === '自定义' && '⚙️ 自定义'}
                  </View>
                ))}
              </View>

              {copyStyle === '自定义' && (
                <Input
                  type="text"
                  className="modern-input"
                  placeholder="请输入您的自定义风格，例如“数码测评”..."
                  value={customCopyStyle}
                  onInput={(e) => setCustomCopyStyle(e.detail.value)}
                />
              )}

              <Textarea
                className="modern-textarea"
                placeholder="添加亮点描述（选填，如拍摄主题、天气或特定亮点）..."
                value={copyKeywords}
                onInput={(e) => setCopyKeywords(e.detail.value)}
              />

              <Button
                className="btn-pill"
                onClick={handleGenerateAICopy}
                disabled={isGeneratingCopy}
              >
                {isGeneratingCopy ? '🤖 智能撰写中...' : '🚀 一键生成爆款小红书文案'}
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

              {/* Collapsible micro-editor to keep layout concise */}
              <View className="accordion">
                <View 
                  className="accordion-trigger" 
                  onClick={() => setIsEditorExpanded(!isEditorExpanded)}
                >
                  <Text className="accordion-title">✏️ 对文案进行微调修改</Text>
                  <Text className="accordion-icon">{isEditorExpanded ? '▲' : '▼'}</Text>
                </View>
                
                {isEditorExpanded && (
                  <View className="accordion-content">
                    <View>
                      <Text className="form-label">微调标题：</Text>
                      <Input 
                        type="text" 
                        className="modern-input" 
                        value={aiTitle} 
                        onInput={(e) => setAiTitle(e.detail.value)}
                      />
                    </View>
                    <View>
                      <Text className="form-label">微调正文与标签：</Text>
                      <Textarea 
                        className="modern-textarea" 
                        style={{ height: '120px' }}
                        value={aiBody} 
                        onInput={(e) => setAiBody(e.detail.value)}
                      />
                    </View>
                  </View>
                )}
              </View>

            </View>
          )}

        </View>
      </View>
    </View>
  );
}
