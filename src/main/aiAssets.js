'use strict';
/**
 * AI 会话图片存储：按会话放在 userData/ai-assets/<sessionId>/。
 *
 * 不把 base64 写进 SQLite：单张截图几百 KB，历史会话很快就会把库撑大。
 * 每个会话最多保留 200 张，超出按修改时间删最旧的；删除会话时整目录清理。
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const MAX_PER_SESSION = 200;

function rootDir() {
  return path.join(app.getPath('userData'), 'ai-assets');
}

function safeId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96) || 'session';
}

function sessionDir(sessionId) {
  return path.join(rootDir(), safeId(sessionId));
}

function listFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const full = path.join(dir, entry.name);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch { /* 忽略 */ }
        return { full, name: entry.name, mtime, size: safeSize(full) };
      });
  } catch {
    return [];
  }
}

function safeSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function prune(sessionId, keep = MAX_PER_SESSION) {
  const dir = sessionDir(sessionId);
  const files = listFiles(dir).sort((a, b) => b.mtime - a.mtime);
  files.slice(keep).forEach((file) => {
    try { fs.rmSync(file.full, { force: true }); } catch { /* 忽略 */ }
  });
}

/** 保存一轮消息里的图片，返回可存进消息 meta 的相对路径 */
function saveImages({ sessionId, messageId, images = [] } = {}) {
  if (!sessionId) return { success: false, error: 'sessionId 不能为空', images: [] };
  const dir = sessionDir(sessionId);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (error) {
    return { success: false, error: `创建图片目录失败：${error.message}`, images: [] };
  }

  const saved = [];
  (Array.isArray(images) ? images : []).forEach((image, index) => {
    const raw = String(image?.dataUrl || image?.base64 || '');
    const match = /^data:([^;]+);base64,(.+)$/s.exec(raw);
    const mimeType = String(image?.mimeType || match?.[1] || 'image/png');
    const base64 = match ? match[2] : raw.replace(/^data:[^;]+;base64,/, '');
    if (!base64) return;
    const ext = mimeType.includes('jpeg') ? 'jpg'
      : mimeType.includes('webp') ? 'webp'
        : mimeType.includes('gif') ? 'gif'
          : 'png';
    const name = `${safeId(messageId || 'msg')}-${index}.${ext}`;
    try {
      fs.writeFileSync(path.join(dir, name), Buffer.from(base64, 'base64'));
      const relative = path.relative(app.getPath('userData'), path.join(dir, name)).split(path.sep).join('/');
      saved.push({ path: relative, mimeType });
    } catch { /* 单张失败不影响其余 */ }
  });

  prune(sessionId);
  return { success: true, images: saved };
}

/** 读回图片给渲染层显示（dataUrl） */
function readImage(relativePath) {
  const raw = String(relativePath || '');
  if (!raw) return { success: false, error: '路径为空' };
  const absolute = path.resolve(app.getPath('userData'), raw);
  const base = path.resolve(rootDir());
  if (!absolute.startsWith(base + path.sep)) return { success: false, error: '路径不合法' };
  try {
    const buffer = fs.readFileSync(absolute);
    const ext = path.extname(absolute).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
      : ext === '.webp' ? 'image/webp'
        : ext === '.gif' ? 'image/gif' : 'image/png';
    return { success: true, dataUrl: `data:${mime};base64,${buffer.toString('base64')}` };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function stats(sessionId) {
  const dir = sessionDir(sessionId);
  const files = listFiles(dir);
  return {
    count: files.length,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
    limit: MAX_PER_SESSION,
  };
}

function cleanupSession(sessionId) {
  try {
    fs.rmSync(sessionDir(sessionId), { recursive: true, force: true });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/** 清理入口：把所有会话裁到 keep 张 */
function cleanupAll(keep = MAX_PER_SESSION) {
  let sessions = [];
  try {
    sessions = fs.readdirSync(rootDir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch { /* 没有目录也算成功 */ }
  sessions.forEach((sessionId) => prune(sessionId, keep));
  return { success: true, sessions: sessions.length };
}

module.exports = { saveImages, readImage, stats, cleanupSession, cleanupAll, MAX_PER_SESSION };
