'use strict';
/**
 * .pptx 文本提取（不依赖外部 zip 库）。
 *
 * .pptx 本质是 ZIP 包，正文在 ppt/slides/slideN.xml 的 <a:t> 里。
 * 这里只做「按幻灯片提取文字」，保留幻灯片序号与首段标题，供助教定位引用；
 * 不做版式还原、图片抽取，也不处理旧版 .ppt（二进制格式，需另存为 .pptx 或导出 PDF）。
 */

const fs = require('fs');
const zlib = require('zlib');

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function readUInt32(buf, offset) {
  return buf.readUInt32LE(offset);
}

/** 读 ZIP 中央目录，返回 Map<文件名, Buffer>（只解压需要的条目） */
function readZipEntries(buf) {
  let eocd = -1;
  const minOffset = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minOffset; i -= 1) {
    if (readUInt32(buf, i) === EOCD_SIGNATURE) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 .pptx 文件（ZIP 结构损坏）');

  const count = buf.readUInt16LE(eocd + 10);
  const centralOffset = readUInt32(buf, eocd + 16);
  if (count === 0xffff || centralOffset === 0xffffffff) {
    throw new Error('暂不支持 ZIP64 格式的 .pptx，请另存为普通 .pptx');
  }

  const entries = new Map();
  let pointer = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (readUInt32(buf, pointer) !== CENTRAL_SIGNATURE) break;
    const method = buf.readUInt16LE(pointer + 10);
    const compressedSize = readUInt32(buf, pointer + 20);
    const nameLength = buf.readUInt16LE(pointer + 28);
    const extraLength = buf.readUInt16LE(pointer + 30);
    const commentLength = buf.readUInt16LE(pointer + 32);
    const localOffset = readUInt32(buf, pointer + 42);
    const name = buf.toString('utf8', pointer + 46, pointer + 46 + nameLength);

    if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) {
      if (readUInt32(buf, localOffset) !== LOCAL_SIGNATURE) {
        throw new Error('PPT 内容读取失败（ZIP 条目损坏）');
      }
      const localNameLength = buf.readUInt16LE(localOffset + 26);
      const localExtraLength = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const raw = buf.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) entries.set(name, Buffer.from(raw));
      else if (method === 8) entries.set(name, zlib.inflateRawSync(raw));
      else throw new Error(`PPT 内容压缩方式不受支持（method=${method}）`);
    }

    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function decodeXml(text) {
  return String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 一个 <a:p> 段落 → 纯文本（合并段落内多个 run） */
function paragraphTexts(slideXml) {
  const paragraphs = [];
  const paragraphRe = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g;
  let match;
  while ((match = paragraphRe.exec(slideXml))) {
    const runs = [];
    const runRe = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g;
    let run;
    while ((run = runRe.exec(match[1]))) runs.push(run[1]);
    if (!runs.length) continue;
    const text = decodeXml(runs.join(''))
      .replace(/<[^>]+>/g, '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/[ \u00a0]{2,}/g, ' ')
      .trim();
    if (text) paragraphs.push(text);
  }
  return paragraphs;
}

function slideNumber(name) {
  const match = /slide(\d+)\.xml$/.exec(name);
  return match ? Number(match[1]) : 0;
}

/**
 * 提取 .pptx 的文字。
 * @returns {{markdown:string, slides:number, chars:number}}
 */
function extractPptxText(filePath, displayName = '') {
  const buf = fs.readFileSync(filePath);
  const entries = readZipEntries(buf);
  const slideNames = [...entries.keys()].sort((a, b) => slideNumber(a) - slideNumber(b));
  if (!slideNames.length) throw new Error('这个 .pptx 里没有找到幻灯片文字');

  const title = String(displayName || '').replace(/\.pptx$/i, '') || 'PPT 资料';
  const lines = [
    `# ${title} · PPT 转写`,
    '',
    '> 由 .pptx 直接提取文字，按幻灯片分节保留页码与首段标题；辅助资料，权威依据以主教材为准。',
    '',
  ];

  let slides = 0;
  for (const name of slideNames) {
    const no = slideNumber(name);
    const paragraphs = paragraphTexts(entries.get(name).toString('utf8'));
    if (!paragraphs.length) continue;
    slides += 1;
    const heading = paragraphs[0].length <= 80 ? paragraphs[0] : '';
    const body = heading ? paragraphs.slice(1) : paragraphs;
    lines.push(`## 第 ${no} 张幻灯片${heading ? `：${heading}` : ''}`);
    lines.push('');
    if (body.length) {
      lines.push(body.join('\n\n'));
      lines.push('');
    }
  }

  if (!slides) throw new Error('这个 .pptx 的幻灯片中没有可提取的文字');
  const markdown = lines.join('\n').trim();
  return { markdown, slides, chars: markdown.length };
}

module.exports = { extractPptxText };
