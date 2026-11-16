/**
 * 笔记 AI 助教（主进程）
 *
 * 职责：把「笔记」页里随手写下的内容读懂，规范化成可复习的 Markdown 结构，
 * 并做精细化分类（学科 / 题型 / 笔记类型 / 难度 / 掌握度 / 关键概念 / 考点）。
 *
 * 结果同时用于两处：
 *   1. 应用内：正文回写笔记、分类存进 notes.meta，卡片上显示分类标签；
 *   2. Obsidian：桥接层读 notes.meta 直接写 frontmatter，不再重复调用模型。
 *
 * 模型走应用「设置 → AI」里的配置，失败时退化为本地关键词分类（不改写正文）。
 */

const aiService = require('./ai/index.js');
const { SKILL_POINT_TREE } = require('../shared/skillPoints.js');
const { MATH_STYLE_PROMPT, normalizeMath } = require('../shared/mathStyle.js');

// database 在调用时才 require：避免模块加载顺序把 electron / better-sqlite3 提前拉进来

const NOTE_TYPES = ['方法总结', '错题复盘', '概念辨析', '公式速记', '真题精析',
  '框架梳理', '概念笔记', '例题整理', '随手记录', '通用'];
const MASTERY_LEVELS = ['刚接触', '理解中', '熟练', '待巩固', '已掌握'];

const AI_TIMEOUT_MS = 90 * 1000;

/* ------------------------------------------------------------------ 考点目录 */

let catalogCache = null;

/** 把三级考点树摊平成 [{id,label,category,...}]，并按模块分组 */
function getCatalog() {
  if (catalogCache) return catalogCache;
  const items = [];
  for (const [category, node] of Object.entries(SKILL_POINT_TREE || {})) {
    for (const [sub, subNode] of Object.entries(node?.subs || {})) {
      for (const [key, label] of subNode?.points || []) {
        items.push({
          id: `${category}.${sub}.${key}`,
          label,
          category,
          categoryLabel: node.label,
          sub,
          subLabel: subNode.label,
        });
      }
    }
  }
  catalogCache = { items, byId: new Map(items.map((item) => [item.id, item])) };
  return catalogCache;
}

/** 给模型的候选清单：`- shuliang.jisuan.gongcheng = 数量关系 / 数学运算 / 工程问题` */
function renderCatalogForPrompt() {
  const { items } = getCatalog();
  const groups = new Map();
  for (const item of items) {
    const key = `${item.categoryLabel}（${item.category}）`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(`- ${item.id} = ${item.categoryLabel} / ${item.subLabel} / ${item.label}`);
  }
  return [...groups.entries()]
    .map(([group, lines]) => `${group}\n${lines.join('\n')}`)
    .join('\n\n');
}

/* -------------------------------------------------------------------- 提示词 */

/** 行测预置科目：只有这些才走「模块 / 题型 / 考点」三级体系 */
const PRESET_CATEGORY_NAMES = new Set(['言语理解', '数量关系', '判断推理', '资料分析', '常识判断']);

/**
 * 笔记挂在自己建的科目上（自动控制原理、线性代数…）时，行测考点树完全不适用。
 * 之前不管什么笔记都强行往考点树里塞，结果《自动控制原理》的笔记被标成了
 * 「判断推理 / 图形推理 / 物理」，思维导图跟着一起错。
 */
function buildSubjectPromptSection(subjectName) {
  const name = String(subjectName || '').trim();
  if (!name || PRESET_CATEGORY_NAMES.has(name)) {
    return `可用考点清单（格式：考点 id = 模块 / 题型 / 考点）：
${renderCatalogForPrompt()}`;
  }
  return `这篇笔记属于科目「${name}」，不在行测题库的考点体系里，所以不要套用下面的考点树。

- \`knowledge_points\` 一律给空数组 \`[]\`；
- 改为在 \`knowledge_labels\` 里给 2-4 个**该科目内的知识点短标签**（例如「二阶系统」「阻尼比」「根轨迹」），按重要度从高到低排序；
- \`subject\` 填「${name}」，\`topic\` 填更细一层的主题（例如「时域分析」）；
- \`tags\` 里不要出现行测模块名（言语理解 / 数量关系 / 判断推理 / 资料分析 / 常识判断）。`;
}

function buildSystemPrompt(subjectName) {
  return `你是「OpenExam AI 助教」，负责把考生的随手笔记整理成可复习、可归档的结构化笔记。

你的任务：
1. 读懂笔记：判断它属于哪个科目 / 模块、哪个题型、哪个考点，作者到底想记住什么。
2. 规范化正文：保留作者原意和所有具体数据，只重组结构、补小标题、把口语改写成书面表达，不扩写内容。
3. 精细化分类：模块、题型、笔记类型、难度、掌握度、关键概念、标签、考点。
4. 只输出一个 JSON 对象，不要输出任何解释性文字。

硬性规则：
- 不要编造笔记里没有的结论、数据、题目。信息不足时宁可留空。
- 只整理原文已有的内容：不新增原文没有的知识点、例题、拓展、延伸阅读、背景、学习建议或鼓励语；不要用「总结」之名把笔记补成一节课，也不要为了结构完整而添加原文没问的内容。
- 正文必须用 Markdown，且只用 \`## \` 和 \`### \` 两级标题；至少有一个 \`## \` 标题。
- 正文第一个 \`## \` 标题要能概括核心内容（例如「核心概念」「解题套路」「错因分析」），
  因为思维导图会直接跳转到这个标题。
- 保留数字、单位、专有名词与题目条件，不得改写；但**所有数学表达式必须写成 LaTeX**（行内 $...$、块级 $$...$$），
  纯文本公式（如 24/7 ≈ 3.4、G(s)=ω_n²/(s²+2ζω_n s+ω_n²)）要转成规范 LaTeX，中文说明留在公式外。
- 原文里的图片引用（形如 \`![说明](openexam-asset://note-assets/...)\`）必须原样保留在正文里，
  不要删除、不要改写链接、不要把它们挪到别的小节。
- 如果原文有「例题」小节，原样保留该小节的标题和内容，不要改写题干与选项。
- knowledge_points 只能从下面给出的考点清单里选，最多 3 个，按相关度从高到低排序；
  一个都匹配不上就给空数组，不要硬凑。
- 不要输出 \`---\` 包裹的 frontmatter，不要在 JSON 之外写任何内容。

${buildSubjectPromptSection(subjectName)}

${MATH_STYLE_PROMPT}`;
}

function buildUserPrompt({ title, tags, content, subjectName }) {
  const customSubject = Boolean(subjectName) && !PRESET_CATEGORY_NAMES.has(String(subjectName).trim());
  const knowledgeLine = customSubject
    ? '  "knowledge_points": [],\n  "knowledge_labels": ["该科目内的知识点，2-4 个"],\n'
    : '  "knowledge_points": [{"id": "shuliang.jisuan.gongcheng", "note": "这篇笔记在这个考点上讲了什么，20 字以内"}],\n';
  const lines = [
    `标题（可能为空）：${title || "（无）"}`,
    `已有标签：${(tags || []).join("、") || "（无）"}`,
    subjectName ? `所属科目：${subjectName}` : "",
    "原始笔记：",
    "<<<",
    String(content || "").trim(),
    ">>>",
    "",
    "整理范围：正文只整理上面「原始笔记」里已有的内容，不要补充原文没有的知识、例题、拓展、延伸阅读或学习建议。",
    "请按下面的 JSON 结构输出：",
    `{
  "title": "不超过 24 字的标题",
  "summary": "一句话概括，不超过 50 字",
  "subject": "${customSubject ? subjectName : "模块中文名，例如 数量关系"}",
  "topic": "题型中文名，例如 数学运算",
  "note_type": "${NOTE_TYPES.join("|")}",
  "difficulty": 1,
  "mastery": "${MASTERY_LEVELS.join("|")}",
  "key_concepts": ["3-6 个关键概念"],
  "tags": ["3-6 个标签，包含模块与题型"],
${knowledgeLine}  "body": "## 核心内容\\n..."
}`,
  ];
  return lines.filter((line) => line !== "").join("\n");
}

/* ---------------------------------------------------------------- 结果规范化 */

function cleanLine(value, maxLength) {
  const text = String(value ?? "")
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function normalizeTags(raw, extra = []) {
  const list = [];
  const push = (value) => {
    const text = String(value ?? "").trim();
    if (text && !list.includes(text)) list.push(text);
  };
  if (Array.isArray(raw)) raw.forEach(push);
  else if (typeof raw === "string") raw.split(/[,，;；、\s]+/).forEach(push);
  extra.forEach(push);
  return list.slice(0, 10);
}

function normalizeBody(raw, title) {
  let body = String(raw ?? "").replace(/\r\n/g, "\n").trim();
  if (!body) return "";

  // 模型偶尔会包一层 frontmatter 或者重复 H1 标题，这里清掉
  body = body.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  body = body.replace(/^#\s+[^\n]*\n+/, "").trim();

  if (!/^##\s+/m.test(body)) {
    const heading = title ? `## ${title}` : "## 核心内容";
    body = `${heading}\n\n${body}`;
  }
  // 模型偶尔仍会输出旧定界符或 Unicode 伪公式，回写笔记前统一成 Obsidian 能渲染的 LaTeX
  const normalized = normalizeMath(body);
  if (normalized.warnings.length) {
    console.warn('[noteTutor] 公式格式提醒：', normalized.warnings.slice(0, 4).join('；'));
  }
  return `${normalized.text.trim()}\n`;
}

const IMAGE_REF_RE = /!\[[^\]]*\]\((openexam-asset:\/\/[^)\s]+)\)/g;

function imageRefs(text) {
  return [...String(text || "").matchAll(IMAGE_REF_RE)].map((match) => match[0]);
}

/** AI 重写正文时容易把图片那几行丢掉，缺失的补回「## 附图」 */
function keepImages(body, original) {
  const originals = imageRefs(original);
  if (!originals.length) return body;
  const kept = new Set(imageRefs(body));
  const missing = originals.filter((ref) => !kept.has(ref));
  if (!missing.length) return body;
  return `${String(body).replace(/\s*$/, "")}\n\n## 附图\n\n${missing.join("\n\n")}\n`;
}

function normalizePoints(raw) {
  const { byId } = getCatalog();
  const list = Array.isArray(raw) ? raw : [];
  const picked = [];
  for (const entry of list) {
    const id = typeof entry === "string" ? entry : entry?.id;
    const node = byId.get(String(id || "").trim());
    if (!node || picked.some((item) => item.id === node.id)) continue;
    picked.push({
      id: node.id,
      label: node.label,
      category: node.category,
      categoryLabel: node.categoryLabel,
      sub: node.sub,
      subLabel: node.subLabel,
      note: cleanLine(typeof entry === "object" ? entry?.note : "", 40),
    });
    if (picked.length >= 3) break;
  }
  return picked;
}

/** 把 subjectId 解析成科目名；解析不到就返回空（走行测考点树） */
function resolveSubjectName(subjectId, fallbackName) {
  const direct = String(fallbackName || '').trim();
  if (direct) return direct;
  const id = String(subjectId || '').trim();
  if (!id) return '';
  try {
    // eslint-disable-next-line global-require
    const subjects = require('./subjectManager.js').getSubjects() || [];
    return String(subjects.find((item) => String(item.id) === id)?.name || '').trim();
  } catch {
    return '';
  }
}

function normalizeResult(raw, { content, tags, subjectName }) {
  const { byId } = getCatalog();
  const points = normalizePoints(raw?.knowledge_points ?? raw?.knowledgePoints);
  const first = points[0] ? byId.get(points[0].id) : null;

  const subject = cleanLine(raw?.subject, 12) || String(subjectName || '').trim() || first?.categoryLabel || "";
  let topic = cleanLine(raw?.topic, 12) || first?.subLabel || "";
  // 模型经常把 subject / topic 填成同一个模块名，这时用考点所属题型补位，
  // 否则思维导图里会出现「资料分析 → 资料分析」这种重复层级。
  if (topic && topic === subject && first?.subLabel && first.subLabel !== subject) {
    topic = first.subLabel;
  }

  const noteType = NOTE_TYPES.includes(raw?.note_type) ? raw.note_type : "随手记录";
  const mastery = MASTERY_LEVELS.includes(raw?.mastery) ? raw.mastery : "理解中";
  const difficulty = Math.min(5, Math.max(1, Math.round(Number(raw?.difficulty) || 3)));

  const keyConcepts = (Array.isArray(raw?.key_concepts) ? raw.key_concepts : [])
    .map((item) => cleanLine(item, 12))
    .filter(Boolean)
    .slice(0, 6);

  // 自建科目走自由标签：模型给 knowledge_labels，缺了就退回关键概念
  const knowledgeLabels = (Array.isArray(raw?.knowledge_labels) ? raw.knowledge_labels : [])
    .map((item) => cleanLine(item, 12))
    .filter(Boolean)
    .slice(0, 4);

  const title = cleanLine(raw?.title, 30) || cleanLine(content, 24) || "未命名笔记";
  const body = keepImages(
    normalizeBody(raw?.body, title) || String(content || ""),
    content
  );

  return {
    title,
    summary: cleanLine(raw?.summary, 60),
    subject,
    topic,
    noteType,
    difficulty,
    mastery,
    keyConcepts,
    tags: normalizeTags(raw?.tags, [...tags, subject, topic].filter(Boolean)),
    knowledgePoints: points,
    knowledgeLabels: knowledgeLabels.length ? knowledgeLabels : keyConcepts.slice(0, 3),
    body,
  };
}

/* ---------------------------------------------------------------- 本地兜底 */

const LOCAL_ALIASES = {
  "shuliang.jisuan.gongcheng": ["工程", "合作完成", "效率"],
  "shuliang.jisuan.xingcheng": ["行程", "相遇", "追及", "速度"],
  "shuliang.jisuan.lirun": ["利润", "成本", "折扣", "售价"],
  "shuliang.jisuan.nongdu": ["浓度", "溶液", "溶质"],
  "shuliang.jisuan.pailie": ["排列", "组合", "捆绑", "插空"],
  "shuliang.jisuan.gailv": ["概率", "期望"],
  "shuliang.jisuan.rongchi": ["容斥", "两集合", "三集合"],
  "yanyu.xuanci.chengyu": ["成语", "成语辨析"],
  "yanyu.xuanci.shici": ["实词", "词语辨析"],
  "panduan.luoji.jiaqiang": ["加强", "削弱", "论证"],
  "ziliao.jisuan.zengzhang": ["增长率", "增长量", "同比"],
  "ziliao.jisuan.bizhong": ["比重", "占比"],
  "ziliao.jisuan.pingjun": ["平均数", "均值"],
  "changshi.renwen.lishi": ["历史", "朝代"],
};

/** 模型不可用时的兜底：只做分类，不改写正文 */
function localAnalyze({ content, tags }) {
  const text = String(content || "");
  const { items, byId } = getCatalog();
  const scored = [];

  for (const item of items) {
    let score = 0;
    if (item.label && text.includes(item.label)) score += 6;
    for (const word of LOCAL_ALIASES[item.id] || []) {
      if (word && text.includes(word)) score += 3;
    }
    if (score > 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const points = scored.slice(0, 3).map(({ item }) => ({
    id: item.id,
    label: item.label,
    category: item.category,
    categoryLabel: item.categoryLabel,
    sub: item.sub,
    subLabel: item.subLabel,
    note: "",
  }));

  const first = points[0] ? byId.get(points[0].id) : null;

  let noteType = "随手记录";
  if (/错题|做错|错了|踩坑|失误/.test(text)) noteType = "错题复盘";
  else if (/公式|口诀|速记/.test(text)) noteType = "公式速记";
  else if (/区别|辨析|易混|对比/.test(text)) noteType = "概念辨析";
  else if (/方法|技巧|套路|步骤/.test(text)) noteType = "方法总结";
  else if (/框架|导图|梳理/.test(text)) noteType = "框架梳理";

  return {
    title: cleanLine(text, 24) || "未命名笔记",
    summary: cleanLine(text, 50),
    subject: first?.categoryLabel || "",
    topic: first?.subLabel || "",
    noteType,
    difficulty: 3,
    mastery: "理解中",
    keyConcepts: [],
    tags: normalizeTags(tags, [first?.categoryLabel, first?.subLabel].filter(Boolean)),
    knowledgePoints: points,
    body: String(content || ""),
  };
}

/* -------------------------------------------------------------------- 元数据 */

function nowStr() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/** 存进 notes.meta 的精简结构，字段名与 vault frontmatter 对齐 */
function buildMeta(result, { model, fallback }) {
  return {
    ai: true,
    model: model || "",
    fallback: !!fallback,
    at: nowStr(),
    title: result.title || "",
    summary: result.summary || "",
    subject: result.subject || "",
    topic: result.topic || "",
    noteType: result.noteType || "",
    difficulty: result.difficulty || 3,
    mastery: result.mastery || "",
    keyConcepts: result.keyConcepts || [],
    // 自建科目的知识点标签（行测科目为空，走 knowledgePoints）
    knowledgeLabels: result.knowledgeLabels || [],
    knowledgePoints: (result.knowledgePoints || []).map((item) => ({
      id: item.id,
      label: item.label,
      note: item.note || "",
    })),
  };
}

/* -------------------------------------------------------------------- 主入口 */

/** 超时控制：到点就 abort，调用方负责 clearTimeout */
function createAbortTimer(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, timer };
}

/**
 * @param {{ content: string, tags?: string[], title?: string }} input
 * @returns {Promise<{success: boolean, error?: string, needSettings?: boolean,
 *                    fallback?: boolean, model?: string, result?: object, meta?: object}>}
 */
async function tutorNote(input = {}) {
  const content = String(input.content || "").trim();
  if (!content) {
    return { success: false, error: "笔记是空的，先写点东西再整理" };
  }

  let settings = null;
  try {
    // eslint-disable-next-line global-require
    settings = require('./database.js').getAISettings();
    // 笔记整理属于「助教」角色：角色单独配置过模型时用角色的，否则沿用通用配置
    if (settings) settings = aiService.resolveRoleSettings(settings, 'assistant');
  } catch (error) {
    settings = null;
  }

  if (!settings?.apiKey) {
    return {
      success: false,
      needSettings: true,
      error: "还没有配置 AI：到「设置 → AI」填好 API Key 后再试，目前只能做本地关键词分类",
    };
  }

  const tags = normalizeTags(input.tags);
  const subjectName = resolveSubjectName(input.subjectId, input.subjectName);
  const { controller, timer } = createAbortTimer(AI_TIMEOUT_MS);

  let response;
  try {
    response = await aiService.complete(settings, {
      system: buildSystemPrompt(subjectName),
      messages: [{ role: "user", content: buildUserPrompt({ title: input.title, tags, content, subjectName }) }],
      maxTokens: 3000,
      signal: controller.signal,
    });
  } catch (error) {
    response = { success: false, error: error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }

  if (!response?.success) {
    const reason = controller.signal.aborted ? "AI 响应超时" : (response?.error || "AI 调用失败");
    return {
      success: false,
      error: reason,
      fallback: true,
      result: localAnalyze({ content, tags }),
      meta: null,
    };
  }

  let parsed;
  try {
    parsed = aiService.parseAIJson(response.content, ["body", "knowledge_points", "knowledge_labels"]);
  } catch (error) {
    return {
      success: false,
      error: `AI 返回的内容解析失败：${error.message}`,
      fallback: true,
      result: localAnalyze({ content, tags }),
    };
  }

  const result = normalizeResult(parsed, { content, tags, subjectName });
  const model = settings.model || settings.aiProvider || "";
  return {
    success: true,
    model,
    fallback: false,
    result,
    meta: buildMeta(result, { model, fallback: false }),
  };
}

module.exports = {
  tutorNote,
  localAnalyze,
  buildMeta,
  getCatalog,
  NOTE_TYPES,
  MASTERY_LEVELS,
};
