#!/usr/bin/env node
/**
 * 导出结果校验：页数、页面尺寸（A4）、图片数量、右侧越界文字（判断是否截断）
 * 用法：node verify-pdf.mjs <pdf 或目录> [更多...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pdfjs = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

const A4 = { w: 595.28, h: 841.89, tol: 2 };

function walk(target, acc = []) {
  const st = fs.statSync(target);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(target)) {
      if (e === '.work' || e === '.assets' || e === '.chrome-profile') continue;
      walk(path.join(target, e), acc);
    }
  } else if (/\.pdf$/i.test(target)) {
    acc.push(target);
  }
  return acc;
}

async function inspect(file) {
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(file)),
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;

  const out = { file, pages: doc.numPages, sizes: new Set(), images: 0, chars: 0, clipped: [], sparse: [], text: '' };
  const ops = pdfjs.OPS;

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    out.sizes.add(`${vp.width.toFixed(1)}x${vp.height.toFixed(1)}`);

    let pageImages = 0;
    const opList = await page.getOperatorList();
    for (const fn of opList.fnArray) {
      if (fn === ops.paintImageXObject || fn === ops.paintJpegXObject || fn === ops.paintInlineImageXObject) {
        pageImages++;
      }
    }
    out.images += pageImages;

    const content = await page.getTextContent();
    let pageChars = 0;
    for (const item of content.items) {
      if (!item.str) continue;
      pageChars += item.str.length;
      out.text += item.str;
      const x = item.transform[4];
      const w = item.width || 0;
      if (item.str.trim() && x + w > vp.width - 3) {
        out.clipped.push({ page: p, snippet: item.str.slice(0, 24), overflow: Math.round(x + w - vp.width) });
      }
    }
    out.chars += pageChars;
    if (pageChars < 20 && pageImages === 0) out.sparse.push(p);
  }

  await doc.destroy();
  return out;
}

const targets = process.argv.slice(2);
if (!targets.length) targets.push(path.join(path.dirname(fileURLToPath(import.meta.url)), 'out'));

const files = targets.flatMap((t) => walk(path.resolve(t)));
if (!files.length) {
  console.error('没有找到 PDF');
  process.exit(1);
}

let bad = 0;
for (const file of files) {
  const r = await inspect(file);
  const sizeOk = [...r.sizes].every((s) => {
    const [w, h] = s.split('x').map(Number);
    return Math.abs(w - A4.w) <= A4.tol && Math.abs(h - A4.h) <= A4.tol;
  });
  const hasHeaderFooter = /file:\/\/\/|www\.|Printed on/i.test(r.text);
  const ok = sizeOk && !hasHeaderFooter && r.clipped.length === 0 && r.sparse.length === 0;
  if (!ok) bad++;

  console.log(`${ok ? '✓' : '✗'} ${path.basename(file)}`);
  console.log(`    页数 ${r.pages}｜页面 ${[...r.sizes].join(', ')}${sizeOk ? '（A4）' : '（非 A4）'}`);
  console.log(`    文字 ${r.chars} 字｜图片 ${r.images} 张｜越界文字 ${r.clipped.length} 处${hasHeaderFooter ? '｜检测到页眉页脚' : ''}`);
  if (r.sparse.length) console.log(`    · 近乎空白页：第 ${r.sparse.join('、')} 页`);
  if (r.clipped.length) {
    r.clipped.slice(0, 5).forEach((c) => console.log(`    · 第 ${c.page} 页溢出 ${c.overflow}pt：${c.snippet}`));
  }
  if (process.env.SHOW_HEAD) console.log(`    开头：${r.text.slice(0, 80)}`);
}

console.log(`\n共 ${files.length} 个 PDF，问题 ${bad} 个`);
process.exit(bad ? 1 : 0);
