/**
 * 考研题库的知识点体系（科目 → 模块 → 章节 → 知识点）。
 *
 * 设计目标：让 AI 分类「可收敛」。
 * 旧版让模型自由输出 tags（知识点/考点混写、一句一个），数学一门课能长出上千个
 * 节点，知识图谱既画不下也看不懂。这里改成：
 *   1. 模块（sub_category）用固定编码，不允许模型自造；
 *   2. 章节（chapter）只允许从下面的白名单里选，选不到就落「其他」；
 *   3. 知识点（points）只保留 1-2 个教材标准名词，做长度/前缀清洗。
 *
 * 主进程（AI 提示词、数据库归一化、知识图谱建树）共用这份定义。
 */

const SUBJECTS = {
  math: { label: '数学' },
  english: { label: '英语' },
  politics: { label: '政治' },
  major: { label: '专业课' },
};

const MODULES = {
  math: {
    gaoshu: { label: '高等数学' },
    daishu: { label: '线性代数' },
    gaiilv: { label: '概率论与数理统计' },
  },
  english: {
    wanxing: { label: '完形填空' },
    yuedu: { label: '阅读理解' },
    fanyi: { label: '翻译' },
    xiezuo: { label: '英语写作' },
  },
  politics: {
    makesi: { label: '马克思主义基本原理' },
    maogai: { label: '毛中特' },
    shixi: { label: '思想道德与法治' },
    shiju: { label: '形势与政策' },
  },
  major: {
    major: { label: '专业课综合' },
  },
};

/**
 * 章节白名单。键是 `科目/模块`，值是章节名数组。
 * 只列考研大纲里真正会出题的主干章节，避免层级越分越细。
 */
const CHAPTERS = {
  'math/gaoshu': [
    '函数、极限与连续',
    '一元函数微分学',
    '一元函数积分学',
    '多元函数微分学',
    '多元函数积分学',
    '无穷级数',
    '常微分方程',
    '空间解析几何',
  ],
  'math/daishu': [
    '行列式',
    '矩阵',
    '向量',
    '线性方程组',
    '特征值与特征向量',
    '二次型',
  ],
  'math/gaiilv': [
    '随机事件与概率',
    '一维随机变量',
    '多维随机变量',
    '数字特征',
    '大数定律与中心极限定理',
    '数理统计',
    '参数估计',
  ],
  'english/wanxing': ['词汇辨析', '逻辑衔接', '语法结构', '篇章理解'],
  'english/yuedu': ['主旨大意', '细节理解', '推理判断', '词义猜测', '态度观点'],
  'english/fanyi': ['长难句拆分', '词义选择', '语序调整'],
  'english/xiezuo': ['应用文写作', '图表作文', '图画作文', '议论文写作'],
  'politics/makesi': ['唯物论', '辩证法', '认识论', '唯物史观', '资本主义本质', '垄断资本主义', '社会主义发展'],
  'politics/maogai': ['新民主主义革命', '社会主义改造', '社会主义建设探索', '中国特色社会主义理论体系', '新时代中国特色社会主义'],
  'politics/shixi': ['人生观', '理想信念', '中国精神', '社会主义核心价值观', '道德修养', '法治素养'],
  'politics/shiju': ['国内时政', '国际时政'],
  // 专业课没有统编大纲，交给模型自己概括，但同样限制长度
  'major/major': [],
};

/** 每个章节给一两个「标准知识点」示例，帮助模型把长句压成名词 */
const POINT_HINTS = {
  'math/gaoshu': '泰勒公式、洛必达法则、拉格朗日中值定理、定积分换元、格林公式、级数敛散性',
  'math/daishu': '行列式展开、矩阵的秩、初等变换、基础解系、相似对角化、正定二次型',
  'math/gaiilv': '全概率公式、贝叶斯公式、分布函数、数学期望、方差、矩估计、最大似然估计',
  'english/wanxing': '固定搭配、关联词、时态一致、上下文复现',
  'english/yuedu': '段落主旨、同义替换、指代关系、作者态度',
  'english/fanyi': '定语从句、被动语态、词性转换',
  'english/xiezuo': '书信格式、数据描述、论点展开',
  'politics/makesi': '物质与意识、矛盾分析法、实践与认识、社会基本矛盾、剩余价值',
  'politics/maogai': '农村包围城市、三大改造、主要矛盾、新发展理念',
  'politics/shixi': '人生价值、理想信念、民族精神、诚实守信、宪法权威',
  'politics/shiju': '重要会议、重大政策、国际合作',
  'major/major': '',
};

const OTHER_CHAPTER = '其他';

const MODULE_LABELS = Object.fromEntries(
  Object.entries(MODULES).flatMap(([category, modules]) => Object.entries(modules).map(([key, value]) => [key, value.label]))
);

function moduleKeyOf(category, subCategory) {
  const key = String(subCategory || '').trim();
  const modules = MODULES[category] || {};
  if (modules[key]) return key;
  // 兼容旧数据里把中文模块名写进 sub_category 的情况
  const matched = Object.entries(modules).find(([, value]) => value.label === key);
  return matched ? matched[0] : (Object.keys(modules)[0] || '');
}

function chapterListOf(category, subCategory) {
  return CHAPTERS[`${category}/${moduleKeyOf(category, subCategory)}`] || [];
}

/** 去掉「考点：」「知识点1、」这类前缀和尾部标点，压成短名词 */
function cleanLabel(raw, maxLength = 14) {
  let text = String(raw || '')
    .replace(/\s+/g, '')
    .replace(/^[\s\d.、)）(（\-—·*]+/, '')
    .replace(/^(核心|重点|难点|常考|主要)?(考点|知识点|考核点|题型|模块)[:：·\-—]?/, '')
    .replace(/^(掌握|理解|了解|熟悉|会求|会算|能求)/, '')
    .replace(/[。；;，,、:：!！?？"'“”‘’]+$/, '')
    .replace(/(的应用场景|的应用|的相关概念|相关概念|及其应用|的求法|的判定)$/, '')
    .trim();
  if (!text) return '';
  // 括号里的补充说明对图谱没有价值，去掉能显著缩短节点
  text = text.replace(/[（(][^）)]{0,20}[）)]/g, '').trim() || text;
  if (text.length > maxLength) text = text.slice(0, maxLength);
  return text;
}

/**
 * 章节归一化：优先精确命中白名单，其次包含匹配；都不中时保留清洗后的短标签，
 * 但长度严格限制，避免模型自造的长章节名把图谱撑爆。
 */
function normalizeChapter(category, subCategory, raw) {
  const text = cleanLabel(raw, 12);
  if (!text) return '';
  const list = chapterListOf(category, subCategory);
  if (!list.length) return text;
  const exact = list.find((chapter) => chapter === text);
  if (exact) return exact;
  const fuzzy = list.find((chapter) => text.includes(chapter) || chapter.includes(text));
  if (fuzzy) return fuzzy;
  const aliasHits = [
    [/泰勒|中值|洛必达|导数|微分|极值|单调|凹凸/, '一元函数微分学'],
    [/定积分|不定积分|反常积分|换元积分|分部积分/, '一元函数积分学'],
    [/偏导|全微分|多元.*微分|条件极值/, '多元函数微分学'],
    [/二重积分|三重积分|曲线积分|曲面积分|格林|高斯|斯托克斯/, '多元函数积分学'],
    [/级数|幂级数|傅里叶/, '无穷级数'],
    [/微分方程|通解|特解/, '常微分方程'],
    [/极限|连续|无穷小|间断/, '函数、极限与连续'],
    [/行列式/, '行列式'],
    [/矩阵|秩|初等变换/, '矩阵'],
    [/向量组|线性相关|线性无关|极大无关组/, '向量'],
    [/方程组|解的结构|基础解系/, '线性方程组'],
    [/特征值|特征向量|相似/, '特征值与特征向量'],
    [/二次型|正定/, '二次型'],
    [/概率|条件概率|独立|全概率|贝叶斯/, '随机事件与概率'],
    [/分布函数|分布律|密度函数/, '一维随机变量'],
    [/二维|联合分布|边缘分布/, '多维随机变量'],
    [/期望|方差|协方差|相关系数/, '数字特征'],
    [/大数定律|中心极限/, '大数定律与中心极限定理'],
    [/估计|检验|统计量/, '参数估计'],
    [/主旨|中心|标题|意在/, '主旨大意'],
    [/推断|推理/, '推理判断'],
    [/细节/, '细节理解'],
    [/态度|观点/, '态度观点'],
    [/词义|划线词|指代/, '词义猜测'],
    [/翻译|长难句|英译汉/, '长难句拆分'],
    [/写作|作文|书信|图表/, '应用文写作'],
    [/唯物|物质|意识/, '唯物论'],
    [/辩证法|矛盾|量变|否定之否定/, '辩证法'],
    [/认识论|实践|真理/, '认识论'],
    [/唯物史观|社会存在|上层建筑/, '唯物史观'],
    [/剩余价值|资本|商品/, '资本主义本质'],
  ].find(([pattern]) => pattern.test(text));
  return aliasHits ? aliasHits[1] : (list.includes(OTHER_CHAPTER) ? OTHER_CHAPTER : text);
}

/**
 * 自建科目没有统编大纲，真实层级来自教材解析后生成的「知识清单」：
 *   ## 模块一 绪论与系统基本概念（第 1 章）
 *   ### 1.1 自动控制与自动控制系统的基本术语
 *     - 核心概念：控制、自动控制、……
 * 这里把清单解析成「子类别 → 章节 → 知识点示例」，供 AI 分类时原样取用，
 * 避免模型凭空编章节名。
 */
function parseKnowledgeSummaryTaxonomy(knowledgeSummary) {
  const lines = String(knowledgeSummary || '').split('\n');
  const modules = [];
  let moduleNode = null;
  let chapterNode = null;

  const pickHints = (raw) => {
    const text = String(raw || '')
      .replace(/^[^：:]*[：:]/, '')
      .replace(/\$[^$]*\$/g, '');
    const items = text.split(/[、，,；;。]/)
      .map((item) => cleanLabel(item, 12))
      .filter((item) => item.length >= 2 && !/[=<>/]/.test(item));
    return Array.from(new Set(items)).slice(0, 4).join('、');
  };

  lines.forEach((line) => {
    const moduleMatch = line.match(/^##\s+(.+)$/);
    if (moduleMatch) {
      const raw = moduleMatch[1].replace(/^模块\s*[一二三四五六七八九十百\d]+\s*[、.．:：-]?\s*/, '');
      const label = cleanLabel(raw.replace(/[（(][^）)]*[）)]/g, ''), 24);
      chapterNode = null;
      moduleNode = label ? { key: `m${modules.length + 1}`, label, chapters: [] } : null;
      if (moduleNode) modules.push(moduleNode);
      return;
    }

    const sectionMatch = line.match(/^###\s*(\d+(?:\.\d+)*)\s+(.+)$/);
    if (sectionMatch && moduleNode) {
      const label = cleanLabel(sectionMatch[2], 24);
      if (!label) return;
      chapterNode = { key: sectionMatch[1], label, hints: '' };
      if (!moduleNode.chapters.some((chapter) => chapter.label === label)) {
        moduleNode.chapters.push(chapterNode);
      }
      return;
    }

    if (chapterNode && /核心概念/.test(line) && !chapterNode.hints) {
      chapterNode.hints = pickHints(line.replace(/^\s*[-*]\s*/, ''));
    }
  });

  const usable = modules.filter((module) => module.chapters.length);
  return usable.length ? { modules: usable } : null;
}

function matchTaxonomyChapter(chapters = [], raw) {
  const text = cleanLabel(String(raw || '').replace(/^\s*\d+(?:\.\d+)*[.、]?\s*/, ''), 24);
  if (!text) return '';
  const exact = chapters.find((chapter) => chapter.label === text);
  if (exact) return exact.label;
  const fuzzy = chapters.find((chapter) => text.includes(chapter.label) || chapter.label.includes(text));
  return fuzzy ? fuzzy.label : '';
}

/** 把科目知识清单转成给模型看的分类清单 */
function buildSubjectTaxonomyGuide(taxonomy = {}) {
  const lines = [];
  if (taxonomy.subjectName) lines.push(`科目：${taxonomy.subjectName}`);
  (taxonomy.modules || []).forEach((module) => {
    lines.push(`- 子类别（subCategory）：${module.label}`);
    lines.push(`  章节（chapter）：${module.chapters.map((chapter) => chapter.label).join('、')}`);
    const hints = module.chapters.map((chapter) => chapter.hints).filter(Boolean).slice(0, 6);
    if (hints.length) lines.push(`  知识点示例：${hints.join('、').slice(0, 160)}`);
  });
  return lines.join('\n');
}

/**
 * 知识点归一化：1-2 个短名词。
 * 会丢掉与章节/模块同名的标签、超长句子、重复项，保证「知识点尽可能精简」。
 */
function normalizeKnowledgePoints(raw, options = {}) {
  const limit = Math.max(1, Math.min(3, Number(options.limit) || 2));
  const chapter = String(options.chapter || '').trim();
  const moduleLabel = String(options.moduleLabel || '').trim();
  const chapterSet = new Set((options.chapterList || []).map((item) => String(item).trim()).filter(Boolean));
  const list = Array.isArray(raw)
    ? raw
    : String(raw || '').split(/[,，、;；|/\n]+/);

  const seen = new Set();
  const points = [];
  list.forEach((item) => {
    const text = cleanLabel(item, 12);
    if (!text) return;
    // 章节名 / 模块名不是知识点，混进来就是「考点和知识点并在一起」
    if (text === chapter || text === moduleLabel || chapterSet.has(text)) return;
    if (text.length < 2) return;
    // 一句话式的「分析…并求解…」不是知识点
    if (/[，。；]/.test(String(item)) && text.length > 10) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    points.push(text);
  });
  return points.slice(0, limit);
}

/**
 * 把一行题目的分类字段整理成落库结构。
 *
 * options.taxonomy 存在时按「自建科目教材清单」归一化：subCategory 保留中文子类别，
 * 章节必须能对上清单里的真实章节，对不上就返回空章节（调用方据此跳过该题、保持原样）。
 */
function normalizeClassification(input = {}, options = {}) {
  const category = String(input.category || '').trim();
  const taxonomy = options.taxonomy;
  if (taxonomy && Array.isArray(taxonomy.modules) && taxonomy.modules.length) {
    const rawModule = String(input.subCategory || input.sub_category || '').trim();
    const rawChapter = String(input.chapter || '').trim();
    const moduleText = cleanLabel(rawModule.replace(/^模块\s*[一二三四五六七八九十百\d]+\s*[、.．:：-]?\s*/, ''), 24);
    let moduleNode = taxonomy.modules.find((module) => (
      module.label === moduleText
      || (moduleText && (moduleText.includes(module.label) || module.label.includes(moduleText)))
    ));
    if (!moduleNode && rawChapter) {
      moduleNode = taxonomy.modules.find((module) => matchTaxonomyChapter(module.chapters, rawChapter));
    }
    if (!moduleNode) return { category, subCategory: '', chapter: '', points: [] };
    const chapter = matchTaxonomyChapter(moduleNode.chapters, rawChapter);
    if (!chapter) return { category, subCategory: moduleNode.label, chapter: '', points: [] };
    const points = normalizeKnowledgePoints(input.points || input.tags || input.knowledgePoints, {
      chapter,
      moduleLabel: moduleNode.label,
      chapterList: moduleNode.chapters.map((item) => item.label),
    });
    return { category, subCategory: moduleNode.label, chapter, points };
  }

  const subCategory = moduleKeyOf(category, input.subCategory || input.sub_category);
  const chapter = normalizeChapter(category, subCategory, input.chapter);
  const points = normalizeKnowledgePoints(input.points || input.tags || input.knowledgePoints, {
    chapter,
    moduleLabel: MODULE_LABELS[subCategory] || '',
    chapterList: chapterListOf(category, subCategory),
  });
  return { category, subCategory, chapter, points };
}

/** 生成给模型看的分类说明（只列该科目自己的模块和章节，省 token 也少干扰） */
function buildTaxonomyGuide(categories = Object.keys(SUBJECTS)) {
  const lines = [];
  categories.forEach((category) => {
    const modules = MODULES[category] || {};
    Object.entries(modules).forEach(([key, value]) => {
      const chapters = CHAPTERS[`${category}/${key}`] || [];
      const chapterText = chapters.length ? chapters.join('、') : '自拟（不超过 10 个字）';
      const hints = POINT_HINTS[`${category}/${key}`];
      lines.push(`- ${category} / ${key}（${value.label}）章节：${chapterText}${hints ? `；知识点示例：${hints}` : ''}`);
    });
  });
  return lines.join('\n');
}

module.exports = {
  SUBJECTS,
  MODULES,
  CHAPTERS,
  MODULE_LABELS,
  OTHER_CHAPTER,
  moduleKeyOf,
  chapterListOf,
  cleanLabel,
  normalizeChapter,
  normalizeKnowledgePoints,
  normalizeClassification,
  buildTaxonomyGuide,
  parseKnowledgeSummaryTaxonomy,
  buildSubjectTaxonomyGuide,
};
