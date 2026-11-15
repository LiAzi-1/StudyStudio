/**
 * 教材格式层验证脚本（只读，不修改任何数据库）。
 * 用法：node scripts/verify-textbook-format.js [db路径] [抽样数]
 * 会从 questions 表抽样，打印格式化前后对照与 KaTeX 解析失败率。
 */
const path = require('path');
const fs = require('fs');
const {
  formatQuestionRow,
  formatQuestionText,
  fragmentToLatex,
} = require('../src/shared/textbookFormat');

const katex = require('katex');
const dbPath = process.argv[2] || path.join(
  process.env.APPDATA || process.env.HOME || '.',
  'studystudio', 'openexam.db'
);
const sampleSize = Number(process.argv[3] || 12);
const showFallback = process.argv.includes('--fallback');

let rows = [];
try {
  // better-sqlite3 是原生模块，普通 node 可能加载不了；加载失败时退回内置样例
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });
  rows = db.prepare(`SELECT * FROM questions ORDER BY rowid LIMIT 400`).all();
  db.close();
} catch (error) {
  console.log(`[info] 直接读库不可用（${error.message}），改用内置样例`);
  rows = [
    { id: 's1', type: 'fill', content: 'lim_{x→0} (tan x − sin x)/x³ = ______.', options: '[]', answer: '', analysis: '' },
    { id: 's2', type: 'fill', content: '设 z = f(x²y, xy²)，其中 f 具有二阶连续偏导数。则 ∂²z/∂x∂y = ______.', options: '[]', answer: '', analysis: '' },
    { id: 's3', type: 'subjective', content: '计算 ∭_Ω √(x² + y² + z²) dV，其中 Ω = {(x,y,z) | x² + y² + z² ≤ z}。', options: '[]', answer: '', analysis: '' },
    { id: 's4', type: 'subjective', content: '(1) 判别级数 Σ_{n=1}^∞ n!/nⁿ 的敛散性；(2) 求级数 Σ_{n=1}^∞ 1/(n(n+1)(n+2)) 的和。', options: '[]', answer: '', analysis: '' },
    { id: 's5', type: 'subjective', content: '设 F(y) = ∫₀^{π/2} ln(1 + y sin x)dx（|y| < 1），则 F′(0) = ______.', options: '[]', answer: '', analysis: '' },
    { id: 's6', type: 'fill', content: '点 M(2,1,1) 到直线 L: (x−1)/1 = (y−2)/2 = (z−3)/3 的距离为 ______.', options: '[]', answer: '√6', analysis: '距离 d = √35/√14 = √(35/14) = √6。' },
    { id: 's7', type: 'single', content: '1. 【单选题】下列关于 x² + y² ≤ 1 的说法正确的是（  ）', options: '[{"key":"A","content":"A. 只含一个点"},{"key":"B","content":"B. 是圆盘"}]', answer: '答案：B', analysis: '【解析】x² + y² ≤ 1 表示圆盘，故选 B。' },
    { id: 's8', type: 'fill', content: '∫₀^π x sin x/(1+cos²x) dx = ______.', options: '[]', answer: '', analysis: '' },
  ];
}

let fallbackCount = 0;
let formulaCount = 0;
const failures = [];
const samples = rows.slice(0, Math.min(sampleSize, rows.length));

samples.forEach((row, index) => {
  const patch = formatQuestionRow(row);
  const content = patch ? patch.content : row.content;
  const analysis = patch ? patch.analysis : row.analysis;
  console.log(`\n[${index + 1}] ${row.id} (${row.type})`);
  console.log('  原 :', String(row.content || '').replace(/\n/g, '⏎').slice(0, 220));
  console.log('  后 :', String(content || '').replace(/\n/g, '⏎').slice(0, 260));
  if (analysis) console.log('  解析:', String(analysis || '').replace(/\n/g, '⏎').slice(0, 180));
  if (patch && patch.answer) console.log('  答案:', String(patch.answer).slice(0, 120));

  // 统计 KaTeX 解析情况
  [content, analysis].forEach((text) => {
    const formulas = String(text || '').match(/\$[^$\n]+\$/g) || [];
    formulas.forEach((f) => {
      formulaCount += 1;
      try { katex.__parse(f.slice(1, -1), { throwOnError: true }); }
      catch (error) { failures.push(`${row.id}: ${f} → ${error.message.split('\n')[0]}`); }
    });
  });
});

// 全量扫描：还有多少数学字符没能被 LaTeX 包住（转换兜底率）
rows.forEach((row) => {
  const patch = formatQuestionRow(row);
  const text = patch ? patch.content : row.content;
  const stripped = String(text || '').replace(/\$[^$\n]*\$/g, '');
  if (/[\u2070-\u209f√∫Σ∑∏∂∞→≤≥≠∣‖²³ⁿₙ]/.test(stripped)) {
    fallbackCount += 1;
    if (showFallback) console.log('  [未公式化]', row.id, String(text).slice(0, 160));
  }
});

console.log(`\n==== 统计（前 ${rows.length} 题） ====`);
console.log(`公式总数 ${formulaCount}，KaTeX 解析失败 ${failures.length}，残留未公式化题目 ${fallbackCount}`);
failures.slice(0, 12).forEach((item) => console.log('  ✗', item));
// 幂等检查：格式化两次必须完全一致（同一道题会经过 AI 层 / 落库层 / 迁移层多次）
const { formatQuestionForStorage } = require('../src/shared/textbookFormat');
let nonIdempotent = 0;
rows.forEach((row) => {
  const once = formatQuestionForStorage({
    id: row.id, type: row.type, content: row.content, content_html: row.content_html,
    options: row.options, answer: row.answer, analysis: row.analysis, analysis_html: row.analysis_html,
  });
  const twice = formatQuestionForStorage(once);
  ['content', 'answer', 'analysis', 'content_html', 'analysis_html'].forEach((key) => {
    if (String(once[key] || '') !== String(twice[key] || '')) {
      nonIdempotent += 1;
      if (nonIdempotent <= 5) console.log(`  [非幂等] ${row.id}.${key}\n   一次: ${String(once[key]).slice(0, 140)}\n   二次: ${String(twice[key]).slice(0, 140)}`);
    }
  });
});
console.log(`幂等性：${nonIdempotent === 0 ? '通过' : `失败 ${nonIdempotent} 处`}`);

console.log('\n==== 直接片段测试 ====');
[
  'lim_{x→0} (tan x − sin x)/x³',
  '∬_Σ (x + y + z) dS',
  'Σ_{n=1}^∞ 1/(n(n+1)(n+2))',
  'xₙ₊₁ = √(2 + xₙ)',
  '∫₀^{π/2} ln(1 + y sin x)dx',
].forEach((item) => console.log(' ', item, '→', fragmentToLatex(item)));
