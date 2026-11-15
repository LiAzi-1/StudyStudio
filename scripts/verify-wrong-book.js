/**
 * 错题库回归验证：ELECTRON_RUN_AS_NODE=1 + electron 桩模块运行
 * （better-sqlite3 按 Electron ABI 编译，普通 node 加载不了）。
 * 用法：ELECTRON_RUN_AS_NODE=1 ./release/win-unpacked/StudyStudio.exe scripts/verify-wrong-book.js
 * 覆盖：外键迁移、快照列、自建错题 CRUD、平台快照写入、筛选搜索、复习进度保留、
 *       图片落盘与清理、备份导出携带快照。
 */
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'electron') return require.resolve('./electron-stub.js');
  return origResolve.call(this, request, parent, isMain, options);
};

const { app } = require('./electron-stub.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
}

try {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openexam-wrongbook-test-'));
  app.setPath('userData', tempDir);
  const dbPath = path.join(tempDir, 'openexam.db');

  // 1) 预置「旧版」表结构（带外键 + 旧列），模拟存量用户
  const raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE papers (id TEXT PRIMARY KEY, title TEXT NOT NULL, year INTEGER NOT NULL, type TEXT NOT NULL, subject TEXT NOT NULL, province TEXT, question_count INTEGER DEFAULT 0, duration INTEGER DEFAULT 120, difficulty INTEGER DEFAULT 3, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE questions (id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, order_num INTEGER NOT NULL, type TEXT DEFAULT 'single', category TEXT, sub_category TEXT, content TEXT NOT NULL, content_html TEXT, material_html TEXT, material_group_id TEXT, options TEXT NOT NULL, answer TEXT NOT NULL, analysis TEXT, analysis_html TEXT, difficulty INTEGER DEFAULT 2, tags TEXT, quality_flag TEXT, textbook_format_version INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (paper_id) REFERENCES papers(id));
    CREATE TABLE practice_records (id TEXT PRIMARY KEY, paper_id TEXT, category TEXT, sub_category TEXT, start_time TEXT NOT NULL, end_time TEXT, duration INTEGER, status TEXT DEFAULT 'ongoing', answers TEXT, correct_count INTEGER DEFAULT 0, total_count INTEGER DEFAULT 0, accuracy INTEGER DEFAULT 0, score INTEGER DEFAULT 0, meta TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE wrong_questions (id TEXT PRIMARY KEY, question_id TEXT NOT NULL, paper_id TEXT NOT NULL, user_answer TEXT, correct_answer TEXT, added_at TEXT DEFAULT CURRENT_TIMESTAMP, review_count INTEGER DEFAULT 0, last_review TEXT, next_review_at TEXT, review_stage INTEGER DEFAULT 0, FOREIGN KEY (question_id) REFERENCES questions(id));
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE ai_chat_sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, provider TEXT, model TEXT, message_count INTEGER DEFAULT 0, last_message_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE ai_chat_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (session_id) REFERENCES ai_chat_sessions(id));
  `);
  // 试卷用用户生成类型（imported），避免命中「内置官方题库清理」规则——那是有意设计
  raw.prepare("INSERT INTO papers (id, title, year, type, subject) VALUES ('p1', '旧试卷', 2024, 'imported', 'xingce')").run();
  raw.prepare("INSERT INTO questions (id, paper_id, order_num, content, options, answer) VALUES ('q1', 'p1', 1, '旧题目内容', '[{\"key\":\"A\",\"content\":\"甲\"},{\"key\":\"B\",\"content\":\"乙\"}]', 'A')").run();
  raw.prepare("INSERT INTO wrong_questions (id, question_id, paper_id, user_answer, correct_answer) VALUES ('wrong_q1', 'q1', 'p1', 'B', 'A')").run();
  raw.close();

  // 2) 初始化（触发外键迁移 + 快照列补齐）
  const database = require(path.join(__dirname, '..', 'src', 'main', 'database.js'));
  database.initDatabase();

  const inspect = new Database(dbPath, { readonly: true });
  const fkCount = inspect.pragma('foreign_key_list(wrong_questions)').length;
  check('存量表外键已移除', fkCount === 0, `foreign_key_list=${fkCount}`);
  const cols = new Set(inspect.pragma('table_info(wrong_questions)').map((c) => c.name));
  const needed = ['source_type', 'source_label', 'q_type', 'q_content', 'q_content_html', 'q_options', 'q_analysis', 'q_analysis_html', 'q_category', 'q_sub_category', 'q_answer', 'images', 'reason', 'note'];
  const missingCols = needed.filter((name) => !cols.has(name));
  check('快照列齐全', missingCols.length === 0, missingCols.length ? `缺 ${missingCols.join(',')}` : '');
  const legacyRow = inspect.prepare("SELECT * FROM wrong_questions WHERE id = 'wrong_q1'").get();
  check('存量错题数据保留', Boolean(legacyRow) && legacyRow.user_answer === 'B');
  inspect.close();

  // 3) 平台错题：带快照写入
  database.addWrongQuestion('q1', 'p1', 'B（重新做错）', 'A', {
    type: 'single', content: '旧题目内容', contentHtml: '<p>旧题目内容</p>',
    options: [{ key: 'A', content: '甲' }, { key: 'B', content: '乙' }],
    analysis: '因为所以', analysisHtml: '', category: 'panduan', subCategory: '', answer: 'A',
  });
  const platformRow = database.getWrongQuestionById('wrong_q1');
  check('平台错题快照写入', Boolean(platformRow) && platformRow.content === '旧题目内容' && platformRow.source_type === 'platform');
  check('平台错题题干 HTML 可用', platformRow.content_html === '<p>旧题目内容</p>');
  check('平台错题关联试卷标题', platformRow.paper_title === '旧试卷');
  check('平台错题选项可读', Array.isArray(platformRow.options) && platformRow.options.length === 2 && platformRow.options[0].key === 'A');

  // 完全虚拟 ID 的平台错题（题目不在题库表里，验证外键已无约束）
  database.addWrongQuestion('ghost_1', '', 'C', 'B', { type: 'single', content: '幽灵题', options: [{ key: 'B', content: '乙' }], answer: 'B' });
  const ghostRow = database.getWrongQuestionById('wrong_ghost_1');
  check('虚拟题目 ID 平台错题可写入', Boolean(ghostRow) && ghostRow.content === '幽灵题');

  // 4) 自建错题：创建 → 列表 → 复习 → 编辑（保留进度）
  const custom = database.saveCustomWrongQuestion({
    type: 'multiple', category: 'ziliao', content: '自建多选题干',
    options: [{ key: 'A', content: '一' }, { key: 'B', content: '二' }, { key: 'C', content: '三' }],
    userAnswer: 'A', answer: 'AB', analysis: '自建解析',
    sourceType: 'manual', sourceLabel: '2024 省考卷一', reason: '概念不清', note: '注意陷阱选项',
  });
  check('自建错题创建', Boolean(custom?.id) && String(custom.id).startsWith('wrong_custom_'), custom?.id);
  check('自建错题来源标记 manual', custom.source_type === 'manual');
  check('自建错题来源说明映射', custom.paper_title === '2024 省考卷一');
  check('自建错题多选答案', custom.answer === 'AB' && custom.options.length === 3);

  const listed = database.getWrongQuestions();
  check('错题列表含新旧记录', listed.length >= 3, `count=${listed.length}`);

  const reviewed = database.reviewWrongQuestion(custom.id, 'remembered');
  check('自建错题可复习（按 id）', reviewed.review_count === 1 && reviewed.review_stage === 1 && !reviewed.is_due);

  const edited = database.saveCustomWrongQuestion({
    id: custom.id, type: 'multiple', category: 'ziliao', content: '自建多选题干（改）',
    options: [{ key: 'A', content: '一' }, { key: 'B', content: '二' }],
    answer: 'AB', analysis: '解析已补充', sourceType: 'manual', reason: '计算错误',
    // 真实表单会回填全量字段，这里保持一致，避免来源被清空
    sourceLabel: '2024 省考卷一',
  });
  check('编辑保留复习进度', edited.review_stage === 1 && edited.review_count === 1);
  check('编辑内容已更新', edited.content === '自建多选题干（改）' && edited.reason === '计算错误');

  // 平台错题不允许被自建表单覆盖
  let blocked = false;
  try { database.saveCustomWrongQuestion({ id: 'wrong_q1', content: 'x', answer: 'A' }); } catch (_) { blocked = true; }
  check('平台错题禁止自建编辑覆盖', blocked);

  // 5) 筛选与搜索
  const manualOnly = database.getWrongQuestions({ sourceType: 'manual' });
  check('来源筛选 manual', manualOnly.length === 1 && manualOnly[0].id === custom.id, `count=${manualOnly.length}`);
  const platformOnly = database.getWrongQuestions({ sourceType: 'platform' });
  check('来源筛选 platform', platformOnly.length === 2, `count=${platformOnly.length}`);
  const searched = database.getWrongQuestions({ query: '省考卷一' });
  check('关键词搜索命中来源', searched.length === 1 && searched[0].id === custom.id, `count=${searched.length}`);
  const searchedContent = database.getWrongQuestions({ query: '幽灵' });
  check('关键词搜索命中题干', searchedContent.length === 1 && searchedContent[0].id === 'wrong_ghost_1');
  const dueList = database.getWrongQuestions({ dueOnly: true });
  check('到期筛选可用', dueList.every((row) => row.is_due));

  // 6) 图片落盘 + 删除清理
  const wrongAssets = require(path.join(__dirname, '..', 'src', 'main', 'wrongAssets.js'));
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const imgSaved = wrongAssets.saveImage({ wrongId: custom.id, dataUrl: `data:image/png;base64,${pngBase64}` });
  check('错题图片落盘', imgSaved.success === true && imgSaved.url.startsWith('openexam-asset://wrong-assets/'), imgSaved.error || imgSaved.url);
  const resolved = wrongAssets.resolveWrongAssetPath(`${custom.id}/${imgSaved.file}`);
  check('图片路径可解析且存在', Boolean(resolved) && fs.existsSync(resolved));

  const withImg = database.saveCustomWrongQuestion({
    type: 'single', content: '', options: [], answer: 'A',
    images: [imgSaved.url], sourceType: 'upload', sourceLabel: '拍照错题',
  });
  check('纯图片错题可保存（无题干）', Boolean(withImg?.id) && withImg.source_type === 'upload' && withImg.images.length === 1);

  database.removeWrongQuestion({ id: withImg.id });
  check('删除错题后记录消失', !database.getWrongQuestionById(withImg.id));
  const imgDir = path.join(wrongAssets.wrongRoot(), withImg.id);
  check('删除错题后图片目录清理', !fs.existsSync(imgDir));

  // 7) 备份导出携带快照
  const backup = database.exportAllData();
  check('导出含自建错题', Array.isArray(backup.data.wrong_questions) && backup.data.wrong_questions.some((row) => row.id === custom.id));
  const exportHasSnapshot = backup.data.wrong_questions.some((row) => row.id === custom.id && row.q_content && row.q_answer);
  check('导出携带快照列', exportHasSnapshot);

  console.log('---');
  const failed = results.filter((r) => !r.ok);
  console.log(`结果: ${results.length - failed.length}/${results.length} 通过`);
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  process.exit(failed.length ? 1 : 0);
} catch (error) {
  console.error('验证脚本异常:', error);
  process.exit(1);
}
