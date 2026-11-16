/**
 * 教材解析流水线（主进程）
 *
 * 用户上传教材 → 渲染层逐页取文本/识图 → 这里负责逐页落盘、生成知识清单
 * （写进笔记库 / Obsidian）、把课本例题与习题提取进题库。
 *
 * 每一步独立成函数，渲染层串行/并发调用并展示进度；任何一步失败都能重试，
 * 逐页结果先落盘，中断后重新上传同一本书可以接着上次的页码继续。
 */

const fs = require('fs');
const path = require('path');
const aiService = require('./ai/index.js');
const subjectManager = require('./subjectManager.js');
const materialManager = require('./materialManager.js');
const { GOOD_LEARNING_SKILL } = require('../shared/goodLearningSkill.js');
const { MATH_STYLE_PROMPT, normalizeMath } = require('../shared/mathStyle.js');
const { repairGhostText } = require('./textRepair.js');

/** 教材文本疑似损坏（幽灵文字层 / Tofu）时，返回给用户的可执行提示 */
function corruptTextMessage(quality, action) {
  const pct = quality.topShare ? ` 占正文约 ${Math.round(quality.topShare * 100)}%` : '';
  const ghost = quality.topChar ? `（检测到大量重复乱码字符「${quality.topChar}」${pct}）` : '';
  const where = action === 'inventory' ? '无法生成知识清单' : '无法提取题目写入题库';
  return `教材文本疑似损坏/乱码${ghost}，${where}。请到「科目」页点击「重新解析」重跑，或到「资料管理」重新上传一份清晰版主教材 PDF（避免从带隐藏文字层的扫描件直接转 PDF）。`;
}

const PAGE_FILE_RE = /^页-(\d+)\.md$/;
const META_FILE = '解析进度.json';
const PAGE_DIR_NAME = '教材';

/* ------------------------------------------------------------------ 逐页落盘 */

function textbookDir(subjectId) {
  const dir = subjectManager.getSubjectDir(subjectId);
  if (!dir) throw new Error('科目不存在');
  const pageDir = path.join(dir, PAGE_DIR_NAME);
  fs.mkdirSync(pageDir, { recursive: true });
  return pageDir;
}

function emptyMeta() {
  return { fileName: null, pages: [], total: 0, status: null, error: null, updatedAt: null, noteId: null };
}

function readParseMeta(subjectId) {
  try {
    const file = path.join(textbookDir(subjectId), META_FILE);
    if (!fs.existsSync(file)) return emptyMeta();
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      fileName: parsed.fileName || null,
      pages: Array.isArray(parsed.pages) ? parsed.pages.map((n) => Number(n)).filter((n) => n > 0) : [],
      total: Number(parsed.total) || 0,
      status: parsed.status || null,
      error: parsed.error || null,
      updatedAt: parsed.updatedAt || null,
      // 分批解析时用来原地更新知识清单笔记，别让 noteId 在读写之间丢掉
      noteId: parsed.noteId || null,
    };
  } catch (error) {
    console.warn('[Subjects] 读取解析进度失败:', error?.message || error);
    return emptyMeta();
  }
}

function writeParseMeta(subjectId, patch = {}) {
  try {
    const dir = textbookDir(subjectId);
    const next = { ...readParseMeta(subjectId), ...patch, updatedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(dir, META_FILE), JSON.stringify(next, null, 2), 'utf8');
    return next;
  } catch (error) {
    console.warn('[Subjects] 写入解析进度失败:', error?.message || error);
    return null;
  }
}

/** 扫描已落盘的页码，meta 丢了也能从文件名恢复 */
function readPageFiles(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((name) => PAGE_FILE_RE.test(name));
  } catch {
    return [];
  }
  return files
    .map((name) => ({
      page: Number(name.match(PAGE_FILE_RE)[1]),
      markdown: fs.readFileSync(path.join(dir, name), 'utf8'),
    }))
    .sort((a, b) => a.page - b.page);
}

function clearPageFiles(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of files) {
    if (PAGE_FILE_RE.test(name) || name === META_FILE) {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch (error) {
        console.warn('[Subjects] 清理旧页失败:', name, error?.message || error);
      }
    }
  }
}

/**
 * 单页结果落盘：subjects/<id>/教材/页-0001.md
 * 换教材（文件名不同）时清空旧页，避免两本书的转写混进同一份全文。
 */
function saveTextbookPage({ subjectId, page, markdown, source = 'vision', fileName, total } = {}) {
  const subject = subjectManager.getSubject(subjectId);
  if (!subject) throw new Error('科目不存在');
  const pageNo = Number(page);
  if (!Number.isFinite(pageNo) || pageNo <= 0) throw new Error('页码不合法');

  const dir = textbookDir(subjectId);
  const meta = readParseMeta(subjectId);
  if (fileName && meta.fileName && meta.fileName !== fileName) {
    clearPageFiles(dir);
    meta.pages = [];
  }

  const label = source === 'text' ? 'PDF 文字层' : 'AI 识图';
  // MinerU 本地解析与 API 识图的产物都可能带「幽灵文字层」（每个字之间夹一个乱码字）；
  // 落盘前统一剔除，让教材全文、知识清单、题目提取、助教检索共用一份干净正文
  const cleaned = repairGhostText(String(markdown || '')).text;
  // 逐页转写会喂给知识清单模型，也会随笔记同步进 Obsidian，公式先统一成 MathJax 写法
  const pageBody = normalizeMath(cleaned.trim()).text;
  const body = `<!-- 第 ${pageNo} 页 · ${label} -->\n\n${pageBody}\n`;
  fs.writeFileSync(path.join(dir, `页-${String(pageNo).padStart(4, '0')}.md`), body, 'utf8');

  const pages = new Set(meta.pages);
  pages.add(pageNo);
  writeParseMeta(subjectId, {
    fileName: fileName || meta.fileName,
    pages: [...pages].sort((a, b) => a - b),
    total: Number(total) || meta.total || 0,
    status: 'parsing',
    error: null,
  });
  return { page: pageNo, saved: pages.size };
}

/** 断点续传：返回已完成的页码与上次的教材文件名 */
function getTextbookProgress(subjectId) {
  const subject = subjectManager.getSubject(subjectId);
  if (!subject) return { pages: [], fileName: null, total: 0, status: 'none' };
  const dir = textbookDir(subjectId);
  const meta = readParseMeta(subjectId);
  const fromFiles = readPageFiles(dir).map((item) => item.page);
  // 新版会把每页原图也落盘；只有「正文 + 页图」都齐的页才算真正可续传，
  // 否则题目会缺配图。旧版本解析过的页在这里会被判为待补跑。
  let figurePages = [];
  try {
    const figures = require('./textbookFigures.js').loadIndex(subjectId);
    if (!figures.fileName || figures.fileName === (meta.fileName || subject.textbookName || '')) {
      figurePages = figures.pageImages.map((item) => Number(item.page)).filter((n) => n > 0);
    }
  } catch { /* 索引不存在就当全部待补 */ }
  return {
    pages: fromFiles.length ? fromFiles : meta.pages,
    figurePages,
    fileName: meta.fileName || subject.textbookName || null,
    total: meta.total || 0,
    status: meta.status || subject.textbookStatus || 'none',
  };
}

/* ------------------------------------------------------------------ 全文落盘 */

/** 拼接逐页结果 → 教材/教材全文.md，状态置 ready */
function saveTranscription({ subjectId, pages, fileName, totalPages } = {}) {
  const subject = subjectManager.getSubject(subjectId);
  if (!subject) throw new Error('科目不存在');

  const dir = textbookDir(subjectId);
  let list = readPageFiles(dir);

  // 兼容旧调用：没有逐页文件时，用渲染层传来的 pages 补写一份
  if (!list.length) {
    const incoming = (Array.isArray(pages) ? pages : [])
      .filter((page) => page && String(page.markdown || '').trim())
      .sort((a, b) => (Number(a.page) || 0) - (Number(b.page) || 0));
    if (!incoming.length) throw new Error('没有可保存的转写内容');
    for (const page of incoming) {
      saveTextbookPage({
        subjectId,
        page: page.page,
        markdown: page.markdown,
        source: page.source || 'vision',
        fileName,
        total: totalPages,
      });
    }
    list = readPageFiles(dir);
  }

  if (!list.length) throw new Error('没有可保存的转写内容');

  const composed = [
    `# ${subject.name} · 教材全文`,
    '',
    `> 来源：${fileName || subject.textbookName || '用户上传教材'}，共 ${list.length} 页转写。`,
    '> 数字版页面直接取 PDF 文字层，扫描页由 AI 识图；个别页面可能识别不全，知识清单中的「范围待核」条目请对照原文核对。',
    list.map((page) => `\n\n<!-- 第 ${page.page} 页 -->\n\n${String(page.markdown).trim()}`).join(''),
  ].join('');

  // 兼容早期版本落下的页文件（落盘前没做幽灵字符修复）：汇总时再修一次，
  // 保证「教材全文.md」始终是干净正文
  const repair = repairGhostText(composed);
  if (repair.repaired) {
    console.warn(`[subjectTextbook] 教材汇总检测到幽灵文字层，已剔除乱码字符「${repair.ghostChar}」共 ${repair.removed} 处`);
  }
  const markdown = repair.text;

  const resolvedName = fileName || subject.textbookName || '';
  subjectManager.saveSubject({
    id: subject.id,
    textbookStatus: 'ready',
    textbookName: resolvedName,
    textbookPages: list.length,
  });
  subjectManager.writeSubjectTextbook(subject.id, resolvedName, markdown, list.length);
  writeParseMeta(subjectId, { fileName: resolvedName, total: Number(totalPages) || list.length, status: 'ready', error: null });

  return { pages: list.length, chars: markdown.length };
}

/**
 * 解析失败原因里可能带 MinerU 服务日志尾部（关键 traceback 在最后几行），
 * 不能直接截到 300 字符。超长时保留开头结论 + 结尾日志，中间省略。
 */
function compactErrorText(reason, max = 6000) {
  const text = String(reason || '解析中断').trim() || '解析中断';
  if (text.length <= max) return text;
  const headLen = 1200;
  const tailLen = max - headLen;
  const omitted = text.length - headLen - tailLen;
  return `${text.slice(0, headLen)}\n…（中间省略 ${omitted} 字符）…\n${text.slice(-tailLen)}`;
}

/** 解析失败 / 取消：状态落成 failed，卡片上可以直接重试，不会再永远停在「解析中」 */
function markTextbookFailed(subjectId, reason) {
  const subject = subjectManager.getSubject(subjectId);
  if (!subject) return { success: false };
  subjectManager.saveSubject({ id: subjectId, textbookStatus: 'failed' });
  writeParseMeta(subjectId, { status: 'failed', error: compactErrorText(reason) });
  return { success: true };
}

/** 清空解析结果，回到未上传状态 */
function resetTextbook(subjectId) {
  const subject = subjectManager.getSubject(subjectId);
  if (!subject) return { success: false };
  const dir = textbookDir(subjectId);
  clearPageFiles(dir);
  try {
    const full = path.join(dir, '教材全文.md');
    if (fs.existsSync(full)) fs.unlinkSync(full);
  } catch (error) {
    console.warn('[Subjects] 清理教材全文失败:', error?.message || error);
  }
  subjectManager.saveSubject({ id: subjectId, textbookStatus: 'none', textbookPages: 0 });
  return { success: true };
}

/* ------------------------------------------------------------------ 知识清单 */

/** 知识清单生成提示词：skill 方法论 + 教材全文 */
function buildInventoryPrompt(subject, textbookMarkdown) {
  return `${GOOD_LEARNING_SKILL}

# 任务

你刚读完《${subject.name}》的教材转写全文。请严格按照上文的「知识清单（kind: knowledge）」规范，
为这门科目生成**完整的知识清单**，直接输出 Markdown 正文（不要代码块包裹，不要开场白）：

- 按教材章节组织成主题模块，模块内拆出可检查的知识点，每项带稳定编号（如 1.1、1.2、2.1）；
- 每个知识点给出：核心概念与使用条件、典型任务或题型、必要前置、材料位置（第几章/第几节）、优先级（高/中/低）、当前状态（统一填「掌握待测」）；
- 清单末尾给一节「覆盖范围说明」：列出教材覆盖的章节、转写中识别不清或缺失的部分（标「范围待核」）；
- 再给一节「知识点编号索引」：一行一个「编号 - 知识点名」，方便后续计划和错题引用；
- 如果科目是备考模式（考试日期 ${subject.examDate || '无'}），优先级按考查可能性排序；学习模式按教材逻辑顺序。

# 数学公式规范（清单里出现公式时必须遵守）

${MATH_STYLE_PROMPT}

# 教材转写全文

${textbookMarkdown}`;
}

/**
 * 生成知识清单：调用助教角色模型 → 写进笔记库（subject_id 关联，Obsidian 同步）
 * 同时把清单前 2000 字存进 subjects.knowledge_summary，供对话上下文引用。
 */
async function generateKnowledgeInventory({ subjectId, settings, signal }) {
  const subject = subjectManager.getSubject(subjectId);
  if (!subject) throw new Error('科目不存在');

  const dir = subjectManager.getSubjectDir(subjectId);
  const textbookFile = path.join(dir, PAGE_DIR_NAME, '教材全文.md');
  if (!fs.existsSync(textbookFile)) throw new Error('教材还没转写完成，先完成逐页转写');

  const textbookMarkdown = fs.readFileSync(textbookFile, 'utf8');
  if (textbookMarkdown.length < 200) throw new Error('教材转写内容太少，无法生成知识清单');

  // 教材若带「幽灵文字层」（某异常字高频出现在每字之间），尝试整体剔除救回原文；
  // 只有剔除后仍判定损坏（如 Tofu 缺失类、无法恢复）才报错，避免静默产出乱码清单
  const inventoryRepair = repairGhostText(textbookMarkdown);
  if (inventoryRepair.repaired) {
    console.warn(`[subjectTextbook] 教材检测到幽灵文字层，已自动剔除乱码字符「${inventoryRepair.ghostChar}」共 ${inventoryRepair.removed} 处`);
  }
  if (inventoryRepair.quality.corrupt) {
    throw new Error(corruptTextMessage(inventoryRepair.quality, 'inventory'));
  }
  const textbookMarkdownClean = inventoryRepair.text;

  // 超长教材截断：保留开头与结尾（章节结构通常在开头，习题在结尾）
  const LIMIT = 60000;
  const trimmed = textbookMarkdownClean.length > LIMIT
    ? `${textbookMarkdownClean.slice(0, LIMIT * 0.7)}\n\n<!-- 中间部分过长已截断 -->\n\n${textbookMarkdownClean.slice(-LIMIT * 0.3)}`
    : textbookMarkdownClean;

  const assistantSettings = aiService.resolveRoleSettings(settings, 'assistant');
  // 兜底超时：超长教材偶尔会让模型迟迟不返回，卡住整条流水线
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5 * 60 * 1000);
  let result;
  try {
    result = await aiService.complete(assistantSettings, {
      system: `你是学习平台的 AI 助教，正在按 Good Learning 方法论为用户建立知识清单。只输出清单 Markdown 正文。笔记会自动同步到 Obsidian，数学公式必须用 $...$ / $$...$$ 的 MathJax LaTeX 书写。\n\n${MATH_STYLE_PROMPT}`,
      messages: [{ role: 'user', content: buildInventoryPrompt(subject, trimmed) }],
      maxTokens: 8192,
      // 整理清单不需要思维链：关掉后长输出不会被推理 token 截断，也明显更快
      fast: true,
      signal: signal || controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!result?.success) throw new Error(result?.error || '知识清单生成失败');

  const normalized = normalizeMath(String(result.content || '').trim());
  if (normalized.warnings.length) {
    console.warn('[Subjects] 知识清单公式格式提醒：', ...normalized.warnings.slice(0, 3));
  }
  const content = normalized.text;
  if (content.length < 100) throw new Error('知识清单内容异常地短，请重试');

  const summary = content
    .split('\n')
    .filter((line) => /^\s*(#{1,4}\s|[-*]\s)?\s*(\d+(\.\d+)*[.、\s])/.test(line) || /^#{1,3}\s/.test(line))
    .slice(0, 60)
    .join('\n');

  subjectManager.saveSubject({
    id: subject.id,
    knowledgeSummary: summary || content.slice(0, 1500),
  });

  const note = require('./database.js').saveNote({
    // 分批解析时反复生成清单：沿用上一次的笔记 id 原地更新，避免笔记库里堆一串同名清单
    id: readParseMeta(subjectId).noteId || undefined,
    title: `知识清单 · ${subject.name}`,
    content,
    tags: [subject.name, '知识清单'],
    sourceType: 'subject',
    sourceId: subject.id,
    sourceLabel: '教材解析',
    subjectId: subject.id,
    meta: { kind: 'knowledge', subject: subject.name, generatedAt: new Date().toISOString() },
  });

  if (note?.id) writeParseMeta(subjectId, { noteId: note.id });

  return { noteId: note?.id || null, chars: content.length };
}

/* ------------------------------------------------------------------ 题目提取 */

/**
 * 按标题块切分教材文本，每块独立提取题目，块太大再按长度硬切。
 * 用累计长度而不是每行 join 一次，避免长教材上的 O(n²) 开销。
 */
function splitTextbookChunks(text, targetChars = 6000) {
  const source = String(text || '');
  const lines = source.split('\n');
  const blocks = [];
  let current = [];
  let currentLength = 0;

  const flush = () => {
    if (current.length) blocks.push(current.join('\n'));
    current = [];
    currentLength = 0;
  };

  for (const line of lines) {
    // 一级/二级标题是天然分界
    if (/^#{1,2}\s/.test(line) && currentLength > targetChars * 0.5) {
      flush();
    }
    current.push(line);
    currentLength += line.length + 1;
    if (currentLength >= targetChars) flush();
  }
  flush();

  // 超长块硬切
  const chunks = [];
  for (const block of blocks) {
    if (block.length <= targetChars * 1.8) {
      chunks.push(block);
      continue;
    }
    for (let offset = 0; offset < block.length; offset += targetChars) {
      chunks.push(block.slice(offset, offset + targetChars));
    }
  }
  return chunks.filter((chunk) => /\S/.test(chunk));
}

/** 只有带「例题 / 习题 / 思考题」标记的段落才值得调模型提取题目 */
const EXERCISE_MARKER = /(例\s*\d|例题|习题|练习|思考题|作业题|自测题|复习题|题\s*\d+\s*[.．、])/;

function hasExerciseMarker(chunk) {
  return EXERCISE_MARKER.test(chunk);
}

function withTimeout(promise, ms, label = '请求') {
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时（${Math.round(ms / 1000)} 秒）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** 页范围筛选：按章节从教材/资料提取题目时，只把落在指定页码内的块送给模型 */
function chunkPageSpan(chunk) {
  const pages = [...String(chunk).matchAll(/<!--\s*第\s*(\d+)\s*页/g)].map((match) => Number(match[1]));
  if (!pages.length) return null;
  return { from: Math.min(...pages), to: Math.max(...pages) };
}

function filterChunksByPages(chunks, pages) {
  const from = Number(pages?.from) || 0;
  const to = Number(pages?.to) || 0;
  if (!from && !to) return chunks;
  const low = from || 1;
  const high = to || Number.MAX_SAFE_INTEGER;
  return chunks.filter((chunk) => {
    const span = chunkPageSpan(chunk);
    return Boolean(span) && span.to >= low && span.from <= high;
  });
}

/**
 * 从教材/补充资料提取例题与习题进题库。
 * 有主教材时按主教材走；没有主教材时读全部已就绪的补充资料（可传 materialIds 限定）。
 * 只处理带题目标记的段落，多段并发（默认 2 路）调用现有文本识题管线，最后合并入一份试卷。
 */
async function generateTextbookQuestions({ subjectId, settings, signal, onProgress, concurrency = 2, timeoutMs = 180000, budgetMs = 10 * 60 * 1000, pages = null, title = '', paperId: appendPaperId = null, dryRun = false, materialIds = [] } = {}) {
  const subject = subjectManager.getSubject(subjectId);
  if (!subject) throw new Error('科目不存在');

  const dir = subjectManager.getSubjectDir(subjectId);
  const textbookFile = path.join(dir, PAGE_DIR_NAME, '教材全文.md');
  const hasPrimary = fs.existsSync(textbookFile);

  // 来源选择：主教材优先；没有主教材时从补充资料里摘题
  const sources = [];
  let sourceMaterials = [];
  if (hasPrimary) {
    sources.push({ name: '', markdown: fs.readFileSync(textbookFile, 'utf8'), fromTextbook: true });
  } else {
    const index = materialManager.listMaterials(subjectId);
    const wanted = (Array.isArray(materialIds) ? materialIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean);
    const ready = (index.supplementary || []).filter((item) => item.status === 'ready' && item.hasText && item.textPath
      && (!wanted.length || wanted.includes(String(item.id))));
    if (!ready.length) {
      throw new Error(wanted.length
        ? '指定的补充资料还没有解析完成，无法提取题目'
        : '还没有可提取题目的资料：请先上传主教材，或添加并解析补充资料');
    }
    sourceMaterials = ready;
    for (const item of ready) {
      const markdown = materialManager.readSupplementaryText(subjectId, item.id);
      if (!String(markdown || '').trim()) continue;
      // 资料转写文件自带标题与 `<!-- 第 N 页 -->` 页标记，直接拼接即可保持出处页码
      sources.push({ name: item.name || '补充资料', markdown, fromTextbook: false, item });
    }
    if (!sources.length) throw new Error('补充资料的转写内容为空，无法提取题目');
  }

  // 教材若带「幽灵文字层」，先整体剔除救回原文再拆段；剔除后仍损坏才报错，
  // 避免把乱码喂给模型后静默产出 0 题。补充资料逐份剔除，个别损坏不影响其余资料。
  const hasRange = Boolean(Number(pages?.from) || Number(pages?.to));
  const allChunks = [];
  const corruptSources = [];
  const emptyRangeSources = [];
  let candidateCount = 0;
  for (const source of sources) {
    const repair = repairGhostText(source.markdown);
    if (repair.repaired) {
      console.warn(`[subjectTextbook] ${source.name || '教材'}检测到幽灵文字层，已自动剔除乱码字符「${repair.ghostChar}」共 ${repair.removed} 处`);
    }
    if (repair.quality.corrupt) {
      if (source.fromTextbook) {
        return {
          success: false,
          corrupt: true,
          questions: 0,
          paperId: null,
          source: 'textbook',
          note: corruptTextMessage(repair.quality, 'questions'),
          error: corruptTextMessage(repair.quality, 'questions'),
        };
      }
      corruptSources.push(source.name);
      continue;
    }
    const sourceChunks = splitTextbookChunks(repair.text);
    if (!sourceChunks.length) {
      if (source.fromTextbook) throw new Error('教材转写内容为空');
      continue;
    }
    candidateCount += sourceChunks.length;
    const scopedChunks = filterChunksByPages(sourceChunks, pages);
    if (!scopedChunks.length) {
      if (source.fromTextbook) throw new Error('指定页范围内没有可提取的教材内容');
      emptyRangeSources.push(source.name);
      continue;
    }
    const marked = scopedChunks.filter(hasExerciseMarker);
    // 没有题目标记时退回全量（并限流），否则宁可少跑几段也别空手而归；按份限流，保证每份资料都能被扫到
    const picked = (marked.length ? marked : scopedChunks).slice(0, hasRange ? 80 : 60);
    picked.forEach((text) => allChunks.push({ text, source }));
  }
  if (!allChunks.length) {
    const skipped = [...corruptSources, ...emptyRangeSources];
    return {
      success: false,
      questions: 0,
      paperId: null,
      source: hasPrimary ? 'textbook' : 'supplementary',
      corrupt: corruptSources.length > 0,
      note: skipped.length
        ? `可用的资料内容为空或没有落在指定页范围内（${skipped.join('、')}）`
        : '资料转写内容为空',
      error: skipped.length ? `没有可提取的资料内容：${skipped.join('、')}` : '资料转写内容为空',
    };
  }
  const chunks = allChunks;

  const visionSettings = aiService.resolveRoleSettings(settings, 'vision');
  const results = new Array(chunks.length);
  const deadline = Date.now() + budgetMs;
  let cursor = 0;
  let done = 0;
  let collectedCount = 0;
  let budgetHit = false;

  const report = () => {
    if (typeof onProgress !== 'function') return;
    onProgress({
      done,
      total: chunks.length,
      questions: collectedCount,
      skipped: candidateCount - chunks.length,
    });
  };

  const worker = async () => {
    while (true) {
      if (signal?.aborted) return;
      // 总时间预算：宁可少扫几段，也别让一次解析挂上一小时
      if (Date.now() > deadline) {
        budgetHit = true;
        return;
      }
      const index = cursor;
      cursor += 1;
      if (index >= chunks.length) return;
      const chunk = chunks[index];

      try {
        const raw = await withTimeout(
          aiService.structureQuestionsFromText(visionSettings, chunk.text, { signal }),
          timeoutMs,
          '题目提取',
        );
        const parsed = aiService.parseAIJson ? aiService.parseAIJson(raw, ['questions']) : null;
        const questions = Array.isArray(parsed?.questions) ? parsed.questions : [];
        // 每个块带上它来自哪一页，题目提到「图 X-Y」时才能定位到该页的插图/整页图。
        // 块可能跨多页：只用模型按「<!-- 第 N 页 -->」标记回报、且落在本块范围内的 page；
        // 拿不到就留空（不挂图），绝不拿块首页硬当题目所在页。
        const span = chunkPageSpan(chunk.text);
        const sourcePageOf = (question) => {
          const reported = Number(question?.page);
          if (Number.isFinite(reported) && reported > 0
            && (!span || (reported >= span.from && reported <= span.to))) {
            return reported;
          }
          // 拿不到确切页码就留空：宁可这道题不挂图，也不能把块首页当成题目所在页挂错
          return null;
        };
        results[index] = questions.map((question) => (question && typeof question === 'object'
          ? {
            ...question,
            __sourcePage: sourcePageOf(question),
            __fromTextbook: chunk.source.fromTextbook,
            __sourceName: chunk.source.name || '',
          }
          : question));
        collectedCount += questions.length;
      } catch (error) {
        if (signal?.aborted) return;
        // 单块失败不影响其余章节，最后汇报
        console.warn('[Subjects] 题目提取单块失败:', error?.message || error);
        results[index] = [];
      }
      done += 1;
      report();
    }
  };

  report();
  const lanes = Math.max(1, Math.min(concurrency, chunks.length));
  await Promise.all(Array.from({ length: lanes }, () => worker()));

  if (signal?.aborted) return { cancelled: true, questions: 0, paperId: null };

  const collected = results.flat().filter(Boolean);
  if (!collected.length) {
    return {
      questions: 0,
      paperId: null,
      source: hasPrimary ? 'textbook' : 'supplementary',
      pendingClassification: !hasPrimary,
      note: budgetHit
        ? '例题提取达到时间上限，还没识别出可入库的题目'
        : (hasPrimary ? '教材里没有识别出可入库的例题/习题' : '补充资料里没有识别出可入库的例题/习题'),
      scanned: done,
      total: chunks.length,
      partial: budgetHit,
    };
  }

  const database = require('./database.js');
  const sourceMeta = () => ({
    source: hasPrimary ? 'textbook' : 'supplementary',
    sourceNames: sources.map((item) => item.name).filter(Boolean),
    // 没有主教材就没有知识清单，题目先入库、暂不做知识图谱分类
    pendingClassification: !hasPrimary,
    classificationNote: hasPrimary ? '' : '未上传主教材：题目已入库，但还没有知识清单，暂未按知识图谱分类',
    missingPages: sourceMaterials.flatMap((item) => (Array.isArray(item.missingPages)
      ? item.missingPages.map((no) => `《${item.name}》第 ${no} 页`)
      : [])),
    corruptSources,
    emptyRangeSources,
  });
  // 只识别不入库：补图 / 校对时用，避免重复建卷、重复题目
  if (dryRun) {
    let questions = collected;
    let figureStats = { attached: 0, fallback: 0 };
    if (hasPrimary) {
      try {
        const textbookFigures = require('./textbookFigures.js');
        const enriched = textbookFigures.attachFiguresToQuestions(subjectId, collected);
        questions = enriched.questions;
        figureStats = { attached: enriched.attached, fallback: enriched.fallback };
      } catch (error) {
        console.warn('[Subjects] 题目配图失败（dryRun）:', error?.message || error);
      }
    }
    return {
      success: true,
      dryRun: true,
      ...sourceMeta(),
      questions,
      figureStats,
      scanned: done,
      total: chunks.length,
      partial: budgetHit,
      skipped: candidateCount - chunks.length,
    };
  }
  // 分批 / 重复解析会反复扫到同一批题目：按题干去重，只入库新题。
  // 纯字符串相等太脆——同一道题两次识别，编号、标点、换行经常有细微差异，
  // 所以先做归一化精确匹配，再用二元组相似度兜一层模糊匹配。
  const DUP_SIMILARITY = 0.8;
  // 短题干不参与模糊匹配：一句话的选择题很容易彼此相似，误杀代价比漏判大
  const FUZZY_MIN_LENGTH = 24;
  const normalize = (value) => String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/^[（(【\[]*\d+[)）】\]、.．]\s*/, '')
    .toLowerCase()
    .trim();
  const bigrams = (text) => {
    const grams = new Set();
    for (let i = 0; i < text.length - 1; i += 1) grams.add(text.slice(i, i + 2));
    return grams;
  };
  const similarity = (left, right) => {
    if (left === right) return 1;
    if (left.length < 2 || right.length < 2) return 0;
    const a = bigrams(left);
    const b = bigrams(right);
    if (!a.size || !b.size) return 0;
    let shared = 0;
    for (const gram of a) if (b.has(gram)) shared += 1;
    return (2 * shared) / (a.size + b.size);
  };
  // 图号 / 公式编号不同，基本就是两道不同的题，不做模糊合并。
  // 只认「2-40」「3.5」这类复合编号：单个数字噪声太大，而且识别时漏掉图号很常见，
  // 所以只有两边都带着编号、且编号不一致时才拦下来。
  const figures = (text) => new Set(text.match(/\d+(?:[.\-]\d+)+/g) || []);
  const figuresConflict = (a, b) => {
    if (!a.size || !b.size) return false;
    if (a.size !== b.size) return true;
    for (const item of a) if (!b.has(item)) return true;
    return false;
  };

  const pool = (database.getSubjectQuestionContents?.(subjectId) || [])
    .map(normalize)
    .filter(Boolean);
  const exact = new Set(pool);
  const isDuplicate = (key) => {
    if (exact.has(key)) return true;
    if (key.length < FUZZY_MIN_LENGTH) return false;
    const keyFigures = figures(key);
    for (const candidate of pool) {
      if (candidate.length < FUZZY_MIN_LENGTH) continue;
      // 长度差太多的直接跳过，避免大题库里每条都比一遍二元组
      if (Math.abs(candidate.length - key.length) > Math.max(16, key.length * 0.4)) continue;
      if (figuresConflict(keyFigures, figures(candidate))) continue;
      if (similarity(key, candidate) >= DUP_SIMILARITY) return true;
    }
    return false;
  };

  const fresh = [];
  for (const question of collected) {
    const key = normalize(question?.content || question?.contentHtml || question?.content_html || '');
    if (!key || isDuplicate(key)) continue;
    exact.add(key);
    pool.push(key);
    fresh.push(question);
  }

  if (!fresh.length) {
    return {
      questions: 0,
      paperId: null,
      ...sourceMeta(),
      note: '这批段落里的题目题库里都有了，没有新增',
      scanned: done,
      total: chunks.length,
      partial: budgetHit,
      duplicate: true,
    };
  }

  // 补充资料没有教材插图可挂，出处以「资料名 + 页码」写进材料区
  const escapeSource = (value) => String(value || '').replace(/[&<>"]/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[ch]));
  const withSourceLabel = (question) => {
    if (question.__fromTextbook) return question;
    const name = String(question.__sourceName || '').trim() || '补充资料';
    const page = Number(question.__sourcePage) || 0;
    const label = `出处：《${name}》${page ? `第 ${page} 页` : ''}`;
    const existingHtml = String(question.material_html || question.materialHtml || '').trim();
    const existingText = String(question.material || '').trim();
    const parts = [`<p>${escapeSource(label)}</p>`];
    if (existingHtml) parts.push(existingHtml);
    else if (existingText) parts.push(`<p>${escapeSource(existingText).replace(/\n/g, '<br />')}</p>`);
    const materialHtml = parts.join('\n');
    return { ...question, material_html: materialHtml, materialHtml };
  };

  // 题干里提到「图 X-Y」时挂上精确裁出的插图；没裁到就退回该页整页扫描图。
  // 图片走 openexam-asset:// 协议，写进 material_html，看题时显示在「材料」区。
  // 补充资料没有教材页图，不参与挂图，避免按相同页码挂到教材插图上。
  let toImport = hasPrimary ? fresh : fresh.map(withSourceLabel);
  let figureStats = { attached: 0, fallback: 0 };
  if (hasPrimary) {
    try {
      const textbookFigures = require('./textbookFigures.js');
      const enriched = textbookFigures.attachFiguresToQuestions(subjectId, fresh);
      toImport = enriched.questions;
      figureStats = { attached: enriched.attached, fallback: enriched.fallback };
    } catch (error) {
      console.warn('[Subjects] 题目配图失败（不影响入库）:', error?.message || error);
    }
  }

  // 一本书只保留一卷「教材例题习题」，重复解析往同一卷里追加，而不是每次都新建；
  // 按章节提取时，允许显式指定要追加的试卷（同一章分页补录）。
  // 无主教材时新建/追加独立的「资料例题习题」卷。
  const existingPaper = String(appendPaperId || '').trim()
    ? { id: String(appendPaperId).trim() }
    : (hasPrimary ? database.getSubjectTextbookPaper?.(subjectId) : null);
  let paperId = existingPaper?.id || null;
  let paperTotal = 0;
  if (paperId) {
    const appended = database.appendImportedQuestions(paperId, toImport);
    paperTotal = Number(appended?.questionCount) || 0;
  } else {
    const created = database.importPaper(
      {
        title: String(title || '').trim().slice(0, 80) || `${subject.name} · ${hasPrimary ? '教材例题习题' : '资料例题习题'}`,
        subject: 'custom',
        subjectId: subject.id,
        type: 'imported',
      },
      toImport,
    );
    paperId = created?.paperId || null;
    paperTotal = Number(created?.questionCount) || fresh.length;
  }

  return {
    questions: fresh.length,
    paperId,
    paperTotal,
    appended: Boolean(existingPaper?.id),
    figures: figureStats,
    scanned: done,
    total: chunks.length,
    partial: budgetHit,
    duplicateSkipped: collected.length - fresh.length,
    ...sourceMeta(),
  };
}

module.exports = {
  saveTranscription,
  saveTextbookPage,
  getTextbookProgress,
  markTextbookFailed,
  resetTextbook,
  generateKnowledgeInventory,
  generateTextbookQuestions,
  splitTextbookChunks,
  hasExerciseMarker,
};
