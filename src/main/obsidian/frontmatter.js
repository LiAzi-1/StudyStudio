'use strict';
/**
 * Obsidian 笔记的 YAML frontmatter 读写。
 *
 * 只处理桥接自己写出去的那一小撮格式（标量 + 行内数组 + 短横线数组），
 * 不引入 YAML 依赖：vault 里的文件必须与既有 Python 版桥接逐字节兼容，
 * 否则用户切换实现后 Obsidian 里会出现一堆「脏」属性。
 */

const KEY_RE = /^([\w\u4e00-\u9fff_-]+)\s*:\s*(.*)$/;
const LIST_ITEM_RE = /^\s+-\s+(.*)$/;
const NEEDS_QUOTE_RE = /[:#\n[\]{}"']/;

function parseScalar(raw) {
  const value = String(raw ?? '').trim();
  if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
    return value.slice(1, -1);
  }
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  return value;
}

/**
 * @returns {{ meta: Record<string, any>, body: string }}
 */
function parse(text) {
  const source = String(text ?? '');
  if (!source.startsWith('---')) return { meta: {}, body: source };
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/.exec(source);
  if (!match) return { meta: {}, body: source };

  const meta = {};
  let listKey = null;
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;

    const item = LIST_ITEM_RE.exec(line);
    if (item && listKey) {
      meta[listKey].push(parseScalar(item[1]));
      continue;
    }

    const kv = KEY_RE.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].trim();
    listKey = null;
    if (value === '') {
      meta[key] = [];
      listKey = key;
    } else if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim();
      meta[key] = inner ? inner.split(',').map((v) => parseScalar(v)).filter((v) => String(v).length) : [];
    } else {
      meta[key] = parseScalar(value);
    }
  }
  return { meta, body: source.slice(match[0].length) };
}

function dumpScalar(value) {
  const text = String(value);
  if (NEEDS_QUOTE_RE.test(text) || text.trim() !== text) {
    return `"${text.replace(/"/g, "'")}"`;
  }
  return text;
}

function dump(meta) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(meta || {})) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      const items = value.map((v) => String(v).replace(/[[\]]/g, ''));
      lines.push(`${key}: [${items.join(', ')}]`);
    } else if (typeof value === 'boolean') {
      lines.push(`${key}: ${value ? 'true' : 'false'}`);
    } else {
      lines.push(`${key}: ${dumpScalar(value)}`);
    }
  }
  lines.push('---');
  return `${lines.join('\n')}\n\n`;
}

/** 把 meta 转成稳定的字符串指纹，用于判断「属性有没有变」 */
function stableKey(meta) {
  return Object.keys(meta || {})
    .sort()
    .map((key) => {
      const value = meta[key];
      return `${key}=${Array.isArray(value) ? value.join('|') : String(value)}`;
    })
    .join(';');
}

module.exports = { parse, dump, parseScalar, stableKey };
