'use strict';
/**
 * 教材本地解析引擎（MinerU）。
 *
 * 为什么要它：逐页调多模态 API 转写 420 页要 ¥3–6（账户只剩 ¥2.90）、耗时约 30 分钟，
 * 而且插图位置只能让模型猜。MinerU 在本地跑，一次输出 Markdown + content_list.json
 * （每个图/表/公式块都带 page_idx 和 bbox），三个问题一起解决：
 *   - 成本：转写免费，只有后面的「知识清单 / 题目提取」走文本 API（约 ¥1）
 *   - 速度：一次提交整本，几十分钟内出全本
 *   - 配图：images/ 里是已裁好的插图，图号从图注里提，不再猜坐标
 *
 * 只做转写与落盘；知识清单 / 题目提取仍由渲染层走现有 API 流程。
 */

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const subjectTextbook = require('./subjectTextbook.js');
const textbookFigures = require('./textbookFigures.js');
const mineruServer = require('./mineruServer.js');
const runtimeEnv = require('./runtimeEnv.js');

/**
 * 4.x 提取器脚本路径。
 * - 开发模式：项目根/scripts/mineru4_extract.py
 * - 打包版：脚本经 extraResources 放到 asar 外的 resources/mineru-scripts/，
 *   脱离 asar 才能被 Python 直接 open（asar 内的虚拟路径 Python 读不到）。
 */
function mineru4ExtractScript() {
  return runtimeEnv.extractScriptPath();
}

/** 解析前必须真的可用：Python 能执行、import mineru 成功、模型与工作目录就绪 */
async function requireReadyEnv() {
  const env = await runtimeEnv.detectMineru();
  if (!env.ready) {
    const error = new Error(env.message || '本地解析环境未就绪');
    error.code = 'mineru-not-ready';
    error.missing = env.missing;
    error.env = env;
    throw error;
  }
  return env;
}

/** content_list 里相邻文本项的「图 2-40 xxx」就是这张图的图注 */
function extractCaption(buffers, index) {
  const candidates = [
    ...(Array.isArray(buffers[index]?.img_caption) ? buffers[index].img_caption : []),
    ...(Array.isArray(buffers[index]?.table_caption) ? buffers[index].table_caption : []),
  ];
  const direct = candidates.map((t) => String(t || '').trim()).filter(Boolean);
  if (direct.length) return direct.join('；');

  // 没带图注时，向后找最近的以「图 X-Y」开头的短文本
  for (let offset = 1; offset <= 2 && index + offset < buffers.length; offset += 1) {
    const text = String(buffers[index + offset]?.text || '').trim();
    if (text && text.length <= 80 && /^(图|表)\s*[\d一二三四五六七八九十]+\s*[-.．—–]/.test(text)) {
      return text;
    }
  }
  return '';
}

/** 一个块转成 Markdown 片段；表格用 HTML 原文，公式保留 $ 包裹 */
function blockToMarkdown(block) {
  const type = String(block?.type || '');
  if (type === 'image') return '';
  if (type === 'table') {
    const body = String(block?.table_body || '').trim();
    return body || '';
  }
  const text = String(block?.text || '').trim();
  if (!text) return '';
  if (type === 'equation' && !/^\$\$/.test(text)) return `$$\n${text}\n$$`;
  return text;
}

function parseContentList(contentList, imagesDir) {
  const byPage = new Map(); // pageNo -> { lines, figures }
  const list = Array.isArray(contentList) ? contentList : [];
  for (let index = 0; index < list.length; index += 1) {
    const block = list[index];
    const pageNo = Number(block?.page_idx);
    if (!Number.isFinite(pageNo) || pageNo < 0) continue;
    const page = pageNo + 1; // MinerU 从 0 起数

    if (!byPage.has(page)) byPage.set(page, { lines: [], figures: [] });

    if (String(block?.type) === 'image' && block?.img_path) {
      const absolute = imagesDir ? path.join(imagesDir, ...String(block.img_path).split('/')) : null;
      if (absolute && fs.existsSync(absolute)) {
        const caption = extractCaption(list, index);
        byPage.get(page).figures.push({
          no: textbookFigures.normalizeFigureNo(caption) || `p${page}`,
          caption: caption || `教材插图（第 ${page} 页）`,
          absPath: absolute,
          bbox: Array.isArray(block?.bbox) ? block.bbox.map((v) => Math.round(Number(v))) : null,
        });
      }
      continue;
    }

    const line = blockToMarkdown(block);
    if (line) byPage.get(page).lines.push(line);
  }
  return byPage;
}

function stageSender(event, subjectId, stage, detail, percent) {
  if (event && !event.sender.isDestroyed()) {
    event.sender.send('subject:mineruProgress', { subjectId, stage, detail, percent });
  }
}

/**
 * 已落盘页码 → 下一批起始页（断点续传）。
 * 换教材时清掉旧页，避免两本书的转写拼进同一份全文。
 */
function resumeStartPage(subjectId, fileName) {
  try {
    const progress = subjectTextbook.getTextbookProgress(subjectId);
    const done = Array.isArray(progress?.pages) ? progress.pages.map(Number).filter((n) => n > 0) : [];
    const previousName = progress?.fileName || null;
    if (previousName && fileName && previousName !== fileName && done.length) {
      subjectTextbook.resetTextbook(subjectId);
      return 1;
    }
    if (!done.length) return 1;
    const set = new Set(done);
    let page = 1;
    while (set.has(page)) page += 1;
    return page;
  } catch {
    return 1;
  }
}

/** 把一个批次的 content_list 落到科目目录（每批解析完立刻调用，进度条才有真实反馈） */
function applyBatch({ subjectId, outDir, filename, fileName, total }) {
  const partPath = path.join(outDir, filename);
  if (!fs.existsSync(partPath)) return { pages: 0, figures: 0 };
  const list = JSON.parse(fs.readFileSync(partPath, 'utf8'));
  const byPage = parseContentList(Array.isArray(list) ? list : [], null);
  let figureCount = 0;
  for (const [pageNo, data] of byPage) {
    subjectTextbook.saveTextbookPage({
      subjectId, page: pageNo,
      markdown: data.lines.join('\n\n'),
      source: 'local', fileName, total,
    });
    if (data.figures.length) {
      const saved = textbookFigures.saveFigureFiles({ subjectId, page: pageNo, fileName, figures: data.figures });
      figureCount += saved.saved || 0;
    }
  }
  return { pages: byPage.size, figures: figureCount };
}

/**
 * 整本交给 MinerU 4.x，按「每批 N 页」提交、逐批落盘、逐批上报进度。
 *
 * 为什么分批：417 页一次性渲染会把临时目录撑爆（C 盘 No space left on device），
 * 且用户看不到真实进度。借鉴 RAGFlow 的解析任务状态机——小批提交、批次完成即落盘，
 * 已落盘页码在 `解析进度.json` 里，重跑自动跳过。
 */
async function parseTextbookLocal({ subjectId, pdfPath, fileName, onProgress, batchSize } = {}) {
  const env = await requireReadyEnv();
  const py = { command: env.python.command };
  const script = mineru4ExtractScript();
  if (!pdfPath || !fs.existsSync(pdfPath)) throw new Error('PDF 路径无效');

  // 教材文件名常有 100+ 字符（微信传输的 PDF 尤其），统一复制到短路径工作目录再解析，
  // 输出目录也放这里；目录由 runtimeEnv 决定（应用数据目录或可复用的旧环境）。
  const workDir = env.paths.workDir;
  fs.mkdirSync(path.join(workDir, 'tmp'), { recursive: true });
  const safePdf = path.join(workDir, `textbook-${String(subjectId || 'x').slice(0, 8)}.pdf`);
  const sourceSize = fs.statSync(pdfPath).size;
  if (!fs.existsSync(safePdf) || fs.statSync(safePdf).size !== sourceSize) {
    fs.copyFileSync(pdfPath, safePdf);
  }

  const outDir = path.join(workDir, `out-${Date.now()}`);
  fs.mkdirSync(outDir, { recursive: true });

  const emit = (stage, detail, percent, extra) => {
    try { onProgress?.({ stage, detail, percent, ...(extra || {}) }); } catch { /* 进度失败不影响解析 */ }
  };
  emit('local', '准备解析（探测页数与断点）', 2);

  const startPage = resumeStartPage(subjectId, fileName);
  const size = Number(batchSize || process.env.OPENEXAM_PARSE_BATCH || 10);
  const waitSeconds = process.env.OPENEXAM_PARSE_WAIT || '3600';
  const tier = process.env.OPENEXAM_PARSE_TIER || 'basic';
  const endPage = process.env.OPENEXAM_PARSE_END_PAGE || '0';

  // 先确保 doclib server + OCR 引擎就绪；应用自己拉起，不依赖外部后台任务
  return mineruServer.ensureRunning({ onProgress: emit }).then((ready) => {
    if (!ready.ok) throw new Error(ready.error);
    return runExtractor();
  });

  function runExtractor() {
    return new Promise((resolve, reject) => {
    const child = spawn(py.command, [
      script,
      safePdf,
      '--out-dir', outDir,
      '--tier', tier,
      '--wait', waitSeconds,
      '--batch-size', String(size),
      '--start-page', String(startPage),
      '--end-page', String(endPage),
    ], {
      env: runtimeEnv.parsingEnv({ tier }),
      windowsHide: true,
    });

    let stderr = '';
    let buffered = '';
    let resultLine = '';
    let total = 0;
    let lastPage = startPage - 1;
    let figureCount = 0;
    let appliedBatches = 0;
    let failed = false;

    child.stdout.on('data', (chunk) => {
      buffered += chunk.toString();
      const lines = buffered.split('\n');
      buffered = lines.pop() || '';
      for (const line of lines) {
        const text = line.trim();
        if (text.startsWith('RESULT:')) { resultLine = text.slice(7); continue; }
        if (text.startsWith('PROBE:')) {
          total = Number(text.slice(6)) || 0;
          emit('local', `共 ${total} 页，每批 ${size} 页${startPage > 1 ? `，从第 ${startPage} 页续传` : ''}`, 3, { total, donePages: startPage - 1 });
          continue;
        }
        if (text.startsWith('BATCH:')) {
          // BATCH:<a>:<b>:<blocks>:<filename>
          const parts = text.slice(6).split(':');
          const a = Number(parts[0]) || 0;
          const b = Number(parts[1]) || 0;
          const filename = parts[3];
          if (!filename) continue;
          try {
            const applied = applyBatch({ subjectId, outDir, filename, fileName, total: total || b });
            figureCount += applied.figures;
            appliedBatches += 1;
            lastPage = Math.max(lastPage, b);
            const percent = total ? Math.min(96, 5 + Math.round((lastPage / total) * 90)) : 50;
            emit('local', `已解析 ${lastPage}/${total || '?'} 页（第 ${appliedBatches} 批）`, percent, {
              total, donePages: lastPage, batchFrom: a, batchTo: b, batchIndex: appliedBatches,
            });
          } catch (error) {
            failed = true;
            stderr += `\n批次落盘失败：${error.message}`;
          }
          continue;
        }
        const match = /^PROGRESS:(\d+):(.*)$/.exec(text);
        if (match) {
          // 分批进度由 BATCH 精确计算，PROGRESS 只用于「正在解析本批」的心跳文案
          const detail = match[2] || '解析中';
          if (/解析 \d+-\d+ 页/.test(detail)) emit('local', detail, Number(match[1]));
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
          if (parsed && parsed.error) detail = String(parsed.error);
        } catch { /* 用 stderr 兜底 */ }
        reject(new Error(`MinerU 4.x 提取失败（退出码 ${code}）：${detail}`));
        return;
      }
      try {
        // 全部批次已落盘 → 拼教材全文、状态置 ready
        const saved = subjectTextbook.saveTranscription({ subjectId, fileName, totalPages: total || lastPage });
        emit('local', `解析完成 · ${saved.pages} 页`, 100, { total: saved.pages, donePages: saved.pages });
        try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
        resolve({ pages: saved.pages, figures: figureCount, fileName: fileName || '' });
      } catch (error) {
        reject(error);
      }
    });
    });
  }
}

function stemOf(pdfPath) {
  return path.basename(String(pdfPath || '')).replace(/\.pdf$/i, '') || 'textbook';
}

function findOutputDir(outDir, stem) {
  const candidates = [
    path.join(outDir, stem, 'auto'),
    path.join(outDir, stem),
    outDir,
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'content_list.json'))) return dir;
    if (!fs.existsSync(dir)) continue; // 4.x 提取器直接写 outDir，不会有 stem/auto 子目录
    const nested = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name, 'auto'))
      .find((dir2) => fs.existsSync(path.join(dir2, 'content_list.json')));
    if (nested) return nested;
  }
  throw new Error('MinerU 没有产出 content_list.json');
}

function collectOutput({ subjectId, outDir, fileName, stem, emit }) {
  const dir = findOutputDir(outDir, stem);
  const contentList = JSON.parse(fs.readFileSync(path.join(dir, 'content_list.json'), 'utf8'));
  const imagesDir = fs.existsSync(path.join(dir, 'images')) ? path.join(dir, 'images') : null;

  const byPage = parseContentList(Array.isArray(contentList) ? contentList : [], imagesDir);
  const pages = [...byPage.keys()].sort((a, b) => a - b);
  if (!pages.length) throw new Error('MinerU 输出为空');

  let figureCount = 0;
  pages.forEach((pageNo, index) => {
    const data = byPage.get(pageNo);
    emit('local', `落盘 ${index + 1}/${pages.length}`, 50 + Math.round(((index + 1) / pages.length) * 45));

    const markdown = data.lines.join('\n\n');
    subjectTextbook.saveTextbookPage({
      subjectId, page: pageNo, markdown, source: 'local', fileName, total: pages.length,
    });

    if (data.figures.length) {
      const saved = textbookFigures.saveFigureFiles({
        subjectId, page: pageNo, fileName,
        figures: data.figures,
      });
      figureCount += saved.saved || 0;
    }
  });

  subjectTextbook.saveTranscription({ subjectId, fileName, totalPages: pages.length });

  // 解析中间产物不再需要（页文件和插图已经进了仓库），腾出磁盘
  try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* 无所谓 */ }

  return { pages: pages.length, figures: figureCount, fileName: fileName || '' };
}

/**
 * 兼容旧接口：渲染层用它判断「本地解析是否可用」。
 * 现在走 runtimeEnv 的真实探测，available 只有在 Python / mineru / 模型 / 目录 / 脚本全部就绪时才为 true。
 */
async function detectMineru() {
  const env = await runtimeEnv.detectMineru();
  return { ...env, ...env.python, available: env.ready, reason: env.message, engine: 'mineru4' };
}

module.exports = { detectMineru, parseTextbookLocal, mineru4ExtractScript, requireReadyEnv };
