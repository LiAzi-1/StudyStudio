'use strict';

/**
 * 教材文本质量（乱码 / 损坏文字层）检测与修复。
 *
 * 很多中文教材 PDF 带有一层「幽灵文字层」：每个真实字之间被塞进一个固定乱码字符
 * （常见是某个 CJK 占位字，实测见过「睏」U+770F），或者文字层整体错位。直接读这层
 * 会得到每字间隔的垃圾，既无法生成知识清单，也提取不出题目。标准 Tofu 字符（U+FFFD）
 * 只是一部分情况，这里同时检测「单一异常字符高频出现」这种更隐蔽的损坏。
 *
 * 更隐蔽的一种情况：损坏发生在 PDF 的「可见内容流」里（而非隐藏文字层）。这时即便把
 * 页面渲染成图片交给识图模型，模型也会把那些幽灵字一起抄下来。实测只要把这些异常高频的
 * 幽灵字整体剔除，剩下的就是干净的原文。所以本模块同时提供检测（textQuality）与修复
 * （repairGhostText），让流水线在读取/落盘时自动救回这类教材。
 *
 * 该模块同时被渲染进程（ESM，Vite 打包）与主进程（CommonJS，require）使用，
 * 因此导出采用「ESM export + 兜底 module.exports」双兼容写法。
 */

const REPLACEMENT_CHAR = '�'; // U+FFFD
const CJK_RANGE = /[㐀-䶿一-鿿豈-﫿]/;

// 评估乱码至少需要这么多正文（CJK）字符，避免短文本里某个字占比高造成的误判
const MIN_CJK_FOR_GHOST_CHECK = 40;
// 单一 CJK 字符占全部 CJK 字符的比例超过这个阈值，判定为幽灵文字层
const GHOST_CHAR_RATIO = 0.1;
// 标准 Tofu / 替换字符占全部非空白字符的比例阈值
const TOFU_RATIO = 0.02;

function isCJK(ch) {
  return CJK_RANGE.test(ch);
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} input
 * @returns {{ corrupt:boolean, ghost:boolean, tofuCorrupt:boolean, score:number, topChar:string, topShare:number, cjk:number, tofu:number }}
 */
function textQuality(input) {
  const compact = String(input == null ? '' : input).replace(/\s+/g, '');
  const len = compact.length;
  if (!len) return { corrupt: false, ghost: false, tofuCorrupt: false, score: 0, topChar: '', topShare: 0, cjk: 0, tofu: 0 };

  let tofu = 0;
  let cjk = 0;
  const freq = Object.create(null);
  for (const ch of compact) {
    if (ch === REPLACEMENT_CHAR) { tofu += 1; continue; }
    if (isCJK(ch)) {
      cjk += 1;
      freq[ch] = (freq[ch] || 0) + 1;
    }
  }

  let top = 0;
  let topChar = '';
  for (const key in freq) {
    if (freq[key] > top) { top = freq[key]; topChar = key; }
  }
  const topShare = cjk ? top / cjk : 0;

  // 文字层太短时不做幽灵字符判定（短标题里某个字占比高是正常的）
  const ghost = cjk >= MIN_CJK_FOR_GHOST_CHECK && topShare > GHOST_CHAR_RATIO;
  const tofuCorrupt = len > 0 && tofu / len > TOFU_RATIO;
  const corrupt = ghost || tofuCorrupt;
  const score = Math.max(tofu / len, topShare);

  return { corrupt, ghost, tofuCorrupt, score, topChar, topShare, cjk, tofu };
}

function isCorruptText(text) {
  return textQuality(text).corrupt;
}

/**
 * 修复「幽灵文字层」：把异常高频的单个幽灵字符整体剔除，其余文字原样保留。
 *
 * 只有确认是「单一异常字符高频出现」（ghost = true）时才动手，绝不会碰 Tofu 类
 * （字符缺失、无法恢复）的损坏——那种情况本函数选择不动，交由上层决定是否报错。
 *
 * @param {string} input
 * @returns {{ text:string, repaired:boolean, ghostChar:string, removed:number, quality:object }}
 */
function repairGhostText(input) {
  const text = String(input == null ? '' : input);
  const quality = textQuality(text);
  // 仅当判定为「幽灵字符」损坏时才修复；Tofu 缺失类损坏不可恢复，原样返回
  if (!quality.ghost || !quality.topChar) {
    return { text, repaired: false, ghostChar: '', removed: 0, quality };
  }
  const ghostChar = quality.topChar;
  let removed = 0;
  const stripped = text.replace(new RegExp(escapeRegExp(ghostChar), 'g'), () => {
    removed += 1;
    return '';
  });
  // 剔除后顺手清掉拼接处可能留下的连续空行 / 行尾空格，让正文更整洁
  const cleaned = stripped.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n');
  return { text: cleaned, repaired: true, ghostChar, removed, quality: textQuality(cleaned) };
}

export { textQuality, isCorruptText, repairGhostText, GHOST_CHAR_RATIO, TOFU_RATIO };

// 主进程（CommonJS / require）兜底导出；typeof 守卫确保 ESM 打包时不会因引用 module 报错
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { textQuality, isCorruptText, repairGhostText, GHOST_CHAR_RATIO, TOFU_RATIO };
}
