/**
 * AI 助教 Agent（主进程）
 *
 * 职责：
 * 1. 维护唯一一份「助教」人设与动作协议（模型路由由 aiChat.js 统一决定）。
 * 2. 把本地学习数据（今日待办、练习统计、错题量、题库量）拼成上下文快照，
 *    让助教能基于真实数据调整计划，而不是凭空建议。
 * 3. 约定「动作协议」：模型想写库 / 改计划时，在回复末尾输出一个 <action> JSON 块，
 *    由渲染层解析成待确认卡片，用户点确认后才真正落库。
 *
 * 这里不做任何写库动作，写操作统一由渲染层调用既有 preload 接口执行，
 * 保证「模型建议 → 用户确认 → 落库」这条链路里始终有用户的一票。
 */

const { buildSubjectSkillBlock } = require('../shared/goodLearningSkill.js');
const { MATH_STYLE_PROMPT, normalizeMath } = require('../shared/mathStyle.js');

// 模型忘了写 </action> 也要能救回来：闭合标签缺失时按「到文末」处理
const ACTION_BLOCK_PATTERN = /<action>([\s\S]*?)(?:<\/action>|$)/i;

const ACTION_TYPES = ['import_questions', 'add_wrong_questions', 'adjust_plan', 'write_notes', 'edit_note', 'update_subject_profile', 'add_subject', 'generate_inventory', 'import_textbook_questions', 'classify_questions'];

const TODO_KINDS = ['vocab', 'essay', 'drill', 'note', 'custom'];

// 模型经常把 subjectId 写成「当前科目」这类占位词：只接受真实 id，交给渲染层回退到当前绑定科目
const SUBJECT_ID_PATTERN = /^subj_[a-z0-9]+$/i;
const PAPER_ID_PATTERN = /^paper_[a-z0-9_]+$/i;

function subjectIdOrEmpty(value) {
  const id = String(value || '').trim();
  return SUBJECT_ID_PATTERN.test(id) ? id : '';
}

const QUESTION_TYPES = ['single', 'multiple', 'judge', 'fill', 'subjective'];

const ASSISTANT_SYSTEM_PROMPT = `你是学习平台里的「AI 助教」。你坐在用户左侧，全程陪着用户学习和备考。

## 你的定位
你既是答疑老师，也是帮用户把学习落地的助教 —— 用户不需要切换模式，同一段对话里既能讲题，也能在确认后执行动作：
- 答疑讲解（用户要讲解时）：定位用户卡住的步骤，讲清概念、条件、易错点，必要时给完整例题与变式；同一道题的连续追问要接着上下文讲，不要重新问一遍题目
- 科目管理：用户在「科目」页创建学习科目（可设考试日期、上传教材），你按 Good Learning 方法论陪跑
- 录入题库：用户给你题目原文、拍的照片、或让你从教材 / 补充资料里整理题目
- 录入错题：用户做错的题、不会的题，让你帮他收进错题本
- 调整计划：根据真实学习进度，改当天/本周的任务量与安排
- 写笔记：知识清单、学习计划、每日学习笔记，经用户确认后写入笔记库（自动同步 Obsidian）
- 日常陪跑：回答学习安排类问题、复盘进度；只有用户明确要安排或复盘时才给下一步建议，用户只要知识点总结时不要附加建议

## 行为准则
1. 用中文回答，简洁、具体、可执行。不要写「建议你加强练习」这种空话，要给出「今天做 30 道资料分析里的增长率专项」这种能马上做的动作；但只在用户要安排或复盘时给动作，不要为了显得周到而附加用户没要的内容。
2. 你能看到用户当前的学习数据（今日待办、练习量、正确率、错题数、题库存量、连续打卡天数），所有计划建议都要基于这些真实数字，不要编造。
3. 用户给你图片时，你会自动收到图片内容。图片里的题目要逐题读出来再录入，读不清的地方要明说「这题看不清」，不要猜。
4. 不要重复罗列用户已经告诉你的信息，直接给结论；需要落库或调整计划时再给动作。
5. 绑定了科目的对话里，遵守下文的 Good Learning 方法论；科目教材已解析但你还不知道用户基础和可用时间时，第一件事是简短地问清这两项，拿到答复再生成计划。方法论只用于知识清单、学习计划、每日学习与整科教学，用户只要某个知识点的总结时不要套用每日学习结构与收尾建议。
6. 先判断这一轮用户要什么，再决定输出形态：只要知识点总结时，只输出该知识点本身，不追加拓展、延伸阅读、相关知识点、例题练习、学习建议、下一步安排或鼓励语；要讲解时讲透，要整理时保持原意，要提问时只提问。不要把所有回答都写成一套固定格式。

## 动作协议
当你判断需要落库或改计划时，在回复的最后单独输出一个 <action> 块，里面放一个 JSON 对象。
除了这个块，正文里不要出现任何 JSON。

### 1. 录入题库
{
  "type": "import_questions",
  "title": "试卷名称",
  "subject": "xingce",
  "appendToPaperId": "",
  "questions": [
    {
      "type": "single",
      "content": "题干",
      "options": [{ "key": "A", "content": "选项内容" }],
      "answer": "A",
      "analysis": "解析，可留空",
      "category": "xingce",
      "difficulty": 3
    }
  ]
}
- type 只能是 single / multiple / judge / fill / subjective
- options 的 key 从 A 开始；主观题和填空题可以不写 options
- answer 写选项字母（多选写 "AB"）；主观题写参考答案
- 继续往已有试卷里加题时，把 appendToPaperId 设成那份试卷的 id（见「当前学习数据」里的试卷清单），
  并把 title 写成那份试卷的名字，这样不会多出一份重复试卷

### 2. 录入错题
{
  "type": "add_wrong_questions",
  "questions": [
    {
      "type": "single",
      "content": "题干",
      "options": [{ "key": "A", "content": "选项内容" }],
      "answer": "B",
      "userAnswer": "A",
      "analysis": "为什么错、正确思路是什么",
      "reason": "一句话错因，如「概念混淆」"
    }
  ]
}

### 3. 调整计划
{
  "type": "adjust_plan",
  "ops": [
    { "op": "add", "title": "任务名", "kind": "drill", "target": { "unit": "count", "value": 30 }, "date": "2026-11-07" },
    { "op": "update", "id": "待办 id", "title": "新任务名", "target": { "unit": "count", "value": 40 } },
    { "op": "delete", "id": "待办 id" }
  ]
}
- op 为 add / update / delete
- kind 只能是 vocab（背词）/ essay（申论主观题）/ drill（刷题）/ note（笔记）/ custom（其它）
- update 和 delete 必须带 id，id 来自上下文里的待办清单
- 只输出真正要改的条目，不要把没动的任务也写进来

### 4. 写笔记
{
  "type": "write_notes",
  "subjectId": "当前科目 id，可省略",
  "notes": [
    { "kind": "summary", "title": "笔记标题", "content": "Markdown 正文" }
  ]
}
- kind 只能是 knowledge（知识清单）/ plan（学习计划）/ daily（每日学习）/ summary（阶段总结）
- content 只写用户本轮要求的内容范围。用户只要知识点总结时，只写该知识点的总结，不要写成每日学习、学习计划或知识清单，也不要附加拓展、延伸阅读、学习建议、下一步安排或鼓励语
- 不要为了凑长度补充用户没问的知识；资料没覆盖的部分直接不写
- 单篇 content 控制在 4000 字以内；内容更长就拆成多篇，不要写超长单篇（会被输出上限截断）
- 整本科目的知识清单不要用这个动作手写，改用下面的 generate_inventory

### 5. 修改已有笔记
{
  "type": "edit_note",
  "noteId": "候选清单里的笔记 id，能确定时优先填",
  "titleQuery": "不确定 id 时填笔记标题或关键词",
  "subjectId": "当前科目 id，可省略",
  "operation": "replace_section | append_after_section | replace_text | append_to_note",
  "section": "要改的小节标题（前两种操作必填）",
  "find": "replace_text 时要被替换的原文片段，必须与原文完全一致且只出现一次",
  "content": "新内容（Markdown）"
}
- 只有用户明确要修改已有笔记时才用这个动作；新建笔记仍用 write_notes
- noteId 只能来自下文「用户的笔记」清单；不确定是哪一篇时，先在正文里问用户选哪一篇，不要猜
- replace_section：只写这一节的正文，不要带小节标题；这一节以外的段落由系统原样保留
- append_after_section：把 content 插在这一节末尾、下一节标题之前
- replace_text：用于「把这段重写」；find 必须从笔记原文里原样复制，找不到或多处命中时系统会让用户确认
- 不要在 content 里输出整篇笔记；用户要整篇重写时先用正文确认，不要自己决定
- 找不到小节或原文片段时，先问用户，不要改用整篇重写

### 6. 生成 / 修改知识清单
{
  "type": "generate_inventory",
  "subjectId": "当前科目 id",
  "startChapter": "可选：从哪一章开始，章节号或标题关键字，如 13 或 同步电机",
  "learnedChapters": ["可选：已经学过的章节，章节号或标题关键字"],
  "source": "可选：primary（主教材）/ material（指定补充资料）/ auto（默认）",
  "materialId": "可选：source=material 时填补充资料 id",
  "fromPage": 230,
  "toPage": 367,
  "modules": [{ "title": "自定义知识模块名", "fromPage": 1, "toPage": 20 }],
  "keepExisting": true,
  "forceRerun": false,
  "concurrency": 2
}
- 系统按章节结构逐章、逐页分批并发调用模型，只重写本次涉及的章节，其余章节保留原文；已完成章节会落盘缓存，重跑时自动跳过，forceRerun=true 可强制重跑；写入前保留旧版快照
- 用户说“前面几章已经学过 / 从第 N 章开始 / 只看某某资料 / 按这个模块列表”时，把对应字段填上；不填则整科主教材
- 用了这个动作，正文里只要说明正在生成即可，不要把清单全文再抄一遍；最终条目数、批次数以系统返回为准，不要自己编造

### 7. 从资料导入例题 / 习题
{
  "type": "import_textbook_questions",
  "subjectId": "当前科目 id",
  "title": "试卷名称，如：自动控制原理 · 第 2 章 例题与习题",
  "fromPage": 17,
  "toPage": 83,
  "materialIds": ["指定从哪些补充资料提取时填，省略则全部已就绪资料"],
  "appendToPaperId": "要把题目补录进已有试卷时填它的 id（见当前学习数据的试卷清单），否则省略"
}
- 用户要「把教材第 N 章的例题 / 习题导入题库」或「把补充资料里的题摘进题库」时使用，由系统逐段识别原文，不要自己手写题目 JSON
- 有主教材时系统优先用主教材；没有主教材时会从全部已就绪的补充资料里提取，没有指定资料时不用填 materialIds
- 页码参照知识清单里该章标注的页码范围；没有主教材时 fromPage/toPage 指补充资料自己的页码；不确定就省略，按整份资料提取
- 同一章分批补录时带上 appendToPaperId，避免多出一份重复试卷
- 结果里若提示缺页（未转出文字的页码），要在正文里如实告诉用户，不要根据缺失页面编题

### 8. 按知识图谱分类题目
{
  "type": "classify_questions",
  "subjectId": "当前科目 id",
  "onlyMissing": false
}
- 用户要「把题库按章节 / 知识点归类」「按知识图谱整理题目」「重新分类这门科目的题」时使用
- 分类由系统读取该科目教材解析出的知识清单（子类别 → 章节 → 知识点）后逐题完成，你不需要在动作里输出题目
- 只有该科目已有教材 / 知识清单时才能分类；教材没上传或没解析完，就先在正文里告诉用户去「科目」页上传教材，不要输出这个动作
- 默认重新分类该科目下全部题目；用户明确说「只补缺失的分类」时把 onlyMissing 设为 true
- 不要自己在正文里编造章节名或知识点，也不要把分类结果抄一遍

一次最多输出一个 <action> 块。需要多步操作时，先完成一步，让用户确认后再继续。
不确定用户是否真的想执行时，用正文问一句，不要输出 <action> 块。

## 数学公式（写笔记、录题、写解析时一律遵守）
${MATH_STYLE_PROMPT}`;

/* ------------------------------------------------------------------ 上下文 */

function todayStr(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function safeCall(fn, fallback) {
  try {
    const value = fn();
    return value === undefined || value === null ? fallback : value;
  } catch (error) {
    console.warn('[Assistant] 上下文采集失败:', error?.message || error);
    return fallback;
  }
}

/**
 * 采集本地学习数据，压缩成一段可以直接喂给模型的文本。
 * 单项失败不影响整体：某一类数据拿不到就少一段，不让助教整个不可用。
 */
function buildContextSnapshot(database) {
  const date = todayStr();

  const daily = safeCall(() => database.getDailyTodos(date), null);
  const todayStats = safeCall(() => database.getTodayStats(), null);
  const streak = safeCall(() => database.getStreakDays(), 0);
  const papers = safeCall(() => database.getPapers(), []);
  const wrong = safeCall(() => database.getWrongQuestions({}), []);
  const templates = safeCall(() => database.getTodoTemplates(), []);

  const paperList = Array.isArray(papers) ? papers : [];
  const wrongList = Array.isArray(wrong) ? wrong : [];

  const questionCount = paperList.reduce((sum, paper) => sum + (Number(paper.question_count) || 0), 0);
  const dueWrong = wrongList.filter((item) => {
    const next = item.next_review_at || item.added_at;
    if (!next) return true;
    return String(next).replace('T', ' ').slice(0, 16) <= `${date} 23:59`;
  }).length;

  const todos = (daily?.items || []).map((item) => ({
    id: item.id,
    title: item.title,
    kind: item.kind,
    target: item.target,
    progress: item.progress,
    status: item.status,
  }));

  const overdue = (daily?.overdue || []).map((item) => ({
    id: item.id,
    date: item.date,
    title: item.title,
  }));

  return {
    date,
    todos,
    overdue,
    papers: paperList.slice(0, 20).map((paper) => ({
      id: paper.id,
      title: paper.title,
      questionCount: Number(paper.question_count) || 0,
    })),
    templates: (templates || []).map((item) => ({
      id: item.id,
      title: item.title,
      kind: item.kind,
      target: item.target,
      enabled: item.enabled,
    })),
    todayStats: {
      answered: todayStats?.total || 0,
      correct: todayStats?.correct || 0,
      minutes: todayStats?.duration || 0,
      sessions: todayStats?.sessions || 0,
    },
    streak: Number(streak) || 0,
    paperCount: paperList.length,
    questionCount,
    wrongCount: wrongList.length,
    dueWrongCount: dueWrong,
  };
}

function formatContext(context = {}) {
  const lines = [];
  lines.push(`今天是 ${context.date}。`);

  const stats = context.todayStats || {};
  const accuracy = stats.answered > 0 ? Math.round((stats.correct / stats.answered) * 100) : 0;
  lines.push(
    `今日已练 ${stats.answered || 0} 题，正确 ${stats.correct || 0} 题（正确率 ${accuracy}%），`
    + `用时 ${stats.minutes || 0} 分钟，连续打卡 ${context.streak || 0} 天。`
  );
  lines.push(
    `题库：${context.paperCount || 0} 份试卷 / ${context.questionCount || 0} 道题；`
    + `错题本 ${context.wrongCount || 0} 题，其中 ${context.dueWrongCount || 0} 题到期待复习。`
  );

  const todos = context.todos || [];
  if (todos.length) {
    lines.push('今日待办：');
    todos.forEach((item) => {
      const target = Number(item.target?.value) || 0;
      lines.push(`- [${item.id}] ${item.title}｜类型 ${item.kind}｜目标 ${target}｜进度 ${item.progress || 0}｜状态 ${item.status}`);
    });
  } else {
    lines.push('今日待办：暂时没有安排。');
  }

  const overdue = context.overdue || [];
  if (overdue.length) {
    lines.push('逾期未完成：');
    overdue.slice(0, 8).forEach((item) => lines.push(`- [${item.id}] ${item.date} ${item.title}`));
  }

  const templates = context.templates || [];
  if (templates.length) {
    lines.push('常驻计划模板（每天自动生成，可用于长期安排）：');
    templates.forEach((item) => {
      lines.push(`- [${item.id}] ${item.title}｜类型 ${item.kind}｜目标 ${Number(item.target?.value) || 0}${item.enabled ? '' : '｜已停用'}`);
    });
  }

  const papers = context.papers || [];
  if (papers.length) {
    lines.push('已有试卷（继续录入同一份试卷时，把 appendToPaperId 设成对应 id）：');
    papers.forEach((item) => {
      lines.push(`- [${item.id}] ${item.title}｜${item.questionCount} 题`);
    });
  }

  return lines.join('\n');
}

function buildSystemPrompt(context, subjectBlock = '') {
  return `${ASSISTANT_SYSTEM_PROMPT}\n\n## 当前学习数据（只读，用于判断，不确定就基于它给建议）\n${formatContext(context)}${subjectBlock}`;
}

/* ------------------------------------------------------------ 笔记候选上下文 */

const NOTE_INTENT_RE = /(笔记|知识清单|学习计划|复盘|改写|重写|修改|追加|补充|更新|删掉|删除)/;
const NOTE_BLOCK_LIMIT = 4200;

function messageText(message) {
  const raw = message?.content ?? message?.text;
  if (typeof raw === 'string') return raw;
  if (!Array.isArray(raw)) return '';
  return raw.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('\n');
}

function lastUserText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.role === 'user' || list[index]?.type === 'user') {
      return messageText(list[index]);
    }
  }
  return '';
}

function bigramsOf(text) {
  const source = String(text || '').replace(/\s+/g, '').toLowerCase();
  const set = new Set();
  for (let index = 0; index < source.length - 1; index += 1) {
    set.add(source.slice(index, index + 2));
  }
  return set;
}

function quotedKeywords(text) {
  const list = [];
  const source = String(text || '');
  for (const match of source.matchAll(/[「《“"'【]([^」》”"'】]{2,40})[」》”"'】]/g)) {
    const value = match[1].trim();
    if (value) list.push(value);
  }
  const anchor = source.match(/([\u4e00-\u9fa5A-Za-z0-9·—\-]{2,24})(?:的)?(?:笔记|知识清单)/);
  if (anchor) list.push(anchor[1]);
  return [...new Set(list)];
}

function scoreNote(note, userText, keywords, subjectId) {
  const title = String(note.title || '').toLowerCase();
  const source = String(userText || '').toLowerCase();
  let score = 0;
  if (subjectId && note.subjectId === subjectId) score += 3;
  for (const keyword of keywords) {
    const value = String(keyword || '').toLowerCase();
    if (!value) continue;
    if (title === value) score += 20;
    else if (title.includes(value)) score += 10;
    else if (source.includes(value)) score += 5;
  }
  const titleGrams = bigramsOf(title);
  for (const gram of titleGrams) {
    if (source.includes(gram)) score += 1;
  }
  return score;
}

function noteSections(content) {
  const lines = String(content || '').split('\n');
  return lines
    .map((line, index) => {
      const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
      return match ? { title: match[2].trim(), level: match[1].length, line: index } : null;
    })
    .filter(Boolean);
}

function relevantSectionText(content, keywords) {
  const text = String(content || '');
  if (!text.trim()) return '';
  const sections = noteSections(text);
  const lines = text.split('\n');
  for (const keyword of keywords) {
    const value = String(keyword || '').toLowerCase();
    if (!value) continue;
    const hit = sections.findIndex((section) => {
      const title = section.title.toLowerCase();
      return title.includes(value) || value.includes(title);
    });
    if (hit < 0) continue;
    const start = sections[hit].line;
    const end = sections.slice(hit + 1).find((section) => section.level <= sections[hit].level)?.line ?? lines.length;
    return lines.slice(start, end).join('\n').slice(0, 1800);
  }
  return text.slice(0, 1200);
}

/**
 * 把「用户可能想改哪篇笔记」压缩成上下文：
 * - 先给最近更新的笔记清单（id / 标题 / 科目 / 更新时间 / 字数）
 * - 再按用户这轮的原话打分，给匹配候选
 * - 只对最可能的一篇附小节标题和相关原文，避免把整库笔记塞进提示词
 */
function buildNotesContext(database, { subjectId, messages } = {}) {
  const userText = lastUserText(messages);
  if (!userText || !NOTE_INTENT_RE.test(userText)) return '';

  let briefs = [];
  try {
    if (typeof database.listNoteBriefs === 'function') {
      briefs = database.listNoteBriefs({ subjectId: subjectId || undefined, limit: 80 });
      if (subjectId) {
        const all = database.listNoteBriefs({ limit: 80 });
        const seen = new Set(briefs.map((item) => item.id));
        briefs = [...briefs, ...all.filter((item) => !seen.has(item.id))];
      }
    } else {
      const result = database.getNotes({ subjectId: subjectId || undefined, limit: 80 });
      briefs = (result?.items || []).map((note) => ({
        id: note.id,
        title: note.title,
        subjectId: note.subjectId,
        updatedAt: note.updatedAt,
        chars: [...String(note.content || '')].length,
        preview: String(note.content || '').slice(0, 80),
        content: note.content,
      }));
    }
  } catch (error) {
    console.warn('[Assistant] 读取笔记候选失败:', error?.message || error);
    return '';
  }
  if (!briefs.length) return '';

  const keywords = quotedKeywords(userText);
  const scored = briefs
    .map((note) => ({ note, score: scoreNote(note, userText, keywords, subjectId) }))
    .sort((a, b) => b.score - a.score || String(b.note.updatedAt || '').localeCompare(String(a.note.updatedAt || '')));
  const matches = scored.filter((item) => item.score > 0).slice(0, 6);
  const targets = (matches.length ? matches : scored.slice(0, 4)).map((item) => item.note);

  const lines = [
    '## 用户的笔记（只读；用户要改已有笔记时使用 edit_note）',
    '修改规则：',
    '- noteId 只能从下面清单里选；标题或关键词命中多篇时，先在正文里问用户选哪一篇，不要猜。',
    '- 只改用户点名的小节或原文片段，未涉及的段落由系统原样保留；不要在动作里输出整篇笔记。',
    '- 找不到小节或原文片段时，先问用户，不要整篇重写。',
  ];
  if (matches.length) {
    lines.push('', '匹配到的候选（这轮更可能在说这些）：');
    for (const item of matches) {
      const note = item.note;
      lines.push(`- [${note.id}] 《${note.title}》｜科目：${noteSubjectName(note)}｜更新：${formatNoteTime(note.updatedAt)}｜${note.chars || 0} 字`);
    }
  }
  lines.push('', '最近更新的笔记：');
  for (const note of briefs.slice(0, 8)) {
    lines.push(`- [${note.id}] 《${note.title}》｜科目：${noteSubjectName(note)}｜更新：${formatNoteTime(note.updatedAt)}｜${note.chars || 0} 字`);
  }

  const primary = targets[0];
  if (primary) {
    let content = primary.content;
    if (content === undefined) {
      try {
        content = database.getNote(primary.id)?.content || '';
      } catch {
        content = '';
      }
    }
    const sections = noteSections(content);
    if (sections.length) {
      lines.push('', `最可能的目标笔记《${primary.title}》的小节：`);
      for (const section of sections.slice(0, 40)) {
        lines.push(`- ${'#'.repeat(section.level)} ${section.title}`);
      }
    }
    const excerpt = relevantSectionText(content, keywords);
    if (excerpt.trim()) {
      lines.push('', `《${primary.title}》相关原文节选（只用于定位要改的段落）：`, '```markdown', excerpt, '```');
    }
  }

  const text = lines.join('\n');
  return text.length > NOTE_BLOCK_LIMIT ? `${text.slice(0, NOTE_BLOCK_LIMIT)}\n…（笔记候选已截断）` : text;
}

function noteSubjectName(note) {
  try {
    if (!note?.subjectId) return '未绑定科目';
    return require('./subjectManager.js').getSubject(note.subjectId)?.name || '未知科目';
  } catch {
    return '未知科目';
  }
}

function formatNoteTime(value) {
  const text = String(value || '').replace('T', ' ');
  return text.slice(0, 16) || '未知';
}

/* ------------------------------------------------------------------ 动作解析 */

function stripActionBlock(text) {
  const source = String(text || '');
  const match = source.match(ACTION_BLOCK_PATTERN);
  if (!match) return source.trim();
  return source.slice(0, match.index).trim();
}

/** 宽松 JSON 解析：模型偶尔会在 JSON 前后带 ``` 或多余逗号 */
function parseLooseJSON(raw) {
  const text = String(raw || '').trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(text.slice(first, last + 1));
      } catch (_) {
        return null;
      }
    }
    return null;
  }
}

/** 动作里的正文统一走公式规范，避免坏 LaTeX 直接落库再镜像进 Obsidian */
function mathText(value) {
  return normalizeMath(String(value ?? '')).text;
}

function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options
    .map((option, index) => {
      if (typeof option === 'string') {
        return { key: String.fromCharCode(65 + index), content: mathText(option) };
      }
      if (!option || typeof option !== 'object') return null;
      const key = String(option.key || option.label || option.id || String.fromCharCode(65 + index)).trim();
      const content = mathText(option.content ?? option.text ?? option.value ?? '').trim();
      if (!content) return null;
      return { key: key.toUpperCase(), content };
    })
    .filter(Boolean);
}

function normalizeQuestionType(type) {
  const value = String(type || '').trim().toLowerCase();
  if (QUESTION_TYPES.includes(value)) return value;
  if (['填空', '填空题', 'blank'].includes(value)) return 'fill';
  if (['主观', '主观题', '简答', '论述', 'essay'].includes(value)) return 'subjective';
  if (['多选', '不定项'].includes(value)) return 'multiple';
  if (['判断', '判断题'].includes(value)) return 'judge';
  return 'single';
}

/** 把模型给的题目统一成写库要的形状，字段缺失的用空值兜底 */
function normalizeQuestionItem(item = {}) {
  const content = String(item.content ?? item.question ?? item.stem ?? '').trim();
  if (!content) return null;
  return {
    type: normalizeQuestionType(item.type),
    content: mathText(content),
    options: normalizeOptions(item.options),
    answer: mathText(item.answer ?? item.correctAnswer ?? item.correct_answer ?? '').trim(),
    analysis: mathText(item.analysis ?? item.explanation ?? '').trim(),
    category: String(item.category || '').trim(),
    subCategory: String(item.subCategory || item.sub_category || '').trim(),
    difficulty: Math.max(1, Math.min(5, Number(item.difficulty) || 3)),
  };
}

function normalizeAction(action) {
  if (!action || typeof action !== 'object') return null;
  const type = String(action.type || '').trim();
  if (!ACTION_TYPES.includes(type)) return null;

  if (type === 'import_questions') {
    const questions = (Array.isArray(action.questions) ? action.questions : [])
      .map((item) => normalizeQuestionItem(item))
      .filter(Boolean);
    if (!questions.length) return null;
    return {
      type,
      title: String(action.title || '').trim() || `助教录入 · ${todayStr()}`,
      subject: String(action.subject || 'xingce').trim() || 'xingce',
      // 指定了已有试卷就往那份试卷里追加，而不是新建一份
      appendToPaperId: String(action.appendToPaperId || '').trim(),
      questions,
    };
  }

  if (type === 'add_wrong_questions') {
    const questions = (Array.isArray(action.questions) ? action.questions : [])
      .map((item) => {
        const base = normalizeQuestionItem(item);
        if (!base) return null;
        return {
          ...base,
          userAnswer: mathText(item.userAnswer ?? item.user_answer ?? '').trim(),
          reason: mathText(item.reason ?? item.wrongReason ?? '').trim().slice(0, 240),
        };
      })
      .filter(Boolean);
    if (!questions.length) return null;
    return { type, questions };
  }

  const ops = (Array.isArray(action.ops) ? action.ops : [])
    .map((op) => {
      if (!op || typeof op !== 'object') return null;
      const kind = String(op.op || '').trim().toLowerCase();
      if (!['add', 'update', 'delete'].includes(kind)) return null;
      const title = String(op.title || '').trim();
      if (kind !== 'delete' && !title) return null;
      if (kind !== 'add' && !String(op.id || '').trim()) return null;
      const target = op.target && typeof op.target === 'object'
        ? { unit: 'count', value: Math.max(1, Number(op.target.value) || 1) }
        : null;
      return {
        op: kind,
        id: String(op.id || '').trim(),
        title,
        kind: TODO_KINDS.includes(String(op.kind || '')) ? String(op.kind) : 'custom',
        target,
        date: String(op.date || '').trim(),
        progress: Number.isFinite(Number(op.progress)) ? Number(op.progress) : null,
        status: String(op.status || '').trim(),
      };
    })
    .filter(Boolean);
  if (!ops.length) return null;
  return { type, ops };
}

/** 写笔记：知识清单 / 学习计划 / 每日学习 / 总结，落笔记库并同步 Obsidian */
function normalizeWriteNotesAction(action) {
  const notes = (Array.isArray(action.notes) ? action.notes : [])
    .map((note) => {
      if (!note || typeof note !== 'object') return null;
      const title = String(note.title || '').trim();
      const content = mathText(note.content || '').trim();
      if (!title || content.length < 30) return null;
      const kind = ['knowledge', 'plan', 'daily', 'summary'].includes(String(note.kind || ''))
        ? String(note.kind)
        : 'summary';
      return { kind, title, content };
    })
    .filter(Boolean);
  if (!notes.length) return null;
  return { type: 'write_notes', subjectId: subjectIdOrEmpty(action.subjectId), notes };
}

/** 修改已有笔记：只做局部操作，定位信息优先 noteId，其次标题关键词 */
const NOTE_OPERATIONS = ['replace_section', 'append_after_section', 'replace_text', 'append_to_note', 'replace_whole'];

function normalizeEditNoteAction(action) {
  const noteId = String(action?.noteId || '').trim().slice(0, 80);
  const titleQuery = String(action?.titleQuery || '').trim().slice(0, 80);
  if (!noteId && !titleQuery) return null;
  const operation = NOTE_OPERATIONS.includes(String(action?.operation || '').trim())
    ? String(action.operation).trim()
    : 'replace_section';
  const content = mathText(action?.content ?? '').trim();
  if (!content) return null;
  return {
    type: 'edit_note',
    noteId,
    titleQuery,
    subjectId: subjectIdOrEmpty(action?.subjectId),
    operation,
    section: String(action?.section || '').trim().slice(0, 120),
    // find 必须和原文逐字一致，这里不做公式规范化
    find: String(action?.find ?? '').slice(0, 2000),
    content,
    wholeNote: action?.wholeNote === true || operation === 'replace_whole',
  };
}

/** 生成整科知识清单：交给本地解析管线，避免模型手写上万字被输出上限截断 */
function normalizeInventoryAction(action) {
  return { type: 'generate_inventory', subjectId: subjectIdOrEmpty(action?.subjectId) };
}

/** 从教材/补充资料提取例题 / 习题：页码可选，交给主进程逐段识别，不让模型手写题目 JSON */
function normalizeTextbookQuestionsAction(action) {
  const from = Math.max(0, Math.round(Number(action?.fromPage) || 0));
  const to = Math.max(0, Math.round(Number(action?.toPage) || 0));
  const pages = from || to ? { from: from || undefined, to: to || undefined } : null;
  const paperId = String(action?.appendToPaperId || '').trim();
  const materialIds = (Array.isArray(action?.materialIds) ? action.materialIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean)
    .slice(0, 20);
  return {
    type: 'import_textbook_questions',
    subjectId: subjectIdOrEmpty(action?.subjectId),
    title: String(action?.title || '').trim().slice(0, 80),
    pages,
    paperId: PAPER_ID_PATTERN.test(paperId) ? paperId : '',
    materialIds,
  };
}

/** 按知识图谱分类：整科重跑或只补缺失，由系统按教材目录逐题归类 */
function normalizeClassifyQuestionsAction(action) {
  return {
    type: 'classify_questions',
    subjectId: subjectIdOrEmpty(action?.subjectId),
    onlyMissing: Boolean(action?.onlyMissing),
  };
}

/** 起点诊断存档：学习基础 / 每天可用时间 / 偏好 */
function normalizeProfileAction(action) {
  const profile = action.profile && typeof action.profile === 'object' ? action.profile : null;
  if (!profile) return null;
  return {
    type: 'update_subject_profile',
    subjectId: String(action.subjectId || '').trim(),
    profile: {
      level: String(profile.level || '').slice(0, 200),
      dailyHours: Math.max(0, Math.min(16, Number(profile.dailyHours) || 0)),
      weeklyDays: Math.max(0, Math.min(7, Number(profile.weeklyDays) || 0)),
      style: String(profile.style || '').slice(0, 120),
      notes: String(profile.notes || '').slice(0, 500),
    },
  };
}

/** 建科目：用户口头提到要学新科目时，提议创建（之后引导传教材 / 设考试日期） */
function normalizeAddSubjectAction(action) {
  const name = String(action?.name || '').trim().slice(0, 40);
  if (!name) return null;
  const examDate = action.examDate ? String(action.examDate).slice(0, 10) : null;
  if (examDate && !/^\d{4}-\d{2}-\d{2}$/.test(examDate)) return null;
  return { type: 'add_subject', name, examDate };
}

/**
 * 从模型回复里拆出「正文 + 动作」。
 * 解析失败时只返回正文：动作是可选增强，解析不了不该让整轮回复失败。
 */
function parseAssistantReply(text) {
  const source = String(text || '');
  const match = source.match(ACTION_BLOCK_PATTERN);
  const reply = stripActionBlock(source);
  if (!match) return { reply, action: null, actionError: '' };

  const parsed = parseLooseJSON(match[1]);
  if (!parsed) {
    return { reply, action: null, actionError: '动作内容不是合法 JSON，已忽略' };
  }
  const type = String(parsed?.type || '').trim();
  let action = null;
  if (type === 'write_notes') action = normalizeWriteNotesAction(parsed);
  else if (type === 'edit_note') action = normalizeEditNoteAction(parsed);
  else if (type === 'classify_questions') action = normalizeClassifyQuestionsAction(parsed);
  else if (type === 'generate_inventory') action = normalizeInventoryAction(parsed);
  else if (type === 'import_textbook_questions') action = normalizeTextbookQuestionsAction(parsed);
  else if (type === 'update_subject_profile') action = normalizeProfileAction(parsed);
  else if (type === 'add_subject') action = normalizeAddSubjectAction(parsed);
  else action = normalizeAction(parsed);
  if (!action) {
    return { reply, action: null, actionError: '动作类型或字段不完整，已忽略' };
  }
  return { reply, action, actionError: '' };
}

/* ------------------------------------------------------------------ 模型路由 */

/** 把图片数组转成统一的 image 片段 */
function toImageParts(images) {
  return (Array.isArray(images) ? images : [])
    .filter((image) => image && image.base64)
    .map((image) => ({
      type: 'image',
      base64: String(image.base64).replace(/^data:[^;,]*;base64,/, ''),
      mimeType: String(image.mimeType || 'image/png'),
    }));
}

/** 这一轮对话里有没有图片：有就必须走能读图的模型 */
function hasImageMessages(messages) {
  return (Array.isArray(messages) ? messages : []).some((message) => (
    Array.isArray(message?.images) && message.images.some((image) => image?.base64)
  ));
}

/**
 * 把图片挂到对应的用户消息上。
 * 图片放在文字之后：多数模型对「先文字后图片」的顺序更稳。
 */
function attachImagesToMessages(messages, extraImages) {
  const list = (Array.isArray(messages) ? messages : []).map((message) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: message.content,
  }));

  const mergeParts = (message, parts) => {
    if (!parts.length) return;
    const base = Array.isArray(message.content)
      ? message.content.slice()
      : [{ type: 'text', text: String(message.content || '') }];
    message.content = [...base, ...parts];
  };

  // 每条消息自带的图片挂回这条消息，多轮对话里旧图片也不会丢
  (Array.isArray(messages) ? messages : []).forEach((message, index) => {
    mergeParts(list[index], toImageParts(message?.images));
  });

  // 额外传来的图片（本轮新附件）挂到最后一条用户消息
  const attachments = toImageParts(extraImages);
  if (!attachments.length) return list;

  let targetIndex = -1;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index].role === 'user') {
      targetIndex = index;
      break;
    }
  }
  if (targetIndex < 0) {
    list.push({ role: 'user', content: '' });
    targetIndex = list.length - 1;
  }
  mergeParts(list[targetIndex], attachments);
  return list;
}

module.exports = {
  ASSISTANT_SYSTEM_PROMPT,
  ACTION_TYPES,
  buildContextSnapshot,
  buildSystemPrompt,
  buildNotesContext,
  formatContext,
  attachImagesToMessages,
  hasImageMessages,
  parseAssistantReply,
  parseLooseJSON,
  stripActionBlock,
  normalizeAction,
};
