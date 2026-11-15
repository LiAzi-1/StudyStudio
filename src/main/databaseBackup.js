'use strict';
/**
 * 本地数据库自动备份（WP-07）
 *
 * 与 dataBackup.js 的 JSON 导出不同，这里直接备份 SQLite 主库：
 *   - 用 better-sqlite3 的在线备份 API（SQLite Online Backup），WAL 中尚未合并的
 *     数据也会进入快照，不需要停写、也不会锁库；
 *   - 备份落在 userData/backups，文件名带本地时间戳与类型（auto / manual）；
 *   - 按「最多 10 份 + 总计不超过 1GB」轮转，超限从最旧的开始淘汰；
 *   - 恢复前先只读打开做 integrity_check 并确认是 OpenExam 的库，坏文件直接拒绝；
 *   - 不新增依赖、不改任何表结构。
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const Database = require('better-sqlite3');

const BACKUP_DIR_NAME = 'backups';
const MAX_COUNT = 10;
const MAX_BYTES = 1024 * 1024 * 1024; // 1 GB
const DB_FILE_NAME = 'openexam.db';
const NAME_PATTERN = /^openexam-(auto|manual)-(\d{8})-(\d{6})-(\d{3})\.db$/;

let backupInFlight = false;

function backupDirectory() {
  return path.join(app.getPath('userData'), BACKUP_DIR_NAME);
}

function databasePath() {
  return path.join(app.getPath('userData'), DB_FILE_NAME);
}

function ensureDirectory() {
  const dir = backupDirectory();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function pad(value, length = 2) {
  return String(value).padStart(length, '0');
}

/** 本地时间戳，避免 UTC 导致「今天」判断错位 */
function stampOf(date = new Date()) {
  const d = date;
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
}

function dayKeyOf(date = new Date()) {
  const d = date;
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function parseBackupName(name) {
  const match = String(name || '').match(NAME_PATTERN);
  if (!match) return null;
  const [, kind, day, time, ms] = match;
  const iso = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}.${ms}`;
  return { kind, day, time, ms, sortKey: `${day}${time}${ms}`, localIso: iso };
}

/** 只允许 backups 目录下的合法备份名，避免路径穿越 */
function resolveBackupPath(name) {
  const base = path.basename(String(name || ''));
  if (base !== String(name || '') || !NAME_PATTERN.test(base)) {
    throw new Error('备份文件名不合法');
  }
  const full = path.join(backupDirectory(), base);
  if (path.dirname(full) !== backupDirectory()) throw new Error('备份路径不合法');
  return full;
}

function listBackups() {
  const dir = backupDirectory();
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    entries = [];
  }

  const backups = entries
    .filter((name) => NAME_PATTERN.test(name))
    .map((name) => {
      const fullPath = path.join(dir, name);
      let stat = null;
      try { stat = fs.statSync(fullPath); } catch (_) { return null; }
      const parsed = parseBackupName(name);
      return {
        name,
        size: stat.size,
        createdAt: stat.mtime.toISOString(),
        kind: parsed?.kind || 'manual',
        day: parsed?.day || '',
        sortKey: parsed?.sortKey || '',
      };
    })
    .filter(Boolean)
    // 按时间戳而不是完整文件名排序：auto/manual 前缀不同，按名字排会把自动备份误当成最旧
    .sort((a, b) => b.sortKey.localeCompare(a.sortKey) || b.name.localeCompare(a.name));

  const totalBytes = backups.reduce((sum, item) => sum + item.size, 0);
  return {
    success: true,
    directory: dir,
    backups: backups.map(({ sortKey, ...item }) => item),
    count: backups.length,
    totalBytes,
    limits: { maxCount: MAX_COUNT, maxBytes: MAX_BYTES },
  };
}

/** 轮转：超出数量或总大小就从最旧的开始删；至少保留最新一份 */
function pruneBackups(keepName) {
  const state = listBackups();
  const backups = [...state.backups];
  let total = state.totalBytes;
  const removed = [];

  const canRemove = (item) => item.name !== keepName && backups.length > 1;

  // 先按数量淘汰
  while (backups.length > MAX_COUNT) {
    const oldest = backups[backups.length - 1];
    if (!canRemove(oldest)) break;
    backups.pop();
    total -= oldest.size;
    removed.push(oldest.name);
    try { fs.rmSync(path.join(state.directory, oldest.name), { force: true }); } catch (_) { /* 忽略单个文件删除失败 */ }
  }

  // 再按总大小淘汰
  while (total > MAX_BYTES && backups.length > 1) {
    const oldest = backups[backups.length - 1];
    if (!canRemove(oldest)) break;
    backups.pop();
    total -= oldest.size;
    removed.push(oldest.name);
    try { fs.rmSync(path.join(state.directory, oldest.name), { force: true }); } catch (_) { /* 忽略单个文件删除失败 */ }
  }

  return removed;
}

async function createBackup(db, kind = 'manual') {
  if (!db) throw new Error('数据库尚未初始化，无法备份');
  if (backupInFlight) return { success: false, error: '已有备份任务在进行中' };

  const safeKind = kind === 'auto' ? 'auto' : 'manual';
  backupInFlight = true;
  try {
    ensureDirectory();
    const name = `openexam-${safeKind}-${stampOf()}.db`;
    const target = path.join(backupDirectory(), name);

    // SQLite Online Backup：一致性快照，包含 WAL 中尚未 checkpoint 的数据
    await db.backup(target);

    let size = 0;
    try { size = fs.statSync(target).size; } catch (_) { size = 0; }
    if (!size) throw new Error('备份文件为空，备份失败');

    pruneBackups(name);
    const state = listBackups();
    return {
      success: true,
      backup: state.backups.find((item) => item.name === name) || { name, size, kind: safeKind },
      ...state,
    };
  } finally {
    backupInFlight = false;
  }
}

/** 启动/定时检查：本地自然日只自动备份一次，已有当天备份就跳过 */
async function maybeAutoBackup(db) {
  if (!db) return { success: false, skipped: true, error: '数据库尚未初始化' };
  const state = listBackups();
  const today = dayKeyOf();
  const latestAuto = state.backups.find((item) => item.kind === 'auto');
  if (latestAuto && latestAuto.day === today) {
    return { success: true, skipped: true, reason: '今天已自动备份', backup: latestAuto, ...state };
  }
  return createBackup(db, 'auto');
}

/**
 * 只读校验备份：完整性检查 + 确认是 OpenExam 数据库。
 * 返回 { success, size, createdAt, counts } 或 { success:false, error }
 */
function validateBackup(name) {
  let filePath = '';
  try {
    filePath = resolveBackupPath(name);
  } catch (error) {
    return { success: false, error: error.message };
  }

  if (!fs.existsSync(filePath)) return { success: false, error: '备份文件不存在' };

  let conn = null;
  try {
    conn = new Database(filePath, { readonly: true, fileMustExist: true });
    const integrity = conn.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      return { success: false, error: `备份完整性检查失败：${String(integrity).slice(0, 120)}` };
    }
    const tableNames = conn
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    if (!tableNames.includes('papers') || !tableNames.includes('questions')) {
      return { success: false, error: '该文件不是有效的 OpenExam 数据库备份' };
    }
    const counts = {
      papers: conn.prepare('SELECT COUNT(*) AS n FROM papers').get()?.n || 0,
      questions: conn.prepare('SELECT COUNT(*) AS n FROM questions').get()?.n || 0,
    };
    const stat = fs.statSync(filePath);
    return {
      success: true,
      name,
      size: stat.size,
      createdAt: stat.mtime.toISOString(),
      counts,
    };
  } catch (error) {
    return { success: false, error: `无法打开备份文件：${error?.message || error}` };
  } finally {
    try { conn?.close(); } catch (_) { /* 忽略关闭失败 */ }
  }
}

/**
 * 用备份替换当前主库。调用方必须先 closeDatabase()。
 * 复制到临时文件再原子改名，失败时尽量把旧库换回来。
 */
function replaceDatabaseWithBackup(name) {
  const backupPath = resolveBackupPath(name);
  const dbPath = databasePath();
  const tmpPath = `${dbPath}.restore-tmp`;
  const oldPath = `${dbPath}.restore-old`;

  fs.copyFileSync(backupPath, tmpPath);
  // 旧 WAL/SHM 属于旧库，必须在换库前删除，否则会被误应用到新库
  for (const suffix of ['-wal', '-shm']) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }

  let movedOld = false;
  if (fs.existsSync(dbPath)) {
    fs.renameSync(dbPath, oldPath);
    movedOld = true;
  }

  try {
    fs.renameSync(tmpPath, dbPath);
  } catch (error) {
    if (movedOld) {
      try { fs.renameSync(oldPath, dbPath); } catch (_) { /* 回滚失败时保留 restore-old 供人工处理 */ }
    }
    throw error;
  }

  fs.rmSync(oldPath, { force: true });
  fs.rmSync(tmpPath, { force: true });
  return { path: dbPath, backup: backupPath };
}

module.exports = {
  BACKUP_DIR_NAME,
  MAX_COUNT,
  MAX_BYTES,
  backupDirectory,
  listBackups,
  createBackup,
  maybeAutoBackup,
  validateBackup,
  replaceDatabaseWithBackup,
};
