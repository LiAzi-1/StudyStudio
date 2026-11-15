/**
 * 错题图片存储
 *
 * 图片放在 `userData/wrong-assets/<wrongId>/` 下，错题快照里用
 * `openexam-asset://wrong-assets/<wrongId>/<文件名>` 引用。
 *
 * 复用 questionAssets 已经注册的 `openexam-asset://` 协议，按 host 分流，
 * 渲染层不用为错题图片再开一套 scheme。
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WRONG_HOST = 'wrong-assets';
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_IMAGES_PER_QUESTION = 12;

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
};

function wrongRoot() {
  return path.join(app.getPath('userData'), 'wrong-assets');
}

/** 错题 ID 只允许字母数字和 - _，避免目录穿越 */
function safeWrongId(wrongId) {
  const value = String(wrongId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) return '';
  return value;
}

function wrongDir(wrongId) {
  const safe = safeWrongId(wrongId);
  if (!safe) throw new Error('错题 ID 不合法');
  return path.join(wrongRoot(), safe);
}

/** 解析 wrong-assets 请求的相对路径，必须落在 wrongRoot 内 */
function resolveWrongAssetPath(relativePath = '') {
  const value = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!value || value.includes('\0')) return '';
  const normalized = path.posix.normalize(value);
  if (!normalized || normalized === '.' || normalized.startsWith('../')) return '';
  if (path.posix.isAbsolute(normalized) || /^[a-z]:/i.test(normalized)) return '';

  const root = path.resolve(wrongRoot());
  const target = path.resolve(root, normalized);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return '';
  return target;
}

function toWrongAssetUrl(wrongId, fileName) {
  const safe = safeWrongId(wrongId);
  if (!safe || !fileName) return '';
  return `openexam-asset://${WRONG_HOST}/${safe}/${encodeURIComponent(fileName)}`;
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
 * 保存一张错题图片。
 * @param {{ wrongId: string, dataUrl: string, name?: string }} input
 * @returns {{ success: boolean, error?: string, url?: string, file?: string, size?: number }}
 */
function saveImage(input = {}) {
  const safe = safeWrongId(input.wrongId);
  if (!safe) return { success: false, error: '错题 ID 不合法' };

  const parsed = parseDataUrl(input.dataUrl);
  if (!parsed) return { success: false, error: '只支持 PNG / JPG / WebP / GIF / BMP 图片' };
  if (!parsed.buffer.length) return { success: false, error: '图片内容为空' };
  if (parsed.buffer.length > MAX_BYTES) {
    return { success: false, error: `图片超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB，先压缩再传` };
  }

  try {
    const dir = wrongDir(safe);
    fs.mkdirSync(dir, { recursive: true });
    const existing = fs.readdirSync(dir).filter((name) => /\.(png|jpg|webp|gif|bmp)$/i.test(name));
    if (existing.length >= MAX_IMAGES_PER_QUESTION) {
      return { success: false, error: `每道错题最多 ${MAX_IMAGES_PER_QUESTION} 张图片` };
    }
    const stamp = Date.now().toString(36);
    const rand = crypto.randomBytes(3).toString('hex');
    const fileName = `${stamp}-${rand}.${parsed.ext}`;
    fs.writeFileSync(path.join(dir, fileName), parsed.buffer);
    return {
      success: true,
      url: toWrongAssetUrl(safe, fileName),
      file: fileName,
      size: parsed.buffer.length,
    };
  } catch (error) {
    return { success: false, error: `写入图片失败：${error.message}` };
  }
}

/** 删单张图（缩略图上的 × 按钮） */
function removeImage({ wrongId, file } = {}) {
  const safe = safeWrongId(wrongId);
  const name = path.basename(String(file || ''));
  if (!safe || !name || name === '.' || name === '..') return { success: false };
  const target = resolveWrongAssetPath(`${safe}/${name}`);
  if (!target) return { success: false };
  try {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/** 删除错题（或重置数据）时清掉它的图片目录 */
function removeWrongAssets(wrongId) {
  const safe = safeWrongId(wrongId);
  if (!safe) return { success: false };
  const dir = path.join(wrongRoot(), safe);
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    return { success: true };
  } catch (error) {
    console.warn('清理错题图片失败:', error.message);
    return { success: false, error: error.message };
  }
}

module.exports = {
  WRONG_HOST,
  wrongRoot,
  wrongDir,
  resolveWrongAssetPath,
  toWrongAssetUrl,
  saveImage,
  removeImage,
  removeWrongAssets,
};
