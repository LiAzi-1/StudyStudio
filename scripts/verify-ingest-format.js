/**
 * 教材格式「录入前置格式化 + 存量迁移」端到端验证
 * ==========================================================================
 *
 * 只在**真实题库的副本**上操作，绝不改动用户数据库：
 *   1) 复制 openexam.db 到临时目录，用 database.initDatabase() 模拟一次真实启动，
 *      验证存量迁移、迁移快照、幂等、KaTeX 可解析、公式残留；
 *   2) 在副本上逐条走 importPaper / appendImportedQuestions / stageImportedQuestions /
 *      recoverStagedImports / updateQuestionAnswer / importAllData，验证「先格式化再录入」；
 *   3) 可选传入旧版大题库，把其中 N 道题灌进新库做批量迁移压力验证。
 *
 * 运行（必须用打包版 Electron 的 Node，better-sqlite3 才是匹配的 ABI）：
 *   ELECTRON_RUN_AS_NODE=1 ./release/win-unpacked/StudyStudio.exe scripts/verify-ingest-format.js [当前库] [旧库]
 */

const fs = require('fs');
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');

const root = path.resolve(__dirname, '..');
const workRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), 'oe-ingest-verify-'));
let currentWorkDir = workRoot;
const failures = [];
const notes = [];

// Electron 主进程模块在纯 Node 下不可用，这里只打桩 database.js 真正用到的 app.getPath
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { getPath: () => currentWorkDir, getVersion: () => 'verify', getName: () => 'StudyStudio', isPackaged: false },
      BrowserWindow: class {},
      dialog: {},
      ipcMain: { handle() {} },
      protocol: {},
      nativeImage: {},
      shell: {},
      nativeTheme: {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { formatQuestionForStorage, TEXTBOOK_FORMAT_VERSION } = require('../src/shared/textbookFormat');
const katex = require('katex');

function check(name, actual, predicate, detail) {
  const ok = typeof predicate === 'function' ? predicate(actual) : actual === predicate;
  console.log(`${ok ? '✓' : '✗'} ${name}: ${typeof actual === 'boolean' ? (actual ? '是' : '否') : actual}${detail ? `（${detail}）` : ''}`);
  if (!ok) failures.push(name);
  return ok;
}

function freshDatabaseModule(workDir) {
  currentWorkDir = workDir;
  fsSync.mkdirSync(workDir, { recursive: true });
  delete require.cache[require.resolve('../src/main/database.js')];
  return require('../src/main/database.js');
}

function copyDatabase(source, target) {
  fsSync.copyFileSync(source, target);
  // WAL / SHM 存在时一起复制，保证副本是一致的数据库状态
  ['-wal', '-shm'].forEach((suffix) => {
    const extra = `${source}${suffix}`;
    if (fsSync.existsSync(extra)) fsSync.copyFileSync(extra, `${target}${suffix}`);
  });
}

function scanTextbookQuality(rows) {
  const stats = { formula: 0, parseFailed: 0, residual: 0, nonIdempotent: 0 };
  const residualRe = /[⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉ₙ₊₋ˣʸᶻ√∫Σ∑∂∞]/;
  rows.forEach((row) => {
    const text = [row.content, row.answer, row.analysis].map((v) => String(v || '')).join('\n');
    const formulas = text.match(/\$[^$\n]+\$/g) || [];
    stats.formula += formulas.length;
    formulas.forEach((match) => {
      try {
        katex.__parse(match.slice(1, -1), { throwOnError: true, strict: false, trust: false });
      } catch (_) { stats.parseFailed += 1; }
    });
    if (residualRe.test(text.replace(/\$[^$\n]+\$/g, ''))) stats.residual += 1;
    const once = formatQuestionForStorage({
      type: row.type,
      content: row.content,
      content_html: row.content_html,
      options: row.options,
      answer: row.answer,
      analysis: row.analysis,
      analysis_html: row.analysis_html,
      material_html: row.material_html,
    });
    ['content', 'answer', 'analysis', 'content_html', 'analysis_html'].forEach((key) => {
      if (String(once[key] || '') !== String(row[key] || '')) stats.nonIdempotent += 1;
    });
  });
  return stats;
}

const RAW_FILL = {
  type: 'fill',
  content: '1. 求 lim_{x→0} (tan x − sin x)/x³ 的值 ______',
  options: [],
  answer: 'f(x) = x²/2',
  analysis: '解析：由 eˣ 的展开式可得',
  category: 'math',
  chapter: '极限',
};
const RAW_SINGLE = {
  type: 'single',
  content: '2. 设 x² + y² = 1，则 z 的最大值是多少？',
  options: [{ key: 'A', content: 'A. 1' }, { key: 'B', content: 'B. 2' }],
  answer: 'b',
  analysis: '解析：由 x²≥0 得',
  category: 'math',
};
const RAW_STAGED = {
  type: 'fill',
  content: '3. 计算 ∫₀^π x sin x dx = ______',
  answer: 'π/2',
  analysis: '',
  category: 'math',
};

function main() {
  const sourceDb = process.argv[2] || path.join(os.homedir(), 'AppData', 'Roaming', 'studystudio', 'openexam.db');
  const bulkDb = process.argv[3] || '';
  if (!fsSync.existsSync(sourceDb)) throw new Error(`找不到题库文件：${sourceDb}`);

  /* ---------------- Phase A：真实启动 + 存量迁移 ---------------- */
  console.log(`\n=== A. 存量题库启动迁移（副本） ===\n源库：${sourceDb}`);
  const dirA = path.join(workRoot, 'startup');
  fsSync.mkdirSync(dirA, { recursive: true });
  copyDatabase(sourceDb, path.join(dirA, 'openexam.db'));
  const database = freshDatabaseModule(dirA);
  const db = database.initDatabase();

  const total = Number(db.prepare('SELECT COUNT(*) AS n FROM questions').get().n);
  const versioned = Number(db.prepare('SELECT COUNT(*) AS n FROM questions WHERE COALESCE(textbook_format_version, 0) >= ?').get(TEXTBOOK_FORMAT_VERSION).n);
  const rows = db.prepare('SELECT * FROM questions ORDER BY rowid').all();
  const quality = scanTextbookQuality(rows);

  check('题库题目总数', total, (v) => v > 0);
  check('已升级为教材格式', `${versioned}/${total}`, () => versioned === total);
  check('KaTeX 可解析公式数', quality.formula, (v) => v >= 0);
  check('公式解析失败', quality.parseFailed, 0);
  check('残留未公式化数学字符题目', quality.residual, 0);
  check('格式化幂等性差异', quality.nonIdempotent, 0);
  check('content_html 教材段落', Number(db.prepare("SELECT COUNT(*) AS n FROM questions WHERE content_html LIKE '%tb-p tb-stem%'").get().n), (v) => v >= 0);

  const snapshots = fsSync.readdirSync(dirA).filter((name) => name.startsWith('openexam.before-textbook-'));
  check('迁移前一致性快照', snapshots.length, (v) => v >= 1);
  if (snapshots.length) {
    try {
      const snapshot = new (require('better-sqlite3'))(path.join(dirA, snapshots[0]), { readonly: true });
      const snapshotRows = Number(snapshot.prepare('SELECT COUNT(*) AS n FROM questions').get().n);
      check('快照题目数与迁移前一致', snapshotRows, total);
      snapshot.close();
    } catch (error) {
      check('快照可独立打开', false, true, error.message);
    }
  }

  const rerun = database.migrateTextbookFormat();
  check('重复启动迁移不重复改写', rerun.migrated, 0);

  /* ---------------- Phase B：所有写入路径 ---------------- */
  console.log('\n=== B. 录入链路「先格式化再录入」 ===');

  const imported = database.importPaper({ title: '格式验证试卷', subject: 'math' }, [RAW_FILL, RAW_SINGLE]);
  const importedRows = db.prepare('SELECT * FROM questions WHERE paper_id = ? ORDER BY order_num').all(imported.paperId);
  const fill = importedRows[0];
  const single = importedRows[1];

  check('importPaper 写入题数', importedRows.length, 2);
  check('题干去掉卷面题号', fill.content.startsWith('1.'), false);
  check('填空答案保留公式且不被大写', fill.answer.includes('f(x)') && !fill.answer.includes('F(X)'), true, fill.answer);
  check('填空答案含 LaTeX 定界符', /\$/.test(fill.answer), true);
  check('客观题答案规范为大写字母', single.answer, 'B');
  check('选项前缀被剥离', single.options.includes('A. 1'), false);
  check('生成 content_html 教材段落', fill.content_html.includes('tb-p tb-stem'), true);
  check('解析去掉「解析：」残句前缀', fill.analysis.startsWith('解析：'), false);
  check('新题直接带上格式版本', fill.textbook_format_version, TEXTBOOK_FORMAT_VERSION);

  const appended = database.appendImportedQuestions(imported.paperId, [RAW_STAGED]);
  const appendedRow = db.prepare('SELECT * FROM questions WHERE paper_id = ? ORDER BY order_num DESC LIMIT 1').get(imported.paperId);
  check('appendImportedQuestions 写入', appended.appended, 1);
  check('追加题积分已公式化', appendedRow.content.includes('\\int'), true, appendedRow.content);
  check('追加题答案 π/2 已公式化', /\$/.test(appendedRow.answer), true, appendedRow.answer);

  const staged = database.stageImportedQuestions({ taskId: 'verify_task', questions: [RAW_STAGED] });
  const pending = database.getPendingStagedQuestions({ taskId: 'verify_task' });
  check('暂存写入', staged.staged, 1);
  check('暂存 payload 已格式化', pending[0]?.question?.content?.includes('\\int'), true);
  check('暂存 payload 带格式版本', pending[0]?.question?.textbook_format_version, TEXTBOOK_FORMAT_VERSION);

  const recovered = database.recoverStagedImports({ taskId: 'verify_task', force: true });
  check('暂存恢复补写', recovered.recovered + recovered.duplicates, (v) => v >= 1);

  const updated = database.updateQuestionAnswer(fill.id, { answer: 'g(x)=eˣ', analysis: '解析：用洛必达法则' });
  check('答案更新不破坏小写函数名', String(updated.answer).includes('g(x)') && !String(updated.answer).includes('G(X)'), true, updated.answer);
  check('答案更新生成教材式解析 HTML', String(updated.analysis_html || '').includes('tb-p tb-analysis'), true);

  const objectiveUpdate = database.updateQuestionAnswer(single.id, { answer: 'a' });
  check('客观题答案更新统一大写', String(objectiveUpdate.answer), 'A');

  // importAllData 会清空并重建全部数据，放在最后跑
  const backup = {
    data: {
      papers: [{ id: 'p_restore', title: '恢复验证', year: 2026, type: 'imported', subject: 'math', question_count: 1 }],
      questions: [{
        id: 'q_restore', paper_id: 'p_restore', order_num: 1, type: 'fill',
        content: '4. 已知 x² ≥ 0，求 xₙ₊₁ = √(2 + xₙ) 的极限 ______',
        content_html: '', options: [], answer: 'eˣ/2', analysis: '解析：n=1,2,…',
        analysis_html: '', difficulty: 2, tags: '', created_at: '2026-01-01 00:00:00',
      }],
      practice_records: [], wrong_questions: [], app_settings: [], ai_chat_sessions: [], ai_chat_messages: [],
    },
  };
  database.importAllData(backup);
  const restored = db.prepare("SELECT * FROM questions WHERE id = 'q_restore'").get();
  check('备份恢复题目被格式化', restored?.content?.includes('\\sqrt'), true, restored?.content);
  check('备份恢复答案保留小写 e', String(restored?.answer || '').includes('e') && !String(restored?.answer || '').includes('Eˣ'), true, restored?.answer);
  check('备份恢复带格式版本', restored?.textbook_format_version, TEXTBOOK_FORMAT_VERSION);
  database.closeDatabase();

  /* ---------------- Phase C：大题库批量迁移压力验证 ---------------- */
  if (bulkDb && fsSync.existsSync(bulkDb)) {
    console.log(`\n=== C. 大题库批量迁移（副本，最多 1200 题） ===\n源库：${bulkDb}`);
    const dirC = path.join(workRoot, 'bulk');
    fsSync.mkdirSync(dirC, { recursive: true });
    const databaseC = freshDatabaseModule(dirC);
    const dbC = databaseC.initDatabase();
    // 大题库只复制再 ATTACH，避免在用户真实数据库目录里生成 WAL 文件
    const bulkCopy = path.join(dirC, 'legacy-source.db');
    copyDatabase(bulkDb, bulkCopy);
    const sourcePath = bulkCopy.replace(/\\/g, '/').replace(/'/g, "''");
    // 批量灌入的是题目快照，papers 表为空，临时关掉外键约束
    dbC.pragma('foreign_keys = OFF');
    dbC.exec(`ATTACH DATABASE '${sourcePath}' AS src`);
    dbC.exec(`
      INSERT INTO main.questions
        (id, paper_id, order_num, type, category, sub_category, content, content_html, options, answer, analysis, analysis_html, difficulty, tags, textbook_format_version)
      SELECT id, paper_id, order_num, type, category, sub_category, content, content_html, options, answer, analysis, analysis_html, difficulty, tags, 0
      FROM src.questions LIMIT 1200
    `);
    const bulkTotal = Number(dbC.prepare('SELECT COUNT(*) AS n FROM main.questions').get().n);
    const bulkResult = databaseC.migrateTextbookFormat();
    const bulkRows = dbC.prepare('SELECT * FROM main.questions').all();
    const bulkQuality = scanTextbookQuality(bulkRows);
    const bulkVersioned = Number(dbC.prepare('SELECT COUNT(*) AS n FROM main.questions WHERE COALESCE(textbook_format_version, 0) >= ?').get(TEXTBOOK_FORMAT_VERSION).n);
    check('大题库迁移题数', bulkTotal, (v) => v > 0);
    check('大题库迁移成功数', bulkResult.migrated, bulkTotal);
    check('大题库迁移失败数', bulkResult.failed, 0);
    check('大题库格式版本覆盖', `${bulkVersioned}/${bulkTotal}`, () => bulkVersioned === bulkTotal);
    check('大题库公式解析失败', bulkQuality.parseFailed, 0);
    check('大题库残留未公式化题目', bulkQuality.residual, 0);
    check('大题库幂等性差异', bulkQuality.nonIdempotent, 0);
    databaseC.closeDatabase();
  } else {
    notes.push('未提供旧版大题库路径，跳过批量迁移压力验证');
  }

  console.log(`\n=== 结果 ===`);
  if (notes.length) notes.forEach((note) => console.log(`· ${note}`));
  console.log(failures.length ? `验证失败 ${failures.length} 项：${failures.join('、')}` : '入库格式化与存量迁移检查：全部通过');
  fsSync.rmSync(workRoot, { recursive: true, force: true });
  process.exitCode = failures.length ? 1 : 0;
}

try {
  main();
} catch (error) {
  console.error('验证脚本异常：', error);
  try { fsSync.rmSync(workRoot, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exitCode = 1;
}
