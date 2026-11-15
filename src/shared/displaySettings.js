// 题目字体大小设置层。
// 仅缩放题目文字（题干、选项、解析、答案），界面其余部分不变：
// - styles.css 里 .rich-question-content 用 calc(1em * var(--question-font-scale, 1)) 缩放，
//   .question-content / .option-content 保住 15px 设计基准再乘变量；
// - RichQuestionContent 组件把调用方传入的内联数字字号包成 calc(Npx * var)；
// - 本模块只负责在根节点设置 --question-font-scale 一个 CSS 变量并持久化。

export const QUESTION_FONT_SCALE_KEY = 'openexam_question_font_scale';
export const DEFAULT_FONT_SCALE = 1;
export const FONT_SCALE_MIN = 1;
export const FONT_SCALE_MAX = 2;
export const FONT_SCALE_STEP = 0.05;

// 预设档位，方便用户快速选择
export const FONT_SCALE_PRESETS = [
  { id: 'default', label: '标准', value: 1 },
  { id: 'large', label: '大', value: 1.25 },
  { id: 'xlarge', label: '特大', value: 1.5 },
  { id: 'xxlarge', label: '超大', value: 2 },
];

export function clampFontScale(value) {
  const n = Number(value);
  if (!isFinite(n)) return DEFAULT_FONT_SCALE;
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, n));
}

export function getFontScale() {
  try {
    const raw = localStorage.getItem(QUESTION_FONT_SCALE_KEY);
    if (!raw) return DEFAULT_FONT_SCALE;
    return clampFontScale(parseFloat(raw));
  } catch (error) {
    return DEFAULT_FONT_SCALE;
  }
}

// 仅把缩放值写到 DOM（设置 --question-font-scale 变量），不落库（落库交给 setFontScale）
export function applyFontScale(scale) {
  try {
    const value = clampFontScale(scale);
    document.documentElement.style.setProperty('--question-font-scale', String(value));
  } catch (error) {
    // 忽略：极少数环境下 documentElement 不可写
  }
}

// 写入 localStorage 并立即应用到界面，返回实际生效的值
export function setFontScale(value) {
  const scale = clampFontScale(value);
  try {
    localStorage.setItem(QUESTION_FONT_SCALE_KEY, String(scale));
  } catch (error) {
    // 忽略：隐私模式等无法写入
  }
  applyFontScale(scale);
  return scale;
}

export function resetFontScale() {
  return setFontScale(DEFAULT_FONT_SCALE);
}
