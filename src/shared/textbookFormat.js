/**
 * 教材式题目格式层（Textbook Format Layer）
 * ==========================================================================
 * 目标：题库里的题目 / 选项 / 答案 / 解析统一成「市面教材 / 教辅」的书写形式：
 *
 *   1. 题干不带题号、题型标签，不混入选项、答案和解析；
 *   2. 数学公式一律写成 KaTeX 可解析的行内 LaTeX（$...$），
 *      Unicode 上下标、√、∫、Σ、lim_{x→0}、a/b 这类 OCR 半成品全部升级为
 *      x^{2}、\sqrt{}、\int、\sum、\lim_{x\to0}、\frac{a}{b}；
 *   3. 中文正文与公式分离渲染，公式用数学体、变量斜体；
 *   4. 填空横线统一 ______，答案解析按段落分开；
 *   5. content / analysis 存带 $...$ 的纯文本（搜索、导出、AI 讲题都用得上），
 *      content_html / analysis_html 存教材化段落 HTML（渲染更贴近纸书）。
 *
 * 这个模块是**纯字符串处理 + 幂等**的：同一道题格式化一次和十次结果一致，
 * 因此可以同时挂在「AI 输出返回前」「落库前」「存量迁移」三处，不会套娃。
 * 主进程（database / ai / main）直接 require；渲染层只负责把 $...$ 渲染出来。
 */

const TEXTBOOK_FORMAT_VERSION = 3;

// 校验公式时用到 KaTeX 的语法解析器（可选依赖，缺失时降级为不校验）
let parseTex = null;
try {
  const katex = require('katex');
  if (typeof katex.__parse === 'function') {
    parseTex = (tex) => {
      katex.__parse(tex, { throwOnError: true, strict: false, trust: false });
      return true;
    };
  }
} catch (_) { /* 打包环境没带 katex 时不阻断格式化 */ }

/** 写进 AI 提示词的格式规范：让模型一开始就吐教材格式，规则层只做兜底。 */
const TEXTBOOK_FORMAT_GUIDE = `
【教材式排版规范（必须遵守）】
- 数学公式一律用 LaTeX，并用行内定界符 $...$ 包住；独立成行的公式用 $$...$$。
  例：$x^{2}+y^{2}\\le z$、$\\lim_{x\\to0}\\frac{\\tan x-\\sin x}{x^{3}}$、$\\int_{0}^{\\pi}\\sin x\\,dx$、$\\sum_{n=1}^{\\infty}\\frac{1}{n^{2}}$。
  禁止输出 Unicode 上下标（x²、xₙ）、禁止裸写 lim_{x→0} / ∫₀^π / Σ_{n=1}^∞ / √3 / a/b 这类半成品；
  分数必须写 \\frac{分子}{分母}，根号写 \\sqrt{}，希腊字母与运算符写对应 LaTeX 命令（\\pi、\\infty、\\partial、\\le、\\to 等）。
- 题干只写题目本身：不要带题号（1. / 第 1 题 / (1) 这类卷面编号）、不要带「单选题 / 计算题」等题型标签，
  不要把选项 A. B. C. D.、答案、解析、分值、页码混进题干；材料题把材料单独放在 material 字段。
- options 里只写选项正文，不要重复写 A. / B. 前缀；选项公式同样用 $...$。
- 填空处统一用 6 个下划线 ______；中文用全角标点，数字与中文之间留一个空格（如「共 3 个解」）。
- 解析按「考点 → 逐项分析 → 结论」分段，每项单独一行，引用选项写成「A 项」而不是「A.」；
  解析中的公式同样用 $...$，不要写「答案：A」这类答案表残句。
- 定界符里只放数学：中文说明、单位、约等号后的解释一律留在 $...$ 外面，或用 \\text{中文}。
  正确：需要 $\\frac{24}{7} \\approx 3.4$ 小时；错误：$\\frac{24}{7 \\approx 3.4}$、$24/7 ≈ 3.4 小时$。
  块级公式 $$...$$ 单独占行，前后各留一个空行，Obsidian 才会渲染。
- 只输出 JSON，不要输出 Markdown 代码块、不要解释你做了什么。`.trim();

/* -------------------------------------------------------------------------- */
/* 基础清洗                                                                    */
/* -------------------------------------------------------------------------- */

const INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g;
const STEM_PREFIX_RE = /^\s*(?:第\s*)?\d{1,3}\s*[.．、)）:：]\s*(?!\d)/;
const TYPE_TAG_RE = /^\s*[（(\[【]\s*(?:单项|多项|不定项)?(?:选择|单选|多选|判断|填空|简答|论述|计算|证明|案例)题?\s*[）)\]】]\s*/;
const INLINE_OPTION_RE = /^\s*[（(]?\s*([A-H])\s*[.．、)）:：]\s*(.+?)\s*$/;
const ANSWER_LINE_RE = /^\s*[【\[]?\s*(?:参考)?答案\s*[】\]]?\s*[:：]?\s*(.+?)\s*$/;
const ANALYSIS_LINE_RE = /^\s*[【\[]?\s*(?:解析|详解|试题解析|参考答案及解析|解答|答案与解析)\s*[】\]]?\s*[:：]?\s*(.*)$/;
const ANALYSIS_LABEL_RE = /^[【\[]?\s*(?:解析|详解|试题解析|解答|答案与解析)\s*[】\]]?\s*[:：]?\s*/;

function cleanWhitespace(value) {
  return String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE_RE, '')
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
    .split('\n').map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 去掉题干里被 OCR 带进来的卷面编号、题型标签。 */
function stripStemPrefix(value) {
  let text = String(value || '');
  // 只处理开头，最多剥两层（如「1. 【单选题】…」）
  for (let i = 0; i < 2; i += 1) {
    const next = text.replace(TYPE_TAG_RE, '').replace(STEM_PREFIX_RE, '');
    if (next === text) break;
    text = next;
  }
  return text;
}

/** 从题干里剥离混入的选项行 / 答案行 / 解析块。 */
function splitStemBlocks(text) {
  const lines = String(text || '').split('\n');
  const stem = [];
  const options = [];
  const answerLines = [];
  const analysisLines = [];
  let inAnalysis = false;

  lines.forEach((line) => {
    if (inAnalysis) { analysisLines.push(line); return; }
    const analysisMatch = line.match(ANALYSIS_LINE_RE);
    if (analysisMatch) {
      inAnalysis = true;
      if (analysisMatch[1]) analysisLines.push(analysisMatch[1]);
      return;
    }
    const answerMatch = line.match(ANSWER_LINE_RE);
    if (answerMatch && answerMatch[1].length <= 120) {
      answerLines.push(answerMatch[1]);
      return;
    }
    const optionMatch = line.match(INLINE_OPTION_RE);
    if (optionMatch) { options.push({ key: optionMatch[1], content: optionMatch[2] }); return; }
    stem.push(line);
  });

  return {
    stem: stem.join('\n'),
    options,
    answer: answerLines.join('\n'),
    analysis: analysisLines.join('\n'),
  };
}

/* -------------------------------------------------------------------------- */
/* Unicode / 半成品公式 → LaTeX                                                */
/* -------------------------------------------------------------------------- */

const SUPER_MAP = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
  '⁺': '+', '⁻': '-', '⁼': '=', '⁽': '(', '⁾': ')', 'ⁿ': 'n', 'ⁱ': 'i', 'ᵀ': 'T',
  'ˣ': 'x', 'ʸ': 'y', 'ᶻ': 'z', 'ᵃ': 'a', 'ᵇ': 'b', 'ᶜ': 'c', 'ᵈ': 'd', 'ᵉ': 'e',
  'ᶠ': 'f', 'ᵍ': 'g', 'ʰ': 'h', 'ʲ': 'j', 'ᵏ': 'k', 'ˡ': 'l', 'ᵐ': 'm', 'ᵒ': 'o',
  'ᵖ': 'p', 'ʳ': 'r', 'ˢ': 's', 'ᵗ': 't', 'ᵘ': 'u', 'ᵛ': 'v', 'ʷ': 'w',
  '¹': '1', '²': '2', '³': '3',
};
const SUB_MAP = {
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
  '₊': '+', '₋': '-', '₌': '=', '₍': '(', '₎': ')', 'ₐ': 'a', 'ₑ': 'e', 'ₒ': 'o', 'ₓ': 'x',
  'ᵢ': 'i', 'ₙ': 'n', 'ₖ': 'k', 'ₘ': 'm', 'ₜ': 't',
};
const SUPER_CHARS = '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱᵀˣʸᶻᵃᵇᶜᵈᵉᶠᵍʰʲᵏˡᵐᵒᵖʳˢᵗᵘᵛʷ¹²³';
const SUB_CHARS = '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓᵢₙₖₘₜ';

const SYMBOL_MAP = {
  '−': '-', '–': '-', '—': '-', '→': '\\to ', '⟶': '\\to ', '⇒': '\\Rightarrow ', '⇔': '\\Leftrightarrow ',
  '∞': '\\infty ', '∂': '\\partial ', '∫': '\\int ', '∬': '\\iint ', '∭': '\\iiint ', '∮': '\\oint ',
  '∑': '\\sum ', '∏': '\\prod ', '≤': '\\le ', '≥': '\\ge ', '≠': '\\ne ', '≈': '\\approx ',
  '≡': '\\equiv ', '∈': '\\in ', '∉': '\\notin ', '⊂': '\\subset ', '⊆': '\\subseteq ',
  '∪': '\\cup ', '∩': '\\cap ', '∅': '\\varnothing ', '∀': '\\forall ', '∃': '\\exists ',
  '±': '\\pm ', '∓': '\\mp ', '×': '\\times ', '÷': '\\div ', '·': '\\cdot ', '∗': '\\ast ',
  '∣': '\\mid ', '‖': '\\Vert ', '∇': '\\nabla ', '∠': '\\angle ', '⊥': '\\perp ',
  '′': "'", '″': "''", '°': '^{\\circ}', '…': '\\cdots ', '⋯': '\\cdots ', '⋮': '\\vdots ',
  '⟨': '\\langle ', '⟩': '\\rangle ', '≪': '\\ll ', '≫': '\\gg ', '∝': '\\propto ',
  'α': '\\alpha ', 'β': '\\beta ', 'γ': '\\gamma ', 'δ': '\\delta ', 'ε': '\\varepsilon ', 'ζ': '\\zeta ',
  'η': '\\eta ', 'θ': '\\theta ', 'ϑ': '\\vartheta ', 'ι': '\\iota ', 'κ': '\\kappa ', 'λ': '\\lambda ',
  'μ': '\\mu ', 'ν': '\\nu ', 'ξ': '\\xi ', 'ρ': '\\rho ', 'σ': '\\sigma ', 'τ': '\\tau ',
  'υ': '\\upsilon ', 'φ': '\\phi ', 'ϕ': '\\varphi ', 'χ': '\\chi ', 'ψ': '\\psi ', 'ω': '\\omega ',
  'Γ': '\\Gamma ', 'Δ': '\\Delta ', 'Θ': '\\Theta ', 'Λ': '\\Lambda ', 'Ξ': '\\Xi ', 'Π': '\\Pi ',
  'Υ': '\\Upsilon ', 'Φ': '\\Phi ', 'Ψ': '\\Psi ', 'Ω': '\\Omega ', 'π': '\\pi ',
};

const MATH_FUNCS = [
  'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'coth', 'lim', 'sup', 'inf',
  'max', 'min', 'exp', 'log', 'ln', 'lg', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc',
  'det', 'dim', 'deg', 'gcd', 'hom', 'ker', 'arg', 'mod', 'Pr',
];

const CJK_RE = /[\u3400-\u9dbf\u3000-\u303f\uff00-\uffef]/;
const CJK_PUNCT_RE = /[，。；：、！？「」『』【】（）“”‘’《》〈〉—]/;
// \u02b0-\u02ff 是 ˣ ʸ ᶻ ᵃ 这类「修饰字母」上标，中文里单独出现 eˣ / xⁿ 时也要能识别成公式
const MATH_HINT_RE = /[0-9=+\-*/^_{}()[\]<>\\|,$%]|[\u02b0-\u02ff\u2190-\u22ff\u2070-\u209f\u00b0\u00b1\u00b2\u00b3\u00b9\u00d7\u00f7√∫Σ∑∏∂∞]/;
const PLAIN_WORD_RE = /^[A-Za-z]{3,}$/;
const SKIP_WORDS = new Set(['AI', 'PDF', 'OCR', 'APP', 'OpenExam', 'the', 'and', 'for', 'with', 'from', 'that', 'this', 'null', 'true', 'false', 'undefined']);
const NUMBERED_ITEM_RE = /^\(?\d{1,2}\)?$/;
const BLANK_TOKEN = '\u0005BLANK\u0005';
// 带上下限的运算符前缀：\lim_{x\to0} / \sum_{n=1}^\infty / \int_0^\pi ...
// 分式必须写在运算符「里面」，不能把 lim / ∑ / ∫ 一起塞进分子
const TEX_OPERATOR_PREFIX_RE = /^\\(?:lim|sum|prod|int|iint|iiint|oint)\s*(?:[_^]\s*(?:\{[^{}]*\}|\\[A-Za-z]+|[A-Za-z0-9]))*\s*/;

/** 连续 Unicode 上下标字符 → ^{...} / _{...} */
function foldScripts(value, chars, map, prefix) {
  let out = '';
  let i = 0;
  while (i < value.length) {
    if (chars.includes(value[i])) {
      let buf = '';
      while (i < value.length && chars.includes(value[i])) {
        buf += map[value[i]] || value[i];
        i += 1;
      }
      out += `${prefix}{${buf}}`;
    } else {
      out += value[i];
      i += 1;
    }
  }
  return out;
}

/** 找到与开括号匹配的闭括号下标；找不到返回 -1 */
function findClosing(text, start, open, close) {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === open) depth += 1;
    else if (text[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** √ 后面接括号 / 单个 token → \sqrt{...} */
function convertRoots(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '√') { out += text[i]; continue; }
    let j = i + 1;
    while (j < text.length && text[j] === ' ') j += 1;
    let done = false;
    for (const [open, close] of [['(', ')'], ['{', '}']]) {
      if (text[j] !== open) continue;
      const end = findClosing(text, j, open, close);
      if (end > j) {
        out += `\\sqrt{${text.slice(j + 1, end)}}`;
        i = end;
        done = true;
        break;
      }
    }
    if (done) continue;
    let k = j;
    while (k < text.length && /[A-Za-z0-9.]/.test(text[k])) k += 1;
    if (k > j) { out += `\\sqrt{${text.slice(j, k)}}`; i = k - 1; continue; }
    out += '\\sqrt{}';
  }
  return out;
}

/** 数学片段切成 token：atom / space / slash / op，用于安全地识别 a/b */
function tokenizeMath(str) {
  const tokens = [];
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (/\s/.test(ch)) { tokens.push({ start: i, end: i + 1, type: 'space' }); i += 1; continue; }
    if (ch === '/') { tokens.push({ start: i, end: i + 1, type: 'slash' }); i += 1; continue; }

    const start = i;
    let atom = '';
    while (i < str.length) {
      if (str[i] === '\\') {
        let j = i + 1;
        while (j < str.length && /[A-Za-z]/.test(str[j])) j += 1;
        if (j === i + 1) { atom += str[i]; i += 1; continue; }
        atom += str.slice(i, j);
        i = j;
        for (let k = 0; k < 2; k += 1) {
          if (str[i] !== '{') break;
          const close = findClosing(str, i, '{', '}');
          if (close < 0) break;
          atom += str.slice(i, close + 1);
          i = close + 1;
        }
        continue;
      }
      if (str[i] === '(' || str[i] === '[' || str[i] === '{') {
        const open = str[i];
        const close = open === '(' ? ')' : open === '[' ? ']' : '}';
        const end = findClosing(str, i, open, close);
        if (end > i) { atom += str.slice(i, end + 1); i = end + 1; continue; }
      }
      if (str[i] === '^' || str[i] === '_') {
        atom += str[i];
        i += 1;
        if (str[i] === '{') {
          const end = findClosing(str, i, '{', '}');
          if (end > i) { atom += str.slice(i, end + 1); i = end + 1; }
        } else if (i < str.length) { atom += str[i]; i += 1; }
        continue;
      }
      if (/[A-Za-z0-9.'!]/.test(str[i])) { atom += str[i]; i += 1; continue; }
      break;
    }
    if (atom) { tokens.push({ start, end: i, type: 'atom' }); continue; }
    tokens.push({ start: i, end: i + 1, type: 'op' });
    i += 1;
  }
  return tokens;
}

/** 从 slash 向左 / 向右合并连续的 atom（跳过空格），运算符处断开 */
function collectTerm(str, tokens, index, direction) {
  let i = index + direction;
  let start = null;
  let end = null;
  while (i >= 0 && i < tokens.length) {
    const token = tokens[i];
    if (token.type === 'space') { i += direction; continue; }
    if (token.type !== 'atom') break;
    const body = str.slice(token.start, token.end);
    // 积分里的 dx / dV 是微分记号，不能并进分母（教材里写在分式后面）
    if (direction > 0 && start !== null && /^d[A-Za-z]$/.test(body.trim())) break;
    if (direction < 0) {
      start = token.start;
      if (end === null) end = token.end;
    } else {
      if (start === null) start = token.start;
      end = token.end;
    }
    i += direction;
  }
  if (start === null || end === null) return null;
  return { start, end, body: str.slice(start, end).trim() };
}

function stripOuterGroup(text) {
  const value = String(text || '').trim();
  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
    if (value.startsWith(open) && value.endsWith(close) && findClosing(value, 0, open, close) === value.length - 1) {
      return value.slice(1, -1).trim();
    }
  }
  return value;
}

/** 把 a/b 升级为 \frac{a}{b}（只处理「项/项」，教材里分数线是标志性版式） */
function convertFractions(text) {
  let result = text;
  let guard = 0;
  while (guard < 12) {
    guard += 1;
    const tokens = tokenizeMath(result);
    const index = tokens.findIndex((token) => token.type === 'slash');
    if (index < 0) break;
    const left = collectTerm(result, tokens, index, -1);
    const right = collectTerm(result, tokens, index, 1);
    if (!left || !right || !left.body || !right.body) {
      result = `${result.slice(0, tokens[index].start)}\u0001${result.slice(tokens[index].end)}`;
      continue;
    }
    const replacement = `\\frac{${stripOuterGroup(left.body)}}{${stripOuterGroup(right.body)}}`;
    result = `${result.slice(0, left.start)}${replacement}${result.slice(right.end)}`;
  }
  return result.replace(/\u0001/g, '/');
}

/** 集合 / 区间花括号转义成 \{ \}，分组花括号（^ _ \sqrt \frac 的参数）原样保留 */
function escapeSetBraces(tex) {
  let out = '';
  let i = 0;
  while (i < tex.length) {
    const ch = tex[i];
    if (ch === '{') {
      const before = out.replace(/\s+$/, '');
      const prev = before.slice(-1);
      const isGroup = prev === '_' || prev === '^' || prev === '}' || /\\[A-Za-z]+$/.test(before);
      if (isGroup) {
        const close = findClosing(tex, i, '{', '}');
        if (close > i) { out += tex.slice(i, close + 1); i = close + 1; continue; }
      }
      out += '\\{';
      i += 1;
      continue;
    }
    if (ch === '}') { out += '\\}'; i += 1; continue; }
    out += ch;
    i += 1;
  }
  return out;
}

/** 片段是否值得包成公式：纯标点 / 普通英文单词 / 卷面编号一律跳过 */
function isMathFragment(candidate) {
  const text = candidate.trim();
  if (!text || text.length > 240) return false;
  if (NUMBERED_ITEM_RE.test(text)) return false;
  if (!MATH_HINT_RE.test(text)) return false;
  if (!/[A-Za-z0-9\\\u0370-\u03ff]/.test(text) && !/[√∫Σ∑∏∂∞]/.test(text)) return false;
  if (/\u0002|\u0005/.test(text)) return false;
  if (PLAIN_WORD_RE.test(text) && !SKIP_WORDS.has(text)) {
    if (!MATH_FUNCS.includes(text) && !/^(dx|dy|dz|dt|dS|dV|dA)$/.test(text)) return false;
  }
  if (SKIP_WORDS.has(text)) return false;
  if (/https?:\/\/|www\./i.test(text)) return false;
  if (/^[-+=<>|,.!;:'" ]+$/.test(text)) return false;
  // 纯数字（年份、年份日期、数量）用正文体，教材里不会把「2026 年」写成斜体公式
  if (/^\d[\d.,]*$/.test(text)) return false;
  // 章节 / 图 / 公式编号（图 2-7、式（2-60）、表 2-7）是正文编号，不是算式；
  // 包成 $...$ 会被 KaTeX 渲染成减号「2−7」，看起来像公式丢了编号。
  if (/^\d{1,3}\s*[-.．—–]\s*\d{1,3}(?:\s*[（(][a-zA-Z\d][)）])?$/.test(text)) return false;
  return true;
}

/** 单个数学片段 → LaTeX（不含 $ 定界符） */
function fragmentToLatex(raw) {
  let tex = String(raw || '').trim();
  if (!tex) return '';

  // 0. 填空线先占位，免得被当成下标脚本；% 在 LaTeX 里是注释符，必须转义
  tex = tex.replace(/_{3,}|＿＿+/g, BLANK_TOKEN);
  tex = tex.replace(/(?<!\\)%/g, '\\%');

  // 1. 连续 Unicode 上下标
  tex = foldScripts(tex, SUPER_CHARS, SUPER_MAP, '^');
  tex = foldScripts(tex, SUB_CHARS, SUB_MAP, '_');

  // 2. 符号逐字符映射（√ 留给下一步转 \sqrt{}，Σ 按上下文判断求和号 / 曲面记号）
  let mapped = '';
  for (let i = 0; i < tex.length; i += 1) {
    const ch = tex[i];
    if (ch === 'Σ') {
      const tail = tex.slice(i + 1);
      mapped += /^_\{[^}]*=/.test(tail) ? '\\sum ' : '\\Sigma ';
    } else if (SYMBOL_MAP[ch] !== undefined) {
      mapped += SYMBOL_MAP[ch];
    } else {
      mapped += ch;
    }
  }
  tex = mapped;

  // 3. √ → \sqrt{}
  tex = convertRoots(tex);

  // 4. 函数名正体
  MATH_FUNCS.forEach((name) => {
    tex = tex.replace(new RegExp(`(?<![A-Za-z\\\\])${name}(?![A-Za-z])`, 'g'), `\\${name} `);
  });

  // 5. 摘出带上下限的运算符前缀，分式只作用于它后面的被积式 / 通项
  let operatorPrefix = '';
  const prefixMatch = tex.match(TEX_OPERATOR_PREFIX_RE);
  if (prefixMatch) {
    operatorPrefix = prefixMatch[0].trim();
    tex = tex.slice(prefixMatch[0].length).trim();
  }

  // 6. a/b → \frac{a}{b}
  tex = convertFractions(tex);

  // 7. 上标 / 根号里的简单除法也用分数线（积分上限 π/2、√(35/14) 等）
  const upgradeInnerFraction = (part) => part
    .replace(/\^\{\s*(\\[A-Za-z]+|[A-Za-z0-9]+)\s*\/\s*(\\[A-Za-z]+|[A-Za-z0-9]+)\s*\}/g, '^{\\frac{$1}{$2}}')
    .replace(/\\sqrt\{\s*(\\[A-Za-z]+|[A-Za-z0-9]+)\s*\/\s*(\\[A-Za-z]+|[A-Za-z0-9]+)\s*\}/g, '\\sqrt{\\frac{$1}{$2}}');
  tex = upgradeInnerFraction(tex);
  if (operatorPrefix) operatorPrefix = upgradeInnerFraction(operatorPrefix);

  // 8. 集合花括号转义（分组花括号保留）
  tex = escapeSetBraces(tex);

  // 9. 填空线换成教材式下划线
  tex = tex.split(BLANK_TOKEN).join('\\underline{\\hspace{1.6em}}');

  // 10. 空格收敛、微分符号前的细间距，最后把运算符前缀拼回来
  tex = tex.replace(/[ \t]{2,}/g, ' ').trim();
  tex = tex.replace(/(\\[a-zA-Z]+|\}|\))\s?d([VvSsxyzt])/g, '$1\\,d$2');
  if (operatorPrefix) tex = `${operatorPrefix} ${tex}`.trim();
  return tex;
}

/** 把一段纯文本里的数学片段包成 $...$（已含定界符的部分原样保留，保证幂等） */
function wrapMathInLine(line) {
  const placeholders = [];
  let work = String(line || '');

  work = work.replace(/\$\$[\s\S]+?\$\$|(?<!\\)\$[^$\n]+?\$|\\\([^)]*?\\\)|\\\[[^\]]*?\\\]/g, (match) => {
    const key = `\u0002${placeholders.length}\u0002`;
    placeholders.push(match);
    return key;
  });

  // 按「中文 / 中文标点」与「其余字符」切段，公式永远不会吞掉汉字
  const segments = [];
  let buffer = '';
  let mode = null;
  const flush = () => { if (buffer) segments.push({ mode, text: buffer }); buffer = ''; };
  for (const ch of work) {
    const nextMode = CJK_RE.test(ch) || CJK_PUNCT_RE.test(ch) ? 'text' : 'math';
    if (mode && nextMode !== mode) flush();
    mode = nextMode;
    buffer += ch;
  }
  flush();

  let result = segments.map((segment) => {
    if (segment.mode === 'text') return segment.text;
    const trimmed = segment.text.trim();
    if (!trimmed || !isMathFragment(trimmed)) return segment.text;
    // 句读不进公式：$...$ 后接原来的标点，和教材一致
    const tail = trimmed.match(/[.,;:]+$/);
    const core = tail ? trimmed.slice(0, -tail[0].length) : trimmed;
    const tex = fragmentToLatex(core);
    if (!tex) return segment.text;
    if (parseTex) {
      try { parseTex(tex); } catch (_) { return segment.text; } // 解析不了就保留原文，绝不渲染红字
    }
    const offset = segment.text.indexOf(trimmed);
    const leading = segment.text.slice(0, offset);
    const trailing = segment.text.slice(offset + trimmed.length);
    return `${leading}$${tex}$${tail ? tail[0] : ''}${trailing}`;
  }).join('');

  placeholders.forEach((value, index) => {
    result = result.split(`\u0002${index}\u0002`).join(value);
  });
  return result;
}

/**
 * 旧版 MathML / OCR 退化后，中文里可能只剩一个孤立的 ³、₂（如「（1100）₂」「…）³＞…」）。
 * 这些字符前面已经没有底数，无法还原成完整公式，但直接留着 Unicode 又不符合教材排版，
 * 因此转成 KaTeX 可解析的空底上下标 ${}^{3}$ / ${}_{2}$。只对 $...$ 之外的正文生效。
 */
const ORPHAN_SCRIPT_RE = new RegExp(
  `[${SUPER_CHARS.replace(/[[\]\\^-]/g, '\\$&')}]+|[${SUB_CHARS.replace(/[[\]\\^-]/g, '\\$&')}]+`,
  'g'
);
function wrapOrphanScripts(line) {
  const source = String(line || '');
  if (!/[⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉\u02b0-\u02ff]/.test(source)) return source;
  const parts = source.split(/(\$\$[\s\S]+?\$\$|(?<!\\)\$[^$\n]+?\$|\\\([^)]*?\\\)|\\\[[^\]]*?\\\])/g);
  return parts.map((part, index) => {
    if (index % 2 === 1) return part; // 已经是公式
    ORPHAN_SCRIPT_RE.lastIndex = 0;
    return part.replace(ORPHAN_SCRIPT_RE, (run) => {
      const isSuper = SUPER_CHARS.includes(run[0]);
      const map = isSuper ? SUPER_MAP : SUB_MAP;
      const body = [...run].map((ch) => map[ch] || ch).join('');
      if (!/[A-Za-z0-9+\-=()]/.test(body)) return run;
      return isSuper ? ('$' + '{}^{' + body + '}$') : ('$' + '{}_{' + body + '}$');
    });
  }).join('');
}

/** 文本级教材格式：清洗 + 去噪 + 数学公式 LaTeX 化 */
function formatQuestionText(value, role = 'stem') {
  let text = cleanWhitespace(value);
  if (!text) return '';
  if (role === 'stem' || role === 'option') text = stripStemPrefix(text);
  if (role === 'analysis') {
    text = text.split('\n').map((line) => line.replace(ANALYSIS_LABEL_RE, '')).join('\n');
  }

  // 已有 LaTeX 里做符号修补，避免 KaTeX 报未知字符（幂等：只改内容不改定界符）
  text = text.replace(/\$[^$\n]+\$/g, (match) => {
    const inner = match.slice(1, -1)
      .replace(/[−–]/g, '-').replace(/→/g, '\\to ').replace(/∞/g, '\\infty ')
      .replace(/≤/g, '\\le ').replace(/≥/g, '\\ge ').replace(/≠/g, '\\ne ')
      .replace(/×/g, '\\times ').replace(/·/g, '\\cdot ');
    // 旧结果里被误包成公式的章节编号（$2-5$、$2-5(a)$）还原成正文，避免渲染成「2−5」
    if (/^\d{1,3}\s*[-.．—–]\s*\d{1,3}\s*(?:[（(][a-zA-Z\d][)）])?$/.test(inner.trim())) {
      return inner.trim();
    }
    return `$${inner}$`;
  });

  return text.split('\n').map((line) => wrapOrphanScripts(wrapMathInLine(line))).join('\n').trim();
}

/* -------------------------------------------------------------------------- */
/* 教材化 HTML                                                                 */
/* -------------------------------------------------------------------------- */

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 把规范化文本转成教材式段落 HTML */
function toTextbookHtml(text, role = 'stem') {
  const value = String(text || '').trim();
  if (!value) return '';
  return value.split(/\n{2,}/).map((block) => {
    const lines = block.split('\n').map((line) => {
      const safe = escapeHtml(line).replace(/_{6,}/g, '<span class="tb-blank" aria-label="填空"></span>');
      return safe;
    });
    return `<p class="tb-p tb-${role}">${lines.join('<br/>')}</p>`;
  }).join('');
}

/** 完整解码 HTML 实体，保证「解码 → 格式化 → 编码」反复执行不会把 & 越滚越多 */
function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&(quot|apos);/gi, (_, name) => (name.toLowerCase() === 'quot' ? '"' : "'"))
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

/** 已有 HTML（含图片 / 表格 / MathML）只清洗文本节点，保留标签结构 */
function formatExistingHtml(html, role = 'stem') {
  const raw = String(html || '').trim();
  if (!raw) return '';
  return raw.split(/(<[^>]+>)/g).map((part) => {
    if (/^<[^>]+>$/.test(part)) {
      // 保留 class（tb-* 教材版式类），只剥掉会覆盖统一版式的内联样式
      return part.replace(/\s(?:style|id|lang|face|color|size|align)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    }
    if (!part.trim()) return part;
    const decoded = decodeHtmlEntities(part);
    return escapeHtml(formatQuestionText(decoded, role))
      .replace(/_{6,}/g, '<span class="tb-blank" aria-label="填空"></span>');
  }).join('');
}

const RICH_HTML_RE = /<(?:img|table|math|svg|iframe|picture)\b/i;

/** 规范化一道题的全部文本字段（幂等） */
function formatQuestionForStorage(input = {}) {
  if (!input || typeof input !== 'object') return input;
  const q = { ...input };
  const type = String(q.type || '').toLowerCase();
  const isObjective = ['single', 'multiple', 'judge'].includes(type);

  // 题干只认纯文本字段；没有纯文本时才从 HTML 里剥标签取字，避免把 <p> 当正文
  let stem = cleanWhitespace(q.content || '');
  if (!stem && (q.content_html || q.contentHtml)) {
    stem = cleanWhitespace(String(q.content_html || q.contentHtml).replace(/<[^>]+>/g, ' '));
  }

  const blocks = splitStemBlocks(stem);
  let answer = q.answer === undefined || q.answer === null ? '' : String(q.answer);
  let analysis = q.analysis === undefined || q.analysis === null ? '' : String(q.analysis);
  if (blocks.answer && !answer.trim()) answer = blocks.answer;
  if (blocks.analysis && !analysis.trim()) analysis = blocks.analysis;

  // 题干里混进来的选项：options 为空时提成选项，否则丢弃（避免教材里重复出现 A. B.）
  let options = normalizeOptions(q.options);
  if (blocks.options.length >= 2 && !options.length) options = blocks.options;
  stem = blocks.stem;

  q.content = formatQuestionText(stem, 'stem');
  q.options = options.map((opt) => ({
    ...opt,
    key: String(opt.key || '').toUpperCase(),
    content: formatQuestionText(String(opt.content || '').replace(/^\s*[A-H]\s*[.．、)）:：]\s*/, ''), 'option'),
  }));

  // 客观题答案只留选项字母；主观 / 填空答案是文本（公式要保留大小写，不能被 toUpperCase 毁掉）
  if (isObjective) {
    const raw = answer.trim();
    if (type === 'judge' && /^(正确|对|是|√|✓|true|t|a)$/i.test(raw)) q.answer = 'A';
    else if (type === 'judge' && /^(错误|错|否|×|✗|false|f|b)$/i.test(raw)) q.answer = 'B';
    else {
      const letters = [...new Set(raw.toUpperCase().replace(/[^A-H]/g, '').split(''))].sort().join('');
      // 题型标错或用数字作答时，宁可原样保留，也不要把答案清空
      q.answer = letters || cleanWhitespace(raw);
    }
  } else {
    q.answer = formatQuestionText(answer, 'answer').trim();
  }

  q.analysis = formatQuestionText(analysis, 'analysis');

  const sourceHtml = q.content_html || q.contentHtml || '';
  q.content_html = RICH_HTML_RE.test(sourceHtml)
    ? formatExistingHtml(sourceHtml, 'stem')
    : toTextbookHtml(q.content, 'stem');
  q.contentHtml = q.content_html;

  const sourceAnalysisHtml = q.analysis_html || q.analysisHtml || '';
  q.analysis_html = RICH_HTML_RE.test(sourceAnalysisHtml)
    ? formatExistingHtml(sourceAnalysisHtml, 'analysis')
    : (q.analysis ? toTextbookHtml(q.analysis, 'analysis') : '');
  q.analysisHtml = q.analysis_html;

  if (q.material_html || q.materialHtml || q.material) {
    const material = q.material_html || q.materialHtml || '';
    q.material_html = RICH_HTML_RE.test(material)
      ? formatExistingHtml(material, 'material')
      : toTextbookHtml(formatQuestionText(String(q.material || material).replace(/<[^>]+>/g, ' '), 'material'), 'material');
    q.materialHtml = q.material_html;
  }

  q.textbook_format_version = TEXTBOOK_FORMAT_VERSION;
  return q;
}

function normalizeOptions(options) {
  let list = options;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch (_) { return []; }
  }
  if (!Array.isArray(list)) return [];
  return list.filter((item) => item && typeof item === 'object').map((item, index) => ({
    key: String(item.key || String.fromCharCode(65 + index)).toUpperCase(),
    content: String(item.content ?? item.text ?? ''),
  })).filter((item) => item.content.trim());
}

/** 答案表条目（AI 识别答案 / 文本答案）：保留题号，答案与解析走教材格式 */
function formatAnswerForStorage(input = {}) {
  if (!input || typeof input !== 'object') return input;
  const a = { ...input };
  if (a.answer !== undefined) {
    const raw = String(a.answer || '').trim();
    a.answer = /^[A-H]{1,4}$/i.test(raw) ? raw.toUpperCase() : formatQuestionText(raw, 'answer');
  }
  if (a.analysis !== undefined) a.analysis = formatQuestionText(a.analysis, 'analysis');
  return a;
}

/** 题目—答案匹配结果：answer 是字母，analysis 是解析正文 */
function formatMatchForStorage(input = {}) {
  if (!input || typeof input !== 'object') return input;
  const m = { ...input };
  if (m.answer !== undefined) {
    const raw = String(m.answer || '').trim();
    m.answer = /^[A-H]{1,4}$/i.test(raw) ? raw.toUpperCase() : formatQuestionText(raw, 'answer');
  }
  if (m.analysis !== undefined) m.analysis = formatQuestionText(m.analysis, 'analysis');
  if (m.reason !== undefined) m.reason = formatQuestionText(m.reason, 'analysis');
  return m;
}

function formatQuestions(list) {
  return Array.isArray(list) ? list.map((item) => formatQuestionForStorage(item)) : list;
}
function formatAnswers(list) {
  return Array.isArray(list) ? list.map((item) => formatAnswerForStorage(item)) : list;
}
function formatMatches(list) {
  return Array.isArray(list) ? list.map((item) => formatMatchForStorage(item)) : list;
}

/** AI 识别 / 生成结果的统一出口：题目、答案表、匹配表都先格式化再交给渲染层 */
function formatAIResult(result) {
  if (!result || typeof result !== 'object') return result;
  const next = { ...result };
  if (Array.isArray(next.questions)) next.questions = formatQuestions(next.questions);
  if (Array.isArray(next.answers)) next.answers = formatAnswers(next.answers);
  if (Array.isArray(next.matches)) next.matches = formatMatches(next.matches);
  return next;
}

/**
 * 存量数据库行 → 需要 UPDATE 的字段补丁。
 * 返回 null 表示这一行已经是新格式，无需改动。
 */
function formatQuestionRow(row = {}) {
  if (!row || Number(row.textbook_format_version || 0) >= TEXTBOOK_FORMAT_VERSION) return null;
  const patch = formatQuestionForStorage({
    type: row.type,
    content: row.content,
    content_html: row.content_html,
    options: row.options,
    answer: row.answer,
    analysis: row.analysis,
    analysis_html: row.analysis_html,
    material_html: row.material_html,
  });
  return {
    content: patch.content,
    content_html: patch.content_html || null,
    options: JSON.stringify(patch.options || []),
    answer: patch.answer ?? '',
    analysis: patch.analysis || '',
    analysis_html: patch.analysis_html || null,
    material_html: patch.material_html || row.material_html || null,
    textbook_format_version: TEXTBOOK_FORMAT_VERSION,
  };
}

module.exports = {
  TEXTBOOK_FORMAT_VERSION,
  TEXTBOOK_FORMAT_GUIDE,
  cleanWhitespace,
  stripStemPrefix,
  splitStemBlocks,
  fragmentToLatex,
  formatQuestionText,
  toTextbookHtml,
  formatExistingHtml,
  formatQuestionForStorage,
  formatAnswerForStorage,
  formatMatchForStorage,
  formatQuestions,
  formatAnswers,
  formatMatches,
  formatAIResult,
  formatQuestionRow,
};
