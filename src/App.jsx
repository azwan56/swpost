import React, { useState, useRef } from 'react';

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

      newImages.push({
        id,
        file,
        src,
        styledSrc: null,
        activeStyle: null
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

  // Call Doubao style transfer model via backend
  const handleAIStyleTransfer = async (styleName) => {
    const activeImage = uploadedImages[activeIdx];
    if (!activeImage) return;
    
    setIsLoading(true);
    const styleLabel = styleName === 'clay' ? '泥塑黏土化' : styleName === 'japanese-film' ? '日式胶片风' : '吉卜力卡通化';
    setAiOperationName(`豆包模型 ${styleLabel}`);
    setErrorMsg('');

    try {
      // Use styledSrc as input if styled already, or fallback to original src
      const inputSrc = activeImage.styledSrc || activeImage.src;
      const compressedImage = await resizeImageBase64(inputSrc, 2048, 0.9);

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
      
      // Update the image with the styled result
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
        
        // Populate inputs
        setAiTitle(result.options[0].title);
        setAiBody(`${result.options[0].body}\n\n${result.options[0].tags}`);
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
    setAiBody(`${opt.body}\n\n${opt.tags}`);
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
            <img src="/logo.jpg" alt="闪贴 AI" className="welcome-logo-img" />
          </div>
          <h1 className="welcome-title">你拍照我生文</h1>
          <p className="welcome-subtitle">AI 智能画风转换与爆款文案助手</p>
          
          <div className="welcome-workflow">
            <h3 className="workflow-title">💡 极简工作流程说明</h3>
            <div className="workflow-steps">
              <div className="workflow-step">
                <span className="step-num">1</span>
                <div className="step-content">
                  <strong>上传照片</strong>
                  <span>最多可支持上传 4 张照片。</span>
                </div>
              </div>
              <div className="workflow-step">
                <span className="step-num">2</span>
                <div className="step-content">
                  <strong>艺术风格化</strong>
                  <span>选择喜欢的图片处理风格（吉卜力/泥塑/胶片），一键转换。</span>
                </div>
              </div>
              <div className="workflow-step">
                <span className="step-num">3</span>
                <div className="step-content">
                  <strong>图片存档</strong>
                  <span>将生成的精美艺术画风图片保存或导出到本地。</span>
                </div>
              </div>
              <div className="workflow-step">
                <span className="step-num">4</span>
                <div className="step-content">
                  <strong>文案风格设定</strong>
                  <span>选择想要的文案风格（如探店、旅行、自定义等）。</span>
                </div>
              </div>
              <div className="workflow-step">
                <span className="step-num">5</span>
                <div className="step-content">
                  <strong>AI 智能生成</strong>
                  <span>AI 根据图片拍摄的场景、时间、地点及您想要突出的重点，一键撰写文案与热门标签。</span>
                </div>
              </div>
              <div className="workflow-step">
                <span className="step-num">6</span>
                <div className="step-content">
                  <strong>挑选与拷贝</strong>
                  <span>在系统自动生成的 3 种文案方案中挑选最满意的一款，一键复制。</span>
                </div>
              </div>
              <div className="workflow-step">
                <span className="step-num">7</span>
                <div className="step-content">
                  <strong>即刻发文</strong>
                  <span>复制成功后，就可以愉快地去微信朋友圈、小红书、Ins 发文分享啦！</span>
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
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>点击选中某张照片进行画风转换：</p>
                  <div className="uploaded-images-list">
                    {uploadedImages.map((img, idx) => (
                      <div 
                        key={img.id}
                        className={`uploaded-image-thumbnail ${activeIdx === idx ? 'active' : ''}`}
                        onClick={() => setActiveIdx(idx)}
                      >
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
                选择一种艺术画风，调用豆包 Seedream 模型重绘选中的第 {activeIdx + 1} 张图片：
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
                  <input
                    type="text"
                    className="form-control"
                    placeholder="如：科技测评、搞笑吐槽、日常随笔..."
                    style={{ width: '100%', marginBottom: '0.5rem', padding: '0.4rem 0.5rem', fontSize: '0.8rem' }}
                    value={customCopyStyle}
                    onChange={(e) => setCustomCopyStyle(e.target.value)}
                  />
                )}
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
                    </div>

                    <div style={{ fontSize: '0.85rem', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '0.5rem', paddingBottom: '0.5rem', borderBottom: '1px dotted var(--border-color)' }}>
                      标题：{aiTitle}
                    </div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-primary)', whiteSpace: 'pre-wrap', lineHeight: '1.5' }}>
                      {aiBody}
                    </div>
                  </div>

                  {/* Copy Editor */}
                  <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem' }}>
                    <h4 style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.5rem' }}>✍️ 微调编辑：</h4>
                    <div style={{ marginBottom: '0.5rem' }}>
                      <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '0.25rem' }}>修改标题</label>
                      <input 
                        type="text" 
                        className="form-control" 
                        style={{ width: '100%', padding: '0.4rem 0.5rem', fontSize: '0.8rem', boxSizing: 'border-box' }}
                        value={aiTitle} 
                        onChange={(e) => setAiTitle(e.target.value)}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '0.25rem' }}>修改正文与标签</label>
                      <textarea 
                        className="form-control" 
                        rows="5"
                        style={{ width: '100%', padding: '0.4rem 0.5rem', fontSize: '0.8rem', resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit' }}
                        value={aiBody} 
                        onChange={(e) => setAiBody(e.target.value)}
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
