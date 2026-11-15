import React, { useMemo } from 'react';
import katex from 'katex';

const HTML_RE = /<[^>]+>/;
// 格式层只允许 tb-* 教材版式类与 MathML 降级标记，避免题库 HTML 塞进任意 class 破坏排版
const SAFE_CLASS_RE = /^(?:math-plain|tb-[\w-]+|katex(?:-[\w-]+)?)$/;
// $...$ 行内、$$...$$ 独立成行，兼容旧 OCR 常见的 \(...\) / \[...\]
const MATH_DELIMITER_RE = /\$\$([\s\S]+?)\$\$|(?<!\\)\$([^$\n]+?)\$|\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g;
const ALLOWED_TAGS = new Set(['p', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 'br', 'img', 'sup', 'sub', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'colgroup', 'col', 'ul', 'ol', 'li']);
const IMG_ATTRS = new Set(['src', 'alt', 'width', 'height', 'flag']);
const TABLE_ATTRS = new Set(['colspan', 'rowspan', 'width', 'height', 'align']);
const MATH_TAGS = new Set([
  'math', 'mrow', 'mi', 'mn', 'mo', 'ms', 'mtext', 'mspace',
  'mfrac', 'msup', 'msub', 'msubsup', 'mroot', 'msqrt',
  'mstyle', 'mpadded', 'mphantom', 'menclose', 'semantics', 'annotation',
]);
const SUPERSCRIPT_MAP = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
  'n': 'ⁿ', 'i': 'ⁱ',
};
const SUBSCRIPT_MAP = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
  '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
  'a': 'ₐ', 'e': 'ₑ', 'o': 'ₒ', 'x': 'ₓ', 'i': 'ᵢ', 'n': 'ₙ',
};

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return '';
  // 内联图片只放行 image/* 的 base64 data URL
  if (/^data:image\/(png|jpe?g|gif|webp|bmp|svg\+xml);base64,/i.test(url)) return url;
  // 带协议的 URL 只放行本地资源协议与 http(s)，其余（javascript: / file: / vbscript: …）一律丢弃
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    const scheme = url.slice(0, url.indexOf(':')).toLowerCase();
    return scheme === 'http' || scheme === 'https' || scheme === 'openexam-asset' ? url : '';
  }
  // 无协议的相对路径保持原样
  return url;
}

function mapChars(value, map) {
  return String(value || '')
    .split('')
    .map((ch) => map[ch] || ch)
    .join('');
}

function mathChildren(node) {
  return Array.from(node.childNodes || []).filter((child) => {
    if (child.nodeType === 3) return String(child.textContent || '').trim().length > 0;
    if (child.nodeType !== 1) return false;
    const tag = child.tagName.toLowerCase();
    if (tag === 'annotation') return false;
    return true;
  });
}

function serializeMathNode(node) {
  if (!node) return '';
  if (node.nodeType === 3) return String(node.textContent || '').replace(/\s+/g, ' ');
  if (node.nodeType !== 1) return '';

  const tag = node.tagName.toLowerCase();
  const kids = mathChildren(node);

  if (tag === 'annotation') return '';
  if (tag === 'mfrac') {
    const num = serializeMathNode(kids[0]).trim() || '?';
    const den = serializeMathNode(kids[1]).trim() || '?';
    const wrap = (part) => (/^[A-Za-z0-9.]+$/.test(part) ? part : `(${part})`);
    return `${wrap(num)}/${wrap(den)}`;
  }
  if (tag === 'msup') {
    const base = serializeMathNode(kids[0]).trim();
    const exp = serializeMathNode(kids[1]).trim();
    return `${base}${mapChars(exp, SUPERSCRIPT_MAP)}`;
  }
  if (tag === 'msub') {
    const base = serializeMathNode(kids[0]).trim();
    const sub = serializeMathNode(kids[1]).trim();
    return `${base}${mapChars(sub, SUBSCRIPT_MAP)}`;
  }
  if (tag === 'msubsup') {
    const base = serializeMathNode(kids[0]).trim();
    const sub = serializeMathNode(kids[1]).trim();
    const exp = serializeMathNode(kids[2]).trim();
    return `${base}${mapChars(sub, SUBSCRIPT_MAP)}${mapChars(exp, SUPERSCRIPT_MAP)}`;
  }
  if (tag === 'msqrt') {
    return `√(${serializeMathNode(kids[0]).trim()})`;
  }
  if (tag === 'mroot') {
    const base = serializeMathNode(kids[0]).trim();
    const idx = serializeMathNode(kids[1]).trim();
    return `${mapChars(idx, SUPERSCRIPT_MAP)}√(${base})`;
  }
  if (tag === 'mo' || tag === 'mi' || tag === 'mn' || tag === 'ms' || tag === 'mtext') {
    return String(node.textContent || '').replace(/\s+/g, ' ');
  }

  return kids.map((child) => serializeMathNode(child)).join('');
}

function convertMathMl(root) {
  // KaTeX 自带的 .katex-mathml 是渲染结果，不能再降级成纯文本
  const mathNodes = Array.from(root.querySelectorAll('math'))
    .filter((node) => !node.closest || !node.closest('.katex'));
  mathNodes.forEach((mathNode) => {
    const plain = serializeMathNode(mathNode).replace(/\s+/g, ' ').trim();
    const span = mathNode.ownerDocument.createElement('span');
    span.setAttribute('class', 'math-plain');
    span.textContent = plain || '';
    mathNode.replaceWith(span);
  });

  // Safety: unwrap any leftover MathML tags that escaped conversion.
  Array.from(root.querySelectorAll('*')).forEach((el) => {
    const tag = el.tagName.toLowerCase();
    if (!MATH_TAGS.has(tag) || (el.closest && el.closest('.katex'))) return;
    const span = el.ownerDocument.createElement('span');
    span.setAttribute('class', 'math-plain');
    span.textContent = String(el.textContent || '').replace(/\s+/g, ' ').trim();
    el.replaceWith(span);
  });
}

/**
 * 只把「看起来像公式」的 $...$ 交给 KaTeX。
 * 英文题干里常有价格写法（cost $5 and $10），两个 $ 之间的自然语言必须保持正文。
 */
export function isLikelyTex(tex) {
  const text = String(tex || '').trim();
  if (!text) return false;
  if (/[\\^_{}=]/.test(text)) return true;              // LaTeX 命令、上下标、分组、等号
  if (/^[\d.,]+$/.test(text)) return true;              // 纯数字（$5$ 之类）
  if (/[0-9]/.test(text) && /[+\-*/<>]/.test(text)) return true; // 有运算符的算式
  // 无命令也无运算符时，「空格 + 英文单词」说明是价格 / 正文（cost $5 and $10）
  if (/\s[A-Za-z]{2,}/.test(text)) return false;
  return /^[\sA-Za-z0-9.,()+\-*/<>:]+$/.test(text);     // x、x + y、f(x)
}

/** 把一段 TeX 渲染成 KaTeX HTML；解析失败返回空串，调用方保留原文，绝不显示红字报错。 */
function texToHtml(tex, displayMode) {
  try {
    return katex.renderToString(String(tex || '').trim(), {
      displayMode,
      output: 'htmlAndMathml',
      throwOnError: true,
      strict: 'ignore',
      trust: false,
    });
  } catch (_) {
    return '';
  }
}

/**
 * 在「已经过白名单清洗」的 HTML 里渲染数学公式。
 * 只处理文本节点，所以 img 的 src / alt、表格属性里的 $ 都不会被误伤；
 * KaTeX 的 HTML 在清洗之后注入，不会被 sanitize 二次剥掉 MathML 结构。
 */
function renderMathInHtml(html) {
  if (!html || typeof DOMParser === 'undefined' || !/\$|\\\(|\\\[/.test(html)) return html;
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild || doc.body;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  let changed = false;
  textNodes.forEach((node) => {
    const source = String(node.data || '');
    if (!/\$|\\\(|\\\[/.test(source)) return;
    MATH_DELIMITER_RE.lastIndex = 0;
    const fragment = doc.createDocumentFragment();
    let cursor = 0;
    let hit = false;
    let match;
    while ((match = MATH_DELIMITER_RE.exec(source)) !== null) {
      const tex = match[1] ?? match[2] ?? match[3] ?? match[4];
      const displayMode = match[1] !== undefined || match[4] !== undefined;
      // 只有裸 $...$ 需要判别；$$...$$ / \(...\) / \[...\] 是明确的公式定界符
      const looksLikeMath = match[2] === undefined || isLikelyTex(tex);
      const rendered = tex && looksLikeMath ? texToHtml(tex, displayMode) : '';
      // 解析失败 / 不是公式的内容保持原样（cursor 不推进，后面会作为普通文本输出）
      if (!rendered) continue;
      if (match.index > cursor) {
        fragment.appendChild(doc.createTextNode(source.slice(cursor, match.index).replace(/\\\$/g, '$')));
      }
      const holder = doc.createElement('span');
      holder.innerHTML = rendered;
      while (holder.firstChild) fragment.appendChild(holder.firstChild);
      cursor = match.index + match[0].length;
      hit = true;
    }
    if (!hit) return;
    if (cursor < source.length) {
      fragment.appendChild(doc.createTextNode(source.slice(cursor).replace(/\\\$/g, '$')));
    }
    node.replaceWith(fragment);
    changed = true;
  });

  return changed ? root.innerHTML : html;
}

/**
 * 纯文本（不是 HTML）里渲染公式：转义后按同一套定界符交给 KaTeX。
 * 与 sanitizeHtml 的区别是不做 trim，聊天消息里以空格分隔的片段不会粘在一起。
 */
export function renderMathText(value) {
  return renderMathInHtml(escapeHtml(String(value || '')).replace(/\n/g, '<br/>'));
}

export function sanitizeHtml(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  if (!HTML_RE.test(input)) return renderMathInHtml(escapeHtml(input).replace(/\n/g, '<br/>'));
  if (typeof DOMParser === 'undefined') return renderMathInHtml(escapeHtml(input).replace(/\n/g, '<br/>'));

  const doc = new DOMParser().parseFromString(`<div>${input}</div>`, 'text/html');
  const root = doc.body.firstElementChild || doc.body;
  convertMathMl(root);

  const walk = (node) => {
    Array.from(node.childNodes).forEach((child) => {
      if (child.nodeType !== 1) return;
      // 已是 KaTeX 渲染结果时整棵保留，避免把 MathML / .katex-html 的结构拆散
      if (child.classList && child.classList.contains('katex')) return;
      walk(child);
      const tag = child.tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) {
        while (child.firstChild) node.insertBefore(child.firstChild, child);
        child.remove();
        return;
      }
      Array.from(child.attributes).forEach((attr) => {
        const name = attr.name.toLowerCase();
        if (tag === 'img' && IMG_ATTRS.has(name)) return;
        if (['td', 'th'].includes(tag) && TABLE_ATTRS.has(name)) return;
        if (name === 'class' && ['span', 'p', 'div', 'table', 'tr', 'td', 'th'].includes(tag)) {
          const safe = String(attr.value || '').split(/\s+/)
            .filter((cls) => SAFE_CLASS_RE.test(cls)).join(' ');
          if (safe) { child.setAttribute('class', safe); return; }
        }
        if (tag === 'span' && name === 'aria-label' && attr.value === '填空') return;
        child.removeAttribute(attr.name);
      });
      if (tag === 'img') {
        const src = normalizeUrl(child.getAttribute('src'));
        if (!src) {
          child.remove();
          return;
        }
        child.setAttribute('src', src);
        child.setAttribute('loading', 'lazy');
      }
    });
  };

  walk(root);
  return renderMathInHtml(root.innerHTML.trim());
}

export function mathMlToPlainText(value = '') {
  const input = String(value || '');
  if (!input || !/<math[\s>]/i.test(input) || typeof DOMParser === 'undefined') {
    return input;
  }
  const doc = new DOMParser().parseFromString(`<div>${input}</div>`, 'text/html');
  const root = doc.body.firstElementChild || doc.body;
  convertMathMl(root);
  return root.textContent || '';
}

const PREVIEW_SYMBOLS = {
  to: '→', infty: '∞', partial: '∂', le: '≤', ge: '≥', ne: '≠', times: '×',
  cdot: '·', pi: 'π', alpha: 'α', beta: 'β', gamma: 'γ', theta: 'θ',
  sigma: 'σ', omega: 'ω', Delta: 'Δ', approx: '≈', pm: '±', cdots: '…',
};
const PREVIEW_OPERATORS = {
  lim: 'lim', sum: 'Σ', prod: 'Π', int: '∫', iint: '∬', iiint: '∭', oint: '∮',
};

/** 折叠态 / 列表摘要用：把 $...$ 里的 LaTeX 粗略还原成可读文本，不渲染公式。 */
function simplifyTex(tex) {
  // 先把简单上下标的分组花括号收掉，\frac{a}{x^{3}} 这类才能被下面的正则识别
  let out = String(tex || '')
    .replace(/\^\{\s*([^{}]*?)\s*\}/g, '^$1')
    .replace(/_\{\s*([^{}]*?)\s*\}/g, '_$1');
  for (let i = 0; i < 4; i += 1) {
    const next = out
      .replace(/\\frac\s*\{\s*([^{}]*?)\s*\}\s*\{\s*([^{}]*?)\s*\}/g, '($1)/($2)')
      .replace(/\\sqrt\s*\{\s*([^{}]*?)\s*\}/g, '√($1)');
    if (next === out) break;
    out = next;
  }
  return out
    .replace(/\\underline\s*\{\s*\\hspace\s*\{[^}]*\}\s*\}/g, '______')
    .replace(/\\(lim|sum|prod|int|iint|iiint|oint)\b/g, (_, name) => PREVIEW_OPERATORS[name] || name)
    .replace(/\\([a-zA-Z]+)/g, (_, name) => PREVIEW_SYMBOLS[name] ?? name)
    .replace(/[{}]/g, '')
    .replace(/\\[,;!]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function mathToPlainText(value = '') {
  const input = String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
  const plain = input
    .replace(/\$\$([\s\S]*?)\$\$|\$([^$\n]*?)\$|\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g,
      (_, display, inline, inlineOld, displayOld) => simplifyTex(display ?? inline ?? inlineOld ?? displayOld ?? ''));
  return plain.replace(/[ \t]+/g, ' ').trim();
}

// 题目字体大小：调用方传入的内联数字字号（如做题页题干 14、选项 13）
// 统一包上 --question-font-scale 变量，让「设置 → 显示设置」只放大题目文字。
// 没传内联字号的调用方由 styles.css 里 .rich-question-content 的 calc 规则负责缩放，
// 两种来源互斥（内联优先级更高），不会出现双重缩放。
const QUESTION_FONT_SCALE_EXPR = 'var(--question-font-scale, 1)';

function applyQuestionFontScale(style) {
  if (!style || typeof style.fontSize !== 'number') return style;
  return { ...style, fontSize: `calc(${style.fontSize}px * ${QUESTION_FONT_SCALE_EXPR})` };
}

export default function RichQuestionContent({ value = '', className = '', style = undefined }) {
  const html = useMemo(() => sanitizeHtml(value), [value]);
  if (!html) return null;
  return <div className={`rich-question-content ${className}`.trim()} style={applyQuestionFontScale(style)} dangerouslySetInnerHTML={{ __html: html }} />;
}
