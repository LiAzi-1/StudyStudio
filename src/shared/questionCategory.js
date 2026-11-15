const createAliasMap = (groups) => Object.fromEntries(
  Object.entries(groups).flatMap(([value, aliases]) => aliases.map((alias) => [alias, value]))
);

const CATEGORY_ALIASES = createAliasMap({
  math: ['math', '数学', '数学一', '数学二', '数学三', '考研数学'],
  english: ['english', '英语', '英语一', '英语二', '考研英语'],
  politics: ['politics', '政治', '考研政治'],
  major: ['major', '专业课', '专业课综合', '专业课一', '专业课二'],
  yanyu: ['yanyu', '言语理解', '言语'],
  shuliang: ['shuliang', '数量关系', '数量'],
  panduan: ['panduan', '判断推理', '判断'],
  ziliao: ['ziliao', '资料分析', '资料'],
  changshi: ['changshi', '常识判断', '常识', '经济', '法律', '科技', '人文', '地理'],
});

const SUBCATEGORY_ALIASES = createAliasMap({
  gaoshu: ['gaoshu', '高等数学', '微积分', '高数'],
  daishu: ['daishu', '线性代数', '线代'],
  gaiilv: ['gaiilv', '概率论与数理统计', '概率论'],
  wanxing: ['wanxing', '完形填空'],
  yuedu: ['yuedu', '阅读理解'],
  fanyi: ['fanyi', '翻译'],
  xiezuo: ['xiezuo', '英语写作', '作文'],
  makesi: ['makesi', '马克思主义基本原理', '马原'],
  maogai: ['maogai', '毛泽东思想和中国特色社会主义理论体系', '毛中特'],
  shixi: ['shixi', '思想道德与法治', '思修'],
  shiju: ['shiju', '形势与政策', '时政'],
  xuanci: ['xuanci', '逻辑填空', '逻辑题空', '选词填空'],
  yueduan: ['yueduan', '中心理解', '细节判断', '标题填入', '推断下文', '词句理解', '片段阅读'],
  yuju: ['yuju', '语句填空', '语句排序', '病语', '病句', '歧义句', '语句表达'],
  wenzhang: ['wenzhang', '篇章阅读', '文章阅读'],
  jisuan: ['jisuan', 'gongcheng', '和差倍比', '几何问题', '容斥问题', '工程问题', '年龄问题', '不定方程', '方阵问题', '排列组合', '组合排列', '组合排列（材料）', '概率问题', '溶液问题', '行程问题', '计算问题', '最值问题', '经济利润', '数学运算'],
  tuili: ['tuili', '数字推理'],
  tuxing: ['tuxing', '图形推理', '图像推理', '空间重构', '立体拼合', '三视图', '六面体', '截面图', '平面问题'],
  dingyi: ['dingyi', '定义判断'],
  leibi: ['leibi', '类比推理'],
  luoji: ['luoji', '加强削弱', '翻译推理', '真假推理', '日常结论', '结构相似', '原因解释', '论证缺陷', '集合推理', '逻辑判断'],
  wenzi: ['wenzi', '文字资料'],
  biaoge: ['biaoge', '表格资料'],
  tubiao: ['tubiao', '图形资料'],
  zonghe: ['zonghe', '资料分析', '综合资料'],
  zengzhang: ['zengzhang', '增长率'],
  zhengzhi: ['zhengzhi', '理论政策', '马克思主义', '毛泽东思想', '新思想', '政治'],
  jingji: ['jingji', '经济', '管理'],
  falv: ['falv', '法律', '公文'],
  keji: ['keji', '自然科技', '科学推理', '科技'],
  renwen: ['renwen', '人文历史', '历史', '人文'],
  dili: ['dili', '地理国情', '地理'],
});

const SUBCATEGORY_CATEGORY_MAP = { gaoshu: 'math', daishu: 'math', gaiilv: 'math', wanxing: 'english', yuedu: 'english', fanyi: 'english', xiezuo: 'english', makesi: 'politics', maogai: 'politics', shixi: 'politics', shiju: 'politics', xuanci: 'yanyu', yueduan: 'yanyu', yuju: 'yanyu', wenzhang: 'yanyu', jisuan: 'shuliang', tuili: 'shuliang', tuxing: 'panduan', dingyi: 'panduan', leibi: 'panduan', luoji: 'panduan', wenzi: 'ziliao', biaoge: 'ziliao', tubiao: 'ziliao', zonghe: 'ziliao', zengzhang: 'ziliao', zhengzhi: 'changshi', jingji: 'changshi', falv: 'changshi', keji: 'changshi', renwen: 'changshi', dili: 'changshi' };
const DEFAULT_SUBCATEGORY = { math: 'gaoshu', english: 'yuedu', politics: 'makesi', major: 'major', yanyu: 'yueduan', shuliang: 'jisuan', panduan: 'luoji', ziliao: 'zonghe', changshi: 'zhengzhi' };
const CATEGORY_RULES = [
  { value: 'math', patterns: ['函数', '极限', '导数', '积分', '矩阵', '线性代数', '概率', '数列'] },
  { value: 'english', patterns: ['阅读理解', '完形填空', '英译汉', '翻译下列', '作文', 'paragraph', 'passage'] },
  { value: 'politics', patterns: ['马克思主义', '毛泽东思想', '中国特色社会主义', '思想道德与法治', '形势与政策'] },
  { value: 'ziliao', patterns: ['根据下列资料', '根据以下资料', '图表', '统计表', '同比', '环比', '增长率', '表中', '图中'] },
  { value: 'panduan', patterns: ['根据上述定义', '图形', '问号处', '最能支持', '最能削弱', '如果那么', '只有才'] },
  { value: 'shuliang', patterns: ['工程问题', '行程问题', '概率问题', '几何问题', '利润', '浓度', '甲乙', '速度', '工作效率', '打折'] },
  { value: 'yanyu', patterns: ['这段文字', '文段', '依次填入', '语句排序', '病句', '成语', '词语'] },
];
const SUBCATEGORY_RULES = {
  math: [{ value: 'gaoshu', patterns: ['极限', '导数', '积分', '微分', '函数'] }, { value: 'daishu', patterns: ['矩阵', '行列式', '向量', '线性方程组'] }, { value: 'gaiilv', patterns: ['概率', '随机变量', '分布', '数理统计'] }],
  english: [{ value: 'wanxing', patterns: ['完形填空'] }, { value: 'yuedu', patterns: ['阅读理解', 'passage'] }, { value: 'fanyi', patterns: ['翻译', '英译汉'] }, { value: 'xiezuo', patterns: ['作文', '写作'] }],
  politics: [{ value: 'makesi', patterns: ['马克思主义', '辩证法', '唯物'] }, { value: 'maogai', patterns: ['毛泽东思想', '新时代中国特色社会主义'] }, { value: 'shixi', patterns: ['思想道德与法治'] }, { value: 'shiju', patterns: ['形势与政策', '时政'] }],
  yanyu: [{ value: 'wenzhang', patterns: ['阅读以下文字', '阅读下文', '根据这篇文章', '文章中'] }, { value: 'yuju', patterns: ['语句排序', '语句填空', '病句', '歧义', '下列各句'] }, { value: 'xuanci', patterns: ['依次填入', '填入划横线', '填入横线', '成语', '词语'] }, { value: 'yueduan', patterns: ['这段文字', '文段', '主旨', '意在说明', '理解正确', '标题最合适'] }],
  shuliang: [{ value: 'tuili', patterns: ['数字推理', '数字序列', '数列'] }, { value: 'jisuan', patterns: ['工程', '行程', '利润', '概率', '几何', '工作效率', '成本', '售价', '浓度', '容斥'] }],
  panduan: [{ value: 'dingyi', patterns: ['根据上述定义', '属于上述定义', '不属于上述定义'] }, { value: 'leibi', patterns: ['之于', '相当于', '最贴切'] }, { value: 'tuxing', patterns: ['图形', '问号处', '纸盒', '展开图', '折叠', '立体拼合', '三视图', '六面体', '截面'] }, { value: 'luoji', patterns: ['最能支持', '最能削弱', '最能解释', '不能质疑', '不能推出', '如果那么', '只有才', '加强', '削弱', '论证'] }],
  ziliao: [{ value: 'zengzhang', patterns: ['增长率', '同比', '环比', '增速', '增长速度'] }, { value: 'zonghe', patterns: ['文字、表格、图形资料', '综合资料'] }, { value: 'biaoge', patterns: ['统计表', '表格', '如下表', '表中', '见表'] }, { value: 'tubiao', patterns: ['图表', '如下图', '图中', '柱状图', '折线图', '饼图'] }, { value: 'wenzi', patterns: ['根据下列资料', '根据以下资料', '根据材料'] }],
  changshi: [{ value: 'falv', patterns: ['宪法', '民法', '刑法', '行政法', '条例', '诉讼', '司法', '爱国主义教育法'] }, { value: 'jingji', patterns: ['经济', '财政', '货币', '税', '关税', '贸易', '消费券', '营商环境', '市场准入', 'gdp', '民营经济'] }, { value: 'keji', patterns: ['科技', '科学', '物理', '化学', '生物', '红外', '量子', '锂电池', '芯片', '算力', '高铁', '卫星', '人工智能', '航天'] }, { value: 'dili', patterns: ['地理', '气候', '地形', '山脉', '河流', '海洋', '经纬', '广东省', '地球', '同步卫星', '国土'] }, { value: 'renwen', patterns: ['历史', '文学', '诗', '文化', '文明', '古代', '白居易', '贞观', '传统文化', '节日', '文物'] }, { value: 'zhengzhi', patterns: ['习近平', '新时代', '中国特色社会主义', '马克思主义', '毛泽东思想', '中国共产党', '党的二十大', '全面深化改革', '高质量发展', '社会主义核心价值观', '政策'] }],
};
const FAKE_QUESTION_PATTERNS = ['题目正在全力以赴征集', '将会在征集到后第一时间上传'];

function trimText(value) { return String(value || '').trim(); }
function normalizeText(value) { return trimText(value).replace(/\s+/g, '').toLowerCase(); }
function normalizeCategory(value) { return CATEGORY_ALIASES[trimText(value)] || inferCategoryBySubCategory(value) || ''; }
function normalizeSubCategory(value) { return SUBCATEGORY_ALIASES[trimText(value)] || ''; }
function inferCategoryBySubCategory(value) { const key = normalizeSubCategory(value); return key ? SUBCATEGORY_CATEGORY_MAP[key] || '' : ''; }
function inferByRules(text, rules = []) {
  let best = ''; let bestScore = 0;
  rules.forEach((rule) => {
    const score = rule.patterns.reduce((sum, pattern) => sum + (text.includes(normalizeText(pattern)) ? 1 : 0), 0);
    if (score > bestScore) { best = rule.value; bestScore = score; }
  });
  return best;
}
function inferCategoryFromContent(content) { return inferByRules(normalizeText(content), CATEGORY_RULES); }
function inferSubCategoryFromContent(category, content) { return inferByRules(normalizeText(content), SUBCATEGORY_RULES[category] || []); }
function isFakeQuestionContent(content) { const text = trimText(content); return !text || text === '<' || FAKE_QUESTION_PATTERNS.some((pattern) => text.includes(pattern)); }
function hasQuestionHtmlContent(content) {
  const html = trimText(content);
  return /<img/i.test(html) || /<svg/i.test(html) || /<table/i.test(html);
}
function isFakeQuestion(question = {}) {
  if (hasQuestionHtmlContent(question.content_html || question.contentHtml)) return false;
  return isFakeQuestionContent(question.content);
}
function normalizeQuestionTaxonomy(question = {}) {
  const rawCategory = trimText(question.category);
  const rawSubCategory = trimText(question.subCategory || question.sub_category);
  const content = question.content || '';
  const aliasedSubCategory = normalizeSubCategory(rawSubCategory) || normalizeSubCategory(rawCategory);
  const explicitCategory = normalizeCategory(rawCategory);

  // 用户显式选择的分类优先。旧逻辑让「内容关键词推断」盖过用户选择，
  // 导致选了「专业课」的题被强行改成数学/高数，后续按分类练习时找不到。
  const category = explicitCategory
    || inferCategoryBySubCategory(aliasedSubCategory)
    || inferCategoryFromContent(content)
    || 'changshi';
  const subCategory = (aliasedSubCategory && SUBCATEGORY_CATEGORY_MAP[aliasedSubCategory] === category ? aliasedSubCategory : '')
    || inferSubCategoryFromContent(category, content)
    || DEFAULT_SUBCATEGORY[category]
    || '';
  return { category, subCategory };
}
function inferCategoryFromQuestion(question = {}) { return normalizeQuestionTaxonomy(question).category; }

module.exports = { inferCategoryFromQuestion, normalizeQuestionTaxonomy, isFakeQuestion, isFakeQuestionContent };
