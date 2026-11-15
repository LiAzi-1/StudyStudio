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

/* ---------------- 图号 / 题干 → 教材页码（避免把整页图挂错页） ---------------- */

const textCache = new Map();

function textbookText(subjectId) {
  const file = path.join(subjectTextbookRoot(subjectId), '教材全文.md');
  const stat = fs.statSync(file);
  const cached = textCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached;
  const { repairGhostText } = require('./textRepair.js');
  const text = repairGhostText(fs.readFileSync(file, 'utf8')).text;
  const markers = [...text.matchAll(/<!--\s*第\s*(\d+)\s*页/g)].map((m) => ({ index: m.index, page: Number(m[1]) }));
  const entry = { mtimeMs: stat.mtimeMs, text, markers, squashed: null, norm: null };
  // 只缓存最近 2 本教材，避免长期驻留多份全文
  if (textCache.size >= 2 && !textCache.has(file)) {
    textCache.delete(textCache.keys().next().value);
  }
  textCache.set(file, entry);
  return entry;
}

function pageAt(entry, originalIndex) {
  let page = null;
  for (const marker of entry.markers) {
    if (marker.index <= originalIndex) page = marker.page;
    else break;
  }
  return page;
}

/** 「图 2-5」在教材正文里第一次出现的位置 → 页码 */
function pageByFigureNo(subjectId, no) {
  const match = String(no || '').match(/(\d+)\s*[-.．—–]\s*(\d+)/);
  if (!match) return null;
  try {
    const entry = textbookText(subjectId);
    if (!entry.squashed) {
      let value = '';
      const map = [];
      for (let i = 0; i < entry.text.length; i += 1) {
        if (/\s/.test(entry.text[i])) continue;
        value += entry.text[i];
        map.push(i);
      }
      entry.squashed = { value, map };
    }
    const head = match[1];
    const num = match[2];
    const occurrences = [];
    for (const variant of [`图${head}-${num}`, `图${head}.${num}`, `图${head}．${num}`, `图${head}—${num}`]) {
      let from = 0;
      while (occurrences.length < 20) {
        const at = entry.squashed.value.indexOf(variant, from);
        if (at < 0) break;
        occurrences.push(entry.squashed.map[at]);
        from = at + variant.length;
      }
    }
    if (!occurrences.length) return null;
    occurrences.sort((a, b) => a - b);
    // 优先取「图 2-5 xxx」这种图题行（同一页可能有正文引用，图题更接近插图本身）
    const caption = occurrences.find((originalIndex) => {
      const lineStart = entry.text.lastIndexOf('\n', originalIndex) + 1;
      const lineEnd = entry.text.indexOf('\n', originalIndex);
      const line = entry.text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).trim();
      return line.replace(/\s+/g, '').startsWith('图') && line.length <= 60;
    });
    return pageAt(entry, caption !== undefined ? caption : occurrences[occurrences.length - 1]);
  } catch { /* 没有教材全文就放弃 */ }
  return null;
}

/** 无图号引用：用题干原文在教材里定位，找不到就不挂图，绝不猜页 */
function pageByQuestionText(subjectId, content) {
  try {
    const entry = textbookText(subjectId);
    if (!entry.norm) {
      let value = '';
      const map = [];
      let inMath = false;
      for (let i = 0; i < entry.text.length; i += 1) {
        const ch = entry.text[i];
        if (ch === '$') { inMath = !inMath; continue; }
        if (inMath) continue;
        if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(ch)) continue;
        value += ch.toLowerCase();
        map.push(i);
      }
      entry.norm = { value, map };
    }
    const stem = String(content || '').replace(/<[^>]*>/g, '');
    let stemNorm = '';
    for (const ch of stem) {
      if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(ch)) continue;
      stemNorm += ch.toLowerCase();
    }
    for (let start = 0; start < stemNorm.length && start < 80; start += 7) {
      const probe = stemNorm.slice(start, start + 14);
      if (probe.length < 10) break;
      const at = entry.norm.value.indexOf(probe);
      if (at < 0) continue;
      const page = pageAt(entry, entry.norm.map[at]);
      if (page) return page;
    }
  } catch { /* 忽略 */ }
  return null;
}

/** 教材图号标注 → 插图索引 → 可用的图片 URL */
function resolveFigures(subjectId, refs) {
  const wanted = new Set((Array.isArray(refs) ? refs : [refs]).map(normalizeFigureNo).filter(Boolean));
  if (!wanted.size) return [];
  const index = loadIndex(subjectId);
  const seen = new Set();
  const hits = [];
  for (const figure of index.figures) {
    const key = normalizeFigureNo(figure.no);
    if (!wanted.has(key) || seen.has(key)) continue;
    const absolute = path.join(assetDir(subjectId), `${figure.id}${IMAGE_EXT}`);
    if (!fs.existsSync(absolute)) continue;
    seen.add(key);
    hits.push(figure);
  }
  return hits;
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

/** 给题目挂配图：优先精确裁出的插图，未命中时退回整页图 */
function attachFiguresToQuestions(subjectId, questions, { pageByQuestion } = {}) {
  const index = loadIndex(subjectId);
  let attached = 0;
  let fallback = 0;

  const output = (questions || []).map((question) => {
    const content = String(question?.content || question?.contentHtml || question?.content_html || '');
    const refs = extractFigureRefs(content);
    // 没写图号的「如图」也要兜底：只要题干提到图，就用来源页 / 图号推页挂整页图
    const concerned = refs.length > 0 || hasFigureHint(content);
    const sourcePage = Number(question?.__sourcePage || question?.sourcePage) || 0;
    let figures = refs.length ? resolveFigures(subjectId, refs) : [];
    let source = 'figure';

    if (!figures.length && concerned) {
      // 教材抽取的题自带来源页：以题目实际所在页为准。
      // 不能再用图号在全书中查页——章节正文和章末习题的图号会各编一套（如正文图 2-6 是 RC 电路，
      // 习题图 2-6 是框图），按图号查会稳定挂到正文页上，正是之前 13 题配错页的原因。
      // 人工导入的题没有来源页，才退回图号 / 原文定位；两者都定位不到就不挂图。
      let page = null;
      if (sourcePage > 0) {
        page = sourcePage;
      } else if (question?.__fromTextbook) {
        // 教材抽取但没拿到确切页码：不再按图号全书乱查（正文/习题图号会重号），宁可不挂图
        page = null;
      } else {
        page = (refs.length ? pageByFigureNo(subjectId, refs[0]) : pageByQuestionText(subjectId, content))
          || pageByQuestion?.[question?.id]
          || (!refs.length ? null : guessPageFromFigures(index, refs));
      }
      const url = page ? ensurePageFallbackAsset(subjectId, page) : null;
      if (url) {
        figures = [{ no: refs[0] || '', page, url }];
        source = 'page';
        fallback += 1;
      }
    }

    if (!figures.length) return question;
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
    };
  });

  return { questions: output, attached, fallback };
}

function guessPageFromFigures(index, refs) {
  const wanted = new Set(refs.map(normalizeFigureNo));
  const hit = index.figures.find((item) => wanted.has(normalizeFigureNo(item.no)));
  return hit?.page || null;
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
  resolvePageImage,
  attachFiguresToQuestions,
  ensurePageFallbackAsset,
  assetUrl,
  stats,
};
