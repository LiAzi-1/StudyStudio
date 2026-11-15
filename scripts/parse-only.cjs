/**
 * 只跑「教材本地转写」的离线脚本（不碰 AI、不生成清单/题目）。
 *
 * 用法：
 *   node scripts/parse-only.cjs <subjectId> <pdfPath> [--reset]
 *
 *   --reset  先清空该科目旧教材数据（页文件 + 教材全文 + 状态置 none），再全本转写。
 *
 * 依赖：D:/mineru-venv（MinerU 4.x）+ 常驻 mineru server。
 * 通过 src/main/textbookMineru.js::parseTextbookLocal 走完整链路：
 *   python 提取器 -> content_list.json -> collectOutput -> 页文件/教材全文落盘。
 */
const Module = require('module');
const path = require('path');

const USER_DATA = process.env.OPENEXAM_USER_DATA || 'C:\\Users\\Li_13\\AppData\\Roaming\\studystudio';
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return { app: { getPath: () => USER_DATA }, webUtils: { getPathForFile: () => '' } };
  }
  return origLoad.call(this, request, ...rest);
};

const database = require('../src/main/database.js');
const subjectManager = require('../src/main/subjectManager.js');
const subjectTextbook = require('../src/main/subjectTextbook.js');
const textbookMineru = require('../src/main/textbookMineru.js');
const fs = require('fs');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));
const [subjectId, pdfPath] = positional;

if (!subjectId || !pdfPath) {
  console.error('用法: node scripts/parse-only.cjs <subjectId> <pdfPath> [--reset]');
  process.exit(1);
}

const ts = () => new Date().toTimeString().slice(0, 8);

async function main() {
  database.initDatabase();
  const subject = subjectManager.getSubject(subjectId);
  if (!subject) throw new Error(`科目不存在: ${subjectId}`);
  console.log(`[${ts()}] 科目: ${subject.name}（当前状态=${subject.textbookStatus || 'none'}，页数=${subject.textbookPages || 0}）`);

  if (flags.has('--reset')) {
    const r = subjectTextbook.resetTextbook(subjectId);
    console.log(`[${ts()}] 已重置旧教材数据: ${JSON.stringify(r)}`);
  }

  console.log(`[${ts()}] 开始本地转写（MinerU 4.x flash，页范围=${process.env.OPENEXAM_PARSE_PAGES || 'all'}）…`);
  const started = Date.now();
  const parsed = await textbookMineru.parseTextbookLocal({
    subjectId,
    pdfPath,
    fileName: path.basename(pdfPath),
    onProgress: (p) => console.log(`[${ts()}] ${p.stage} ${p.percent}% ${p.detail}`),
  });
  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.log(`[${ts()}] 转写完成：${parsed.pages} 页, 插图 ${parsed.figures} 张，用时 ${mins} 分钟`);

  // 校验落盘
  const subjectDir = path.join(USER_DATA, 'subjects', subjectId, '教材');
  let pageFiles = 0;
  try {
    pageFiles = fs.readdirSync(subjectDir).filter((n) => /^页-\d+\.md$/.test(n)).length;
  } catch { /* 目录可能不存在 */ }
  const fullPath = path.join(subjectDir, '教材全文.md');
  const fullSize = fs.existsSync(fullPath) ? fs.statSync(fullPath).size : 0;
  const after = subjectManager.getSubject(subjectId);
  console.log(`[${ts()}] 落盘校验：页文件 ${pageFiles} 个；教材全文.md ${(fullSize / 1024).toFixed(0)} KB；状态=${after?.textbookStatus}，页数=${after?.textbookPages}`);
  console.log(`[${ts()}] 完成`);
}

main().catch((error) => {
  console.error('[FATAL]', error?.stack || error?.message || error);
  process.exit(1);
});
