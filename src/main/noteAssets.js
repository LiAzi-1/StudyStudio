/**
 * 笔记图片存储
 *
 * 图片放在 `userData/note-assets/<noteId>/` 下，正文里用
 * `![说明](openexam-asset://note-assets/<noteId>/<文件名>)` 引用。
 *
 * 复用 questionAssets 已经注册的 `openexam-asset://` 协议，按 host 分流，
 * 这样渲染层不用为图片再开一套 scheme。
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NOTE_HOST = 'note-assets';
const MAX_BYTES = 12 * 1024 * 1024;

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
};

function noteRoot() {
  return path.join(app.getPath('userData'), 'note-assets');
}

/** 笔记 ID 只允许字母数字和 - _，避免目录穿越 */
function safeNoteId(noteId) {
  const value = String(noteId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) return '';
  return value;
}

function noteDir(noteId) {
  const safe = safeNoteId(noteId);
  if (!safe) throw new Error('笔记 ID 不合法');
  return path.join(noteRoot(), safe);
}

/** 解析 note-assets 请求的相对路径，必须落在 noteRoot 内 */
function resolveNoteAssetPath(relativePath = '') {
  const value = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!value || value.includes('\0')) return '';
  const normalized = path.posix.normalize(value);
  if (!normalized || normalized === '.' || normalized.startsWith('../')) return '';
  if (path.posix.isAbsolute(normalized) || /^[a-z]:/i.test(normalized)) return '';

  const root = path.resolve(noteRoot());
  const target = path.resolve(root, normalized);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return '';
  return target;
}

function toNoteAssetUrl(noteId, fileName) {
  const safe = safeNoteId(noteId);
  if (!safe || !fileName) return '';
  return `openexam-asset://${NOTE_HOST}/${safe}/${encodeURIComponent(fileName)}`;
}

function parseDataUrl(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(dataUrl || ''));
  if (!match) return null;
  const mime = (match[1] || 'image/png').toLowerCase();
  const isBase64 = !!match[2];
  if (!MIME_EXT[mime]) return null;
  const buffer = isBase64
    ? Buffer.from(match[3], 'base64')
    : Buffer.from(decodeURIComponent(match[3]), 'utf8');
  return { mime, ext: MIME_EXT[mime], buffer };
}

/**
 * 保存一张图片。
 * @param {{ noteId: string, dataUrl: string, name?: string }} input
 * @returns {{ success: boolean, error?: string, url?: string, file?: string, size?: number }}
 */
function saveImage(input = {}) {
  const safe = safeNoteId(input.noteId);
  if (!safe) return { success: false, error: '缺少笔记 ID，先保存一次笔记再插图' };

  const parsed = parseDataUrl(input.dataUrl);
  if (!parsed) return { success: false, error: '只支持 PNG / JPG / WebP / GIF / BMP 图片' };
  if (!parsed.buffer.length) return { success: false, error: '图片内容为空' };
  if (parsed.buffer.length > MAX_BYTES) {
    return { success: false, error: `图片超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB，先压缩再传` };
  }

  try {
    const dir = noteDir(safe);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = Date.now().toString(36);
    const rand = crypto.randomBytes(3).toString('hex');
    const fileName = `${stamp}-${rand}.${parsed.ext}`;
    fs.writeFileSync(path.join(dir, fileName), parsed.buffer);
    return {
      success: true,
      url: toNoteAssetUrl(safe, fileName),
      file: fileName,
      size: parsed.buffer.length,
    };
  } catch (error) {
    return { success: false, error: `写入图片失败：${error.message}` };
  }
}

/** 删单张图（缩略图上的 × 按钮） */
function removeImage({ noteId, file } = {}) {
  const safe = safeNoteId(noteId);
  const name = path.basename(String(file || ''));
  if (!safe || !name || name === '.' || name === '..') return { success: false };
  const target = resolveNoteAssetPath(`${safe}/${name}`);
  if (!target) return { success: false };
  try {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/** 删除整篇笔记时清掉它的图片目录 */
function removeNoteAssets(noteId) {
  const safe = safeNoteId(noteId);
  if (!safe) return { success: false };
  const dir = path.join(noteRoot(), safe);
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    return { success: true };
  } catch (error) {
    console.warn('清理笔记图片失败:', error.message);
    return { success: false, error: error.message };
  }
}

module.exports = {
  NOTE_HOST,
  noteRoot,
  noteDir,
  resolveNoteAssetPath,
  toNoteAssetUrl,
  saveImage,
  removeImage,
  removeNoteAssets,
};
