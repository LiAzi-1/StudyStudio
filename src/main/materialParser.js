'use strict';
/**
 * 补充资料解析：PDF 走 MinerU 分批提取；PPTX 直接解包取幻灯片文字。
 *
 * 与主教材的区别：不写 教材/页-NNNN.md、不改 subjects.textbook_status，
 * 只产出 资料/转写/<材料ID>.md，供 Skill 作为「辅助来源」引用。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const textbookMineru = require('./textbookMineru.js');
const materialManager = require('./materialManager.js');
const mineruServer = require('./mineruServer.js');
const runtimeEnv = require('./runtimeEnv.js');
const parseProcesses = require('./parseProcesses.js');
const pptxParser = require('./pptxParser.js');

function tmpRoot() {
  return runtimeEnv.resolvePaths().workDir;
}

/** 各批 content_list → 按页拼成 markdown（标题/表格/公式各自保留格式） */
function blocksToMarkdown(list) {
  const byPage = new Map();
  for (const block of list) {
    const page = Number(block?.page_idx);
    if (!Number.isFinite(page) || page < 0) continue;
    const no = page + 1;
    const type = String(block?.type || '');
    let line = '';
    if (type === 'table') line = String(block?.table_body || '').trim();
    else if (type === 'image') line = '';
    else line = String(block?.text || '').trim();
    if (!line) continue;
    if (type === 'equation' && !/^\$\$/.test(line)) line = `$$\n${line}\n$$`;
    if (!byPage.has(no)) byPage.set(no, []);
    byPage.get(no).push(line);
  }
  const pages = [...byPage.keys()].sort((a, b) => a - b);
  return {
    markdown: pages.map((no) => `\n\n<!-- 第 ${no} 页 -->\n\n${byPage.get(no).join('\n\n')}`).join(''),
    pages: pages.length,
    pageNumbers: pages,
  };
}

/**
 * 解析一份补充资料。
 * @returns {Promise<{pages:number, chars:number}>}
 */
async function parseSupplementary({ subjectId, id, onProgress } = {}) {
  const script = textbookMineru.mineru4ExtractScript();
  if (!fs.existsSync(script)) throw new Error(`缺少提取器脚本：${script}`);

  const index = materialManager.listMaterials(subjectId);
  const item = index.supplementary.find((entry) => entry.id === id);
  if (!item) throw new Error('资料不存在');

  const root = require('./subjectManager.js').getSubjectDir(subjectId);
  const sourcePath = path.join(root, item.storedPath);
  if (!fs.existsSync(sourcePath)) throw new Error('资料文件已丢失，请重新添加');

  const emit = (detail, percent) => {
    try { onProgress?.({ stage: 'material', detail, percent, materialId: id }); } catch { /* 忽略 */ }
  };

  // 文本型资料在 addSupplementary 里已直接可读，无需解析
  if (item.kind === 'text') {
    const text = materialManager.readSupplementaryText(subjectId, id);
    return Promise.resolve({ pages: 0, chars: text.length });
  }

  // PPTX：本地解包取每张幻灯片的文字，无需 OCR / Python
  if (item.kind === 'pptx') {
    return Promise.resolve().then(() => {
      emit('提取 PPT 幻灯片文字', 20);
      const { markdown, slides } = pptxParser.extractPptxText(sourcePath, item.name);
      const finished = materialManager.finishSupplementary({
        subjectId, id, markdown, pages: slides,
      });
      emit('解析完成', 100);
      return { pages: slides, chars: finished?.chars || markdown.length };
    }).catch((error) => {
      try { materialManager.patchSupplementary(subjectId, id, { status: 'failed', error: error.message }); } catch { /* 忽略 */ }
      throw error;
    });
  }

  if (item.kind !== 'pdf') throw new Error('图片与其它格式暂不支持自动转写，请改用 Markdown/TXT、PDF 或 PPTX');

  const env = await runtimeEnv.detectMineru();
  if (!env.ready) {
    const error = new Error(env.message || '本地解析环境未就绪');
    error.code = 'mineru-not-ready';
    error.missing = env.missing;
    throw error;
  }

  const workDir = tmpRoot();
  fs.mkdirSync(path.join(workDir, 'tmp'), { recursive: true });
  const safePdf = path.join(workDir, `material-${id}.pdf`);
  if (!fs.existsSync(safePdf) || fs.statSync(safePdf).size !== fs.statSync(sourcePath).size) {
    fs.copyFileSync(sourcePath, safePdf);
  }
  const outDir = path.join(workDir, `material-out-${Date.now()}`);
  fs.mkdirSync(outDir, { recursive: true });

  const batchSize = Number(process.env.OPENEXAM_PARSE_BATCH || 10);
  const tier = process.env.OPENEXAM_PARSE_TIER || 'basic';

  return mineruServer.ensureRunning({ onProgress: (p) => emit(p.detail, p.percent) }).then((ready) => {
    if (!ready.ok) throw new Error(ready.error);
    return runExtractor();
  });

  function runExtractor() {
    return new Promise((resolve, reject) => {
    const child = parseProcesses.track(spawn(env.python.command, [
      script, safePdf,
      '--out-dir', outDir,
      '--tier', tier,
      '--batch-size', String(batchSize),
      '--wait', process.env.OPENEXAM_PARSE_WAIT || '3600',
    ], {
      env: runtimeEnv.parsingEnv({ tier }),
      windowsHide: true,
    }));

    let buffered = '';
    let stderr = '';
    let resultLine = '';
    let total = 0;
    let lastPage = 0;
    let failed = false;
    const parts = [];
    // 真正产出正文的页码：完成状态与页数都按它统计，而不是按 PDF 总页数
    const convertedPages = new Set();

    child.stdout.on('data', (chunk) => {
      buffered += chunk.toString();
      const lines = buffered.split('\n');
      buffered = lines.pop() || '';
      for (const line of lines) {
        const text = line.trim();
        if (text.startsWith('RESULT:')) { resultLine = text.slice(7); continue; }
        if (text.startsWith('PROBE:')) { total = Number(text.slice(6)) || 0; continue; }
        if (text.startsWith('BATCH:')) {
          const bits = text.slice(6).split(':');
          const a = Number(bits[0]) || 0;
          const b = Number(bits[1]) || 0;
          const filename = bits[3];
          if (!filename) continue;
          try {
            const partPath = path.join(outDir, filename);
            const list = JSON.parse(fs.readFileSync(partPath, 'utf8'));
            const converted = blocksToMarkdown(Array.isArray(list) ? list : []);
            converted.pageNumbers.forEach((no) => convertedPages.add(no));
            parts.push({ a, markdown: converted.markdown });
            lastPage = Math.max(lastPage, b);
            emit(`已解析 ${lastPage}/${total || '?'} 页`, total ? Math.min(95, 5 + Math.round((lastPage / total) * 90)) : 50);
          } catch (error) {
            failed = true;
            stderr += `\n批次处理失败：${error.message}`;
          }
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => reject(new Error(`启动 Python 提取器失败：${error.message}`)));
    child.on('close', (code) => {
      if (code !== 0 || failed) {
        let detail = stderr.split('\n').filter(Boolean).slice(-3).join(' | ') || '无输出';
        try {
          const parsed = JSON.parse(resultLine);
          if (parsed?.error) detail = String(parsed.error);
        } catch { /* 用 stderr 兜底 */ }
        try { materialManager.patchSupplementary(subjectId, id, { status: 'failed', error: detail }); } catch { /* 忽略 */ }
        reject(new Error(`资料解析失败：${detail}`));
        return;
      }
      try {
        parts.sort((x, y) => x.a - y.a);
        const markdown = `# ${item.name} · 补充资料转写\n\n> 辅助资料，供对照与拓展；权威依据以主教材为准。\n${parts.map((p) => p.markdown).join('')}`;
        const totalPages = total || lastPage;
        const missingPages = totalPages > 0
          ? Array.from({ length: totalPages }, (_v, i) => i + 1).filter((no) => !convertedPages.has(no))
          : [];
        materialManager.finishSupplementary({
          subjectId,
          id,
          markdown,
          // pages = 实际转出正文的页数；totalPages/missingPages 记录覆盖率缺口，避免「显示解析完成但缺页」
          pages: convertedPages.size,
          totalPages,
          missingPages,
        });
        try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
        emit(
          missingPages.length
            ? `解析完成 · ${convertedPages.size}/${totalPages} 页，第 ${missingPages.slice(0, 12).join('、')}${missingPages.length > 12 ? '…' : ''} 页未转出文字`
            : '解析完成',
          100,
        );
        resolve({ pages: convertedPages.size, totalPages, missingPages, chars: markdown.length });
      } catch (error) {
        reject(error);
      }
    });
    });
  }
}

module.exports = { parseSupplementary, blocksToMarkdown };
