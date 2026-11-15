'use strict';
/**
 * Obsidian 联动的总入口（Node 实现，不依赖 Python）。
 *
 * 之前的联动全部交给 obsidian/bridge.py：
 *   - 打包配置没把 obsidian/ 打进包，安装版必然报「联动套件不完整」；
 *   - vault 固定在代码目录，升级/卸载会连笔记一起丢掉；
 *   - 用户机器上没装 Python 就直接不可用。
 * 现在「笔记 ↔ Obsidian」这条主链路走 Node，Python 只留给收件箱识图整理这类可选增强。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const V = require('./vault');
const noteSync = require('./noteSync');
const mindmap = require('./mindmap');
const home = require('./home');

const PREF_VAULT = 'obsidian.vaultPath';
const PREF_AUTO = 'obsidian.autoSync';
const PREF_MIGRATED = 'obsidian.migratedFrom';

let runtime = null;

function attach(context) {
  runtime = context;
  return api;
}

function appPaths() {
  if (!runtime?.app) throw new Error('Obsidian 联动尚未初始化');
  return runtime.app;
}

function database() {
  if (!runtime?.database) throw new Error('数据库尚未就绪');
  return runtime.database;
}

/* --------------------------------------------------------------- 设置项 */

function readPref(key) {
  try {
    return database().getAppPreference(key)?.value ?? null;
  } catch {
    return null;
  }
}

function writePref(key, value) {
  try {
    database().setAppPreference(key, value ?? '');
    return true;
  } catch {
    return false;
  }
}

function defaultVaultDir() {
  return path.join(appPaths().getPath('userData'), 'obsidian-vault');
}

function legacyVaultCandidates() {
  const list = [];
  // 打包后：extraResources 会把 obsidian/ 放到 resources/obsidian
  if (process.resourcesPath) {
    list.push(path.join(process.resourcesPath, 'obsidian', 'vault'));
  }
  // 开发态：项目根目录
  list.push(path.resolve(__dirname, '..', '..', '..', 'obsidian', 'vault'));
  return [...new Set(list)];
}

function resolveVaultDir() {
  const configured = String(readPref(PREF_VAULT) || '').trim();
  if (configured) return path.resolve(configured.replace(/^~(?=$|[\\/])/, os.homedir()));
  return defaultVaultDir();
}

function autoSyncEnabled() {
  const value = readPref(PREF_AUTO);
  if (value === null) return true; // 默认开：用户要的就是「改了就能看到」
  return String(value) !== '0' && String(value).toLowerCase() !== 'false';
}

/* ------------------------------------------------------------ 首次迁移 */

/**
 * 首次运行时，把旧版放在代码目录里的 vault 搬到用户数据目录。
 * 只补缺失文件，不覆盖用户已经在新位置改过的内容。
 */
function migrateLegacyVault(vaultDir) {
  const already = String(readPref(PREF_MIGRATED) || '').trim();
  if (already) return { migrated: false, reason: 'done' };

  const legacy = legacyVaultCandidates().find((candidate) => {
    try {
      return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()
        && V.countMarkdown(candidate) > 0;
    } catch {
      return false;
    }
  });
  if (!legacy) return { migrated: false, reason: 'no-legacy' };

  const normalizedLegacy = path.resolve(legacy);
  const normalizedTarget = path.resolve(vaultDir);
  if (normalizedLegacy === normalizedTarget) {
    writePref(PREF_MIGRATED, normalizedLegacy);
    return { migrated: false, reason: 'same-path' };
  }

  const { copied, skipped } = V.mergeCopy(normalizedLegacy, normalizedTarget);
  writePref(PREF_MIGRATED, normalizedLegacy);
  return {
    migrated: copied.length > 0,
    from: normalizedLegacy,
    copied: copied.length,
    skipped: skipped.length,
  };
}

function ensureReady() {
  const vaultDir = resolveVaultDir();
  V.ensureVault(vaultDir);
  const migration = migrateLegacyVault(vaultDir);
  return { vaultDir, migration };
}

/* ------------------------------------------------------------- 数据读取 */

function listNotes() {
  const db = runtime?.database;
  if (!db?.getNotes) return [];
  const pageSize = 500;
  const collected = [];
  for (let offset = 0; offset < 20000; offset += pageSize) {
    let page;
    try {
      page = db.getNotes({ limit: pageSize, offset });
    } catch {
      break;
    }
    const items = Array.isArray(page?.items) ? page.items : [];
    collected.push(...items);
    if (items.length < pageSize) break;
  }
  return collected;
}

function listSubjects() {
  try {
    return runtime.subjectManager?.getSubjects?.() || [];
  } catch {
    return [];
  }
}

function saveNote(input) {
  return database().saveNote(input);
}

/* --------------------------------------------------------------- 流水线 */

function refresh(options = {}) {
  const { vaultDir, migration } = ensureReady();
  const notes = listNotes();
  const subjects = listSubjects();

  const result = { vaultDir, migration, steps: {} };

  // 先拉后推：把 Obsidian 里的改动收进来，再把合并后的结果写回去
  if (options.pull !== false) {
    result.steps.pull = noteSync.pullNotes({ vaultDir, notes, saveNote });
  }

  const freshNotes = options.pull === false ? notes : listNotes();
  if (options.push !== false) {
    result.steps.push = noteSync.pushNotes({ vaultDir, notes: freshNotes, subjects });
  }

  const state = noteSync.loadState(vaultDir);
  if (options.mindmap !== false) {
    result.steps.mindmap = mindmap.build({ vaultDir, notes: freshNotes, subjects, state });
  }
  result.steps.home = { file: home.writeHome({ vaultDir, notes: freshNotes, subjects, state }) };

  result.registration = V.registerVault(vaultDir);
  result.ok = true;
  result.at = new Date().toISOString();
  return result;
}

/** 只做推送（保存笔记后触发，快） */
function pushOnly() {
  const vaultDir = resolveVaultDir();
  V.ensureVault(vaultDir);
  const notes = listNotes();
  const subjects = listSubjects();
  const push = noteSync.pushNotes({ vaultDir, notes, subjects });
  return { vaultDir, push };
}

/* ------------------------------------------------- 单篇笔记定位 */

/**
 * 找到某篇应用笔记在 vault 里的镜像文件。
 * 打开前必须走一遍：state 里的记录可能被用户删了 / 改名了 / 笔记刚创建还没同步，
 * 所以按顺序「查 state → 扫 frontmatter → 立即推送后重查」兜三层。
 */
function resolveNoteFile(noteId) {
  const id = String(noteId || '').trim();
  if (!id) return { ok: false, error: '没有指定笔记' };

  const { vaultDir } = ensureReady();
  let state = noteSync.loadState(vaultDir);
  let rel = state.notes[id]?.file || null;

  // 应用里刚改过正文却还没到防抖时间：立刻推一次，保证 Obsidian 打开的是最新版。
  // 应用没变时绝不推送 —— 用户可能正在 Obsidian 里改这篇，推了会把他的改动覆盖掉。
  const current = listNotes().find((note) => String(note.id) === id);
  let synced = false;
  if (current && state.notes[id]?.hash !== noteSync.noteDigest(current)) {
    pushOnly();
    state = noteSync.loadState(vaultDir);
    rel = state.notes[id]?.file || null;
    synced = true;
  }

  const valid = (candidate) => {
    if (!candidate) return false;
    const absolute = path.join(vaultDir, ...String(candidate).split('/'));
    if (!fs.existsSync(absolute)) return false;
    try {
      const { meta } = require('./frontmatter').parse(fs.readFileSync(absolute, 'utf8'));
      return String(meta.app_note_id || '') === id;
    } catch {
      return false;
    }
  };

  if (!valid(rel)) {
    const found = noteSync.scanAppNoteFiles(vaultDir).get(id);
    if (found) rel = path.relative(vaultDir, found.absolute).split(path.sep).join('/');
  }
  if (!valid(rel)) {
    // 不等防抖，立即把最新正文写进 vault，避免 Obsidian 打开的是旧版本
    pushOnly();
    state = noteSync.loadState(vaultDir);
    rel = state.notes[id]?.file || null;
    synced = true;
  }
  if (!valid(rel)) {
    return { ok: false, error: '这篇笔记还没同步到 Obsidian，先保存或点一次同步再试', vaultDir };
  }

  const absolute = path.join(vaultDir, ...rel.split('/'));
  return {
    ok: true,
    vaultDir,
    file: rel,
    absolute,
    obsidianFile: rel.replace(/\.md$/, ''),
    synced,
  };
}

/* ------------------------------------------------------------ Python 探测 */

let pythonCache = null;

function detectPython() {
  if (pythonCache) return Promise.resolve(pythonCache);
  const candidates = process.platform === 'win32'
    ? [['py', ['-3', '--version']], ['python', ['--version']], ['python3', ['--version']]]
    : [['python3', ['--version']], ['python', ['--version']]];

  return new Promise((resolve) => {
    let index = 0;
    const next = () => {
      if (index >= candidates.length) {
        pythonCache = { available: false, reason: '未检测到 Python 3' };
        resolve(pythonCache);
        return;
      }
      const [command, args] = candidates[index];
      index += 1;
      execFile(command, args, { windowsHide: true, timeout: 8000 }, (error, stdout, stderr) => {
        const text = `${stdout || ''}${stderr || ''}`.trim();
        const match = /Python\s+(\d+)\.(\d+)/.exec(text);
        if (!error && match && Number(match[1]) >= 3) {
          pythonCache = {
            available: true,
            command,
            baseArgs: command === 'py' ? ['-3'] : [],
            version: `${match[1]}.${match[2]}`,
          };
          resolve(pythonCache);
          return;
        }
        next();
      });
    };
    next();
  });
}

/* ---------------------------------------------------------------- 状态 */

async function status() {
  const vaultDir = resolveVaultDir();
  const exists = fs.existsSync(vaultDir);
  const state = exists ? noteSync.loadState(vaultDir) : { notes: {}, lastRun: null };
  const notes = listNotes();
  const python = await detectPython();
  const installed = await require('../runtimeEnv.js').detectObsidian();

  return {
    ok: true,
    engine: 'node',
    vaultDir,
    vaultExists: exists,
    isDefaultPath: path.resolve(vaultDir) === path.resolve(defaultVaultDir()),
    registered: V.isVaultRegistered(vaultDir),
    autoSync: autoSyncEnabled(),
    noteCount: notes.length,
    syncedCount: Object.keys(state.notes || {}).length,
    markdownCount: exists ? V.countMarkdown(vaultDir) : 0,
    lastRun: state.lastRun,
    pending: notes.filter((note) => {
      const record = state.notes?.[String(note.id)];
      return !record || !fs.existsSync(path.join(vaultDir, ...String(record.file || '').split('/')));
    }).length,
    legacy: {
      candidates: legacyVaultCandidates().filter((p) => fs.existsSync(p)),
      migratedFrom: readPref(PREF_MIGRATED) || '',
    },
    installed,
    python,
  };
}

/* ------------------------------------------------------------ 自动同步 */

let pushTimer = null;
let pullTimer = null;

function schedulePush(delayMs = 1200) {
  if (!autoSyncEnabled()) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    try {
      pushOnly();
    } catch (error) {
      console.warn('[Obsidian] 自动推送失败:', error?.message || error);
    }
  }, delayMs);
  if (pushTimer.unref) pushTimer.unref();
}

function startAutoSync({ intervalMs = 45000 } = {}) {
  stopAutoSync();
  pullTimer = setInterval(() => {
    if (!autoSyncEnabled()) return;
    try {
      const vaultDir = resolveVaultDir();
      if (!fs.existsSync(vaultDir)) return;
      const result = noteSync.pullNotes({ vaultDir, notes: listNotes(), saveNote });
      if (result.pulled.length) {
        const notes = listNotes();
        const subjects = listSubjects();
        noteSync.pushNotes({ vaultDir, notes, subjects });
        mindmap.build({ vaultDir, notes, subjects, state: noteSync.loadState(vaultDir) });
        runtime?.onNotesPulled?.(result.pulled);
      }
    } catch (error) {
      console.warn('[Obsidian] 自动拉取失败:', error?.message || error);
    }
  }, intervalMs);
  if (pullTimer.unref) pullTimer.unref();
  return true;
}

function stopAutoSync() {
  if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
  if (pullTimer) { clearInterval(pullTimer); pullTimer = null; }
}

const api = {
  attach,
  status,
  refresh,
  pushOnly,
  schedulePush,
  startAutoSync,
  stopAutoSync,
  resolveVaultDir,
  resolveNoteFile,
  defaultVaultDir,
  isVaultRegistered: () => V.isVaultRegistered(resolveVaultDir()),
  vaultKey: () => V.vaultIdFor(resolveVaultDir()) || path.basename(resolveVaultDir()),
  ensureReady,
  autoSyncEnabled,
  setVaultDir(dir) {
    const next = String(dir || '').trim();
    writePref(PREF_VAULT, next ? path.resolve(next) : '');
    return resolveVaultDir();
  },
  setAutoSync(enabled) {
    writePref(PREF_AUTO, enabled ? '1' : '0');
    if (enabled) startAutoSync();
    else stopAutoSync();
    return autoSyncEnabled();
  },
  registerVault() {
    return V.registerVault(resolveVaultDir());
  },
  detectPython,
};

module.exports = api;
