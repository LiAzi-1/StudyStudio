const { app, protocol, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const noteAssets = require('./noteAssets.js');
const wrongAssets = require('./wrongAssets.js');

const ASSET_SCHEME = 'openexam-asset';
const ASSET_HOST = 'question-assets';

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
  getAssetRoots,
  parseAssetRequest,
  registerProtocol,
  resolveAssetPath,
  toAssetUrl,
};
