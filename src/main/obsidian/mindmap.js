'use strict';
/**
 * 知识地图：把应用内笔记按「科目 → 知识点 → 笔记」铺成 Markdown 思维导图 + Obsidian Canvas。
 *
 * 之前的实现按题库的「模块.题型.考点」分类硬套，结果《自动控制原理》的笔记被挂到了
 * 「判断推理 / 图形推理」下面——因为行测题库的标签体系跟用户的科目根本不是一回事。
 * 所以这里改成先按科目分组，科目内再按笔记自带的 knowledge_labels / tags 分。
 */

const fs = require('fs');
const path = require('path');

const V = require('./vault');

const MAX_NOTES_PER_GROUP = 40;

function safeAnchor(text) {
  return String(text || '')
    .replace(/[|[\]#^]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function noteLabels(note, subject) {
  const meta = note.meta && typeof note.meta === 'object' ? note.meta : {};
  const raw = [
    ...(Array.isArray(meta.knowledge_labels) ? meta.knowledge_labels : []),
    ...(Array.isArray(note.tags) ? note.tags : []),
  ]
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    // 与科目同名的标签没信息量，只会让地图里多出一层空壳
    .filter((item) => item !== subject);

  const unique = [...new Set(raw)];
  if (unique.length) return unique.slice(0, 2);
  return ['未归类'];
}

function groupNotes({ notes, subjects, state }) {
  const subjectName = new Map((subjects || []).map((s) => [String(s.id), s.name]));
  const tree = new Map(); // subject -> Map(label -> note[])

  for (const note of notes || []) {
    const meta = note.meta && typeof note.meta === 'object' ? note.meta : {};
    const subject = String(
      subjectName.get(String(note.subjectId || '')) || meta.subject || meta.topic || '未归类',
    ).trim() || '未归类';

    const record = state?.notes?.[String(note.id)];
    const file = record?.file || null;

    if (!tree.has(subject)) tree.set(subject, new Map());
    const bucket = tree.get(subject);
    for (const label of noteLabels(note, subject)) {
      const key = String(label).trim() || '未归类';
      if (!bucket.has(key)) bucket.set(key, []);
      bucket.get(key).push({ note, file });
    }
  }
  return tree;
}

function buildMarkdown(tree) {
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const lines = [];
  lines.push('# OpenExam 知识地图');
  lines.push('');
  lines.push(`> 由应用内笔记自动生成，更新于 ${stamp}。`);
  lines.push('> **画布版**：[[20-思维导图/知识地图.canvas|打开可点击的思维导图]] —— 双击卡片直接跳到笔记。');
  lines.push('');
  lines.push('```mermaid');
  lines.push('mindmap');
  lines.push('  root((OpenExam 知识地图))');

  let nodeSeq = 0;
  const entries = [];
  for (const [subject, bucket] of tree) {
    nodeSeq += 1;
    lines.push(`    n${nodeSeq}{{${safeAnchor(subject)}}}`);
    for (const [label, items] of bucket) {
      nodeSeq += 1;
      lines.push(`      n${nodeSeq}(${safeAnchor(label)})`);
      const shown = items.slice(0, MAX_NOTES_PER_GROUP);
      for (const item of shown) {
        nodeSeq += 1;
        const title = String(item.note.title || '未命名笔记').replace(/"/g, "'");
        lines.push(`        n${nodeSeq}["${title}"]`);
      }
      entries.push({ subject, label, items });
    }
  }

  if (!entries.length) {
    lines.push('    empty(还没有笔记)');
  }

  lines.push('```');
  lines.push('');
  lines.push('## 知识点入口');
  lines.push('');

  if (!entries.length) {
    lines.push('> 还没有笔记。到应用「笔记」页写一篇，或把文件丢进 `00-收件箱`。');
  }

  for (const entry of entries) {
    const links = entry.items.slice(0, MAX_NOTES_PER_GROUP).map((item) => {
      const title = String(item.note.title || '未命名笔记');
      if (!item.file) return `📄 ${title}`;
      return `[[${item.file.replace(/\.md$/, '')}|📄 ${title}]]`;
    });
    lines.push(`### ${entry.subject} / ${entry.label}`);
    lines.push('');
    lines.push(links.join(' · '));
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

/* ----------------------------------------------------------------- canvas */

function buildCanvas(tree) {
  const nodes = [];
  const edges = [];
  let seq = 0;
  const nextId = () => {
    seq += 1;
    return `oe${String(seq).padStart(4, '0')}`;
  };

  const COLUMN_WIDTH = 300;
  const ROW_GAP = 24;

  const rootId = nextId();
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const totalGroups = [...tree.values()].reduce((sum, bucket) => sum + bucket.size, 0);

  const subjectHeights = new Map();
  const labelHeights = new Map();

  for (const [subject, bucket] of tree) {
    let height = 0;
    for (const [label, items] of bucket) {
      const labelHeight = 34 + Math.min(items.length, MAX_NOTES_PER_GROUP) * 46;
      labelHeights.set(`${subject}\u0000${label}`, labelHeight);
      height += labelHeight + ROW_GAP;
    }
    subjectHeights.set(subject, Math.max(height, 70));
  }

  const totalHeight = Math.max(
    [...subjectHeights.values()].reduce((sum, h) => sum + h + ROW_GAP, 0),
    300,
  );

  nodes.push({
    id: rootId,
    type: 'text',
    text: `**OpenExam 知识地图**\n\n${totalGroups} 个知识点分组 · ${stamp}`,
    x: 0,
    y: Math.round(totalHeight / 2 - 48),
    width: 250,
    height: 96,
    color: '6',
  });

  let cursorY = 0;
  for (const [subject, bucket] of tree) {
    const subjectId = nextId();
    nodes.push({
      id: subjectId,
      type: 'text',
      text: `**${subject}**\n${bucket.size} 个知识点`,
      x: COLUMN_WIDTH,
      y: cursorY + Math.round(subjectHeights.get(subject) / 2 - 35),
      width: 230,
      height: 70,
      color: '5',
    });
    edges.push({ id: `edge-${rootId}-${subjectId}`, fromNode: rootId, fromSide: 'right', toNode: subjectId, toSide: 'left', toEnd: 'arrow' });

    let labelY = cursorY;
    for (const [label, items] of bucket) {
      const labelHeight = labelHeights.get(`${subject}\u0000${label}`);
      const labelId = nextId();
      nodes.push({
        id: labelId,
        type: 'text',
        text: `**${label}**\n${items.length} 篇`,
        x: COLUMN_WIDTH * 2,
        y: labelY + 17,
        width: 220,
        height: 34,
        color: '4',
      });
      edges.push({ id: `edge-${subjectId}-${labelId}`, fromNode: subjectId, fromSide: 'right', toNode: labelId, toSide: 'left', toEnd: 'arrow' });

      let noteY = labelY + 34;
      for (const item of items.slice(0, MAX_NOTES_PER_GROUP)) {
        const noteId = nextId();
        const title = String(item.note.title || '未命名笔记');
        const text = item.file
          ? `[[${item.file.replace(/\.md$/, '')}|${title}]]`
          : title;
        nodes.push({
          id: noteId,
          type: 'text',
          text,
          x: COLUMN_WIDTH * 3,
          y: noteY,
          width: 260,
          height: 40,
          color: '1',
        });
        edges.push({ id: `edge-${labelId}-${noteId}`, fromNode: labelId, fromSide: 'right', toNode: noteId, toSide: 'left' });
        noteY += 46;
      }
      labelY += labelHeight + ROW_GAP;
    }
    cursorY += subjectHeights.get(subject) + ROW_GAP;
  }

  return { nodes, edges };
}

function build({ vaultDir, notes, subjects, state }) {
  V.ensureVault(vaultDir);
  const tree = groupNotes({ notes, subjects, state });
  const dir = path.join(vaultDir, ...V.DIR.mindmap.split('/'));
  fs.mkdirSync(dir, { recursive: true });

  const mdPath = path.join(dir, '知识地图.md');
  const canvasPath = path.join(dir, '知识地图.canvas');

  const markdown = buildMarkdown(tree);
  const canvas = buildCanvas(tree);

  V.writeFileAtomic(mdPath, markdown);
  V.writeFileAtomic(canvasPath, `${JSON.stringify(canvas, null, 2)}\n`);

  const groupCount = [...tree.values()].reduce((sum, bucket) => sum + bucket.size, 0);
  return {
    subjects: tree.size,
    groups: groupCount,
    notes: (notes || []).length,
    files: [mdPath, canvasPath],
  };
}

module.exports = { build, groupNotes };
