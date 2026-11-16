const { app, protocol, net } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const noteAssets = require('./noteAssets.js');
const wrongAssets = require('./wrongAssets.js');

const ASSET_SCHEME = 'openexam-asset';
const ASSET_HOST = 'question-assets';
// 用户补答案的图片统一放在 question-assets/answers/<题目目录>/ 下
const ANSWER_DIR = 'answers';
const MAX_ANSWER_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_ANSWER_IMAGES = 20;
const ANSWER_IMAGE_MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
};

function getAssetRoots() {
  const roots = [];
  try {
    roots.push(path.join(app.getPath('userData'), 'question-assets'));
  } catch (_) {}
  if (process.resourcesPath) roots.push(path.join(process.resourcesPath, 'question-assets'));
  roots.push(path.join(__dirname, '..', '..', 'data', 'question-assets'));
  return roots;
}

function normalizeRelativePath(input = '') {
  // 反斜杠在 Windows 上会被 path.join 当成目录分隔符，
  // 必须先统一成正斜杠再做 posix normalize，否则 `..\\..\\x` 可以逃出资源根目录。
  const value = String(input || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!value || value.includes('\0')) return '';
  const normalized = path.posix.normalize(value);
  if (!normalized || normalized === '.' || normalized === '..') return '';
  if (normalized.startsWith('../')) return '';
  if (path.posix.isAbsolute(normalized) || /^[a-z]:/i.test(normalized)) return '';
  return normalized;
}

const FALLBACK_EXTENSIONS = ['.webp', '.png', '.jpg', '.jpeg', '.gif', '.svg'];

function resolveAssetPath(relativePath = '') {
  const safeRelativePath = normalizeRelativePath(relativePath);
  if (!safeRelativePath) return '';

  const parsed = path.posix.parse(safeRelativePath);
  const fallbackCandidates = parsed.ext
    ? FALLBACK_EXTENSIONS.map((ext) => path.join(parsed.dir, `${parsed.name}${ext}`)).filter(Boolean)
    : [];

  for (const root of getAssetRoots()) {
    const rootResolved = path.resolve(root);
    const isInsideRoot = (candidate) => {
      const resolved = path.resolve(candidate);
      return resolved === rootResolved || resolved.startsWith(`${rootResolved}${path.sep}`);
    };

    const exact = path.join(root, safeRelativePath);
    if (isInsideRoot(exact) && fs.existsSync(exact) && fs.statSync(exact).isFile()) {
      return exact;
    }
    for (const fallbackRelativePath of fallbackCandidates) {
      const candidate = path.join(root, fallbackRelativePath);
      if (isInsideRoot(candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }
  }
  return '';
}

function toAssetUrl(relativePath = '') {
  const safeRelativePath = normalizeRelativePath(relativePath);
  if (!safeRelativePath) return '';
  return `${ASSET_SCHEME}://${ASSET_HOST}/${safeRelativePath}`;
}

/** 题目 ID 可能来自历史备份，不能直接当目录名；不合规时用哈希兜底，保证同一道题目录稳定 */
function questionAnswerKey(questionId = '') {
  const value = String(questionId || '').trim();
  if (!value) return '';
  if (/^[A-Za-z0-9_-]{1,80}$/.test(value)) return value;
  return `h_${crypto.createHash('sha1').update(value).digest('hex').slice(0, 32)}`;
}

function writableAssetRoot() {
  return path.join(app.getPath('userData'), 'question-assets');
}

function questionAnswerRelativeDir(questionId = '') {
  const key = questionAnswerKey(questionId);
  if (!key) return '';
  return `${ANSWER_DIR}/${key}`;
}

function parseAnswerImageDataUrl(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(dataUrl || ''));
  if (!match) return null;
  const mime = (match[1] || 'image/png').toLowerCase();
  const ext = ANSWER_IMAGE_MIME_EXT[mime];
  if (!ext) return null;
  const buffer = match[2]
    ? Buffer.from(match[3], 'base64')
    : Buffer.from(decodeURIComponent(match[3]), 'utf8');
  return { ext, buffer };
}

/**
 * 保存一张题目答案图片。
 * @param {{ questionId: string, dataUrl: string, name?: string }} input
 * @returns {{ success: boolean, error?: string, url?: string, relativePath?: string, file?: string, size?: number }}
 */
function saveAnswerImage(input = {}) {
  const relativeDir = questionAnswerRelativeDir(input.questionId);
  if (!relativeDir) return { success: false, error: '题目 ID 不合法' };

  const parsed = parseAnswerImageDataUrl(input.dataUrl);
  if (!parsed) return { success: false, error: '只支持 PNG / JPG / WebP / GIF / BMP 图片' };
  if (!parsed.buffer.length) return { success: false, error: '图片内容为空' };
  if (parsed.buffer.length > MAX_ANSWER_IMAGE_BYTES) {
    return { success: false, error: `图片超过 ${Math.round(MAX_ANSWER_IMAGE_BYTES / 1024 / 1024)}MB，先压缩再传` };
  }

  try {
    const dir = path.join(writableAssetRoot(), relativeDir);
    fs.mkdirSync(dir, { recursive: true });
    const existing = fs.readdirSync(dir).filter((name) => /\.(png|jpg|jpeg|webp|gif|bmp)$/i.test(name));
    if (existing.length >= MAX_ANSWER_IMAGES) {
      return { success: false, error: `每道题最多 ${MAX_ANSWER_IMAGES} 张答案图片` };
    }
    const stamp = Date.now().toString(36);
    const rand = crypto.randomBytes(3).toString('hex');
    const fileName = `${stamp}-${rand}.${parsed.ext}`;
    fs.writeFileSync(path.join(dir, fileName), parsed.buffer);
    const relativePath = `${relativeDir}/${fileName}`;
    return {
      success: true,
      url: toAssetUrl(relativePath),
      relativePath,
      file: fileName,
      size: parsed.buffer.length,
    };
  } catch (error) {
    return { success: false, error: `写入图片失败：${error.message}` };
  }
}

/** 从 openexam-asset URL 或相对路径里取出 answers/ 下的合法相对路径 */
function answerImageRelativePath(value = '') {
  let raw = String(value || '').trim();
  const prefix = `${ASSET_SCHEME}://${ASSET_HOST}/`;
  if (raw.startsWith(prefix)) raw = raw.slice(prefix.length);
  const relative = normalizeRelativePath(raw);
  if (!relative || !relative.startsWith(`${ANSWER_DIR}/`)) return '';
  return relative;
}

function removeAnswerImage(value = '') {
  const relative = answerImageRelativePath(value);
  if (!relative) return { success: false, error: '不是有效的答案图片地址' };
  const target = resolveAssetPath(relative);
  if (!target) return { success: false, error: '图片文件不存在' };
  try {
    fs.unlinkSync(target);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function removeQuestionAnswerAssets(questionId = '') {
  const relativeDir = questionAnswerRelativeDir(questionId);
  if (!relativeDir) return { success: false };
  const dir = path.join(writableAssetRoot(), relativeDir);
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function parseAssetRequest(requestUrl = '') {
  try {
    const url = new URL(requestUrl);
    if (url.protocol !== `${ASSET_SCHEME}:`) return '';
    if (url.host !== ASSET_HOST) return '';
    return normalizeRelativePath(decodeURIComponent(url.pathname || ''));
  } catch (_) {
    return '';
  }
}

function registerProtocol() {
  protocol.handle(ASSET_SCHEME, (request) => {
    // 笔记图片走同一个 scheme，用 host 区分（note-assets/<noteId>/<file>）
    let host = '';
    let pathname = '';
    try {
      const url = new URL(request.url);
      host = url.host;
      pathname = url.pathname || '';
    } catch (_) {
      return new Response('Bad Request', { status: 400 });
    }

    if (host === noteAssets.NOTE_HOST) {
      let relative = '';
      try {
        relative = decodeURIComponent(pathname).replace(/^\/+/, '');
      } catch (_) {
        return new Response('Bad Request', { status: 400 });
      }
      const notePath = noteAssets.resolveNoteAssetPath(relative);
      if (!notePath || !fs.existsSync(notePath)) {
        return new Response('Asset Not Found', { status: 404 });
      }
      return net.fetch(pathToFileURL(notePath).href);
    }

    // 错题图片（wrong-assets/<wrongId>/<file>）
    if (host === wrongAssets.WRONG_HOST) {
      let relative = '';
      try {
        relative = decodeURIComponent(pathname).replace(/^\/+/, '');
      } catch (_) {
        return new Response('Bad Request', { status: 400 });
      }
      const wrongPath = wrongAssets.resolveWrongAssetPath(relative);
      if (!wrongPath || !fs.existsSync(wrongPath)) {
        return new Response('Asset Not Found', { status: 404 });
      }
      return net.fetch(pathToFileURL(wrongPath).href);
    }

    const relativePath = parseAssetRequest(request.url);
    const filePath = resolveAssetPath(relativePath);
    if (!filePath) {
      return new Response('Asset Not Found', { status: 404 });
    }
    return net.fetch(pathToFileURL(filePath).href);
  });
}

module.exports = {
  ASSET_SCHEME,
  ASSET_HOST,
  ANSWER_DIR,
  getAssetRoots,
  parseAssetRequest,
  registerProtocol,
  resolveAssetPath,
  toAssetUrl,
  questionAnswerKey,
  saveAnswerImage,
  removeAnswerImage,
  removeQuestionAnswerAssets,
};
