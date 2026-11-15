'use strict';
/**
 * 首页（首页.md）里的动态索引区块。
 * 只在 openexam:index:start / end 之间写，用户自己写的其他内容原样保留。
 */

const fs = require('fs');
const path = require('path');

const V = require('./vault');
const fm = require('./frontmatter');

const HOME_STUB = `# StudyStudio 笔记首页

> 这里既是 Obsidian 仓库，也是 StudyStudio 的笔记出口。

## 快速开始

- 在应用「笔记」页写的东西会自动同步到这里（保存即同步）
- 想反向同步：直接在 Obsidian 里改带 \`app_note_id\` 属性的笔记，应用会按修改时间回流
- 整理后的笔记在 \`10-笔记/\`，知识地图在 \`20-思维导图/\`

## 笔记格式

每篇笔记的 frontmatter 里可以写 \`knowledge_points\` / \`knowledge_labels\`，知识地图会按它分组。

\`\`\`yaml
---
title: 二阶系统的阶跃响应
subject: 自动控制原理
tags: [时域分析]
knowledge_labels: [二阶系统, 阻尼比]
---
\`\`\`

## 数学公式（LaTeX）

Obsidian 内置 MathJax，**不需要装插件**：行内公式用 \`$...$\`，重要公式用 \`$$...$$\` 单独占行，前后各留一个空行。

\`\`\`markdown
二阶系统 $G(s)=\\frac{\\omega_n^{2}}{s^{2}+2\\zeta\\omega_n s+\\omega_n^{2}}$，其中 $\\zeta$ 为阻尼比。

$$
t_p = \\frac{\\pi}{\\omega_n\\sqrt{1-\\zeta^{2}}}
$$
\`\`\`

中文说明、单位、约等号后的解释一律放在公式外（写成「需要 $\\frac{24}{7} \\approx 3.4$ 小时」），
不要写 \`24/7 ≈ 3.4\`、\`x²\`、\`√m/k\` 这类 Unicode 伪公式，也不要用 \`\\(...\\)\` 旧定界符。
应用里的 AI 助教、教材知识清单、笔记整理都按这套格式写入，保存即同步到本仓库。
`;

function buildIndexBlock({ notes, subjects, state, vaultDir }) {
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const subjectName = new Map((subjects || []).map((s) => [String(s.id), s.name]));

  const lines = [];
  lines.push(V.MARK.home[0]);
  lines.push('');
  lines.push(`## 笔记总览 · ${stamp}`);
  lines.push('');
  lines.push(`共 **${(notes || []).length}** 篇笔记，已同步 **${Object.keys(state?.notes || {}).length}** 篇到本仓库。`);
  lines.push('');

  const recent = [...(notes || [])]
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, 8);

  if (recent.length) {
    lines.push('### 最近更新');
    lines.push('');
    for (const note of recent) {
      const record = state?.notes?.[String(note.id)];
      const title = String(note.title || '未命名笔记');
      const subject = subjectName.get(String(note.subjectId || '')) || '';
      const link = record?.file ? `[[${record.file.replace(/\.md$/, '')}|${title}]]` : title;
      lines.push(`- ${link}${subject ? ` · ${subject}` : ''} · ${String(note.updatedAt || '').slice(0, 16)}`);
    }
    lines.push('');
  }

  const counts = new Map();
  for (const note of notes || []) {
    const name = subjectName.get(String(note.subjectId || '')) || '未归类';
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  if (counts.size) {
    lines.push('### 按科目');
    lines.push('');
    for (const [name, count] of [...counts].sort((a, b) => b[1] - a[1])) {
      lines.push(`- **${name}** · ${count} 篇`);
    }
    lines.push('');
  }

  lines.push('地图：[[20-思维导图/知识地图|知识地图]] · [[20-思维导图/知识地图.canvas|画布版]]');
  lines.push('');
  lines.push(V.MARK.home[1]);
  return lines.join('\n');
}

function writeHome({ vaultDir, notes, subjects, state }) {
  V.ensureVault(vaultDir);
  const target = path.join(vaultDir, '首页.md');
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : HOME_STUB;

  const block = buildIndexBlock({ notes, subjects, state, vaultDir });
  const pattern = new RegExp(`${escapeRe(V.MARK.home[0])}[\\s\\S]*?${escapeRe(V.MARK.home[1])}`);

  let next;
  if (pattern.test(existing)) {
    next = existing.replace(pattern, block);
  } else {
    next = `${existing.replace(/\s+$/, '')}\n\n${block}\n`;
  }
  V.writeFileAtomic(target, next);
  return target;
}

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { writeHome, buildIndexBlock, HOME_STUB };
