'use strict';
/**
 * 一次性数据修复（在桌面用户权限下运行，直接写 userData）：
 * 1) 13 道带教材页图的题：按人工核对过的真实页重挂页图（Q34 无法定位 → 摘图）；
 * 2) 重建 content_html：上一轮只改了 content，content_html 还是旧识图结果，
 *    图号 / 公式编号在旧 HTML 里被吞掉（「图 2」「如图所示」），前端优先渲染 HTML 所以看起来公式丢了。
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { formatQuestionForStorage } = require('../src/shared/textbookFormat.js');

const SUBJECT = 'subj_mw7m2yj1lv00rqcz';
const PAPER = 'paper_1794585659299_1be62ddd';
const userData = path.join(process.env.APPDATA, 'studystudio');
const dbPath = path.join(userData, 'openexam.db');
const pageDir = path.join(userData, 'subjects', SUBJECT, '教材', '页图');
const assetDir = path.join(userData, 'question-assets', 'textbook', SUBJECT);

// 逐题人工核对（题号 → 教材物理页）。已在渲染出的页图上确认该页含对应题图。
const PAGE_BY_ORDER = {
  34: null, // 「信号流图如图 2-6」在教材里定位不到唯一页，宁可不挂
  37: 81,   // 图 2-56（无自平衡能力对象阶跃响应）与传递函数 1/(Ta s (1+T0 s)^n)
  45: 89,   // 题 2-4 图 2-61 各电路
  46: 89,   // 题 2-5 图 2-62 方框图
  48: 90,   // 题 2-7 图 2-64
  49: 90,   // 题 2-8 图 2-65 反馈放大器信号流图
  50: 90,   // 题 2-9 图 2-66 信号流图
  53: 92,   // 题 2-13 图 2-67（题文在 91 页末，图在 92 页首）
  54: 92,   // 题 2-14 图 2-68（同上）
  56: 92,   // 题 2-16 图 2-69 汽车悬浮
  57: 92,   // 题 2-17 图 2-70 有源网络
  59: 92,   // 题 2-19 图 2-71 RC 网络
  61: 92,   // 题 2-21 图 2-72 传递函数框图
};

const log = [];
function say(...args) { const line = args.join(' '); log.push(line); console.log(line); }

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

const rows = db.prepare('SELECT * FROM questions WHERE paper_id = ? ORDER BY order_num').all(PAPER);
say(`题数 ${rows.length}`);

const FIGURE_BLOCK_RE = /<p\s+class="tb-figure"[^>]*>[\s\S]*?<\/p>/g;

function ensureAsset(page) {
  const name = `page-${String(page).padStart(4, '0')}.jpg`;
  const src = path.join(pageDir, `页-${String(page).padStart(4, '0')}.jpg`);
  if (!fs.existsSync(src)) return { ok: false, src, name };
  fs.mkdirSync(assetDir, { recursive: true });
  fs.copyFileSync(src, path.join(assetDir, name));
  return { ok: true, src, name };
}

const update = db.prepare(`
  UPDATE questions
     SET content = ?, content_html = ?, options = ?, answer = ?, analysis = ?, analysis_html = ?,
         material_html = ?, textbook_format_version = 3
   WHERE id = ?
`);

let changed = 0;
const tx = db.transaction(() => {
  for (const row of rows) {
    const order = Number(row.order_num);
    const isTarget = Object.prototype.hasOwnProperty.call(PAGE_BY_ORDER, order);

    let material = String(row.material_html || '');
    const oldPages = [...material.matchAll(/page-0*(\d+)\.jpg/g)].map((m) => Number(m[1]));
    material = material.replace(FIGURE_BLOCK_RE, '').trim();

    let newPage = null;
    if (isTarget) {
      newPage = PAGE_BY_ORDER[order];
      if (newPage) {
        const asset = ensureAsset(newPage);
        if (!asset.ok) { say(`#${order} 缺页图 ${asset.src}，保持无图`); newPage = null; }
        else {
          const no = [...String(row.content).matchAll(/图\s*\$?(\d+[-.．]\d+)\$?/g)].map((m) => m[1])[0] || '';
          material = `${material}\n<p class="tb-figure"><img src="openexam-asset://question-assets/textbook/${SUBJECT}/${asset.name}" alt="教材${no ? ` 图 ${no}` : ''}（第 ${newPage} 页）" /></p>`.trim();
        }
      }
    } else {
      // 不在本次核对名单里：材料区原样保留
      material = String(row.material_html || '');
    }

    let options = [];
    try { options = JSON.parse(row.options || '[]'); } catch { options = []; }
    const formatted = formatQuestionForStorage({
      type: row.type,
      content: row.content,
      content_html: row.content_html,
      options,
      answer: row.answer,
      analysis: row.analysis,
      analysis_html: row.analysis_html,
      material_html: material,
    });

    const before = { page: oldPages[0] || null, html: String(row.content_html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 70) };
    update.run(
      formatted.content,
      formatted.content_html || null,
      JSON.stringify(formatted.options || []),
      formatted.answer ?? '',
      formatted.analysis || '',
      formatted.analysis_html || null,
      formatted.material_html || null,
      row.id,
    );
    changed += 1;
    say(`#${order} 页 ${before.page}→${newPage || '无'} | html: ${before.html}`);
  }
});
tx();
say(`已更新 ${changed} 行`);

const verify = db.prepare('SELECT order_num, content_html, material_html FROM questions WHERE paper_id = ? ORDER BY order_num').all(PAPER);
const withFigure = verify.filter((r) => /tb-figure/.test(String(r.material_html || '')));
say(`修复后带图题 ${withFigure.length} / ${verify.length}`);
for (const r of withFigure) {
  const page = [...String(r.material_html).matchAll(/page-0*(\d+)\.jpg/g)].map((m) => m[1]);
  const text = String(r.content_html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 60);
  say(`  #${r.order_num} p${page.join(',')} | ${text}`);
}
fs.writeFileSync(path.join(__dirname, 'repair.log'), `${log.join('\n')}\n`, 'utf8');
db.close();
