#!/usr/bin/env node
/**
 * Obsidian 笔记 → 手机阅读用 PDF 批量导出
 *
 * 依赖：Node 18+、本机 Chrome 或 Edge（headless 打印）、项目内已安装的 katex
 * 不依赖 Pandoc / 付费软件，也不写入 vault（只读笔记）
 *
 * 用法：
 *   node export-pdf.mjs                       # 导出 vault 里全部笔记
 *   node export-pdf.mjs --only 自动控制原理     # 只导出文件名含该关键字的笔记
 *   node export-pdf.mjs --file <某篇.md 的绝对路径>   # 导出 vault 之外的单篇（调试用）
 *   node export-pdf.mjs --list                # 只列出将要导出的笔记
 *   node export-pdf.mjs --no-check            # 跳过导出前的排版自检
 *
 * 可选参数：
 *   --vault <目录>    默认 %APPDATA%/studystudio/obsidian-vault
 *   --out <目录>      默认 本脚本所在目录/out
 *   --css <文件>      默认 <vault>/.obsidian/snippets/mobile-print.css，缺省用脚本同目录的 mobile-print.css
 *   --browser <exe>   指定 Chrome/Edge 可执行文件
 *   --exclude <片段>  追加排除路径（可重复）
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/* 参数解析                                                            */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = {
    vault: path.join(process.env.APPDATA || os.homedir(), 'studystudio', 'obsidian-vault'),
    out: path.join(SCRIPT_DIR, 'out'),
    css: null,
    browser: null,
    only: [],
    exclude: ['.obsidian', '_bridge', '99-附件', '99-模板'],
    file: null,
    list: false,
    check: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--vault': opts.vault = path.resolve(next()); break;
      case '--out': opts.out = path.resolve(next()); break;
      case '--css': opts.css = path.resolve(next()); break;
      case '--browser': opts.browser = next(); break;
      case '--only': opts.only.push(next()); break;
      case '--exclude': opts.exclude.push(next()); break;
      case '--file': opts.file = path.resolve(next()); break;
      case '--list': opts.list = true; break;
      case '--no-check': opts.check = false; break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
      default:
        if (a.startsWith('--')) {
          console.error(`未知参数：${a}`);
          process.exit(2);
        }
    }
  }
  return opts;
}

function printHelp() {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .split('\n').slice(1, 26).map((l) => l.replace(/^\s*\*? ?/, '')).join('\n'));
}

/* ------------------------------------------------------------------ */
/* 浏览器与 katex 资源                                                  */
/* ------------------------------------------------------------------ */

function findBrowser(explicit) {
  const candidates = [
    explicit,
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch { /* ignore */ }
  }
  throw new Error('未找到 Chrome 或 Edge，请用 --browser 指定可执行文件路径');
}

function locateKatex() {
  try {
    // require.resolve('katex') 指向 dist/katex.js，包根目录下的 dist 才是 css 与字体
    const pkg = require.resolve('katex/package.json');
    return path.join(path.dirname(pkg), 'dist');
  } catch {
    return null;
  }
}

/** 把 katex 的 css 与字体复制到输出目录，避免 file:// 跨目录取字体失败 */
function ensureKatexAssets(katexDistDir, outDir) {
  if (!katexDistDir) return null;
  const css = path.join(katexDistDir, 'katex.min.css');
  if (!fs.existsSync(css)) return null;
  const dest = path.join(outDir, '.assets', 'katex');
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(css, path.join(dest, 'katex.min.css'));
  const fontsSrc = path.join(katexDistDir, 'fonts');
  const fontsDest = path.join(dest, 'fonts');
  if (fs.existsSync(fontsSrc) && !fs.existsSync(fontsDest)) {
    fs.cpSync(fontsSrc, fontsDest, { recursive: true });
  }
  return path.join(dest, 'katex.min.css');
}

/* ------------------------------------------------------------------ */
/* Markdown → HTML                                                     */
/* ------------------------------------------------------------------ */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);
const escapeAttr = (s) => escapeHtml(s).replace(/'/g, '&#39;');

const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|webp|svg|avif)$/i;

function renderMath(tex, display) {
  const katexDir = locateKatex();
  if (katexDir) {
    try {
      const katex = require('katex');
      const html = katex.renderToString(tex.trim(), {
        displayMode: display,
        throwOnError: false,
        strict: false,
        output: 'html',
      });
      return display ? `<div class="math math-block">${html}</div>` : html;
    } catch { /* 落到下面的降级 */ }
  }
  return `<code>${escapeHtml(tex.trim())}</code>`;
}

function toFileUrl(absPath) {
  // pathToFileURL 负责转义空格与中文
  return pathToFileURL(absPath).href;
}

function resolveImage(src, ctx) {
  if (/^(https?:|data:|file:)/i.test(src)) return { url: src };
  let p = src;
  if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')) {
    return fs.existsSync(p) ? { url: toFileUrl(p) } : { missing: src };
  }
  const candidates = [
    path.resolve(ctx.noteDir, decodeURI(p)),
    path.resolve(ctx.vault, decodeURI(p)),
    path.resolve(ctx.vault, '99-附件', decodeURI(p)),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return { url: toFileUrl(c) };
  }
  return { missing: src };
}

function renderImage(alt, src, ctx) {
  const r = resolveImage(src, ctx);
  if (r.missing) {
    return `<span class="embed-missing">［图片未找到：${escapeHtml(r.missing)}］</span>`;
  }
  return `<img src="${escapeAttr(r.url)}" alt="${escapeAttr(alt || '')}">`;
}

/** ![[...]] 嵌入：图片直接显示，笔记片段给出占位说明（不伪造内容） */
function renderEmbed(inner, ctx) {
  const [targetRaw, sizeRaw] = inner.split('|');
  const target = targetRaw.trim();
  const base = target.split('#')[0].trim();
  if (IMAGE_EXT.test(base)) {
    const r = resolveImage(base, ctx);
    if (r.missing) return `<span class="embed-missing">［图片未找到：${escapeHtml(base)}］</span>`;
    const width = sizeRaw && /^\d+$/.test(sizeRaw.trim()) ? ` width="${sizeRaw.trim()}"` : '';
    return `<img src="${escapeAttr(r.url)}" alt="${escapeAttr(base)}"${width}>`;
  }
  return `<span class="embed-missing">［嵌入片段：${escapeHtml(target)}（导出时未展开）］</span>`;
}

function renderWikiLink(inner) {
  const [target, alias] = inner.split('|');
  const label = (alias || target).replace(/#/g, ' › ').trim();
  const unresolved = !alias && target.includes('/');
  return `<span class="internal-link${unresolved ? ' is-unresolved' : ''}">${escapeHtml(label)}</span>`;
}

function renderInline(text, ctx) {
  const tokens = [];
  const put = (html) => `\u0001${tokens.push(html) - 1}\u0001`;
  let s = text;

  // 行内代码优先，避免里面的 $ 与 * 被误判
  s = s.replace(/(`+)([\s\S]*?)\1/g, (m, f, code) => put(`<code>${escapeHtml(code.trim())}</code>`));
  // 块级公式
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (m, tex) => put(renderMath(tex, true)));
  // 行内公式
  s = s.replace(/(^|[^\\$])\$([^$\n]+?)\$(?!\d)/g,
    (m, pre, tex) => `${pre}${put(renderMath(tex, false))}`);

  // 图片嵌入 / 图片链接
  s = s.replace(/!\[\[([^\]]+?)\]\]/g, (m, inner) => put(renderEmbed(inner, ctx)));
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, alt, src) => put(renderImage(alt, src, ctx)));
  // 双链 / 普通链接
  s = s.replace(/\[\[([^\]]+?)\]\]/g, (m, inner) => put(renderWikiLink(inner)));
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (m, label, href) => put(`<a href="${escapeAttr(href)}">${escapeHtml(label)}</a>`));

  // 剩下的纯文本：先转义，再加行内样式
  s = escapeHtml(s);
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/==([^=]+)==/g, '<mark>$1</mark>')
    .replace(/\n/g, ' ');

  return s.replace(/\u0001(\d+)\u0001/g, (m, i) => tokens[Number(i)] ?? '');
}

const RE_HEADING = /^(#{1,6})\s+(.*)$/;
const RE_FENCE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
const RE_HR = /^\s*((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/;
const RE_LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RE_QUOTE = /^\s*>/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

function isBlockStart(lines, i) {
  const l = lines[i];
  if (l === undefined) return true;
  return (
    l.trim() === '' ||
    RE_FENCE.test(l) ||
    RE_HEADING.test(l) ||
    RE_HR.test(l) ||
    RE_QUOTE.test(l) ||
    RE_LIST.test(l) ||
    /^\s*\$\$\s*$/.test(l) ||
    (l.includes('|') && RE_TABLE_SEP.test(lines[i + 1] || ''))
  );
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function parseList(lines, ctx) {
  const items = [];
  let current = null;
  for (const raw of lines) {
    const m = RE_LIST.exec(raw);
    if (m) {
      current = {
        indent: m[1].replace(/\t/g, '    ').length,
        ordered: /^\d/.test(m[2]),
        text: m[3],
      };
      items.push(current);
    } else if (current && raw.trim() !== '') {
      current.text += ' ' + raw.trim();
    }
  }
  if (!items.length) return '';

  const render = (slice) => {
    const base = Math.min(...slice.map((x) => x.indent));
    const groups = [];
    let i = 0;
    let group = null;
    while (i < slice.length) {
      const item = slice[i];
      let j = i + 1;
      while (j < slice.length && slice[j].indent > base) j++;
      const children = slice.slice(i + 1, j);
      const body = renderInline(item.text, ctx) + (children.length ? render(children) : '');
      if (!group || group.ordered !== item.ordered) {
        group = { ordered: item.ordered, items: [] };
        groups.push(group);
      }
      group.items.push(body);
      i = j;
    }
    return groups
      .map((g) => {
        const tag = g.ordered ? 'ol' : 'ul';
        return `<${tag}>${g.items.map((b) => `<li>${b}</li>`).join('')}</${tag}>`;
      })
      .join('');
  };

  return render(items);
}

function parseBlocks(lines, ctx) {
  let html = '';
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') { i++; continue; }

    // 代码块
    const fence = RE_FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2] || '';
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${marker[0]}{3,}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // 跳过结束围栏
      const isMermaid = /^mermaid$/i.test(lang);
      const cls = lang ? ` class="language-${escapeAttr(lang)}"` : '';
      const label = lang
        ? `<div class="code-lang">${escapeHtml(lang)}${isMermaid ? '（图表，导出为源码）' : ''}</div>`
        : '';
      html += `<pre>${label}<code${cls}>${escapeHtml(body.join('\n'))}</code></pre>`;
      continue;
    }

    // 块级公式
    if (/^\s*\$\$\s*$/.test(line)) {
      const body = [];
      i++;
      while (i < lines.length && !/^\s*\$\$\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++;
      html += renderMath(body.join('\n'), true);
      continue;
    }
    const oneLineMath = /^\s*\$\$(.+?)\$\$\s*$/.exec(line);
    if (oneLineMath) {
      html += renderMath(oneLineMath[1], true);
      i++;
      continue;
    }

    // 标题
    const h = RE_HEADING.exec(line);
    if (h) {
      const level = h[1].length;
      // Obsidian 标题尾部的 `优先级：高` 之类反引号保持行内代码样式
      html += `<h${level}>${renderInline(h[2], ctx)}</h${level}>`;
      i++;
      continue;
    }

    // 分隔线
    if (RE_HR.test(line)) {
      html += '<hr>';
      i++;
      continue;
    }

    // 引用 / Callout
    if (RE_QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && (RE_QUOTE.test(lines[i]) || (lines[i].trim() !== '' && body.length && !isBlockStart(lines, i)))) {
        body.push(lines[i].replace(/^\s*> ?/, ''));
        i++;
      }
      const callout = /^\[!([\w-]+)\][+-]?\s*(.*)$/.exec(body[0] || '');
      if (callout) {
        const rest = body.slice(1).filter((l, idx) => idx > 0 || l.trim() !== '');
        const title = callout[2] || callout[1];
        html += `<div class="callout" data-callout="${escapeAttr(callout[1].toLowerCase())}">`
          + `<div class="callout-title">${escapeHtml(title)}</div>`
          + `<div class="callout-content">${parseBlocks(rest, ctx)}</div></div>`;
      } else {
        html += `<blockquote>${parseBlocks(body, ctx)}</blockquote>`;
      }
      continue;
    }

    // 表格
    if (line.includes('|') && RE_TABLE_SEP.test(lines[i + 1] || '')) {
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => {
        if (/^:.*:$/.test(c)) return 'center';
        if (/:$/.test(c)) return 'right';
        return 'left';
      });
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const th = header.map((c, k) => `<th style="text-align:${aligns[k] || 'left'}">${renderInline(c, ctx)}</th>`).join('');
      const tb = rows.map((r) => `<tr>${r.map((c, k) => `<td style="text-align:${aligns[k] || 'left'}">${renderInline(c, ctx)}</td>`).join('')}</tr>`).join('');
      html += `<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`;
      continue;
    }

    // 列表
    if (RE_LIST.test(line)) {
      const body = [];
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === '') break;
        if (RE_LIST.test(l) || /^\s{2,}\S/.test(l)) {
          body.push(l);
          i++;
          continue;
        }
        break;
      }
      html += parseList(body, ctx);
      continue;
    }

    // 段落
    const para = [];
    while (i < lines.length && lines[i].trim() !== '' && !(para.length && isBlockStart(lines, i))) {
      para.push(lines[i]);
      i++;
    }
    html += `<p>${renderInline(para.join('\n'), ctx)}</p>`;
  }

  return html;
}

function stripFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(md);
  return m ? md.slice(m[0].length) : md;
}

function convertMarkdown(md, ctx) {
  let text = md.replace(/\r\n/g, '\n');
  text = stripFrontmatter(text);
  text = text.replace(/<!--[\s\S]*?-->/g, ''); // Obsidian/app 的 HTML 注释标记
  text = text.replace(/%%[\s\S]*?%%/g, '');    // Obsidian 注释
  return parseBlocks(text.split('\n'), ctx);
}

/* ------------------------------------------------------------------ */
/* HTML 模板                                                           */
/* ------------------------------------------------------------------ */

const DIAG_SCRIPT = `
<script>
// 公式/代码超宽时按比例缩小，避免打印时被裁切
document.addEventListener('DOMContentLoaded', function () {
  var nodes = document.querySelectorAll('.katex-display, .math-block');
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    el.style.zoom = '';
    var host = el.parentElement || document.body;
    var avail = host.clientWidth || document.documentElement.clientWidth;
    var w = el.scrollWidth;
    if (w > avail && avail > 0) {
      el.style.zoom = Math.max(0.5, avail / w).toFixed(3);
    }
  }
});
window.addEventListener('load', function () {
  var items = [];
  var nodes = document.querySelectorAll('pre, table, .katex-display, .math-block, img');
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    if (el.tagName === 'IMG') {
      if (!el.complete || el.naturalWidth === 0) items.push('IMG_MISSING ' + el.getAttribute('src'));
      continue;
    }
    if (el.scrollWidth > el.clientWidth + 2) {
      items.push('OVERFLOW_X ' + el.tagName.toLowerCase() + ' ' + el.scrollWidth + '>' + el.clientWidth
        + ' 「' + (el.textContent || '').trim().slice(0, 30) + '」');
    }
  }
  var d = document.createElement('pre');
  d.id = '__diag';
  d.textContent = 'DIAG_JSON ' + JSON.stringify({
    items: items,
    bodyScrollWidth: document.documentElement.scrollWidth,
    bodyClientWidth: document.documentElement.clientWidth,
    docHeight: document.documentElement.scrollHeight
  });
  document.body.appendChild(d);
});
</script>`;

function buildHtml(bodyHtml, css, katexCssPath) {
  const katexCss = katexCssPath
    ? `<link rel="stylesheet" href="${toFileUrl(katexCssPath)}">`
    : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>导出</title>
${katexCss}
<style>
  html, body { margin: 0; padding: 0; background: #fff; }
  body { padding: 0; }
  /* 与 Obsidian 阅读视图一致的容器结构，便于 CSS 片段直接生效 */
  .markdown-preview-view { display: block; }
  .code-lang {
    font-size: 8.5pt; color: #6b7480; letter-spacing: .04em;
    margin: -2px 0 4px; font-family: "Segoe UI", sans-serif;
  }
  .embed-missing {
    display: inline-block; font-size: 9pt; color: #8a6d3b;
    background: #fdf6e3; border: 1px dashed #e0cf9a; border-radius: 3px;
    padding: 1px 6px;
  }
  #__diag { display: none !important; }
  @media print { #__diag { display: none !important; } }
</style>
<style>
${css}
</style>
</head>
<body>
<div class="markdown-preview-view">
<div class="markdown-rendered">
${bodyHtml}
</div>
</div>
${DIAG_SCRIPT}
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/* Chrome 调用                                                         */
/* ------------------------------------------------------------------ */

function runChrome(browser, args, profileDir) {
  const base = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--allow-file-access-from-files',
    `--user-data-dir=${profileDir}`,
  ];
  const r = spawnSync(browser, [...base, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    timeout: 120000,
  });
  return r;
}

function diagnose(browser, htmlPath, profileDir) {
  const r = runChrome(browser, ['--virtual-time-budget=8000', '--dump-dom', toFileUrl(htmlPath)], profileDir);
  const dom = (r.stdout || '') + (r.stderr || '');
  const m = /DIAG_JSON (\{.*?\})<\/pre>/s.exec(dom) || /DIAG_JSON (\{.*\})/.exec(dom);
  if (!m) return null;
  try {
    return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  } catch {
    return null;
  }
}

function printToPdf(browser, htmlPath, pdfPath, profileDir) {
  const r = runChrome(browser, [
    '--no-pdf-header-footer',
    '--virtual-time-budget=15000',
    '--run-all-compositor-stages-before-draw',
    `--print-to-pdf=${pdfPath}`,
    toFileUrl(htmlPath),
  ], profileDir);
  if (!fs.existsSync(pdfPath)) {
    throw new Error(`PDF 未生成：${pdfPath}\n${(r.stderr || '').slice(0, 800)}`);
  }
  return fs.statSync(pdfPath).size;
}

/* ------------------------------------------------------------------ */
/* 笔记收集                                                            */
/* ------------------------------------------------------------------ */

function collectNotes(opts) {
  if (opts.file) return [opts.file];
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(opts.vault, abs).replace(/\\/g, '/');
      if (opts.exclude.some((ex) => rel === ex || rel.startsWith(ex + '/'))) continue;
      if (entry.isDirectory()) walk(abs);
      else if (/\.md$/i.test(entry.name)) found.push(abs);
    }
  };
  walk(opts.vault);
  return found
    .filter((f) => !opts.only.length || opts.only.some((k) => f.includes(k)))
    .sort((a, b) => {
      const ra = path.relative(opts.vault, a).replace(/\\/g, '/');
      const rb = path.relative(opts.vault, b).replace(/\\/g, '/');
      const rootA = ra.includes('/') ? 1 : 0;
      const rootB = rb.includes('/') ? 1 : 0;
      return rootA - rootB || ra.localeCompare(rb, 'zh');
    });
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(opts.vault) && !opts.file) {
    console.error(`vault 不存在：${opts.vault}`);
    process.exit(1);
  }

  const notes = collectNotes(opts);
  if (!notes.length) {
    console.error('没有匹配的笔记');
    process.exit(1);
  }

  if (opts.list) {
    notes.forEach((n) => console.log(opts.vault ? path.relative(opts.vault, n) : n));
    console.log(`共 ${notes.length} 篇`);
    return;
  }

  const cssPath = opts.css
    || [path.join(opts.vault, '.obsidian', 'snippets', 'mobile-print.css'),
      path.join(SCRIPT_DIR, 'mobile-print.css')].find((p) => fs.existsSync(p));
  if (!cssPath) console.warn('警告：未找到打印 CSS，将使用浏览器默认样式');
  const css = cssPath ? fs.readFileSync(cssPath, 'utf8') : '';

  const browser = findBrowser(opts.browser);
  const katexDir = locateKatex();
  if (!katexDir) console.warn('警告：未找到 katex，公式将退化为源码文本');

  const workDir = path.join(opts.out, '.work');
  const profileDir = path.join(opts.out, '.chrome-profile');
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });
  const katexCssPath = ensureKatexAssets(katexDir, opts.out);

  console.log(`vault  ：${opts.vault}`);
  console.log(`输出   ：${opts.out}`);
  console.log(`CSS    ：${cssPath || '(默认)'}`);
  console.log(`浏览器 ：${browser}`);
  console.log(`katex  ：${katexDir || '(无)'}`);
  console.log(`笔记数 ：${notes.length}\n`);

  const report = [];
  for (const note of notes) {
    const rel = opts.vault && note.startsWith(opts.vault)
      ? path.relative(opts.vault, note)
      : path.basename(note);
    const relNoExt = rel.replace(/\.md$/i, '');
    const pdfPath = path.join(opts.out, `${relNoExt}.pdf`);
    const workName = rel.replace(/[\\/]/g, '__').replace(/\.md$/i, '') + '.html';
    const htmlPath = path.join(workDir, workName);

    const md = fs.readFileSync(note, 'utf8');
    const ctx = { vault: opts.vault, noteDir: path.dirname(note), notePath: note };
    const body = convertMarkdown(md, ctx);
    fs.writeFileSync(htmlPath, buildHtml(body, css, katexCssPath), 'utf8');

    fs.mkdirSync(path.dirname(pdfPath), { recursive: true });

    let diag = null;
    if (opts.check) diag = diagnose(browser, htmlPath, profileDir);
    const size = printToPdf(browser, htmlPath, pdfPath, profileDir);

    const problems = diag ? diag.items : [];
    report.push({ rel, pdfPath, size, diag, problems });

    const flag = problems.length ? `  ⚠ ${problems.length} 项` : '';
    console.log(`✓ ${rel}  →  ${(size / 1024).toFixed(0)} KB${flag}`);
    if (problems.length) problems.forEach((p) => console.log(`    · ${p}`));
  }

  fs.rmSync(profileDir, { recursive: true, force: true });

  console.log(`\n完成：${report.length} 篇，输出目录 ${opts.out}`);
  const bad = report.filter((r) => r.problems.length);
  if (bad.length) {
    console.log(`排版自检有提示的笔记：${bad.length} 篇（见上方 ⚠ 行）`);
  }
}

main();
