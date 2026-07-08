import React, { useState } from 'react';
import Taro, { useLoad } from '@tarojs/taro';
import { View, Text, Image, Button, Input, Textarea, ScrollView } from '@tarojs/components';
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
const saveOrDownloadImage = (base64, activeIdx) => {
  if (Taro.getEnv() === Taro.ENV_TYPE.WEB) {
    // Web environment: use anchor link download
    const link = document.createElement('a');
    link.href = base64;
    link.download = `xhs-style-${activeIdx + 1}-${Date.now()}.jpg`;
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
      {/* Header */}
      <View className="app-header">
        <View className="logo-section">
          <View className="logo-badge">书</View>
          <View className="logo-text">
            <Text className="h1-text" style={{ fontSize: '1.2rem', fontWeight: 'bold', display: 'block' }}>小红书画风与文案生成器</Text>
            <Text className="sub-text" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>豆包大模型一键风格化 & AI爆款文案</Text>
          </View>
        </View>
        
        {uploadedImages.length > 0 && (
          <Button 
            className="btn btn-secondary btn-clear"
            style={{ fontWeight: 600, fontSize: '0.75rem', padding: '0.3rem 0.6rem', minHeight: 'auto', width: 'auto', display: 'inline-block' }}
            onClick={clearAllImages}
          >
            🧹 清空全部
          </Button>
        )}
      </View>

      {/* Loading Overlay */}
      {isLoading && (
        <View className="loading-overlay" style={{ position: 'fixed', width: '100vw', height: '100vh', top: 0, left: 0, zIndex: 1000, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.6)' }}>
          <View className="spinner"></View>
          <Text className="loading-text" style={{ fontSize: '1rem', fontWeight: 600, color: '#ffffff', marginTop: '1rem' }}>{aiOperationName}... 请稍候...</Text>
        </View>
      )}

      {/* Main Workspace Scroll Wrapper */}
      <ScrollView scrollY className="workspace-scroll" style={{ height: 'calc(100vh - 70px)' }}>
        <View className={`workspace ${uploadedImages.length > 0 ? 'has-images' : ''}`}>
          
          {/* Left Control Panel */}
          <View className="editor-panel">
            {errorMsg && (
              <View className="error-banner">
                <Text>⚠️ {errorMsg}</Text>
                <Text className="error-close" onClick={() => setErrorMsg('')}>×</Text>
              </View>
            )}

            {/* 1. Upload Section */}
            <View className="card">
              <Text className="card-title" style={{ fontSize: '0.95rem', fontWeight: 'bold', marginBottom: '0.75rem', display: 'block' }}>📸 上传照片 (最多4张)</Text>
              <View style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {uploadedImages.length < 4 && (
                  <View 
                    className="upload-zone"
                    onClick={handlePhotosUpload}
                    style={{ padding: '1.5rem 1rem', border: '2px dashed var(--border-color)', borderRadius: 'var(--radius-md)', display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer' }}
                  >
                    <Text className="upload-icon" style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>📤</Text>
                    <Text style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>点击添加 1-4 张图片</Text>
                  </View>
                )}

                {/* Uploaded Thumbnails Manager */}
                {uploadedImages.length > 0 && (
                  <View>
                    <Text style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.5rem', display: 'block' }}>点击选中某张照片进行画风转换：</Text>
                    <View className="uploaded-images-list" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                      {uploadedImages.map((img, idx) => (
                        <View 
                          key={img.id}
                          className={`uploaded-image-thumbnail ${activeIdx === idx ? 'active' : ''}`}
                          onClick={() => setActiveIdx(idx)}
                          style={{ position: 'relative', width: '60px', height: '60px', borderRadius: 'var(--radius-sm)', border: activeIdx === idx ? '2px solid var(--xhs-red)' : '1px solid var(--border-color)', overflow: 'hidden' }}
                        >
                          <Image src={img.styledSrc || img.src} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          <View 
                            className="uploaded-image-remove"
                            onClick={(e) => removeUploadedImage(img.id, e)}
                            style={{ position: 'absolute', top: 0, right: 0, width: '18px', height: '18px', backgroundColor: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: '10px', display: 'flex', justifyContent: 'center', alignItems: 'center', borderRadius: '0 0 0 4px', cursor: 'pointer' }}
                          >
                            ✕
                          </View>
                        </View>
                      ))}
                    </View>
                  </View>
                )}
              </View>
            </View>

            {/* 2. Image Style Control */}
            {uploadedImages.length > 0 && activeImage && (
              <View className="card">
                <Text className="card-title" style={{ fontSize: '0.95rem', fontWeight: 'bold', marginBottom: '0.5rem', display: 'block' }}>🎨 豆包 AI 画风重绘</Text>
                <Text style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.75rem', display: 'block' }}>
                  调用豆包 Seedream 模型重绘选中的第 {activeIdx + 1} 张图片：
                </Text>
                
                <View style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem', marginBottom: '0.75rem' }}>
                  <Button 
                    className="btn btn-primary" 
                    style={{ padding: '0.4rem 0.25rem', fontSize: '0.75rem', background: 'linear-gradient(135deg, #4f46e5, #6366f1)', border: 'none', color: '#fff', minHeight: 'auto', height: 'auto', width: '100%' }}
                    onClick={() => handleAIStyleTransfer('cartoon')}
                  >
                    吉卜力
                  </Button>
                  <Button 
                    className="btn btn-primary" 
                    style={{ padding: '0.4rem 0.25rem', fontSize: '0.75rem', background: 'linear-gradient(135deg, #ec4899, #d946ef)', border: 'none', color: '#fff', minHeight: 'auto', height: 'auto', width: '100%' }}
                    onClick={() => handleAIStyleTransfer('clay')}
                  >
                    泥塑风
                  </Button>
                  <Button 
                    className="btn btn-primary" 
                    style={{ padding: '0.4rem 0.25rem', fontSize: '0.75rem', background: 'linear-gradient(135deg, #d97706, #92400e)', border: 'none', color: '#fff', minHeight: 'auto', height: 'auto', width: '100%' }}
                    onClick={() => handleAIStyleTransfer('japanese-film')}
                  >
                    胶片风
                  </Button>
                </View>

                {activeImage.styledSrc && (
                  <Button
                    className="btn btn-secondary"
                    style={{ width: '100%', fontSize: '0.75rem', padding: '0.4rem', minHeight: 'auto', height: 'auto' }}
                    onClick={restoreToOriginal}
                  >
                    ↩️ 恢复原图
                  </Button>
                )}
              </View>
            )}

            {/* 3. AI Copy Generator */}
            {uploadedImages.length > 0 && (
              <View className="card">
                <Text className="card-title" style={{ fontSize: '0.95rem', fontWeight: 'bold', marginBottom: '0.5rem', display: 'block' }}>✍️ 小红书爆款文案生成</Text>
                <Text style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.75rem', display: 'block' }}>
                  让 AI 智能识别内容风格，撰写文案与热门标签：
                </Text>

                <View style={{ marginBottom: '0.75rem' }}>
                  <Text className="form-label" style={{ fontSize: '0.75rem', display: 'block', marginBottom: '0.25rem', fontWeight: 'bold' }}>文案风格：</Text>
                  <View style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
                    {['探店', '旅行心情', '自定义'].map((style) => (
                      <Button
                        key={style}
                        className="btn"
                        style={{
                          padding: '0.3rem 0.6rem',
                          fontSize: '0.7rem',
                          borderRadius: '20px',
                          border: copyStyle === style ? 'none' : '1px solid var(--border-color)',
                          background: copyStyle === style ? 'linear-gradient(135deg, #ff2442, #ff4d66)' : 'var(--bg-card)',
                          color: copyStyle === style ? '#fff' : 'var(--text-secondary)',
                          fontWeight: copyStyle === style ? '600' : 'normal',
                          minHeight: 'auto',
                          width: 'auto',
                          height: 'auto',
                          lineHeight: 1.5,
                          margin: 0
                        }}
                        onClick={() => setCopyStyle(style)}
                      >
                        {style === '探店' && '🛍️ 探店'}
                        {style === '旅行心情' && '✈️ 旅行心情'}
                        {style === '自定义' && '⚙️ 自定义'}
                      </Button>
                    ))}
                  </View>

                  {copyStyle === '自定义' && (
                    <Input
                      type="text"
                      className="form-control"
                      placeholder="如：科技测评、日常随笔..."
                      style={{ width: '100%', marginBottom: '0.5rem', padding: '0.4rem 0.5rem', fontSize: '0.75rem', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', boxSizing: 'border-box' }}
                      value={customCopyStyle}
                      onInput={(e) => setCustomCopyStyle(e.detail.value)}
                    />
                  )}
                </View>

                <View style={{ marginBottom: '0.75rem' }}>
                  <Text className="form-label" style={{ fontSize: '0.75rem', display: 'block', marginBottom: '0.25rem', fontWeight: 'bold' }}>亮点描述（选填）：</Text>
                  <Textarea
                    className="form-control"
                    placeholder="可简述图片拍摄的主题、天气或想表达的亮点描述..."
                    style={{ width: '100%', padding: '0.4rem 0.5rem', fontSize: '0.75rem', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', boxSizing: 'border-box', height: '60px' }}
                    value={copyKeywords}
                    onInput={(e) => setCopyKeywords(e.detail.value)}
                  />
                </View>

                <Button
                  className="btn btn-primary"
                  style={{ width: '100%', background: 'linear-gradient(135deg, #6366f1, #4f46e5)', color: '#fff', fontSize: '0.8rem', fontWeight: 'bold' }}
                  onClick={handleGenerateAICopy}
                  disabled={isGeneratingCopy}
                >
                  {isGeneratingCopy ? '🤖 智能撰写中...' : '🚀 一键生成小红书文案'}
                </Button>
              </View>
            )}
          </View>

          {/* Right Preview & Result Column */}
          <View className="preview-panel">
            {uploadedImages.length > 0 && activeImage ? (
              <View style={{ display: 'flex', flexDirection: 'column', gap: '1rem', width: '100%' }}>
                
                {/* Image Preview Card */}
                <View className="card" style={{ padding: '1rem' }}>
                  <View style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                    <Text style={{ fontSize: '0.85rem', fontWeight: 'bold' }}>🖼️ 风格化效果预览</Text>
                    <Button 
                      className="btn btn-primary" 
                      style={{ padding: '0.3rem 0.6rem', fontSize: '0.7rem', background: 'linear-gradient(135deg, #ff2442, #ff4d66)', border: 'none', color: '#fff', fontWeight: '600', minHeight: 'auto', width: 'auto', height: 'auto' }} 
                      onClick={() => saveOrDownloadImage(activeImage.styledSrc || activeImage.src, activeIdx)}
                    >
                      📥 导出图片
                    </Button>
                  </View>
                  
                  <View style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', background: '#f3f4f6', borderRadius: 'var(--radius-md)', overflow: 'hidden', padding: '1rem', minHeight: '200px' }}>
                    <Image 
                      src={activeImage.styledSrc || activeImage.src} 
                      mode="aspectFit"
                      style={{ width: '100%', height: '300px', borderRadius: 'var(--radius-sm)', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}
                    />
                  </View>
                </View>

                {/* Copywriting Result Card */}
                {generatedCopyOptions.length > 0 && (
                  <View className="card" style={{ padding: '1rem' }}>
                    <Text style={{ fontSize: '0.85rem', fontWeight: 'bold', marginBottom: '0.5rem', display: 'block' }}>✍️ AI 生成文案</Text>
                    
                    <View style={{ display: 'flex', gap: '0.25rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem', marginBottom: '0.75rem' }}>
                      {generatedCopyOptions.map((opt, idx) => (
                        <Button
                          key={idx}
                          className={`btn ${activeCopyOptionIdx === idx ? 'btn-primary' : 'btn-secondary'}`}
                          style={{ flex: 1, padding: '0.3rem 0.25rem', fontSize: '0.7rem', minHeight: 'auto', height: 'auto', lineHeight: 1.5 }}
                          onClick={() => applyCopyOption(idx)}
                        >
                          方案 {idx + 1}
                        </Button>
                      ))}
                    </View>

                    <View style={{ background: 'var(--bg-main)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', position: 'relative', marginBottom: '0.75rem' }}>
                      <View style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                        <Text style={{ fontSize: '0.75rem', fontWeight: 'bold', color: 'var(--text-secondary)' }}>
                          ✨ 效果预览：
                        </Text>
                        <Button
                          className="btn btn-secondary"
                          style={{ padding: '0.2rem 0.4rem', fontSize: '0.65rem', minHeight: 'auto', width: 'auto', height: 'auto', margin: 0 }}
                          onClick={handleCopyClipboard}
                        >
                          📋 复制文案
                        </Button>
                      </View>

                      <View style={{ fontSize: '0.8rem', fontWeight: 'bold', color: 'var(--text-primary)', marginBottom: '0.5rem', paddingBottom: '0.5rem', borderBottom: '1px dotted var(--border-color)' }}>
                        标题：{aiTitle}
                      </View>
                      <Text style={{ fontSize: '0.75rem', color: 'var(--text-primary)', whiteSpace: 'pre-wrap', lineHeight: '1.5', display: 'block' }}>
                        {aiBody}
                      </Text>
                    </View>

                    {/* Copy Editor */}
                    <View style={{ borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem' }}>
                      <Text style={{ fontSize: '0.75rem', fontWeight: 'bold', marginBottom: '0.5rem', display: 'block' }}>✍️ 微调编辑：</Text>
                      <View style={{ marginBottom: '0.5rem' }}>
                        <Text style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '0.25rem' }}>修改标题</Text>
                        <Input 
                          type="text" 
                          className="form-control" 
                          style={{ width: '100%', padding: '0.4rem 0.5rem', fontSize: '0.75rem', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', boxSizing: 'border-box' }}
                          value={aiTitle} 
                          onInput={(e) => setAiTitle(e.detail.value)}
                        />
                      </View>
                      <View>
                        <Text style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '0.25rem' }}>修改正文与标签</Text>
                        <Textarea 
                          className="form-control" 
                          style={{ width: '100%', padding: '0.4rem 0.5rem', fontSize: '0.75rem', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', boxSizing: 'border-box', height: '100px' }}
                          value={aiBody} 
                          onInput={(e) => setAiBody(e.detail.value)}
                        />
                      </View>
                    </View>
                  </View>
                )}
              </View>
            ) : (
              <View className="card" style={{ width: '100%', height: '250px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6c757d' }}>
                <Text style={{ fontSize: '0.8rem' }}>🌅 请先在左侧上传并选择照片进行风格重绘</Text>
              </View>
            )}
          </View>

        </View>
      </ScrollView>
    </View>
  );
}
