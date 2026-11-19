'use strict';
/**
 * 教材插图：页图落盘 → 精确裁图 → 图号索引 → 题目配图。
 *
 * 设计要点：
 * - 精确裁图由渲染层 canvas 完成（主进程不引图像库），这里只负责落盘与索引。
 * - 图片写进 userData/question-assets/textbook/<subjectId>/，直接用已有的
 *   openexam-asset://question-assets/... 协议访问，渲染层零改动。
 * - 页图同时也留在科目文件夹 教材/页图/，Obsidian 里能直接翻原页。
 * - 每页的插图清单是「追加覆盖」：同一页重新解析时用新结果替换旧记录，
 *   断点续传时不会把旧图重复堆进索引。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const subjectManager = require('./subjectManager.js');

const IMAGE_EXT = '.jpg';
const INDEX_FILE = '插图.json';
const PAGE_IMAGE_DIR = '页图';

function subjectTextbookRoot(subjectId) {
  const dir = subjectManager.getSubjectDir(subjectId);
  if (!dir) throw new Error('科目不存在');
  return path.join(dir, '教材');
}

function pageImageDir(subjectId) {
  return path.join(subjectTextbookRoot(subjectId), PAGE_IMAGE_DIR);
}

function assetDir(subjectId) {
  return path.join(app.getPath('userData'), 'question-assets', 'textbook', String(subjectId));
}

function assetUrl(subjectId, figureId) {
  return `openexam-asset://question-assets/textbook/${String(subjectId)}/${figureId}${IMAGE_EXT}`;
}

function indexFile(subjectId) {
  return path.join(subjectTextbookRoot(subjectId), INDEX_FILE);
}

function loadIndex(subjectId) {
  try {
    const data = JSON.parse(fs.readFileSync(indexFile(subjectId), 'utf8'));
    return {
      version: 1,
      fileName: data?.fileName || '',
      figures: Array.isArray(data?.figures) ? data.figures : [],
      pageImages: Array.isArray(data?.pageImages) ? data.pageImages : [],
    };
  } catch {
    return { version: 1, fileName: '', figures: [], pageImages: [] };
  }
}

function saveIndex(subjectId, data) {
  const target = indexFile(subjectId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, target);
  return data;
}

/** 换教材时把旧书的页图、裁图、索引一起清掉，避免两本书的图号串台 */
function resetFigures(subjectId, fileName) {
  const root = subjectTextbookRoot(subjectId);
  try { fs.rmSync(path.join(root, PAGE_IMAGE_DIR), { recursive: true, force: true }); } catch { /* 目录可能不存在 */ }
  try { fs.rmSync(assetDir(subjectId), { recursive: true, force: true }); } catch { /* 同上 */ }
  return saveIndex(subjectId, { version: 1, fileName: fileName || '', figures: [], pageImages: [] });
}

function writeBase64(target, base64) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const buffer = Buffer.from(String(base64 || '').replace(/^data:[^,]+,/, ''), 'base64');
  if (!buffer.length) throw new Error('图片数据为空');
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, target);
  return buffer.length;
}

/** 保存一页的原始扫描图（整页兜底 + Obsidian 翻页用），不额外花 API token */
function savePageImage({ subjectId, page, base64, fileName } = {}) {
  const pageNo = Number(page);
  if (!Number.isFinite(pageNo) || pageNo <= 0) throw new Error('页码不合法');
  const root = subjectTextbookRoot(subjectId);
  fs.mkdirSync(root, { recursive: true });

  const index = loadIndex(subjectId);
  if (fileName && index.fileName && index.fileName !== fileName) resetFigures(subjectId, fileName);
  const state = loadIndex(subjectId);
  if (fileName && !state.fileName) state.fileName = fileName;

  const rel = `${PAGE_IMAGE_DIR}/页-${String(pageNo).padStart(4, '0')}${IMAGE_EXT}`;
  const size = writeBase64(path.join(root, PAGE_IMAGE_DIR, path.basename(rel)), base64);

  const rest = state.pageImages.filter((item) => Number(item.page) !== pageNo);
  rest.push({ page: pageNo, file: rel, size });
  state.pageImages = rest.sort((a, b) => a.page - b.page);
  saveIndex(subjectId, state);
  return { page: pageNo, file: rel, size };
}

/**
 * 保存一页里裁出来的插图。
 * @param figures [{ no, caption, base64, bbox:[x1,y1,x2,y2] }]  bbox 为 0-1000 归一化坐标
 */
function saveFigures({ subjectId, page, figures = [], fileName } = {}) {
  const pageNo = Number(page);
  if (!Number.isFinite(pageNo) || pageNo <= 0) throw new Error('页码不合法');
  const dir = assetDir(subjectId);
  fs.mkdirSync(dir, { recursive: true });

  const state = loadIndex(subjectId);
  if (fileName && state.fileName && state.fileName !== fileName) resetFigures(subjectId, fileName);
  const index = loadIndex(subjectId);
  if (fileName && !index.fileName) index.fileName = fileName;

  // 同一页重跑：先删掉旧裁图，再补新的
  const old = index.figures.filter((item) => Number(item.page) === pageNo);
  for (const item of old) {
    try { fs.unlinkSync(path.join(dir, `${item.id}${IMAGE_EXT}`)); } catch { /* 文件可能已不在 */ }
  }
  index.figures = index.figures.filter((item) => Number(item.page) !== pageNo);

  const saved = [];
  for (const figure of figures || []) {
    const no = normalizeFigureNo(figure?.no || figure?.number || '');
    if (!no || !figure?.base64) continue;
    const id = `p${String(pageNo).padStart(4, '0')}_${crypto.createHash('md5')
      .update(`${no}|${figure.caption || ''}|${JSON.stringify(figure.bbox || [])}`)
      .digest('hex').slice(0, 10)}`;
    let size;
    try {
      size = writeBase64(path.join(dir, `${id}${IMAGE_EXT}`), figure.base64);
    } catch (error) {
      console.warn('[Figures] 插图落盘失败:', no, error?.message || error);
      continue;
    }
    const record = {
      id,
      no,
      page: pageNo,
      caption: String(figure.caption || '').slice(0, 120),
      bbox: Array.isArray(figure.bbox) ? figure.bbox.slice(0, 4) : null,
      url: assetUrl(subjectId, id),
      size,
    };
    index.figures.push(record);
    saved.push(record);
  }

  index.figures.sort((a, b) => a.page - b.page || a.no.localeCompare(b.no));
  saveIndex(subjectId, index);
  return { page: pageNo, saved: saved.length, figures: saved };
}

/* ------------------------------------------------------------- 图号匹配 */

/**
 * 把「图 2-40」「图2．40(a)」「图 2.40」统一成可比较的键。
 * 教材里同一个图在不同题目里写法经常不一致，这里只保留「章节-序号」主干。
 */
function normalizeFigureNo(input) {
  const text = String(input || '').trim();
  if (!text) return '';
  const match = /([一二三四五六七八九十\d]+)\s*[-.．—–]\s*(\d+)/.exec(text);
  if (!match) {
    const plain = /(\d+)\s*[-.．—–]\s*(\d+)/.exec(text);
    if (!plain) return '';
    return `${plain[1]}-${plain[2]}`;
  }
  const cn = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const head = cn[match[1]] || match[1];
  return `${head}-${match[2]}`;
}

/** 从题干里抽出所有被引用的图号 */
function extractFigureRefs(text) {
  const source = String(text || '');
  const refs = new Set();
  const re = /(?:图|表|Fig(?:ure)?\.?|图\s*)\s*([一二三四五六七八九十\d]+\s*[-.．—–]\s*\d+(?:\s*[（(][a-zA-Z\d][)）])?)/gi;
  let match = re.exec(source);
  while (match) {
    const key = normalizeFigureNo(match[1]);
    if (key) refs.add(key);
    match = re.exec(source);
  }
  return [...refs];
}

/** 题干是否提到图：含没写图号的「如图」「见下图」这类引用 */
function hasFigureHint(text) {
  return /如图|见图|下图|上图|左图|右图|图中|附图|题图|图\s*[一二三四五六七八九十\d]/.test(String(text || ''));
}

/* ---------------- 图号 → 插图索引 ---------------- */

const textCache = new Map();

/** 教材全文（带页标记），供助教检索与页码定位复用 */
function textbookText(subjectId) {
  const file = path.join(subjectTextbookRoot(subjectId), '教材全文.md');
  const stat = fs.statSync(file);
  const cached = textCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached;
  const { repairGhostText } = require('./textRepair.js');
  const text = repairGhostText(fs.readFileSync(file, 'utf8')).text;
  const markers = [...text.matchAll(/<!--\s*第\s*(\d+)\s*页/g)].map((m) => ({ index: m.index, page: Number(m[1]) }));
  const entry = { mtimeMs: stat.mtimeMs, text, markers };
  // 只缓存最近 2 本教材，避免长期驻留多份全文
  if (textCache.size >= 2 && !textCache.has(file)) {
    textCache.delete(textCache.keys().next().value);
  }
  textCache.set(file, entry);
  return entry;
}

function figureRecords(subjectId) {
  const index = loadIndex(subjectId);
  return index.figures.filter((figure) => fs.existsSync(path.join(assetDir(subjectId), `${figure.id}${IMAGE_EXT}`)));
}

/** 题目所在块的页范围（本章页范围），拿不到就是 null */
function pageSpanOf(question) {
  const from = Number(question?.__pageSpan?.from) || 0;
  const to = Number(question?.__pageSpan?.to) || 0;
  return from && to ? { from: Math.min(from, to), to: Math.max(from, to) } : null;
}

/**
 * 明确图号 → 插图记录。只在「本章页范围 / 题目来源页」内确认；
 * 同号图有多张或不在该范围内时放弃——教材正文图号与习题图号会重号，
 * 全书唯一并不等于题目要的那张图。
 */
function resolveFigures(subjectId, refs, { page = 0, span = null, records } = {}) {
  const wanted = new Set((Array.isArray(refs) ? refs : [refs]).map(normalizeFigureNo).filter(Boolean));
  if (!wanted.size) return [];
  const all = records || figureRecords(subjectId);
  const hits = [];
  for (const no of wanted) {
    const sameNo = all.filter((figure) => normalizeFigureNo(figure.no) === no);
    if (!sameNo.length) continue;
    let pick = null;
    if (span) {
      const inSpan = sameNo.filter((figure) => Number(figure.page) >= span.from && Number(figure.page) <= span.to);
      if (inSpan.length === 1) pick = inSpan[0];
    } else if (page > 0) {
      const onPage = sameNo.filter((figure) => Number(figure.page) === Number(page));
      if (onPage.length === 1) pick = onPage[0];
    }
    if (pick) hits.push(pick);
  }
  return hits;
}

/** 候选图（不自动挂图时给用户选，或用于跳原页） */
function listFigureCandidates(subjectId, refs, { page = 0, span = null } = {}) {
  const wanted = new Set((Array.isArray(refs) ? refs : [refs]).map(normalizeFigureNo).filter(Boolean));
  let list = figureRecords(subjectId);
  if (wanted.size) list = list.filter((figure) => wanted.has(normalizeFigureNo(figure.no)));
  else if (page > 0) list = list.filter((figure) => Number(figure.page) === Number(page));
  else list = [];
  if (span) list = list.filter((figure) => Number(figure.page) >= span.from && Number(figure.page) <= span.to);
  return list.map(({ id, no, page: pageNo, caption, url }) => ({ id, no, page: pageNo, caption, url }));
}

/** 兜底：精确裁图没命中时，用整页扫描图 */
function resolvePageImage(subjectId, page) {
  const index = loadIndex(subjectId);
  const hit = index.pageImages.find((item) => Number(item.page) === Number(page));
  if (!hit) return null;
  const root = subjectTextbookRoot(subjectId);
  const absolute = path.join(root, ...String(hit.file).split('/'));
  return fs.existsSync(absolute) ? { file: hit.file, absolute } : null;
}

/**
 * 给题目挂配图。宁缺勿错：
 * - 有明确图号：只在本章页范围 / 题目来源页内确认，不在范围内或有多张就放弃；
 * - 没有明确图号（只写「如图」）：只有来源页恰好一张图时才自动挂，多图不猜；
 * - 整页扫描图一律不写进材料区，只留 textbookPage 元数据供「查看教材第 N 页」入口使用。
 */
function attachFiguresToQuestions(subjectId, questions) {
  let attached = 0;
  let fallback = 0;
  let pageLinks = 0;
  const records = figureRecords(subjectId);

  const output = (questions || []).map((question) => {
    const content = String(question?.content || question?.contentHtml || question?.content_html || '');
    const refs = extractFigureRefs(content);
    const hint = refs.length > 0 || hasFigureHint(content);
    const sourcePage = Number(question?.__sourcePage || question?.sourcePage) || 0;
    const span = pageSpanOf(question);

    let figures = refs.length ? resolveFigures(subjectId, refs, { page: sourcePage, span, records }) : [];
    let source = 'figure';

    // 图号对不上（或题干只写「如图」）时，只信「同页/本章范围内唯一一张图」
    if (!figures.length && hint) {
      const scope = sourcePage > 0
        ? records.filter((figure) => Number(figure.page) === sourcePage)
        : (span ? records.filter((figure) => Number(figure.page) >= span.from && Number(figure.page) <= span.to) : []);
      if (scope.length === 1) {
        figures = scope;
        source = sourcePage > 0 ? 'page-single' : 'span-single';
        fallback += 1;
      }
    }

    // 整页图只作为「查看教材第 N 页」的元数据，绝不进材料区冒充图 X-Y
    const pageImage = sourcePage > 0 ? resolvePageImage(subjectId, sourcePage) : null;
    const textbookPage = pageImage ? { page: sourcePage, file: pageImage.file } : null;
    if (textbookPage) pageLinks += 1;

    if (!figures.length) {
      if (!textbookPage) return question;
      const candidates = listFigureCandidates(subjectId, refs, { page: sourcePage, span });
      return { ...question, textbookPage, ...(candidates.length ? { figureCandidates: candidates } : {}) };
    }

    attached += 1;
    // 只用 p / img：这两个标签在 textbookFormat 的富文本白名单和 RichQuestionContent 里都放行，
    // figure / figcaption 会被清洗掉，反而丢图。
    const html = figures.map((figure) => {
      const label = figure.caption || `教材${figure.no ? ` ${figure.no}` : ''}${figure.page ? `（第 ${figure.page} 页）` : ''}`;
      return `<p class="tb-figure"><img src="${figure.url}" alt="${escapeAttr(label)}" /></p>`;
    }).join('\n');
    return {
      ...question,
      materialHtml: [question?.materialHtml || question?.material_html || '', html].filter(Boolean).join('\n'),
      figureIds: figures.map((item) => item.id || item.url),
      figureSource: source,
      ...(textbookPage ? { textbookPage } : {}),
    };
  });

  return { questions: output, attached, fallback, pageLinks };
}

function escapeHtml(text) {
  return String(text || '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}
function escapeAttr(text) { return escapeHtml(text); }

/** 整页兜底图片也放进 asset 目录，让 openexam-asset:// 能读到 */
function ensurePageFallbackAsset(subjectId, page) {
  const pageImage = resolvePageImage(subjectId, page);
  if (!pageImage) return null;
  const id = `page-${String(page).padStart(4, '0')}`;
  const target = path.join(assetDir(subjectId), `${id}${IMAGE_EXT}`);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(pageImage.absolute, target);
  }
  return assetUrl(subjectId, id);
}

/** MinerU 等本地引擎给的插图已经是裁好的文件：直接拷进 asset 目录并登记索引 */
function saveFigureFiles({ subjectId, page, figures = [], fileName } = {}) {
  const pageNo = Number(page);
  if (!Number.isFinite(pageNo) || pageNo <= 0) throw new Error('页码不合法');
  const dir = assetDir(subjectId);
  fs.mkdirSync(dir, { recursive: true });

  const state = loadIndex(subjectId);
  if (fileName && state.fileName && state.fileName !== fileName) resetFigures(subjectId, fileName);
  const index = loadIndex(subjectId);
  if (fileName && !index.fileName) index.fileName = fileName;

  index.figures = index.figures.filter((item) => Number(item.page) !== pageNo);
  const saved = [];
  for (const figure of figures || []) {
    if (!figure?.absPath || !fs.existsSync(figure.absPath)) continue;
    const no = normalizeFigureNo(figure?.no) || `p${pageNo}`;
    const id = `p${String(pageNo).padStart(4, '0')}_${crypto.createHash('md5')
      .update(`${no}|${figure.caption || ''}|${figure.absPath}`)
      .digest('hex').slice(0, 10)}`;
    const target = path.join(dir, `${id}${IMAGE_EXT}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(figure.absPath, target);
    } catch (error) {
      console.warn('[Figures] 插图拷贝失败:', figure.absPath, error?.message || error);
      continue;
    }
    const record = {
      id,
      no,
      page: pageNo,
      caption: String(figure?.caption || '').slice(0, 120),
      bbox: Array.isArray(figure?.bbox) ? figure.bbox.map((v) => Math.round(Number(v))) : null,
      url: assetUrl(subjectId, id),
      size: fs.statSync(target).size,
    };
    index.figures.push(record);
    saved.push(record);
  }
  index.figures.sort((a, b) => a.page - b.page || a.no.localeCompare(b.no));
  saveIndex(subjectId, index);
  return { page: pageNo, saved: saved.length, figures: saved };
}

function stats(subjectId) {
  const index = loadIndex(subjectId);
  return {
    figures: index.figures.length,
    pageImages: index.pageImages.length,
    fileName: index.fileName,
  };
}

module.exports = {
  savePageImage,
  saveFigureFiles,
  saveFigures,
  textbookText,
  resetFigures,
  loadIndex,
  normalizeFigureNo,
  extractFigureRefs,
  resolveFigures,
  listFigureCandidates,
  resolvePageImage,
  attachFiguresToQuestions,
  ensurePageFallbackAsset,
  assetUrl,
  stats,
};
