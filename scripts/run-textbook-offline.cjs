/**
 * 教材全链路离线脚本（不启动 Electron UI）：
 *   MinerU 整本转写 → 按页落盘 + 插图索引 → 知识清单 → 例题习题入库
 *
 * 用法（ELECTRON_RUN_AS_NODE=1 "release/win-unpacked/StudyStudio.exe" scripts/run-textbook-offline.cjs <subjectId> <pdfPath> [--pages N]）
 * electron mock 放在最前面：database/subjectManager 在 Node 模式下会 require('electron')。
 */
const Module = require('module');

const USER_DATA = process.env.OPENEXAM_USER_DATA || 'C:\\Users\\Li_13\\AppData\\Roaming\\studystudio';
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return { app: { getPath: () => USER_DATA }, webUtils: { getPathForFile: () => '' } };
  }
  return origLoad.call(this, request, ...rest);
};

const database = require('../src/main/database.js');
const subjectTextbook = require('../src/main/subjectTextbook.js');
const textbookMineru = require('../src/main/textbookMineru.js');
const aiService = require('../src/main/ai/index.js');

const [subjectId, pdfPath] = process.argv.slice(2);
if (!subjectId || !pdfPath) {
  console.error('用法: run-textbook-offline.cjs <subjectId> <pdfPath>');
  process.exit(1);
}

const ts = () => new Date().toTimeString().slice(0, 8);

async function main() {
  database.initDatabase();
  const subject = database.getSubject ? null : null; // subjectManager 才有
  const subjectManager = require('../src/main/subjectManager.js');
  const subjectRow = subjectManager.getSubject(subjectId);
  if (!subjectRow) throw new Error(`科目不存在: ${subjectId}`);
  console.log(`[${ts()}] 科目: ${subjectRow.name}`);

  const settings = database.getAISettings();
  if (!settings?.apiKey) throw new Error('AI 未配置（后续知识清单/题目提取需要）');

  console.log(`[${ts()}] MinerU 解析开始（首次会下载模型，请耐心等）`);
  const parsed = await textbookMineru.parseTextbookLocal({
    subjectId,
    pdfPath,
    fileName: require('path').basename(pdfPath),
    onProgress: (p) => console.log(`[${ts()}] ${p.stage} ${p.percent}% ${p.detail}`),
  });
  console.log(`[${ts()}] MinerU 完成: ${parsed.pages} 页, 插图 ${parsed.figures} 张`);

  console.log(`[${ts()}] 生成知识清单（文本 API）…`);
  const inv = await subjectTextbook.generateKnowledgeInventory({
    subjectId,
    settings: aiService.resolveRoleSettings(settings, 'assistant'),
  });
  console.log(`[${ts()}] 知识清单: ${inv?.success ? 'OK' : inv?.error} chars=${inv?.chars ?? '-'}`);

  console.log(`[${ts()}] 提取例题习题（文本 API，最多 10 分钟预算）…`);
  const questions = await subjectTextbook.generateTextbookQuestions({
    subjectId,
    settings: aiService.resolveRoleSettings(settings, 'vision'),
    onProgress: (p) => console.log(`[${ts()}]   题目 ${p.done}/${p.total}`),
  });
  console.log(`[${ts()}] 题目提取: 成功=${questions?.success} 入库=${questions?.questions || 0} 配图=${JSON.stringify(questions?.figures || {})} 去重跳过=${questions?.duplicateSkipped || 0}`);

  const figures = require('../src/main/textbookFigures.js').stats(subjectId);
  console.log(`[${ts()}] 插图索引: ${figures.figures} 张 / 页图 ${figures.pageImages} 张`);

  const papers = database.getSubjectTextbookPaper?.(subjectId);
  console.log(`[${ts()}] 教材试卷: ${papers?.title || '-'} 共 ${papers?.question_count ?? 0} 题`);

  console.log(`[${ts()}] 全部完成`);
}

main().catch((error) => {
  console.error('[FATAL]', error?.stack || error?.message || error);
  process.exit(1);
});
