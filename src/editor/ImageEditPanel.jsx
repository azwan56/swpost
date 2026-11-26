import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ASPECT_RATIOS,
  BASIC_ADJUST_DEFAULTS,
  CLUTTER_QUICK_PRESETS,
  applyLocalAspectTransform,
  buildBrushMaskDataUrl,
  computeOutpaintLayout,
  renderBasicAdjustments,
  renderLocalDepthBlur
} from './imageEditUtils.js';

export function ImageEditPanel({
  activeImage,
  activeIdx,
  apiBase,
  subTab,
  onChangeSubTab,
  hasSubjectMask,
  onRequestSubjectMask,
  isDetectingMask,
  bokehFocusPoint,
  isBokehTapFocusActive,
  onSetBokehTapFocusActive,
  isEraseBrushMode,
  onSetEraseBrushMode,
  eraseBrushSize,
  onSetEraseBrushSize,
  eraseBrushStrokes,
  onUndoEraseStroke,
  onClearEraseStrokes,
  onSetLivePreview,
  onCommitEdit,
  onUndoEdit,
  onResetOriginal,
  onStartLoading,
  onStopLoading,
  onError,
  onToast
}) {
  // 1. Outpaint / Aspect Ratio states
  const [targetAspect, setTargetAspect] = useState('3:4');
  const [outpaintAnchor, setOutpaintAnchor] = useState('center');
  const [outpaintZoom, setOutpaintZoom] = useState(1.0);
  const [outpaintPrompt, setOutpaintPrompt] = useState('');

  // 2. Clutter Removal / Erase states
  const [eraseMode, setEraseMode] = useState('smart'); // 'smart' | 'brush'
  const [isScanningClutter, setIsScanningClutter] = useState(false);
  const [clutterSummary, setClutterSummary] = useState('');
  const [detectedItems, setDetectedItems] = useState([]);
  const [selectedPresetLabels, setSelectedPresetLabels] = useState([]);
  const [customErasePrompt, setCustomErasePrompt] = useState('');

  // 3. Foreground / Background Blur states
  const [bokehMode, setBokehMode] = useState('background'); // 'background' | 'foreground' | 'tilt-shift'
  const [bokehEngine, setBokehEngine] = useState('local'); // 'local' | 'ai'
  const [localMaskSource, setLocalMaskSource] = useState('portrait'); // 'portrait' | 'point'
  const [bokehStrength, setBokehStrength] = useState(60);
  const [bokehFeather, setBokehFeather] = useState(50);
  const [bokehHighlight, setBokehHighlight] = useState(25);
  const [bokehFocusSize, setBokehFocusSize] = useState(0.34);
  const [aiBokehIntensity, setAiBokehIntensity] = useState('medium');
  const [aiBokehFocusTarget, setAiBokehFocusTarget] = useState('');
  const [isLocalBokehDirty, setIsLocalBokehDirty] = useState(false);

  // 4. Basic Adjustment states
  const [basicParams, setBasicParams] = useState(() => ({ ...BASIC_ADJUST_DEFAULTS }));
  const [isBasicDirty, setIsBasicDirty] = useState(false);

  const previewTimerRef = useRef(null);
  const previewReqRef = useRef(0);

  // Reset transient per-image states when switching photos
  useEffect(() => {
    clearTimeout(previewTimerRef.current);
    previewReqRef.current += 1;
    setClutterSummary('');
    setDetectedItems([]);
    setSelectedPresetLabels([]);
    setCustomErasePrompt('');
    setBasicParams({ ...BASIC_ADJUST_DEFAULTS });
    setIsBasicDirty(false);
    setIsLocalBokehDirty(false);
    onSetLivePreview('');
  }, [activeImage?.id]);

  // Sync interactive stage overlays with active subTab & mode
  useEffect(() => {
    const brushActive = subTab === 'erase' && eraseMode === 'brush';
    onSetEraseBrushMode(brushActive);

    const tapFocusActive =
      subTab === 'bokeh' &&
      bokehEngine === 'local' &&
      (bokehMode === 'tilt-shift' || localMaskSource === 'point');
    onSetBokehTapFocusActive(tapFocusActive);
  }, [subTab, eraseMode, bokehEngine, bokehMode, localMaskSource]);

  const blueprint = useMemo(
    () =>
      computeOutpaintLayout(
        activeImage?.width || 1000,
        activeImage?.height || 1000,
        targetAspect,
        outpaintAnchor,
        outpaintZoom
      ),
    [activeImage?.width, activeImage?.height, targetAspect, outpaintAnchor, outpaintZoom]
  );

  // Ensure appropriate default anchor when axis changes
  useEffect(() => {
    if (blueprint.axis === 'horizontal' && (outpaintAnchor === 'top' || outpaintAnchor === 'bottom')) {
      setOutpaintAnchor('center');
    } else if (blueprint.axis === 'vertical' && (outpaintAnchor === 'left' || outpaintAnchor === 'right')) {
      setOutpaintAnchor('center');
    }
  }, [blueprint.axis]);

  // Live preview effect for local depth blur
  useEffect(() => {
    if (subTab !== 'bokeh' || bokehEngine !== 'local' || !isLocalBokehDirty || !activeImage?.src) {
      return;
    }
    const reqId = ++previewReqRef.current;
    clearTimeout(previewTimerRef.current);
    previewTimerRef.current = setTimeout(async () => {
      try {
        const subjectMask =
          localMaskSource === 'portrait' && bokehMode !== 'tilt-shift'
            ? await onRequestSubjectMask(activeIdx, { silent: true })
            : null;
        if (reqId !== previewReqRef.current) return;

        const res = await renderLocalDepthBlur(activeImage.src, {
          mode: bokehMode,
          strength: bokehStrength,
          feather: bokehFeather,
          bokehHighlight,
          focusX: bokehFocusPoint.x,
          focusY: bokehFocusPoint.y,
          focusSize: bokehFocusSize,
          usePortraitMask: localMaskSource === 'portrait',
          subjectMask,
          maxEdge: 1200
        });
        if (reqId !== previewReqRef.current) return;

        if (localMaskSource === 'portrait' && bokehMode !== 'tilt-shift' && !res.usedPortraitMask) {
          setLocalMaskSource('point');
          onToast('未检测到人像主体，已自动切换为「点击画面自定义对焦」');
        }
        onSetLivePreview(res.dataUrl);
      } catch (err) {
        console.warn('[LocalBokehPreview]', err);
      }
    }, 100);

    return () => clearTimeout(previewTimerRef.current);
  }, [
    subTab,
    bokehEngine,
    isLocalBokehDirty,
    bokehMode,
    localMaskSource,
    bokehStrength,
    bokehFeather,
    bokehHighlight,
    bokehFocusSize,
    bokehFocusPoint.x,
    bokehFocusPoint.y,
    activeImage?.src,
    activeIdx
  ]);

  // Live preview effect for basic adjustments
  useEffect(() => {
    if (subTab !== 'basic' || !isBasicDirty || !activeImage?.src) {
      return;
    }
    const reqId = ++previewReqRef.current;
    clearTimeout(previewTimerRef.current);
    previewTimerRef.current = setTimeout(async () => {
      try {
        const res = await renderBasicAdjustments(activeImage.src, basicParams, { maxEdge: 1200 });
        if (reqId !== previewReqRef.current) return;
        onSetLivePreview(res.dataUrl);
      } catch (err) {
        console.warn('[BasicAdjustPreview]', err);
      }
    }, 90);

    return () => clearTimeout(previewTimerRef.current);
  }, [subTab, isBasicDirty, basicParams, activeImage?.src]);

  // Compress current image before uploading to backend AI endpoints
  const preparePayloadImage = async (src, maxDim = 1500) => {
    const img = new Image();
    if (!src.startsWith('data:')) img.crossOrigin = 'anonymous';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = src;
    });
    let w = img.naturalWidth || img.width;
    let h = img.naturalHeight || img.height;
    if (Math.max(w, h) <= maxDim && src.length < 2200000) {
      return { dataUrl: src, width: w, height: h };
    }
    if (w > h && w > maxDim) {
      h = Math.round((h * maxDim) / w);
      w = maxDim;
    } else if (h >= w && h > maxDim) {
      w = Math.round((w * maxDim) / h);
      h = maxDim;
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    return { dataUrl: canvas.toDataURL('image/jpeg', 0.9), width: w, height: h };
  };

  // --- Handlers: Outpaint & Local Aspect Transform ---
  const handleAIOutpaint = async () => {
    if (!activeImage) return;
    onError('');
    onStartLoading(`AI 生成式延展至 ${targetAspect}`);
    try {
      const { dataUrl, width, height } = await preparePayloadImage(activeImage.src, 1440);
      const res = await fetch(`${apiBase}/api/ai/edit-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: dataUrl,
          mode: 'outpaint',
          width,
          height,
          targetAspect,
          anchor: outpaintAnchor,
          zoomOut: outpaintZoom,
          prompt: outpaintPrompt
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'AI 扩图失败');

      onCommitEdit(activeImage.id, {
        dataUrl: data.image,
        width: data.width,
        height: data.height,
        label: `📐 AI 扩图 ${targetAspect}`
      });
      onToast(`✨ 已完成 AI 生成式延展（${targetAspect}）`);
    } catch (err) {
      console.error('[AIOutpaint]', err);
      onError(err.message || 'AI 扩图失败，请稍后重试');
    } finally {
      onStopLoading();
    }
  };

  const handleLocalAspect = async (mode, padBg = 'blur') => {
    if (!activeImage) return;
    onError('');
    try {
      const res = await applyLocalAspectTransform(activeImage.src, {
        targetAspect,
        mode,
        anchor: outpaintAnchor,
        padBg,
        exif: activeImage.exif
      });
      const tag =
        mode === 'crop'
          ? `✂️ 裁剪 ${targetAspect}`
          : padBg === 'white'
            ? `⬜ 白边 ${targetAspect}`
            : `🖼️ 留白 ${targetAspect}`;
      onCommitEdit(activeImage.id, { ...res, label: tag });
      onToast(`✅ 已转换画幅至 ${targetAspect}`);
    } catch (err) {
      onError(`画幅变换失败: ${err.message}`);
    }
  };

  // --- Handlers: Clutter Detection & Removal ---
  const handleScanClutter = async () => {
    if (!activeImage) return;
    onError('');
    setIsScanningClutter(true);
    try {
      const { dataUrl } = await preparePayloadImage(activeImage.src, 1024);
      const res = await fetch(`${apiBase}/api/ai/detect-clutter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'AI 识别失败');

      const items = (data.items || []).map((it) => ({ ...it, checked: true }));
      setDetectedItems(items);
      setClutterSummary(data.summary || '');
      if (items.length === 0) {
        onToast('✨ 画面很整洁，也可以选择常用杂物或手动涂抹消除');
      } else {
        onToast(`🔍 已识别 ${items.length} 处可清理元素`);
      }
    } catch (err) {
      console.error('[ScanClutter]', err);
      onError(err.message || 'AI 识别杂乱元素失败');
    } finally {
      setIsScanningClutter(false);
    }
  };

  const toggleDetectedItem = (id) => {
    setDetectedItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, checked: !it.checked } : it))
    );
  };

  const togglePresetLabel = (label) => {
    setSelectedPresetLabels((prev) =>
      prev.includes(label) ? prev.filter((x) => x !== label) : [...prev, label]
    );
  };

  const handleSmartRemove = async () => {
    if (!activeImage) return;
    const chosenDetected = detectedItems.filter((it) => it.checked);
    const chosenItems = [
      ...chosenDetected.map((it) => ({ label: it.label, location: it.location })),
      ...selectedPresetLabels.map((label) => ({ label, location: '' }))
    ];
    if (chosenItems.length === 0 && !customErasePrompt.trim()) {
      onToast('请先扫描并勾选要消除的元素，或点击下方常用杂物/输入描述');
      return;
    }

    onError('');
    onStartLoading('AI 智能无痕消除杂物');
    try {
      const { dataUrl, width, height } = await preparePayloadImage(activeImage.src, 1500);
      const res = await fetch(`${apiBase}/api/ai/edit-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: dataUrl,
          mode: 'remove_clutter',
          width,
          height,
          items: chosenItems,
          prompt: customErasePrompt
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'AI 消除失败');

      onCommitEdit(activeImage.id, {
        dataUrl: data.image,
        width: data.width,
        height: data.height,
        label: '🧹 AI 智能消除'
      });
      setDetectedItems([]);
      setSelectedPresetLabels([]);
      setCustomErasePrompt('');
      onToast('✨ 已无痕清理选中杂乱元素！');
    } catch (err) {
      console.error('[SmartRemove]', err);
      onError(err.message || 'AI 消除失败，请重试');
    } finally {
      onStopLoading();
    }
  };

  const handleBrushErase = async () => {
    if (!activeImage || eraseBrushStrokes.length === 0) {
      onToast('请先在上方图片上涂抹需要消除的区域');
      return;
    }
    onError('');
    onStartLoading('AI 精准修补涂抹区域');
    try {
      const { dataUrl, width, height } = await preparePayloadImage(activeImage.src, 1500);
      const maskDataUrl = buildBrushMaskDataUrl(eraseBrushStrokes, width, height);
      const res = await fetch(`${apiBase}/api/ai/edit-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: dataUrl,
          mask: maskDataUrl,
          mode: 'remove_mask',
          width,
          height,
          prompt: customErasePrompt
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '涂抹消除失败');

      onCommitEdit(activeImage.id, {
        dataUrl: data.image,
        width: data.width,
        height: data.height,
        label: '🖌️ 涂抹消除'
      });
      onClearEraseStrokes();
      onSetEraseBrushMode(false);
      setCustomErasePrompt('');
      onToast('✨ 涂抹区域已无痕消除！');
    } catch (err) {
      console.error('[BrushErase]', err);
      onError(err.message || '涂抹消除失败，请重试');
    } finally {
      onStopLoading();
    }
  };

  // --- Handlers: Foreground / Background Bokeh ---
  const handleSelectBokehControl = async (nextSource) => {
    setLocalMaskSource(nextSource);
    setIsLocalBokehDirty(true);
    if (nextSource === 'portrait' && bokehMode !== 'tilt-shift' && !hasSubjectMask) {
      await onRequestSubjectMask(activeIdx, { silent: false });
    }
  };

  const handleApplyLocalBokeh = async () => {
    if (!activeImage) return;
    onError('');
    onStartLoading('正在输出高清景深虚化成片');
    try {
      const subjectMask =
        localMaskSource === 'portrait' && bokehMode !== 'tilt-shift'
          ? await onRequestSubjectMask(activeIdx, { silent: true })
          : null;
      const res = await renderLocalDepthBlur(activeImage.src, {
        mode: bokehMode,
        strength: bokehStrength,
        feather: bokehFeather,
        bokehHighlight,
        focusX: bokehFocusPoint.x,
        focusY: bokehFocusPoint.y,
        focusSize: bokehFocusSize,
        usePortraitMask: localMaskSource === 'portrait',
        subjectMask,
        maxEdge: null,
        exif: activeImage.exif
      });
      onSetLivePreview('');
      setIsLocalBokehDirty(false);
      const label =
        bokehMode === 'foreground'
          ? '🌿 前景虚化'
          : bokehMode === 'tilt-shift'
            ? '🎯 移轴景深'
            : '📷 背景虚化';
      onCommitEdit(activeImage.id, { ...res, label });
      onToast('✅ 已应用景深虚化效果！');
    } catch (err) {
      onError(`应用虚化失败: ${err.message}`);
    } finally {
      onStopLoading();
    }
  };

  const handleAIBokeh = async () => {
    if (!activeImage) return;
    const mode = bokehMode === 'foreground' ? 'blur_foreground' : 'blur_background';
    onError('');
    onStartLoading(`AI 生成 3D 光学${bokehMode === 'foreground' ? '前景' : '背景'}虚化`);
    try {
      const { dataUrl, width, height } = await preparePayloadImage(activeImage.src, 1500);
      const res = await fetch(`${apiBase}/api/ai/edit-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: dataUrl,
          mode,
          width,
          height,
          intensity: aiBokehIntensity,
          focusTarget: aiBokehFocusTarget
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'AI 虚化生成失败');

      onSetLivePreview('');
      setIsLocalBokehDirty(false);
      onCommitEdit(activeImage.id, {
        dataUrl: data.image,
        width: data.width,
        height: data.height,
        label: bokehMode === 'foreground' ? '🌿 AI 前景虚化' : '🎬 AI 背景虚化'
      });
      onToast('✨ AI 大光圈光学虚化已生成！');
    } catch (err) {
      console.error('[AIBokeh]', err);
      onError(err.message || 'AI 虚化失败，请重试');
    } finally {
      onStopLoading();
    }
  };

  // --- Handlers: Basic Adjustments ---
  const updateBasic = (patch) => {
    setBasicParams((prev) => ({ ...prev, ...patch }));
    setIsBasicDirty(true);
  };

  const handleApplyBasic = async () => {
    if (!activeImage) return;
    onError('');
    onStartLoading('正在导出高清精修成片');
    try {
      const res = await renderBasicAdjustments(activeImage.src, basicParams, {
        maxEdge: null,
        exif: activeImage.exif
      });
      onSetLivePreview('');
      setBasicParams({ ...BASIC_ADJUST_DEFAULTS });
      setIsBasicDirty(false);
      onCommitEdit(activeImage.id, { ...res, label: '🎛️ 基础精修' });
      onToast('✅ 已保存基础修图调整！');
    } catch (err) {
      onError(`精修保存失败: ${err.message}`);
    } finally {
      onStopLoading();
    }
  };

  if (!activeImage) return null;

  const editHistoryCount = activeImage.editHistory?.length || 0;
  const isEdited = Boolean(activeImage.originalSrc && activeImage.originalSrc !== activeImage.src);
  const smartSelectionCount =
    detectedItems.filter((it) => it.checked).length + selectedPresetLabels.length;

  return (
    <div className="h5-panel-card edit-panel">
      <div className="h5-panel-header">
        <div>
          <h2 className="h5-panel-title">✨ AI 智能修图工作台</h2>
          <p className="h5-panel-desc">
            生成式扩图 · AI 去杂物 · 景深虚化 · 裁剪调色（当前 {activeImage.width}×{activeImage.height}）
          </p>
        </div>
        <div className="edit-header-actions">
          {editHistoryCount > 0 && (
            <button
              type="button"
              className="h5-mini-outline-btn"
              onClick={() => {
                onSetLivePreview('');
                setIsLocalBokehDirty(false);
                setIsBasicDirty(false);
                onUndoEdit(activeImage.id);
              }}
            >
              ↩️ 撤销 ({editHistoryCount})
            </button>
          )}
          {isEdited && (
            <button
              type="button"
              className="h5-mini-outline-btn danger"
              onClick={() => {
                onSetLivePreview('');
                setBasicParams({ ...BASIC_ADJUST_DEFAULTS });
                setIsBasicDirty(false);
                setIsLocalBokehDirty(false);
                onResetOriginal(activeImage.id);
              }}
            >
              恢复原片
            </button>
          )}
        </div>
      </div>

      {/* 4 Sub-tabs */}
      <div className="h5-subtab-bar edit-subtab-bar">
        {[
          { id: 'expand', label: '📐 智能扩图' },
          { id: 'erase', label: '🧹 消除杂物' },
          { id: 'bokeh', label: '📷 AI 虚化' },
          { id: 'basic', label: '🎛️ 基础精修' }
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`h5-subtab-pill ${subTab === tab.id ? 'active' : ''}`}
            onClick={() => {
              onSetLivePreview('');
              setIsLocalBokehDirty(false);
              setIsBasicDirty(false);
              onChangeSubTab(tab.id);
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* SUBTAB 1: GENERATIVE OUTPAINT & ASPECT TRANSFORM */}
      {subTab === 'expand' && (
        <div className="h5-subtab-content edit-stack">
          <div className="edit-ratio-grid">
            {ASPECT_RATIOS.map((r) => {
              const active = targetAspect === r.id;
              const maxBox = 20;
              const bw = r.w >= r.h ? maxBox : Math.max(10, Math.round((maxBox * r.w) / r.h));
              const bh = r.h >= r.w ? maxBox : Math.max(10, Math.round((maxBox * r.h) / r.w));
              return (
                <button
                  key={r.id}
                  type="button"
                  className={`edit-ratio-card ${active ? 'active' : ''}`}
                  onClick={() => setTargetAspect(r.id)}
                >
                  <span
                    className="edit-ratio-wire"
                    style={{ width: `${bw}px`, height: `${bh}px` }}
                  />
                  <strong>{r.label}</strong>
                  <span>{r.tag}</span>
                </button>
              );
            })}
          </div>

          {/* Framing Blueprint */}
          <div className="edit-blueprint-card">
            <div className="edit-blueprint-visual">
              <div
                className="edit-blueprint-target"
                style={{
                  aspectRatio: `${targetAspect.replace(':', ' / ')}`,
                  width: blueprint.targetRatio >= 1 ? '76px' : `${Math.round(76 * blueprint.targetRatio)}px`
                }}
              >
                <div
                  className="edit-blueprint-inner"
                  style={{
                    left: `${blueprint.innerX * 100}%`,
                    top: `${blueprint.innerY * 100}%`,
                    width: `${blueprint.innerW * 100}%`,
                    height: `${blueprint.innerH * 100}%`
                  }}
                >
                  <img src={activeImage.src} alt="原图范围" />
                </div>
              </div>
            </div>

            <div className="edit-blueprint-info">
              <div className="edit-blueprint-badges">
                <span className="edit-dir-badge">{blueprint.directionLabel}</span>
                <span className="edit-dim-badge">目标 {targetAspect}</span>
              </div>
              <p>虚线区域将由 AI 根据原图透视、光影与环境自动延展补全</p>
            </div>
          </div>

          {/* Anchor & Zoom-out */}
          <div className="spk-box edit-stack-sm">
            <div className="edit-field-row">
              <span className="spk-label">📍 原图位置</span>
              <div className="h5-pill-group">
                {(blueprint.axis === 'horizontal'
                  ? [
                      { id: 'left', label: '靠左' },
                      { id: 'center', label: '居中' },
                      { id: 'right', label: '靠右' }
                    ]
                  : blueprint.axis === 'vertical'
                    ? [
                        { id: 'top', label: '靠上' },
                        { id: 'center', label: '居中' },
                        { id: 'bottom', label: '靠下' }
                      ]
                    : [{ id: 'center', label: '居中外扩' }]
                ).map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className={`h5-choice-pill ${outpaintAnchor === a.id ? 'active' : ''}`}
                    onClick={() => setOutpaintAnchor(a.id)}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="edit-field-row">
              <span className="spk-label">🔭 视野外扩</span>
              <div className="h5-pill-group">
                {[
                  { val: 1.0, label: '1.0× 改比例' },
                  { val: 1.2, label: '1.2× 轻扩' },
                  { val: 1.4, label: '1.4× 广角' }
                ].map((z) => (
                  <button
                    key={z.val}
                    type="button"
                    className={`h5-choice-pill ${outpaintZoom === z.val ? 'active' : ''}`}
                    onClick={() => setOutpaintZoom(z.val)}
                  >
                    {z.label}
                  </button>
                ))}
              </div>
            </div>

            <input
              type="text"
              className="h5-input"
              value={outpaintPrompt}
              onChange={(e) => setOutpaintPrompt(e.target.value)}
              placeholder="选填：描述延伸画面内容，如“延续海面晚霞与木质栈道”"
            />
          </div>

          <button
            type="button"
            className="h5-primary-action-btn indigo"
            onClick={handleAIOutpaint}
          >
            ✨ AI 生成式延展至 {targetAspect}
          </button>

          <div className="edit-local-quick-row">
            <button type="button" onClick={() => handleLocalAspect('crop')}>
              ✂️ 快捷裁剪
            </button>
            <button type="button" onClick={() => handleLocalAspect('pad', 'blur')}>
              🖼️ 虚化留白
            </button>
            <button type="button" onClick={() => handleLocalAspect('pad', 'white')}>
              ⬜ 白边画框
            </button>
          </div>
        </div>
      )}

      {/* SUBTAB 2: AI CLUTTER RECOGNITION & REMOVAL + BRUSH ERASE */}
      {subTab === 'erase' && (
        <div className="h5-subtab-content edit-stack">
          <div className="h5-pill-group">
            <button
              type="button"
              className={`h5-choice-pill ${eraseMode === 'smart' ? 'active' : ''}`}
              onClick={() => setEraseMode('smart')}
            >
              🤖 AI 识别去除杂乱
            </button>
            <button
              type="button"
              className={`h5-choice-pill ${eraseMode === 'brush' ? 'active' : ''}`}
              onClick={() => setEraseMode('brush')}
            >
              🖌️ 手动涂抹消除
            </button>
          </div>

          {eraseMode === 'smart' ? (
            <div className="edit-stack">
              <button
                type="button"
                className="edit-scan-btn"
                disabled={isScanningClutter}
                onClick={handleScanClutter}
              >
                {isScanningClutter ? '⏳ AI 正在扫描画面干扰元素...' : '🔍 AI 自动扫描画面杂乱元素'}
              </button>

              {(clutterSummary || detectedItems.length > 0) && (
                <div className="spk-box edit-stack-sm">
                  {clutterSummary && (
                    <div className="edit-scan-summary">💡 {clutterSummary}</div>
                  )}
                  {detectedItems.length > 0 && (
                    <div className="edit-chip-list">
                      {detectedItems.map((it) => (
                        <button
                          key={it.id}
                          type="button"
                          className={`edit-clutter-chip ${it.checked ? 'checked' : ''}`}
                          onClick={() => toggleDetectedItem(it.id)}
                        >
                          <span className="chip-check">{it.checked ? '✓' : '+'}</span>
                          <span className="chip-main">{it.label}</span>
                          <span className="chip-loc">{it.location}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="spk-box edit-stack-sm">
                <span className="spk-label">⚡ 常见杂物快捷勾选</span>
                <div className="edit-preset-chips">
                  {CLUTTER_QUICK_PRESETS.map((label) => {
                    const active = selectedPresetLabels.includes(label);
                    return (
                      <button
                        key={label}
                        type="button"
                        className={`edit-preset-chip ${active ? 'active' : ''}`}
                        onClick={() => togglePresetLabel(label)}
                      >
                        {active ? `✓ ${label}` : label}
                      </button>
                    );
                  })}
                </div>
                <input
                  type="text"
                  className="h5-input"
                  value={customErasePrompt}
                  onChange={(e) => setCustomErasePrompt(e.target.value)}
                  placeholder="补充要消除的内容，如：左上角空调外机、右下角水杯"
                />
              </div>

              <button
                type="button"
                className="h5-primary-action-btn"
                onClick={handleSmartRemove}
              >
                ✨ 一键智能无痕消除{smartSelectionCount > 0 ? ` (${smartSelectionCount}项)` : ''}
              </button>
            </div>
          ) : (
            <div className="edit-stack">
              <div className="spk-box edit-stack-sm">
                <div className="edit-brush-header">
                  <span className="spk-label">
                    {isEraseBrushMode ? '🖌️ 请在上方照片涂抹要消除的区域' : '涂抹画笔已暂停'}
                  </span>
                  <span className="edit-dim-badge">已画 {eraseBrushStrokes.length} 笔</span>
                </div>

                <label className="spk-slider-item">
                  <div className="spk-slider-meta">
                    <span>画笔粗细</span>
                    <strong>{eraseBrushSize} px</strong>
                  </div>
                  <input
                    type="range"
                    min={12}
                    max={56}
                    step={2}
                    value={eraseBrushSize}
                    onChange={(e) => onSetEraseBrushSize(Number(e.target.value))}
                  />
                </label>

                <div className="h5-doodle-bar">
                  <button
                    type="button"
                    className={`h5-doodle-toggle ${isEraseBrushMode ? 'active' : ''}`}
                    onClick={() => onSetEraseBrushMode(!isEraseBrushMode)}
                  >
                    {isEraseBrushMode ? '✅ 涂抹画笔开启中' : '🖌️ 继续涂抹'}
                  </button>
                  <button
                    type="button"
                    className="h5-doodle-sub"
                    disabled={eraseBrushStrokes.length === 0}
                    onClick={onUndoEraseStroke}
                  >
                    ↩️ 撤销一笔
                  </button>
                  <button
                    type="button"
                    className="h5-doodle-sub"
                    disabled={eraseBrushStrokes.length === 0}
                    onClick={onClearEraseStrokes}
                  >
                    🧹 清空
                  </button>
                </div>

                <input
                  type="text"
                  className="h5-input"
                  value={customErasePrompt}
                  onChange={(e) => setCustomErasePrompt(e.target.value)}
                  placeholder="选填：补全提示（如“草地”或“红砖墙”）"
                />
              </div>

              <button
                type="button"
                className="h5-primary-action-btn"
                disabled={eraseBrushStrokes.length === 0}
                onClick={handleBrushErase}
              >
                ✨ 精准消除涂抹区域 ({eraseBrushStrokes.length} 笔)
              </button>
            </div>
          )}
        </div>
      )}

      {/* SUBTAB 3: AI FOREGROUND / BACKGROUND BOKEH */}
      {subTab === 'bokeh' && (
        <div className="h5-subtab-content edit-stack">
          <div className="h5-pill-group">
            {[
              { id: 'background', label: '👤 虚化背景' },
              { id: 'foreground', label: '🌿 虚化前景' },
              { id: 'tilt-shift', label: '🎯 移轴双景深' }
            ].map((m) => (
              <button
                key={m.id}
                type="button"
                className={`h5-choice-pill ${bokehMode === m.id ? 'active' : ''}`}
                onClick={() => {
                  setBokehMode(m.id);
                  if (m.id === 'tilt-shift') {
                    setBokehEngine('local');
                  }
                  if (bokehEngine === 'local') {
                    setIsLocalBokehDirty(true);
                  }
                }}
              >
                {m.label}
              </button>
            ))}
          </div>

          {bokehMode !== 'tilt-shift' && (
            <div className="edit-engine-switch">
              <button
                type="button"
                className={`edit-eng-btn ${bokehEngine === 'local' ? 'active' : ''}`}
                onClick={() => setBokehEngine('local')}
              >
                <span>⚡ 实时智能景深</span>
                <small>零等待 · 可触控对焦</small>
              </button>
              <button
                type="button"
                className={`edit-eng-btn ${bokehEngine === 'ai' ? 'active' : ''}`}
                onClick={() => {
                  onSetLivePreview('');
                  setIsLocalBokehDirty(false);
                  setBokehEngine('ai');
                }}
              >
                <span>🎬 AI 3D 大光圈</span>
                <small>景物/宠物/人像通用</small>
              </button>
            </div>
          )}

          {bokehEngine === 'local' ? (
            <div className="edit-stack">
              {bokehMode !== 'tilt-shift' && (
                <div className="spk-box edit-stack-sm">
                  <span className="spk-label">🎯 主体识别方式</span>
                  <div className="h5-pill-group">
                    <button
                      type="button"
                      className={`h5-choice-pill ${localMaskSource === 'portrait' ? 'active' : ''}`}
                      disabled={isDetectingMask}
                      onClick={() => handleSelectBokehControl('portrait')}
                    >
                      {isDetectingMask ? '⏳ 识别中...' : '🤖 AI 人像自动识别'}
                    </button>
                    <button
                      type="button"
                      className={`h5-choice-pill ${localMaskSource === 'point' ? 'active' : ''}`}
                      onClick={() => handleSelectBokehControl('point')}
                    >
                      🎯 点击画面对焦
                    </button>
                  </div>
                </div>
              )}

              {isBokehTapFocusActive && (
                <div className="edit-tip-bar">
                  {bokehMode === 'foreground'
                    ? '👆 点击上方照片想要【虚化】的前景位置（如近处花朵/桌面边缘）'
                    : '👆 点击上方照片想要保持【清晰对焦】的位置'}
                </div>
              )}

              <div className="spk-box">
                <div className="spk-slider-grid">
                  <label className="spk-slider-item">
                    <div className="spk-slider-meta">
                      <span>虚化强度</span>
                      <strong>{bokehStrength}%</strong>
                    </div>
                    <input
                      type="range"
                      min={10}
                      max={100}
                      step={5}
                      value={bokehStrength}
                      onChange={(e) => {
                        setBokehStrength(Number(e.target.value));
                        setIsLocalBokehDirty(true);
                      }}
                    />
                  </label>

                  <label className="spk-slider-item">
                    <div className="spk-slider-meta">
                      <span>边缘过渡羽化</span>
                      <strong>{bokehFeather}%</strong>
                    </div>
                    <input
                      type="range"
                      min={10}
                      max={100}
                      step={5}
                      value={bokehFeather}
                      onChange={(e) => {
                        setBokehFeather(Number(e.target.value));
                        setIsLocalBokehDirty(true);
                      }}
                    />
                  </label>

                  <label className="spk-slider-item">
                    <div className="spk-slider-meta">
                      <span>焦外光斑提亮</span>
                      <strong>{bokehHighlight}%</strong>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={5}
                      value={bokehHighlight}
                      onChange={(e) => {
                        setBokehHighlight(Number(e.target.value));
                        setIsLocalBokehDirty(true);
                      }}
                    />
                  </label>

                  {(localMaskSource === 'point' || bokehMode === 'tilt-shift') && (
                    <label className="spk-slider-item">
                      <div className="spk-slider-meta">
                        <span>{bokehMode === 'tilt-shift' ? '清晰带宽度' : '对焦范围'}</span>
                        <strong>{Math.round(bokehFocusSize * 100)}%</strong>
                      </div>
                      <input
                        type="range"
                        min={15}
                        max={65}
                        step={2}
                        value={Math.round(bokehFocusSize * 100)}
                        onChange={(e) => {
                          setBokehFocusSize(Number(e.target.value) / 100);
                          setIsLocalBokehDirty(true);
                        }}
                      />
                    </label>
                  )}
                </div>
              </div>

              <div className="edit-apply-row">
                <button
                  type="button"
                  className="btn btn-secondary edit-half-btn"
                  onClick={() => {
                    setIsLocalBokehDirty(false);
                    onSetLivePreview('');
                  }}
                >
                  ↺ 取消预览
                </button>
                <button
                  type="button"
                  className="h5-primary-action-btn edit-grow-btn"
                  onClick={handleApplyLocalBokeh}
                >
                  ✅ 应用当前虚化
                </button>
              </div>
            </div>
          ) : (
            <div className="edit-stack">
              <div className="spk-box edit-stack-sm">
                <span className="spk-label">📸 选择镜头光圈虚化程度</span>
                <div className="edit-aperture-grid">
                  {[
                    { id: 'light', title: 'f/2.8', desc: '自然微虚·保留环境' },
                    { id: 'medium', title: 'f/1.8', desc: '奶油人像·经典虚化' },
                    { id: 'strong', title: 'f/1.2', desc: '电影浅景·梦幻光斑' }
                  ].map((ap) => (
                    <button
                      key={ap.id}
                      type="button"
                      className={`edit-aperture-card ${aiBokehIntensity === ap.id ? 'active' : ''}`}
                      onClick={() => setAiBokehIntensity(ap.id)}
                    >
                      <strong>{ap.title}</strong>
                      <span>{ap.desc}</span>
                    </button>
                  ))}
                </div>

                <input
                  type="text"
                  className="h5-input"
                  value={aiBokehFocusTarget}
                  onChange={(e) => setAiBokehFocusTarget(e.target.value)}
                  placeholder={
                    bokehMode === 'foreground'
                      ? '选填：想保持清晰的后景主体（如“远处的日落古塔”）'
                      : '选填：想保持清晰的前景主体（如“桌上的拿铁咖啡”）'
                  }
                />
              </div>

              <button
                type="button"
                className="h5-primary-action-btn indigo"
                onClick={handleAIBokeh}
              >
                🎬 AI 生成 3D 光学{bokehMode === 'foreground' ? '前景' : '背景'}虚化
              </button>
            </div>
          )}
        </div>
      )}

      {/* SUBTAB 4: BASIC GEOMETRY & TONE ADJUSTMENTS */}
      {subTab === 'basic' && (
        <div className="h5-subtab-content edit-stack">
          <div className="edit-geo-row">
            <button
              type="button"
              onClick={() => updateBasic({ rotation: (basicParams.rotation + 270) % 360 })}
            >
              ↺ 左转90°
            </button>
            <button
              type="button"
              onClick={() => updateBasic({ rotation: (basicParams.rotation + 90) % 360 })}
            >
              ↻ 右转90°
            </button>
            <button
              type="button"
              className={basicParams.flipH ? 'active' : ''}
              onClick={() => updateBasic({ flipH: !basicParams.flipH })}
            >
              ⇄ 水平镜像
            </button>
            <button
              type="button"
              className={basicParams.flipV ? 'active' : ''}
              onClick={() => updateBasic({ flipV: !basicParams.flipV })}
            >
              ⇅ 垂直翻转
            </button>
          </div>

          <div className="spk-box edit-stack-sm">
            <span className="spk-label">✂️ 快捷裁剪比例</span>
            <div className="edit-crop-pills">
              {[{ id: 'original', label: '原比例' }, ...ASPECT_RATIOS].map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={`h5-choice-pill ${basicParams.cropAspect === r.id ? 'active' : ''}`}
                  onClick={() => updateBasic({ cropAspect: r.id })}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          <div className="spk-box">
            <div className="spk-sliders-header">
              <span className="spk-label">🎚️ 基础光影与画质微调</span>
              <button
                type="button"
                className="spk-reset-link"
                onClick={() => {
                  setBasicParams({ ...BASIC_ADJUST_DEFAULTS });
                  setIsBasicDirty(false);
                  onSetLivePreview('');
                }}
              >
                ↺ 重置参数
              </button>
            </div>

            <div className="spk-slider-grid">
              {[
                { key: 'straighten', label: '水平校正', min: -15, max: 15, step: 0.5, fmt: (v) => `${v > 0 ? '+' : ''}${v}°` },
                { key: 'brightness', label: '亮度', min: -40, max: 40, step: 2, fmt: (v) => `${v > 0 ? '+' : ''}${v}` },
                { key: 'contrast', label: '对比度', min: -40, max: 40, step: 2, fmt: (v) => `${v > 0 ? '+' : ''}${v}` },
                { key: 'saturation', label: '饱和度', min: -60, max: 60, step: 2, fmt: (v) => `${v > 0 ? '+' : ''}${v}` },
                { key: 'warmth', label: '色温冷暖', min: -50, max: 50, step: 2, fmt: (v) => `${v > 0 ? '+' : ''}${v}` },
                { key: 'sharpen', label: '清晰锐化', min: 0, max: 100, step: 5, fmt: (v) => `${v}%` },
                { key: 'vignette', label: '四周暗角', min: 0, max: 100, step: 5, fmt: (v) => `${v}%` }
              ].map((s) => (
                <label key={s.key} className="spk-slider-item">
                  <div className="spk-slider-meta">
                    <span>{s.label}</span>
                    <strong>{s.fmt(basicParams[s.key] ?? 0)}</strong>
                  </div>
                  <input
                    type="range"
                    min={s.min}
                    max={s.max}
                    step={s.step}
                    value={basicParams[s.key] ?? 0}
                    onChange={(e) => updateBasic({ [s.key]: Number(e.target.value) })}
                  />
                </label>
              ))}
            </div>
          </div>

          <div className="edit-apply-row">
            <button
              type="button"
              className="btn btn-secondary edit-half-btn"
              disabled={!isBasicDirty}
              onClick={() => {
                setBasicParams({ ...BASIC_ADJUST_DEFAULTS });
                setIsBasicDirty(false);
                onSetLivePreview('');
              }}
            >
              ↺ 放弃调整
            </button>
            <button
              type="button"
              className="h5-primary-action-btn edit-grow-btn"
              disabled={!isBasicDirty}
              onClick={handleApplyBasic}
            >
              ✅ 应用精修调整
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
