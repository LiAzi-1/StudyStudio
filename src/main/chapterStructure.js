'use strict';
/**
 * 章节结构表：把教材 / 补充资料的转写 Markdown 拆成「章节 → 页码区间」。
 *
 * 背景：知识清单以前靠「前 42,000 + 后 18,000 字符」硬截断喂给模型，
 * 400 多页的教材只能看到约 10%，后几章必然缺失。按章分批生成需要一张
 * 可复用的结构表，这里负责：
 *   1. 从 `<!-- 第 N 页 -->` 标记 + 「第N章」标题识别章节边界；
 *   2. 识别不全时用页区间均分补齐（标记 auto），保证生成流程不中断；
 *   3. 落盘成可读 JSON（教材/章节结构.json、资料/转写/<id>.章节结构.json）；
 *   4. 支持界面手动校正后覆盖保存。
 *
 * 纯文本解析 + 文件读写，不调用模型。
 */

const fs = require('fs');
const path = require('path');
const subjectManager = require('./subjectManager.js');
const materialManager = require('./materialManager.js');

const STRUCTURE_FILE = '章节结构.json';
const PAGE_MARK_RE = /<!--\s*第\s*(\d+)\s*页[^>]*-->/g;
const CHAPTER_LINE_RE = /^\s*(?:#{1,4}\s*)?第\s*([0-9〇零一二三四五六七八九十百]{1,4})\s*章\s*(.*)$/;
const CN_DIGITS = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS = { 十: 10, 百: 100 };

function chineseToNumber(raw) {
  const text = String(raw || '').trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) return Number(text);
  // 只处理 1..199 的常见章节编号（一、十二、二十三、一百）
  let total = 0;
  let current = 0;
  for (const ch of text) {
    if (CN_DIGITS[ch] !== undefined) {
      current = CN_DIGITS[ch];
    } else if (CN_UNITS[ch]) {
      total += (current || 1) * CN_UNITS[ch];
      current = 0;
    } else {
      return 0;
    }
  }
  return total + current;
}

/** 拆页：同一页可能出现「文字层」和「AI 识图」两个标记，正文按顺序拼接 */
function splitPages(markdown) {
  const text = String(markdown || '');
  const matches = [...text.matchAll(PAGE_MARK_RE)];
  if (!matches.length) {
    return { totalPages: 0, pages: new Map(), order: [], preamble: text, hasPageMarks: false };
  }
  const pages = new Map();
  const preamble = text.slice(0, matches[0].index);
  matches.forEach((match, index) => {
    const no = Number(match[1]);
    if (!Number.isFinite(no) || no <= 0) return;
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    pages.set(no, `${pages.get(no) || ''}${text.slice(start, end)}`);
  });
  const order = [...pages.keys()].sort((a, b) => a - b);
  return {
    totalPages: order.length ? order[order.length - 1] : 0,
    pages,
    order,
    preamble,
    hasPageMarks: true,
  };
}

function cleanTitle(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .replace(/^[、.．:：\-—\s]+/, '')
    .replace(/[.。；;，,、]+$/, '')
    .trim();
}

function looksLikeTocPage(body) {
  return /目\s*录|contents/i.test(String(body || ''));
}

/**
 * 扫描章节标题。返回候选列表（同一章可能命中目录页与正文页，后面再择优）。
 */
function scanChapterCandidates(pageInfo) {
  const candidates = [];
  const perPageCount = new Map();
  for (const no of pageInfo.order) {
    const body = pageInfo.pages.get(no) || '';
    const lines = body.split('\n');
    const tocPage = looksLikeTocPage(body);
    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+/g, ' ').trim();
      if (!line || line.length > 60) continue;
      const match = line.match(CHAPTER_LINE_RE);
      if (!match) continue;
      const chapterNo = chineseToNumber(match[1]);
      if (!chapterNo || chapterNo > 200) continue;
      const title = cleanTitle(match[2]);
      // 句子不是标题；目录行末尾常带引导点，也在这里挡掉
      if (/[。；;]/.test(title)) continue;
      if (/^[.·…\s]+$/.test(title)) continue;
      candidates.push({ no: chapterNo, title, page: no, toc: tocPage });
      perPageCount.set(no, (perPageCount.get(no) || 0) + 1);
    }
  }
  // 一页里挤了三行以上「第N章」，基本就是目录页
  for (const item of candidates) {
    if ((perPageCount.get(item.page) || 0) >= 3) item.toc = true;
  }
  return candidates;
}

/**
 * 同一章号取一：目录页降权、标题更完整者优先、靠后的正文页优先。
 * 这样「第1章」在目录 p7 和正文 p18 同时出现时，会选 p18。
 */
function pickChapterCandidates(candidates) {
  const byNo = new Map();
  for (const item of candidates) {
    const score = (item.toc ? -1000 : 0) + Math.min(item.title.length, 30) + item.page / 100000;
    const prev = byNo.get(item.no);
    if (!prev || score > prev.score) byNo.set(item.no, { ...item, score });
  }
  const picked = [...byNo.values()]
    .sort((a, b) => a.page - b.page)
    .filter((item, index, list) => index === 0 || item.page > list[index - 1].page);
  return picked;
}

/** 无页标记的资料：按 Markdown 标题（或「第N章」行）切 */
function scanHeadingChapters(markdown) {
  const text = String(markdown || '');
  const lines = text.split('\n');
  const chapters = [];
  let offset = 0;
  for (const line of lines) {
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    const chapterLine = line.match(CHAPTER_LINE_RE);
    const rawTitle = heading ? heading[1] : (chapterLine ? `第${chapterLine[1]}章 ${cleanTitle(chapterLine[2])}` : '');
    if (rawTitle && rawTitle.length <= 80) {
      chapters.push({
        no: chapterLine ? chineseToNumber(chapterLine[1]) : chapters.length + 1,
        title: cleanTitle(rawTitle),
        fromChar: offset,
        toChar: null,
      });
    }
    offset += line.length + 1;
  }
  if (!chapters.length) {
    return [{ no: 1, title: '全文', fromChar: 0, toChar: text.length, auto: true }];
  }
  chapters.forEach((chapter, index) => {
    chapter.toChar = index + 1 < chapters.length ? chapters[index + 1].fromChar : text.length;
  });
  return chapters;
}

/**
 * 生成章节数组：优先按页；识别不到章节时按页均分兜底。
 * @returns {{ chapters: Array, warnings: string[] }}
 */
function buildChaptersFromMarkdown(markdown, { totalPages = 0 } = {}) {
  const pageInfo = splitPages(markdown);
  const pages = Number(totalPages) || pageInfo.totalPages;
  const warnings = [];

  if (!pageInfo.hasPageMarks) {
    const chapters = scanHeadingChapters(markdown);
    if (chapters.length === 1 && chapters[0].auto) {
      warnings.push('资料没有页码标记，也没有可识别的标题，已按全文作为一章处理');
    }
    return {
      chapters: chapters.map((chapter, index) => ({
        index: index + 1,
        no: chapter.no || index + 1,
        title: chapter.title,
        fromPage: null,
        toPage: null,
        fromChar: chapter.fromChar,
        toChar: chapter.toChar,
        auto: Boolean(chapter.auto),
      })),
      warnings,
    };
  }

  const candidates = scanChapterCandidates(pageInfo);
  const picked = pickChapterCandidates(candidates);
  if (!picked.length) {
    // 完全识别不到章节：按每 20 页一块兜底，至少让分批生成能跑
    const block = 20;
    const chapters = [];
    for (let from = 1; from <= pages; from += block) {
      const to = Math.min(pages, from + block - 1);
      chapters.push({
        index: chapters.length + 1,
        no: chapters.length + 1,
        title: `第 ${from}–${to} 页`,
        fromPage: from,
        toPage: to,
        auto: true,
      });
    }
    warnings.push(`未识别到「第N章」标题，已按每 20 页自动分块（共 ${chapters.length} 块）`);
    return { chapters, warnings };
  }

  // 缺失的章号用页区间均分补齐，标题标「待核」；第 1 章缺失也要补上
  const byNo = new Map(picked.map((item) => [item.no, item]));
  const maxNo = Math.max(...picked.map((item) => item.no));
  const nodes = [];
  for (let no = 1; no <= maxNo; no += 1) {
    const hit = byNo.get(no);
    nodes.push(hit
      ? { no, title: hit.title || `第${no}章（标题待核）`, page: hit.page, auto: !hit.title }
      : { no, title: `第${no}章（标题待核）`, page: null, auto: true });
  }

  // 锚点（识别到真实起始页）之间的页区间，按「锚点 + 缺失章」的数量均分。
  // 例：第2章 p27、第4章 p149、第3章缺失 → p27–87 第2章、p88–148 第3章。
  const result = [];
  let previous = null;
  let pending = [];
  const pushMissingBefore = (anchorPage) => {
    if (!pending.length) return;
    const start = previous ? previous.page : 1;
    const end = anchorPage - 1;
    // 有前一章时也要给它留一份；没有前一章时只均分缺失章
    const parts = pending.length + (previous ? 1 : 0);
    const size = Math.max(1, Math.floor((end - start + 1) / Math.max(1, parts)));
    let cursor = previous ? start + size : start;
    pending.forEach((node, index) => {
      const isLast = index === pending.length - 1;
      const to = isLast ? end : Math.min(end, cursor + size - 1);
      result.push({
        index: result.length + 1,
        no: node.no,
        title: node.title,
        fromPage: Math.max(1, cursor),
        toPage: Math.max(cursor, to),
        auto: true,
      });
      cursor = to + 1;
    });
    pending = [];
  };

  for (const node of nodes) {
    if (!node.page) {
      pending.push(node);
      continue;
    }
    pushMissingBefore(node.page);
    result.push({
      index: result.length + 1,
      no: node.no,
      title: node.title,
      fromPage: node.page,
      toPage: node.page,
      auto: node.auto,
    });
    previous = node;
  }
  // 末尾缺失章：从最后一个锚点开始均分到全书末页
  if (pending.length) {
    const start = previous ? previous.page : 1;
    const parts = pending.length + (previous ? 1 : 0);
    const size = Math.max(1, Math.floor((pages - start + 1) / Math.max(1, parts)));
    let cursor = previous ? start + size : start;
    pending.forEach((node, index) => {
      const isLast = index === pending.length - 1;
      const to = isLast ? pages : Math.min(pages, cursor + size - 1);
      result.push({
        index: result.length + 1,
        no: node.no,
        title: node.title,
        fromPage: Math.max(1, cursor),
        toPage: Math.max(cursor, to),
        auto: true,
      });
      cursor = to + 1;
    });
  }

  // 统一结算每章结束页 = 下一章起始页 - 1，最后一章到全书末页
  for (let i = 0; i < result.length; i += 1) {
    const next = result[i + 1];
    result[i].toPage = next ? Math.max(result[i].fromPage, next.fromPage - 1) : pages;
  }

  const autoCount = result.filter((item) => item.auto).length;
  if (autoCount) warnings.push(`${autoCount} 个章节未识别到标题，页码为自动均分结果，可在「章节结构」里校正`);
  return { chapters: result, warnings };
}

/* ---------------------------------------------------------------- 来源与读写 */

function subjectDir(subjectId) {
  const dir = subjectManager.getSubjectDir(subjectId);
  if (!dir) throw new Error('科目不存在');
  return dir;
}

function structurePath(subjectId, sourceKey) {
  const dir = subjectDir(subjectId);
  if (!sourceKey || sourceKey === 'primary') {
    return path.join(dir, '教材', STRUCTURE_FILE);
  }
  const materialId = String(sourceKey).replace(/^material:/, '');
  return path.join(dir, '资料', '转写', `${materialId}.${STRUCTURE_FILE}`);
}

/** 解析来源：主教材 / 指定补充资料 / 无主教材时唯一可读补充资料 */
function resolveSource(subjectId, sourceKey = 'auto') {
  const dir = subjectDir(subjectId);
  const subject = subjectManager.getSubject(subjectId);
  const key = String(sourceKey || 'auto');
  if (key === 'primary' || key === 'auto') {
    const primaryFile = path.join(dir, '教材', '教材全文.md');
    if (fs.existsSync(primaryFile)) {
      const markdown = fs.readFileSync(primaryFile, 'utf8');
      const pageInfo = splitPages(markdown);
      return {
        key: 'primary',
        type: 'primary',
        id: null,
        name: subject?.textbookName || subject?.name || '主教材',
        markdown,
        totalPages: Number(subject?.textbookPages) || pageInfo.totalPages,
        textPath: path.join('教材', '教材全文.md'),
      };
    }
    if (key === 'primary') throw new Error('主教材还没解析完成，没有可用的教材全文');
  }

  const index = materialManager.listMaterials(subjectId);
  const ready = (index.supplementary || []).filter((item) => item.status === 'ready' && item.hasText && item.textPath);
  let target = null;
  if (key.startsWith('material:')) {
    const id = key.slice('material:'.length);
    target = ready.find((item) => String(item.id) === id) || null;
    if (!target) throw new Error(`指定的补充资料（${id}）还没解析完成，或转写文件不存在`);
  } else if (key === 'auto') {
    if (!ready.length) throw new Error('还没有可用的教材或补充资料，请先上传并解析');
    if (ready.length > 1) {
      const names = ready.slice(0, 8).map((item) => `《${item.name}》(${item.id})`).join('、');
      throw new Error(`该科目没有主教材，可读补充资料有多份：${names}。请指定要使用哪一份`);
    }
    target = ready[0];
  } else if (key === 'supplementary') {
    if (!ready.length) throw new Error('还没有解析完成的补充资料');
    if (ready.length > 1) {
      const names = ready.slice(0, 8).map((item) => `《${item.name}》(${item.id})`).join('、');
      throw new Error(`可读补充资料有多份：${names}。请指定 materialId`);
    }
    target = ready[0];
  } else {
    throw new Error(`未知的资料来源：${key}`);
  }

  const markdown = materialManager.readSupplementaryText(subjectId, target.id);
  if (!String(markdown || '').trim()) throw new Error(`《${target.name}》的转写内容为空`);
  const pageInfo = splitPages(markdown);
  return {
    key: `material:${target.id}`,
    type: 'supplementary',
    id: target.id,
    name: target.name || '补充资料',
    markdown,
    totalPages: Number(target.totalPages) || pageInfo.totalPages,
    textPath: target.textPath || '',
  };
}

function normalizeChapters(chapters = []) {
  const source = (Array.isArray(chapters) ? chapters : [])
    .map((item, index) => ({
      index: index + 1,
      no: Number(item?.no) || index + 1,
      title: String(item?.title || `第${index + 1}章`).trim() || `第${index + 1}章`,
      fromPage: Number.isFinite(Number(item?.fromPage)) && Number(item?.fromPage) > 0 ? Number(item.fromPage) : null,
      toPage: Number.isFinite(Number(item?.toPage)) && Number(item?.toPage) > 0 ? Number(item.toPage) : null,
      fromChar: Number.isFinite(Number(item?.fromChar)) ? Number(item.fromChar) : null,
      toChar: Number.isFinite(Number(item?.toChar)) ? Number(item.toChar) : null,
      auto: Boolean(item?.auto),
    }))
    .filter((item) => item.title);
  // 只有带页码的结构才按页排序；纯字符切分的资料按原顺序保留
  const list = (source.some((item) => item.fromPage)
    ? source.sort((left, right) => {
      const lp = left.fromPage ?? Number.MAX_SAFE_INTEGER;
      const rp = right.fromPage ?? Number.MAX_SAFE_INTEGER;
      return lp - rp || left.no - right.no;
    })
    : source).map((item, index) => ({ ...item, index: index + 1 }));
  // 页码区间修正：缺 toPage 的用下一章 fromPage-1，最后一章补到总页数在调用侧处理
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].fromPage && (!list[i].toPage || list[i].toPage < list[i].fromPage)) {
      const nextFrom = list.slice(i + 1).find((item) => item.fromPage)?.fromPage;
      list[i].toPage = nextFrom ? Math.max(list[i].fromPage, nextFrom - 1) : null;
    }
  }
  return list;
}

function readStructure(subjectId, sourceKey) {
  try {
    const file = structurePath(subjectId, sourceKey);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed?.chapters) || !parsed.chapters.length) return null;
    return { ...parsed, chapters: normalizeChapters(parsed.chapters) };
  } catch (error) {
    console.warn('[Structure] 读取章节结构失败:', error?.message || error);
    return null;
  }
}

function writeStructure(subjectId, sourceInfo, payload) {
  const file = structurePath(subjectId, sourceInfo.key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const chapters = normalizeChapters(payload.chapters);
  const data = {
    version: 1,
    source: {
      key: sourceInfo.key,
      type: sourceInfo.type,
      id: sourceInfo.id,
      name: sourceInfo.name,
      totalPages: Number(sourceInfo.totalPages) || 0,
      textPath: sourceInfo.textPath || '',
    },
    generatedAt: payload.generatedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    detected: Number(payload.detected) || chapters.filter((item) => !item.auto).length,
    warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
    chapters,
  };
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  return { file, data };
}

/**
 * 取章节结构：已有则读，没有则现场识别并落盘。
 * @returns {{structure:object, file:string, created:boolean}}
 */
function getStructure({ subjectId, source = 'auto' } = {}) {
  const sourceInfo = resolveSource(subjectId, source);
  const existing = readStructure(subjectId, sourceInfo.key);
  if (existing) {
    return { structure: existing, file: structurePath(subjectId, sourceInfo.key), created: false };
  }
  const { chapters, warnings } = buildChaptersFromMarkdown(sourceInfo.markdown, { totalPages: sourceInfo.totalPages });
  const written = writeStructure(subjectId, sourceInfo, { chapters, warnings, detected: chapters.filter((item) => !item.auto).length });
  return { structure: written.data, file: written.file, created: true };
}

/** 重新识别并覆盖结构表（界面「重新识别」用） */
function rebuildStructure({ subjectId, source = 'auto' } = {}) {
  const sourceInfo = resolveSource(subjectId, source);
  const { chapters, warnings } = buildChaptersFromMarkdown(sourceInfo.markdown, { totalPages: sourceInfo.totalPages });
  const written = writeStructure(subjectId, sourceInfo, { chapters, warnings, detected: chapters.filter((item) => !item.auto).length });
  return { structure: written.data, file: written.file, created: true };
}

/** 手动校正：只接受章节数组，页码越界/倒置会被修正 */
function saveStructure({ subjectId, source = 'auto', chapters = [] } = {}) {
  const sourceInfo = resolveSource(subjectId, source);
  const list = normalizeChapters(chapters);
  if (!list.length) throw new Error('章节结构不能为空');
  const totalPages = Number(sourceInfo.totalPages) || 0;
  for (const chapter of list) {
    if (chapter.fromPage && totalPages && chapter.fromPage > totalPages) {
      throw new Error(`「${chapter.title}」起始页 ${chapter.fromPage} 超出教材总页数 ${totalPages}`);
    }
    if (chapter.toPage && totalPages && chapter.toPage > totalPages) {
      throw new Error(`「${chapter.title}」结束页 ${chapter.toPage} 超出教材总页数 ${totalPages}`);
    }
    if (chapter.fromPage && chapter.toPage && chapter.toPage < chapter.fromPage) {
      throw new Error(`「${chapter.title}」结束页小于起始页`);
    }
  }
  // 最后一章没写结束页时补到总页数
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].fromPage && !list[i].toPage) {
      const nextFrom = list.slice(i + 1).find((item) => item.fromPage)?.fromPage;
      list[i].toPage = nextFrom ? nextFrom - 1 : (totalPages || null);
    }
  }
  const written = writeStructure(subjectId, sourceInfo, {
    chapters: list,
    warnings: ['结构表由用户手动校正'],
    detected: list.filter((item) => !item.auto).length,
  });
  return { structure: written.data, file: written.file };
}

/** 取某一章的原文（按页优先，其次按字符偏移） */
function chapterText(sourceInfo, chapter) {
  const markdown = String(sourceInfo.markdown || '');
  if (chapter.fromPage) {
    const pageInfo = splitPages(markdown);
    const from = Math.max(1, Number(chapter.fromPage) || 1);
    const to = Math.max(from, Number(chapter.toPage) || from);
    const parts = [];
    for (const no of pageInfo.order) {
      if (no < from || no > to) continue;
      parts.push(`<!-- 第 ${no} 页 -->\n${pageInfo.pages.get(no) || ''}`);
    }
    return parts.join('\n');
  }
  if (Number.isFinite(chapter.fromChar)) {
    const start = Math.max(0, Number(chapter.fromChar) || 0);
    const end = Number.isFinite(chapter.toChar) ? Number(chapter.toChar) : markdown.length;
    return markdown.slice(start, Math.max(start, end));
  }
  return markdown;
}

module.exports = {
  splitPages,
  buildChaptersFromMarkdown,
  resolveSource,
  getStructure,
  rebuildStructure,
  saveStructure,
  readStructure,
  structurePath,
  chapterText,
  normalizeChapters,
};
