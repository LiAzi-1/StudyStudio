'use strict';
/**
 * Obsidian 数学公式格式一致性校验。
 *
 * 跑法：npm run verify:latex
 *
 * 检查四件事：
 *  1. Python (obsidian/oe_math.py) 与 Node (src/shared/mathStyle.js) 的规范文本逐字一致；
 *  2. 两侧的 normalize 在同一批用例上输出完全一致，且幂等；
 *  3. 所有会写笔记 / 题目的 AI 提示词都注入了规范，所有落库 / 落盘点都有兜底规范化；
 *  4. 仓库内置模板、示例笔记、首页与知识清单已经是干净的 LaTeX（无旧定界符、无中文入公式）。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { MATH_STYLE_PROMPT, normalizeMath } = require(path.join(ROOT, 'src/shared/mathStyle.js'));

const failures = [];
const passes = [];
function check(name, condition, detail = '') {
  if (condition) passes.push(name);
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/* ---------------------------------------------------------------- Python 侧 */

const PY_DRIVER = String.raw`
import json, os, sys
sys.path.insert(0, sys.argv[1])
import oe_math as M
req = json.loads(sys.stdin.read())
op = req["op"]
if op == "style":
    print(json.dumps({"style": M.MATH_STYLE}, ensure_ascii=False))
elif op == "cases":
    out = []
    for text in req["texts"]:
        body, warnings = M.normalize_math(text)
        again, _ = M.normalize_math(body)
        out.append({"text": body, "warnings": warnings, "idempotent": again == body})
    print(json.dumps({"results": out}, ensure_ascii=False))
elif op == "vault":
    out = []
    for p in req["paths"]:
        text = open(p, encoding="utf-8").read()
        body, warnings = M.normalize_math(text)
        out.append({"path": p, "clean": body == text, "warnings": warnings})
    print(json.dumps({"results": out}, ensure_ascii=False))
`;

function python(request) {
  const exe = process.env.PYTHON || process.env.PYTHON_EXE || 'python';
  const out = execFileSync(exe, ['-c', PY_DRIVER, path.join(ROOT, 'obsidian')], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    cwd: ROOT,
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(out);
}

let pyAvailable = true;
try {
  const { style } = python({ op: 'style' });
  check('Python / Node 规范文本逐字一致',
    style.trim() === MATH_STYLE_PROMPT.trim(),
    `\n  Python 长度 ${style.trim().length}，Node 长度 ${MATH_STYLE_PROMPT.trim().length}`);
} catch (error) {
  pyAvailable = false;
  failures.push(`无法调用 Python 侧的 oe_math（${error.message}）`);
}

/* ---------------------------------------------------------------- 行为一致 */

const CASES = [
  '普通正文\n\n\n三段换行不该被改',
  '设总量 24，需要 $24/7 ≈ 3.4$ 小时',
  '合作效率 $W = v × t$，且 $x² + ω_n² ≥ 0$',
  '能量公式 \\(E=mc^2\\)，块级 \\[a^2+b^2=c^2\\]',
  '二阶系统 $G(s)=ω_n²/(s²+2ζω_n s+ω_n²)$',
  '$$工作量 = 效率 \\times 时间$$ 后面还有正文',
  '$\\frac{24}{7 \\approx 3.4}$ 小时',
  '代码 `$x × y$` 与 ```\n$不处理$\n``` 都原样保留',
  '$$t_p = \\frac{\\pi}{\\omega_n\\sqrt{1-\\zeta^{2}}}$$',
  '单个 $ 不成对',
];

if (pyAvailable) {
  const { results } = python({ op: 'cases', texts: CASES });
  const jsResults = CASES.map((text) => {
    const first = normalizeMath(text);
    const again = normalizeMath(first.text);
    return { text: first.text, warnings: first.warnings, idempotent: again.text === first.text };
  });
  results.forEach((py, index) => {
    const js = jsResults[index];
    check(`用例 ${index + 1} 两侧输出一致`, py.text === js.text,
      `\n  输入 ${JSON.stringify(CASES[index])}\n  Python ${JSON.stringify(py.text)}\n  Node   ${JSON.stringify(js.text)}`);
    check(`用例 ${index + 1} 两侧告警一致`,
      JSON.stringify(py.warnings) === JSON.stringify(js.warnings),
      `\n  Python ${JSON.stringify(py.warnings)}\n  Node   ${JSON.stringify(js.warnings)}`);
    check(`用例 ${index + 1} 幂等`, js.idempotent && py.idempotent);
  });
  check('坏 \\frac 只告警不改写',
    normalizeMath(CASES[6]).warnings.some((w) => w.includes('\\frac')));
}

/* ---------------------------------------------------------------- 写入链路 */

const PROMPT_FILES = [
  ['src/main/noteTutor.js', 'MATH_STYLE_PROMPT'],
  ['src/main/assistantAgent.js', 'MATH_STYLE_PROMPT'],
  ['src/main/subjectTextbook.js', 'MATH_STYLE_PROMPT'],
  ['src/shared/goodLearningSkill.js', 'MATH_STYLE_PROMPT'],
  ['src/shared/textbookFormat.js', '定界符里只放数学'],
  ['src/main/ai/index.js', '\\frac{24}{7}'],
  ['obsidian/oe_format.py', 'M.MATH_STYLE'],
  ['obsidian/oe_tutor.py', 'M.MATH_STYLE'],
];
PROMPT_FILES.forEach(([file, token]) => {
  check(`提示词含规范：${file}`, read(file).includes(token), `缺少 ${token}`);
});

const WRITE_FILES = [
  ['src/main/studyPlan.js', 'normalizeMath'],
  ['src/main/noteTutor.js', 'normalizeMath'],
  ['src/main/subjectTextbook.js', 'normalizeMath'],
  ['src/main/assistantAgent.js', 'normalizeMath'],
  ['src/main/obsidian/noteSync.js', 'normalizeMath'],
  ['src/main/obsidian/home.js', 'MathJax'],
  ['obsidian/oe_format.py', 'normalize_math'],
  ['obsidian/oe_tutor.py', 'normalize_math'],
  ['obsidian/oe_import.py', 'normalize_math'],
  ['obsidian/oe_bank.py', 'normalize_math'],
  ['obsidian/bridge.py', 'cmd_latex'],
];
WRITE_FILES.forEach(([file, token]) => {
  check(`写入 / 落盘兜底：${file}`, read(file).includes(token), `缺少 ${token}`);
});

check('package.json 提供 obsidian:latex / verify:latex',
  read('package.json').includes('"obsidian:latex"') && read('package.json').includes('"verify:latex"'));

/* ---------------------------------------------------------------- 笔记样例 */

const TEMPLATE = 'obsidian/vault/99-模板/规范笔记模板.md';
const EXAMPLE = 'obsidian/vault/10-笔记/示例笔记-工程问题.md';
const HOME = 'obsidian/vault/首页.md';
const template = read(TEMPLATE);
const example = read(EXAMPLE);
check('模板含独立成行的块级公式', /\r?\n\$\$\r?\n[\s\S]*?\\times[\s\S]*?\r?\n\$\$\r?\n/.test(template));
check('模板不再把中文写进公式', !template.includes('$$工作量'));
check('模板含公式写法提示', template.includes('[!tip] 公式写法'));
check('示例笔记不再有纯文本 24/7 ≈ 3.4', !example.includes('24/7 ≈ 3.4'));
check('示例笔记解析用 \\frac', example.includes('\\frac{24}{7}'));
check('桥接首页含 LaTeX 章节', read(HOME).includes('## 数学公式（LaTeX）'));
check('应用首页模板含 MathJax 说明', read('src/main/obsidian/home.js').includes('内置 MathJax'));
check('新仓库会预置 LaTeX 笔记模板',
  read('src/main/obsidian/vault.js').includes('NOTE_TEMPLATE') &&
  read('src/main/obsidian/vault.js').includes('ensureVault'));

if (pyAvailable) {
  const vaultDir = path.join(ROOT, 'obsidian', 'vault');
  const targets = [];
  for (const dir of ['00-收件箱', '10-笔记', '99-模板', '20-思维导图']) {
    const base = path.join(vaultDir, dir);
    if (!fs.existsSync(base)) continue;
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) targets.push(full);
    });
    walk(base);
  }
  const homeFile = path.join(vaultDir, '首页.md');
  if (fs.existsSync(homeFile)) targets.push(homeFile);
  const { results } = python({ op: 'vault', paths: targets });
  const dirty = results.filter((r) => !r.clean || r.warnings.length);
  check(`项目 vault ${results.length} 篇笔记公式格式干净且幂等`, dirty.length === 0,
    dirty.map((r) => `\n  ${path.relative(ROOT, r.path)} ${JSON.stringify(r.warnings)}`).join(''));
}

/* ---------------------------------------------------------------- 结果 */

console.log(`[verify:latex] 通过 ${passes.length} 项`);
if (failures.length) {
  console.error(`[verify:latex] 失败 ${failures.length} 项：`);
  failures.forEach((item) => console.error(`  ✗ ${item}`));
  process.exit(1);
}
console.log('[verify:latex] 全部通过 ✓');
