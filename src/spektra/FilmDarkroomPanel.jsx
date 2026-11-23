/* SPDX-License-Identifier: GPL-3.0-or-later */
import React, { useEffect, useMemo, useState } from 'react';
import {
  FILM_CATEGORIES,
  HOT_FILM_IDS,
  compatiblePaperOptions,
  defaultPaperForFilm,
  findFilm,
  loadSpektraCatalog
} from './catalog.js';
import { SPEKTRA_UI_DEFAULTS } from './defaults.js';
import { EDGE_FORMATS, parseExifDateParts, resolveStampText } from './presentation.js';
import { initSpektraEngine, subscribeEngineStatus } from './spektraClient.js';

export function FilmDarkroomPanel({
  params,
  onUpdateParams,
  activeImage,
  selectedBatchCount,
  isRenderingPreview,
  isBatchProcessing,
  onBatchDevelop,
  onRestoreOriginal
}) {
  const [subTab, setSubTab] = useState('film'); // 'film' | 'edge' | 'date'
  const [category, setCategory] = useState('hot');
  const [catalog, setCatalog] = useState(null);
  const [engineStatus, setEngineStatus] = useState('idle');

  useEffect(() => {
    const unsub = subscribeEngineStatus(setEngineStatus);
    loadSpektraCatalog(import.meta.env.BASE_URL || '/')
      .then(setCatalog)
      .catch((err) => console.warn('[SpektraPanel] catalog load error:', err));
    initSpektraEngine().catch(() => {});
    return unsub;
  }, []);

  const currentFilm = useMemo(() => findFilm(catalog, params.film), [catalog, params.film]);
  const paperOptions = useMemo(
    () => (catalog ? compatiblePaperOptions(catalog, params.film) : []),
    [catalog, params.film]
  );

  const visibleFilms = useMemo(() => {
    const allFilms = catalog?.films || [];
    if (category === 'none') {
      return [findFilm(catalog, 'none')];
    }
    if (category === 'hot') {
      const byId = new Map(allFilms.map((f) => [f.id, f]));
      return HOT_FILM_IDS.map((id) => byId.get(id)).filter(Boolean);
    }
    return allFilms.filter((f) => f.category === category);
  }, [catalog, category]);

  const exifDateInfo = useMemo(() => parseExifDateParts(activeImage?.exif), [activeImage?.exif]);
  const resolvedDatePreview = useMemo(
    () => resolveStampText(params, activeImage?.exif),
    [params, activeImage?.exif]
  );

  const currentFormatMeta = EDGE_FORMATS[params.edgeFormat || '135'] || EDGE_FORMATS['135'];
  const is135Gauge = currentFormatMeta.gauge === '135';

  const handleSelectFilm = (filmId) => {
    const nextPaper = catalog ? defaultPaperForFilm(catalog, filmId, params.paper) : params.paper;
    onUpdateParams({ film: filmId, paper: nextPaper });
  };

  const handleSelectEdgeFormat = (fmtId) => {
    const cropMode = fmtId === '135' ? 'keep' : 'gate';
    onUpdateParams({
      border: true,
      edgeFormat: fmtId,
      edgeCropMode: cropMode
    });
  };

  const engineBadge = (() => {
    if (engineStatus === 'wasm') return { text: '⚡ SpektraLab C++ WASM', cls: 'ready' };
    if (engineStatus === 'js-spectral') return { text: '🔬 81波段光谱引擎', cls: 'ready' };
    if (engineStatus === 'loading') return { text: '⏳ 正在加载光谱引擎…', cls: 'loading' };
    if (engineStatus === 'error') return { text: '⚠️ 切换备用光谱模式', cls: 'warn' };
    return { text: '🎞️ SpektraLab 暗房', cls: 'loading' };
  })();

  return (
    <div className="h5-panel-card spk-panel">
      <div className="h5-panel-header">
        <div>
          <div className="spk-title-row">
            <h2 className="h5-panel-title">🎞️ SpektraLab 物理胶片暗房</h2>
            <span className={`spk-engine-pill ${engineBadge.cls}`}>{engineBadge.text}</span>
            {activeImage?.isRaw && (
              <span className="spk-raw-pill">🔬 16位线性 RAW 无损管线</span>
            )}
          </div>
          <p className="h5-panel-desc">
            81 波段真实染料层模拟 · 135/120 齿孔片边 · EXIF 石英日期后背
          </p>
        </div>
        {activeImage?.styledSrc && (
          <button
            type="button"
            className="h5-mini-outline-btn"
            onClick={onRestoreOriginal}
          >
            ↩️ 恢复原图
          </button>
        )}
      </div>

      {/* Sub-navigation inside Darkroom */}
      <div className="h5-subtab-bar">
        {[
          { id: 'film', label: '🎞️ 胶片显影' },
          { id: 'edge', label: `🖼️ 片边齿孔${params.border ? ' · 开' : ''}` },
          { id: 'date', label: `🕒 日期后背${params.dateOn ? ' · 开' : ''}` }
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`h5-subtab-pill ${subTab === tab.id ? 'active' : ''}`}
            onClick={() => setSubTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* SUBTAB 1: FILM & PAPER SIMULATION */}
      {subTab === 'film' && (
        <div className="h5-subtab-content spk-section-stack">
          {/* Film category pills */}
          <div className="spk-cat-scroll">
            {FILM_CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                type="button"
                className={`spk-cat-pill ${category === cat.id ? 'active' : ''}`}
                onClick={() => setCategory(cat.id)}
              >
                {cat.label}
              </button>
            ))}
          </div>

          {/* Film stock cards */}
          <div className="spk-film-grid">
            {visibleFilms.map((film) => {
              const active = params.film === film.id;
              return (
                <button
                  key={film.id}
                  type="button"
                  className={`spk-film-card ${active ? 'active' : ''}`}
                  onClick={() => handleSelectFilm(film.id)}
                >
                  <div className="spk-film-swatch" style={{ background: film.palette[0], color: film.palette[1] }}>
                    <span className="spk-film-brand">{film.brand}</span>
                    {film.iso && <span className="spk-film-iso">ISO {film.iso}</span>}
                  </div>
                  <div className="spk-film-name">{film.shortName}</div>
                  <div className="spk-film-tag">{film.tag}</div>
                  {active && <span className="spk-film-check">✓</span>}
                </button>
              );
            })}
          </div>

          {/* Paper selection & quick tone controls */}
          <div className="spk-box">
            <div className="spk-box-row">
              <span className="spk-label">🖨️ 冲印相纸</span>
              <select
                className="spk-select"
                value={params.paper}
                disabled={params.film === 'none' || currentFilm?.type === 'positive'}
                onChange={(e) => onUpdateParams({ paper: e.target.value })}
              >
                {paperOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="spk-field-block" style={{ marginBottom: 10 }}>
              <span className="spk-label">🎚️ 测光模式</span>
              <div className="h5-pill-group">
                {[
                  { id: 'auto', label: '智能自适应' },
                  { id: 'highlight', label: '高光优先' },
                  { id: 'average', label: '全局提亮' },
                  { id: 'off', label: '关闭测光' }
                ].map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`h5-choice-pill ${(params.metering || 'auto') === m.id ? 'active' : ''}`}
                    onClick={() => onUpdateParams({ metering: m.id })}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="spk-sliders-header">
              <span className="spk-label">🎛️ 暗房显影微调</span>
              <button
                type="button"
                className="spk-reset-link"
                onClick={() =>
                  onUpdateParams({
                    darkroomExposure: SPEKTRA_UI_DEFAULTS.darkroomExposure,
                    metering: SPEKTRA_UI_DEFAULTS.metering,
                    highlightProtect: SPEKTRA_UI_DEFAULTS.highlightProtect,
                    shadowLift: SPEKTRA_UI_DEFAULTS.shadowLift,
                    temperature: SPEKTRA_UI_DEFAULTS.temperature,
                    contrast: SPEKTRA_UI_DEFAULTS.contrast,
                    grain: SPEKTRA_UI_DEFAULTS.grain,
                    halation: SPEKTRA_UI_DEFAULTS.halation,
                    vignette: SPEKTRA_UI_DEFAULTS.vignette
                  })
                }
              >
                ↺ 恢复默认
              </button>
            </div>

            <div className="spk-slider-grid">
              {[
                { key: 'darkroomExposure', label: '暗房曝光', min: -3, max: 3, step: 0.1, fmt: (v) => `${v > 0 ? '+' : ''}${Number(v).toFixed(1)} EV` },
                { key: 'highlightProtect', label: '高光保护', min: 0, max: 100, step: 5, fmt: (v) => `${v}%` },
                { key: 'shadowLift', label: '阴影恢复', min: -40, max: 100, step: 5, fmt: (v) => `${v > 0 ? '+' : ''}${v}%` },
                { key: 'temperature', label: '色温冷暖', min: -60, max: 60, step: 2, fmt: (v) => `${v > 0 ? '+' : ''}${v}` },
                { key: 'contrast', label: '反差对比', min: -40, max: 40, step: 2, fmt: (v) => `${v > 0 ? '+' : ''}${v}` },
                { key: 'grain', label: '银盐颗粒', min: 0, max: 100, step: 5, fmt: (v) => `${v}%` },
                { key: 'halation', label: '高光光晕', min: 0, max: 100, step: 5, fmt: (v) => `${v}%` },
                { key: 'vignette', label: '镜头暗角', min: 0, max: 100, step: 5, fmt: (v) => `${v}%` }
              ].map((s) => (
                <label key={s.key} className="spk-slider-item">
                  <div className="spk-slider-meta">
                    <span>{s.label}</span>
                    <strong>{s.fmt(params[s.key] ?? 0)}</strong>
                  </div>
                  <input
                    type="range"
                    min={s.min}
                    max={s.max}
                    step={s.step}
                    value={params[s.key] ?? 0}
                    onChange={(e) => onUpdateParams({ [s.key]: Number(e.target.value) })}
                  />
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* SUBTAB 2: FILM EDGE & SPROCKET PERFORATIONS */}
      {subTab === 'edge' && (
        <div className="h5-subtab-content spk-section-stack">
          <div className={`h5-feature-toggle-card ${params.border ? 'active-indigo' : ''}`}>
            <div className="h5-toggle-row">
              <div className="h5-toggle-info">
                <div className="h5-toggle-title">
                  <span>🎞️ 胶片片边、齿孔与片号</span>
                  <span className="h5-mini-badge indigo">135 / 120</span>
                </div>
                <p>还原暗房扫描片门、齿孔排列、片基灰雾及实拍片边字</p>
              </div>
              <button
                type="button"
                className={`h5-switch-pill ${params.border ? 'on' : 'off'}`}
                onClick={() => onUpdateParams({ border: !params.border })}
              >
                <span className="switch-dot" />
                <span>{params.border ? '已开启' : '已关闭'}</span>
              </button>
            </div>
          </div>

          {params.border && (
            <div className="spk-box spk-section-stack">
              <div className="spk-field-block">
                <span className="spk-label">📐 胶片画幅与齿孔规格</span>
                <div className="spk-format-grid">
                  {Object.values(EDGE_FORMATS).map((fmt) => (
                    <button
                      key={fmt.id}
                      type="button"
                      className={`spk-format-card ${params.edgeFormat === fmt.id ? 'active' : ''}`}
                      onClick={() => handleSelectEdgeFormat(fmt.id)}
                    >
                      <strong>{fmt.label}</strong>
                      <span>{fmt.desc}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="spk-field-block">
                <span className="spk-label">✂️ 画面比例与片条走向</span>
                <div className="h5-pill-group">
                  {[
                    { id: 'keep', label: '保持原图比例' },
                    { id: 'gate', label: '裁切标准片门比例' }
                  ].map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className={`h5-choice-pill ${params.edgeCropMode === m.id ? 'active' : ''}`}
                      onClick={() => onUpdateParams({ edgeCropMode: m.id })}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                <div className="h5-pill-group" style={{ marginTop: 6 }}>
                  {[
                    { id: 'auto', label: '🔄 智能横竖' },
                    { id: 'horizontal', label: '↔️ 上下齿孔' },
                    { id: 'vertical', label: '↕️ 左右齿孔' }
                  ].map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      className={`h5-choice-pill ${params.edgeOrientation === o.id ? 'active' : ''}`}
                      onClick={() => onUpdateParams({ edgeOrientation: o.id })}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="spk-two-col">
                <div className="spk-field-block">
                  <span className="spk-label">边框形态</span>
                  <div className="h5-pill-group">
                    {[
                      { id: 'strip', label: '整幅齿孔' },
                      { id: 'filed', label: '窄黑片门' }
                    ].map((st) => (
                      <button
                        key={st.id}
                        type="button"
                        className={`h5-choice-pill ${params.edgeStyle === st.id ? 'active' : ''}`}
                        onClick={() => onUpdateParams({ edgeStyle: st.id })}
                      >
                        {st.label}
                      </button>
                    ))}
                  </div>
                </div>

                {is135Gauge && params.edgeStyle !== 'filed' && (
                  <div className="spk-field-block">
                    <span className="spk-label">齿孔底色</span>
                    <div className="h5-pill-group">
                      {[
                        { id: 'white', label: '⬜ 扫描透白' },
                        { id: 'black', label: '⬛ 暗房黑孔' }
                      ].map((h) => (
                        <button
                          key={h.id}
                          type="button"
                          className={`h5-choice-pill ${params.edgeHoles === h.id ? 'active' : ''}`}
                          onClick={() => onUpdateParams({ edgeHoles: h.id })}
                        >
                          {h.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="spk-field-block">
                <span className="spk-label">片门切角样式</span>
                <div className="h5-pill-group">
                  {[
                    { id: 'rounded', label: '微圆角' },
                    { id: 'square', label: '直角' },
                    { id: 'eared', label: '耳形切口' },
                    { id: 'kicked', label: '哈苏V角' }
                  ].map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      className={`h5-choice-pill ${params.edgeGate === g.id ? 'active' : ''}`}
                      onClick={() => onUpdateParams({ edgeGate: g.id })}
                    >
                      {g.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="spk-slider-grid">
                <label className="spk-slider-item">
                  <div className="spk-slider-meta">
                    <span>画格编号</span>
                    <strong>#{String(params.frameNumber || 24).padStart(2, '0')}</strong>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={36}
                    step={1}
                    value={params.frameNumber || 24}
                    onChange={(e) => onUpdateParams({ frameNumber: Number(e.target.value) })}
                  />
                </label>

                <label className="spk-slider-item">
                  <div className="spk-slider-meta">
                    <span>边缘漏光</span>
                    <strong>{params.edgeLeaks || 0}%</strong>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={params.edgeLeaks || 0}
                    onChange={(e) => onUpdateParams({ edgeLeaks: Number(e.target.value) })}
                  />
                </label>
              </div>
            </div>
          )}
        </div>
      )}

      {/* SUBTAB 3: QUARTZ DATE BACK */}
      {subTab === 'date' && (
        <div className="h5-subtab-content spk-section-stack">
          <div className={`h5-feature-toggle-card ${params.dateOn ? 'active-emerald' : ''}`}>
            <div className="h5-toggle-row">
              <div className="h5-toggle-info">
                <div className="h5-toggle-title">
                  <span>🕒 胶片石英日期后背 (Date Back)</span>
                </div>
                <p>在胶片显影前通过光学曝光叠印橙红数码管日期，随胶片一起显影发光</p>
              </div>
              <button
                type="button"
                className={`h5-switch-pill emerald ${params.dateOn ? 'on' : 'off'}`}
                onClick={() => onUpdateParams({ dateOn: !params.dateOn })}
              >
                <span className="switch-dot" />
                <span>{params.dateOn ? '已开启' : '已关闭'}</span>
              </button>
            </div>
          </div>

          {params.dateOn && (
            <div className="spk-box spk-section-stack">
              <div className="spk-date-preview-bar">
                <span className="spk-date-source-tag">
                  {params.dateSource === 'custom'
                    ? '✏️ 自定义印字'
                    : (exifDateInfo.fromExif ? '📅 已读取照片 EXIF 时间' : '📅 无 EXIF，使用今天日期')}
                </span>
                <code className="spk-date-led-sample">{resolvedDatePreview}</code>
              </div>

              <div className="spk-field-block">
                <span className="spk-label">日期来源</span>
                <div className="h5-pill-group">
                  {[
                    { id: 'exif', label: '📅 自动读取 EXIF' },
                    { id: 'custom', label: '✏️ 自定义内容' }
                  ].map((src) => (
                    <button
                      key={src.id}
                      type="button"
                      className={`h5-choice-pill ${params.dateSource === src.id ? 'active' : ''}`}
                      onClick={() => onUpdateParams({ dateSource: src.id })}
                    >
                      {src.label}
                    </button>
                  ))}
                </div>
              </div>

              {params.dateSource === 'exif' ? (
                <div className="spk-field-block">
                  <span className="spk-label">日期格式</span>
                  <div className="h5-pill-group">
                    {[
                      { id: 'classic_yy', label: "'26 10 05 经典" },
                      { id: 'ymd_dot', label: '2026.10.05' },
                      { id: 'ymd_dash', label: '2026-10-05' }
                    ].map((fmt) => (
                      <button
                        key={fmt.id}
                        type="button"
                        className={`h5-choice-pill ${params.dateFormat === fmt.id ? 'active' : ''}`}
                        onClick={() => onUpdateParams({ dateFormat: fmt.id })}
                      >
                        {fmt.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="h5-field">
                  <label>自定义日期 / 字符（支持数字、&apos;、.、-）</label>
                  <input
                    type="text"
                    className="h5-input"
                    value={params.dateText}
                    onChange={(e) => onUpdateParams({ dateText: e.target.value })}
                    placeholder="例如：'98 08 18 或 2026.10.05"
                  />
                </div>
              )}

              <div className="spk-field-block">
                <span className="spk-label">显示字体样式</span>
                <div className="h5-pill-group">
                  {[
                    { id: 'lcd', label: '🔢 七段数码管' },
                    { id: 'dots', label: '⠿ 复古点阵' },
                    { id: 'data', label: '📷 机背参数' }
                  ].map((st) => (
                    <button
                      key={st.id}
                      type="button"
                      className={`h5-choice-pill ${params.dateStyle === st.id ? 'active' : ''}`}
                      onClick={() => onUpdateParams({ dateStyle: st.id })}
                    >
                      {st.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="spk-field-block">
                <span className="spk-label">曝光角落位置</span>
                <div className="h5-pill-group">
                  {[
                    { id: 'br', label: '↘️ 右下角' },
                    { id: 'bl', label: '↙️ 左下角' },
                    { id: 'tr', label: '↗️ 右上角' },
                    { id: 'tl', label: '↖️ 左上角' }
                  ].map((pos) => (
                    <button
                      key={pos.id}
                      type="button"
                      className={`h5-choice-pill ${params.dateCorner === pos.id ? 'active' : ''}`}
                      onClick={() => onUpdateParams({ dateCorner: pos.id })}
                    >
                      {pos.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="spk-slider-grid">
                <label className="spk-slider-item">
                  <div className="spk-slider-meta">
                    <span>日期字号</span>
                    <strong>{(params.dateSize || 1).toFixed(2)}×</strong>
                  </div>
                  <input
                    type="range"
                    min={0.6}
                    max={1.8}
                    step={0.05}
                    value={params.dateSize || 1}
                    onChange={(e) => onUpdateParams({ dateSize: Number(e.target.value) })}
                  />
                </label>

                <label className="spk-slider-item">
                  <div className="spk-slider-meta">
                    <span>发光浓度</span>
                    <strong>{Math.round((params.dateExposure || 1) * 100)}%</strong>
                  </div>
                  <input
                    type="range"
                    min={0.3}
                    max={1.8}
                    step={0.05}
                    value={params.dateExposure || 1}
                    onChange={(e) => onUpdateParams({ dateExposure: Number(e.target.value) })}
                  />
                </label>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Optional source choice when AI image exists & watermark option */}
      <div className="spk-bottom-options">
        {activeImage?.aiRawSrc && (
          <div className="spk-source-row">
            <span className="spk-label">底片输入来源：</span>
            <div className="h5-pill-group">
              {[
                { id: 'original', label: '📷 原始实拍图' },
                { id: 'ai', label: '🎨 AI 重绘图' }
              ].map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`h5-choice-pill ${params.sourceType === s.id ? 'active' : ''}`}
                  onClick={() => onUpdateParams({ sourceType: s.id })}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {!params.border && (
          <label className="spk-checkbox-row">
            <input
              type="checkbox"
              checked={Boolean(params.withLeicaWatermark)}
              onChange={(e) => onUpdateParams({ withLeicaWatermark: e.target.checked })}
            />
            <span>底部叠加「闪贴 AI · EXIF」白边摄影水印</span>
          </label>
        )}

        <div className="spk-export-res-row">
          <span className="spk-label">📐 导出分辨率</span>
          <div className="h5-pill-group">
            {[
              { val: 2400, label: '2400px 社交高清' },
              { val: 3600, label: '3600px 超清冲印' },
              { val: 6000, label: '6000px 原图级' }
            ].map((opt) => (
              <button
                key={opt.val}
                type="button"
                className={`h5-choice-pill ${(params.exportMaxEdge || 3600) === opt.val ? 'active' : ''}`}
                onClick={() => onUpdateParams({ exportMaxEdge: opt.val })}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <button
        type="button"
        className="h5-primary-action-btn"
        disabled={isBatchProcessing}
        onClick={onBatchDevelop}
      >
        {isBatchProcessing
          ? '⏳ 正在高清冲印输出…'
          : isRenderingPreview
            ? '🔄 实时预览计算中 · 点击批量高清冲印'
            : `🎞️ 高清冲印并应用到已选 (${selectedBatchCount} 张)`}
      </button>
    </div>
  );
}
