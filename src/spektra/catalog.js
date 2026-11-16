/* SPDX-License-Identifier: GPL-3.0-or-later */

let cachedCatalogPromise = null;

export const FILM_CATEGORIES = [
  { id: 'hot', label: '🔥 热门精选' },
  { id: 'negative', label: '🎞️ 彩色负片' },
  { id: 'cine', label: '🎬 电影卷' },
  { id: 'positive', label: '🌅 反转正片' },
  { id: 'bw', label: '⚫ 银盐黑白' },
  { id: 'none', label: '📷 原色直出' }
];

export const HOT_FILM_IDS = [
  'kodak_portra_400',
  'kodak_gold_200',
  'fujifilm_pro_400h',
  'fujifilm_c200',
  'cinestill_800t',
  'fujifilm_velvia_100',
  'kodak_kodachrome_64',
  'ilford_hp5_plus_400'
];

export const FILM_META_ZH = {
  cinestill_800t: { tag: '霓虹红晕 · 夜景神器', palette: ['#8a403b', '#f0dcca', '#d4ba7d'] },
  fujifilm_c200: { tag: '日系通透 · 绿色高光', palette: ['#7e9b76', '#1f261e', '#d9e3c6'] },
  fujifilm_neopan_acros_100_ii: { tag: '细腻灰阶 · 极微颗粒', palette: ['#a9aca4', '#1d221e', '#6f776a'] },
  fujifilm_pro_400h: { tag: '日系青透 · 人像空气感', palette: ['#829c79', '#25291f', '#e0c297'] },
  fujifilm_provia_100f: { tag: '自然写实 · 日光正片', palette: ['#588776', '#f4f5ee', '#a5cbb9'] },
  fujifilm_velvia_100: { tag: '浓郁艳丽 · 风光大片', palette: ['#8a4d6e', '#faf2e8', '#e58e73'] },
  fujifilm_xtra_400: { tag: '青绿阴影 · 街拍经典', palette: ['#6b8e78', '#222723', '#d7c38a'] },
  ilford_hp5_plus_400: { tag: '纪实抓拍 · 经典银盐', palette: ['#b5b8ad', '#1e2420', '#727a6a'] },
  kodak_ektachrome_100: { tag: '清澈冷调 · 复古幻灯', palette: ['#4b799c', '#f3f6fa', '#d8b66c'] },
  kodak_ektar_100: { tag: '高饱和暖红 · 风景锐利', palette: ['#a05c4b', '#f5e5c9', '#dbaf67'] },
  kodak_gold_200: { tag: '复古暖金 · 阳光日常', palette: ['#d7ad45', '#3b2916', '#b15732'] },
  kodak_kodachrome_64: { tag: '国家地理 · 传奇正片', palette: ['#9e6340', '#faf0de', '#d89b48'] },
  kodak_portra_160: { tag: '柔和淡雅 · 棚拍人像', palette: ['#c59f7e', '#2a221b', '#ebd3b8'] },
  kodak_portra_400: { tag: '温润肤色 · 人像全能', palette: ['#ba9a6d', '#25291f', '#e0c297'] },
  kodak_portra_800: { tag: '暗光高感 · 黄金暖调', palette: ['#c2935b', '#2b2017', '#e5bb81'] },
  kodak_portra_800_push1: { tag: '迫冲 +1 档 · 高反差', palette: ['#b5824c', '#291d14', '#dfa86c'] },
  kodak_portra_800_push2: { tag: '迫冲 +2 档 · 粗颗粒', palette: ['#a36e3d', '#241810', '#d19252'] },
  kodak_tmax_100: { tag: '现代锐利 · 细腻黑白', palette: ['#aeb2aa', '#1a1e1c', '#767d72'] },
  kodak_tri_x_400: { tag: '粗犷颗粒 · 硬朗反差', palette: ['#9b9e95', '#171917', '#61665d'] },
  kodak_ultramax_400: { tag: '浓郁明快 · 扫街必备', palette: ['#c78d43', '#2e2115', '#ebba68'] },
  kodak_verita_200d: { tag: '宽容自然 · 日光电影', palette: ['#8d8267', '#26231c', '#cfc19b'] },
  kodak_vision3_200t: { tag: '钨丝灯光 · 电影质感', palette: ['#58768c', '#f0f4f8', '#9eb8cb'] },
  kodak_vision3_250d: { tag: '胶片电影 · 柔和宽容', palette: ['#8c7d5e', '#25221b', '#d4c198'] },
  kodak_vision3_500t: { tag: '蓝调夜景 · 电影高感', palette: ['#45617a', '#ecf2f7', '#89a7c2'] },
  kodak_vision3_50d: { tag: '极致细腻 · 晴昼电影', palette: ['#a88c60', '#2b241a', '#dfc28d'] }
};

export const EDGE_PRINT_MAP = {
  cinestill_800t: 'CINESTILL 800T   C-41',
  fujifilm_c200: 'FUJIFILM C200   CA-200',
  fujifilm_neopan_acros_100_ii: 'FUJIFILM ACROS 100 II',
  fujifilm_pro_400h: 'FUJI PRO 400H   PRO400H',
  fujifilm_provia_100f: 'FUJICHROME PROVIA 100F',
  fujifilm_velvia_100: 'FUJICHROME VELVIA 100',
  fujifilm_xtra_400: 'FUJICOLOR SUPERIA X-TRA 400',
  ilford_hp5_plus_400: 'ILFORD HP5 PLUS 400',
  kodak_ektachrome_100: 'KODAK EKTACHROME E100',
  kodak_ektar_100: 'KODAK EKTAR 100',
  kodak_gold_200: 'KODAK GOLD 200   GB200',
  kodak_kodachrome_64: 'KODAK KODACHROME 64   KR',
  kodak_portra_160: 'KODAK 160VC   PORTRA 160',
  kodak_portra_400: 'KODAK 400VC   PORTRA 400',
  kodak_portra_800: 'KODAK 800   PORTRA 800',
  kodak_portra_800_push1: 'KODAK PORTRA 800 +1',
  kodak_portra_800_push2: 'KODAK PORTRA 800 +2',
  kodak_tmax_100: 'KODAK T-MAX 100   TMX',
  kodak_tri_x_400: 'KODAK TRI-X 400   400TX',
  kodak_ultramax_400: 'KODAK ULTRAMAX 400   GC',
  kodak_verita_200d: 'KODAK VERITA 200D',
  kodak_vision3_200t: 'KODAK 5213   VISION3 200T',
  kodak_vision3_250d: 'KODAK 5207   VISION3 250D',
  kodak_vision3_500t: 'KODAK 5219   VISION3 500T',
  kodak_vision3_50d: 'KODAK 5203   VISION3 50D',
  none: 'SPEKTRA DARKROOM   35MM'
};

export const PAPER_LABELS_ZH = {
  kodak_portra_endura: 'Kodak Portra Endura (柔和人像彩纸)',
  kodak_supra_endura: 'Kodak Supra Endura (均衡标准彩纸)',
  kodak_ultra_endura: 'Kodak Ultra Endura (高反差艳丽)',
  kodak_endura_premier: 'Kodak Endura Premier (现代通透)',
  kodak_ektacolor_edge: 'Kodak Ektacolor Edge (浓郁暖调)',
  fujifilm_crystal_archive_typeii: 'Fujifilm Crystal Archive II (日系清透)',
  ilford_multigrade_iv_rc: 'Ilford Multigrade IV RC (银盐黑白纸)',
  kodak_2383: 'Kodak Vision 2383 (经典电影拷贝)',
  kodak_2393: 'Kodak Vision Premier 2393 (高对比电影拷贝)',
  none: '正片直扫 (不经过相纸冲印)',
  di: '数字中间片 (Cineon Log)'
};

export function normalizeBaseUrl(baseUrl = '/') {
  const b = String(baseUrl || '/');
  return b.endsWith('/') ? b : `${b}/`;
}

export async function loadSpektraCatalog(baseUrl = '/') {
  if (!cachedCatalogPromise) {
    const base = normalizeBaseUrl(baseUrl);
    cachedCatalogPromise = fetch(`${base}spektra/stock-catalog.json`)
      .then((res) => {
        if (!res.ok) throw new Error(`无法加载胶片目录 (${res.status})`);
        return res.json();
      })
      .then((data) => {
        const rawStocks = Array.isArray(data?.stocks) ? data.stocks : [];
        const films = rawStocks
          .filter((s) => s.stage === 'filming')
          .map((s) => {
            const meta = FILM_META_ZH[s.id] || {};
            const shortName = s.name
              .replace(/^(Kodak |Fujifilm |Ilford )/, '')
              .replace('Professional ', '');
            const iso = s.name.match(/(\d{2,4})/)?.[1] || '';
            const category = s.monochrome
              ? 'bw'
              : s.type === 'positive'
                ? 'positive'
                : s.use === 'cine'
                  ? 'cine'
                  : 'negative';
            return {
              ...s,
              shortName,
              fullName: s.name,
              brand: s.name.split(' ')[0].toUpperCase(),
              iso,
              category,
              tag: meta.tag || '实测光谱配置',
              palette: meta.palette || (s.monochrome ? ['#b5b8ad', '#1e2420', '#727a6a'] : ['#ba9a6d', '#25291f', '#e0c297'])
            };
          });
        const papers = rawStocks
          .filter((s) => s.stage === 'printing')
          .map((p) => ({
            ...p,
            labelZh: PAPER_LABELS_ZH[p.id] || p.name
          }));
        return { rawStocks, films, papers };
      })
      .catch((err) => {
        cachedCatalogPromise = null;
        throw err;
      });
  }
  return cachedCatalogPromise;
}

export function findFilm(catalog, filmId) {
  if (!filmId || filmId === 'none') {
    return {
      id: 'none',
      name: '原片直出',
      shortName: '原片直出',
      fullName: '原片直出 (仅片边/日期)',
      brand: 'ORIGINAL',
      iso: '',
      category: 'none',
      type: 'none',
      monochrome: false,
      tag: '保持原色 · 仅加片边或日期',
      palette: ['#64748b', '#f8fafc', '#94a3b8']
    };
  }
  return catalog?.films?.find((f) => f.id === filmId) || null;
}

export function isPaperCompatible(catalog, filmId, paperId) {
  if (filmId === 'none') return paperId === 'none';
  const film = findFilm(catalog, filmId);
  if (!film) return false;
  if (film.type === 'positive') return paperId === 'none';
  if (paperId === 'di') return !film.monochrome;
  const paper = catalog?.papers?.find((p) => p.id === paperId);
  return Boolean(paper && Boolean(film.monochrome) === Boolean(paper.monochrome));
}

export function defaultPaperForFilm(catalog, filmId, preferredPaper) {
  if (filmId === 'none') return 'none';
  const film = findFilm(catalog, filmId);
  if (!film) return 'kodak_portra_endura';
  if (preferredPaper && isPaperCompatible(catalog, filmId, preferredPaper)) {
    return preferredPaper;
  }
  if (film.type === 'positive') return 'none';
  return film.targetPrint || (film.monochrome ? 'ilford_multigrade_iv_rc' : 'kodak_portra_endura');
}

export function compatiblePaperOptions(catalog, filmId) {
  if (filmId === 'none') {
    return [{ id: 'none', label: '保持原片色彩 (不使用相纸)' }];
  }
  const film = findFilm(catalog, filmId);
  if (!film) return [];
  if (film.type === 'positive') {
    return [{ id: 'none', label: PAPER_LABELS_ZH.none }];
  }
  const list = (catalog?.papers || [])
    .filter((p) => isPaperCompatible(catalog, filmId, p.id))
    .map((p) => ({
      id: p.id,
      label: p.labelZh || p.name
    }));
  if (!film.monochrome) {
    list.push({ id: 'di', label: PAPER_LABELS_ZH.di });
  }
  return list;
}
