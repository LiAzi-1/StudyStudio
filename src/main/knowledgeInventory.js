'use strict';
/**
 * 按章分批生成知识清单。
 *
 * 旧实现把教材截成「前 42,000 + 后 18,000 字符」一次性喂给模型，并要求模型
 * 直接写出整篇 Markdown；400 多页的教材只能覆盖约 10%，输出又会被 max_tokens
 * 截断，且 finish_reason 从不检查，于是每次生成的清单都停在前几章。
 *
 * 这里改为：
 *   1. 用 chapterStructure 的章节表按章取原文，不再截断全文；
 *   2. 一章过长时按页拆批，每批只让模型输出 NDJSON 条目（不带编号）；
 *   3. 编号、排序、知识点编号索引、覆盖范围说明全部由代码生成；
 *   4. 读取 finish_reason，被截断时自动续写，仍不完整则明确报错，不静默保存；
 *   5. 支持指定起始章节 / 已学章节 / 资料页码范围；未涉及章节保留原文；
 *   6. 覆盖写入前把旧版清单存进 教材/清单快照/。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const aiService = require('./ai/index.js');
const subjectManager = require('./subjectManager.js');
const chapterStructure = require('./chapterStructure.js');
const { MATH_STYLE_PROMPT, normalizeMath } = require('../shared/mathStyle.js');
const { repairGhostText } = require('./textRepair.js');

const DEFAULT_BATCH_CHARS = 24000;
const MAX_CONTINUATIONS = 3;
const FIELD_MAX = 500;
const CACHE_VERSION = 3;
const RETRYABLE_RE = /(^|\D)(429|500|502|503|504)(\D|$)|rate.?limit|too many requests|overloaded|server error|bad gateway|service unavailable|gateway timeout|ECONNRESET|ETIMEDOUT|ECONNREFUSED|fetch failed|socket hang up|network|timed? out|timeout/i;

function resolveConcurrency(settings, override) {
  const raw = Number(override ?? settings?.inventoryConcurrency);
  return Math.min(6, Math.max(1, Number.isFinite(raw) && raw > 0 ? raw : 2));
}

function resolveRetryOptions(settings) {
  const max = Number(settings?.inventoryRetryMax);
  const base = Number(settings?.inventoryRetryBaseMs);
  return {
    maxRetries: Number.isFinite(max) && max >= 0 ? Math.min(6, max) : 3,
    baseMs: Number.isFinite(base) && base > 0 ? base : 700,
  };
}

function isRetryableError(message) {
  return RETRYABLE_RE.test(String(message || ''));
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('知识清单生成已取消'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('知识清单生成已取消'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function safeSourceKey(sourceKey) {
  return String(sourceKey || 'primary').replace(/[^a-zA-Z0-9_-]+/g, '_');
}

/** 章节缓存：主教材落 教材/知识清单缓存.json，补充资料落 资料/转写/<id>.清单缓存.json */
function chapterCachePath(subjectId, sourceKey) {
  const dir = subjectManager.getSubjectDir(subjectId);
  if (String(sourceKey || '').startsWith('material:')) {
    return path.join(dir, '资料', '转写', `${safeSourceKey(sourceKey)}.清单缓存.json`);
  }
  return path.join(dir, '教材', '知识清单缓存.json');
}

function emptyChapterCache(sourceKey) {
  return { version: CACHE_VERSION, sourceKey, status: 'empty', chapters: {} };
}

function loadChapterCache(subjectId, sourceKey) {
  try {
    const file = chapterCachePath(subjectId, sourceKey);
    if (!fs.existsSync(file)) return { ...emptyChapterCache(sourceKey), file };
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Number(data?.version) !== CACHE_VERSION) return { ...emptyChapterCache(sourceKey), file };
    return { ...emptyChapterCache(sourceKey), ...data, chapters: data.chapters || {}, file };
  } catch (error) {
    console.warn('[Inventory] 读取章节缓存失败，将重新生成:', error?.message || error);
    return { ...emptyChapterCache(sourceKey), file: chapterCachePath(subjectId, sourceKey) };
  }
}

function saveChapterCache(subjectId, sourceKey, data) {
  const file = chapterCachePath(subjectId, sourceKey);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const payload = {
    ...data,
    version: CACHE_VERSION,
    sourceKey,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/** 章节内容 + 是否已学 + 提示词版本共同决定缓存是否可用 */
function chapterHash(text, learned) {
  return crypto
    .createHash('sha1')
    .update(`v${CACHE_VERSION}|${learned ? 'learned' : 'new'}|`)
    .update(String(text || ''))
    .digest('hex')
    .slice(0, 16);
}


const INVENTORY_SYSTEM = `你是学习平台的教材知识清单整理器。你的唯一任务是：只依据用户给出的教材原文片段，拆出可检查的知识点条目。
输出格式是 NDJSON：每行一个 JSON 对象，不要数组包裹、不要 Markdown、不要解释、不要编号。
字段：{"topic":"知识点名称","concept":"核心概念","conditions":"使用条件","tasks":"典型任务或题型","prerequisites":"必要前置","location":"材料位置（章/页）","priority":"高|中|低","status":"掌握待测","verification":"下一步验证方法"}
原文没有的内容留空字符串，不要编造页码、公式或定义。`;

function splitChapterBatches(text, maxChars = DEFAULT_BATCH_CHARS) {
  const source = String(text || '');
  const limit = Math.max(4000, Number(maxChars) || DEFAULT_BATCH_CHARS);
  const pageMatches = [...source.matchAll(/<!--\s*第\s*(\d+)\s*页[^>]*-->/g)];
  if (!pageMatches.length) {
    const batches = [];
    for (let offset = 0; offset < source.length; offset += limit) {
      batches.push({ text: source.slice(offset, offset + limit), fromPage: null, toPage: null, chars: Math.min(limit, source.length - offset) });
    }
    return batches.filter((batch) => batch.text.trim());
  }

  const pages = [];
  pageMatches.forEach((match, index) => {
    const start = match.index;
    const end = index + 1 < pageMatches.length ? pageMatches[index + 1].index : source.length;
    pages.push({
      no: Number(match[1]),
      text: source.slice(start, end),
    });
  });

  const batches = [];
  let current = null;
  for (const page of pages) {
    const text = page.text || '';
    if (!current) current = { parts: [], fromPage: page.no, toPage: page.no, chars: 0, text: '' };
    if (current.chars && current.chars + text.length > limit) {
      batches.push(current);
      current = { parts: [], fromPage: page.no, toPage: page.no, chars: 0, text: '' };
    }
    // 单页超过上限：按字符硬切，页码仍记这一页
    if (text.length > limit) {
      for (let offset = 0; offset < text.length; offset += limit) {
        const piece = text.slice(offset, offset + limit);
        if (current.chars) {
          batches.push(current);
          current = { parts: [], fromPage: page.no, toPage: page.no, chars: 0, text: '' };
        }
        batches.push({ parts: [], fromPage: page.no, toPage: page.no, chars: piece.length, text: piece });
      }
      current = null;
      continue;
    }
    current.parts.push(page.no);
    current.toPage = page.no;
    current.chars += text.length;
    current.text += text;
  }
  if (current && current.chars) batches.push(current);
  return batches.filter((batch) => String(batch.text || '').trim());
}

/** 从模型输出里提取 JSON 对象：兼容 NDJSON、JSON 数组、代码块包裹和末尾被截断 */
function extractJsonObjects(raw) {
  const text = String(raw || '').replace(/```json/gi, '').replace(/```/g, '');
  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (start < 0) {
      if (ch === '{') {
        start = i;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString && ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          objects.push(JSON.parse(candidate));
        } catch {
          // 单个对象坏了不影响其他行
        }
        start = -1;
      }
    }
  }
  return objects.flatMap((item) => (Array.isArray(item?.entries) ? item.entries : (Array.isArray(item?.items) ? item.items : [item])));
}

function pickText(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, FIELD_MAX);
  }
  return '';
}

function normalizePriority(raw) {
  const text = String(raw || '').trim();
  if (/高/.test(text)) return '高';
  if (/低/.test(text)) return '低';
  return '中';
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const topic = pickText(raw, ['topic', 'title', 'name', '知识点', '知识点名称', 'point']).slice(0, 80);
  if (!topic) return null;
  return {
    topic,
    concept: pickText(raw, ['concept', '核心概念', 'core', 'definition', '定义']),
    conditions: pickText(raw, ['conditions', 'condition', '使用条件', '适用条件']),
    tasks: pickText(raw, ['tasks', 'task', '典型任务', '题型', '典型任务或题型']),
    prerequisites: pickText(raw, ['prerequisites', 'prerequisite', '前置', '必要前置', '前置知识']),
    location: pickText(raw, ['location', '材料位置', 'page', '页码']),
    priority: normalizePriority(raw.priority || raw.优先级),
    status: pickText(raw, ['status', '当前状态']) || '掌握待测',
    verification: pickText(raw, ['verification', '下一步验证', '验证方法', '下一步验证方法']),
  };
}

function dedupeEntries(entries) {
  const seen = new Set();
  const list = [];
  for (const entry of entries) {
    const key = `${entry.topic.toLowerCase()}|${String(entry.concept || '').slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(entry);
  }
  return list;
}

function buildBatchPrompt({ subjectName, sourceName, chapter, batch, learned }) {
  const range = batch.fromPage && batch.toPage
    ? `第 ${batch.fromPage}–${batch.toPage} 页`
    : '本批原文';
  const status = learned ? '已学·待测' : '掌握待测';
  return `科目：${subjectName}
资料来源：${sourceName}
章节：${chapter.title}（${chapter.fromPage && chapter.toPage ? `第 ${chapter.fromPage}–${chapter.toPage} 页` : '无页码'}）
本批范围：${range}

请只依据下面的原文，拆出可检查的知识点条目。输出 NDJSON，每行一个 JSON 对象：
{"topic":"...","concept":"...","conditions":"...","tasks":"...","prerequisites":"...","location":"...","priority":"高|中|低","status":"${status}","verification":"..."}

规则：
1. topic 是 2–30 字的具体知识点名称，不要只写章名或“概述”；
2. concept 写核心概念与使用条件，conditions 单独写适用条件（没有就留空）；
3. tasks 写典型任务/题型；prerequisites 写必要前置；
4. location 写本批原文中的页码（如「第 ${batch.fromPage || chapter.fromPage || '?'} 页」），原文没标页码就留空；
5. priority 只能选 高 / 中 / 低；status 固定为 ${status}；
6. verification 写一个可执行的验证动作（做什么题、达到什么标准）；
7. 只写本批原文里真实出现的内容，缺字或残缺处不要猜，必要时在 concept 末尾注明“原文残缺，范围待核”；
8. 不要编号、不要输出数组、不要解释，一行一个 JSON 对象。

原文：
${batch.text}`;
}

async function requestBatchEntries({ system, user, settings, signal, maxTokens }) {
  const messages = [{ role: 'user', content: user }];
  const chunks = [];
  let truncated = false;
  let finishReason = '';
  for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt += 1) {
    const result = await aiService.complete(settings, {
      system,
      messages,
      maxTokens,
      fast: true,
      signal,
    });
    if (!result?.success) throw new Error(result?.error || '模型调用失败');
    chunks.push(String(result.content || ''));
    finishReason = String(result.finishReason || '');
    truncated = Boolean(result.truncated);
    if (!truncated || attempt === MAX_CONTINUATIONS) break;
    messages.push({ role: 'assistant', content: String(result.content || '') });
    messages.push({
      role: 'user',
      content: '上一次输出因长度上限被截断。请从中断处继续输出剩余的 JSON 行；不要重复已经输出的条目，不要解释。',
    });
  }
  const entries = dedupeEntries(extractJsonObjects(chunks.join('\n')).map(normalizeEntry).filter(Boolean));
  if (!entries.length) {
    throw new Error(`模型返回了内容但没有可解析的知识点（finish_reason=${finishReason || 'unknown'}）：${chunks.join('').slice(0, 300)}`);
  }
  return { entries, truncated, finishReason, continuations: chunks.length - 1 };
}

/** 429 / 5xx / 网络错误退避重试；重试信息通过 onRetry 同步给进度事件 */
async function requestBatchWithRetry({ chapterTitle, batchNo, onRetry, signal, ...args }, retryOptions) {
  const { maxRetries, baseMs } = retryOptions;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestBatchEntries({ ...args, signal });
    } catch (error) {
      if (signal?.aborted) throw new Error('知识清单生成已取消');
      const message = error?.message || String(error);
      const retryable = isRetryableError(message);
      if (attempt >= maxRetries || !retryable) throw error;
      const delay = Math.round(Math.min(8000, baseMs * 2 ** attempt) * (0.8 + Math.random() * 0.4));
      console.warn(`[Inventory] ${chapterTitle} 第 ${batchNo} 批失败（${message}），${delay}ms 后重试 ${attempt + 1}/${maxRetries}`);
      onRetry?.({ attempt: attempt + 1, maxRetries, delay, error: message });
      await sleep(delay, signal);
    }
  }
}

function matchChapterToken(chapters, token) {
  const raw = String(token ?? '').trim();
  if (!raw) return null;
  const number = Number((raw.match(/\d+/) || [])[0]);
  if (Number.isFinite(number) && number > 0) {
    const byNo = chapters.find((chapter) => Number(chapter.no) === number);
    if (byNo) return byNo;
  }
  return chapters.find((chapter) => chapter.title.includes(raw) || raw.includes(chapter.title)) || null;
}

function selectChapters(structure, { startChapter, fromPage, toPage, modules } = {}) {
  let list = Array.isArray(modules) && modules.length
    ? modules.map((item, index) => ({
      index: index + 1,
      no: Number(item.no) || index + 1,
      title: String(item.title || `第${index + 1}章`).trim(),
      fromPage: Number(item.fromPage) || null,
      toPage: Number(item.toPage) || null,
      fromChar: Number.isFinite(Number(item.fromChar)) ? Number(item.fromChar) : null,
      toChar: Number.isFinite(Number(item.toChar)) ? Number(item.toChar) : null,
      auto: false,
    })).filter((item) => item.title)
    : structure.chapters.slice();

  if (startChapter !== undefined && startChapter !== null && String(startChapter).trim()) {
    const hit = matchChapterToken(list, startChapter);
    if (!hit) {
      throw new Error(`找不到起始章节「${startChapter}」，可选章节：${list.slice(0, 12).map((item) => item.title).join('、')}`);
    }
    list = list.slice(list.findIndex((item) => item.no === hit.no));
  }

  const low = Number(fromPage) || 0;
  const high = Number(toPage) || 0;
  if (low || high) {
    const from = low || 1;
    const to = high || Number.MAX_SAFE_INTEGER;
    list = list
      .filter((chapter) => !chapter.fromPage || (chapter.toPage >= from && chapter.fromPage <= to))
      .map((chapter) => (chapter.fromPage
        ? { ...chapter, fromPage: Math.max(chapter.fromPage, from), toPage: Math.min(chapter.toPage || chapter.fromPage, to) }
        : chapter));
  }
  return list;
}

/** 解析旧版清单的模块块（## 开头），供未涉及章节原样保留 */
function parseExistingBlocks(content) {
  const text = String(content || '');
  if (!text.trim()) return [];
  const lines = text.split('\n');
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (current) blocks.push(current);
      if (/^##\s*(覆盖范围说明|知识点编号索引)/.test(line)) {
        current = null;
        continue;
      }
      current = { heading: line, lines: [line], no: null };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) blocks.push(current);
  return blocks.map((block) => {
    const heading = block.heading;
    const chapterNo = Number((heading.match(/第\s*(\d+)\s*章/) || [])[1] || 0);
    return {
      heading,
      text: block.lines.join('\n').trim(),
      no: chapterNo || null,
    };
  });
}

function chapterBlockTitle(chapter) {
  const range = chapter.fromPage && chapter.toPage ? `（第 ${chapter.fromPage}–${chapter.toPage} 页）` : '';
  const auto = chapter.auto ? '（页码待核）' : '';
  return `## 模块${chapter.index} ${chapter.title}${range}${auto}`;
}

function renderEntry(number, entry, chapter, learned) {
  const status = learned ? '已学·待测' : (entry.status || '掌握待测');
  const concept = [entry.concept, entry.conditions].filter(Boolean).join('；') || '（原文未覆盖，范围待核）';
  const location = entry.location || (chapter.fromPage
    ? `第 ${chapter.fromPage}–${chapter.toPage} 页`
    : '（原文未标页码）');
  return `### ${number} ${entry.topic}
- 核心概念与使用条件：${concept}
- 典型任务/题型：${entry.tasks || '（原文未覆盖）'}
- 必要前置：${entry.prerequisites || '（原文未标注）'}
- 材料位置：${location}
- 优先级：${entry.priority || '中'}
- 当前状态：${status}
- 下一步验证：${entry.verification || '（待补充）'}`;
}

function renderChapterBlock(chapter, entries, learned) {
  const lines = [];
  lines.push(chapterBlockTitle(chapter));
  entries.forEach((entry, index) => {
    lines.push(renderEntry(`${chapter.no}.${index + 1}`, entry, chapter, learned));
  });
  if (!entries.length) {
    lines.push('（本章没有生成可解析的知识点，范围待核）');
  }
  return lines.join('\n\n');
}

function buildCoverageSection({ source, selected, chapterEntries = [], preservedNos, missingChapters, stats, warnings, resumed = [], skippedBatches = 0, concurrency = 1 }) {
  const lines = ['## 覆盖范围说明', ''];
  lines.push(`- 资料来源：${source.type === 'primary' ? '主教材' : '补充资料'}《${source.name}》${source.totalPages ? `，共 ${source.totalPages} 页` : ''}。`);
  lines.push(`- 本次处理：${selected.length} 章 / ${stats.batches} 批；成功 ${stats.okChapters} 章，失败 ${stats.failedChapters.length} 章；并发 ${concurrency} 路。`);
  if (resumed.length) {
    lines.push(`- 续跑复用：${resumed.map((item) => item.title || item).join('、')}（缓存命中 ${skippedBatches} 批，未重新请求）。`);
  }
  if (selected.length) {
    lines.push(`- 章节与页码：${selected.map((chapter) => `${chapter.title}（${chapter.fromPage ? `第 ${chapter.fromPage}–${chapter.toPage} 页` : '无页码'}）`).join('；')}。`);
  }
  if (chapterEntries.length) {
    lines.push(`- 各章条目数：${chapterEntries.map((item) => `${item.title} ${item.entries || 0} 条`).join('；')}。`);
  }
  if (preservedNos.length) {
    lines.push(`- 保留上一版原文的章节：${preservedNos.join('、')}（本次未涉及，未重写）。`);
  }
  if (missingChapters.length) {
    lines.push(`- 清单未覆盖的章节：${missingChapters.map((chapter) => `${chapter.title}（${chapter.fromPage ? `第 ${chapter.fromPage}–${chapter.toPage} 页` : '无页码'}）`).join('；')}。`);
  }
  if (stats.truncatedBatches.length) {
    lines.push(`- **截断**：${stats.truncatedBatches.map((item) => `${item.chapter}（${item.range}）`).join('；')} 达到输出上限，已自动续写 ${MAX_CONTINUATIONS} 次仍未完整，结果可能缺条目。`);
  } else {
    lines.push('- 截断：无（所有批次都在输出上限内结束）。');
  }
  if (stats.failedChapters.length) {
    lines.push(`- **失败**：${stats.failedChapters.map((item) => `${item.chapter}：${item.error}`).join('；')}。`);
  }
  const structureWarnings = Array.isArray(warnings) ? warnings.filter(Boolean) : [];
  if (structureWarnings.length) lines.push(`- 章节结构提示：${structureWarnings.join('；')}。`);
  const autoChapters = selected.filter((chapter) => chapter.auto);
  if (autoChapters.length) {
    lines.push(`- 页码待核：${autoChapters.map((chapter) => chapter.title).join('、')} 的章节边界是自动推断的，建议在「科目 → 章节结构」里校正。`);
  }
  return lines.join('\n');
}

function buildIndexSection(moduleBlocks) {
  const lines = ['## 知识点编号索引', ''];
  for (const block of moduleBlocks) {
    for (const line of block.split('\n')) {
      const match = line.match(/^###\s+(\S+)\s+(.+)$/);
      if (match) lines.push(`- ${match[1]} ${match[2]}`);
    }
  }
  if (lines.length === 2) lines.push('- （暂无条目）');
  return lines.join('\n');
}

function writeSnapshot(subjectId, content) {
  if (!String(content || '').trim()) return '';
  const dir = path.join(subjectManager.getSubjectDir(subjectId), '教材', '清单快照');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `知识清单-${stamp}.md`);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function findExistingNote(database, subjectId) {
  try {
    const result = database.getNotes({ subjectId, limit: 100 });
    const items = Array.isArray(result?.items) ? result.items : [];
    return items.find((note) => /知识清单/.test(String(note.title || '')) && String(note.content || '').trim()) || null;
  } catch (error) {
    console.warn('[Inventory] 读取旧清单失败:', error?.message || error);
    return null;
  }
}

/** 自定义模块只给了标题时，优先复用章节结构表的页码；否则按标题在原文里的位置补出字符区间 */
function applyModuleRanges(markdown, moduleList, existingChapters = []) {
  const text = String(markdown || '');
  const chapterList = Array.isArray(existingChapters) ? existingChapters : [];
  let cursor = 0;
  for (const module of moduleList) {
    if (Number(module.fromPage) > 0 || Number.isFinite(Number(module.fromChar))) continue;
    const title = String(module.title || '').trim();
    const matched = chapterList.find((chapter) => chapter.title && (chapter.title.includes(title) || title.includes(chapter.title)));
    if (matched?.fromPage) {
      module.fromPage = matched.fromPage;
      module.toPage = matched.toPage;
      continue;
    }
    const index = title ? text.indexOf(title, cursor) : -1;
    if (index < 0) {
      throw new Error(`自定义知识模块「${title}」在资料原文里找不到，请补充 fromPage / toPage 或改用资料里出现的标题`);
    }
    module.fromChar = index;
    cursor = index + title.length;
  }
  const charModules = moduleList.filter((module) => !Number(module.fromPage) && Number.isFinite(Number(module.fromChar)));
  charModules.forEach((module, index) => {
    if (Number.isFinite(Number(module.toChar))) return;
    if (charModules[index + 1]) {
      module.toChar = charModules[index + 1].fromChar;
      return;
    }
    // 最后一个模块：截到下一个「第N章」标题前，避免把整本书都算进来
    const rest = text.slice(module.fromChar + 1);
    const nextChapter = rest.match(/\n\s*第\s*[0-9〇零一二三四五六七八九十百]{1,4}\s*章/);
    module.toChar = nextChapter ? module.fromChar + 1 + nextChapter.index : text.length;
  });
  return moduleList;
}

/**
 * 规划知识清单：解析来源、选章节、切批次、检查缓存与旧版清单。
 * 只读，不调用模型、不写笔记；计划卡与真正生成共用这一份逻辑。
 */
function prepareInventoryPlan({
  subjectId,
  settings,
  source = 'auto',
  materialId = '',
  startChapter = '',
  learnedChapters = [],
  fromPage = 0,
  toPage = 0,
  modules = [],
  keepExisting = true,
  forceRerun = false,
  persistStructure = false,
  concurrency: concurrencyOverride = 0,
} = {}) {
  const subject = subjectManager.getSubject(subjectId);
  if (!subject) throw new Error('科目不存在');

  if (source === 'material' && !materialId) {
    throw new Error('指定按补充资料生成时必须提供 materialId（可先读取该科目的资料清单）');
  }
  const sourceKey = materialId ? `material:${materialId}` : source;
  const sourceInfo = chapterStructure.resolveSource(subjectId, sourceKey);
  const repair = repairGhostText(sourceInfo.markdown);
  if (repair.repaired) {
    console.warn(`[Inventory] ${sourceInfo.name} 检测到幽灵文字层，已剔除「${repair.ghostChar}」${repair.removed} 处`);
  }
  if (repair.quality.corrupt) {
    throw new Error('教材文本疑似损坏/乱码，无法生成知识清单。请到「科目」页重新解析，或重新上传清晰版 PDF。');
  }
  const markdown = repair.text;
  const readable = { ...sourceInfo, markdown };
  const moduleList = Array.isArray(modules) ? modules.map((item) => ({ ...item })) : [];

  // 章节识别和清单共用 resolveSource 修复后的正文；文本指纹变化时旧结构失效。
  // 只有真正生成（persistStructure=true）才落盘/备份，计划卡保持只读。
  const baseStructure = chapterStructure.getStructure({
    subjectId,
    source: sourceKey,
    persist: persistStructure,
  }).structure;
  if (moduleList.length) applyModuleRanges(markdown, moduleList, baseStructure.chapters);

  const structure = moduleList.length
    ? {
      chapters: moduleList.map((item, index) => ({
        index: index + 1,
        no: Number(item.no) || index + 1,
        title: String(item.title || `第${index + 1}章`).trim(),
        fromPage: Number(item.fromPage) || null,
        toPage: Number(item.toPage) || null,
        fromChar: Number.isFinite(Number(item.fromChar)) ? Number(item.fromChar) : null,
        toChar: Number.isFinite(Number(item.toChar)) ? Number(item.toChar) : null,
        auto: false,
      })).filter((item) => item.title),
      warnings: ['本次按用户自定义知识模块生成'],
    }
    : baseStructure;

  const selected = selectChapters(structure, { startChapter, fromPage, toPage, modules: moduleList });
  if (!selected.length) throw new Error('按当前范围没有选中任何章节，请检查起始章节或页码范围');

  const learnedSet = new Set(
    (Array.isArray(learnedChapters) ? learnedChapters : [])
      .map((token) => matchChapterToken(structure.chapters, token))
      .filter(Boolean)
      .map((chapter) => chapter.no),
  );

  const concurrency = resolveConcurrency(settings, concurrencyOverride);
  const retryOptions = resolveRetryOptions(settings);
  const maxTokens = aiService.resolveMaxOutputTokens(settings);

  // 规划批次：先算清楚总批次数；每章记录内容哈希，用于断点续跑
  const plan = selected.map((chapter, chapterIndex) => {
    const text = chapterStructure.chapterText(readable, chapter);
    const learned = learnedSet.has(chapter.no);
    const batches = splitChapterBatches(text, Number(settings?.inventoryBatchChars) || DEFAULT_BATCH_CHARS);
    return {
      chapterIndex,
      chapter,
      learned,
      text,
      chars: text.length,
      hash: chapterHash(text, learned),
      batches,
      batchResults: new Array(batches.length),
      cachedEntries: null,
      finalEntries: null,
      finalized: false,
      error: null,
    };
  });
  const totalBatches = plan.reduce((sum, item) => sum + item.batches.length, 0);
  if (!totalBatches) throw new Error('选中的章节里没有可处理的原文');

  const database = require('./database.js');
  const existing = keepExisting ? findExistingNote(database, subjectId) : null;
  const existingBlocks = existing ? parseExistingBlocks(existing.content) : [];

  const cacheData = loadChapterCache(subjectId, sourceInfo.key);
  const resumedChapters = [];
  let skippedBatches = 0;
  if (!forceRerun) {
    for (const item of plan) {
      const cached = cacheData.chapters[String(item.chapter.no)];
      if (cached && cached.hash === item.hash && Array.isArray(cached.entries) && cached.entries.length) {
        item.cachedEntries = cached.entries;
        skippedBatches += item.batches.length;
        resumedChapters.push({
          no: item.chapter.no,
          title: item.chapter.title,
          entries: cached.entries.length,
          fromPage: item.chapter.fromPage,
          toPage: item.chapter.toPage,
        });
      }
    }
  }

  return {
    subject,
    sourceInfo,
    sourceKey,
    markdown,
    readable,
    moduleList,
    baseStructure,
    structure,
    selected,
    learnedSet,
    concurrency,
    retryOptions,
    maxTokens,
    plan,
    totalBatches,
    existing,
    existingBlocks,
    cacheData,
    resumedChapters,
    skippedBatches,
  };
}

/**
 * 知识清单计划：给动作卡展示「改哪些章、保留哪些章、多少批、是否续跑复用」。
 * 只读，不会触发模型调用或写库。
 */
function planKnowledgeInventory(options = {}) {
  const prepared = prepareInventoryPlan(options);
  const selectedNos = new Set(prepared.selected.map((chapter) => chapter.no));
  const existingNos = [...new Set(prepared.existingBlocks.map((block) => block.no).filter(Boolean))];
  const preservedChapters = existingNos
    .filter((no) => !selectedNos.has(no))
    .sort((a, b) => a - b)
    .map((no) => {
      const block = prepared.existingBlocks.find((item) => item.no === no);
      return { no, title: String(block?.heading || '').replace(/^##\s*(模块\d+\s*)?/, '') };
    });
  const totalChars = prepared.plan.reduce((sum, item) => sum + item.chars, 0);
  const estimatedEntries = Math.max(prepared.selected.length, Math.round(totalChars / 320));

  return {
    success: true,
    subject: { id: prepared.subject.id, name: prepared.subject.name },
    source: {
      key: prepared.sourceInfo.key,
      type: prepared.sourceInfo.type,
      name: prepared.sourceInfo.name,
      totalPages: prepared.sourceInfo.totalPages,
    },
    structureWarnings: prepared.structure.warnings || [],
    selectedChapters: prepared.selected.map((chapter) => ({
      no: chapter.no,
      title: chapter.title,
      fromPage: chapter.fromPage,
      toPage: chapter.toPage,
      auto: Boolean(chapter.auto),
      chars: prepared.plan.find((item) => item.chapter.no === chapter.no)?.chars || 0,
    })),
    chapterPlan: prepared.plan.map((item) => ({
      no: item.chapter.no,
      title: item.chapter.title,
      fromPage: item.chapter.fromPage,
      toPage: item.chapter.toPage,
      chars: item.chars,
      batches: item.batches.length,
      resumed: Boolean(item.cachedEntries),
    })),
    preservedChapters,
    totalBatches: prepared.totalBatches,
    requestBatches: prepared.totalBatches - prepared.skippedBatches,
    skippedBatches: prepared.skippedBatches,
    resumedChapters: prepared.resumedChapters,
    forceRerun: Boolean(options.forceRerun),
    concurrency: prepared.concurrency,
    estimatedEntries,
    existingNote: prepared.existing
      ? { id: prepared.existing.id, title: prepared.existing.title, chars: String(prepared.existing.content || '').length }
      : null,
    writeNoteTitle: `知识清单 · ${prepared.subject.name}`,
    snapshotHint: '教材/清单快照/',
  };
}

/**
 * 生成 / 更新知识清单。
 *
 * @param {object} options
 * @param {string} options.subjectId
 * @param {object} options.settings  AI 设置（可含 inventoryMaxTokens / inventoryBatchChars）
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.onProgress]
 * @param {'auto'|'primary'|'supplementary'|'material:<id>'} [options.source]
 * @param {string} [options.materialId]
 * @param {number|string} [options.startChapter] 起始章节号或标题关键字
 * @param {Array<number|string>} [options.learnedChapters] 已学章节
 * @param {number} [options.fromPage]
 * @param {number} [options.toPage]
 * @param {Array<object>} [options.modules] 用户自定义知识模块
 * @param {boolean} [options.keepExisting=true]
 * @param {boolean} [options.forceRerun=false] 忽略章节缓存，强制重跑
 * @param {number} [options.concurrency] 并发批次数（默认 2，可用 settings.inventoryConcurrency 配置）
 */
async function generateKnowledgeInventory(options = {}) {
  const { subjectId, settings, signal, onProgress, keepExisting = true, forceRerun = false } = options;
  const prepared = prepareInventoryPlan({ ...options, persistStructure: true });
  // 规划阶段把旧清单读进了内存，真正的写入仍要拿到数据库句柄；
  // 这里显式 require，避免依赖规划函数内部的局部声明（0.6.8 曾因此 ReferenceError）。
  const database = require('./database.js');
  const {
    subject,
    sourceInfo,
    moduleList,
    baseStructure,
    structure,
    selected,
    concurrency,
    retryOptions,
    maxTokens,
    plan,
    totalBatches,
    existing,
    existingBlocks,
    cacheData,
    resumedChapters,
    skippedBatches,
  } = prepared;


  const regenerated = new Map();
  const failedChapters = [];
  const truncatedBatches = [];
  const batchDetails = [];
  const stats = { batches: 0, entries: 0, okChapters: 0, failedChapters, truncatedBatches };
  let doneBatches = skippedBatches;
  const runStartedAt = Date.now();
  if (resumedChapters.length) {
    console.info(`[Inventory] 续跑跳过 ${resumedChapters.length} 章（缓存命中）：${resumedChapters.map((item) => item.title).join('、')}`);
  }

  const emitProgress = (stage, payload = {}) => {
    if (typeof onProgress !== 'function') return;
    const elapsedMs = Date.now() - runStartedAt;
    const executed = doneBatches - skippedBatches;
    const etaMs = executed > 0
      ? Math.max(0, Math.round((elapsedMs / executed) * (totalBatches - doneBatches)))
      : null;
    try {
      onProgress({
        stage,
        subjectId,
        elapsedMs,
        etaMs,
        done: doneBatches,
        total: totalBatches,
        skippedBatches,
        resumedChapters: resumedChapters.map((item) => item.title),
        concurrency,
        ...payload,
      });
    } catch (error) {
      console.warn('[Inventory] 进度回调失败:', error?.message || error);
    }
  };

  emitProgress('plan', {
    chapters: selected.length,
    readyBatches: totalBatches - skippedBatches,
    resumedChapters,
  });
  for (const item of resumedChapters) {
    emitProgress('chapter:skipped', {
      chapter: item.title,
      chapterNo: item.no,
      fromPage: item.fromPage,
      toPage: item.toPage,
      entries: item.entries,
      message: `续跑跳过「${item.title}」（缓存命中 ${item.entries} 条）`,
    });
  }

  const persistChapterCache = (item) => {
    if (!item.finalEntries) return;
    cacheData.chapters[String(item.chapter.no)] = {
      hash: item.hash,
      title: item.chapter.title,
      fromPage: item.chapter.fromPage,
      toPage: item.chapter.toPage,
      learned: item.learned,
      entries: item.finalEntries,
      updatedAt: new Date().toISOString(),
    };
    cacheData.status = 'partial';
    try {
      saveChapterCache(subjectId, sourceInfo.key, cacheData);
    } catch (error) {
      console.warn('[Inventory] 写入章节缓存失败（不影响本次生成）:', error?.message || error);
    }
  };

  const finalizeChapter = (item) => {
    if (item.finalized) return;
    if (item.batchResults.some((result) => result === undefined)) return;
    item.finalized = true;
    const failures = item.batchResults.filter((result) => result?.error);
    if (failures.length) {
      item.error = item.batchResults
        .map((result, index) => (result?.error ? `第 ${index + 1} 批：${result.error}` : ''))
        .filter(Boolean)
        .join('；');
      return;
    }
    const entries = dedupeEntries(item.batchResults.flatMap((result) => result?.entries || []));
    item.finalEntries = entries;
    stats.entries += entries.length;
    // 整章成功就立刻落盘，后续章节失败时重跑可直接复用
    persistChapterCache(item);
  };

  const tasks = [];
  for (const item of plan) {
    if (item.cachedEntries) continue;
    item.batches.forEach((batch, batchIndex) => tasks.push({ item, batch, batchIndex }));
  }

  let taskCursor = 0;
  const runTask = async ({ item, batch, batchIndex }) => {
    if (signal?.aborted) throw new Error('知识清单生成已取消');
    const batchNo = batchIndex + 1;
    const range = batch.fromPage && batch.toPage ? `第 ${batch.fromPage}–${batch.toPage} 页` : `第 ${batchNo} 批`;
    emitProgress('batch:start', {
      chapter: item.chapter.title,
      chapterNo: item.chapter.no,
      batch: batchNo,
      chapterBatches: item.batches.length,
      fromPage: batch.fromPage,
      toPage: batch.toPage,
      message: `第 ${item.chapter.no} 章「${item.chapter.title}」${range} 开始（并发 ${concurrency}）`,
    });
    let outcome;
    try {
      const result = await requestBatchWithRetry({
        chapterTitle: item.chapter.title,
        batchNo,
        system: INVENTORY_SYSTEM,
        user: buildBatchPrompt({
          subjectName: subject.name,
          sourceName: `${sourceInfo.name}${sourceInfo.type === 'primary' ? '（主教材）' : '（补充资料）'}`,
          chapter: item.chapter,
          batch,
          learned: item.learned,
        }),
        settings,
        signal,
        maxTokens,
        onRetry: (retry) => {
          emitProgress('batch:retry', {
            chapter: item.chapter.title,
            chapterNo: item.chapter.no,
            batch: batchNo,
            attempt: retry.attempt,
            maxRetries: retry.maxRetries,
            delayMs: retry.delay,
            error: retry.error,
            message: `第 ${item.chapter.no} 章第 ${batchNo} 批遇到 ${retry.error}，${retry.delay}ms 后第 ${retry.attempt}/${retry.maxRetries} 次重试`,
          });
        },
      }, retryOptions);
      outcome = {
        entries: result.entries,
        truncated: result.truncated,
        finishReason: result.finishReason,
      };
    } catch (error) {
      if (signal?.aborted) throw new Error('知识清单生成已取消');
      outcome = { entries: [], truncated: false, error: error?.message || String(error) };
    }
    item.batchResults[batchIndex] = outcome;
    doneBatches += 1;
    emitProgress(outcome.error ? 'batch:failed' : 'batch:done', {
      chapter: item.chapter.title,
      chapterNo: item.chapter.no,
      batch: batchNo,
      chapterBatches: item.batches.length,
      fromPage: batch.fromPage,
      toPage: batch.toPage,
      entries: outcome.entries.length,
      chapterEntries: (item.finalEntries || []).length,
      truncated: Boolean(outcome.truncated),
      error: outcome.error || '',
      message: outcome.error
        ? `第 ${item.chapter.no} 章「${item.chapter.title}」第 ${batchNo} 批失败：${outcome.error}`
        : `第 ${item.chapter.no} 章「${item.chapter.title}」第 ${batchNo} 批完成（${outcome.entries.length} 条）`,
    });
    finalizeChapter(item);
  };

  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, tasks.length)) }, async () => {
    while (!signal?.aborted) {
      const index = taskCursor;
      taskCursor += 1;
      if (index >= tasks.length) return;
      await runTask(tasks[index]);
    }
    throw new Error('知识清单生成已取消');
  });
  await Promise.all(workers);

  // 按章节原始顺序汇总：并发完成顺序不影响条目顺序与编号
  for (const item of plan) {
    const { chapter } = item;
    if (item.cachedEntries) {
      stats.entries += item.cachedEntries.length;
      regenerated.set(chapter.no, {
        chapter,
        block: renderChapterBlock(chapter, dedupeEntries(item.cachedEntries), item.learned),
        entries: item.cachedEntries.length,
        failed: null,
        resumed: true,
      });
      item.batches.forEach((batch, batchIndex) => {
        batchDetails.push({
          chapterNo: chapter.no,
          chapter: chapter.title,
          batch: batchIndex + 1,
          fromPage: batch.fromPage,
          toPage: batch.toPage,
          entries: 0,
          resumed: true,
          truncated: false,
        });
      });
      continue;
    }
    item.batchResults.forEach((result, index) => {
      const batch = item.batches[index];
      const batchEntry = {
        chapterNo: chapter.no,
        chapter: chapter.title,
        batch: index + 1,
        fromPage: batch?.fromPage ?? null,
        toPage: batch?.toPage ?? null,
        entries: result?.entries?.length || 0,
        truncated: Boolean(result?.truncated),
        error: result?.error || undefined,
      };
      batchDetails.push(batchEntry);
      if (result?.truncated) {
        truncatedBatches.push({
          chapter: chapter.title,
          range: batch?.fromPage && batch?.toPage ? `第 ${batch.fromPage}–${batch.toPage} 页` : `第 ${index + 1} 批`,
        });
      }
    });
    if (item.error) {
      failedChapters.push({
        chapter: chapter.title,
        chapterNo: chapter.no,
        error: item.error,
        batches: item.batchResults.map((result, index) => (result?.error ? index + 1 : null)).filter(Boolean),
      });
    } else {
      stats.okChapters += 1;
    }
    regenerated.set(chapter.no, {
      chapter,
      block: renderChapterBlock(chapter, item.finalEntries || [], item.learned),
      entries: (item.finalEntries || []).length,
      failed: item.error,
      resumed: false,
    });
  }

  stats.batches = totalBatches;
  const elapsedMs = Date.now() - runStartedAt;
  emitProgress('generated', {
    okChapters: stats.okChapters,
    failedChapters: failedChapters.length,
    entries: stats.entries,
    message: `已生成 ${stats.okChapters}/${selected.length} 章，${stats.entries} 条；耗时 ${(elapsedMs / 1000).toFixed(1)}s`,
  });

  if (!regenerated.size) throw new Error('所有章节都生成失败，未写入知识清单');
  if (!stats.okChapters && !resumedChapters.length) {
    const detail = failedChapters.map((item) => `${item.chapter}：${item.error}`).join('；');
    throw new Error(`所有章节都生成失败，未写入知识清单（旧版保持不变）：${detail}`);
  }

  // 合并：本次涉及章节用新块，其余章节保留上一版原文
  const preservedBlocks = new Map();
  for (const block of existingBlocks) {
    if (!block.no) continue;
    if (!preservedBlocks.has(block.no)) preservedBlocks.set(block.no, block);
  }
  const moduleBlocks = [];
  const preservedNos = [];
  const missingChapters = [];
  const allChapters = moduleList.length ? selected : structure.chapters;
  for (const chapter of allChapters) {
    const regen = regenerated.get(chapter.no);
    if (regen && !regen.failed) {
      moduleBlocks.push(regen.block);
      continue;
    }
    const preserved = preservedBlocks.get(chapter.no);
    if (preserved) {
      // 本章生成失败但旧版有内容：保留原文，避免用失败占位覆盖掉可用清单
      moduleBlocks.push(preserved.text);
      preservedNos.push(chapter.no);
      continue;
    }
    if (regen) {
      // 没有旧版可保留时，把失败原因留在清单里，覆盖范围说明会再报一次
      moduleBlocks.push(regen.block);
      continue;
    }
    missingChapters.push(chapter);
  }
  // 自定义模块之外、旧清单里可能还有本次未涉及且结构表里没有的块：一并保留，避免丢内容
  if (!moduleList.length) {
    for (const [no, block] of preservedBlocks) {
      if (moduleBlocks.some((item) => item.startsWith(`## 模块`) && item.includes(`第 ${no} 章`))) continue;
      if (regenerated.has(no)) continue;
      if (structure.chapters.some((chapter) => chapter.no === no)) continue;
      moduleBlocks.push(block.text);
      preservedNos.push(no);
    }
  }

  const header = [
    `# ${subject.name} · 知识清单`,
    `> 来源：${sourceInfo.type === 'primary' ? '主教材' : '补充资料'}《${sourceInfo.name}》${sourceInfo.totalPages ? `，共 ${sourceInfo.totalPages} 页` : ''}；生成时间 ${new Date().toLocaleString('zh-CN')}。`,
    `> 本次按章分批生成：${selected.length} 章 / ${totalBatches} 批；编号、索引与覆盖范围说明由系统生成。`,
  ].join('\n');

  const chapterEntries = selected.map((chapter) => ({
    no: chapter.no,
    title: chapter.title,
    entries: regenerated.get(chapter.no)?.entries || 0,
  }));
  const coverage = buildCoverageSection({
    source: sourceInfo,
    selected,
    chapterEntries,
    preservedNos: [...new Set(preservedNos)],
    missingChapters,
    stats,
    warnings: structure.warnings,
    resumed: resumedChapters,
    skippedBatches,
    concurrency,
  });
  const index = buildIndexSection(moduleBlocks);
  const rawContent = [header, ...moduleBlocks, coverage, index].filter(Boolean).join('\n\n');
  const normalized = normalizeMath(rawContent);

  const snapshotPath = writeSnapshot(subjectId, existing?.content || '');
  // 计划到保存之间旧笔记可能已在笔记页被删除：以数据库现状为准，
  // 删了就新建，绝不拿旧 id 去覆盖不存在的（或别人的）笔记。
  const existingNote = existing?.id ? database.getNote(existing.id) : null;
  const previousNoteMissing = Boolean(existing?.id) && !existingNote;
  const note = database.saveNote({
    id: existingNote?.id || undefined,
    title: `知识清单 · ${subject.name}`,
    content: normalized.text,
    tags: [subject.name, '知识清单'],
    sourceType: 'subject',
    sourceId: subject.id,
    sourceLabel: sourceInfo.type === 'primary' ? '教材解析' : '补充资料',
    subjectId: subject.id,
    meta: {
      kind: 'knowledge',
      subject: subject.name,
      generatedAt: new Date().toISOString(),
      source: { key: sourceInfo.key, type: sourceInfo.type, name: sourceInfo.name, totalPages: sourceInfo.totalPages },
      chapters: selected.map((chapter) => ({ no: chapter.no, title: chapter.title, fromPage: chapter.fromPage, toPage: chapter.toPage })),
      batches: totalBatches,
      truncated: truncatedBatches.length > 0,
      failed: failedChapters,
      snapshotPath: snapshotPath || null,
    },
  });

  // 清单正文完整写入 knowledge_summary：不再只存前 60 行标题，
  // 助教上下文与题库分类都能看到完整章节。
  subjectManager.saveSubject({ id: subject.id, knowledgeSummary: normalized.text });

  // 清单位、知识点索引都已完整写入：此时才整理章节缓存。
  // 只删除已不属于当前结构表的陈旧条目，保留本次用过的条目供下次同范围复用；
  // 中途失败时不会走到这里，缓存保持 partial，可继续续跑。
  try {
    const validKeys = new Set(baseStructure.chapters.map((chapter) => String(chapter.no)));
    for (const key of Object.keys(cacheData.chapters)) {
      if (!validKeys.has(key)) delete cacheData.chapters[key];
    }
    cacheData.status = 'committed';
    cacheData.lastCommitAt = new Date().toISOString();
    saveChapterCache(subjectId, sourceInfo.key, cacheData);
  } catch (error) {
    console.warn('[Inventory] 整理章节缓存失败（不影响清单）:', error?.message || error);
  }

  emitProgress('done', {
    okChapters: stats.okChapters,
    failedChapters: failedChapters.length,
    entries: stats.entries,
    elapsedMs,
    chars: normalized.text.length,
    message: `知识清单已写入：${selected.length} 章 / ${totalBatches} 批，${normalized.text.length} 字，耗时 ${(elapsedMs / 1000).toFixed(1)}s${previousNoteMissing ? '；原清单已被删除，已按缓存内容新建' : ''}`,
  });

  return {
    noteId: note?.id || null,
    // 计划时读到的旧笔记若在保存前被删除，这里会新建一篇，并如实提示
    noteCreated: !existingNote,
    previousNoteMissing,
    notice: previousNoteMissing ? '原清单已被删除，已按缓存内容新建' : '',
    chars: normalized.text.length,
    elapsedMs,
    concurrency,
    source: {
      key: sourceInfo.key,
      type: sourceInfo.type,
      name: sourceInfo.name,
      totalPages: sourceInfo.totalPages,
      textPath: sourceInfo.textPath,
    },
    structureFile: chapterStructure.structurePath(subjectId, sourceInfo.key),
    structureWarnings: structure.warnings || [],
    chapterCount: selected.length,
    selectedChapters: selected.map((chapter) => ({
      no: chapter.no,
      title: chapter.title,
      fromPage: chapter.fromPage,
      toPage: chapter.toPage,
      auto: Boolean(chapter.auto),
      entries: regenerated.get(chapter.no)?.entries || 0,
      resumed: Boolean(regenerated.get(chapter.no)?.resumed),
    })),
    batches: totalBatches,
    batchDetails,
    batchEntries: selected.map((chapter) => ({
      no: chapter.no,
      title: chapter.title,
      entries: regenerated.get(chapter.no)?.entries || 0,
    })),
    truncated: truncatedBatches.length > 0,
    truncatedBatches,
    failedChapters,
    resumedChapters,
    skippedBatches,
    forceRerun,
    cacheFile: chapterCachePath(subjectId, sourceInfo.key),
    preservedChapters: [...new Set(preservedNos)],
    missingChapters: missingChapters.map((chapter) => ({ no: chapter.no, title: chapter.title })),
    snapshotPath: snapshotPath || null,
    mathWarnings: normalized.warnings.slice(0, 5),
  };
}

module.exports = {
  generateKnowledgeInventory,
  planKnowledgeInventory,
  prepareInventoryPlan,
  splitChapterBatches,
  extractJsonObjects,
  normalizeEntry,
  selectChapters,
  parseExistingBlocks,
};
