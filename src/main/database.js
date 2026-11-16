const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { normalizeQuestionTaxonomy, isFakeQuestion } = require('../shared/questionCategory');
const { SUBJECTS, normalizeClassification, MODULE_LABELS } = require('../shared/knowledgeTaxonomy');
const { hasUsableMaterial, isPracticeableQuestion, parseOptions } = require('../shared/questionQuality');
const { patchQuestionDatabase } = require('../shared/questionQualityRepair');
const {
  TEXTBOOK_FORMAT_VERSION,
  formatQuestionForStorage,
  formatQuestionRow,
  formatQuestionText,
  toTextbookHtml,
} = require('../shared/textbookFormat');
const achievementCatalog = require('../shared/achievementCatalog.json');
const studyPlan = require('./studyPlan.js');

let db = null;

const REVIEW_INTERVAL_DAYS = [0, 1, 2, 4, 7, 15, 30];
const USER_GENERATED_PAPER_TYPES = ['imported', 'ai_exam', 'ai_practice'];
const USER_GENERATED_PAPER_TYPE_SQL = USER_GENERATED_PAPER_TYPES.map((type) => `\'${type}\'`).join(', ');
const PAPER_PROVINCE_ALIASES = {
  '北京市': '北京',
  '天津市': '天津',
  '上海市': '上海',
  '重庆市': '重庆',
  '深圳市': '深圳',
  '内蒙古自治区': '内蒙古',
  '广西壮族自治区': '广西',
  '宁夏回族自治区': '宁夏',
  '新疆维吾尔自治区': '新疆',
  '西藏自治区': '西藏',
  '香港特别行政区': '香港',
  '澳门特别行政区': '澳门',
};

function normalizePaperProvince(value) {
  const province = String(value || '').trim();
  if (!province) return null;
  if (PAPER_PROVINCE_ALIASES[province]) return PAPER_PROVINCE_ALIASES[province];
  if (province.endsWith('省') || province.endsWith('市')) return province.slice(0, -1);
  return province;
}

function normalizePaperRecord(paper = {}) {
  return {
    ...paper,
    province: paper?.type === 'national' ? null : (normalizePaperProvince(paper?.province) || null),
  };
}

function normalizePaperRecords(records = []) {
  return Array.isArray(records) ? records.map((record) => normalizePaperRecord(record)) : [];
}

function normalizePaperProvinceData() {
  const rows = db.prepare('SELECT id, type, province FROM papers').all();
  if (!rows.length) return;

  const update = db.prepare('UPDATE papers SET province = ? WHERE id = ?');
  db.transaction(() => {
    rows.forEach((row) => {
      const nextProvince = row.type === 'national' ? null : (normalizePaperProvince(row.province) || null);
      const currentProvince = row.province == null || String(row.province).trim() === '' ? null : row.province;
      if (nextProvince !== currentProvince) update.run(nextProvince, row.id);
    });
  })();
}

const SYSTEM_SEED_PURGE_KEY = 'migration:purge_system_seed_v2';

/**
 * 一次性清理「历史内置官方题库」。
 *
 * 旧版每次启动都按标题/科目模糊删除，用户自己导入的、标题里恰好带
 * 「行测/公务员/国考」的试卷也会被误删。这里改成：
 *   1. 只按内置题库的 ID 前缀 / 旧示例 ID / 官方真题 type 精确识别；
 *   2. 显式排除 imported / ai_exam / ai_practice（含 Obsidian 导入）；
 *   3. 用 app_settings 迁移标记保证全局只执行一次，之后永不再删用户数据。
 */
function purgeBundledSystemContentOnce() {
  // 注意：这里刻意每次启动都执行。查询条件只认内置题库 ID 前缀 / 旧示例 ID /
  // 官方真题 type，并显式排除用户生成的试卷类型，因此重复执行是幂等的、
  // 不可能误删用户数据；换成「只跑一次」反而会让备份还原回来的系统题漏网。
  const legacyPaperIds = db.prepare(`
    SELECT id FROM papers
    WHERE COALESCE(type, '') NOT IN (${USER_GENERATED_PAPER_TYPE_SQL})
      AND (
           id LIKE 'paper_oe_%'
        OR id IN ('paper_2024_national', 'paper_2024_beijing', 'paper_2023_national')
        OR (COALESCE(subject, '') IN ('xingce', 'shiye')
            AND COALESCE(type, '') IN ('national', 'provincial', 'mock', 'real', 'zhenshi'))
      )
  `).all().map((row) => row.id).filter(Boolean);

  const result = { purged: legacyPaperIds.length > 0, reason: 'ok', papers: 0, questions: 0 };
  db.transaction(() => {
    if (legacyPaperIds.length) {
      const placeholders = legacyPaperIds.map(() => '?').join(', ');
      result.questions = db.prepare(`DELETE FROM questions WHERE paper_id IN (${placeholders})`).run(...legacyPaperIds).changes;
      db.prepare(`DELETE FROM wrong_questions WHERE paper_id IN (${placeholders})`).run(...legacyPaperIds);
      db.prepare(`DELETE FROM practice_records WHERE paper_id IN (${placeholders})`).run(...legacyPaperIds);
      result.papers = db.prepare(`DELETE FROM papers WHERE id IN (${placeholders})`).run(...legacyPaperIds).changes;
    }
    db.prepare(`
      INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(SYSTEM_SEED_PURGE_KEY, JSON.stringify({ at: new Date().toISOString(), ...result }));
  })();
  return result;
}

/** 兼容更早版本创建的暂存表：补齐后续新增的列。 */
function ensureImportStagingSchema() {
  const columns = db.prepare('PRAGMA table_info(import_staging)').all().map((row) => row.name);
  const additions = [
    ['batch_id', 'TEXT'],
    ['error', 'TEXT'],
    ['paper_id', 'TEXT'],
    ['updated_at', 'TEXT'],
    ['committed_at', 'TEXT'],
    ['meta', 'TEXT'],
  ];
  additions.forEach(([name, definition]) => {
    if (!columns.includes(name)) db.prepare(`ALTER TABLE import_staging ADD COLUMN ${name} ${definition}`).run();
  });
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_import_staging_status ON import_staging(status, task_id);
    CREATE INDEX IF NOT EXISTS idx_import_staging_task ON import_staging(task_id, created_at);
  `);
}

function toSQLiteDateTime(input = new Date()) {
  const date = input instanceof Date ? input : new Date(input);
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/** 本地日历日 YYYY-MM-DD（避免 toISOString 的 UTC 偏移） */
function toLocalDateStr(input = new Date()) {
  const date = input instanceof Date ? input : new Date(input);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 本地某日 [start, end) 对应的 UTC SQLite 时间字符串 */
function getLocalDayBounds(offsetDays = 0) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + offsetDays);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return {
    start: toSQLiteDateTime(start),
    end: toSQLiteDateTime(end),
    dateStr: toLocalDateStr(start),
  };
}

function parseSQLiteDateTime(value) {
  if (!value) return null;
  const normalized = String(value).replace(' ', 'T');
  const withZone = /z$/i.test(normalized) ? normalized : `${normalized}Z`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDays(dateTime, days = 0) {
  const next = new Date(dateTime instanceof Date ? dateTime : new Date(dateTime));
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function getNextReviewAt(stage = 0, from = new Date()) {
  const safeStage = Math.max(0, Math.min(stage, REVIEW_INTERVAL_DAYS.length - 1));
  return toSQLiteDateTime(addDays(from, REVIEW_INTERVAL_DAYS[safeStage] || 0));
}

function ensurePracticeRecordsSchema() {
  const columns = db.pragma('table_info(practice_records)');
  if (!Array.isArray(columns) || !columns.length) return;

  const byName = new Map(columns.map((column) => [column.name, column]));
  const needsRebuild = [
    'category',
    'sub_category',
    'accuracy',
    'created_at'
  ].some((name) => !byName.has(name)) || Number(byName.get('paper_id')?.notnull || 0) !== 0;

  if (!needsRebuild) return;

  const hasColumn = (name) => byName.has(name);
  const pick = (name, fallback) => hasColumn(name) ? name : fallback;
  const accuracyExpr = hasColumn('accuracy')
    ? `COALESCE(accuracy, CASE WHEN COALESCE(total_count, 0) > 0 THEN ROUND(COALESCE(correct_count, 0) * 100.0 / total_count) ELSE 0 END)`
    : `CASE WHEN COALESCE(total_count, 0) > 0 THEN ROUND(COALESCE(correct_count, 0) * 100.0 / total_count) ELSE 0 END`;

  db.transaction(() => {
    db.exec(`
      CREATE TABLE practice_records_new (
        id TEXT PRIMARY KEY,
        paper_id TEXT,
        category TEXT,
        sub_category TEXT,
        start_time TEXT NOT NULL,
        end_time TEXT,
        duration INTEGER,
        status TEXT DEFAULT 'ongoing',
        answers TEXT,
        correct_count INTEGER DEFAULT 0,
        total_count INTEGER DEFAULT 0,
        accuracy INTEGER DEFAULT 0,
        score INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      INSERT INTO practice_records_new (
        id, paper_id, category, sub_category, start_time, end_time, duration,
        status, answers, correct_count, total_count, accuracy, score, created_at
      )
      SELECT
        ${pick('id', 'lower(hex(randomblob(16)))')},
        ${pick('paper_id', 'NULL')},
        ${pick('category', 'NULL')},
        ${pick('sub_category', 'NULL')},
        ${pick('start_time', 'CURRENT_TIMESTAMP')},
        ${pick('end_time', 'NULL')},
        ${pick('duration', '0')},
        ${pick('status', "'ongoing'")},
        ${pick('answers', "'{}'")},
        ${pick('correct_count', '0')},
        ${pick('total_count', '0')},
        ${accuracyExpr},
        ${pick('score', '0')},
        ${pick('created_at', "COALESCE(start_time, CURRENT_TIMESTAMP)")}
      FROM practice_records;

      DROP TABLE practice_records;
      ALTER TABLE practice_records_new RENAME TO practice_records;
    `);
  })();
}

function ensurePracticeRecordsMetaColumn() {
  const columns = db.pragma('table_info(practice_records)');
  if (!Array.isArray(columns) || !columns.length) return;
  if (columns.some((column) => column.name === 'meta')) return;
  db.exec('ALTER TABLE practice_records ADD COLUMN meta TEXT');
}

function ensureWrongQuestionsSchema() {
  const columns = db.pragma('table_info(wrong_questions)');
  if (!Array.isArray(columns) || !columns.length) return;

  // 存量安装里 wrong_questions 可能带 `FOREIGN KEY (question_id) REFERENCES questions(id)`，
  // 但自建错题用的是虚拟题目 ID，会违反外键。这里把表重建一遍去掉外键约束。
  const fks = db.pragma('foreign_key_list(wrong_questions)');
  if (Array.isArray(fks) && fks.length > 0) {
    db.exec(`
      ALTER TABLE wrong_questions RENAME TO wrong_questions_legacy;
      CREATE TABLE wrong_questions (
        id TEXT PRIMARY KEY,
        question_id TEXT NOT NULL,
        paper_id TEXT NOT NULL DEFAULT '',
        user_answer TEXT,
        correct_answer TEXT,
        added_at TEXT DEFAULT CURRENT_TIMESTAMP,
        review_count INTEGER DEFAULT 0,
        last_review TEXT,
        next_review_at TEXT,
        review_stage INTEGER DEFAULT 0
      );
      INSERT INTO wrong_questions (
        id, question_id, paper_id, user_answer, correct_answer,
        added_at, review_count, last_review, next_review_at, review_stage
      )
      SELECT
        id, question_id, paper_id, user_answer, correct_answer,
        added_at, review_count, last_review, next_review_at, review_stage
      FROM wrong_questions_legacy;
      DROP TABLE wrong_questions_legacy;
    `);
  }

  const currentColumns = db.pragma('table_info(wrong_questions)');
  const byName = new Set(currentColumns.map((column) => column.name));
  const additions = [
    ['review_count', 'INTEGER DEFAULT 0'],
    ['last_review', 'TEXT'],
    ['next_review_at', 'TEXT'],
    ['review_stage', 'INTEGER DEFAULT 0'],
    ['source_type', "TEXT DEFAULT 'platform'"],
    ['source_label', 'TEXT'],
    ['q_type', "TEXT DEFAULT 'single'"],
    ['q_content', 'TEXT'],
    ['q_content_html', 'TEXT'],
    ['q_options', 'TEXT'],
    ['q_analysis', 'TEXT'],
    ['q_analysis_html', 'TEXT'],
    ['q_category', 'TEXT'],
    ['q_sub_category', 'TEXT'],
    ['q_answer', 'TEXT'],
    ['images', 'TEXT'],
    ['reason', 'TEXT'],
    ['note', 'TEXT'],
  ];

  additions.forEach(([name, definition]) => {
    if (!byName.has(name)) {
      db.prepare(`ALTER TABLE wrong_questions ADD COLUMN ${name} ${definition}`).run();
    }
  });

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_wrong_questions_question_id ON wrong_questions(question_id);
    CREATE INDEX IF NOT EXISTS idx_wrong_questions_next_review_at ON wrong_questions(next_review_at);
  `);

  db.prepare(`
    UPDATE wrong_questions
    SET next_review_at = COALESCE(next_review_at, added_at, datetime('now')),
        review_stage = COALESCE(review_stage, 0),
        review_count = COALESCE(review_count, 0),
        source_type = COALESCE(source_type, 'platform'),
        q_type = COALESCE(q_type, 'single')
    WHERE next_review_at IS NULL OR review_stage IS NULL OR review_count IS NULL
      OR source_type IS NULL OR q_type IS NULL
  `).run();
}

function ensureQuestionsSchema() {
  const columns = db.pragma('table_info(questions)');
  if (!Array.isArray(columns) || !columns.length) return;

  const byName = new Set(columns.map((column) => column.name));
  const additions = [
    ['content_html', 'TEXT'],
    ['analysis_html', 'TEXT'],
    ['material_html', 'TEXT'],
    ['material_group_id', 'TEXT'],
    ['quality_flag', 'TEXT'],
    ['chapter', 'TEXT'],
    ['answer_source', "TEXT DEFAULT 'imported'"],
    ['answer_status', "TEXT DEFAULT 'unverified'"],
    ['answer_confidence', 'REAL'],
    ['answer_updated_at', 'TEXT'],
    // 用户补充的答案图片：JSON 数组，存 openexam-asset://question-assets/... 引用，图片文件本身不落库
    ['answer_images', 'TEXT'],
    ['textbook_format_version', 'INTEGER DEFAULT 0'],
  ];

  additions.forEach(([name, definition]) => {
    if (!byName.has(name)) {
      db.prepare(`ALTER TABLE questions ADD COLUMN ${name} ${definition}`).run();
    }
  });

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_questions_paper_id ON questions(paper_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_questions_paper_order_unique ON questions(paper_id, order_num);
    CREATE INDEX IF NOT EXISTS idx_questions_material_group ON questions(material_group_id);
  `);
}

function ensureAiChatSchema() {
  const sessionColumns = db.pragma('table_info(ai_chat_sessions)');
  if (Array.isArray(sessionColumns) && sessionColumns.length) {
    const names = new Set(sessionColumns.map((column) => column.name));
    if (!names.has('context_json')) db.prepare('ALTER TABLE ai_chat_sessions ADD COLUMN context_json TEXT').run();
    if (!names.has('source')) db.prepare("ALTER TABLE ai_chat_sessions ADD COLUMN source TEXT DEFAULT 'chat'").run();
    // 置顶时间：为空表示未置顶；置顶会话在列表里排在最前
    if (!names.has('pinned_at')) db.prepare('ALTER TABLE ai_chat_sessions ADD COLUMN pinned_at TEXT').run();
  }

  const messageColumns = db.pragma('table_info(ai_chat_messages)');
  if (Array.isArray(messageColumns) && messageColumns.length) {
    const names = new Set(messageColumns.map((column) => column.name));
    if (!names.has('meta')) db.prepare('ALTER TABLE ai_chat_messages ADD COLUMN meta TEXT').run();
  }
}

/**
 * 每日一练：只记录「当天抽到的题目集合」与完成状态。
 * 作答进度仍复用 practice_records（paper_id = daily_<本地日期>），
 * 因此中断后可以直接沿用现有的继续作答逻辑。
 */
function ensureDailyPracticeSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_practice (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      category TEXT NOT NULL,
      category_label TEXT,
      question_ids TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ongoing',
      correct_count INTEGER DEFAULT 0,
      total_count INTEGER DEFAULT 0,
      accuracy INTEGER DEFAULT 0,
      completed_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_practice_date ON daily_practice(date);
  `);
}

// 打开主库并切到 WAL；失败时关闭连接，交给上层决定是否重试
function openDatabaseFile(dbPath) {
  const conn = new Database(dbPath);
  try {
    conn.pragma('journal_mode = WAL');
    return conn;
  } catch (error) {
    try { conn.close(); } catch { /* 忽略 */ }
    throw error;
  }
}

/**
 * 打开主库。上次解析中途被强制结束时，可能留下无法回放的 -wal/-shm
 * （文件仍被映射时 SQLite 报 SQLITE_IOERR_TRUNCATE / SQLITE_CANTOPEN），
 * 导致之后每次启动都卡在 WAL 初始化。这里清理残留文件后重试一次，
 * 让应用能从异常退出中恢复，而不是永远打不开。
 */
function openDatabaseWithRecovery(dbPath) {
  try {
    return openDatabaseFile(dbPath);
  } catch (error) {
    console.warn('[DB] 主库 WAL 初始化失败，尝试清理上次中断留下的 WAL/SHM 后重试:', error?.message || error);
    for (const suffix of ['-wal', '-shm']) {
      try {
        fs.rmSync(`${dbPath}${suffix}`, { force: true });
      } catch (cleanupError) {
        console.warn(`[DB] 清理 ${suffix} 失败:`, cleanupError?.message || cleanupError);
      }
    }
    return openDatabaseFile(dbPath);
  }
}

// 初始化数据库
function initDatabase() {
  const userDataPath = app.getPath('userData');
  const dbPath = path.join(userDataPath, 'openexam.db');

  fs.mkdirSync(userDataPath, { recursive: true });

  // 不再从内置种子库初始化：新用户得到的是空题库，只保存用户自己传入的内容。
  db = openDatabaseWithRecovery(dbPath);

  // 创建表
  db.exec(`
    -- 试卷表
    CREATE TABLE IF NOT EXISTS papers (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      year INTEGER NOT NULL,
      type TEXT NOT NULL,
      subject TEXT NOT NULL,
      province TEXT,
      question_count INTEGER DEFAULT 0,
      duration INTEGER DEFAULT 120,
      difficulty INTEGER DEFAULT 3,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- 题目表
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      paper_id TEXT NOT NULL,
      order_num INTEGER NOT NULL,
      type TEXT DEFAULT 'single',
      category TEXT,
      sub_category TEXT,
      content TEXT NOT NULL,
      content_html TEXT,
      material_html TEXT,
      material_group_id TEXT,
      options TEXT NOT NULL,
      answer TEXT NOT NULL,
      answer_images TEXT,
      analysis TEXT,
      analysis_html TEXT,
      difficulty INTEGER DEFAULT 2,
      tags TEXT,
      quality_flag TEXT,
      textbook_format_version INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (paper_id) REFERENCES papers(id)
    );

    -- 练习记录表
    CREATE TABLE IF NOT EXISTS practice_records (
      id TEXT PRIMARY KEY,
      paper_id TEXT,
      category TEXT,
      sub_category TEXT,
      start_time TEXT NOT NULL,
      end_time TEXT,
      duration INTEGER,
      status TEXT DEFAULT 'ongoing',
      answers TEXT,
      correct_count INTEGER DEFAULT 0,
      total_count INTEGER DEFAULT 0,
      accuracy INTEGER DEFAULT 0,
      score INTEGER DEFAULT 0,
      meta TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- 错题本
    -- 关键设计：错题记录自带题目快照（q_* 列），不再依赖 questions 表。
    -- 这样用户手动录入 / 上传的错题（虚拟题目 ID）也能独立存在，
    -- 平台错题即便原试卷被删除也不会丢。因此不再设外键约束。
    CREATE TABLE IF NOT EXISTS wrong_questions (
      id TEXT PRIMARY KEY,
      question_id TEXT NOT NULL,
      paper_id TEXT NOT NULL DEFAULT '',
      user_answer TEXT,
      correct_answer TEXT,
      added_at TEXT DEFAULT CURRENT_TIMESTAMP,
      review_count INTEGER DEFAULT 0,
      last_review TEXT,
      next_review_at TEXT,
      review_stage INTEGER DEFAULT 0,
      source_type TEXT DEFAULT 'platform',
      source_label TEXT,
      q_type TEXT DEFAULT 'single',
      q_content TEXT,
      q_content_html TEXT,
      q_options TEXT,
      q_analysis TEXT,
      q_analysis_html TEXT,
      q_category TEXT,
      q_sub_category TEXT,
      q_answer TEXT,
      images TEXT,
      reason TEXT,
      note TEXT
    );

    -- 应用设置表（持久化 AI 配置等）
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- AI 聊天会话
    CREATE TABLE IF NOT EXISTS ai_chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      message_count INTEGER DEFAULT 0,
      last_message_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- AI 聊天消息
    CREATE TABLE IF NOT EXISTS ai_chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES ai_chat_sessions(id)
    );

    -- 导入暂存：识别成功即落盘，窗口被卸载 / 进程崩溃 / 重启后都能恢复
    CREATE TABLE IF NOT EXISTS import_staging (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      batch_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      payload TEXT NOT NULL,
      meta TEXT,
      error TEXT,
      paper_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      committed_at TEXT
    );
  `);

  ensurePracticeRecordsSchema();
  ensurePracticeRecordsMetaColumn();
  ensureWrongQuestionsSchema();
  ensureQuestionsSchema();
  ensureAiChatSchema();
  ensureDailyPracticeSchema();
  ensureImportStagingSchema();
  normalizePaperProvinceData();
  try {
    const purgeResult = purgeBundledSystemContentOnce();
    if (purgeResult.purged && purgeResult.papers) {
      console.log(`已清理内置官方题库：${purgeResult.papers} 份试卷 / ${purgeResult.questions} 道题（用户导入内容完整保留）`);
    }
  } catch (error) {
    console.error('清理内置官方题库失败（不影响用户数据）:', error);
  }

  // 「备考方向」已下线：清掉旧版本写入的存储字段
  try {
    db.prepare("DELETE FROM app_settings WHERE key = 'exam_track'").run();
  } catch (error) {
    console.error('清理旧版备考方向配置失败（忽略）:', error);
  }

  // 备考待办 / 笔记 / 申论 / 词语 数据层
  try {
    studyPlan.initStudyPlan(db);
  } catch (error) {
    console.error('备考待办模块初始化失败:', error);
  }

  try {
    repairQuestionQuality();
  } catch (error) {
    console.error('题库质量修补失败:', error);
  }

  // 存量题库一次性升级为教材式排版（新写入的题目在落库前就已格式化，这里会被跳过）
  try {
    migrateTextbookFormat();
  } catch (error) {
    console.error('题库教材格式迁移失败:', error);
  }

  return db;
}

// 内置示例试卷/题目已移除：应用不再自带任何官方题目。

// 获取所有试卷
function getPapers() {
  // 顺带算出每份试卷「既没有文字答案、也没有图片答案」的题数，题库列表直接标出来
  const rows = db.prepare(`
    SELECT p.*,
           (
             SELECT COUNT(*)
             FROM questions q
             WHERE q.paper_id = p.id
               AND TRIM(COALESCE(q.answer, '')) = ''
               AND COALESCE(NULLIF(TRIM(q.answer_images), ''), '[]') IN ('[]', 'null')
           ) AS missing_answer_count
    FROM papers p
    ORDER BY p.year DESC, p.created_at DESC
  `).all();
  return normalizePaperRecords(rows);
}

// 获取试卷题目；limit 用于「只做题目选择器」这类只要前 N 道的场景
function getQuestionsByPaperId(paperId, limit) {
  const max = Number(limit);
  const rows = Number.isFinite(max) && max > 0
    ? db.prepare('SELECT * FROM questions WHERE paper_id = ? ORDER BY order_num LIMIT ?').all(paperId, Math.floor(max))
    : db.prepare('SELECT * FROM questions WHERE paper_id = ? ORDER BY order_num').all(paperId);
  return rows.map(mapQuestionRow);
}

// 保存练习记录
function normalizePracticeMeta(meta) {
  if (!meta) return null;
  if (typeof meta === 'string') {
    try { return JSON.parse(meta); } catch (error) { return null; }
  }
  if (typeof meta === 'object') return meta;
  return null;
}

/**
 * 每日一练的完成状态以 practice_records 为准：
 * 只要这次练习回到未完成/待自评，今日页的每日一练也同步回落。
 */
function syncDailyPracticeFromRecord(record = {}) {
  const paperId = String(record.paperId || record.paper_id || '');
  if (!paperId.startsWith('daily_')) return;
  const date = paperId.slice('daily_'.length);
  const completed = String(record.status || '') === 'completed';
  db.prepare(`
    UPDATE daily_practice
    SET status = ?, correct_count = ?, total_count = ?, accuracy = ?,
        completed_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE date = ?
  `).run(
    completed ? 'done' : 'ongoing',
    Number(record.correctCount ?? record.correct_count) || 0,
    Number(record.totalCount ?? record.total_count) || 0,
    Number(record.accuracy) || 0,
    completed ? toSQLiteDateTime() : null,
    date
  );
}

function savePracticeRecord(record) {
  const meta = normalizePracticeMeta(record.meta);
  // 只在本次由「未完成」跨到「已完成」时回写待办，避免答题中途的自动保存重复计数
  const previous = db.prepare('SELECT status FROM practice_records WHERE id = ?').get(record.id);
  const justCompleted = record.status === 'completed' && previous?.status !== 'completed';
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO practice_records
    (id, paper_id, category, sub_category, start_time, end_time, duration, status, answers, correct_count, total_count, accuracy, score, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    record.id,
    record.paperId || null,
    record.category || null,
    record.subCategory || null,
    record.startTime,
    record.endTime,
    record.duration,
    record.status,
    JSON.stringify(record.answers || {}),
    record.correctCount,
    record.totalCount,
    record.accuracy || 0,
    record.score || 0,
    meta ? JSON.stringify(meta) : null
  );

  if (justCompleted) {
    try {
      const answered = Number(record.totalCount) || Object.keys(record.answers || {}).length;
      if (answered > 0) {
        // 逻辑填空即是词语积累的练法，单独计入词语待办
        const kind = record.subCategory === 'xuanci' ? 'vocab' : 'drill';
        studyPlan.bumpTodoProgress(kind, answered);
      }
    } catch (error) {
      console.error('回写待办进度失败:', error);
    }
  }

  syncDailyPracticeFromRecord({
    paperId: record.paperId,
    status: record.status,
    correctCount: record.correctCount,
    totalCount: record.totalCount,
    accuracy: record.accuracy,
  });
}

// 获取练习记录
function getPracticeRecords() {
  const rows = db.prepare(`
    SELECT pr.*, p.title as paper_title
    FROM practice_records pr
    LEFT JOIN papers p ON pr.paper_id = p.id
    ORDER BY pr.start_time DESC
  `).all();
  return rows.map(row => ({
    ...row,
    answers: row.answers ? JSON.parse(row.answers) : {},
    meta: normalizePracticeMeta(row.meta),
  }));
}

/**
 * 科目可用的最完整知识清单。
 * subjects.knowledge_summary 会被截断（当前真实库只有 868 字，缺后几章），
 * 优先用同科目「知识清单」笔记的完整内容，保证分类目录不缺章。
 */
function getSubjectKnowledgeContent(subjectId) {
  const id = String(subjectId || '').trim();
  if (!id) return '';
  const summary = String(db.prepare('SELECT knowledge_summary FROM subjects WHERE id = ?').get(id)?.knowledge_summary || '');
  const note = db.prepare(`
    SELECT content FROM notes
    WHERE subject_id = ? AND title LIKE '%知识清单%' AND COALESCE(content, '') <> ''
    ORDER BY length(content) DESC
    LIMIT 1
  `).get(id);
  const content = String(note?.content || '');
  return content.length > summary.length ? content : summary;
}

/** 一批试卷对应的科目（含教材知识清单），重新分类时用来判断是否自建科目 */
function getSubjectsForPaperIds(paperIds = []) {
  const ids = Array.from(new Set((Array.isArray(paperIds) ? paperIds : []).map((id) => String(id || '').trim()).filter(Boolean)));
  if (!ids.length) return {};
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT p.id AS paper_id, s.id, s.name, s.category_key, s.knowledge_summary
    FROM papers p
    JOIN subjects s ON s.id = p.subject_id
    WHERE p.id IN (${placeholders})
  `).all(...ids);
  return Object.fromEntries(rows.map((row) => [row.paper_id, {
    id: row.id,
    name: row.name,
    categoryKey: String(row.category_key || ''),
    knowledgeSummary: getSubjectKnowledgeContent(row.id) || String(row.knowledge_summary || ''),
  }]));
}

function getQuestionsByIds(ids = []) {
  const list = Array.isArray(ids) ? ids.map((id) => String(id || '').trim()).filter(Boolean) : [];
  if (!list.length) return [];
  const placeholders = list.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT * FROM questions WHERE id IN (${placeholders})`).all(...list);
  const byId = new Map(rows.map((row) => [row.id, mapQuestionRow(row)]));
  return list.map((id) => byId.get(id)).filter(Boolean);
}

// ---------- 错题本（自带题目快照，不依赖 questions 表） ----------

const WRONG_MAX_IMAGES = 12;
const WRONG_ALLOWED_TYPES = ['single', 'multiple', 'judge', 'fill', 'subjective'];

let _wrongAssets = null;
function getWrongAssets() {
  if (!_wrongAssets) _wrongAssets = require('./wrongAssets.js');
  return _wrongAssets;
}

function parseSafeJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function escapeWrongHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeWrongType(type) {
  return WRONG_ALLOWED_TYPES.includes(String(type || '')) ? String(type) : 'single';
}

function normalizeWrongOptions(input) {
  const raw = Array.isArray(input) ? input : [];
  const seen = new Set();
  return raw
    .map((opt, index) => ({
      key: String(opt?.key ?? String.fromCharCode(65 + index)),
      content: String(opt?.content ?? ''),
    }))
    .filter((opt) => {
      if (!opt.key || seen.has(opt.key)) return false;
      seen.add(opt.key);
      return true;
    });
}

function normalizeWrongImages(input) {
  const raw = Array.isArray(input) ? input : [];
  return raw
    .map((url) => String(url || ''))
    .filter((url) => url.startsWith('openexam-asset://wrong-assets/') || /^https?:\/\//.test(url))
    .slice(0, WRONG_MAX_IMAGES);
}

function readQuestionById(questionId) {
  if (!questionId) return null;
  const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(String(questionId));
  if (!row) return null;
  return {
    type: row.type,
    category: row.category,
    sub_category: row.sub_category,
    content: row.content,
    content_html: row.content_html,
    options: row.options ? parseSafeJson(row.options) : [],
    answer: row.answer,
    analysis: row.analysis,
    analysis_html: row.analysis_html,
  };
}

function buildSnapshotFromQuestion(question) {
  if (!question) return null;
  return {
    type: String(question.type || 'single'),
    content: String(question.content || ''),
    contentHtml: String(question.content_html || ''),
    options: question.options,
    analysis: String(question.analysis || ''),
    analysisHtml: String(question.analysis_html || ''),
    category: String(question.category || ''),
    subCategory: String(question.sub_category || ''),
    answer: String(question.answer || ''),
  };
}

// 添加错题（平台做题自动记入）。优先用调用方传入的 snapshot，否则回退到 questions 表。
function addWrongQuestion(questionId, paperId, userAnswer, correctAnswer, snapshot) {
  const id = `wrong_${String(questionId || '').trim()}`;
  let snap = snapshot && typeof snapshot === 'object' ? snapshot : null;
  if (!snap) snap = buildSnapshotFromQuestion(readQuestionById(questionId));
  snap = snap || {};
  const now = toSQLiteDateTime();
  db.prepare(`
    INSERT INTO wrong_questions (
      id, question_id, paper_id, user_answer, correct_answer,
      added_at, next_review_at, review_stage,
      source_type, source_label, q_type, q_content, q_content_html, q_options,
      q_analysis, q_analysis_html, q_category, q_sub_category, q_answer, images, reason
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'platform', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      paper_id = excluded.paper_id,
      user_answer = excluded.user_answer,
      correct_answer = excluded.correct_answer,
      added_at = excluded.added_at,
      next_review_at = excluded.next_review_at,
      review_stage = 0,
      source_type = 'platform',
      q_type = excluded.q_type,
      q_content = excluded.q_content,
      q_content_html = excluded.q_content_html,
      q_options = excluded.q_options,
      q_analysis = excluded.q_analysis,
      q_analysis_html = excluded.q_analysis_html,
      q_category = excluded.q_category,
      q_sub_category = excluded.q_sub_category,
      q_answer = excluded.q_answer,
      images = excluded.images
  `).run(
    id,
    String(questionId || ''),
    String(paperId || ''),
    userAnswer ? String(userAnswer) : null,
    correctAnswer ? String(correctAnswer) : null,
    now,
    now,
    null,
    String(snap.type || 'single'),
    String(snap.content || ''),
    String(snap.contentHtml || ''),
    JSON.stringify(normalizeWrongOptions(snap.options)),
    String(snap.analysis || ''),
    String(snap.analysisHtml || ''),
    String(snap.category || ''),
    String(snap.subCategory || ''),
    String(snap.answer || ''),
    JSON.stringify(normalizeWrongImages(snap.images)),
    null
  );
}

// 保存自建错题：首次创建或编辑已有记录（保留复习进度）。
function saveCustomWrongQuestion(input = {}) {
  const existingId = String(input?.id || '').trim();
  // 平台错题（wrong_<questionId>）不允许被自建表单覆盖，避免破坏平台记录
  if (existingId && existingId.startsWith('wrong_') && !existingId.startsWith('wrong_custom_')) {
    throw new Error('这条错题来自平台练习，不能在此编辑');
  }

  const id = existingId || `wrong_custom_${crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`}`;
  const type = normalizeWrongType(input.type);
  const content = String(input.content || '').trim();
  const images = normalizeWrongImages(input.images);
  const sourceType = ['manual', 'upload'].includes(String(input.sourceType || ''))
    ? input.sourceType
    : (images.length ? 'upload' : 'manual');

  if (!content && images.length === 0) throw new Error('请填写题干，或至少上传一张图片');
  if (!type) throw new Error('请选择题型');

  const now = toSQLiteDateTime();
  db.prepare(`
    INSERT INTO wrong_questions (
      id, question_id, paper_id, user_answer, correct_answer,
      added_at, next_review_at, review_stage,
      source_type, source_label, q_type, q_content, q_content_html, q_options,
      q_analysis, q_analysis_html, q_category, q_sub_category, q_answer, images, reason, note
    )
    VALUES (?, ?, '', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      user_answer = excluded.user_answer,
      correct_answer = excluded.correct_answer,
      source_type = excluded.source_type,
      source_label = excluded.source_label,
      q_type = excluded.q_type,
      q_content = excluded.q_content,
      q_content_html = excluded.q_content_html,
      q_options = excluded.q_options,
      q_analysis = excluded.q_analysis,
      q_analysis_html = excluded.q_analysis_html,
      q_category = excluded.q_category,
      q_sub_category = excluded.q_sub_category,
      q_answer = excluded.q_answer,
      images = excluded.images,
      reason = excluded.reason,
      note = excluded.note
  `).run(
    id,
    String(input.questionId || ''),
    input.userAnswer ? String(input.userAnswer) : null,
    input.answer ? String(input.answer) : null,
    now,
    now,
    sourceType,
    input.sourceLabel ? String(input.sourceLabel).slice(0, 120) : null,
    type,
    content,
    String(input.contentHtml || '').slice(0, 200000),
    JSON.stringify(normalizeWrongOptions(input.options)),
    String(input.analysis || '').slice(0, 200000),
    String(input.analysisHtml || '').slice(0, 200000),
    String(input.category || '').slice(0, 40),
    String(input.subCategory || '').slice(0, 80),
    input.answer ? String(input.answer) : null,
    JSON.stringify(images),
    input.reason ? String(input.reason).slice(0, 240) : null,
    input.note ? String(input.note).slice(0, 500) : null
  );

  return getWrongQuestionById(id);
}

// 结果页手动判对错后，把这次练习的得分回写到记录里，避免练习历史一直是 0%
function updatePracticeRecordScore({ id, correctCount, accuracy, verdicts, status, answers }) {
  const recordId = String(id || '').trim();
  if (!recordId) return { updated: 0 };
  const row = db.prepare('SELECT * FROM practice_records WHERE id = ?').get(recordId);
  if (!row) return { updated: 0 };

  const meta = normalizePracticeMeta(row.meta) || {};
  if (verdicts && typeof verdicts === 'object') meta.verdicts = verdicts;
  const nextStatus = String(status || row.status || '').trim() || row.status;
  const safeCorrect = Number(correctCount) || 0;
  const safeAccuracy = Math.max(0, Math.min(100, Number(accuracy) || 0));
  const completedNow = nextStatus === 'completed' && row.status !== 'completed';

  db.prepare(`
    UPDATE practice_records
    SET correct_count = ?, accuracy = ?, score = ?, status = ?,
        answers = ?, end_time = ?, meta = ?
    WHERE id = ?
  `).run(
    safeCorrect,
    safeAccuracy,
    safeAccuracy,
    nextStatus,
    answers ? JSON.stringify(answers) : row.answers,
    nextStatus === 'completed' || nextStatus === 'awaiting_review'
      ? (row.end_time || toSQLiteDateTime())
      : null,
    JSON.stringify(meta),
    recordId
  );

  if (completedNow) {
    try {
      const answered = Number(row.total_count) || Object.keys(row.answers ? parseSafeJson(row.answers) : {}).length;
      if (answered > 0) {
        const kind = row.sub_category === 'xuanci' ? 'vocab' : 'drill';
        studyPlan.bumpTodoProgress(kind, answered);
      }
    } catch (error) {
      console.error('回写待办进度失败:', error);
    }
  }

  syncDailyPracticeFromRecord({
    paperId: row.paper_id,
    status: nextStatus,
    correctCount: safeCorrect,
    totalCount: row.total_count,
    accuracy: safeAccuracy,
  });

  return { updated: 1, status: nextStatus };
}

function hydrateWrongQuestionRow(row) {
  if (!row) return null;

  const nextReviewAt = row.next_review_at || row.added_at || null;
  const nextReviewDate = parseSQLiteDateTime(nextReviewAt);
  const now = new Date();

  const options = normalizeWrongOptions(parseSafeJson(row.q_options));
  const images = normalizeWrongImages(parseSafeJson(row.images));

  return {
    id: row.id,
    question_id: row.question_id,
    paper_id: row.paper_id,
    source_type: row.source_type || 'platform',
    source_label: row.source_label || '',
    type: row.q_type || 'single',
    category: row.q_category || '',
    sub_category: row.q_sub_category || '',
    content: String(row.q_content || ''),
    content_html: String(row.q_content_html || ''),
    options,
    answer: String(row.q_answer || row.correct_answer || ''),
    correct_answer: String(row.correct_answer || row.q_answer || ''),
    user_answer: row.user_answer ? String(row.user_answer) : '',
    analysis: String(row.q_analysis || ''),
    analysis_html: String(row.q_analysis_html || ''),
    images,
    reason: row.reason || '',
    note: row.note || '',
    review_count: Number(row.review_count || 0),
    review_stage: Number(row.review_stage || 0),
    added_at: row.added_at,
    last_review: row.last_review || null,
    next_review_at: nextReviewAt,
    is_due: nextReviewDate ? nextReviewDate.getTime() <= now.getTime() : true,
    paper_title: (row.source_type === 'manual' || row.source_type === 'upload')
      ? (row.source_label || '我的错题')
      : (row.paper_title || row.source_label || '未关联试卷'),
  };
}

// 获取单条错题（按错题 id）
function getWrongQuestionById(id) {
  const row = db.prepare(`
    SELECT wq.*, p.title AS paper_title
    FROM wrong_questions wq
    LEFT JOIN papers p ON wq.paper_id = p.id
    WHERE wq.id = ?
  `).get(id);
  return hydrateWrongQuestionRow(row);
}

function getWrongQuestions(options = {}) {
  const dueOnly = Boolean(options && options.dueOnly);
  const sourceType = ['platform', 'manual', 'upload'].includes(String(options?.sourceType || ''))
    ? options.sourceType
    : '';
  const query = String(options?.query || '').trim();
  const limit = Number(options && options.limit);
  const clauses = [];
  const params = [];

  if (dueOnly) {
    clauses.push(`COALESCE(next_review_at, added_at, datetime('now')) <= datetime('now')`);
  }
  if (sourceType) {
    clauses.push('source_type = ?');
    params.push(sourceType);
  }
  if (query) {
    const like = `%${query.replace(/[%_]/g, '\\$&')}%`;
    clauses.push('(q_content LIKE ? ESCAPE \'\\\' OR q_answer LIKE ? ESCAPE \'\\\' OR q_category LIKE ? ESCAPE \'\\\' OR source_label LIKE ? ESCAPE \'\\\' OR reason LIKE ? ESCAPE \'\\\' OR note LIKE ? ESCAPE \'\\\')');
    params.push(like, like, like, like, like, like);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limitSql = Number.isFinite(limit) && limit > 0 ? ' LIMIT ?' : '';
  if (limitSql) params.push(Math.floor(limit));

  return db.prepare(`
    SELECT wq.*, p.title AS paper_title
    FROM wrong_questions wq
    LEFT JOIN papers p ON wq.paper_id = p.id
    ${where}
    ORDER BY
      CASE WHEN COALESCE(next_review_at, added_at, datetime('now')) <= datetime('now') THEN 0 ELSE 1 END ASC,
      COALESCE(next_review_at, added_at, datetime('now')) ASC,
      COALESCE(review_stage, 0) ASC,
      added_at DESC
    ${limitSql}
  `).all(...params).map(hydrateWrongQuestionRow);
}

function reviewWrongQuestion(idOrQuestionId, outcome = 'again') {
  const raw = String(idOrQuestionId || '').trim();
  const id = raw.startsWith('wrong_') ? raw : `wrong_${raw}`;
  const row = db.prepare('SELECT * FROM wrong_questions WHERE id = ?').get(id);
  if (!row) throw new Error('错题不存在');

  const currentStage = Number(row.review_stage || 0);
  const isRemembered = outcome === 'remembered';
  const nextStage = isRemembered
    ? Math.min(currentStage + 1, REVIEW_INTERVAL_DAYS.length - 1)
    : 0;
  const now = toSQLiteDateTime();
  const nextReviewAt = getNextReviewAt(nextStage, new Date());

  db.prepare(`
    UPDATE wrong_questions
    SET review_count = COALESCE(review_count, 0) + 1,
        last_review = ?,
        next_review_at = ?,
        review_stage = ?
    WHERE id = ?
  `).run(now, nextReviewAt, nextStage, id);

  return getWrongQuestionById(id);
}

/**
 * 今日复习队列：复用 wrong_questions 的 0/1/2/4/7/15/30 阶梯与 next_review_at。
 * 到期判断按本地日历日：只要计划时间早于「本地明天 00:00」就算今天到期，
 * 避免用 UTC 时间比较导致东八区凌晨的复习被算到前一天。
 */
function getTodayReviewQueue() {
  const { end } = getLocalDayBounds(0);
  const rows = db.prepare(`
    SELECT wq.*, p.title AS paper_title,
      CASE
        WHEN s.id IS NOT NULL AND (s.category_key IS NULL OR TRIM(s.category_key) = '')
          THEN 'subject:' || s.id
        ELSE COALESCE(NULLIF(TRIM(wq.q_category), ''), '')
      END AS review_category,
      CASE
        WHEN s.id IS NOT NULL AND (s.category_key IS NULL OR TRIM(s.category_key) = '')
          THEN s.name
        ELSE NULL
      END AS review_label
    FROM wrong_questions wq
    LEFT JOIN papers p ON wq.paper_id = p.id
    LEFT JOIN subjects s ON s.id = p.subject_id
    WHERE COALESCE(wq.next_review_at, wq.added_at, datetime('now')) < ?
    ORDER BY COALESCE(wq.review_stage, 0) ASC,
             COALESCE(wq.next_review_at, wq.added_at) ASC
  `).all(end);

  const groups = new Map();
  rows.forEach((row) => {
    const key = row.review_category || 'uncategorized';
    const isCustom = key.startsWith('subject:');
    const label = isCustom
      ? (row.review_label || '自建科目')
      : (SUBJECTS[key]?.label || (key === 'uncategorized' ? '未分类' : key));
    if (!groups.has(key)) {
      groups.set(key, { key, label, category: isCustom ? key : key, count: 0, items: [] });
    }
    const group = groups.get(key);
    group.count += 1;
    group.items.push({ ...hydrateWrongQuestionRow(row), review_category: key });
  });

  const rank = (key) => {
    const known = ['math', 'english', 'politics', 'major'];
    const index = known.indexOf(key);
    if (index >= 0) return index;
    if (key.startsWith('subject:')) return 10;
    return 20;
  };

  return {
    date: toLocalDateStr(),
    total: rows.length,
    groups: [...groups.values()].sort((a, b) => rank(a.key) - rank(b.key) || a.label.localeCompare(b.label, 'zh-CN')),
  };
}

/** 用户主动把某道错题加入今日复习：只把 next_review_at 提前到今天，不改阶梯进度 */
function addWrongQuestionToTodayReview(idOrQuestionId) {
  const raw = String(idOrQuestionId || '').trim();
  const id = raw.startsWith('wrong_') ? raw : `wrong_${raw}`;
  const row = db.prepare('SELECT id FROM wrong_questions WHERE id = ?').get(id);
  if (!row) throw new Error('错题不存在');
  db.prepare('UPDATE wrong_questions SET next_review_at = ? WHERE id = ?').run(toSQLiteDateTime(), id);
  return getWrongQuestionById(id);
}

// 从错题本移除（自评改判为「答对」时、或用户在错题库里删除时）。同时清理自建图片。
function removeWrongQuestion(idOrInput) {
  const raw = typeof idOrInput === 'string'
    ? idOrInput
    : (idOrInput?.id || idOrInput?.questionId || '');
  const id = String(raw || '').trim();
  const lookup = id.startsWith('wrong_') ? id : `wrong_${id}`;
  const row = db.prepare('SELECT id, images FROM wrong_questions WHERE id = ?').get(lookup);
  if (!row) return { removed: false };
  try {
    getWrongAssets().removeWrongAssets(row.id);
  } catch (_) { /* 图片清理失败不影响删除记录 */ }
  const info = db.prepare('DELETE FROM wrong_questions WHERE id = ?').run(row.id);
  return { removed: info.changes > 0 };
}

/** 自建科目（没有 category_key）列表，供统计与分类选择器当独立分组用 */
function listCustomSubjectCategories() {
  try {
    return db.prepare(`
      SELECT id, name FROM subjects
      WHERE category_key IS NULL OR TRIM(category_key) = ''
      ORDER BY created_at ASC
    `).all().map((row) => ({ id: row.id, name: row.name, key: `subject:${row.id}` }));
  } catch (error) {
    // 老库还没建 subjects 表 / 没这列时不影响四科统计
    return [];
  }
}

// 获取分类统计
/**
 * 有效分类：挂在「自建科目」上的题目，其 questions.category 被历史代码兜底成了 major，
 * 直接按 category 分组会把《自动控制原理》的题算进「专业课」。
 * 这里按 papers.subject_id 把这类题目拆成独立分组 subject:<id>，四科口径保持不变。
 */
const EFFECTIVE_CATEGORY_SQL = `
  CASE WHEN s.id IS NOT NULL AND (s.category_key IS NULL OR TRIM(s.category_key) = '')
       THEN 'subject:' || s.id
       ELSE q.category END
`;
const CATEGORY_JOINS_SQL = `
  LEFT JOIN papers p ON q.paper_id = p.id
  LEFT JOIN subjects s ON s.id = p.subject_id
`;

function getCategoryStats() {
  const stats = db.prepare(`
    SELECT ${EFFECTIVE_CATEGORY_SQL} AS category, COUNT(*) as total
    FROM questions q
    ${CATEGORY_JOINS_SQL}
    WHERE q.category IS NOT NULL AND TRIM(q.category) != ''
    GROUP BY 1
  `).all();

  // 已做题数：完成练习里「应用内作答过的题」∪「本场练习覆盖过的题（meta.questionIds）」。
  // 填空/主观题通常在纸上作答，answers 里不会有记录，只看 answers 会让进度永远是 0；
  // 结果页手动判分也只回写 correct_count，不会补 answers，所以这里必须把 meta 里的题目清单也算上。
  const doneStats = db.prepare(`
    SELECT ${EFFECTIVE_CATEGORY_SQL} AS category, COUNT(DISTINCT q.id) as done
    FROM questions q
    ${CATEGORY_JOINS_SQL}
    WHERE q.category IS NOT NULL AND q.id IN (
      SELECT ak.key
      FROM practice_records pr
      JOIN json_each(pr.answers) ak
      WHERE pr.status = 'completed' AND pr.answers IS NOT NULL
      UNION
      SELECT qid.value
      FROM practice_records pr
      JOIN json_each(CASE WHEN json_valid(pr.meta) THEN json_extract(pr.meta, '$.questionIds') END) qid
      WHERE pr.status = 'completed' AND pr.meta IS NOT NULL
    )
    GROUP BY 1
  `).all();

  const doneMap = {};
  doneStats.forEach(d => { doneMap[d.category] = d.done; });

  // 正确率：按完成练习的判分结果统计。
  // 应用内自动判分和结果页手动判分都会回写 correct_count，所以记录级汇总对
  // 「选择题 + 纸上作答的填空/主观题」都是准确的，比只对比 answers 里的作答更符合用户实际。
  const gradedStats = db.prepare(`
    SELECT category,
           SUM(correct_count) as correct,
           SUM(total_count) as graded
    FROM practice_records
    WHERE status = 'completed' AND category IS NOT NULL AND TRIM(category) != ''
    GROUP BY category
  `).all();

  const gradedMap = {};
  gradedStats.forEach(g => { gradedMap[g.category] = g; });

  // 空类目判断要同时看题目和笔记：只有笔记、没有题目的科目也不该被当成空壳隐藏
  const noteStats = db.prepare(`
    SELECT n.subject_id AS subject_id, s.category_key AS category_key, COUNT(*) AS notes
    FROM notes n
    JOIN subjects s ON s.id = n.subject_id
    GROUP BY n.subject_id, s.category_key
  `).all();
  const notesBySubject = {};
  const notesByCategory = {};
  noteStats.forEach((row) => {
    notesBySubject[row.subject_id] = (notesBySubject[row.subject_id] || 0) + Number(row.notes || 0);
    if (row.category_key) {
      notesByCategory[row.category_key] = (notesByCategory[row.category_key] || 0) + Number(row.notes || 0);
    }
  });

  const subjectCategories = [
    { category: 'math', total: 0 },
    { category: 'english', total: 0 },
    { category: 'politics', total: 0 },
    { category: 'major', total: 0 },
    // 自建科目各自成为独立分组，不再混进 major
    ...listCustomSubjectCategories().map((item) => ({
      category: item.key,
      total: 0,
      label: item.name,
      isCustom: true,
      subjectId: item.id,
    })),
  ];
  const statsByCategory = new Map(stats.map((row) => [row.category, row]));
  // 必须合并 base：db 查出来的 row 只有 category/total，直接用它会把自建科目的
  // label / isCustom / subjectId 弄丢，渲染层就不知道该显示什么名字了
  const normalizedStats = subjectCategories.map((base) => ({
    ...base,
    ...(statsByCategory.get(base.category) || {}),
  }));

  return normalizedStats.map(s => {
    const graded = gradedMap[s.category] || { correct: 0, graded: 0 };
    const accuracyPct = graded.graded > 0
      ? Math.round((graded.correct / graded.graded) * 100)
      : 0;
    const base = {
      ...s,
      done: doneMap[s.category] || 0,
      answered: graded.graded || 0,
      correct: graded.correct || 0,
      accuracy: accuracyPct,
      mastery: accuracyPct,
      rawTotal: s.total,
      incomplete: 0,
      notes: s.isCustom
        ? Number(notesBySubject[s.subjectId] || 0)
        : Number(notesByCategory[s.category] || 0),
    };
    if (s.category === 'ziliao') {
      const material = getCategoryMaterialStats('ziliao');
      return {
        ...base,
        total: material.practiceable,
        rawTotal: material.total,
        incomplete: material.incomplete,
        withMaterial: material.withMaterial,
      };
    }
    return base;
  });
}

/**
 * 知识图谱数据：科目 → 模块 → 章节 → 知识点 四级树，节点自带题量。
 *
 * 旧版返回扁平的 nodes/links（科目→模块→知识点→考点），一屏塞几百个节点，
 * 前端只能画成一张糊掉的网。现在改成树：前端每次只展开一层（点数学看模块，
 * 点高等数学看章节），节点数量天然可控。
 */
function getKnowledgeGraph() {
  const rows = db.prepare(`
    SELECT ${EFFECTIVE_CATEGORY_SQL} AS subject_key,
           q.sub_category, q.chapter, q.tags,
           s.name AS subject_name
    FROM questions q
    ${CATEGORY_JOINS_SQL}
    WHERE q.category IS NOT NULL AND TRIM(q.category) != ''
  `).all();

  const categoryNames = { math: '数学', english: '英语', politics: '政治', major: '专业课' };
  const subjectOrder = ['math', 'english', 'politics', 'major'];
  const subjects = new Map();

  const ensureChild = (parent, id, label, type, path = {}) => {
    if (!parent.children.has(id)) {
      parent.children.set(id, { id, label, type, count: 0, children: new Map(), ...path });
    }
    return parent.children.get(id);
  };

  rows.forEach((row) => {
    // 自建科目的题历史兜底成 major，这里按有效分类拆成独立科目，避免混进「专业课」
    const category = String(row.subject_key || 'major');
    const subjectId = category.startsWith('subject:') ? category : `subject:${category}`;
    const isCustomSubject = category.startsWith('subject:');
    const moduleKey = String(row.sub_category || '').trim();
    const chapterLabel = String(row.chapter || '').trim();
    // 图谱只展示已归类的分类主线：没有子类别 / 章节，或还是旧 key 的题不挂兜底节点
    if (!moduleKey || moduleKey === 'general') return;
    if (isCustomSubject && MODULE_LABELS[moduleKey]) return;
    if (isMissingChapter(chapterLabel)) return;

    if (!subjects.has(subjectId)) {
      subjects.set(subjectId, {
        id: subjectId,
        label: category.startsWith('subject:')
          ? (String(row.subject_name || '').trim() || '未命名科目')
          : (categoryNames[category] || category),
        type: 'subject',
        count: 0,
        children: new Map(),
        category,
      });
    }
    const subject = subjects.get(subjectId);
    subject.count += 1;

    // 自建科目只认教材清单里的中文子类别；预置四科用共享大纲的模块名
    const moduleLabel = isCustomSubject ? moduleKey : (MODULE_LABELS[moduleKey] || moduleKey);
    const moduleNode = ensureChild(subject, `module:${category}:${moduleKey}`, moduleLabel, 'module', { category, subCategory: moduleKey });
    moduleNode.count += 1;

    const chapterNode = ensureChild(moduleNode, `${moduleNode.id}:chapter:${chapterLabel}`, chapterLabel, 'chapter', { category, subCategory: moduleKey, chapter: chapterLabel });
    chapterNode.count += 1;

    // 没有知识点的题不补「未标注知识点」节点，让章节直接成为叶子节点，
    // 这样图上能一眼看出哪些章节还没跑过分类
    const points = String(row.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean).slice(0, 3);
    points.forEach((label) => {
      const pointNode = ensureChild(chapterNode, `${chapterNode.id}:point:${label}`, label, 'point', { category, subCategory: moduleKey, chapter: chapterLabel, point: label });
      pointNode.count += 1;
    });
  });

  const sortNodes = (nodes, depth) => nodes
    .map((node) => ({
      id: node.id,
      label: node.label,
      type: node.type,
      count: node.count,
      category: node.category || '',
      subCategory: node.subCategory || '',
      chapter: node.chapter || '',
      point: node.point || '',
      noteId: node.noteId || '',
      subjectId: node.subjectId || '',
      children: sortNodes(Array.from(node.children.values()), depth + 1),
    }))
    .sort((left, right) => {
      if (depth === 0) {
        const leftKey = left.id.replace(/^subject:/, '');
        const rightKey = right.id.replace(/^subject:/, '');
        const leftRank = subjectOrder.indexOf(leftKey) === -1 ? subjectOrder.length : subjectOrder.indexOf(leftKey);
        const rightRank = subjectOrder.indexOf(rightKey) === -1 ? subjectOrder.length : subjectOrder.indexOf(rightKey);
        if (leftRank !== rightRank) return leftRank - rightRank;
        return String(left.label).localeCompare(String(right.label), 'zh-Hans-CN');
      }
      if (right.count !== left.count) return right.count - left.count;
      return String(left.label).localeCompare(String(right.label), 'zh-Hans-CN');
    });

  return { configured: true, tree: sortNodes(Array.from(subjects.values()), 0) };
}

/**
 * 「重新分类」可选的上传批次。
 * 一次上传 = 一份 imported 试卷，按批次重跑可以精确控制 token 消耗。
 */
function getReclassifyBatches() {
  const rows = db.prepare(`
    SELECT p.id, p.title, p.type, p.created_at, p.question_count,
           COUNT(q.id) AS total,
           SUM(CASE WHEN COALESCE(TRIM(q.tags), '') <> '' THEN 1 ELSE 0 END) AS tagged,
           SUM(CASE WHEN COALESCE(TRIM(q.chapter), '') <> '' THEN 1 ELSE 0 END) AS chaptered,
           SUM(CASE WHEN COALESCE(TRIM(q.tags), '') <> ''
                     AND TRIM(COALESCE(q.chapter, '')) NOT IN ('', '其他', '自拟', '未分类', '待分类', '未归类章节')
                    THEN 1 ELSE 0 END) AS ready
    FROM papers p
    LEFT JOIN questions q ON q.paper_id = p.id
    GROUP BY p.id
    HAVING total > 0
    ORDER BY p.created_at DESC
  `).all();
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    type: row.type,
    createdAt: row.created_at,
    total: Number(row.total || 0),
    tagged: Number(row.tagged || 0),
    chaptered: Number(row.chaptered || 0),
    pending: Number(row.total || 0) - Number(row.ready || 0),
  }));
}

/** 取一批题的精简题干，只带分类需要的字段，避免把整份试卷塞进 prompt */
const FALLBACK_CHAPTERS = ['其他', '自拟', '未分类', '待分类', '未归类章节'];

/** 兜底章节不算「已分类」，重新分类时应该重新跑 */
function isMissingChapter(value) {
  const text = String(value || '').trim();
  return !text || FALLBACK_CHAPTERS.includes(text);
}

function getQuestionsForReclassify(paperId, options = {}) {
  const id = String(paperId || '').trim();
  if (!id) throw new Error('请选择要重新分类的上传批次');
  const onlyMissing = Boolean(options?.onlyMissing);
  const rows = db.prepare(`
    SELECT id, content, options, category, sub_category, chapter, tags
    FROM questions WHERE paper_id = ? ORDER BY order_num
  `).all(id);

  return rows
    .filter((row) => {
      if (!onlyMissing) return true;
      return isMissingChapter(row.chapter) || !String(row.tags || '').trim();
    })
    .map((row) => ({
      id: row.id,
      category: String(row.category || ''),
      subCategory: String(row.sub_category || ''),
      chapter: String(row.chapter || ''),
      content: String(row.content || '').replace(/\s+/g, ' ').slice(0, 240),
      options: parseOptions(row.options)
        .map((option) => `${option.key}.${String(option.content || '').replace(/\s+/g, ' ').slice(0, 40)}`)
        .join(' ')
        .slice(0, 200),
    }))
    .filter((row) => row.content);
}

/**
 * 按知识图谱节点取题：知识点 → 章节 → 模块，逐级放宽条件。
 * 图谱底层点击要「跳到对应题目」，这里给出该节点下真实存在的题目。
 */
function getQuestionsByKnowledge(options = {}) {
  const category = String(options.category || '').trim();
  if (!category) throw new Error('缺少科目，无法定位题目');
  // 知识图谱里自建科目的节点键是 subject:<id>，但历史题目的 category 被兜底成 major，
  // 只能按 papers.subject_id 取题；否则点进知识点永远是 0 条
  const customId = category.startsWith('subject:') ? category.slice(8) : '';
  const subCategory = String(options.subCategory || '').trim();
  const chapter = String(options.chapter || '').trim();
  const point = String(options.point || '').trim();
  const column = (name) => (customId ? `q.${name}` : name);

  const where = [customId ? 'p.subject_id = ?' : 'q.category = ?'];
  const params = [customId || category];
  if (subCategory && subCategory !== 'all') { where.push(`${column('sub_category')} = ?`); params.push(subCategory); }
  if (chapter) { where.push(`${column('chapter')} = ?`); params.push(chapter); }
  if (point) {
    // 知识点存在 tags 里（逗号分隔）；LIKE 只用来粗筛，精确匹配在下面做，
    // 否则「函数」会把「函数极限」也一起捞进来
    where.push(`${column('tags')} LIKE ? ESCAPE '\\'`);
    params.push(`%${point.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
  }

  const limit = Math.min(300, Math.max(1, Number(options.limit) || 120));
  let rows = db.prepare(`
    SELECT ${customId ? 'q.*' : '*'} FROM questions${customId ? ' q JOIN papers p ON q.paper_id = p.id' : ''}
    WHERE ${where.join(' AND ')}
    ORDER BY ${column('paper_id')}, ${column('order_num')}
  `).all(...params);

  if (point) {
    rows = rows.filter((row) => String(row.tags || '')
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean)
      .includes(point));
  }

  return rows
    .map(mapQuestionRow)
    .filter((row) => row.practiceable)
    .slice(0, limit);
}

/**
 * 回写分类结果：科目 / 模块（子类别）/ 章节 / 知识点（tags）
 *
 * options.taxonomy 传入科目的真实教材目录；此时 sub_category 保留中文子类别，
 * requireChapter 为 true 时章节对不上目录的题直接跳过，保持原样不写库。
 */
function applyQuestionClassifications(updates = [], options = {}) {
  const list = Array.isArray(updates) ? updates : [];
  if (!list.length) return { changed: 0 };
  const stmt = db.prepare(`
    UPDATE questions SET category = ?, sub_category = ?, chapter = ?, tags = ? WHERE id = ?
  `);
  let changed = 0;
  let skipped = 0;
  db.transaction(() => {
    list.forEach((item) => {
      const id = String(item?.id || '').trim();
      if (!id) return;
      const classification = normalizeClassification({
        category: item.category,
        subCategory: item.subCategory,
        chapter: item.chapter,
        points: item.points,
      }, options.taxonomy ? { taxonomy: options.taxonomy } : {});
      if (!classification.category) return;
      if (options.requireChapter && !classification.chapter) {
        skipped += 1;
        return;
      }
      changed += stmt.run(
        classification.category,
        classification.subCategory,
        classification.chapter || null,
        classification.points.join(','),
        id
      ).changes;
    });
  })();
  return { changed, skipped };
}

/**
 * 按科目取待分类题目：自建科目走 papers.subject_id，预置四科走 questions.category。
 * 与 getQuestionsForReclassify 一样只带分类需要的精简字段。
 */
function getSubjectQuestionsForClassification(subjectId, options = {}) {
  const raw = String(subjectId || '').trim();
  if (!raw) throw new Error('缺少科目，无法分类');
  const customId = raw.startsWith('subject:') ? raw.slice(8) : raw;
  const subject = db.prepare('SELECT id, name, category_key FROM subjects WHERE id = ?').get(customId);
  if (!subject) throw new Error('科目不存在');
  const categoryKey = String(subject.category_key || '').trim();
  const onlyMissing = Boolean(options?.onlyMissing);
  const where = [categoryKey ? 'q.category = ?' : 'p.subject_id = ?'];
  const params = [categoryKey || customId];
  const rows = db.prepare(`
    SELECT q.id, q.content, q.options, q.category, q.sub_category, q.chapter, q.tags, q.order_num
    FROM questions q
    ${categoryKey ? '' : 'JOIN papers p ON q.paper_id = p.id'}
    WHERE ${where.join(' AND ')}
    ORDER BY ${categoryKey ? 'q.order_num' : 'q.paper_id, q.order_num'}
  `).all(...params);

  return {
    subject: { id: subject.id, name: subject.name, categoryKey: categoryKey || null },
    rows: rows
      .filter((row) => {
        if (!onlyMissing) return true;
        const chapter = String(row.chapter || '').trim();
        const tags = String(row.tags || '').trim();
        return !chapter || chapter === '其他' || !tags;
      })
      .map((row) => ({
        id: row.id,
        category: String(row.category || ''),
        subCategory: String(row.sub_category || ''),
        chapter: String(row.chapter || ''),
        content: String(row.content || '').replace(/\s+/g, ' ').slice(0, 240),
        options: parseOptions(row.options)
          .map((option) => `${option.key}.${String(option.content || '').replace(/\s+/g, ' ').slice(0, 40)}`)
          .join(' ')
          .slice(0, 200),
      }))
      .filter((row) => row.content),
  };
}

/** 分类后按章节统计，直接给助教展示「按章节分布」 */
function getSubjectChapterDistribution(subjectId) {
  const raw = String(subjectId || '').trim();
  if (!raw) return [];
  const customId = raw.startsWith('subject:') ? raw.slice(8) : raw;
  const subject = db.prepare('SELECT id, category_key FROM subjects WHERE id = ?').get(customId);
  if (!subject) return [];
  const categoryKey = String(subject.category_key || '').trim();
  const rows = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(q.chapter), ''), '未归类章节') AS chapter, COUNT(*) AS count
    FROM questions q
    ${categoryKey ? '' : 'JOIN papers p ON q.paper_id = p.id'}
    WHERE ${categoryKey ? 'q.category = ?' : 'p.subject_id = ?'}
    GROUP BY COALESCE(NULLIF(TRIM(q.chapter), ''), '未归类章节')
    ORDER BY count DESC, chapter ASC
  `).all(categoryKey || customId);
  return rows.map((row) => ({ chapter: row.chapter, count: Number(row.count) || 0 }));
}

function getSmartRecommend(options = {}) {
  const limit = Math.min(8, Math.max(1, Number(options.limit) || 5));
  const categoryNames = {
    math: '数学',
    english: '英语',
    politics: '政治',
    major: '专业课',
    yanyu: '言语理解',
    shuliang: '数量关系',
    panduan: '判断推理',
    ziliao: '资料分析',
    changshi: '常识判断',
  };
  const items = [];

  const dueWrong = getWrongQuestions({ dueOnly: true, limit: 30 });
  if (dueWrong.length) {
    items.push({
      id: 'wrong_due',
      type: 'wrong_due',
      action: 'wrong_redo',
      title: `待复习错题 ${dueWrong.length} 道`,
      reason: '优先清掉到期错题，复习节奏更稳',
      count: Math.min(dueWrong.length, 20),
      questionIds: dueWrong.slice(0, 20).map((row) => row.question_id),
    });
  }

  const categoryStats = getCategoryStats()
    .filter((row) => row.category)
    // 题库里没有题目的科目不生成「今日提醒」；否则空题库也会出现 3 条点开即死的推荐
    .filter((row) => Number(row.total) > 0)
    .sort((a, b) => {
      const aAcc = Number(a.accuracy || 0);
      const bAcc = Number(b.accuracy || 0);
      if (a.answered >= 3 && b.answered >= 3) return aAcc - bAcc;
      if (a.answered >= 3) return -1;
      if (b.answered >= 3) return 1;
      const aDone = a.total > 0 ? a.done / a.total : 1;
      const bDone = b.total > 0 ? b.done / b.total : 1;
      return aDone - bDone;
    });

  categoryStats.slice(0, 3).forEach((row) => {
    const name = categoryNames[row.category] || row.category;
    const weak = row.answered >= 3 && row.accuracy < 65;
    items.push({
      id: `cat_${row.category}`,
      type: weak ? 'weak_category' : 'practice_category',
      action: 'practice',
      title: weak ? `加强 ${name}` : `练习 ${name}`,
      reason: weak
        ? `正确率 ${row.accuracy}% · 建议限时刷 10 题`
        : `完成度 ${row.total > 0 ? Math.round((row.done / row.total) * 100) : 0}% · 继续巩固`,
      category: row.category,
      subCategory: 'all',
      count: 10,
      accuracy: row.accuracy,
    });
  });

  return items.slice(0, limit);
}

// 获取子分类统计
function getSubCategoryStats(category) {
  const raw = String(category || '');
  const customId = raw.startsWith('subject:') ? raw.slice(8) : '';
  if (customId) {
    return db.prepare(`
      SELECT q.sub_category as subCategory, COUNT(*) as count
      FROM questions q JOIN papers p ON q.paper_id = p.id
      WHERE p.subject_id = ?
      GROUP BY q.sub_category
      ORDER BY count DESC, q.sub_category ASC
    `).all(customId);
  }
  return db.prepare(`
    SELECT
      sub_category as subCategory,
      COUNT(*) as count
    FROM questions
    WHERE category = ?
    GROUP BY sub_category
    ORDER BY count DESC, sub_category ASC
  `).all(category);
}

function repairQuestionTaxonomy() {
  const rows = db.prepare('SELECT id, category, sub_category, content FROM questions').all();
  const update = db.prepare('UPDATE questions SET category = ?, sub_category = ? WHERE id = ?');
  let changed = 0;

  db.transaction(() => {
    rows.forEach((row) => {
      const next = normalizeQuestionTaxonomy({
        category: row.category,
        sub_category: row.sub_category,
        content: row.content,
      });

      if (next.category !== row.category || next.subCategory !== (row.sub_category || '')) {
        update.run(next.category, next.subCategory, row.id);
        changed += 1;
      }
    });
  })();

  return { total: rows.length, changed };
}

function repairQuestionCategories() {
  return repairQuestionTaxonomy();
}

// 获取练习统计
function getPracticeStats() {
  const totalQuestions = db.prepare('SELECT COUNT(*) as count FROM questions').get().count;

  const completedRecords = db.prepare(`
    SELECT COUNT(*) as count, SUM(correct_count) as correct, SUM(total_count) as total
    FROM practice_records
    WHERE status = 'completed'
  `).get();

  const wrongCount = db.prepare('SELECT COUNT(*) as count FROM wrong_questions').get().count;

  // 今日新增题目数 - 检查列是否存在
  let todayAdded = 0;
  try {
    todayAdded = db.prepare(`
      SELECT COUNT(*) as count FROM questions
      WHERE DATE(created_at) = DATE('now')
    `).get().count;
  } catch (e) {
    // created_at 列不存在，返回 0
  }

  return {
    totalQuestions,
    totalDone: completedRecords.total || 0,
    correctCount: completedRecords.correct || 0,
    wrongCount,
    todayAdded,
    accuracy: completedRecords.total > 0
      ? Math.round((completedRecords.correct / completedRecords.total) * 100)
      : 0
  };
}

/**
 * 重置学习进度：只清练习记录与错题复习阶梯，
 * 题目、笔记、错题条目本身都不删除。
 *
 * category 传空或 'all' 表示全部学科；否则传科目分组键
 * （math / english / politics / major / subject:<id>）。
 * 记录归属同时看 category、练习试卷所属科目和练习包含的题目，
 * 兼容历史上 category 为空、但题目挂在某个自建科目下的练习记录。
 */
function resetStudyProgress(category = '') {
  const target = String(category || '').trim();
  const resetAll = !target || target.toLowerCase() === 'all';

  const collectPracticeIds = () => {
    const ids = new Set();
    db.prepare('SELECT id FROM practice_records WHERE category = ?')
      .all(target)
      .forEach((row) => ids.add(row.id));

    // 练习记录里带的题目属于该科目（含自建科目）
    db.prepare(`
      SELECT DISTINCT pr.id
      FROM practice_records pr
      JOIN json_each(CASE WHEN json_valid(pr.meta) THEN json_extract(pr.meta, '$.questionIds') END) qid
      JOIN questions q ON q.id = qid.value
      LEFT JOIN papers p ON q.paper_id = p.id
      LEFT JOIN subjects s ON s.id = p.subject_id
      WHERE CASE WHEN s.id IS NOT NULL AND (s.category_key IS NULL OR TRIM(s.category_key) = '')
                 THEN 'subject:' || s.id ELSE q.category END = ?
    `).all(target).forEach((row) => ids.add(row.id));

    // 练习所属试卷属于该科目
    db.prepare(`
      SELECT pr.id
      FROM practice_records pr
      WHERE pr.paper_id IN (
        SELECT p.id
        FROM papers p
        LEFT JOIN subjects s ON s.id = p.subject_id
        WHERE CASE WHEN s.id IS NOT NULL AND (s.category_key IS NULL OR TRIM(s.category_key) = '')
                   THEN 'subject:' || s.id ELSE s.category_key END = ?
      )
    `).all(target).forEach((row) => ids.add(row.id));

    return [...ids];
  };

  const collectWrongIds = () => db.prepare(`
    SELECT wq.id
    FROM wrong_questions wq
    LEFT JOIN papers p ON wq.paper_id = p.id
    LEFT JOIN subjects s ON s.id = p.subject_id
    WHERE CASE WHEN s.id IS NOT NULL AND (s.category_key IS NULL OR TRIM(s.category_key) = '')
               THEN 'subject:' || s.id
               ELSE COALESCE(NULLIF(TRIM(wq.q_category), ''), '') END = ?
  `).all(target).map((row) => row.id);

  const run = db.transaction(() => {
    let practiceRecords = 0;
    let wrongQuestions = 0;

    if (resetAll) {
      practiceRecords = db.prepare('DELETE FROM practice_records').run().changes;
      wrongQuestions = db.prepare(`
        UPDATE wrong_questions
        SET review_count = 0, last_review = NULL, next_review_at = NULL, review_stage = 0
        WHERE COALESCE(review_count, 0) != 0 OR COALESCE(review_stage, 0) != 0
           OR last_review IS NOT NULL OR next_review_at IS NOT NULL
      `).run().changes;
    } else {
      const removePractice = db.prepare('DELETE FROM practice_records WHERE id = ?');
      collectPracticeIds().forEach((id) => { practiceRecords += removePractice.run(id).changes; });

      // 错题条目保留，只把复习阶梯恢复成「刚加入」的状态
      const resetWrong = db.prepare(`
        UPDATE wrong_questions
        SET review_count = 0, last_review = NULL, next_review_at = NULL, review_stage = 0
        WHERE id = ? AND (
          COALESCE(review_count, 0) != 0 OR COALESCE(review_stage, 0) != 0
          OR last_review IS NOT NULL OR next_review_at IS NOT NULL
        )
      `);
      collectWrongIds().forEach((id) => { wrongQuestions += resetWrong.run(id).changes; });
    }

    return {
      success: true,
      scope: resetAll ? 'all' : target,
      practiceRecords,
      wrongQuestions,
    };
  });

  return run();
}

function normalizeQuestionType(type) {
  const value = String(type || '').toLowerCase();
  if (['single', 'multiple', 'judge', 'fill', 'subjective'].includes(value)) return value;
  if (['填空', '填空题', 'fill_blank', 'blank'].includes(value)) return 'fill';
  if (['主观', '主观题', '简答', '论述', 'essay', 'short_answer', 'open'].includes(value)) return 'subjective';
  return 'single';
}

function normalizeQuestionOptions(options) {
  if (Array.isArray(options)) {
    return options
      .filter((option) => option && typeof option === 'object')
      .map((option, index) => ({
        key: String(option.key || String.fromCharCode(65 + index)).toUpperCase(),
        content: String(option.content || ''),
      }));
  }

  if (typeof options === 'string') {
    try {
      const parsed = JSON.parse(options);
      return normalizeQuestionOptions(parsed);
    } catch (error) {
      return [];
    }
  }

  return [];
}

function normalizeQuestionTags(tags) {
  if (Array.isArray(tags)) return tags.map((tag) => String(tag).trim()).filter(Boolean).join(',');
  return String(tags || '').trim();
}

/**
 * 所有写入 questions 表的路径共用这一道「先优化格式再录入」的闸门。
 * 格式层是幂等的：AI 层 / 暂存层已经格式化过的题再过一次不会套娃，
 * 但用户手工编辑过、或来自旧版本备份的题也能在这里补上教材式排版。
 */
function formatQuestionForWrite(question) {
  if (!question || typeof question !== 'object') return question;
  return formatQuestionForStorage(question);
}

function formatQuestionsForWrite(questions = []) {
  const list = Array.isArray(questions) ? questions : [];
  return list
    .map((question) => formatQuestionForWrite(question))
    .filter((question) => question && typeof question === 'object' && !isFakeQuestion(question));
}

/** 恢复链路专用：已经是新格式的备份 / 暂存题目不做二次改写。 */
function formatRestoredQuestion(question) {
  if (!question || typeof question !== 'object') return question;
  if (Number(question.textbook_format_version || 0) >= TEXTBOOK_FORMAT_VERSION) return question;
  return formatQuestionForStorage(question);
}

const SAVED_AI_PAPER_TYPES = new Set(['ai_exam', 'ai_practice']);

function normalizeSavedPaperType(type, fallback = 'imported') {
  const value = String(type || '').trim().toLowerCase();
  if (value === 'imported' || SAVED_AI_PAPER_TYPES.has(value)) return value;
  return fallback;
}

function savePaperBundle(paperData = {}, questions = [], fallbackType = 'imported') {
  const normalizedQuestions = formatQuestionsForWrite(questions);
  if (!normalizedQuestions.length) throw new Error('没有可保存的有效题目');

  const paperType = normalizeSavedPaperType(paperData.type, fallbackType);
  // 加随机后缀：同一毫秒内连续导入两份文件时不会撞主键导致整批回滚
  const paperId = `paper_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const questionStamp = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const duration = Math.max(
    paperType === 'ai_practice' ? 15 : 20,
    Number(paperData.duration) || normalizedQuestions.length * 2 || 20
  );
  const difficulty = Math.max(1, Math.min(5, Number(paperData.difficulty) || 3));
  const paperTitle = String(paperData.title || '').trim() || (paperType === 'ai_practice' ? 'AI 自定义练习' : '导入试卷');

  const insertPaper = db.prepare(`
    INSERT INTO papers (id, title, year, type, subject, province, question_count, duration, difficulty, subject_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const insertQuestion = db.prepare(`
    INSERT INTO questions (id, paper_id, order_num, type, category, sub_category, chapter, content, content_html, material_html, options, answer, analysis, analysis_html, difficulty, tags, answer_source, answer_status, answer_confidence, answer_updated_at, textbook_format_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const saveTransaction = db.transaction(() => {
    insertPaper.run(
      paperId,
      paperTitle,
      Number(paperData.year) || new Date().getFullYear(),
      paperType,
      String(paperData.subject || 'xingce').trim() || 'xingce',
      normalizePaperProvince(paperData.province),
      normalizedQuestions.length,
      duration,
      difficulty,
      String(paperData.subjectId || paperData.subject_id || '') || null
    );

    normalizedQuestions.forEach((q, index) => {
      const questionId = `q_${questionStamp}_${index}`;
      const options = normalizeQuestionOptions(q.options);
      const content = String(q.content || '');
      const contentHtml = String(q.contentHtml || q.content_html || '');
      const analysisHtml = String(q.analysisHtml || q.analysis_html || '');
      const taxonomy = normalizeQuestionTaxonomy({
        category: q.category || paperData.category || 'yanyu',
        subCategory: q.subCategory || q.sub_category || paperData.subCategory || '',
        content,
      });
      const classification = normalizeClassification({
        category: taxonomy.category,
        subCategory: taxonomy.subCategory,
        chapter: q.chapter || q.chapterName || '',
        points: q.points || q.knowledgePoints || q.tags,
      });
      insertQuestion.run(
        questionId,
        paperId,
        index + 1,
        normalizeQuestionType(q.type),
        taxonomy.category,
        taxonomy.subCategory,
        classification.chapter || null,
        content,
        contentHtml || null,
        String(q.materialHtml || q.material_html || '') || null,
        JSON.stringify(options),
        String(q.answer ?? '').trim(),
        q.analysis || '',
        analysisHtml || null,
        Math.max(1, Math.min(5, Number(q.difficulty) || difficulty || 2)),
        classification.points.join(','),
        String(q.answerSource || q.answer_source || 'imported'),
        String(q.answerStatus || q.answer_status || (String(q.answer || '').trim() ? 'unverified' : 'missing')),
        Number.isFinite(Number(q.answerConfidence)) ? Number(q.answerConfidence) : null,
        q.answerUpdatedAt || q.answer_updated_at || null,
        TEXTBOOK_FORMAT_VERSION
      );
    });
  });

  saveTransaction();

  return {
    paperId,
    questionCount: normalizedQuestions.length,
    filtered: (Array.isArray(questions) ? questions.length : 0) - normalizedQuestions.length,
    type: paperType,
    title: paperTitle,
  };
}

function updateQuestionAnswer(questionId, input = {}) {
  const id = String(questionId || '').trim();
  if (!id) throw new Error('题目 ID 不能为空');
  const current = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
  if (!current) throw new Error('题目不存在');
  const isObjective = ['single', 'multiple', 'judge'].includes(String(current.type || '').toLowerCase());
  const answer = input.answer === undefined
    ? current.answer
    : (isObjective
        // 客观题只留选项字母（判断题的「正确/错误」映射成 A/B）
        ? formatQuestionForStorage({ type: current.type, answer: input.answer }).answer
        // 填空 / 主观题答案是文本或公式，绝不能 toUpperCase 毁掉 f(x)、x^{n}
        : formatQuestionText(String(input.answer || '').trim(), 'answer'));
  const analysis = input.analysis === undefined
    ? current.analysis
    : formatQuestionText(String(input.analysis || '').trim(), 'analysis');
  const analysisHtml = input.analysis === undefined
    ? null
    : toTextbookHtml(analysis, 'analysis');
  const answerImages = input.answerImages === undefined
    ? parseAnswerImages(current.answer_images)
    : parseAnswerImages(input.answerImages);
  const source = String(input.answerSource || input.source || 'ai_teacher').trim() || 'ai_teacher';
  const hasAnswer = Boolean(String(answer || '').trim()) || answerImages.length > 0;
  const status = String(
    input.answerStatus
    || (input.answerImages === undefined
      ? 'verified'
      : (hasAnswer ? (source.startsWith('user_') ? 'user_supplemented' : 'verified') : 'missing'))
  ).trim() || 'verified';
  const confidence = input.answerConfidence === undefined ? 1 : Math.max(0, Math.min(1, Number(input.answerConfidence) || 0));
  db.prepare(`
    UPDATE questions
    SET answer = ?, analysis = ?, analysis_html = COALESCE(?, analysis_html), answer_images = ?,
        answer_source = ?, answer_status = ?, answer_confidence = ?, answer_updated_at = datetime('now')
    WHERE id = ?
  `).run(answer, analysis, analysisHtml, JSON.stringify(answerImages), source, status, confidence, id);
  return mapQuestionRow(db.prepare('SELECT * FROM questions WHERE id = ?').get(id));
}

/** 追加一张答案图片引用（图片文件已由 questionAssets 落盘） */
function addQuestionAnswerImage(questionId, url) {
  const id = String(questionId || '').trim();
  const imageUrl = String(url || '').trim();
  if (!id || !imageUrl) throw new Error('题目 ID 和图片地址不能为空');
  const current = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
  if (!current) throw new Error('题目不存在');
  const images = parseAnswerImages(current.answer_images);
  const next = images.includes(imageUrl) ? images : [...images, imageUrl];
  const hasText = Boolean(String(current.answer || '').trim());
  db.prepare(`
    UPDATE questions
    SET answer_images = ?, answer_source = ?, answer_status = 'user_supplemented',
        answer_updated_at = datetime('now')
    WHERE id = ?
  `).run(JSON.stringify(next), hasText ? 'user_supplement' : 'user_image', id);
  return mapQuestionRow(db.prepare('SELECT * FROM questions WHERE id = ?').get(id));
}

/** 删除一张答案图片引用并回写状态；没有文字答案也没有图片时回落为「缺答案」 */
function removeQuestionAnswerImage(questionId, url) {
  const id = String(questionId || '').trim();
  const imageUrl = String(url || '').trim();
  if (!id || !imageUrl) throw new Error('题目 ID 和图片地址不能为空');
  const current = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
  if (!current) throw new Error('题目不存在');
  const next = parseAnswerImages(current.answer_images).filter((item) => item !== imageUrl);
  const hasText = Boolean(String(current.answer || '').trim());
  const hasAnswer = hasText || next.length > 0;
  db.prepare(`
    UPDATE questions
    SET answer_images = ?, answer_source = ?, answer_status = ?,
        answer_updated_at = datetime('now')
    WHERE id = ?
  `).run(
    JSON.stringify(next),
    hasAnswer ? (current.answer_source && String(current.answer_source).startsWith('user_') ? current.answer_source : 'user_supplement') : String(current.answer_source || 'imported'),
    hasAnswer ? 'user_supplemented' : 'missing',
    id
  );
  return mapQuestionRow(db.prepare('SELECT * FROM questions WHERE id = ?').get(id));
}

// 导入试卷和题目
function importPaper(paperData, questions) {
  return savePaperBundle({ ...paperData, type: 'imported' }, questions, 'imported');
}

/**
 * 把后续识别出来的题目追加到同一份导入试卷。
 * 后台任务按块完成时直接调用它，避免为每一块新建一份试卷。
 */
function appendImportedQuestions(paperId, questions) {
  const id = String(paperId || '').trim();
  const paper = db.prepare('SELECT id, type, difficulty FROM papers WHERE id = ?').get(id);
  if (!paper) throw new Error('目标试卷不存在');

  const normalizedQuestions = formatQuestionsForWrite(questions);
  if (!normalizedQuestions.length) {
    const count = Number(db.prepare('SELECT COUNT(*) AS count FROM questions WHERE paper_id = ?').get(id)?.count || 0);
    return { paperId: id, appended: 0, questionCount: count };
  }

  const insertQuestion = db.prepare(`
    INSERT INTO questions (id, paper_id, order_num, type, category, sub_category, chapter, content, content_html, material_html, options, answer, analysis, analysis_html, difficulty, tags, answer_source, answer_status, answer_confidence, answer_updated_at, textbook_format_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const difficulty = Math.max(1, Math.min(5, Number(paper.difficulty) || 3));
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const appendTransaction = db.transaction(() => {
    const currentCount = Number(db.prepare('SELECT COUNT(*) AS count FROM questions WHERE paper_id = ?').get(id)?.count || 0);
    normalizedQuestions.forEach((q, index) => {
      const content = String(q.content || '');
      const taxonomy = normalizeQuestionTaxonomy({
        category: q.category || 'yanyu',
        subCategory: q.subCategory || q.sub_category || '',
        content,
      });
      const classification = normalizeClassification({
        category: taxonomy.category,
        subCategory: taxonomy.subCategory,
        chapter: q.chapter || q.chapterName || '',
        points: q.points || q.knowledgePoints || q.tags,
      });
      insertQuestion.run(
        `q_${stamp}_${index}`,
        id,
        currentCount + index + 1,
        normalizeQuestionType(q.type),
        taxonomy.category,
        taxonomy.subCategory,
        classification.chapter || null,
        content,
        String(q.contentHtml || q.content_html || '') || null,
        String(q.materialHtml || q.material_html || '') || null,
        JSON.stringify(normalizeQuestionOptions(q.options)),
        String(q.answer ?? '').trim(),
        q.analysis || '',
        String(q.analysisHtml || q.analysis_html || '') || null,
        Math.max(1, Math.min(5, Number(q.difficulty) || difficulty)),
        classification.points.join(','),
        String(q.answerSource || q.answer_source || 'imported'),
        String(q.answerStatus || q.answer_status || (String(q.answer || '').trim() ? 'unverified' : 'missing')),
        Number.isFinite(Number(q.answerConfidence)) ? Number(q.answerConfidence) : null,
        q.answerUpdatedAt || q.answer_updated_at || null,
        TEXTBOOK_FORMAT_VERSION
      );
    });
    const nextCount = currentCount + normalizedQuestions.length;
    db.prepare('UPDATE papers SET question_count = ?, duration = ? WHERE id = ?')
      .run(nextCount, Math.max(20, nextCount * 2), id);
    return nextCount;
  });

  const questionCount = appendTransaction();
  return {
    paperId: id,
    appended: normalizedQuestions.length,
    filtered: (Array.isArray(questions) ? questions.length : 0) - normalizedQuestions.length,
    questionCount,
  };
}

/* ==========================================================================
 * 导入暂存（import_staging）
 *
 * 目标：识别成功 -> 立即写 SQLite；正式题库写入成功 -> 标记 committed；
 * 重复/无效 -> 标记 discarded。任何未标记的题都会在下次启动或打开导入页时
 * 由 recoverStagedImports() 补写进题库，窗口卸载、进程崩溃、强制断电都不丢题。
 * ========================================================================== */
const STAGING_STATUS = new Set(['pending', 'committed', 'discarded']);

function normalizeStagingText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '');
}

/** 内容级确定 ID：同一任务重复暂存同一道题是幂等的，重启后也能对得上。 */
function computeStagingId(taskId, question = {}) {
  const content = normalizeStagingText(question.content || question.contentHtml || question.content_html || '');
  // 主观 / 填空答案是公式文本，大写会改变内容，也会让同一道题算出的 ID 不稳定
  const answer = String(question.answer || '').trim();
  const options = JSON.stringify(normalizeQuestionOptions(question.options));
  return `stg_${crypto.createHash('sha1').update(`${taskId}|${content}|${answer}|${options}`).digest('hex').slice(0, 24)}`;
}

function safeParseStagingJson(value, fallback) {
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function getStagingSummary(input = {}) {
  const taskId = String(input.taskId || '').trim();
  const rows = taskId
    ? db.prepare('SELECT status, COUNT(*) AS count FROM import_staging WHERE task_id = ? GROUP BY status').all(taskId)
    : db.prepare('SELECT status, COUNT(*) AS count FROM import_staging GROUP BY status').all();
  const summary = { pending: 0, committed: 0, discarded: 0, total: 0 };
  rows.forEach((row) => {
    if (Object.prototype.hasOwnProperty.call(summary, row.status)) summary[row.status] = Number(row.count) || 0;
  });
  summary.total = summary.pending + summary.committed + summary.discarded;
  return summary;
}

function stageImportedQuestions(input = {}) {
  const taskId = String(input.taskId || '').trim() || `task_${Date.now()}`;
  const batchId = String(input.batchId || '').trim();
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const meta = {
    ...(input.meta && typeof input.meta === 'object' ? input.meta : {}),
    taskId,
    paperData: input.paperData || {},
    fileName: input.fileName || '',
    category: input.category || '',
    autoCommit: input.autoCommit !== false,
  };
  const metaJson = JSON.stringify(meta);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO import_staging
      (id, task_id, batch_id, status, payload, meta, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?, datetime('now'), datetime('now'))
  `);
  const ids = [];
  let staged = 0;
  db.transaction(() => {
    questions.forEach((question) => {
      if (!question || typeof question !== 'object') { ids.push(''); return; }
      // 识别成功即暂存：这一步就完成教材格式化，崩溃恢复出来的题也是规范格式
      const formatted = formatQuestionForWrite(question);
      const id = computeStagingId(taskId, formatted);
      ids.push(id);
      staged += insert.run(id, taskId, batchId, JSON.stringify(formatted), metaJson).changes;
    });
  })();
  return { taskId, staged, repeated: questions.length - staged, ids, ...getStagingSummary({ taskId }) };
}

function updateStagedQuestions(input = {}) {
  const ids = Array.isArray(input.ids)
    ? input.ids.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  if (!ids.length) return { updated: 0 };
  const status = STAGING_STATUS.has(input.status) ? input.status : 'committed';
  const paperId = input.paperId ? String(input.paperId) : null;
  const reason = input.reason ? String(input.reason).slice(0, 240) : null;
  const stmt = db.prepare(`
    UPDATE import_staging
       SET status = ?,
           paper_id = COALESCE(?, paper_id),
           error = ?,
           updated_at = datetime('now'),
           committed_at = CASE WHEN ? IN ('committed', 'discarded') THEN datetime('now') ELSE committed_at END
     WHERE id = ?
  `);
  let updated = 0;
  db.transaction(() => {
    ids.forEach((id) => { updated += stmt.run(status, paperId, reason, status, id).changes; });
  })();
  return { updated, status };
}

function getPendingStagedQuestions(input = {}) {
  const taskId = String(input.taskId || '').trim();
  const limit = Math.max(1, Math.min(5000, Number(input.limit) || 500));
  const rows = taskId
    ? db.prepare("SELECT * FROM import_staging WHERE status = 'pending' AND task_id = ? ORDER BY created_at ASC, id ASC LIMIT ?").all(taskId, limit)
    : db.prepare("SELECT * FROM import_staging WHERE status = 'pending' ORDER BY created_at ASC, id ASC LIMIT ?").all(limit);
  return rows.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    batchId: row.batch_id || '',
    status: row.status,
    createdAt: row.created_at,
    question: safeParseStagingJson(row.payload, {}),
    meta: safeParseStagingJson(row.meta, {}),
  }));
}

/**
 * 把仍为 pending 的暂存题补写进正式题库。
 * 用已入库题目内容做索引，避免「已写入但没来得及标记」被重复恢复。
 * 每个任务生成/复用一份独立的「恢复的导入题目」试卷，绝不覆盖用户已有试卷。
 */
function recoverStagedImports(input = {}) {
  const taskId = String(input.taskId || '').trim();
  const preferredPaperId = String(input.paperId || '').trim();
  const rows = taskId
    ? db.prepare("SELECT * FROM import_staging WHERE status = 'pending' AND task_id = ? ORDER BY created_at ASC, id ASC LIMIT 5000").all(taskId)
    : db.prepare("SELECT * FROM import_staging WHERE status = 'pending' ORDER BY created_at ASC, id ASC LIMIT 5000").all();
  if (!rows.length) return { recovered: 0, duplicates: 0, discarded: 0, skipped: 0, tasks: [], paperIds: [] };

  const insertQuestion = db.prepare(`
    INSERT OR IGNORE INTO questions (id, paper_id, order_num, type, category, sub_category, content, content_html, options, answer, analysis, analysis_html, difficulty, tags, answer_source, answer_status, answer_confidence, answer_updated_at, textbook_format_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const insertPaper = db.prepare(`
    INSERT OR IGNORE INTO papers (id, title, year, type, subject, province, question_count, duration, difficulty, created_at)
    VALUES (?, ?, ?, 'imported', ?, NULL, 0, 30, 3, datetime('now'))
  `);
  const mark = db.prepare(`
    UPDATE import_staging
       SET status = ?, paper_id = ?, error = ?, updated_at = datetime('now'), committed_at = datetime('now')
     WHERE id = ?
  `);
  const result = { recovered: 0, duplicates: 0, discarded: 0, skipped: 0, tasks: [], paperIds: [] };
  // 只有明确指定单个任务时才复用它的试卷，避免全局恢复时把所有任务塞进同一份试卷
  const reusePaper = Boolean(taskId && preferredPaperId
    && db.prepare('SELECT id FROM papers WHERE id = ?').get(preferredPaperId));

  db.transaction(() => {
    const existingByContent = new Map();
    db.prepare(`
      SELECT q.content, q.paper_id FROM questions q
      INNER JOIN papers p ON p.id = q.paper_id
      WHERE COALESCE(p.type, '') IN (${USER_GENERATED_PAPER_TYPE_SQL})
    `).all().forEach((row) => {
      const key = normalizeStagingText(row.content);
      if (key && !existingByContent.has(key)) existingByContent.set(key, row.paper_id);
    });

    const byTask = new Map();
    rows.forEach((row) => {
      const task = String(row.task_id || 'task_unknown');
      if (!byTask.has(task)) byTask.set(task, []);
      byTask.get(task).push(row);
    });

    byTask.forEach((taskRows, tid) => {
      const meta = safeParseStagingJson(taskRows[0].meta, {});
      // 用户主动关闭「自动入库」时保留 pending，等他手动确认；但题目始终在暂存表里，不会丢
      if (meta.autoCommit === false && input.force !== true) {
        result.skipped += taskRows.length;
        return;
      }
      const paperData = meta.paperData || {};
      const safeTask = tid.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48);
      const paperId = reusePaper ? preferredPaperId : `paper_recovered_${safeTask}`;
      const title = String(paperData.title || meta.fileName || '').trim() || `恢复的导入题目 · ${tid.slice(-8)}`;
      if (!reusePaper) {
        insertPaper.run(paperId, title, Number(paperData.year) || new Date().getFullYear(), String(paperData.subject || 'kaoyan'));
      }

      let nextOrder = Number(db.prepare('SELECT COUNT(*) AS count FROM questions WHERE paper_id = ?').get(paperId)?.count || 0);
      let insertedForTask = 0;
      taskRows.forEach((row) => {
        // 老版本暂存的题目没有格式版本标记，恢复时补做一次格式化
        const q = formatRestoredQuestion(safeParseStagingJson(row.payload, null));
        const content = q ? String(q.content || '') : '';
        const richContent = q ? String(q.contentHtml || q.content_html || '') : '';
        if (!q || (!content.trim() && !richContent.trim()) || isFakeQuestion(q)) {
          mark.run('discarded', null, 'empty-or-invalid', row.id);
          result.discarded += 1;
          return;
        }
        const key = normalizeStagingText(content || richContent);
        if (existingByContent.has(key)) {
          mark.run('committed', existingByContent.get(key), 'already-in-bank', row.id);
          result.duplicates += 1;
          return;
        }
        const taxonomy = normalizeQuestionTaxonomy({
          category: q.category || paperData.category || 'yanyu',
          subCategory: q.subCategory || q.sub_category || '',
          content,
        });
        nextOrder += 1;
        insertQuestion.run(
          `q_stg_${row.id.slice(4)}`,
          paperId,
          nextOrder,
          normalizeQuestionType(q.type),
          taxonomy.category,
          taxonomy.subCategory,
          content,
          richContent || null,
          JSON.stringify(normalizeQuestionOptions(q.options)),
          String(q.answer ?? '').trim(),
          String(q.analysis || ''),
          String(q.analysisHtml || q.analysis_html || '') || null,
          Math.max(1, Math.min(5, Number(q.difficulty) || 2)),
          normalizeQuestionTags(q.tags),
          String(q.answerSource || q.answer_source || 'recovered'),
          String(q.answerStatus || q.answer_status || (String(q.answer || '').trim() ? 'unverified' : 'missing')),
          Number.isFinite(Number(q.answerConfidence)) ? Number(q.answerConfidence) : null,
          q.answerUpdatedAt || q.answer_updated_at || null,
          TEXTBOOK_FORMAT_VERSION
        );
        existingByContent.set(key, paperId);
        mark.run('committed', paperId, null, row.id);
        insertedForTask += 1;
        result.recovered += 1;
      });

      const count = Number(db.prepare('SELECT COUNT(*) AS count FROM questions WHERE paper_id = ?').get(paperId)?.count || 0);
      db.prepare('UPDATE papers SET question_count = ?, duration = ? WHERE id = ?').run(count, Math.max(20, count * 2), paperId);
      result.tasks.push({ taskId: tid, paperId, title, inserted: insertedForTask });
      if (insertedForTask) result.paperIds.push(paperId);
    });
  })();

  return result;
}

function clearStagedQuestions(input = {}) {
  const clauses = [];
  const args = [];
  const taskId = String(input.taskId || '').trim();
  const status = String(input.status || '').trim();
  if (taskId) { clauses.push('task_id = ?'); args.push(taskId); }
  if (status) { clauses.push('status = ?'); args.push(status); }
  if (!clauses.length) return { deleted: 0 };
  return { deleted: db.prepare(`DELETE FROM import_staging WHERE ${clauses.join(' AND ')}`).run(...args).changes };
}

function saveAIPaper(paperData, questions) {
  return savePaperBundle({ ...paperData, type: normalizeSavedPaperType(paperData?.type, 'ai_exam') }, questions, 'ai_exam');
}

// 获取导入的试卷列表
function getImportedPapers() {
  return normalizePaperRecords(db.prepare(`
    SELECT * FROM papers
    WHERE type = 'imported'
    ORDER BY created_at DESC
  `).all());
}

function getSavedAIPapers() {
  return normalizePaperRecords(db.prepare(`
    SELECT * FROM papers
    WHERE type IN ('ai_exam', 'ai_practice')
    ORDER BY created_at DESC
  `).all());
}

function getSavedPaperForManage(paperId) {
  const id = String(paperId || '').trim();
  if (!id) throw new Error('内容不存在');

  const paper = normalizePaperRecord(db.prepare('SELECT * FROM papers WHERE id = ?').get(id));
  if (!paper) throw new Error('内容不存在或已删除');
  if (!SAVED_AI_PAPER_TYPES.has(String(paper.type || '').trim())) throw new Error('仅支持管理已保存 AI 内容');

  return paper;
}

function renameSavedPaper(paperId, title) {
  const paper = getSavedPaperForManage(paperId);
  const nextTitle = String(title || '').trim();
  if (!nextTitle) throw new Error('名称不能为空');

  db.prepare('UPDATE papers SET title = ? WHERE id = ?').run(nextTitle, paper.id);
  return { ...paper, title: nextTitle };
}

function deleteSavedPaper(paperId) {
  const paper = getSavedPaperForManage(paperId);

  const remove = db.transaction(() => {
    const removedPracticeRecords = db.prepare('DELETE FROM practice_records WHERE paper_id = ?').run(paper.id).changes;
    const removedWrongQuestions = db.prepare('DELETE FROM wrong_questions WHERE paper_id = ?').run(paper.id).changes;
    const removedQuestions = db.prepare('DELETE FROM questions WHERE paper_id = ?').run(paper.id).changes;
    db.prepare('DELETE FROM papers WHERE id = ?').run(paper.id);
    return { removedPracticeRecords, removedWrongQuestions, removedQuestions };
  });

  const summary = remove();
  return { id: paper.id, title: paper.title, type: paper.type, ...summary };
}

/** 解析 answer_images 列：兼容 JSON 数组 / 空值 / 历史脏数据 */
function parseAnswerImages(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map((item) => String(item || '').trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function mapQuestionRow(row) {
  if (!row) return null;
  return {
    ...row,
    options: parseOptions(row.options),
    tags: row.tags ? String(row.tags).split(',').filter(Boolean) : [],
    answerImages: parseAnswerImages(row.answer_images),
    has_material: hasUsableMaterial(row),
    practiceable: isPracticeableQuestion(row),
  };
}

function repairQuestionQuality() {
  if (!db) return { total: 0 };
  return patchQuestionDatabase(db);
}

/* ==========================================================================
 * 存量题库教材格式迁移
 *
 * 只处理 textbook_format_version < TEXTBOOK_FORMAT_VERSION 的行；
 * 每批一个事务，中途失败也只会留下「已迁移 / 未迁移」两种干净状态，
 * 重启后继续从下一批接着跑。首次真正改写前用 VACUUM INTO 留一份完整快照。
 * ========================================================================== */
const TEXTBOOK_MIGRATION_BATCH = 200;

function createTextbookFormatBackup() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backupPath = path.join(app.getPath('userData'), `openexam.before-textbook-v${TEXTBOOK_FORMAT_VERSION}.${stamp}.db`);
  // VACUUM INTO 会生成一个与 WAL 状态无关的、可直接打开的一致性快照
  const escaped = backupPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  return backupPath;
}

function migrateTextbookFormat() {
  const result = { migrated: 0, failed: 0, batches: 0, backupPath: '' };
  if (!db) return result;

  const columns = db.pragma('table_info(questions)');
  if (!Array.isArray(columns) || !columns.some((column) => column.name === 'textbook_format_version')) {
    console.warn('[TextbookFormat] questions 表缺少格式版本列，跳过存量迁移');
    return result;
  }

  const select = db.prepare(`
    SELECT * FROM questions
     WHERE COALESCE(textbook_format_version, 0) < ? AND id > ?
     ORDER BY id LIMIT ?
  `);
  const update = db.prepare(`
    UPDATE questions
       SET content = ?, content_html = ?, options = ?, answer = ?,
           analysis = ?, analysis_html = ?, material_html = ?,
           textbook_format_version = ?
     WHERE id = ?
  `);
  let syncWrongAnswer = null;
  try {
    syncWrongAnswer = db.prepare(`
      UPDATE wrong_questions SET correct_answer = ?
       WHERE question_id = ? AND correct_answer = ?
    `);
  } catch (_) { /* 老库没有错题表时忽略答案快照同步 */ }

  let lastId = '';
  let firstBatch = true;
  try {
    while (true) {
      const rows = select.all(TEXTBOOK_FORMAT_VERSION, lastId, TEXTBOOK_MIGRATION_BATCH);
      if (!rows.length) break;
      if (firstBatch) {
        try {
          result.backupPath = createTextbookFormatBackup();
        } catch (error) {
          // 快照失败不能阻断迁移：格式化本身是幂等的，且原库始终保留
          console.warn('[TextbookFormat] 迁移前快照失败（继续迁移）:', error?.message || String(error));
        }
        firstBatch = false;
      }

      db.transaction(() => {
        rows.forEach((row) => {
          lastId = row.id;
          try {
            const patch = formatQuestionRow(row);
            if (!patch) return;
            update.run(
              patch.content,
              patch.content_html,
              patch.options,
              patch.answer,
              patch.analysis,
              patch.analysis_html,
              patch.material_html,
              patch.textbook_format_version,
              row.id
            );
            // 错题本里存的是答案快照，答案文本被规范化后同步一次，避免显示两套写法
            if (String(patch.answer ?? '') !== String(row.answer ?? '')) {
              try { syncWrongAnswer?.run(patch.answer, row.id, row.answer); } catch (_) { /* 单条同步失败不影响迁移 */ }
            }
            result.migrated += 1;
          } catch (error) {
            result.failed += 1;
            console.warn(`[TextbookFormat] 题目 ${row.id} 迁移失败:`, error?.message || String(error));
          }
        });
      })();
      result.batches += 1;
      if (rows.length < TEXTBOOK_MIGRATION_BATCH) break;
    }
  } catch (error) {
    console.error('[TextbookFormat] 存量迁移中断:', error);
  }

  if (result.migrated || result.failed) {
    console.log(`[TextbookFormat] 存量迁移完成：成功 ${result.migrated} 题，失败 ${result.failed} 题，${result.batches} 批${result.backupPath ? `；快照 ${result.backupPath}` : ''}`);
  }
  return result;
}

/**
 * 某科目已入库的题干文本。
 * 教材解析可以分批/重复跑，导入前用它去重，避免同一道题被反复写进题库。
 */
function getSubjectQuestionContents(subjectId) {
  if (!db || !subjectId) return [];
  try {
    return db.prepare(`
      SELECT q.content FROM questions q
      JOIN papers p ON q.paper_id = p.id
      WHERE p.subject_id = ?
    `).all(String(subjectId))
      .map((row) => String(row.content || ''))
      .filter(Boolean);
  } catch (error) {
    console.warn('[DB] 读取科目题干失败:', error?.message || error);
    return [];
  }
}

/**
 * 某科目由教材解析生成的例题习题卷（一本书只有一卷，重复解析往这卷里追加）。
 */
function getSubjectTextbookPaper(subjectId) {
  if (!db || !subjectId) return null;
  try {
    return db.prepare(`
      SELECT id, title, question_count FROM papers
      WHERE subject_id = ? AND title LIKE '%教材例题习题%'
      ORDER BY created_at ASC
      LIMIT 1
    `).get(String(subjectId)) || null;
  } catch (error) {
    console.warn('[DB] 读取教材习题卷失败:', error?.message || error);
    return null;
  }
}

// 按分类获取题目（用于专项练习）
function getQuestionsByCategory(category, subCategory, limit, shuffle) {
  const raw = String(category || '');
  // 自建科目分组键是 subject:<id>：按 papers.subject_id 取题，
  // 而不是按 questions.category（历史数据把它们兜底成了 major）。
  const customId = raw.startsWith('subject:') ? raw.slice(8) : '';
  let sql = customId
    ? `SELECT q.* FROM questions q JOIN papers p ON q.paper_id = p.id WHERE p.subject_id = ?`
    : `SELECT * FROM questions WHERE category = ?`;
  const params = [customId || category];

  if (subCategory && subCategory !== 'all') {
    sql += ` AND ${customId ? 'q.' : ''}sub_category = ?`;
    params.push(subCategory);
  }

  sql += ` ORDER BY ${customId ? 'q.' : ''}paper_id, ${customId ? 'q.' : ''}order_num`;

  const rows = db.prepare(sql).all(...params)
    .map(mapQuestionRow)
    .filter((row) => row.practiceable);

  let result = rows;
  if (shuffle) {
    result = [...rows].sort(() => Math.random() - 0.5);
  }
  if (limit && limit > 0) {
    result = result.slice(0, limit);
  }
  return result;
}

/* ------------------------------------------------------------ 每日一练 */

function mapDailyPractice(row) {
  if (!row) return null;
  const ids = parseSafeJson(row.question_ids);
  const questionIds = Array.isArray(ids) ? ids.map((id) => String(id || '')).filter(Boolean) : [];
  const category = String(row.category || '');
  return {
    id: row.id,
    date: row.date,
    category,
    categoryLabel: row.category_label || SUBJECTS[category]?.label || category,
    questionIds,
    totalCount: Number(row.total_count) || questionIds.length,
    status: row.status || 'ongoing',
    correctCount: Number(row.correct_count) || 0,
    accuracy: Number(row.accuracy) || 0,
    completedAt: row.completed_at || null,
    sessionKey: `daily_${row.date}`,
  };
}

/** 有可练习题目的科目（四科 + 自建科目），用于每日一练选科目 */
function getDailyPracticeSubjects() {
  try {
    return getCategoryStats()
      .filter((item) => item.category !== 'ziliao' && Number(item.total) > 0)
      .map((item) => ({
        category: item.category,
        label: item.label || SUBJECTS[item.category]?.label || item.category,
        total: Number(item.total) || 0,
        isCustom: !!item.isCustom,
      }))
      .filter((item) => {
        try {
          return getQuestionsByCategory(item.category, 'all', 0, false).length > 0;
        } catch (error) {
          return false;
        }
      });
  } catch (error) {
    console.warn('读取每日一练科目失败:', error.message);
    return [];
  }
}

/** 今日每日一练状态 + 可选题库科目 + 最近的练习记录（用于断点续做） */
function getDailyPractice(dateInput) {
  const date = toLocalDateStr(dateInput || new Date());
  const row = db.prepare('SELECT * FROM daily_practice WHERE date = ?').get(date);
  const sessionKey = `daily_${date}`;
  const recordRow = db.prepare(`
    SELECT * FROM practice_records
    WHERE paper_id = ?
    ORDER BY start_time DESC
    LIMIT 1
  `).get(sessionKey);
  const record = recordRow ? {
    ...recordRow,
    answers: recordRow.answers ? (parseSafeJson(recordRow.answers) || {}) : {},
    meta: normalizePracticeMeta(recordRow.meta),
  } : null;
  return {
    date,
    sessionKey,
    set: mapDailyPractice(row),
    record,
    subjects: getDailyPracticeSubjects(),
  };
}

/**
 * 生成当天固定的一组题。已有当天记录时原样返回，保证「当天固定、不重复抽题」。
 * 返回的题目 id 顺序固定，前端按这个顺序取题即可。
 */
function ensureDailyPractice(input = {}) {
  const date = toLocalDateStr(new Date());
  const existing = db.prepare('SELECT * FROM daily_practice WHERE date = ?').get(date);
  if (existing) {
    // 「再练一遍」：保留当天固定题组，但把完成标记与成绩回落到未开始，
    // 否则今日页会一直显示已完成，和新一次作答对不上。
    if (String(existing.status || '') === 'done') {
      db.prepare(`
        UPDATE daily_practice
        SET status = 'ongoing', correct_count = 0, accuracy = 0,
            completed_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE date = ?
      `).run(date);
    }
    return getDailyPractice(date);
  }

  const subjects = getDailyPracticeSubjects();
  const requested = String(input.category || '').trim();
  const category = subjects.some((item) => item.category === requested)
    ? requested
    : (subjects[0]?.category || '');
  if (!category) throw new Error('题库里还没有可练习的题目，先导入试卷或题目');

  const count = Math.min(30, Math.max(1, Number(input.count) || 10));
  const questions = getQuestionsByCategory(category, 'all', count, true);
  if (!questions.length) throw new Error('该科目暂无可用题目');

  const label = subjects.find((item) => item.category === category)?.label
    || SUBJECTS[category]?.label
    || category;
  db.prepare(`
    INSERT OR IGNORE INTO daily_practice
      (id, date, category, category_label, question_ids, status, total_count)
    VALUES (?, ?, ?, ?, ?, 'ongoing', ?)
  `).run(`daily_${date}`, date, category, label, JSON.stringify(questions.map((q) => q.id)), questions.length);

  return getDailyPractice(date);
}

/** 完成每日一练：只记录结果，作答明细仍在 practice_records 里 */
function completeDailyPractice(input = {}) {
  const date = toLocalDateStr(new Date());
  const correct = Math.max(0, Number(input.correctCount) || 0);
  const total = Math.max(0, Number(input.totalCount) || 0);
  const accuracy = Math.max(0, Math.min(100, Number(input.accuracy) || (total > 0 ? Math.round((correct / total) * 100) : 0)));
  db.prepare(`
    UPDATE daily_practice
    SET status = 'done', correct_count = ?, total_count = ?, accuracy = ?,
        completed_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE date = ?
  `).run(correct, total, accuracy, toSQLiteDateTime(), date);
  return getDailyPractice(date).set;
}

function getCategoryMaterialStats(category = 'ziliao') {
  const rows = db.prepare(`SELECT * FROM questions WHERE category = ?`).all(category);
  const total = rows.length;
  const practiceable = rows.filter((row) => isPracticeableQuestion(row)).length;
  const withMaterial = rows.filter((row) => hasUsableMaterial(row)).length;
  return {
    category,
    total,
    practiceable,
    withMaterial,
    incomplete: Math.max(0, total - practiceable),
  };
}

// 获取过去 N 天每日练习量（用于首页动态折线图）
function getDailyStats(days = 7) {
  const stmt = db.prepare(`
    SELECT
      COUNT(*) as sessions,
      COALESCE(SUM(total_count), 0) as total,
      COALESCE(SUM(correct_count), 0) as correct,
      COALESCE(SUM(duration), 0) as duration
    FROM practice_records
    WHERE status = 'completed'
      AND start_time >= ?
      AND start_time < ?
  `);

  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const { start, end, dateStr } = getLocalDayBounds(-i);
    const found = stmt.get(start, end);
    result.push({
      date: dateStr,
      sessions: found?.sessions || 0,
      total: found?.total || 0,
      correct: found?.correct || 0,
      duration: found?.duration || 0
    });
  }
  return result;
}

// 获取连续签到天数（有练习记录即视为已签到）
function getStreakDays() {
  // start_time 是 UTC 字符串，按本地日历日取日期；否则东八区 0-8 点的练习会算到前一天
  const rows = db.prepare(`
    SELECT DISTINCT DATE(start_time, 'localtime') as date
    FROM practice_records
    ORDER BY date DESC
  `).all();

  if (rows.length === 0) return 0;

  let streak = 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < rows.length; i++) {
    // 'YYYY-MM-DD' 直接 new Date 会按 UTC 解析，必须显式按本地日历日构造
    const [y, m, d] = String(rows[i].date || '').split('-').map(Number);
    if (!y || !m || !d) break;
    const rowDate = new Date(y, m - 1, d);
    const expected = new Date(today);
    expected.setDate(today.getDate() - i);

    if (rowDate.getTime() !== expected.getTime()) break;
    streak++;
  }
  return streak;
}

// 获取总学习时长（分钟）
function getTotalStudyMinutes() {
  const row = db.prepare(`
    SELECT COALESCE(SUM(duration), 0) as total
    FROM practice_records
    WHERE status = 'completed'
  `).get();
  return Math.floor((row?.total || 0) / 60);
}

// 获取今日学习数据（本地日历日 + 仅已完成场次）
function getTodayStats() {
  const { start, end } = getLocalDayBounds(0);
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(total_count), 0) as total,
      COALESCE(SUM(correct_count), 0) as correct,
      COALESCE(SUM(duration), 0) as duration,
      COUNT(*) as sessions
    FROM practice_records
    WHERE status = 'completed'
      AND start_time >= ?
      AND start_time < ?
  `).get(start, end);
  return {
    total: row?.total || 0,
    correct: row?.correct || 0,
    duration: Math.floor((row?.duration || 0) / 60),
    sessions: row?.sessions || 0
  };
}

// 获取过去90天热力图数据（真实练习量）
function getHeatmapData(days = 90) {
  // start_time 存的是 UTC，这里统一按本地日历日分组，和 getTodayStats / getDailyStats 对齐
  const { start } = getLocalDayBounds(-(Math.max(1, days) - 1));
  const rows = db.prepare(`
    SELECT
      DATE(start_time, 'localtime') as date,
      COUNT(*) as sessions,
      COALESCE(SUM(total_count), 0) as count
    FROM practice_records
    WHERE start_time >= ?
    GROUP BY DATE(start_time, 'localtime')
  `).all(start);

  const map = {};
  rows.forEach((row) => {
    map[row.date] = {
      count: row.count || 0,
      sessions: row.sessions || 0,
    };
  });

  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const dateStr = toLocalDateStr(d);
    const dayData = map[dateStr] || { count: 0, sessions: 0 };
    const count = dayData.count;
    const sessions = dayData.sessions;

    let level = 0;
    if (count <= 0) level = 0;
    else if (count <= 10) level = 1;
    else if (count <= 30) level = 2;
    else if (count <= 60) level = 3;
    else level = 4;

    result.push({ date: dateStr, count, sessions, level });
  }
  return result;
}

// 获取成就解锁状态
function getAchievementMetrics(metrics = {}) {
  const practiceStats = metrics.practiceStats || getPracticeStats();
  const totalDone = practiceStats.totalDone || 0;

  const perfectCount = db.prepare(`
    SELECT COUNT(*) as c FROM practice_records
    WHERE accuracy = 100 AND status = 'completed' AND paper_id IS NOT NULL
  `).get().c;

  const speedCount = db.prepare(`
    SELECT COUNT(*) as c FROM practice_records
    WHERE duration <= 30 AND correct_count >= 1 AND status = 'completed'
  `).get().c;

  const sessions = db.prepare(`SELECT COUNT(*) as c FROM practice_records WHERE status = 'completed'`).get().c;
  const wrongCount = db.prepare(`SELECT COUNT(*) as c FROM wrong_questions`).get().c;
  const reviewCount = db.prepare(`SELECT COALESCE(SUM(review_count), 0) as c FROM wrong_questions`).get().c;
  const studyDays = db.prepare(`SELECT COUNT(DISTINCT DATE(start_time)) as c FROM practice_records WHERE status = 'completed'`).get().c;
  const categoryCoverage = db.prepare(`
    SELECT COUNT(DISTINCT q.category) as c
    FROM practice_records pr
    JOIN json_each(pr.answers) answer_keys
    INNER JOIN questions q ON q.id = answer_keys.key
    WHERE pr.status = 'completed'
  `).get().c;
  const savedAIPapers = db.prepare(`SELECT COUNT(*) as c FROM papers WHERE type IN ('ai_exam', 'ai_practice')`).get().c;

  const totalQuestions = db.prepare('SELECT COUNT(*) as c FROM questions').get().c;
  const mastery = totalQuestions > 0 ? Math.round((totalDone / totalQuestions) * 100) : 0;

  return {
    sessions,
    studyDays,
    perfectCount,
    speedCount,
    wrongCount,
    reviewCount,
    categoryCoverage,
    savedAIPapers,
    totalQuestions,
    mastery,
  };
}

function getAchievements(metrics = {}) {
  const practiceStats = metrics.practiceStats || getPracticeStats();
  const totalDone = Number(practiceStats.totalDone) || 0;
  const accuracy = Number(practiceStats.accuracy) || 0;
  const streak = typeof metrics.streak === 'number' ? metrics.streak : getStreakDays();
  const totalMinutes = typeof metrics.totalMinutes === 'number' ? metrics.totalMinutes : getTotalStudyMinutes();
  const achievementMetrics = metrics.achievementMetrics || getAchievementMetrics({ practiceStats });
  const context = {
    totalDone,
    accuracy,
    streak,
    totalMinutes,
    sessions: Number(achievementMetrics.sessions) || 0,
    studyDays: Number(achievementMetrics.studyDays) || 0,
    perfectCount: Number(achievementMetrics.perfectCount) || 0,
    speedCount: Number(achievementMetrics.speedCount) || 0,
    wrongCount: Number(achievementMetrics.wrongCount) || 0,
    reviewCount: Number(achievementMetrics.reviewCount) || 0,
    categoryCoverage: Number(achievementMetrics.categoryCoverage) || 0,
    savedAIPapers: Number(achievementMetrics.savedAIPapers) || 0,
    totalQuestions: Number(achievementMetrics.totalQuestions) || 0,
    mastery: Number(achievementMetrics.mastery) || 0,
  };

  const clamp = (value, max) => Math.max(0, Math.min(Number(value) || 0, max));
  const ratio = (value, max) => max > 0 ? Math.max(0, Math.min((Number(value) || 0) / max, 1)) : 0;
  const buildRequirementProgress = (requirement) => {
    const target = Number(requirement.target) || 0;
    const current = Number(context[requirement.metric]) || 0;
    return {
      current,
      target,
      progressRatio: ratio(current, target),
      text: `${clamp(current, target)}/${target}${requirement.suffix || ''}`,
    };
  };

  return achievementCatalog.map((definition) => {
    if (definition.type === 'combo') {
      const parts = (definition.requirements || []).map(buildRequirementProgress);
      const progressRatio = parts.length > 0 ? Math.min(...parts.map((item) => item.progressRatio)) : 0;
      const unlocked = parts.length > 0 && parts.every((item) => item.current >= item.target);
      return {
        id: definition.id,
        name: definition.name,
        desc: definition.desc,
        group: definition.group,
        tier: definition.tier,
        iconKey: definition.iconKey,
        unlocked,
        progress: unlocked ? 1 : 0,
        target: 1,
        progressRatio,
        progressText: parts.map((item) => item.text).join(' · '),
      };
    }

    const current = Number(context[definition.metric]) || 0;
    const target = Number(definition.target) || 0;
    return {
      id: definition.id,
      name: definition.name,
      desc: definition.desc,
      group: definition.group,
      tier: definition.tier,
      iconKey: definition.iconKey,
      unlocked: current >= target,
      progress: clamp(current, target),
      target,
      progressRatio: ratio(current, target),
      progressText: `${clamp(current, target)}/${target}${definition.suffix || ''}`,
    };
  });
}

// 获取综合成长中心数据（一次性聚合）
function getGrowthData() {
  const streak = getStreakDays();
  const today = getTodayStats();
  const heatmap = getHeatmapData(90);
  const practiceStats = getPracticeStats();
  const totalMinutes = getTotalStudyMinutes();
  const achievementMetrics = getAchievementMetrics({ practiceStats });
  const achievements = getAchievements({ practiceStats, totalMinutes, streak, achievementMetrics });

  // 计算等级 EXP（基于总做题数）
  const totalDone = practiceStats.totalDone || 0;
  const expPerLevel = 100;
  const totalExp = Math.min(totalDone * 2, 9999);
  const level = Math.floor(totalExp / expPerLevel) + 1;
  const exp = totalExp % expPerLevel;

  const levelTitles = ['新手学员', '进阶学员', '熟练学员', '高级学员', '专家学员', '达人学员', '王者学员'];
  const levelTitle = levelTitles[Math.min(level - 1, levelTitles.length - 1)];

  return {
    streak,
    today,
    heatmap,
    achievements,
    achievementMetrics,
    practiceStats,
    totalMinutes,
    level,
    exp,
    maxExp: expPerLevel,
    levelTitle
  };
}

function getAppSetting(key) {
  const row = db.prepare('SELECT value, updated_at FROM app_settings WHERE key = ?').get(key);
  if (!row) return null;
  return row;
}

function setAppSetting(key, value) {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `).run(key, value);
  return getAppSetting(key);
}

function normalizeAppSettingKey(input) {
  return String(input || '').trim().slice(0, 64);
}

function getAppPreference(key) {
  const normalizedKey = normalizeAppSettingKey(key);
  if (!normalizedKey) return null;
  const row = getAppSetting(normalizedKey);
  if (!row) return null;
  return {
    key: normalizedKey,
    value: String(row.value ?? ''),
    updatedAt: row.updated_at || null,
  };
}

function setAppPreference(key, value) {
  const normalizedKey = normalizeAppSettingKey(key);
  if (!normalizedKey) {
    return { success: false, error: 'INVALID_KEY' };
  }
  const normalizedValue = value == null ? '' : String(value);
  const row = setAppSetting(normalizedKey, normalizedValue);
  return {
    success: true,
    key: normalizedKey,
    value: normalizedValue,
    updatedAt: row?.updated_at || new Date().toISOString(),
  };
}

function getAISettings() {
  const row = getAppSetting('ai_settings');
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value);
  } catch (error) {
    return null;
  }
}

function saveAISettings(settings) {
  const payload = JSON.stringify(settings && typeof settings === 'object' ? settings : {});
  const row = setAppSetting('ai_settings', payload);
  return {
    success: true,
    updatedAt: row?.updated_at || new Date().toISOString(),
  };
}

function getAIConnectionState() {
  const row = getAppSetting('ai_connection_state');
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value);
  } catch (error) {
    return null;
  }
}

function saveAIConnectionState(state) {
  const payload = JSON.stringify(state && typeof state === 'object' ? state : {});
  const row = setAppSetting('ai_connection_state', payload);
  return {
    success: true,
    updatedAt: row?.updated_at || new Date().toISOString(),
  };
}

const DEFAULT_USER_PROFILE = Object.freeze({
  name: '考生用户',
  avatar: '',
});

const MAX_AVATAR_LENGTH = 420000;

function normalizeAvatar(input) {
  const value = String(input || '').trim();
  if (!value) return '';
  if (value.length > MAX_AVATAR_LENGTH) return '';
  return /^data:image\/(png|jpeg|jpg|webp);base64,[a-z0-9+/=]+$/i.test(value) ? value : '';
}

function normalizeUserProfile(input) {
  const name = String(input?.name || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);

  return {
    name: name || DEFAULT_USER_PROFILE.name,
    avatar: normalizeAvatar(input?.avatar),
  };
}

function getUserProfile() {
  const row = getAppSetting('user_profile');
  if (!row?.value) return { ...DEFAULT_USER_PROFILE };
  try {
    return normalizeUserProfile(JSON.parse(row.value));
  } catch (error) {
    return { ...DEFAULT_USER_PROFILE };
  }
}

function saveUserProfile(input) {
  const profile = normalizeUserProfile(input);
  const row = setAppSetting('user_profile', JSON.stringify(profile));
  return {
    success: true,
    profile,
    updatedAt: row?.updated_at || new Date().toISOString(),
  };
}

function createAIChatSession(input = {}) {
  const id = String(input.id || `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const title = String(input.title || '新会话').trim() || '新会话';
  const provider = String(input.provider || '').trim() || null;
  const model = String(input.model || '').trim() || null;
  const subjectId = String(input.subjectId || input.subject_id || '').trim() || null;
  const source = String(input.source || '').trim() === 'imported' ? 'imported' : 'chat';

  db.prepare(`
    INSERT INTO ai_chat_sessions (id, title, provider, model, subject_id, source, message_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(id, title, provider, model, subjectId, source);

  const session = db.prepare('SELECT * FROM ai_chat_sessions WHERE id = ?').get(id);
  // 科目会话立刻在科目文件夹建立对话存档
  try { require('./subjectManager.js').syncSubjectChatFile(id); } catch (_) { /* 文件夹视图失败不影响主流程 */ }
  return session;
}

function getAIChatSessions(limit = 30, subjectId = null) {
  const count = Math.max(1, Math.min(200, Number(limit) || 30));
  if (subjectId) {
    return db.prepare(`
      SELECT * FROM ai_chat_sessions
      WHERE subject_id = ?
      ORDER BY (pinned_at IS NULL) ASC, pinned_at DESC, COALESCE(last_message_at, created_at) DESC, updated_at DESC
      LIMIT ?
    `).all(String(subjectId), count);
  }
  return db.prepare(`
    SELECT * FROM ai_chat_sessions
    ORDER BY (pinned_at IS NULL) ASC, pinned_at DESC, COALESCE(last_message_at, created_at) DESC, updated_at DESC
    LIMIT ?
  `).all(count);
}

/** 把用户输入里的 LIKE 通配符转义掉，避免搜「100%」时把整库都匹配出来 */
function escapeLike(value) {
  return String(value || '').replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * 会话搜索：匹配标题与消息正文。
 * 返回会话行，并附带第一条命中消息的摘要，方便在列表里看出为什么命中。
 */
function searchAIChatSessions(query, limit = 100) {
  const keyword = String(query || '').trim();
  const count = Math.max(1, Math.min(200, Number(limit) || 100));
  if (!keyword) return getAIChatSessions(count);
  const pattern = `%${escapeLike(keyword)}%`;

  return db.prepare(`
    SELECT
      s.*,
      (
        SELECT SUBSTR(m.content, 1, 80)
        FROM ai_chat_messages m
        WHERE m.session_id = s.id AND m.content LIKE ? ESCAPE '\\'
        ORDER BY m.created_at DESC, m.rowid DESC
        LIMIT 1
      ) AS match_snippet
    FROM ai_chat_sessions s
    WHERE s.title LIKE ? ESCAPE '\\'
      OR EXISTS (
        SELECT 1 FROM ai_chat_messages m
        WHERE m.session_id = s.id AND m.content LIKE ? ESCAPE '\\'
      )
    ORDER BY (s.pinned_at IS NULL) ASC, s.pinned_at DESC, COALESCE(s.last_message_at, s.created_at) DESC, s.updated_at DESC
    LIMIT ?
  `).all(pattern, pattern, pattern, count);
}

function setAIChatSessionPinned(sessionId, pinned) {
  const id = String(sessionId || '').trim();
  if (!id) return null;
  if (pinned) {
    db.prepare('UPDATE ai_chat_sessions SET pinned_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  } else {
    db.prepare('UPDATE ai_chat_sessions SET pinned_at = NULL WHERE id = ?').run(id);
  }
  return db.prepare('SELECT * FROM ai_chat_sessions WHERE id = ?').get(id);
}

function getAIChatMessages(sessionId, limit = 300) {
  const id = String(sessionId || '').trim();
  if (!id) return [];
  const count = Math.max(1, Math.min(2000, Number(limit) || 300));
  return db.prepare(`
    SELECT * FROM ai_chat_messages
    WHERE session_id = ?
    ORDER BY created_at ASC, rowid ASC
    LIMIT ?
  `).all(id, count);
}

function addAIChatMessage(input = {}) {
  const id = String(input.id || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const sessionId = String(input.sessionId || '').trim();
  const role = String(input.role || 'assistant').trim();
  const content = String(input.content || '').trim();
  const meta = input.meta === undefined || input.meta === null || input.meta === ''
    ? null
    : (typeof input.meta === 'string' ? input.meta : JSON.stringify(input.meta));

  if (!sessionId) throw new Error('sessionId 不能为空');
  if (!content && !meta) throw new Error('content 不能为空');

  db.prepare(`
    INSERT INTO ai_chat_messages (id, session_id, role, content, meta, created_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(id, sessionId, role, content, meta);

  db.prepare(`
    UPDATE ai_chat_sessions
    SET
      updated_at = CURRENT_TIMESTAMP,
      last_message_at = CURRENT_TIMESTAMP,
      message_count = (
        SELECT COUNT(*) FROM ai_chat_messages WHERE session_id = ?
      )
    WHERE id = ?
  `).run(sessionId, sessionId);

  // 科目会话同步落盘到 subjects/<id>/对话/
  // 批量导入时每条都重写整份文件是 O(n²)，调用方传 skipSubjectSync 后自己收尾同步一次
  if (!input.skipSubjectSync) {
    try { require('./subjectManager.js').syncSubjectChatFile(sessionId); } catch (_) { /* 文件夹视图失败不影响主流程 */ }
  }

  return db.prepare('SELECT * FROM ai_chat_messages WHERE id = ?').get(id);
}

function updateAIChatMessageMeta(messageId, meta) {
  const id = String(messageId || '').trim();
  if (!id) return null;
  const payload = meta === null || meta === undefined
    ? null
    : (typeof meta === 'string' ? meta : JSON.stringify(meta));
  db.prepare('UPDATE ai_chat_messages SET meta = ? WHERE id = ?').run(payload, id);
  return db.prepare('SELECT * FROM ai_chat_messages WHERE id = ?').get(id);
}

function updateAIChatSessionContext(sessionId, context) {
  const id = String(sessionId || '').trim();
  if (!id) return null;
  const payload = context === null || context === undefined || context === ''
    ? null
    : (typeof context === 'string' ? context : JSON.stringify(context));
  db.prepare('UPDATE ai_chat_sessions SET context_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(payload, id);
  return db.prepare('SELECT * FROM ai_chat_sessions WHERE id = ?').get(id);
}

function renameAIChatSession(sessionId, title) {
  const id = String(sessionId || '').trim();
  const nextTitle = String(title || '').trim();
  if (!id || !nextTitle) return null;
  db.prepare(`
    UPDATE ai_chat_sessions
    SET title = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(nextTitle, id);
  return db.prepare('SELECT * FROM ai_chat_sessions WHERE id = ?').get(id);
}

function deleteAIChatSession(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return { success: false };

  const session = db.prepare('SELECT subject_id FROM ai_chat_sessions WHERE id = ?').get(id);
  db.transaction(() => {
    db.prepare('DELETE FROM ai_chat_messages WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM ai_chat_sessions WHERE id = ?').run(id);
  })();

  // 科目文件夹里同步清掉这份对话存档
  if (session?.subject_id) {
    try {
      const subjectManager = require('./subjectManager.js');
      const remaining = db.prepare('SELECT id FROM ai_chat_sessions WHERE subject_id = ?')
        .all(session.subject_id)
        .map((row) => row.id);
      subjectManager.removeSubjectChatFiles(session.subject_id, remaining);
    } catch (_) { /* 文件夹视图失败不影响主流程 */ }
  }

  return { success: true };
}

function exportAllData() {
  const safeParseJSON = (value, fallback) => {
    try {
      return JSON.parse(value);
    } catch (error) {
      return fallback;
    }
  };

  const papers = normalizePaperRecords(db.prepare('SELECT * FROM papers ORDER BY year DESC, created_at DESC').all());
  const questions = db.prepare('SELECT * FROM questions ORDER BY paper_id, order_num ASC').all().map((row) => ({
    ...row,
    options: safeParseJSON(row.options, []),
    tags: row.tags ? row.tags.split(',').filter(Boolean) : [],
  }));
  const practiceRecords = db.prepare('SELECT * FROM practice_records ORDER BY start_time DESC').all().map((row) => ({
    ...row,
    answers: safeParseJSON(row.answers, {}),
  }));
  const wrongQuestions = db.prepare('SELECT * FROM wrong_questions ORDER BY added_at DESC').all();
  const appSettings = db.prepare('SELECT * FROM app_settings ORDER BY updated_at DESC').all();
  const aiChatSessions = db.prepare('SELECT * FROM ai_chat_sessions ORDER BY updated_at DESC').all();
  const aiChatMessages = db.prepare('SELECT * FROM ai_chat_messages ORDER BY created_at ASC').all();
  const importStaging = db.prepare('SELECT * FROM import_staging ORDER BY created_at ASC').all();

  return {
    version: 1,
    exported_at: new Date().toISOString(),
    stats: {
      papers: papers.length,
      questions: questions.length,
      practice_records: practiceRecords.length,
      wrong_questions: wrongQuestions.length,
      app_settings: appSettings.length,
      ai_chat_sessions: aiChatSessions.length,
      ai_chat_messages: aiChatMessages.length,
      import_staging: importStaging.length,
    },
    data: {
      papers,
      questions,
      practice_records: practiceRecords,
      wrong_questions: wrongQuestions,
      app_settings: appSettings,
      ai_chat_sessions: aiChatSessions,
      ai_chat_messages: aiChatMessages,
      import_staging: importStaging,
    },
  };
}

function importAllData(payload = {}) {
  if (!payload || typeof payload !== 'object') throw new Error('备份文件不能为空');

  const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
  const requiredKeys = ['papers', 'questions', 'practice_records', 'wrong_questions', 'app_settings', 'ai_chat_sessions', 'ai_chat_messages'];
  const missingKey = requiredKeys.find((key) => !Array.isArray(data[key]));
  if (missingKey) throw new Error(`备份文件缺少 ${missingKey} 数据`);

  const papers = normalizePaperRecords(data.papers);
  const paperIds = new Set();
  const questionIds = new Set();
  const sessionIds = new Set();

  const insertPaper = db.prepare(`
    INSERT INTO papers (id, title, year, type, subject, province, question_count, duration, difficulty, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertQuestion = db.prepare(`
    INSERT INTO questions (id, paper_id, order_num, type, category, sub_category, chapter, content, content_html, options, answer, answer_images, answer_source, answer_status, answer_confidence, answer_updated_at, analysis, analysis_html, difficulty, tags, textbook_format_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPracticeRecord = db.prepare(`
    INSERT INTO practice_records (id, paper_id, category, sub_category, start_time, end_time, duration, status, answers, correct_count, total_count, accuracy, score, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertWrongQuestion = db.prepare(`
    INSERT INTO wrong_questions (
      id, question_id, paper_id, user_answer, correct_answer,
      added_at, review_count, last_review, next_review_at, review_stage,
      source_type, source_label, q_type, q_content, q_content_html, q_options,
      q_analysis, q_analysis_html, q_category, q_sub_category, q_answer, images, reason, note
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAppSetting = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
  `);
  const insertChatSession = db.prepare(`
    INSERT INTO ai_chat_sessions (id, title, provider, model, message_count, last_message_at, created_at, updated_at, subject_id, context_json, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertChatMessage = db.prepare(`
    INSERT INTO ai_chat_messages (id, session_id, role, content, meta, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    db.prepare('DELETE FROM ai_chat_messages').run();
    db.prepare('DELETE FROM ai_chat_sessions').run();
    db.prepare('DELETE FROM wrong_questions').run();
    db.prepare('DELETE FROM practice_records').run();
    db.prepare('DELETE FROM questions').run();
    db.prepare('DELETE FROM papers').run();
    db.prepare('DELETE FROM app_settings').run();

    papers.forEach((paper) => {
      const id = String(paper?.id || '').trim();
      if (!id) return;
      paperIds.add(id);
      insertPaper.run(
        id,
        String(paper.title || 'StudyStudio 试卷').trim() || 'StudyStudio 试卷',
        Number(paper.year) || new Date().getFullYear(),
        String(paper.type || 'provincial').trim() || 'provincial',
        String(paper.subject || 'xingce').trim() || 'xingce',
        normalizePaperProvince(paper.province),
        Math.max(0, Number(paper.question_count) || 0),
        Math.max(1, Number(paper.duration) || 120),
        Math.max(1, Math.min(5, Number(paper.difficulty) || 3)),
        String(paper.created_at || toSQLiteDateTime())
      );
    });

    data.questions.forEach((question, index) => {
      // 旧备份里的题目在恢复时就补齐教材格式，避免「恢复完又变回 OCR 原文」
      const formatted = formatRestoredQuestion(question);
      const questionId = String(formatted?.id || `q_import_${index + 1}`).trim();
      const paperId = String(formatted?.paper_id || '').trim();
      const content = String(formatted?.content || '').trim();
      if (!questionId || !paperIds.has(paperId) || !content) return;
      questionIds.add(questionId);
      const taxonomy = normalizeQuestionTaxonomy({
        category: question.category,
        subCategory: question.sub_category,
        content,
      });
      const restoredAnswerImages = parseAnswerImages(question.answer_images ?? question.answerImages);
      const restoredAnswer = String(formatted.answer ?? '').trim();
      insertQuestion.run(
        questionId,
        paperId,
        Math.max(1, Number(question.order_num) || (index + 1)),
        normalizeQuestionType(question.type),
        taxonomy.category,
        taxonomy.subCategory,
        String(question.chapter || '').trim() || null,
        content,
        String(formatted.content_html || formatted.contentHtml || '').trim() || null,
        JSON.stringify(normalizeQuestionOptions(formatted.options)),
        restoredAnswer,
        JSON.stringify(restoredAnswerImages),
        String(question.answer_source || 'imported'),
        String(question.answer_status || ((restoredAnswer || restoredAnswerImages.length) ? 'unverified' : 'missing')),
        Number.isFinite(Number(question.answer_confidence)) ? Number(question.answer_confidence) : null,
        question.answer_updated_at || null,
        String(formatted.analysis || ''),
        String(formatted.analysis_html || formatted.analysisHtml || '').trim() || null,
        Math.max(1, Math.min(5, Number(formatted.difficulty) || 2)),
        normalizeQuestionTags(formatted.tags),
        TEXTBOOK_FORMAT_VERSION,
        String(formatted.created_at || toSQLiteDateTime())
      );
    });

    data.practice_records.forEach((record, index) => {
      const id = String(record?.id || `record_import_${index + 1}`).trim();
      if (!id || !record?.start_time) return;
      insertPracticeRecord.run(
        id,
        record.paper_id ? String(record.paper_id) : null,
        record.category ? String(record.category) : null,
        record.sub_category ? String(record.sub_category) : null,
        String(record.start_time),
        record.end_time ? String(record.end_time) : null,
        Number(record.duration) || 0,
        String(record.status || 'completed'),
        JSON.stringify(record.answers && typeof record.answers === 'object' ? record.answers : {}),
        Math.max(0, Number(record.correct_count) || 0),
        Math.max(0, Number(record.total_count) || 0),
        Math.max(0, Number(record.accuracy) || 0),
        Math.max(0, Number(record.score) || 0),
        String(record.created_at || toSQLiteDateTime())
      );
    });

    data.wrong_questions.forEach((item, index) => {
      const id = String(item?.id || `wrong_import_${index + 1}`).trim();
      const questionId = String(item?.question_id || '').trim();
      const paperId = String(item?.paper_id || '').trim();
      // 平台错题仍要求题目/试卷在导入数据中；自建错题（manual / upload）用虚拟 ID，不要求存在
      const sourceType = ['manual', 'upload'].includes(String(item?.source_type || '')) ? item.source_type : 'platform';
      const isCustom = sourceType === 'manual' || sourceType === 'upload';
      if (!id) return;
      if (!isCustom && (!questionIds.has(questionId) || !paperIds.has(paperId))) return;
      const options = Array.isArray(item?.q_options) ? item.q_options : [];
      const images = Array.isArray(item?.images) ? item.images : [];
      insertWrongQuestion.run(
        id,
        questionId,
        paperId,
        item.user_answer ? String(item.user_answer) : null,
        item.correct_answer ? String(item.correct_answer) : null,
        String(item.added_at || toSQLiteDateTime()),
        Math.max(0, Number(item.review_count) || 0),
        item.last_review ? String(item.last_review) : null,
        item.next_review_at ? String(item.next_review_at) : null,
        Math.max(0, Number(item.review_stage) || 0),
        sourceType,
        item.source_label ? String(item.source_label) : null,
        String(item.q_type || 'single'),
        item.q_content ? String(item.q_content) : null,
        item.q_content_html ? String(item.q_content_html) : null,
        JSON.stringify(Array.isArray(options) ? options : []),
        item.q_analysis ? String(item.q_analysis) : null,
        item.q_analysis_html ? String(item.q_analysis_html) : null,
        item.q_category ? String(item.q_category) : null,
        item.q_sub_category ? String(item.q_sub_category) : null,
        item.q_answer ? String(item.q_answer) : null,
        JSON.stringify(Array.isArray(images) ? images : []),
        item.reason ? String(item.reason) : null,
        item.note ? String(item.note) : null
      );
    });

    data.app_settings.forEach((item) => {
      const key = String(item?.key || '').trim();
      if (!key) return;
      insertAppSetting.run(key, String(item.value || ''), String(item.updated_at || toSQLiteDateTime()));
    });

    data.ai_chat_sessions.forEach((session, index) => {
      const id = String(session?.id || `chat_import_${index + 1}`).trim();
      if (!id) return;
      sessionIds.add(id);
      insertChatSession.run(
        id,
        String(session.title || '新会话').trim() || '新会话',
        session.provider ? String(session.provider) : null,
        session.model ? String(session.model) : null,
        Math.max(0, Number(session.message_count) || 0),
        session.last_message_at ? String(session.last_message_at) : null,
        String(session.created_at || toSQLiteDateTime()),
        String(session.updated_at || toSQLiteDateTime()),
        session.subject_id ? String(session.subject_id) : null,
        session.context_json ? String(session.context_json) : null,
        session.source ? String(session.source) : 'chat'
      );
    });

    data.ai_chat_messages.forEach((message, index) => {
      const id = String(message?.id || `msg_import_${index + 1}`).trim();
      const sessionId = String(message?.session_id || '').trim();
      const content = String(message?.content || '').trim();
      const meta = message?.meta === undefined || message?.meta === null || message?.meta === ''
        ? null
        : String(message.meta);
      if (!id || !sessionIds.has(sessionId) || (!content && !meta)) return;
      insertChatMessage.run(
        id,
        sessionId,
        String(message.role || 'assistant').trim() || 'assistant',
        content,
        meta,
        String(message.created_at || toSQLiteDateTime())
      );
    });

    // 备份里的暂存记录同样要恢复：未入库的题一条都不能丢。
    // 已标记 committed 但备份里找不到对应试卷的记录退回 pending，交给恢复流程补写。
    if (Array.isArray(data.import_staging)) {
      const insertStaging = db.prepare(`
        INSERT OR IGNORE INTO import_staging
          (id, task_id, batch_id, status, payload, meta, error, paper_id, created_at, updated_at, committed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      data.import_staging.forEach((row) => {
        const id = String(row?.id || '').trim();
        if (!id || !row?.payload) return;
        const status = STAGING_STATUS.has(row.status) ? row.status : 'pending';
        const paperId = row.paper_id ? String(row.paper_id) : null;
        const finalStatus = status === 'committed' && paperId && !paperIds.has(paperId) ? 'pending' : status;
        insertStaging.run(
          id,
          String(row.task_id || 'task_restored'),
          row.batch_id ? String(row.batch_id) : null,
          finalStatus,
          String(row.payload),
          row.meta ? String(row.meta) : null,
          row.error ? String(row.error) : null,
          paperId,
          String(row.created_at || toSQLiteDateTime()),
          String(row.updated_at || toSQLiteDateTime()),
          finalStatus === 'pending' ? null : (row.committed_at || null)
        );
      });
    }

    db.prepare(`
      UPDATE papers
      SET question_count = (
        SELECT COUNT(*) FROM questions WHERE paper_id = papers.id
      )
    `).run();

    db.prepare(`
      UPDATE ai_chat_sessions
      SET
        message_count = (
          SELECT COUNT(*) FROM ai_chat_messages WHERE session_id = ai_chat_sessions.id
        ),
        last_message_at = (
          SELECT MAX(created_at) FROM ai_chat_messages WHERE session_id = ai_chat_sessions.id
        )
    `).run();
  })();

  normalizePaperProvinceData();

  return {
    success: true,
    imported_at: new Date().toISOString(),
    stats: {
      papers: db.prepare('SELECT COUNT(*) AS c FROM papers').get().c,
      questions: db.prepare('SELECT COUNT(*) AS c FROM questions').get().c,
      practice_records: db.prepare('SELECT COUNT(*) AS c FROM practice_records').get().c,
      wrong_questions: db.prepare('SELECT COUNT(*) AS c FROM wrong_questions').get().c,
      app_settings: db.prepare('SELECT COUNT(*) AS c FROM app_settings').get().c,
      ai_chat_sessions: db.prepare('SELECT COUNT(*) AS c FROM ai_chat_sessions').get().c,
      ai_chat_messages: db.prepare('SELECT COUNT(*) AS c FROM ai_chat_messages').get().c,
    },
  };
}

function resetUserData() {
  const clearedAt = new Date().toISOString();
  const savedPaperIds = db.prepare(`
    SELECT id FROM papers
    WHERE type IN (${USER_GENERATED_PAPER_TYPE_SQL})
  `).all().map((row) => row.id);

  const deleteSavedQuestions = savedPaperIds.length > 0
    ? db.prepare(`DELETE FROM questions WHERE paper_id IN (${savedPaperIds.map(() => '?').join(', ')})`)
    : null;
  const deleteSavedPapers = savedPaperIds.length > 0
    ? db.prepare(`DELETE FROM papers WHERE id IN (${savedPaperIds.map(() => '?').join(', ')})`)
    : null;

  const cleared = db.transaction(() => {
    const wrongQuestions = db.prepare('DELETE FROM wrong_questions').run().changes;
    const practiceRecords = db.prepare('DELETE FROM practice_records').run().changes;
    const aiChatMessages = db.prepare('DELETE FROM ai_chat_messages').run().changes;
    const aiChatSessions = db.prepare('DELETE FROM ai_chat_sessions').run().changes;
    const appSettings = db.prepare('DELETE FROM app_settings').run().changes;
    const savedQuestions = deleteSavedQuestions ? deleteSavedQuestions.run(...savedPaperIds).changes : 0;
    const savedPapers = deleteSavedPapers ? deleteSavedPapers.run(...savedPaperIds).changes : 0;

    return {
      wrongQuestions,
      practiceRecords,
      aiChatMessages,
      aiChatSessions,
      appSettings,
      savedQuestions,
      savedPapers,
    };
  })();

  const preserved = {
    papers: db.prepare(`
      SELECT COUNT(*) AS c FROM papers
      WHERE type NOT IN (${USER_GENERATED_PAPER_TYPE_SQL})
    `).get().c,
    questions: db.prepare(`
      SELECT COUNT(*) AS c
      FROM questions q
      INNER JOIN papers p ON p.id = q.paper_id
      WHERE p.type NOT IN (${USER_GENERATED_PAPER_TYPE_SQL})
    `).get().c,
  };

  return {
    success: true,
    clearedAt,
    cleared,
    preserved,
  };
}

function clearAllData() {
  db.transaction(() => {
    db.prepare('DELETE FROM import_staging').run();
    db.prepare('DELETE FROM wrong_questions').run();
    db.prepare('DELETE FROM practice_records').run();
    db.prepare('DELETE FROM questions').run();
    db.prepare('DELETE FROM papers').run();
    db.prepare('DELETE FROM ai_chat_messages').run();
    db.prepare('DELETE FROM ai_chat_sessions').run();
    db.prepare('DELETE FROM app_settings').run();
  })();

  return {
    success: true,
    cleared_at: new Date().toISOString(),
  };
}

// 关闭数据库
function closeDatabase() {
  if (db) {
    db.close();
  }
}

// 只读句柄，供本地备份等模块做在线快照
function getDatabase() {
  return db;
}

module.exports = {
  initDatabase,
  getDatabase,
  closeDatabase,
  ...studyPlan,
  getPapers,
  getQuestionsByPaperId,
  getQuestionsByIds,
  updateQuestionAnswer,
  addQuestionAnswerImage,
  removeQuestionAnswerImage,
  savePracticeRecord,
  getPracticeRecords,
  addWrongQuestion,
  getWrongQuestions,
  getWrongQuestionById,
  saveCustomWrongQuestion,
  reviewWrongQuestion,
  removeWrongQuestion,
  getTodayReviewQueue,
  addWrongQuestionToTodayReview,
  getDailyPractice,
  ensureDailyPractice,
  completeDailyPractice,
  updatePracticeRecordScore,
  getCategoryStats,
  listCustomSubjectCategories,
  getKnowledgeGraph,
  getReclassifyBatches,
  getQuestionsForReclassify,
  getSubjectsForPaperIds,
  getSubjectKnowledgeContent,
  isMissingChapter,
  getSubjectQuestionsForClassification,
  getSubjectChapterDistribution,
  getQuestionsByKnowledge,
  applyQuestionClassifications,
  getSmartRecommend,
  getSubCategoryStats,
  repairQuestionCategories,
  repairQuestionTaxonomy,
  repairQuestionQuality,
  migrateTextbookFormat,
  getPracticeStats,
  resetStudyProgress,
  importPaper,
  appendImportedQuestions,
  stageImportedQuestions,
  updateStagedQuestions,
  getPendingStagedQuestions,
  getStagingSummary,
  recoverStagedImports,
  clearStagedQuestions,
  saveAIPaper,
  getImportedPapers,
  getSavedAIPapers,
  renameSavedPaper,
  deleteSavedPaper,
  getQuestionsByCategory,
  getSubjectQuestionContents,
  getSubjectTextbookPaper,
  getCategoryMaterialStats,
  getDailyStats,
  getStreakDays,
  getTodayStats,
  getTotalStudyMinutes,
  getHeatmapData,
  getAchievements,
  getGrowthData,
  getAppPreference,
  setAppPreference,
  getAISettings,
  saveAISettings,
  getAIConnectionState,
  saveAIConnectionState,
  getUserProfile,
  saveUserProfile,
  createAIChatSession,
  getAIChatSessions,
  getAIChatMessages,
  addAIChatMessage,
  updateAIChatMessageMeta,
  updateAIChatSessionContext,
  renameAIChatSession,
  deleteAIChatSession,
  searchAIChatSessions,
  setAIChatSessionPinned,
  exportAllData,
  importAllData,
  resetUserData,
  clearAllData
};
