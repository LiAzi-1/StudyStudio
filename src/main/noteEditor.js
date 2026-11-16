/**
 * 笔记局部编辑（主进程）
 *
 * 目标：
 * 1. 先定位到具体一篇笔记（按 id / 标题 / 关键词），多篇命中时把候选交回界面让用户选；
 * 2. 只改用户点名的段落：
 *    - replace_section       保留小节标题，只替换该节正文
 *    - append_after_section  在该节正文末尾、下一个同级标题前插入
 *    - replace_text          替换原文里唯一出现的一段文字
 *    - append_to_note        追加到笔记末尾
 *    - replace_whole         整篇重写（必须由调用方显式声明）
 * 3. 写入前把旧内容存一份快照；写入后用行级差异告诉用户改了哪几段。
 *
 * 这里不调用模型，所有判断都是本地的、可复现的：
 * 计划卡和真正执行走同一个 resolveEdit，避免「计划说改 A、实际改了 B」。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { normalizeMath } = require('../shared/mathStyle.js');

const OPERATION_LABELS = {
  replace_section: '只改这一节',
  append_after_section: '在这一节后追加',
  replace_text: '替换指定原文',
  append_to_note: '追加到笔记末尾',
  replace_whole: '整篇重写',
};

const OPERATIONS = Object.keys(OPERATION_LABELS);

function toLines(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').split('\n');
}

function charLength(text) {
  return [...String(text ?? '')].length;
}

function firstContentLine(content) {
  return String(content || '')
    .split('\n')
    .map((line) => line.replace(/^#{1,6}\s*/, '').trim())
    .find(Boolean) || '';
}

function subjectName(subjectId) {
  if (!subjectId) return '';
  try {
    return require('./subjectManager.js').getSubject(subjectId)?.name || '';
  } catch {
    return '';
  }
}

function toCandidate(note) {
  const content = note?.content;
  return {
    id: note?.id || '',
    title: String(note?.title || '').trim() || '未命名笔记',
    subjectId: note?.subjectId || null,
    subjectName: subjectName(note?.subjectId),
    updatedAt: note?.updatedAt || note?.updated_at || '',
    chars: content !== undefined && content !== null
      ? charLength(content)
      : Number(note?.chars) || 0,
    preview: content !== undefined && content !== null
      ? firstContentLine(content).slice(0, 80)
      : String(note?.preview || '').replace(/^#{1,6}\s*/, '').trim().slice(0, 80),
  };
}

/** 统一按 Markdown 标题切小节：每个小节包含标题行 + 到下一个同级/更高级标题前的正文 */
function analyzeSections(content) {
  const lines = toLines(content);
  const headings = [];
  lines.forEach((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) return;
    headings.push({
      title: match[2].trim(),
      level: match[1].length,
      startLine: index,
      bodyStart: index + 1,
    });
  });
  return headings.map((heading, index) => {
    let endLine = lines.length;
    for (let cursor = index + 1; cursor < headings.length; cursor += 1) {
      if (headings[cursor].level <= heading.level) {
        endLine = headings[cursor].startLine;
        break;
      }
    }
    return {
      title: heading.title,
      level: heading.level,
      startLine: heading.startLine,
      bodyStart: heading.bodyStart,
      endLine,
      body: lines.slice(heading.bodyStart, endLine).join('\n'),
    };
  });
}

function publicSection(section) {
  return {
    title: section.title,
    level: section.level,
    // 界面里按 1 基行号展示；正文为空时 startLine 会大于 endLine
    startLine: section.startLine + 1,
    endLine: section.endLine,
    chars: charLength(section.body),
  };
}

function normalizeQuery(value) {
  return String(value || '').trim().replace(/^#{1,6}\s*/, '').trim();
}

function matchSections(sections, query) {
  const raw = normalizeQuery(query);
  if (!raw) return [];
  const target = raw.toLowerCase();
  const exact = sections.filter((section) => section.title.toLowerCase() === target);
  if (exact.length) return exact;
  const numbered = sections.filter((section) => {
    const title = section.title.toLowerCase();
    return title.startsWith(`${target} `)
      || title.startsWith(`${target}.`)
      || title.startsWith(`${target}、`)
      || title.startsWith(`${target}：`)
      || title.startsWith(`${target}:`);
  });
  if (numbered.length) return numbered;
  return sections.filter((section) => {
    const title = section.title.toLowerCase();
    return title.includes(target) || target.includes(title);
  });
}

function sectionAtLine(sections, lineIndex) {
  let found = null;
  for (const section of sections) {
    if (section.startLine <= lineIndex) found = section;
    else break;
  }
  return found;
}

function countTrailingBlank(lines) {
  let count = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!String(lines[index]).trim()) count += 1;
    else break;
  }
  return count;
}

function normalizeBlock(content) {
  const lines = toLines(normalizeMath(String(content ?? '')).text);
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
}

function replaceSectionBody(content, section, nextContent) {
  const lines = toLines(content);
  const originalBody = lines.slice(section.bodyStart, section.endLine);
  const hasNext = section.endLine < lines.length;
  const trailing = Math.max(countTrailingBlank(originalBody), hasNext ? 1 : 0);
  const block = normalizeBlock(nextContent);
  for (let index = 0; index < trailing; index += 1) block.push('');
  return [
    ...lines.slice(0, section.bodyStart),
    ...block,
    ...lines.slice(section.endLine),
  ].join('\n');
}

function insertAfterSection(content, section, addition) {
  const lines = toLines(content);
  const block = normalizeBlock(addition);
  if (!block.length) return content;
  const at = section.endLine;
  const before = lines.slice(0, at);
  const after = lines.slice(at);
  let insert = block;
  if (before.length && before[before.length - 1].trim()) insert = ['', ...insert];
  if (after.length && after[0].trim()) insert = [...insert, ''];
  return [...before, ...insert, ...after].join('\n');
}

function appendToNote(content, addition) {
  const block = normalizeBlock(addition);
  if (!block.length) return content;
  const base = String(content || '').replace(/\s+$/, '');
  const trailingNewline = /\n$/.test(String(content || ''));
  return `${base}${base ? '\n\n' : ''}${block.join('\n')}${trailingNewline ? '\n' : ''}`;
}

function findAll(text, needle) {
  const positions = [];
  if (!needle) return positions;
  let cursor = 0;
  for (;;) {
    const index = text.indexOf(needle, cursor);
    if (index < 0) break;
    positions.push(index);
    cursor = index + needle.length;
    if (positions.length > 50) break;
  }
  return positions;
}

function lineOfIndex(text, index) {
  let line = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text[cursor] === '\n') line += 1;
  }
  return line;
}

function previewLines(lines, maxLines = 10, maxChars = 120) {
  return (Array.isArray(lines) ? lines : [])
    .slice(0, maxLines)
    .map((line) => String(line).slice(0, maxChars));
}

/**
 * 行级差异：局部编辑只会产生一个连续改动块，用「公共前缀 + 公共后缀」足够精确，
 * 也不会像 LCS 那样在长笔记上有性能风险。
 */
function diffLines(beforeText, afterText) {
  const before = toLines(beforeText);
  const after = toLines(afterText);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const beforeStop = before.length - suffix;
  const afterStop = after.length - suffix;
  const removed = before.slice(prefix, beforeStop);
  const added = after.slice(prefix, afterStop);
  if (!removed.length && !added.length) {
    return { changed: false, addedLines: 0, removedLines: 0, hunks: [] };
  }
  return {
    changed: true,
    addedLines: added.length,
    removedLines: removed.length,
    hunks: [{
      beforeStart: prefix + 1,
      beforeEnd: beforeStop,
      afterStart: prefix + 1,
      afterEnd: afterStop,
      removedPreview: previewLines(removed),
      addedPreview: previewLines(added),
    }],
  };
}

function changedSectionTitles(beforeText, afterText, diff) {
  if (!diff?.changed) return [];
  const beforeSections = analyzeSections(beforeText);
  const afterSections = analyzeSections(afterText);
  const hunk = diff.hunks[0];
  const titles = new Set();
  if (diff.removedLines > 0) {
    const section = sectionAtLine(beforeSections, Math.max(0, hunk.beforeStart - 1));
    if (section) titles.add(section.title);
  }
  if (diff.addedLines > 0) {
    const section = sectionAtLine(afterSections, Math.max(0, hunk.afterStart - 1));
    if (section) titles.add(section.title);
  }
  return [...titles];
}

/* ------------------------------------------------------------- 候选与定位 */

function briefFromNote(note) {
  return toCandidate(note);
}

function recentCandidates(database, subjectId, limit) {
  try {
    if (typeof database.listNoteBriefs === 'function') {
      return database.listNoteBriefs({ subjectId: subjectId || undefined, limit })
        .map(briefFromNote);
    }
    const result = database.getNotes({ subjectId: subjectId || undefined, limit });
    return (result?.items || []).map(briefFromNote);
  } catch {
    return [];
  }
}

function dedupeCandidates(items) {
  const seen = new Set();
  const list = [];
  for (const item of items) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    list.push(item);
  }
  return list;
}

/**
 * 按 id / 标题 / 关键词定位笔记。
 * 只有「唯一命中」才自动选中，其余情况一律把候选交回界面。
 */
function resolveTarget(database, input = {}) {
  const noteId = String(input.noteId || '').trim();
  if (noteId) {
    const note = database.getNote(noteId);
    if (note) return { note, candidates: [] };
  }

  const titleQuery = String(input.titleQuery || '').trim();
  const subjectId = String(input.subjectId || '').trim();
  let items = [];
  if (titleQuery) {
    try {
      const result = database.searchNotes(titleQuery, { limit: 20 });
      items = Array.isArray(result?.items) ? result.items : [];
    } catch {
      items = [];
    }
  }
  if (!items.length) {
    items = recentCandidates(database, subjectId, 20)
      .map((candidate) => ({ ...candidate, __brief: true }));
  }

  const candidates = dedupeCandidates(items.map(briefFromNote));
  if (!candidates.length) {
    return {
      needsClarification: true,
      needsChoice: false,
      message: titleQuery
        ? `没有找到标题或内容包含「${titleQuery}」的笔记，请确认笔记标题，或先告诉我要改哪一篇。`
        : '还没有找到可修改的笔记，请先告诉我笔记标题。',
      candidates: [],
    };
  }

  const query = normalizeQuery(titleQuery).toLowerCase();
  if (query) {
    const exact = candidates.filter((item) => item.title.toLowerCase() === query);
    if (exact.length === 1) {
      const note = database.getNote(exact[0].id);
      if (note) return { note, candidates: [] };
    }
    if (exact.length > 1) {
      return {
        needsClarification: true,
        needsChoice: true,
        choiceField: 'noteId',
        message: `有 ${exact.length} 篇同名笔记，请先选一篇：`,
        candidates: exact,
      };
    }
  }

  // 同一科目优先，其余保持搜索顺序
  const ordered = [
    ...candidates.filter((item) => subjectId && item.subjectId === subjectId),
    ...candidates.filter((item) => !(subjectId && item.subjectId === subjectId)),
  ];

  if (ordered.length === 1) {
    const note = database.getNote(ordered[0].id);
    if (note) return { note, candidates: [] };
  }

  return {
    needsClarification: true,
    needsChoice: true,
    choiceField: 'noteId',
    message: titleQuery
      ? `「${titleQuery}」匹配到 ${ordered.length} 篇笔记，请先选一篇：`
      : `你有多篇笔记，请先选要修改的一篇：`,
    candidates: ordered,
  };
}

/* --------------------------------------------------------------- 计划编辑 */

function normalizeOperation(value) {
  const operation = String(value || '').trim();
  return OPERATIONS.includes(operation) ? operation : 'replace_section';
}

function clarification(message, extra = {}) {
  return {
    ok: false,
    needsClarification: true,
    needsChoice: false,
    message,
    ...extra,
  };
}

/** 内部：解析 + 计算新正文，不写库 */
function resolveEdit(database, input = {}) {
  const target = resolveTarget(database, input);
  if (target.needsClarification) {
    return { ok: false, ...target };
  }

  const note = target.note;
  const beforeContent = String(note.content || '');
  const sections = analyzeSections(beforeContent);
  const operation = normalizeOperation(input.operation);
  const wholeNote = input.wholeNote === true || operation === 'replace_whole';
  const newContentRaw = String(input.content ?? '');
  const newContent = normalizeMath(newContentRaw).text;

  if (!newContent.trim() && operation !== 'replace_whole') {
    return clarification('新内容为空，请告诉我这一节要改成什么。', {
      note: toCandidate(note),
      availableSections: sections.map(publicSection),
    });
  }

  let nextContent = beforeContent;
  let section = null;

  if (operation === 'replace_whole' || (wholeNote && operation === 'replace_section' && !String(input.section || '').trim())) {
    if (input.wholeNote !== true && operation !== 'replace_whole') {
      return clarification('整篇重写风险较大，请先确认要整篇覆盖，或改用「只改某一节 / 替换指定原文」。', {
        note: toCandidate(note),
        availableSections: sections.map(publicSection),
      });
    }
    nextContent = newContent;
  } else if (operation === 'append_to_note') {
    nextContent = appendToNote(beforeContent, newContent);
  } else if (operation === 'replace_text') {
    const find = String(input.find ?? '');
    if (!find.trim()) {
      return clarification('「替换指定原文」需要提供要替换的原文片段（find）。', {
        note: toCandidate(note),
        availableSections: sections.map(publicSection),
      });
    }
    const positions = findAll(beforeContent, find);
    if (!positions.length) {
      return clarification(`笔记《${note.title}》里找不到这段原文，请确认要替换的是哪一段（也可以改为指定小节）。`, {
        note: toCandidate(note),
        availableSections: sections.map(publicSection),
      });
    }
    if (positions.length > 1) {
      const lines = positions.slice(0, 8).map((index) => lineOfIndex(beforeContent, index) + 1);
      return clarification(`这段原文在笔记里出现了 ${positions.length} 次（第 ${lines.join('、')} 行），请给一段更精确、唯一的文字。`, {
        note: toCandidate(note),
        availableSections: sections.map(publicSection),
      });
    }
    nextContent = beforeContent.slice(0, positions[0]) + newContent + beforeContent.slice(positions[0] + find.length);
    section = sectionAtLine(sections, lineOfIndex(beforeContent, positions[0]));
  } else {
    const query = String(input.section || '').trim();
    if (!query) {
      return clarification('请先指定要修改的小节标题。', {
        note: toCandidate(note),
        availableSections: sections.map(publicSection),
      });
    }
    const matches = matchSections(sections, query);
    if (!matches.length) {
      return clarification(`笔记《${note.title}》里找不到小节「${query}」，请从已有小节里选一个，或改用「替换指定原文」。`, {
        note: toCandidate(note),
        availableSections: sections.map(publicSection),
      });
    }
    if (matches.length > 1) {
      return {
        ok: false,
        needsClarification: true,
        needsChoice: true,
        choiceField: 'section',
        message: `「${query}」匹配到 ${matches.length} 个小节，请选具体一节：`,
        note: toCandidate(note),
        candidates: matches.map(publicSection),
        availableSections: sections.map(publicSection),
      };
    }
    section = matches[0];
    nextContent = operation === 'append_after_section'
      ? insertAfterSection(beforeContent, section, newContent)
      : replaceSectionBody(beforeContent, section, newContent);
  }

  if (nextContent === beforeContent) {
    return {
      ok: false,
      needsClarification: true,
      needsChoice: false,
      message: '新内容与原文一致，没有需要写入的改动。',
      note: toCandidate(note),
      availableSections: sections.map(publicSection),
    };
  }

  const diff = diffLines(beforeContent, nextContent);
  return {
    ok: true,
    note,
    operation,
    operationLabel: OPERATION_LABELS[operation],
    section,
    beforeContent,
    nextContent,
    diff: {
      ...diff,
      changedSections: changedSectionTitles(beforeContent, nextContent, diff),
    },
    wholeNote: operation === 'replace_whole',
  };
}

function publicPlan(result) {
  if (result.ok) {
    return {
      ok: true,
      note: toCandidate(result.note),
      operation: result.operation,
      operationLabel: result.operationLabel,
      section: result.section ? publicSection(result.section) : null,
      beforeChars: charLength(result.beforeContent),
      afterChars: charLength(result.nextContent),
      diff: {
        changed: result.diff.changed,
        addedLines: result.diff.addedLines,
        removedLines: result.diff.removedLines,
        hunks: result.diff.hunks,
        changedSections: result.diff.changedSections,
      },
      wholeNote: result.wholeNote,
    };
  }
  return {
    ok: false,
    needsClarification: Boolean(result.needsClarification),
    needsChoice: Boolean(result.needsChoice),
    choiceField: result.choiceField || '',
    message: result.message || '',
    note: result.note || null,
    candidates: Array.isArray(result.candidates) ? result.candidates : [],
    availableSections: Array.isArray(result.availableSections) ? result.availableSections : [],
  };
}

/** 只读：给计划卡用 */
function planNoteEdit(database, input = {}) {
  return publicPlan(resolveEdit(database, input));
}

/* ----------------------------------------------------------------- 快照 */

function safeFileName(value) {
  const name = String(value || '').trim().replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40);
  return name || '未命名笔记';
}

function defaultSnapshotDir(note) {
  if (note?.subjectId) {
    try {
      const dir = require('./subjectManager.js').getSubjectDir(note.subjectId);
      if (dir) {
        const target = path.join(dir, '笔记快照');
        fs.mkdirSync(target, { recursive: true });
        return target;
      }
    } catch {
      // 落回 userData
    }
  }
  let root = null;
  try {
    root = require('electron').app.getPath('userData');
  } catch {
    root = path.join(os.tmpdir(), 'StudyStudio');
  }
  const dir = path.join(root, '笔记快照');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSnapshot(note, content, dirOverride) {
  const dir = dirOverride ? String(dirOverride) : defaultSnapshotDir(note);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${safeFileName(note.title || note.id)}-${stamp}.md`);
  fs.writeFileSync(file, String(content || ''), 'utf8');
  return file;
}

/* ----------------------------------------------------------------- 执行 */

/**
 * 执行局部编辑：先快照，再写入，最后按保存后的真实内容算差异。
 * 快照失败会直接抛错，绝不会在没有旧版本的情况下覆盖笔记。
 */
function applyNoteEdit(database, input = {}) {
  const resolved = resolveEdit(database, input);
  if (!resolved.ok) {
    return { success: false, ...publicPlan(resolved) };
  }

  const note = resolved.note;
  const snapshotPath = writeSnapshot(note, resolved.beforeContent, input.snapshotDir);
  const saved = typeof database.updateNoteContent === 'function'
    ? database.updateNoteContent(note.id, resolved.nextContent)
    : database.saveNote({
      id: note.id,
      title: note.title,
      content: resolved.nextContent,
      tags: note.tags,
      sourceType: note.sourceType,
      sourceId: note.sourceId,
      sourceLabel: note.sourceLabel,
      subjectId: note.subjectId,
      pinned: note.pinned,
      meta: note.meta,
    });
  const afterContent = String(saved?.content ?? resolved.nextContent);
  const diff = diffLines(resolved.beforeContent, afterContent);

  return {
    success: true,
    ...publicPlan(resolved),
    snapshotPath,
    beforeChars: charLength(resolved.beforeContent),
    afterChars: charLength(afterContent),
    normalized: afterContent !== resolved.nextContent,
    diff: {
      ...diff,
      changedSections: changedSectionTitles(resolved.beforeContent, afterContent, diff),
    },
    note: toCandidate(saved || note),
  };
}

/* --------------------------------------------------------------- 候选列表 */

/** 按标题/关键词列候选；没有关键词时按最近更新列 */
function listNoteCandidates(database, options = {}) {
  const query = String(options.query || '').trim();
  const subjectId = String(options.subjectId || '').trim();
  const limit = Math.min(50, Math.max(1, Number(options.limit) || 12));
  let items = [];
  if (query) {
    try {
      const result = database.searchNotes(query, { limit: limit * 2 });
      items = (result?.items || []).map(briefFromNote);
    } catch {
      items = [];
    }
  }
  if (!items.length) {
    items = recentCandidates(database, subjectId, limit);
  }
  const ordered = [
    ...items.filter((item) => subjectId && item.subjectId === subjectId),
    ...items.filter((item) => !(subjectId && item.subjectId === subjectId)),
  ];
  return dedupeCandidates(ordered).slice(0, limit);
}

module.exports = {
  OPERATION_LABELS,
  analyzeSections,
  listNoteCandidates,
  planNoteEdit,
  applyNoteEdit,
  resolveTarget,
  diffLines,
};
