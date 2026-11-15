/**
 * 教材式导出验证（只读，不改数据库）
 * 用法：ELECTRON_RUN_AS_NODE=1 ./release/win-unpacked/StudyStudio.exe scripts/verify-export-format.js [输出HTML路径]
 *
 * 检查试卷导出 HTML 里：
 *   1. $...$ 是否渲染成 KaTeX 结构（而不是裸 LaTeX）；
 *   2. KaTeX 字体是否内联（data: URL 打开时无法加载相对路径字体）；
 *   3. tb-* 教材段落、【答案】【解析】标签是否保留；
 *   4. 题库 HTML 里的属性不会被公式渲染误伤。
 */
// paperExport 顶部 require('electron')；纯 Node 验证时打个桩即可（只调用 buildPaperHtml，
// 不碰 BrowserWindow / dialog）。这样验证脚本用普通 node 也能跑。
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { BrowserWindow: class {}, app: {}, dialog: {} };
  return originalLoad.call(this, request, parent, isMain);
};

const { buildPaperHtml } = require('../src/main/paperExport.js');

const question = {
  id: 'q1',
  type: 'fill',
  category: '数学',
  content: '求 $\\lim _{x\\to 0} \\frac{\\tan x - \\sin x}{x^{3}}$ 的值。',
  content_html: '<p class="tb-p tb-stem">求 $\\lim _{x\\to 0} \\frac{\\tan x - \\sin x}{x^{3}}$ 的值。</p>',
  options: [{ key: 'A', content: '$\\sqrt{2}$' }],
  answer: '$\\frac{1}{2}$',
  analysis: '由洛必达法则可得 $\\frac{1}{2}$。',
  analysis_html: '<p class="tb-p tb-analysis">由洛必达法则可得 $\\frac{1}{2}$。</p>',
};

const html = buildPaperHtml({
  paper: { title: '教材格式验证卷' },
  questions: [
    question,
    {
      ...question,
      id: 'q2',
      content_html: '<p class="tb-p tb-stem">看图：</p><p><img src="openexam-asset://question-assets/a.png" alt="图示 $x$" /></p>',
      analysis_html: '',
      analysis: '',
    },
    {
      ...question,
      id: 'q3',
      content_html: '',
      content: '设 $x_{1}=0$，$x_{n+1}=\\sqrt{2+x_{n}}$，求 $\\lim _{n\\to \\infty } x_{n}$。',
      analysis_html: '',
      analysis: '',
    },
    {
      ...question,
      id: 'q4',
      content_html: '',
      content: 'The book costs $5 and $10 in total.',
      answer: 'A',
      analysis_html: '',
      analysis: '',
      options: [],
    },
  ],
});

const checks = [
  ['HTML 体积（KB）', () => Math.round(Buffer.byteLength(html, 'utf8') / 1024), null],
  ['KaTeX 结构数', () => (html.match(/class="katex"/g) || []).length, (v) => v >= 6],
  ['内联 woff2 字体数', () => (html.match(/data:font\/woff2;base64/g) || []).length, (v) => v >= 20],
  ['【答案】标签', () => html.includes('【答案】'), (v) => v === true],
  ['【解析】标签', () => html.includes('【解析】'), (v) => v === true],
  ['tb-p 教材段落保留', () => html.includes('tb-p tb-stem'), (v) => v === true],
  ['图片属性不被公式渲染破坏', () => html.includes('src="openexam-asset://question-assets/a.png"'), (v) => v === true],
  ['正文里没有裸 LaTeX 命令', () => !/求\s*\$|得\s*\$|设\s*\$/.test(html), (v) => v === true],
  ['英文价格不被误判为公式', () => html.includes('The book costs $5 and $10 in total.'), (v) => v === true],
];

let failed = 0;
checks.forEach(([name, get, assert]) => {
  const value = get();
  const ok = assert ? assert(value) : true;
  if (!ok) failed += 1;
  console.log(`${ok ? '✓' : '✗'} ${name}: ${typeof value === 'boolean' ? (value ? '是' : '否') : value}`);
});

const outPath = process.argv[2];
if (outPath) {
  require('fs').writeFileSync(outPath, html, 'utf8');
  console.log(`\n导出样例已写入：${outPath}`);
}

console.log(`\n导出格式检查：${failed === 0 ? '全部通过' : `失败 ${failed} 项`}`);
process.exitCode = failed === 0 ? 0 : 1;
