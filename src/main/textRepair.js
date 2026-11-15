'use strict';

/**
 * 教材文本质量（乱码 / 损坏文字层）检测与修复 —— 主进程 CommonJS 版。
 *
 * 渲染进程（Subjects.jsx）用的 ESM 版在 src/shared/textQuality.js；但主进程跑在
 * Electron 30 的 Node 20 上，`require()` 解析不了带 `export` 语句的 ESM 文件，
 * 所以主进程侧保留一份等价实现，供三条链路共用：
 *   - 落盘：subjectTextbook.saveTextbookPage / saveTranscription
 *   - 助教资料检索：materialContext.buildMaterialContext
 *   - 教材知识清单 / 题目提取：subjectTextbook
 * 改判定阈值或剔除逻辑时，这里的实现要与 src/shared/textQuality.js 同步。
 */

const REPLACEMENT_CHAR = '�'; // U+FFFD
// 与 src/shared/textQuality.js 的字符区间一致（Ext-A / 基本区 / 兼容汉字区）
const CJK_RANGE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

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
 * 只有确认是「单一异常字符高频出现」（ghost = true）时才动手；Tofu 类损坏原样返回。
 *
 * @param {string} input
 * @returns {{ text:string, repaired:boolean, ghostChar:string, removed:number, quality:object }}
 */
function repairGhostText(input) {
  const text = String(input == null ? '' : input);
  const quality = textQuality(text);
  if (!quality.ghost || !quality.topChar) {
    return { text, repaired: false, ghostChar: '', removed: 0, quality };
  }
  const ghostChar = quality.topChar;
  let removed = 0;
  const stripped = text.replace(new RegExp(escapeRegExp(ghostChar), 'g'), () => {
    removed += 1;
    return '';
  });
  const cleaned = stripped.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n');
  return { text: cleaned, repaired: true, ghostChar, removed, quality: textQuality(cleaned) };
}

module.exports = { textQuality, isCorruptText, repairGhostText, GHOST_CHAR_RATIO, TOFU_RATIO };
