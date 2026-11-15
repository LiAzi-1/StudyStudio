'use strict';
/**
 * 科目资料管理：主教材（权威）＋ 补充资料（辅助）。
 *
 * 设计借鉴 AnythingLLM 的 workspace / pinned document 思路：
 *   - 主教材 = pinned，权威来源，知识点定义与范围以它为准；
 *   - 补充资料 = 按需检索，用于补充例题、不同讲法与拓展，不得覆盖主教材。
 * 不引入向量库 / 服务端：索引是一个 JSON 文件，正文是科目目录下的 Markdown。
 *
 * 落盘结构（与现有 教材/、对话/、科目档案.md 平级）：
 *   subjects/<id>/资料/资料清单.json
 *   subjects/<id>/资料/文件/<材料ID>.<原扩展名>     原始文件
 *   subjects/<id>/资料/转写/<材料ID>.md             转写后的可读正文
 *
 * 主教材不在这里复制一份：仍然沿用 subjects 表的 textbook_* 字段与 教材/教材全文.md，
 * 资料清单里的 primary 只是实时同步出来的视图，避免两份数据不一致。
 */

const fs = require('fs');
const path = require('path');
const subjectManager = require('./subjectManager.js');

const MATERIAL_DIR = '资料';
const INDEX_FILE = '资料清单.json';
const FILES_DIR = '文件';
const TEXT_DIR = '转写';
const TEXT_EXT = new Set(['.md', '.txt', '.markdown']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const SUPPLEMENTARY_EXT = new Set([...TEXT_EXT, '.pdf', '.pptx', ...IMAGE_EXT]);

function materialDir(subjectId) {
  const root = subjectManager.getSubjectDir(subjectId);
  if (!root) throw new Error('科目不存在');
  const dir = path.join(root, MATERIAL_DIR);
  fs.mkdirSync(path.join(dir, FILES_DIR), { recursive: true });
  fs.mkdirSync(path.join(dir, TEXT_DIR), { recursive: true });
  return dir;
}

function indexPath(subjectId) {
  return path.join(materialDir(subjectId), INDEX_FILE);
}

function emptyIndex() {
  return { version: 1, primary: null, supplementary: [], updatedAt: null };
}

/** 主教材视图：以 subjects 表为准，避免与资料清单里的快照不一致 */
function primaryView(subjectId) {
  const subject = subjectManager.getSubject(subjectId);
  if (!subject) return null;
  const root = subjectManager.getSubjectDir(subjectId);
  const fullText = path.join(root, '教材', '教材全文.md');
  const exists = fs.existsSync(fullText);
  let chars = 0;
  if (exists) {
    try { chars = fs.statSync(fullText).size; } catch { /* 忽略 */ }
  }
  return {
    name: subject.textbookName || null,
    status: subject.textbookStatus || 'none',
    pages: Number(subject.textbookPages) || 0,
    fullText: exists ? path.join('教材', '教材全文.md') : null,
    chars,
  };
}

function readIndex(subjectId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath(subjectId), 'utf8'));
    return {
      version: 1,
      primary: parsed.primary || null,
      supplementary: Array.isArray(parsed.supplementary) ? parsed.supplementary : [],
      updatedAt: parsed.updatedAt || null,
    };
  } catch {
    return emptyIndex();
  }
}

function writeIndex(subjectId, next) {
  const payload = {
    ...next,
    version: 1,
    primary: primaryView(subjectId),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(indexPath(subjectId), JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function listMaterials(subjectId) {
  const index = readIndex(subjectId);
  return {
    ...index,
    primary: primaryView(subjectId),
    supplementary: index.supplementary.map((item) => ({
      ...item,
      // 转写文件可能已被手工删除，实时反映
      hasText: Boolean(item.textPath) && fs.existsSync(path.join(subjectManager.getSubjectDir(subjectId), item.textPath)),
    })),
  };
}

function newId() {
  return `mat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 添加补充资料。PDF / PPTX / 图片只登记为 pending（由调用方异步解析）；
 * Markdown / TXT 直接落成可读正文，立即可被 Skill 使用。
 */
function addSupplementary({ subjectId, filePath, name } = {}) {
  const subject = subjectManager.getSubject(subjectId);
  if (!subject) throw new Error('科目不存在');
  if (!filePath || !fs.existsSync(filePath)) throw new Error('资料文件不存在');

  const dir = materialDir(subjectId);
  const original = String(name || path.basename(filePath));
  const ext = path.extname(original).toLowerCase() || '.bin';
  if (ext === '.ppt') throw new Error('不支持旧版 .ppt，请另存为 .pptx 或导出 PDF 后再上传');
  if (!SUPPLEMENTARY_EXT.has(ext)) {
    throw new Error(`不支持 ${ext} 格式，请改用 PDF、PPTX、Markdown/TXT 或图片`);
  }
  const id = newId();
  const stored = path.join(MATERIAL_DIR, FILES_DIR, `${id}${ext}`);
  fs.copyFileSync(filePath, path.join(dir, FILES_DIR, `${id}${ext}`));

  const size = fs.statSync(path.join(dir, FILES_DIR, `${id}${ext}`)).size;
  const isText = TEXT_EXT.has(ext);
  const entry = {
    id,
    name: original,
    ext,
    kind: isText ? 'text' : (ext === '.pdf' ? 'pdf' : (ext === '.pptx' ? 'pptx' : (IMAGE_EXT.has(ext) ? 'image' : 'other'))),
    role: 'supplementary',
    status: isText ? 'ready' : 'pending',
    storedPath: stored,
    textPath: null,
    chars: 0,
    size,
    addedAt: new Date().toISOString(),
    error: null,
  };

  if (isText) {
    const text = fs.readFileSync(path.join(dir, FILES_DIR, `${id}${ext}`), 'utf8');
    const rel = path.join(MATERIAL_DIR, TEXT_DIR, `${id}.md`);
    fs.writeFileSync(path.join(dir, TEXT_DIR, `${id}.md`), text, 'utf8');
    entry.textPath = rel;
    entry.chars = text.length;
  }

  const index = readIndex(subjectId);
  index.supplementary.push(entry);
  writeIndex(subjectId, index);
  return entry;
}

function removeSupplementary({ subjectId, id } = {}) {
  const dir = materialDir(subjectId);
  const index = readIndex(subjectId);
  const target = index.supplementary.find((item) => item.id === id);
  if (!target) return { success: false, error: '资料不存在' };
  for (const rel of [target.storedPath, target.textPath]) {
    if (!rel) continue;
    try { fs.rmSync(path.join(dir, '..', rel), { force: true }); } catch { /* 忽略 */ }
  }
  index.supplementary = index.supplementary.filter((item) => item.id !== id);
  writeIndex(subjectId, index);
  return { success: true };
}

function patchSupplementary(subjectId, id, patch = {}) {
  const index = readIndex(subjectId);
  const target = index.supplementary.find((item) => item.id === id);
  if (!target) throw new Error('资料不存在');
  Object.assign(target, patch);
  writeIndex(subjectId, index);
  return target;
}

/** 解析完成后写入可读正文 */
function finishSupplementary({ subjectId, id, markdown, pages = 0 } = {}) {
  const dir = materialDir(subjectId);
  const rel = path.join(MATERIAL_DIR, TEXT_DIR, `${id}.md`);
  const text = String(markdown || '').trim();
  if (!text) throw new Error('没有可保存的转写内容');
  fs.writeFileSync(path.join(dir, TEXT_DIR, `${id}.md`), text, 'utf8');
  return patchSupplementary(subjectId, id, {
    status: 'ready', textPath: rel, chars: text.length, pages, error: null,
  });
}

/** 取补充资料的正文（相对路径 → 绝对路径） */
function readSupplementaryText(subjectId, id) {
  const index = readIndex(subjectId);
  const item = index.supplementary.find((entry) => entry.id === id);
  if (!item?.textPath) return '';
  const root = subjectManager.getSubjectDir(subjectId);
  const abs = path.join(root, item.textPath);
  try { return fs.readFileSync(abs, 'utf8'); } catch { return ''; }
}

/** 主教材全文路径 */
function primaryTextPath(subjectId) {
  const root = subjectManager.getSubjectDir(subjectId);
  const abs = path.join(root, '教材', '教材全文.md');
  return fs.existsSync(abs) ? abs : null;
}

/**
 * 给 Skill 的资料分层摘要（元信息，不含正文，避免撑爆 system prompt）。
 */
function describeForSkill(subjectId) {
  const data = listMaterials(subjectId);
  const lines = ['\n### 资料分层（主教材优先）'];
  if (data.primary?.name) {
    const hasText = Boolean(data.primary.fullText);
    const status = hasText && data.primary.status === 'ready'
      ? `已解析 ${data.primary.pages} 页`
      : data.primary.status === 'failed'
        ? '上次解析中断，暂无完整转写'
        : data.primary.status === 'parsing' ? '正在解析' : '尚未完成转写';
    const location = hasText ? ' · 全文在 `教材/教材全文.md`，可据此引用' : ' · 目前没有可引用的原文';
    lines.push(`- **主教材（权威）**：《${data.primary.name}》· ${status}${location}。`);
    if (!hasText) lines.push('  - 【注意】主教材原文不可用，不要臆造教材章节、定义与页码；请提示用户到「资料管理」重新解析主教材。');
  } else {
    lines.push('- **主教材（权威）**：尚未上传。请提示用户到「资料管理」添加主教材，在此之前不要臆造教材章节与页码。');
  }
  const ready = data.supplementary.filter((item) => item.status === 'ready' && item.hasText);
  const pending = data.supplementary.filter((item) => item.status !== 'ready' || !item.hasText);
  if (data.supplementary.length) {
    lines.push(`- **补充资料（辅助）**：共 ${data.supplementary.length} 份，${ready.length} 份可读。`);
    ready.slice(0, 12).forEach((item, i) => {
      lines.push(`  ${i + 1}. 《${item.name}》· 可读正文 \`${item.textPath}\`（${item.chars} 字）`);
    });
    if (pending.length) lines.push(`  - 另有 ${pending.length} 份尚未完成解析，暂不可引用。`);
  } else {
    lines.push('- **补充资料（辅助）**：暂无。');
  }
  lines.push('规则：概念、定义、公式、章节范围一律以主教材为准；补充资料只用于补充例题、不同讲法与拓展，引用时标注资料名。两者冲突时以主教材为准并明确指出差异，不得用补充资料覆盖主教材。主教材未覆盖的内容标「范围待核」。');
  return lines.join('\n');
}

module.exports = {
  listMaterials,
  addSupplementary,
  removeSupplementary,
  patchSupplementary,
  finishSupplementary,
  readSupplementaryText,
  primaryTextPath,
  describeForSkill,
  materialDir,
};
