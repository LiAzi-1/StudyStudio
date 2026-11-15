'use strict';
/**
 * 应用内笔记 ↔ Obsidian 笔记的双向同步。
 *
 * 单向推送（应用 → vault）早就有，但用户真正需要的是两边都能改：
 * 在 Obsidian 里补一段推导、在应用里改个标题，都不该被对方覆盖掉。
 *
 * 冲突判定按时间：
 *   只有一边变 → 直接采纳；
 *   两边都变   → 比 vault 文件 mtime 与 notes.updated_at，谁新听谁的，并在结果里记一条 conflict。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const fm = require('./frontmatter');
const V = require('./vault');
const { normalizeMath } = require('../../shared/mathStyle.js');

/** 这些属性由同步器自己维护，每次推送都重算，不从旧文件继承 */
const OWNED_KEYS = new Set([
  'title', 'date', 'tags', 'source',
  'app_note_id', 'app_updated_at', 'app_synced_at',
]);

/** AI 整理产出的分类属性：应用自己生成的笔记不该继承 vault 里的旧值 */
const CLASSIFICATION_KEYS = new Set([
  'summary', 'knowledge_points', 'knowledge_labels', 'subject', 'topic',
  'note_type', 'difficulty', 'mastery', 'key_concepts',
  'ai_tutor', 'ai_model', 'ai_fallback', 'ai_at',
]);

const STATE_VERSION = 1;

function sha1(text, length = 40) {
  return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex').slice(0, length);
}

function noteDigest(note) {
  const tags = Array.isArray(note?.tags) ? note.tags : [];
  return sha1([
    note?.title, note?.content, tags.join('|'), note?.updatedAt, JSON.stringify(note?.meta ?? null),
  ].join('\u0001'));
}

function statePath(vaultDir) {
  return path.join(vaultDir, V.DIR.bridge, 'sync-state.json');
}

function loadState(vaultDir) {
  try {
    const raw = fs.readFileSync(statePath(vaultDir), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') throw new Error('bad state');
    return {
      version: STATE_VERSION,
      notes: data.notes && typeof data.notes === 'object' ? data.notes : {},
      lastRun: data.lastRun || null,
    };
  } catch {
    return { version: STATE_VERSION, notes: {}, lastRun: null };
  }
}

function saveState(vaultDir, state) {
  V.writeFileAtomic(statePath(vaultDir), `${JSON.stringify(state, null, 2)}\n`);
}

/** 去掉桥接注入的段落（题库镜像 / 知识点 / 地图索引），避免回流到应用正文 */
function stripInjected(body) {
  let out = String(body || '');
  for (const [start, end] of Object.values(V.MARK)) {
    const pattern = new RegExp(`${escapeRe(start)}[\\s\\S]*?${escapeRe(end)}`, 'g');
    out = out.replace(pattern, '');
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** SQLite 的 CURRENT_TIMESTAMP 是 UTC，不带时区标记，要显式按 UTC 解析 */
function parseDbTime(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
  const stamp = Date.parse(withZone);
  return Number.isFinite(stamp) ? stamp : 0;
}

function fileStamp(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function noteFileName(note) {
  const title = V.safeName(note.title || '未命名笔记', 48) || '未命名笔记';
  return `${title}-${String(note.id || '').slice(0, 6)}.md`;
}

function relativeFile(vaultDir, absolute) {
  return path.relative(vaultDir, absolute).split(path.sep).join('/');
}

/** 应用内 AI 整理结果 → vault frontmatter 字段（与 Python 版 oe_tutor 的映射保持一致） */
function metaToFrontmatter(meta) {
  if (!meta || typeof meta !== 'object' || !meta.ai) return {};
  const points = Array.isArray(meta.knowledgePoints) ? meta.knowledgePoints : [];
  const labels = Array.isArray(meta.knowledgeLabels) && meta.knowledgeLabels.length
    ? meta.knowledgeLabels
    : points.map((item) => item?.label).filter(Boolean);

  const fields = {
    summary: meta.summary || '',
    knowledge_points: points.map((item) => item?.id).filter(Boolean),
    knowledge_labels: labels.filter(Boolean),
    subject: meta.subject || '',
    topic: meta.topic || '',
    note_type: meta.noteType || '',
    difficulty: meta.difficulty || 3,
    mastery: meta.mastery || '',
    key_concepts: Array.isArray(meta.keyConcepts) ? meta.keyConcepts : [],
    ai_tutor: true,
    ai_model: meta.model || '',
    ai_fallback: Boolean(meta.fallback),
    ai_at: meta.at || '',
  };
  // 空值不写，避免 Obsidian 属性面板里出现一堆空白行
  for (const key of Object.keys(fields)) {
    const value = fields[key];
    if (value === '' || value === null || value === undefined) delete fields[key];
    else if (Array.isArray(value) && !value.length) delete fields[key];
  }
  return fields;
}

/* ------------------------------------------------------------------ 推送 */

function pushNotes({ vaultDir, notes, subjects }) {
  V.ensureVault(vaultDir);
  const state = loadState(vaultDir);
  const subjectName = new Map((subjects || []).map((s) => [String(s.id), s.name]));

  const dir = path.join(vaultDir, V.DIR.appNotes);
  fs.mkdirSync(dir, { recursive: true });

  let written = 0;
  let skipped = 0;
  const removed = [];

  const liveIds = new Set();

  for (const note of notes || []) {
    const id = String(note.id || '');
    if (!id) continue;
    liveIds.add(id);

    const target = path.join(dir, noteFileName(note));
    const tags = Array.isArray(note.tags) ? note.tags : [];
    const digest = noteDigest(note);
    const record = state.notes[id];
    const fileExists = fs.existsSync(target);
    // 应用自己生成的笔记（教材知识清单等）分类由应用说了算，
    // 不要把 vault 里上一轮 AI 整理留下的旧考点名一起搬回来
    const appOwnsNote = Boolean(note.meta && typeof note.meta === 'object' && note.meta.kind);
    const synced = Boolean(record && record.hash === digest && fileExists);

    // 内容没变、又是用户手写笔记 → 不必把镜像文件整个读一遍再解析 frontmatter
    if (synced && !appOwnsNote) {
      skipped += 1;
      continue;
    }

    // 保留 AI 助教 / 用户手写的其他属性，只覆盖同步器自己那几个字段
    const existing = fileExists
      ? fm.parse(fs.readFileSync(target, 'utf8'))
      : { meta: {}, body: '' };
    const hasStaleClassification = appOwnsNote
      && Object.keys(existing.meta || {}).some((key) => CLASSIFICATION_KEYS.has(key));

    // 正文没变、也没有需要清掉的旧属性，才算真的不用重写
    if (synced && !hasStaleClassification) {
      skipped += 1;
      continue;
    }

    const carried = {};
    for (const [key, value] of Object.entries(existing.meta || {})) {
      if (OWNED_KEYS.has(key)) continue;
      if (appOwnsNote && CLASSIFICATION_KEYS.has(key)) continue;
      carried[key] = value;
    }

    const meta = {
      title: note.title || '未命名笔记',
      date: String(note.updatedAt || '').slice(0, 10) || new Date().toISOString().slice(0, 10),
      tags,
      source: 'openexam-app',
      app_note_id: id,
      app_updated_at: String(note.updatedAt || ''),
      app_synced_at: new Date().toISOString(),
      ...carried,
      // 应用侧整理过就以应用为准，覆盖 vault 里的旧分类结果
      ...metaToFrontmatter(note.meta),
    };
    if (note.subjectId && subjectName.has(String(note.subjectId)) && !meta.subject) {
      meta.subject = subjectName.get(String(note.subjectId));
    }

    // 镜像进 Obsidian 前统一公式写法：存量笔记没重新保存过也能在 vault 里正确渲染
    const body = `${normalizeMath(String(note.content || '').trim()).text.trim()}\n`;
    V.writeFileAtomic(target, fm.dump(meta) + body);

    state.notes[id] = {
      file: relativeFile(vaultDir, target),
      hash: digest,
      bodyHash: sha1(body),
      pushedAt: Date.now(),
      fileMtimeMs: fileStamp(target),
      title: meta.title,
    };
    written += 1;
  }

  // 应用里删掉的笔记，把对应镜像也删掉（只删同步器自己生成的，带 app_note_id 的）
  for (const [id, record] of Object.entries(state.notes)) {
    if (liveIds.has(id)) continue;
    if (!record?.file) continue;
    const absolute = path.join(vaultDir, ...record.file.split('/'));
    if (!fs.existsSync(absolute)) {
      delete state.notes[id];
      continue;
    }
    const { meta } = fm.parse(fs.readFileSync(absolute, 'utf8'));
    if (String(meta.app_note_id || '') !== id) continue; // 用户改过就别动
    try {
      fs.unlinkSync(absolute);
      removed.push(record.file);
    } catch {
      continue;
    }
    delete state.notes[id];
  }

  // 一篇笔记在 vault 里只保留一份镜像：
  //   ① 应用侧已删除 → 删镜像（即使 state 记录丢了也要清，否则会留孤儿）
  //   ② 笔记改过标题 → 会生成新文件名，旧那份同 ID 的副本也要清掉
  // 只扫托管目录，用户在 10-笔记 其他位置另存的备份不动。
  const managed = listManagedNoteFiles(vaultDir, state);
  for (const entry of managed) {
    const record = state.notes[entry.noteId];
    const rel = relativeFile(vaultDir, entry.absolute);
    const keep = liveIds.has(entry.noteId) && record?.file === rel;
    if (keep) continue;
    try {
      fs.unlinkSync(entry.absolute);
      removed.push(rel);
    } catch {
      // 文件被 Obsidian 占用等，留到下一轮再试，不阻断本次同步
    }
    if (!liveIds.has(entry.noteId)) delete state.notes[entry.noteId];
  }

  state.lastRun = new Date().toISOString();
  saveState(vaultDir, state);
  return { written, skipped, removed };
}

/* ------------------------------------------------------------------ 拉取 */

/** 托管目录（10-笔记/应用笔记）里全部带 app_note_id 的文件，一个 id 可能有多份（改过标题就会） */
function listManagedNoteFiles(vaultDir, state) {
  const root = path.join(vaultDir, ...V.DIR.appNotes.split('/'));
  const knownByFile = indexSyncRecords(state);
  const found = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(absolute); continue; }
      if (!entry.name.toLowerCase().endsWith('.md')) continue;
      // 上次同步后文件没动过：noteId 已经在 sync-state 里，不必再读一遍正文
      const cached = unchangedRecord(knownByFile, vaultDir, absolute);
      if (cached) {
        found.push({ noteId: cached.id, absolute });
        continue;
      }
      try {
        const { meta } = fm.parse(fs.readFileSync(absolute, 'utf8'));
        const noteId = String(meta.app_note_id || '').trim();
        if (noteId) found.push({ noteId, absolute });
      } catch { /* 读不了就跳过 */ }
    }
  };
  walk(root);
  return found;
}

/** sync-state 里的「镜像路径 → 记录」索引，用于按 mtime 判断文件是否自上次同步后没变 */
function indexSyncRecords(state) {
  const map = new Map();
  const notes = state?.notes;
  if (!notes || typeof notes !== 'object') return map;
  for (const [id, record] of Object.entries(notes)) {
    if (record?.file && record?.bodyHash) map.set(String(record.file), { id, record });
  }
  return map;
}

/** 文件自上次同步后未变化时返回对应记录，避免为了拿 app_note_id 把整个文件读进内存 */
function unchangedRecord(knownByFile, vaultDir, absolute) {
  if (!knownByFile.size) return null;
  const hit = knownByFile.get(relativeFile(vaultDir, absolute));
  if (!hit) return null;
  const stamp = fileStamp(absolute);
  return stamp && Number(hit.record.fileMtimeMs) === stamp ? hit : null;
}

/** 收集 vault 里带 app_note_id 的笔记文件 */
function scanAppNoteFiles(vaultDir, state) {
  const roots = [V.DIR.appNotes, V.DIR.notes];
  const found = new Map();
  const knownByFile = indexSyncRecords(state);
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '.obsidian') walk(absolute);
        continue;
      }
      if (!entry.name.toLowerCase().endsWith('.md')) continue;
      // 文件没变过：parsed 留空，pull 时直接跳过，省掉整份正文的读取与解析
      const cached = unchangedRecord(knownByFile, vaultDir, absolute);
      if (cached) {
        const cachedIsAppDir = relativeFile(vaultDir, absolute).startsWith(`${V.DIR.appNotes}/`);
        const previous = found.get(cached.id);
        if (!previous || (cachedIsAppDir && !previous.isAppDir)) {
          found.set(cached.id, { noteId: cached.id, absolute, parsed: null, isAppDir: cachedIsAppDir });
        }
        continue;
      }
      let parsed;
      try {
        parsed = fm.parse(fs.readFileSync(absolute, 'utf8'));
      } catch {
        continue;
      }
      const noteId = String(parsed.meta.app_note_id || '').trim();
      if (!noteId) continue;
      // 同一个 id 出现在多处时，优先 10-笔记/应用笔记 下的那份
      const isAppDir = relativeFile(vaultDir, absolute).startsWith(`${V.DIR.appNotes}/`);
      const previous = found.get(noteId);
      if (!previous || (isAppDir && !previous.isAppDir)) {
        found.set(noteId, { noteId, absolute, parsed, isAppDir });
      }
    }
  };
  for (const rel of roots) walk(path.join(vaultDir, ...rel.split('/')));
  return found;
}

function pullNotes({ vaultDir, notes, saveNote }) {
  const state = loadState(vaultDir);
  const firstRun = Object.keys(state.notes || {}).length === 0;
  const byId = new Map((notes || []).map((note) => [String(note.id), note]));
  const files = scanAppNoteFiles(vaultDir, state);

  const pulled = [];
  const conflicts = [];

  for (const [noteId, entry] of files) {
    const note = byId.get(noteId);
    if (!note) continue; // 应用里已删除，等下一轮 push 清理镜像
    // 文件自上次同步后没动过（scanAppNoteFiles 已按 mtime 判定）→ 不用再读正文
    if (!entry.parsed) continue;

    const bodyHash = sha1(entry.parsed.body);
    const record = state.notes[noteId];
    if (record && record.bodyHash === bodyHash) continue; // vault 没动过

    const vaultStamp = fileStamp(entry.absolute);
    const appStamp = parseDbTime(note.updatedAt);
    const appChangedSincePush = record?.pushedAt ? appStamp > record.pushedAt : false;
    const vaultChangedSincePush = !record || record.bodyHash !== bodyHash;

    if (!vaultChangedSincePush) continue;

    // 两边都动过 → 谁新听谁的
    if (appChangedSincePush && appStamp >= vaultStamp) {
      conflicts.push({ noteId, title: note.title, winner: 'app' });
      continue; // 保留应用版本，下一轮 push 会覆盖 vault
    }
    if (appChangedSincePush) {
      conflicts.push({ noteId, title: note.title, winner: 'vault' });
    }

    const meta = entry.parsed.meta || {};
    let body = stripInjected(entry.parsed.body);
    // AI 助教整理过的笔记会带一个与标题重复的一级标题，回流时去掉
    const heading = String(meta.title || note.title || '').trim();
    if (heading) {
      const firstLine = body.split(/\r?\n/, 1)[0] || '';
      if (firstLine.replace(/^#\s*/, '').trim() === heading) {
        body = body.slice(firstLine.length).replace(/^\r?\n+/, '');
      }
    }
    // 用户在 Obsidian 里可能用了旧定界符或 Unicode 运算符，回流前同样规范化，
    // 避免「vault 改一次 → 应用存一次 → 又推回去」的来回抖动。
    body = normalizeMath(body.trim()).text.trim();

    if (body === String(note.content || '').trim()) {
      state.notes[noteId] = {
        ...(record || {}),
        file: relativeFile(vaultDir, entry.absolute),
        bodyHash,
        fileMtimeMs: vaultStamp,
      };
      continue;
    }

    saveNote({
      id: noteId,
      title: String(meta.title || note.title || '未命名笔记'),
      content: body,
      tags: Array.isArray(meta.tags) ? meta.tags : note.tags,
      subjectId: note.subjectId || undefined,
      pinned: note.pinned,
      // meta 不传 → 保留应用侧原有的分类结果
    });

    state.notes[noteId] = {
      ...(record || {}),
      file: relativeFile(vaultDir, entry.absolute),
      bodyHash,
      fileMtimeMs: vaultStamp,
      pushedAt: Date.now(),
      // 应用侧已经变成 vault 的内容，hash 同步更新，避免下一轮又被推回去
      hash: null,
    };
    pulled.push({ noteId, title: meta.title || note.title });
  }

  state.lastRun = new Date().toISOString();
  saveState(vaultDir, state);
  return { pulled, conflicts, firstRun };
}

module.exports = {
  loadState,
  saveState,
  pushNotes,
  pullNotes,
  scanAppNoteFiles,
  listManagedNoteFiles,
  stripInjected,
  parseDbTime,
  noteFileName,
  noteDigest,
};
