/**
 * 科目管理（主进程）
 *
 * 「更宽泛的学习平台」的核心数据层：用户自建学习科目（数学、英语四六级、教资……），
 * 每个科目可选设置考试截止日期（决定 Good Learning skill 走备考模式还是学习模式），
 * 可上传教材让 AI 解析。科目解析完成后建立科目文件夹，存放教材转写、AI 对话记录与科目档案。
 *
 * 数据分布：
 * - SQLite `subjects` 表：科目元数据（模式 / 考试日期 / 教材状态 / 基础问卷 / 知识清单概要）
 * - `papers.subject_id` / `notes.subject_id` / `ai_chat_sessions.subject_id`：把题目、笔记、会话挂到科目
 * - userData/subjects/<id>/：教材/ + 对话/ + 科目档案.md（用户可直接打开阅读的文件夹视图）
 */

let db = null;
let userDataRoot = null;

function uid() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function todayStr(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseJSON(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function stringifyJSON(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function getUserDataRoot() {
  if (userDataRoot) return userDataRoot;
  try {
    // 延迟 require：让 ELECTRON_RUN_AS_NODE 下的纯逻辑测试不依赖 electron
    const { app } = require('electron');
    userDataRoot = app.getPath('userData');
  } catch (error) {
    userDataRoot = null;
  }
  return userDataRoot;
}

/** 迁移：给既有表补 subject_id 列（已存在则跳过） */
function ensureSubjectColumns() {
  const targets = ['notes', 'papers', 'ai_chat_sessions'];
  for (const table of targets) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    if (!columns.includes('subject_id')) {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN subject_id TEXT`).run();
    }
  }
  const subjectCols = db.prepare('PRAGMA table_info(subjects)').all().map((row) => row.name);
  if (!subjectCols.includes('category_key')) {
    db.prepare('ALTER TABLE subjects ADD COLUMN category_key TEXT').run();
  }
  seedPresetSubjects();
}

/**
 * 预置考研四科：与题库既有分类（math/english/politics/major）联动。
 * 通过 category_key 虚拟关联题库——这些分类下的既有试卷/题目自动归属到对应科目，
 * 不需要迁移数据。固定 ID，可改名；删除后靠 app_settings 标记避免下次启动再补。
 */
const PRESET_SUBJECTS = [
  { id: 'subj_math', name: '数学', categoryKey: 'math' },
  { id: 'subj_english', name: '英语', categoryKey: 'english' },
  { id: 'subj_politics', name: '政治', categoryKey: 'politics' },
  { id: 'subj_major', name: '专业课', categoryKey: 'major' },
];

function getAppFlag(key) {
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return row?.value;
  } catch {
    return null;
  }
}

function setAppFlag(key, value) {
  try {
    db.prepare(`
      INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(key, String(value));
  } catch (error) {
    console.warn('[Subjects] 写 app_settings 失败:', error?.message || error);
  }
}

/** 首次启动补齐预置科目（只补一次；用户删光科目也不会再冒出来） */
function seedPresetSubjects() {
  if (getAppFlag('subjects_presets_seeded_v1')) return;
  const existing = db.prepare('SELECT COUNT(*) AS c FROM subjects').get().c;
  if (existing === 0) {
    const insert = db.prepare(`
      INSERT INTO subjects (id, name, mode, category_key)
      VALUES (@id, @name, 'learn', @categoryKey)
    `);
    const run = db.transaction(() => {
      for (const preset of PRESET_SUBJECTS) {
        insert.run({ id: preset.id, name: preset.name, categoryKey: preset.categoryKey });
      }
    });
    run();
  }
  setAppFlag('subjects_presets_seeded_v1', '1');
}

function initSubjects(database) {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS subjects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'learn',
      exam_date TEXT,
      textbook_name TEXT,
      textbook_status TEXT NOT NULL DEFAULT 'none',
      textbook_pages INTEGER DEFAULT 0,
      profile TEXT,
      knowledge_summary TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  ensureSubjectColumns();

  // 解析流水线由渲染层驱动：进程重启后不可能还有解析在跑。
  // 残留的 parsing 一律标成 failed，卡片上给出「重新上传」入口，而不是永远停在「解析中」。
  try {
    db.prepare("UPDATE subjects SET textbook_status = 'failed' WHERE textbook_status = 'parsing'").run();
  } catch (error) {
    console.warn('[Subjects] 重置中断的解析状态失败:', error?.message || error);
  }
}

/* ------------------------------------------------------------------ 映射 */

function mapSubject(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    mode: row.mode === 'exam' ? 'exam' : 'learn',
    examDate: row.exam_date || null,
    categoryKey: row.category_key || null,
    textbookName: row.textbook_name || null,
    textbookStatus: row.textbook_status || 'none',
    textbookPages: Number(row.textbook_pages) || 0,
    profile: parseJSON(row.profile, null),
    knowledgeSummary: row.knowledge_summary || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* ------------------------------------------------------------------ CRUD */

function saveSubject(input = {}) {
  const existing = input.id ? db.prepare('SELECT * FROM subjects WHERE id = ?').get(String(input.id)) : null;
  if (input.id && !existing) throw new Error('科目不存在');
  if (!input.id && !String(input.name || '').trim()) throw new Error('科目名称不能为空');

  const name = String(input.name || existing?.name || '').trim();
  if (!name) throw new Error('科目名称不能为空');

  // 考试日期没传时保留原值，避免「只改状态」的更新把日期冲掉
  const examDate = input.examDate !== undefined
    ? (input.examDate ? String(input.examDate).slice(0, 10) : null)
    : (existing?.exam_date || null);
  const mode = examDate ? 'exam' : (input.mode === 'exam' ? 'exam' : 'learn');

  if (existing) {
    db.prepare(`
      UPDATE subjects
      SET name = @name, mode = @mode, exam_date = @examDate,
          textbook_name = COALESCE(@textbookName, textbook_name),
          textbook_status = COALESCE(@textbookStatus, textbook_status),
          textbook_pages = COALESCE(@textbookPages, textbook_pages),
          profile = COALESCE(@profile, profile),
          knowledge_summary = COALESCE(@knowledgeSummary, knowledge_summary),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `).run({
      id: input.id,
      name,
      mode,
      examDate,
      textbookName: input.textbookName !== undefined ? String(input.textbookName || '') : null,
      textbookStatus: input.textbookStatus !== undefined ? String(input.textbookStatus || '') : null,
      textbookPages: input.textbookPages !== undefined ? Number(input.textbookPages) || 0 : null,
      profile: input.profile !== undefined ? stringifyJSON(input.profile) : null,
      knowledgeSummary: input.knowledgeSummary !== undefined ? String(input.knowledgeSummary || '') : null,
    });
    const updated = mapSubject(db.prepare('SELECT * FROM subjects WHERE id = ?').get(input.id));
    writeSubjectArchive(updated);
    return updated;
  }

  const id = input.id || `subj_${uid()}`;
  db.prepare(`
    INSERT INTO subjects (id, name, mode, exam_date, category_key, textbook_name, textbook_status, textbook_pages, profile)
    VALUES (@id, @name, @mode, @examDate, @categoryKey, @textbookName, @textbookStatus, @textbookPages, @profile)
  `).run({
    id,
    name,
    mode,
    examDate,
    categoryKey: input.categoryKey ? String(input.categoryKey) : null,
    textbookName: input.textbookName ? String(input.textbookName) : null,
    textbookStatus: input.textbookStatus || 'none',
    textbookPages: Number(input.textbookPages) || 0,
    profile: stringifyJSON(input.profile || null),
  });

  const created = mapSubject(db.prepare('SELECT * FROM subjects WHERE id = ?').get(id));
  ensureSubjectFolder(created);
  return created;
}

function getSubjects() {
  return db.prepare('SELECT * FROM subjects ORDER BY created_at DESC').all().map(mapSubject);
}

function getSubject(id) {
  if (!id) return null;
  return mapSubject(db.prepare('SELECT * FROM subjects WHERE id = ?').get(String(id)));
}

function deleteSubject(id) {
  const subjectId = String(id || '').trim();
  if (!subjectId) return { success: false };
  // 科目下的试卷 / 笔记 / 会话保留，只解绑：删科目不删学习数据
  db.prepare('UPDATE papers SET subject_id = NULL WHERE subject_id = ?').run(subjectId);
  db.prepare('UPDATE notes SET subject_id = NULL WHERE subject_id = ?').run(subjectId);
  db.prepare('UPDATE ai_chat_sessions SET subject_id = NULL WHERE subject_id = ?').run(subjectId);
  db.prepare('DELETE FROM subjects WHERE id = ?').run(subjectId);
  return { success: true };
}

/**
 * 科目学习数据统计。
 * 两条归属路径：显式挂载（papers.subject_id = 科目 id，教材解析 / 助教录入走这条），
 * 以及预置科目的分类联动（subjects.category_key = math/english/politics/major 时，
 * 题库中该分类下的既有题目自动归属，无需迁移数据）。
 */
function getSubjectStats(subjectId) {
  const subject = getSubject(subjectId);
  if (!subject) return { papers: 0, questions: 0, wrong: 0 };

  const explicitPapers = db.prepare('SELECT COUNT(*) AS c FROM papers WHERE subject_id = ?').get(subject.id).c;
  let papers = explicitPapers;
  let questions = db.prepare('SELECT COUNT(*) AS c FROM questions WHERE paper_id IN (SELECT id FROM papers WHERE subject_id = ?)').get(subject.id).c;

  if (subject.categoryKey) {
    const catRow = db.prepare(`
      SELECT COUNT(DISTINCT q.paper_id) AS papers, COUNT(*) AS questions
      FROM questions q
      JOIN papers p ON q.paper_id = p.id
      WHERE q.category = ? AND (p.subject_id IS NULL OR p.subject_id = ?)
    `).get(subject.categoryKey, subject.id);
    papers += Number(catRow?.papers) || 0;
    questions = Math.max(questions, Number(catRow?.questions) || 0);
  }

  // 错题按题目快照里的分类联动（预置科目），显式错题按科目统计暂无直接字段，先按分类
  let wrong = 0;
  if (subject.categoryKey) {
    wrong = db.prepare('SELECT COUNT(*) AS c FROM wrong_questions WHERE q_category = ?').get(subject.categoryKey).c;
  }

  return { papers, questions, wrong };
}

/* ------------------------------------------------------------------ 科目文件夹 */

function getSubjectDir(subjectId) {
  const root = getUserDataRoot();
  if (!root || !subjectId) return null;
  const path = require('path');
  const fs = require('fs');
  const dir = path.join(root, 'subjects', String(subjectId));
  fs.mkdirSync(path.join(dir, '教材'), { recursive: true });
  fs.mkdirSync(path.join(dir, '对话'), { recursive: true });
  return dir;
}

/** 建科目时创建文件夹并写入档案 */
function ensureSubjectFolder(subject) {
  const dir = getSubjectDir(subject?.id);
  if (!dir) return null;
  writeSubjectArchive(subject);
  return dir;
}

/** 科目档案：模式 / 考试日期 / 基础问卷 / 数据概览（Obsidian 兼容 frontmatter） */
function writeSubjectArchive(subject) {
  const dir = getSubjectDir(subject?.id);
  if (!dir || !subject) return false;
  const fs = require('fs');
  const path = require('path');

  const examLine = subject.mode === 'exam' && subject.examDate
    ? `考试日期：${subject.examDate}`
    : '考试日期：未设置（学习模式）';
  const profile = subject.profile || {};
  const profileLines = profile && (profile.level || profile.dailyHours)
    ? [
        `学习基础：${profile.level || '未填写'}`,
        `每天可用：${profile.dailyHours || '?'} 小时 × 每周 ${profile.weeklyDays || '?'} 天`,
        profile.style ? `学习偏好：${profile.style}` : '',
        profile.notes ? `备注：${profile.notes}` : '',
      ].filter(Boolean)
    : ['学习基础：待问卷（AI 助教会在教材解析后主动询问）'];

  const content = [
    '---',
    `title: ${subject.name}`,
    'kind: subject-archive',
    `mode: ${subject.mode}`,
    subject.examDate ? `exam_date: ${subject.examDate}` : null,
    '---',
    '',
    `# ${subject.name} · 科目档案`,
    '',
    examLine,
    `教材：${subject.textbookName ? `${subject.textbookName}（${subject.textbookStatus === 'ready' ? `已解析 ${subject.textbookPages} 页` : subject.textbookStatus === 'parsing' ? '解析中' : '未解析'}）` : '未上传'}`,
    ...profileLines,
    '',
    '## 学习数据',
    '',
    '- 题库：该科目试卷与题目存于应用题库（按科目筛选）',
    '- 笔记：知识清单 / 学习计划 / 每日学习见 Obsidian 仓库同名科目文件夹',
    '- AI 对话：本文件夹 `对话/` 下按会话存档',
    '',
    '## 知识清单概要',
    '',
    subject.knowledgeSummary ? subject.knowledgeSummary.slice(0, 2000) : '（教材解析完成后自动生成）',
    '',
  ].filter((line) => line !== null).join('\n');

  fs.writeFileSync(path.join(dir, '科目档案.md'), content, 'utf8');
  return true;
}

/** 教材逐页转写结果落盘：教材/教材全文.md */
function writeSubjectTextbook(subjectId, fileName, markdown, pageCount) {
  const dir = getSubjectDir(subjectId);
  if (!dir) return null;
  const fs = require('fs');
  const path = require('path');
  const file = path.join(dir, '教材', '教材全文.md');
  fs.writeFileSync(file, String(markdown || ''), 'utf8');
  if (fileName) {
    db.prepare('UPDATE subjects SET textbook_name = ?, textbook_pages = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(String(fileName), Number(pageCount) || 0, String(subjectId));
  }
  return file;
}

/** 该科目的会话落盘：对话/<标题>.md（每次消息后整体重写，会话不长，简单可靠） */
function syncSubjectChatFile(sessionId) {
  const session = db.prepare('SELECT * FROM ai_chat_sessions WHERE id = ?').get(String(sessionId || ''));
  if (!session || !session.subject_id) return null;
  const dir = getSubjectDir(session.subject_id);
  if (!dir) return null;
  const fs = require('fs');
  const path = require('path');

  const messages = db.prepare(
    'SELECT role, content, created_at FROM ai_chat_messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC'
  ).all(String(sessionId));

  const safeTitle = String(session.title || '未命名会话').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  const lines = [
    '---',
    `title: ${safeTitle}`,
    'kind: chat',
    `subject: ${session.subject_id}`,
    `session_id: ${session.id}`,
    '---',
    '',
    `# ${safeTitle}`,
    '',
  ];
  for (const message of messages) {
    lines.push(`## ${message.role === 'assistant' ? 'AI' : '我'} · ${String(message.created_at || '').slice(0, 16)}`);
    lines.push('');
    lines.push(String(message.content || ''));
    lines.push('');
  }
  fs.writeFileSync(path.join(dir, '对话', `${safeTitle}-${String(sessionId).slice(-6)}.md`), lines.join('\n'), 'utf8');
  return true;
}

/** 该科目下的会话重命名 / 删除后清理旧文件 */
function removeSubjectChatFiles(subjectId, keepSessionIds = []) {
  const dir = getSubjectDir(subjectId);
  if (!dir) return;
  const fs = require('fs');
  const path = require('path');
  const chatDir = path.join(dir, '对话');
  const keep = new Set(keepSessionIds.map((id) => String(id).slice(-6)));
  try {
    for (const file of fs.readdirSync(chatDir)) {
      const match = file.match(/-([A-Za-z0-9]+)\.md$/);
      if (match && !keep.has(match[1])) {
        fs.unlinkSync(path.join(chatDir, file));
      }
    }
  } catch (error) {
    console.warn('[Subjects] 清理对话文件失败:', error?.message || error);
  }
}

module.exports = {
  initSubjects,
  saveSubject,
  getSubjects,
  getSubject,
  deleteSubject,
  getSubjectStats,
  getSubjectDir,
  writeSubjectArchive,
  writeSubjectTextbook,
  syncSubjectChatFile,
  removeSubjectChatFiles,
  todayStr,
};
