'use strict';
/**
 * 资料上下文构建：主教材优先、补充资料辅助。
 *
 * 借鉴 RAGFlow 的 citation-aware injection 与 AnythingLLM 的 pinned document：
 *   - 主教材（pinned / 权威）：始终优先分配预算，片段带「主教材 第 N 页」来源标注；
 *   - 补充资料（辅助）：只在主教材未覆盖或预算有余时补充，带资料名标注；
 *   - 全部片段限额，避免把 420 页全文塞进 system prompt。
 *
 * 不引入向量库：先用「页级切片 + 关键词打分」的轻量检索（BM25 思想的极简版），
 * 对本地单机应用足够，且零依赖、零模型下载。
 */

const path = require('path');
const materialManager = require('./materialManager.js');
const subjectManager = require('./subjectManager.js');
const { repairGhostText } = require('./textRepair.js');
const { textbookText } = require('./textbookFigures.js');

const DEFAULT_PRIMARY_BUDGET = 6000;
const DEFAULT_SUPPLEMENT_BUDGET = 2400;

// 存量教材全文可能残留幽灵文字层（每字之间夹一个乱码字），检索前先修复；
// 同一科目只提醒一次，避免每轮对话都刷日志
const ghostWarned = new Set();

function cleanGhostText(text, subjectId, label) {
  const repaired = repairGhostText(text);
  if (repaired.repaired && !ghostWarned.has(subjectId)) {
    ghostWarned.add(subjectId);
    console.warn(`[Materials] ${label}检测到幽灵文字层，已剔除乱码字符「${repaired.ghostChar}」共 ${repaired.removed} 处`);
  }
  return repaired.text;
}

/** 中文按字、英文按词切出检索词；过滤停用词与过短词 */
function tokenize(text) {
  const raw = String(text || '').toLowerCase();
  const cn = raw.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  const en = raw.match(/[a-z0-9]{3,}/g) || [];
  const terms = [...en];
  for (const seg of cn) {
    // 中文按 2-gram 切，兼顾「传递函数」这类复合词
    for (let i = 0; i < seg.length - 1; i += 1) terms.push(seg.slice(i, i + 2));
  }
  return terms.filter((t) => !STOP.has(t));
}

const STOP = new Set(['的', '了', '是', '在', '和', '与', '或', '我', '你', '请', '问', '题', '什么', '如何', '怎么', '一下', '帮我', '关于', '这个', '那个', '以及', '可以', '需要', 'the', 'and', 'for', 'with', 'how', 'what']);

/** 把教材全文按 `<!-- 第 N 页 -->` 切成页片段，回退到按标题/固定长度切 */
function slicePrimary(markdown) {
  const parts = String(markdown || '').split(/<!--\s*第\s*(\d+)\s*页\s*-->/);
  const chunks = [];
  let currentSection = '';
  // parts: [前导, 页码, 正文, 页码, 正文, ...]
  for (let i = 1; i < parts.length; i += 2) {
    const page = Number(parts[i]) || i;
    const body = String(parts[i + 1] || '').trim();
    if (!body) continue;
    // 标题可能只出现在某一页，后续页沿用最近一次标题，引用里也能显示章节
    const localSection = sectionOf(body);
    if (localSection) currentSection = localSection;
    chunks.push({
      source: `主教材 第 ${page} 页`,
      page,
      section: localSection || currentSection,
      role: 'primary',
      text: body,
    });
  }
  if (!chunks.length && String(markdown || '').trim()) {
    const text = String(markdown).trim();
    for (let i = 0; i < text.length; i += 1200) {
      const body = text.slice(i, i + 1200);
      chunks.push({ source: `主教材 片段 ${Math.floor(i / 1200) + 1}`, page: null, section: sectionOf(body), role: 'primary', text: body });
    }
  }
  return chunks;
}

/** 片段里第一个标题当章节名，引用弹窗里显示 */
function sectionOf(text) {
  const match = String(text || '').match(/^#{1,6}\s+(.+)$/m);
  if (!match) return '';
  const line = match[1].replace(/[*_`#]/g, '').replace(/>/g, ' ').trim();
  if (!line || /来源[:：]|教材全文|共\s*\d+\s*页/.test(line)) return '';
  // 优先提取「第 2 章 / 2.3」这类真正的章节标记
  const chapter = line.match(/(第\s*\d+\s*[章节][^。；;]{0,30}|\d+(?:\.\d+)+\s+[^。；;]{1,30})/);
  if (chapter) return chapter[1].trim().slice(0, 40);
  return line.length <= 30 ? line : '';
}

function score(text, terms) {
  if (!terms.length) return 0;
  const lower = String(text).toLowerCase();
  let s = 0;
  for (const term of terms) {
    if (lower.includes(term)) s += term.length >= 4 ? 2 : 1;
  }
  return s;
}

function takeChunks(chunks, terms, budget) {
  const ranked = chunks
    .map((chunk, index) => ({ ...chunk, index, _score: score(chunk.text, terms) }))
    .filter((chunk) => !terms.length || chunk._score > 0)
    .sort((a, b) => b._score - a._score || a.index - b.index);
  // 相关片段优先；没有命中时按原文顺序给开头几段，保证「有教材可依」
  const picked = terms.length && ranked.length ? ranked : chunks.slice(0, 3).map((c, i) => ({ ...c, index: i, _score: 0 }));
  const out = [];
  let used = 0;
  for (const chunk of picked) {
    if (used >= budget) break;
    const room = budget - used;
    const text = chunk.text.length > room ? `${chunk.text.slice(0, room)}…` : chunk.text;
    out.push({
      index: chunk.index,
      source: chunk.source,
      role: chunk.role,
      page: chunk.page ?? null,
      section: chunk.section || '',
      materialName: chunk.materialName || '',
      text,
    });
    used += text.length;
  }
  // 按页码/原顺序排回，读起来连贯
  return out.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map(({ source, role, page, section, materialName, text }) => ({ source, role, page, section, materialName, text }));
}

/**
 * 构建可注入 system prompt 的资料上下文。
 * @returns {{ text: string, primaryChunks: number, supplementChunks: number, hasPrimary: boolean }}
 */
function buildMaterialContext(subjectId, query = '', opts = {}) {
  const primaryBudget = Number(opts.primaryBudget) || DEFAULT_PRIMARY_BUDGET;
  const supplementBudget = Number(opts.supplementBudget) || DEFAULT_SUPPLEMENT_BUDGET;
  const terms = tokenize(query);
  const primaryChunks = [];
  const supplementChunks = [];

  try {
    const primaryPath = materialManager.primaryTextPath(subjectId);
    if (primaryPath) {
      // 存量「教材全文.md」可能是 MinerU 早期解析产物，正文夹带幽灵字符；
      // 这里读取时修复，用户不用重新解析也能拿到干净原文
      const markdown = cleanGhostText(textbookText(subjectId).text, subjectId, '主教材');
      primaryChunks.push(...takeChunks(slicePrimary(markdown), terms, primaryBudget));
    }
  } catch (error) {
    console.warn('[Materials] 读取主教材失败:', error?.message || error);
  }

  try {
    const index = materialManager.listMaterials(subjectId);
    const ready = index.supplementary.filter((item) => item.status === 'ready' && item.hasText);
    for (const item of ready) {
      const text = materialManager.readSupplementaryText(subjectId, item.id);
      if (!text) continue;
      const chunks = takeChunks(
        sliceSecondary(cleanGhostText(text, subjectId, `补充资料《${item.name}》`))
          .map((c) => ({
            ...c,
            source: `补充资料《${item.name}》${c.source}`,
            materialName: item.name,
            role: 'supplementary',
          })),
        terms,
        Math.max(300, Math.floor(supplementBudget / Math.max(1, ready.length))),
      );
      supplementChunks.push(...chunks);
    }
  } catch (error) {
    console.warn('[Materials] 读取补充资料失败:', error?.message || error);
  }

  const subject = (() => {
    try { return subjectManager.getSubject(subjectId); } catch (_) { return null; }
  })();
  const subjectName = String(subject?.name || '').trim();
  const textbookName = String(subject?.textbookName || '').trim() || '主教材';

  const citations = [];
  const addCitation = (chunk) => {
    const index = citations.length + 1;
    const material = chunk.role === 'primary' ? '主教材' : '补充资料';
    const materialName = chunk.role === 'primary'
      ? textbookName
      : (chunk.materialName || '补充资料');
    const citation = {
      id: `C${index}`,
      index,
      subjectId,
      subjectName,
      material,
      materialName,
      page: chunk.page ?? null,
      section: chunk.section || '',
      source: chunk.source,
      excerpt: String(chunk.text || '').slice(0, 800),
    };
    citations.push(citation);
    return citation;
  };

  const lines = [];
  if (primaryChunks.length) {
    lines.push('## 主教材原文（权威，优先依据）');
    primaryChunks.forEach((chunk) => {
      const citation = addCitation(chunk);
      const section = citation.section ? ` · ${citation.section}` : '';
      lines.push(`### 来源 ${citation.id} · ${citation.source}${section}\n> ${chunk.text}`);
    });
  }
  if (supplementChunks.length) {
    lines.push('\n## 补充资料（辅助，仅作补充与对照）');
    supplementChunks.forEach((chunk) => {
      const citation = addCitation(chunk);
      const section = citation.section ? ` · ${citation.section}` : '';
      lines.push(`### 来源 ${citation.id} · ${citation.source}${section}\n> ${chunk.text}`);
    });
  }
  if (!lines.length) return { text: '', citations: [], primaryChunks: 0, supplementChunks: 0, hasPrimary: false };

  lines.push('\n引用规则：概念、定义、公式与章节范围以主教材为准；补充资料只用于补充例题与不同讲法，两者冲突时以主教材为准并说明差异。回答里如果用到上面某段原文，必须在对应句末标注来源编号，格式固定为 [[C1]]（写作方括号、字母 C、数字）；编号只能取本节出现过的编号，禁止自编来源，没有使用原文就不要标注。');
  return {
    text: lines.join('\n\n'),
    citations,
    primaryChunks: primaryChunks.length,
    supplementChunks: supplementChunks.length,
    hasPrimary: primaryChunks.length > 0,
  };
}

const CITATION_MARKER = /\[\[\s*[Cc](\d+)\s*\]\]/g;

/** 服务端校验模型引用：只保留本次真正注入过的来源，其余标记直接丢弃 */
function validateCitations(text, citations = []) {
  const byIndex = new Map((Array.isArray(citations) ? citations : []).map((item) => [String(item.index), item]));
  const used = new Map();
  const content = String(text || '').replace(CITATION_MARKER, (_match, raw) => {
    const citation = byIndex.get(String(Number(raw)));
    if (!citation) return '';
    used.set(citation.id, citation);
    return `[[${citation.id}]]`;
  }).replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n');
  return { content, citations: Array.from(used.values()) };
}

function stripCitationMarkers(text) {
  return String(text || '').replace(CITATION_MARKER, '').replace(/[ \t]{2,}/g, ' ');
}

/** 读取教材某一页原文，供引用弹窗「定位到该页」 */
function readTextbookPage(subjectId, page) {
  const targetPage = Number(page);
  if (!targetPage) return { success: false, error: '缺少页码' };
  try {
    const markdown = cleanGhostText(textbookText(subjectId).text, subjectId, '主教材');
    const parts = String(markdown || '').split(/<!--\s*第\s*(\d+)\s*页\s*-->/);
    const pages = [];
    for (let i = 1; i < parts.length; i += 2) {
      pages.push({ page: Number(parts[i]), text: String(parts[i + 1] || '').trim() });
    }
    if (!pages.length) return { success: false, error: '这本教材没有页标记，无法定位到具体页' };
    const index = pages.findIndex((item) => item.page === targetPage);
    if (index < 0) return { success: false, error: `没有找到第 ${targetPage} 页` };
    return {
      success: true,
      page: pages[index].page,
      text: pages[index].text,
      prevPage: pages[index - 1]?.page ?? null,
      nextPage: pages[index + 1]?.page ?? null,
    };
  } catch (error) {
    return { success: false, error: error?.message || '读取教材页失败' };
  }
}

function sliceSecondary(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const byHeading = raw.split(/(?=^#{1,3}\s)/m).filter((s) => s.trim());
  if (byHeading.length > 1) {
    return byHeading.map((part, i) => ({
      source: `第 ${i + 1} 节`,
      page: null,
      section: sectionOf(part),
      text: part.trim(),
    }));
  }
  const out = [];
  for (let i = 0; i < raw.length; i += 1200) {
    const part = raw.slice(i, i + 1200);
    out.push({ source: `片段 ${Math.floor(i / 1200) + 1}`, page: null, section: sectionOf(part), text: part });
  }
  return out;
}

/** 主教材 + 补充资料的元信息摘要（不读正文，供任何需要的地方复用） */
function describe(subjectId) {
  return materialManager.describeForSkill(subjectId);
}

module.exports = {
  buildMaterialContext,
  describe,
  tokenize,
  slicePrimary,
  validateCitations,
  stripCitationMarkers,
  readTextbookPage,
};
