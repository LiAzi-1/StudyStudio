'use strict';
/**
 * Obsidian 数学公式（LaTeX / MathJax）书写规范与正文规范化 —— Node 侧。
 *
 * 与 obsidian/oe_math.py 是同一份规范的两个实现：
 *   MATH_STYLE_PROMPT 给所有会写笔记的模型看；
 *   normalizeMath()    在正文落库 / 落盘前兜底统一格式。
 * scripts/verify-latex-format.js 会检查两边的规范文本逐字一致、行为一致。
 *
 * Obsidian 原生用 MathJax 渲染 $...$ / $$...$$，不需要任何插件。
 */

const MATH_STYLE_PROMPT = String.raw`
【数学公式格式 · Obsidian / MathJax，必须遵守】
1. 所有数学内容（变量、方程、分式、根式、上下标、希腊字母、运算符）一律写成 LaTeX：
   - 行内公式用单美元符号包裹：$W = v \times t$；
   - 重要公式独立成块，用双美元符号单独占行，前后各留一个空行：
     $$
     G(s) = \frac{Y(s)}{R(s)}
     $$
2. 只用 Obsidian 内置 MathJax 支持的标准命令：\frac{a}{b}、\times、\div、\cdot、\sqrt{x}、x^{2}、x_{i}、\sum、\int、\lim、\alpha~\omega 等希腊字母、\approx、\leq、\geq、\neq、\pm、\infty、\text{...}、\begin{aligned}...\end{aligned}。
   不要写 \usepackage、\newcommand、\ce 等需要宏包或插件的命令；不要用 \(...\)、\[...\] 或代码块包公式。
3. 中文说明放在公式外面；必须进公式时用 \text{中文}。
   正确：$W = v \times t$（工作量 = 效率 × 时间）
   错误：$工作量 = 效率 \times 时间$
4. 定界符里只放数学，不要把单位、中文或说明文字吞进去：
   正确：需要 $\frac{24}{7} \approx 3.4$ 小时；错误：$\frac{24}{7 \approx 3.4}$、$24/7 ≈ 3.4 小时$。
   $...$ 内不要用 ≈ × ÷ ² 等 Unicode 符号，一律换成 LaTeX 命令。
5. 题目、选项、解析里的公式同样按上述规则写；「## 例题」章节的「答案：」「解析：」「知识点：」「难度：」等字段保持可解析的纯文本格式，只有其中的数学部分用 $...$。
6. 不改动原文里已有的正确 LaTeX；不要给公式加编号、代码块或 HTML 标签。`;

/* ---------------------------------------------------------------- 常量 */

// 公式环境内可以无损替换的 Unicode 字符 → LaTeX 命令
const UNICODE_OPS = {
  '×': '\\times ', '÷': '\\div ', '·': '\\cdot ', '⋅': '\\cdot ',
  '≈': '\\approx ', '≠': '\\neq ', '≤': '\\leq ', '≥': '\\geq ',
  '±': '\\pm ', '∓': '\\mp ', '∞': '\\infty ', '∝': '\\propto ',
  '→': '\\to ', '←': '\\leftarrow ', '⇒': '\\Rightarrow ',
  '∈': '\\in ', '∉': '\\notin ', '⊂': '\\subset ',
  '−': '-', '–': '-', '‐': '-',
  'π': '\\pi ', 'α': '\\alpha ', 'β': '\\beta ', 'γ': '\\gamma ',
  'δ': '\\delta ', 'ε': '\\epsilon ', 'ζ': '\\zeta ', 'η': '\\eta ',
  'θ': '\\theta ', 'λ': '\\lambda ', 'μ': '\\mu ', 'ν': '\\nu ',
  'ξ': '\\xi ', 'ρ': '\\rho ', 'σ': '\\sigma ', 'τ': '\\tau ',
  'φ': '\\phi ', 'χ': '\\chi ', 'ψ': '\\psi ', 'ω': '\\omega ',
  'Δ': '\\Delta ', 'Σ': '\\Sigma ', 'Ω': '\\Omega ', 'Γ': '\\Gamma ',
  'Π': '\\Pi ', 'Θ': '\\Theta ', 'Φ': '\\Phi ',
};

const SUPERSCRIPTS = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const SUBSCRIPTS = '₀₁₂₃₄₅₆₇₈₉';

// 自动替换不干净、需要提示作者的符号
const AMBIGUOUS = { '√': '\\sqrt{}', '∑': '\\sum', '∫': '\\int', '∂': '\\partial' };

const CODE_FENCE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]*`/g;
const OLD_INLINE = /\\\((.*?)\\\)/gs;
const OLD_BLOCK = /\\\[(.*?)\\\]/gs;
const BLOCK_MATH = /\$\$(.+?)\$\$/gs;
const MATH_TOKEN = /\$\$(.+?)\$\$|\$(?!\$)(.+?)(?<!\\)\$(?!\$)/gs;
const CJK = /[\u4e00-\u9fff]/;
const SUSPECT_FRAC = /\\frac\s*\{[^{}]*?(?:\\approx|[\u4e00-\u9fff=<>])[^{}]*?\}\s*\{[^{}]*?\}|\\frac\s*\{[^{}]*?\}\s*\{[^{}]*?(?:\\approx|[\u4e00-\u9fff=<>])[^{}]*?\}/;
const BAD_MACRO = /\\(?:usepackage|newcommand|renewcommand|ce)\b/;

/** 代码块里的 $ 和 × 不是公式，先挖出来，处理完再原样回填 */
function protectCode(text) {
  const holes = [];
  const stash = (chunk) => {
    holes.push(chunk);
    return `\u0000CODE${holes.length - 1}\u0000`;
  };
  let out = text.replace(CODE_FENCE, stash).replace(INLINE_CODE, stash);
  return { text: out, holes };
}

function restoreCode(text, holes) {
  let out = text;
  holes.forEach((original, index) => {
    out = out.split(`\u0000CODE${index}\u0000`).join(original);
  });
  return out;
}

/** 把公式体内的 Unicode 运算符、希腊字母、上下标换成 LaTeX 命令 */
function convertOps(inner) {
  let out = '';
  for (const char of inner) {
    if (Object.prototype.hasOwnProperty.call(UNICODE_OPS, char)) out += UNICODE_OPS[char];
    else if (SUPERSCRIPTS.includes(char)) out += `^{${SUPERSCRIPTS.indexOf(char)}}`;
    else if (SUBSCRIPTS.includes(char)) out += `_{${SUBSCRIPTS.indexOf(char)}}`;
    else out += char;
  }
  // \times 这类命令后必须留一个空格分隔，但在括号 / 上下标 / 结尾前多余，收掉
  return out.replace(/(\\[a-zA-Z]+) +(?=[}\]$)_^])/g, '$1').replace(/ {2,}/g, ' ');
}

/** $$...$$ 一律独立成段，避免和正文挤在一行导致 MathJax 不渲染 */
function normalizeBlocks(text) {
  return text.replace(BLOCK_MATH, (_all, inner) => `\n\n$$\n${inner.trim()}\n$$\n\n`);
}

function check(text) {
  const warnings = [];
  const add = (message) => { if (!warnings.includes(message)) warnings.push(message); };
  for (const match of text.matchAll(MATH_TOKEN)) {
    const inner = match[1] || match[2] || '';
    if (CJK.test(inner.replace(/\\text\{[^{}]*\}/g, ''))) {
      add('公式里含中文：中文说明请移到 $...$ 外，或写成 \\text{...}');
    }
    for (const [symbol, command] of Object.entries(AMBIGUOUS)) {
      if (inner.includes(symbol)) add(`公式里还有 Unicode 符号「${symbol}」，请改写成 ${command} 形式`);
    }
    if (SUSPECT_FRAC.test(inner)) {
      add('疑似把说明文字吞进了 \\frac{}{}：$...$ 里只放数学，单位与中文放外面');
    }
  }
  if (BAD_MACRO.test(text)) add('出现了 MathJax 不支持的宏包命令（\\usepackage / \\newcommand / \\ce）');
  // 去掉块级公式后，剩余的 $ 必须成对
  const rest = text.replace(BLOCK_MATH, '');
  if ((rest.match(/(?<!\\)\$/g) || []).length % 2) {
    add('行内公式的 $ 没有成对闭合，Obsidian 里会显示成源码');
  }
  return warnings;
}

/**
 * 规范一篇 Markdown 正文里的数学公式。
 * 保守策略：只改写确定等价的写法；语义可疑的留给模型/作者，只告警。
 * 幂等：对结果重复调用不会再改动正文。
 * @returns {{text: string, warnings: string[]}}
 */
function normalizeMath(input) {
  const original = String(input ?? '');
  if (!original) return { text: original, warnings: [] };
  let { text, holes } = protectCode(original);
  const hasOldBlock = text.search(OLD_BLOCK) >= 0;
  const hasOldInline = text.search(OLD_INLINE) >= 0;
  text = text.replace(OLD_BLOCK, (_all, inner) => `$$${inner}$$`);
  text = text.replace(OLD_INLINE, (_all, inner) => `$${inner}$`);
  text = normalizeBlocks(text);
  // 全文没有公式时原样返回：不能因为统一换行把不含数学的正文也改一遍
  if (!hasOldBlock && !hasOldInline && text.search(MATH_TOKEN) < 0) {
    return { text: original, warnings: check(text) };
  }
  text = text.replace(MATH_TOKEN, (_all, block, inline) => {
    const isBlock = block !== undefined;
    const converted = convertOps(isBlock ? block : inline);
    return isBlock ? `$$\n${converted.trim()}\n$$` : `$${converted}$`;
  });
  const warnings = check(text);
  text = restoreCode(text, holes).replace(/\n{3,}/g, '\n\n');
  return { text, warnings };
}

module.exports = { MATH_STYLE_PROMPT, normalizeMath, MATH_STYLE: MATH_STYLE_PROMPT };
