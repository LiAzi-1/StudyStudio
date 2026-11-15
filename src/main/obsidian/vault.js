'use strict';
/**
 * Obsidian 仓库（vault）的目录约定、迁移与登记。
 *
 * 关键点：vault 不再放在代码目录里。
 * 打包后 __dirname 位于 app.asar，既不可写、也会在升级/卸载时被整个替换掉，
 * 用户的笔记会跟着一起没。所以默认落到 userData，并支持用户改成任意已有库。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const VAULT_DIRS = [
  '00-收件箱',
  '10-笔记',
  '10-笔记/应用笔记',
  '20-思维导图',
  '90-题库',
  '99-附件',
  '99-模板',
  '_bridge',
  '_bridge/index',
];

const DIR = {
  inbox: '00-收件箱',
  notes: '10-笔记',
  appNotes: '10-笔记/应用笔记',
  mindmap: '20-思维导图',
  bank: '90-题库',
  assets: '99-附件',
  templates: '99-模板',
  bridge: '_bridge',
};

const MARK = {
  bank: ['<!-- openexam:bank:start -->', '<!-- openexam:bank:end -->'],
  home: ['<!-- openexam:index:start -->', '<!-- openexam:index:end -->'],
  kp: ['<!-- openexam:kp:start -->', '<!-- openexam:kp:end -->'],
  map: ['<!-- openexam:map:start -->', '<!-- openexam:map:end -->'],
};

/** Windows 文件名禁用字符 → 下划线；保留中文 */
function safeName(text, limit = 80) {
  const cleaned = String(text ?? '').replace(/[\\/:*?"<>|#[\]^]/g, '_').trim();
  return cleaned.slice(0, limit) || 'unnamed';
}

/** 一次性把某个目录树里的文件补到目标目录（已存在的不覆盖） */
function mergeCopy(sourceDir, targetDir) {
  const copied = [];
  const skipped = [];
  const walk = (from, to) => {
    let entries = [];
    try {
      entries = fs.readdirSync(from, { withFileTypes: true });
    } catch {
      return;
    }
    fs.mkdirSync(to, { recursive: true });
    for (const entry of entries) {
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.obsidian') continue; // 让 Obsidian 自己维护配置
        walk(src, dst);
      } else if (entry.isFile()) {
        if (fs.existsSync(dst)) {
          skipped.push(dst);
        } else {
          fs.copyFileSync(src, dst);
          copied.push(dst);
        }
      }
    }
  };
  walk(sourceDir, targetDir);
  return { copied, skipped };
}

function countMarkdown(dir) {
  let total = 0;
  const walk = (current) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name !== '.obsidian') walk(path.join(current, entry.name));
      } else if (entry.name.toLowerCase().endsWith('.md')) {
        total += 1;
      }
    }
  };
  walk(dir);
  return total;
}

/** 新仓库里预置的规范笔记模板：公式用 Obsidian 内置 MathJax 的 LaTeX */
const NOTE_TEMPLATE = `---
title:
subject:
tags: []
knowledge_labels: []
---

> [!tip] 公式写法
> Obsidian 内置 MathJax，不需要插件。行内公式用 \`$...$\`（如 $W = v \\times t$），
> 重要公式用 \`$$...$$\` 单独占行、前后各留一个空行；中文与单位留在公式外。
> 不要写 \`24/7 ≈ 3.4\`、\`x²\`、\`√x\` 这类 Unicode 伪公式，也不要用 \`\\(...\\)\` 旧定界符。

## 核心概念

> 用一句话说清这个知识点是什么。

## 公式 / 结论

$$
G(s) = \\frac{Y(s)}{R(s)}
$$

其中 $G(s)$ 为传递函数，$Y(s)$ 为输出，$R(s)$ 为输入。

## 解题套路

1. 明确已知量与适用条件；
2. 列式，例如 $t = \\frac{W}{\\sum v_i}$；
3. 代入数值并检验量纲与边界条件。

## 易错点

> [!warning] 别踩坑
> 写清最容易混的一步，以及怎么自查。

## 结论速记

- 一句话记住结论，公式用 $...$ 包住。
`;

function ensureVault(vaultDir) {
  fs.mkdirSync(vaultDir, { recursive: true });
  for (const rel of VAULT_DIRS) {
    fs.mkdirSync(path.join(vaultDir, rel), { recursive: true });
  }
  const template = path.join(vaultDir, DIR.templates, '规范笔记模板.md');
  if (!fs.existsSync(template)) {
    fs.writeFileSync(template, NOTE_TEMPLATE, 'utf8');
  }
  return vaultDir;
}

function abs(vaultDir, rel) {
  return path.join(vaultDir, ...String(rel).split('/'));
}

/** 原子写：先写临时文件再 rename，避免 Obsidian 读到半截内容 */
function writeFileAtomic(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, target);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件可能已被清理 */ }
    throw error;
  }
}

/* ------------------------------------------------- Obsidian 仓库登记 */

function obsidianConfigPath() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'obsidian', 'obsidian.json');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'obsidian', 'obsidian.json');
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'obsidian', 'obsidian.json');
}

/**
 * 把 vault 登记进 Obsidian 的仓库列表，用户下次打开 Obsidian 就能直接看到。
 * 失败不影响主流程（没装 Obsidian / 权限不足都很正常）。
 */
function registerVault(vaultDir) {
  const configPath = obsidianConfigPath();
  try {
    if (!fs.existsSync(configPath)) {
      return { ok: false, reason: 'not-installed', configPath };
    }
    const raw = fs.readFileSync(configPath, 'utf8');
    const data = JSON.parse(raw || '{}');
    if (!data.vaults || typeof data.vaults !== 'object') data.vaults = {};

    const normalized = path.resolve(vaultDir);
    const existing = Object.entries(data.vaults)
      .find(([, info]) => path.resolve(String(info?.path || '')) === normalized);
    if (existing) {
      return { ok: true, reason: 'already', id: existing[0], configPath };
    }

    // Obsidian 的仓库 id 是 16 位十六进制
    let id = '';
    do {
      id = require('crypto').randomBytes(8).toString('hex');
    } while (data.vaults[id]);

    data.vaults[id] = { path: normalized, ts: Date.now(), open: false };
    fs.copyFileSync(configPath, `${configPath}.openexam.bak`);
    writeFileAtomic(configPath, JSON.stringify(data, null, 2));
    return { ok: true, reason: 'registered', id, configPath };
  } catch (error) {
    return { ok: false, reason: 'failed', error: error.message, configPath };
  }
}

function isVaultRegistered(vaultDir) {
  return Boolean(vaultIdFor(vaultDir));
}

/**
 * 返回 Obsidian 给这个仓库分配的 id（obsidian.json 里的 16 位十六进制键）。
 * obsidian://open 的 vault 参数既能接仓库名也能接 id，用 id 更稳：
 * 用户在 Obsidian 里给仓库改过名，按文件夹名拼出来的 URI 就失效了。
 */
function vaultIdFor(vaultDir) {
  const configPath = obsidianConfigPath();
  try {
    if (!fs.existsSync(configPath)) return '';
    const data = JSON.parse(fs.readFileSync(configPath, 'utf8') || '{}');
    const normalized = path.resolve(vaultDir);
    const entry = Object.entries(data.vaults || {})
      .find(([, info]) => path.resolve(String(info?.path || '')) === normalized);
    return entry ? entry[0] : '';
  } catch {
    return '';
  }
}

module.exports = {
  DIR,
  MARK,
  VAULT_DIRS,
  safeName,
  mergeCopy,
  countMarkdown,
  ensureVault,
  abs,
  writeFileAtomic,
  obsidianConfigPath,
  registerVault,
  isVaultRegistered,
  vaultIdFor,
};
