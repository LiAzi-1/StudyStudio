import React, { useState, useEffect, useRef } from 'react';
import * as XLSX from 'xlsx';
import { getRoleSettings, isRoleConfigured, isOCRConfigured } from '../store/aiSettings.js';
import { useDialog } from '../components/DialogProvider.jsx';
import {
  createImportTask,
  patchImportTask,
  addImportTaskError,
  useImportTasks,
  registerImportTaskCanceller,
} from '../store/importTasks.js';

const categoryConfig = {
  math: { name: '数学', color: '#2563eb' },
  english: { name: '英语', color: '#0f766e' },
  politics: { name: '政治', color: '#b45309' },
  major: { name: '专业课', color: '#7c3aed' },
};

// 子分类配置
const subCategoryConfig = {
  math: ['高等数学', '线性代数', '概率论与数理统计'],
  english: ['完形填空', '阅读理解', '翻译', '英语写作'],
  politics: ['马克思主义基本原理', '毛中特', '思想道德与法治', '形势与政策'],
  major: ['专业课综合'],
};

// 所有子分类合并
const allSubCategories = Object.values(subCategoryConfig).flat();

// 去重用的文本归一化与相似度：题库已有题、同一任务内已入库题都靠它判断
const normalizeForMatch = (value) => String(value || '').toLowerCase()
  .replace(/\s+/g, '')
  .replace(/[，。、“”‘’；：？！,.;:!?()（）]/g, '');

// 纯图片题没有 content，只有 contentHtml；去重/入库都必须用同一套 key
const contentKeyOf = (question) => normalizeForMatch(
  question?.content || question?.contentHtml || question?.content_html || ''
);

// 只把「几乎完全相同」的题干判为重复。旧版 0.78 + 子串即重复会把
// 「求 a5」和「求 a6」、「细胞膜」和「细胞核」这类不同的题静默丢弃。
const DEDUPE_THRESHOLD = 0.93;
const questionSimilarity = (left, right) => {
  const a = normalizeForMatch(left);
  const b = normalizeForMatch(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const shorter = Math.min(a.length, b.length);
  const longer = Math.max(a.length, b.length);
  // 题干太短或长度差太多时不再用 bigram 近似，避免短句被误判
  if (shorter < 12 || shorter / longer < 0.85) return 0;
  const grams = (value) => new Set(Array.from({ length: Math.max(0, value.length - 1) }, (_, index) => value.slice(index, index + 2)));
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let intersection = 0;
  ga.forEach((gram) => { if (gb.has(gram)) intersection += 1; });
  return intersection / (ga.size + gb.size - intersection);
};

const AUTO_COMMIT_KEY = 'openexam_import_auto_commit';
// 模块级任务注册表：全屏考试页等分支会让导入页短暂卸载，
// 共享同一个 Map 才能保证回来后仍能查看/停止正在跑的任务。
const ACTIVE_RUNS_REF = { current: new Map() };
const TASK_STATUS_LABEL = {
  running: '识别中', done: '已完成', partial: '部分成功',
  failed: '失败', cancelled: '已停止', interrupted: '已中断',
};

const normalizeImportedQuestionType = (value) => {
  const raw = String(value || '').trim().toLowerCase();
  if (['multiple', 'multi', '多选', '多选题'].includes(raw)) return 'multiple';
  if (['judge', '判断', '判断题', 'true_false'].includes(raw)) return 'judge';
  if (['fill', '填空', '填空题', 'fill_blank', 'blank'].includes(raw)) return 'fill';
  if (['subjective', '主观', '主观题', '简答', '论述', 'essay', 'short_answer', 'open'].includes(raw)) return 'subjective';
  return 'single';
};

// 客观题答案统一大写字母；填空 / 主观题答案常是 f(x)、x^{2} 这类公式文本，
// 一旦 toUpperCase 就会变成 F(X)、X^{2}，数学含义直接损坏，必须原样保留。
const normalizeImportedAnswer = (value, type) => {
  const raw = String(value ?? '').trim();
  return ['fill', 'subjective'].includes(normalizeImportedQuestionType(type)) ? raw : raw.toUpperCase();
};

// 下载 Excel 模板（带下拉验证）
function downloadTemplate() {
  const wb = XLSX.utils.book_new();

  // 主数据 + 右侧分类说明
  const wsData = [
    ['题目内容', '选项A', '选项B', '选项C', '选项D', '正确答案', '解析', '分类', '子分类', '题型', '', '分类说明'],
    ['下列说法正确的是：', '选项A内容', '选项B内容', '选项C内容', '选项D内容', 'A', '解析内容', '数学', '高等数学', 'single', '', '分类', '可选子分类'],
    ['', '', '', '', '', '', '', '', '', '', '', '数学', '高等数学, 线性代数, 概率论与数理统计'],
    ['', '', '', '', '', '', '', '', '', '', '', '英语', '完形填空, 阅读理解, 翻译, 英语写作'],
    ['', '', '', '', '', '', '', '', '', '', '', '政治', '马克思主义基本原理, 毛中特, 思想道德与法治, 形势与政策'],
    ['', '', '', '', '', '', '', '', '', '', '', '专业课', '专业课综合'],
  ];

  // 添加空行供用户填写
  for (let i = 0; i < 100; i++) {
    wsData.push(['', '', '', '', '', '', '', '', '']);
  }

  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // 设置列宽
  ws['!cols'] = [
    { wch: 40 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 20 },
    { wch: 10 }, { wch: 30 }, { wch: 12 }, { wch: 14 },
    { wch: 2 }, { wch: 2 }, { wch: 12 }, { wch: 45 },
  ];

  // 数据验证（下拉列表）
  ws['!dataValidation'] = [
    { sqref: 'F2:F102', type: 'list', formula1: '"A,B,C,D"' },
    { sqref: 'H2:H102', type: 'list', formula1: '"数学,英语,政治,专业课"' },
    { sqref: 'I2:I102', type: 'list', formula1: `"${allSubCategories.join(',')}"` },
    { sqref: 'J2:J102', type: 'list', formula1: '"single,multiple,judge,fill,subjective"' },
  ];

  XLSX.utils.book_append_sheet(wb, ws, '题目导入');
  XLSX.writeFile(wb, '题目导入模板.xlsx');
}

export default function ImportPaper({ onBack, onImportComplete }) {
  const [step, setStep] = useState(0); // 0: 选择方式, 1: 选择文件, 2: 配置选项, 3: 预览确认, 4: 解析结果
  const [importMode, setImportMode] = useState(null); // 'ai' | 'template'
  const [file, setFile] = useState(null);
  const [answerFile, setAnswerFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [config, setConfig] = useState({
    category: 'math',
    paperTitle: '',
    year: new Date().getFullYear(),
    recognitionScope: '',
    solveMissingAnswers: false,
  });
  const [parsedQuestions, setParsedQuestions] = useState([]);
  const [duplicateSummary, setDuplicateSummary] = useState({ unique: 0, duplicate: 0, review: 0 });
  const [parsing, setParsing] = useState(false);
  const [parseProgress, setParseProgress] = useState('');
  const [recognitionEngineLabel, setRecognitionEngineLabel] = useState('');
  const [parseError, setParseError] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [importHistory, setImportHistory] = useState([]);
  const [autoCommit, setAutoCommit] = useState(() => {
    try { return localStorage.getItem(AUTO_COMMIT_KEY) !== '0'; } catch (error) { return true; }
  });
  const [lastTaskSummary, setLastTaskSummary] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [stagingSummary, setStagingSummary] = useState({ pending: 0, total: 0 });
  const [recoveryNotice, setRecoveryNotice] = useState('');
  const { alert: showAlert, confirm: showConfirm } = useDialog();
  const tasks = useImportTasks();
  const recognitionRequestRef = useRef('');
  const parsingCancelledRef = useRef(false);
  const parsingStateRef = useRef(false);
  const parseStageRef = useRef('准备解析');
  const stepRef = useRef(0);
  // 每个后台任务自带独立的取消标记、requestId、去重集合和待写入队列，互不干扰
  const activeRunsRef = ACTIVE_RUNS_REF;

  const runningTasks = tasks.filter((task) => task.status === 'running');
  const pendingManualCount = parsedQuestions.filter((question) => !question.committed
    && question.duplicateStatus !== 'duplicate'
    && question.answerStatus !== 'mismatch').length;

  useEffect(() => { stepRef.current = step; }, [step]);

  const makeRun = (taskId, snapshot) => ({
    id: taskId,
    requestId: `import_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    cancelled: false,
    config: { ...snapshot.config },
    answerFile: snapshot.answerFile || null,
    fileName: snapshot.fileName || '未命名文件',
    settings: snapshot.settings || getRoleSettings('vision'),
    autoCommit: snapshot.autoCommit !== false,
    canCommitEarly: false,
    stage: '准备中',
    stats: { recognized: 0, imported: 0, duplicates: 0, failedBlocks: 0, discarded: 0, recovered: 0 },
    errors: [],
    existing: null,
    existingLoad: null,
    existingTruncated: false,
    seen: new Set(),
    committed: new Set(),
    pending: [],
    preview: [],
    stagingDiscarded: [],
    paperId: null,
    flushChain: Promise.resolve(),
    disposeCanceller: null,
  });

  const updateParseStage = (run, stage) => {
    parseStageRef.current = stage;
    setParseProgress(stage);
    if (run) {
      run.stage = stage;
      patchImportTask(run.id, { stage });
    }
  };

  const syncTaskStats = (run) => {
    if (run) patchImportTask(run.id, { ...run.stats });
  };

  const recordTaskError = (run, message, isBlock = false) => {
    if (!run) return;
    const text = String(message || '').trim().slice(0, 260);
    if (!text) return;
    run.errors.push(text);
    addImportTaskError(run.id, text);
    if (isBlock) {
      run.stats.failedBlocks += 1;
      syncTaskStats(run);
    }
  };

  const throwIfCancelled = (run) => {
    if (!run?.cancelled) return;
    const error = new Error('解析已停止');
    error.name = 'AbortError';
    throw error;
  };

  const cancelRun = (run) => {
    if (!run || run.cancelled) return;
    run.cancelled = true;
    parsingCancelledRef.current = true;
    const requestId = run.requestId;
    if (requestId && window.openexam?.ai?.cancelRecognition) {
      window.openexam.ai.cancelRecognition(requestId).catch(() => {});
    }
    patchImportTask(run.id, { stage: '正在停止，已识别的题目会自动入库' });
  };

  const cancelParsing = () => {
    activeRunsRef.current.forEach((run) => cancelRun(run));
    setParsing(false);
    updateParseStage(null, '正在停止，已识别的题目会自动入库');
  };

  const refreshParsingState = () => {
    const active = activeRunsRef.current.size > 0;
    setParsing(active);
    parsingStateRef.current = active;
    if (!active) setParseProgress('');
  };

  const formatParseError = (error, stage = '') => {
    const message = String(error?.message || error || '未知错误').trim();
    const lower = message.toLowerCase();
    let reason = message;
    let suggestion = '请检查文件内容、识别范围和 AI 配置后重试。';

    // 网关配置类错误必须排在通用 JSON 兜底之前，否则会被误报成「模型输出不是合法 JSON」
    if (/base url|网页 html|不是模型结果|没有返回可用的模型文本|no available channel|可用通道|响应缺少|服务端返回了|空的 (?:choices|output|content) 数组/.test(lower)) {
      reason = `AI 网关没有返回有效的模型响应：${message}`;
      suggestion = '进入「设置 → AI 模型」：确认 Base URL 指向 API 接口地址（兼容网关通常要补 /v1），确认模型名、API Key 分组和可用通道；修正后先点「测试连接」再重新导入。';
    } else if (/401|403|unauthor|api key|apikey|鉴权|密钥/.test(lower)) {
      reason = 'AI 服务鉴权失败，API Key 无效、过期或没有权限。';
      suggestion = '进入“设置 → AI 模型”，重新检查 API Key、Base URL 和模型名称，再测试连接。';
    } else if (/429|rate.?limit|too many|限流|频率/.test(lower)) {
      reason = 'AI 服务触发限流，当前请求过于频繁或并发过高。';
      suggestion = '稍等后重试，或减少 PDF 页数/分批上传；扫描 PDF 默认最多并发 3 页。';
    } else if (/timeout|timed out|network|fetch failed|连接|网络|econn|socket/.test(lower)) {
      reason = '无法连接 AI 服务，可能是网络中断、请求超时或服务端暂时不可用。';
      suggestion = '确认网络和 Base URL 可访问，再测试连接；大文件可缩小识别范围后重试。';
    } else if (/无法解析返回结果|json|模型.*解析|识别结果无法解析|不是有效/.test(lower)) {
      reason = '模型返回了内容，但不是完整、合法的 JSON 题目结构，可能被截断或混入了解释文字。';
      suggestion = '换用支持视觉/结构化输出的模型，减少一次上传页数，或缩小识别范围后重试。';
    } else if (/ocr 返回为空|ocr.*empty|返回为空/.test(lower)) {
      reason = 'OCR 服务没有返回可用文本。';
      suggestion = '检查 OCR 地址和响应格式，或在设置中切换为“仅 AI 引擎”；同时确认图片/PDF 清晰可读。';
    } else if (/json 格式不正确|unexpected token|非法|文件内容为空/.test(lower)) {
      reason = '本地文件格式不符合导入要求，或文件内容为空。';
      suggestion = '检查 JSON 是否包含 questions 数组，或改用 Excel/CSV 模板导入。';
    }

    // 用任务自己的阶段，而不是组件级共享 ref：并发多个任务时旧写法会报错到别人的步骤
    return `失败步骤：${stage || parseStageRef.current}\n原因：${reason}\n建议：${suggestion}`;
  };

  useEffect(() => {
    parsingStateRef.current = parsing;
  }, [parsing]);

  useEffect(() => {
    // 只登记一个只读的守卫；组件卸载（例如切到全屏考试页）时绝不取消任务，
    // 后台识别由模块级任务队列继续推进，进度写入全局上传记录。
    const guard = {
      isActive: () => parsingStateRef.current,
      stop: cancelParsing,
    };
    window.__studyStudioImportGuard = guard;
    return () => {
      if (window.__studyStudioImportGuard === guard) delete window.__studyStudioImportGuard;
    };
  }, []);

  const refreshHistory = async () => {
    if (!window.openexam?.db?.getImportedPapers) return;
    try {
      setImportHistory(await window.openexam.db.getImportedPapers());
    } catch (e) {
      console.error('加载导入历史失败:', e);
    }
  };

  const refreshStagingSummary = async () => {
    try {
      const summary = await window.openexam?.db?.getStagingSummary?.({});
      if (summary) setStagingSummary(summary);
    } catch (error) {
      console.warn('[Import] 读取暂存统计失败', error);
    }
  };

  // 加载导入历史 + 暂存统计（有 pending 说明上次有题没写完）
  useEffect(() => {
    refreshHistory();
    refreshStagingSummary();
  }, []);

  const handleRecoverStaging = async () => {
    if (recovering) return;
    setRecovering(true);
    try {
      const result = await window.openexam?.db?.recoverStagedImports?.({ force: true });
      const recovered = Number(result?.recovered || 0);
      const duplicates = Number(result?.duplicates || 0);
      await refreshStagingSummary();
      await refreshHistory();
      setRecoveryNotice(recovered > 0
        ? `已把 ${recovered} 道暂存题目补写进题库${duplicates ? `，另有 ${duplicates} 道题库中已存在` : ''}。`
        : '没有需要补写的暂存题目。');
      if (recovered > 0) {
        onImportComplete?.({
          paperId: result?.paperIds?.[0] || null,
          title: '暂存题目恢复',
          imported: recovered,
          source: 'recovery',
        });
      }
    } catch (error) {
      setRecoveryNotice(`恢复失败：${String(error?.message || error)}`);
    } finally {
      setRecovering(false);
    }
  };

  // 检查是否配置了 AI
  const hasRecognitionConfig = () => isRoleConfigured('vision') || isOCRConfigured();

  const IMAGE_MIME_BY_EXT = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
  };

  // Windows 上拖拽进来的图片 File.type 可能为空；部分视觉服务也不接受 gif/bmp。
  // 按扩展名确定 MIME，并把不受支持的格式统一转成 PNG，保证 data URL 与实际内容一致。
  const convertImageToPng = (dataUrl) => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth || image.width;
      canvas.height = image.naturalHeight || image.height;
      canvas.getContext('2d').drawImage(image, 0, 0);
      resolve(canvas.toDataURL('image/png').split(',')[1]);
    };
    image.onerror = () => reject(new Error('图片解码失败，请改用 PNG / JPG 格式'));
    image.src = dataUrl;
  });

  const readFileAsBase64 = async (targetFile) => {
    const ext = targetFile.name.split('.').pop().toLowerCase();
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.readAsDataURL(targetFile);
    });
    const mimeType = IMAGE_MIME_BY_EXT[ext] || targetFile.type || 'image/png';
    if (mimeType === 'image/gif' || mimeType === 'image/bmp' || !mimeType.startsWith('image/')) {
      return { base64: await convertImageToPng(dataUrl), mimeType: 'image/png' };
    }
    return { base64: dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl, mimeType };
  };

  // 显式页码范围优先于「PDF 最大页数」，并统一夹到真实页数内。
  // 旧逻辑先按 pdfMaxPages 截断再取范围，填「20-30」会得到 0 页且静默失败。
  const resolvePdfPageRange = (numPages, maxPages, scope = '') => {
    const hardLimit = Math.max(1, Math.min(20, Number(maxPages) || 6));
    const rangeMatch = String(scope || '').match(/(\d+)\s*(?:-|至|到)\s*(\d+)/i);
    if (rangeMatch) {
      const startPage = Math.max(1, Math.min(numPages, Number(rangeMatch[1]) || 1));
      const requestedEnd = Math.max(startPage, Math.min(numPages, Number(rangeMatch[2]) || numPages));
      const endPage = Math.min(requestedEnd, startPage + hardLimit - 1);
      return { startPage, endPage, capped: endPage < requestedEnd, total: numPages };
    }
    return { startPage: 1, endPage: Math.min(numPages, hardLimit), capped: numPages > hardLimit, total: numPages };
  };

  const renderPdfToImages = async (run, targetFile, maxPages = 6, scope = '') => {
    const [pdfjsLib, workerSrcModule] = await Promise.all([
      import('pdfjs-dist/build/pdf.mjs'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]);
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrcModule.default;

    const bytes = await targetFile.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const { startPage, endPage, capped } = resolvePdfPageRange(pdf.numPages, maxPages, scope);
    if (capped) recordTaskError(run, `PDF 共 ${pdf.numPages} 页，本次只处理第 ${startPage}-${endPage} 页；需要更多请在设置里调大「PDF 最大页数」或分次上传。`);
    const pages = [];

    for (let pageIndex = startPage; pageIndex <= endPage; pageIndex++) {
      throwIfCancelled(run);
      const page = await pdf.getPage(pageIndex);
      const viewport = page.getViewport({ scale: 1.8 });
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: context, viewport }).promise;
      pages.push(canvas.toDataURL('image/png').split(',')[1]);
    }

    return pages;
  };

  const extractPdfText = async (run, targetFile, maxPages = 6, scope = '') => {
    const [pdfjsLib, workerSrcModule] = await Promise.all([
      import('pdfjs-dist/build/pdf.mjs'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]);
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrcModule.default;
    const bytes = await targetFile.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const { startPage, endPage, capped } = resolvePdfPageRange(pdf.numPages, maxPages, scope);
    if (capped) recordTaskError(run, `PDF 共 ${pdf.numPages} 页，本次只读取第 ${startPage}-${endPage} 页文本。`);
    const chunks = [];
    for (let pageIndex = startPage; pageIndex <= endPage; pageIndex += 1) {
      throwIfCancelled(run);
      const page = await pdf.getPage(pageIndex);
      const content = await page.getTextContent();
      const text = content.items.map((item) => item.str || '').join(' ').trim();
      if (text) chunks.push(`\n[第${pageIndex}页]\n${text}`);
    }
    return chunks.join('\n');
  };

  const mergeRecognizedQuestions = (segments = [], fallbackCategory) => (Array.isArray(segments) ? segments : [])
    .flatMap((segment) => (Array.isArray(segment?.questions) ? segment.questions : []))
    .filter((question) => question && typeof question === 'object'
      && (String(question.content || '').trim()
        || String(question.contentHtml || question.content_html || '').trim()))
    // 选项对象 {key, content} 不是题目，模型返回片段时不要混进题库
    .filter((question) => !('key' in question) || Array.isArray(question.options) || question.type || question.answer)
    .map((question) => ({
      ...question,
      category: categoryNameToKey[String(question.category || '').trim()] || question.category || fallbackCategory,
      subCategory: question.subCategory || '',
      type: normalizeImportedQuestionType(question.type),
    }));

  // 每个任务只扫一次已有题库，之后把新写入的题目也加进索引，
  // 这样「边识别边入库」时不会对同一道题重复写入。
  const loadExistingContents = async (run) => {
    if (run.existing) return run.existing;
    if (!run.existingLoad) {
      run.existingLoad = (async () => {
        const contents = [];
        try {
          // 扫描全部用户试卷：旧版只扫前 60 份 / 6000 条，后面的题会被重复导入
          const papers = await window.openexam?.db?.getPapers?.();
          for (const paper of (papers || [])) {
            if (run.cancelled) break;
            const rows = await window.openexam.db.getQuestions(paper.id);
            (rows || []).forEach((row) => {
              if (row?.content) contents.push(String(row.content));
            });
            if (contents.length > 30000) {
              run.existingTruncated = true;
              break;
            }
          }
        } catch (error) {
          console.warn('[Import] 读取已有题库失败，仅做任务内去重', error);
        }
        run.existing = contents;
        return contents;
      })();
    }
    return run.existingLoad;
  };

  const isExistingDuplicate = (run, content) => (run.existing || [])
    .some((item) => questionSimilarity(content, item) >= DEDUPE_THRESHOLD);

  const markStaged = async (run, questions, status, reason, paperId = null) => {
    const ids = (questions || []).map((question) => question?.stagingId).filter(Boolean);
    if (!ids.length) return;
    try {
      await window.openexam?.db?.updateStagedQuestions?.({ ids, status, reason, paperId });
    } catch (error) {
      // 暂存表只做状态标记，失败不影响正式入库；启动恢复会兜底
      console.warn('[Import] 更新暂存状态失败', error);
    }
  };

  // 单个文本块/页面成功就立刻收集，不等待其它块；失败由 runConcurrent 单独记录
  const collectQuestions = async (run, rawQuestions) => {
    const questions = mergeRecognizedQuestions([{ questions: rawQuestions }], run.config.category)
      .map((question) => ({
        ...question,
        answer: normalizeImportedAnswer(question.answer, question.type),
        answerStatus: question.answerStatus || '',
        answerSource: question.answerSource || 'recognition',
        duplicateStatus: 'unique',
        committed: false,
      }));
    if (!questions.length) return;

    // 第一优先级：识别成功立刻落盘到 import_staging。
    // 之后无论去重、写库、切页、崩溃还是重启，这些题都能从暂存表恢复。
    try {
      const staged = await window.openexam?.db?.stageImportedQuestions?.({
        taskId: run.id,
        batchId: String(run.stats.recognized),
        paperData: {
          title: run.config.paperTitle || run.fileName,
          year: run.config.year,
          subject: 'kaoyan',
          category: run.config.category,
        },
        fileName: run.fileName,
        category: run.config.category,
        autoCommit: run.autoCommit,
        questions,
      });
      const ids = staged?.ids || [];
      questions.forEach((question, index) => { question.stagingId = ids[index] || ''; });
    } catch (error) {
      recordTaskError(run, `暂存题目失败：${String(error?.message || error).slice(0, 160)}`);
    }

    await loadExistingContents(run);
    const added = [];
    questions.forEach((question) => {
      const key = contentKeyOf(question);
      if (!key || run.seen.has(key)) return;
      run.seen.add(key);
      if (isExistingDuplicate(run, question.content)) {
        question.duplicateStatus = 'duplicate';
        question.stagingId && run.stagingDiscarded.push(question.stagingId);
        run.stats.duplicates += 1;
      }
      run.preview.push(question);
      if (question.duplicateStatus !== 'duplicate') added.push(question);
    });
    run.stats.recognized = run.seen.size;
    syncTaskStats(run);
    if (added.length) {
      run.pending.push(...added);
      if (run.canCommitEarly) {
        updateParseStage(run, `已识别 ${run.stats.recognized} 道，正在自动入库...`);
        await flushPending(run);
      }
    }
  };

  const doFlush = async (run) => {
    if (!run.autoCommit || !run.pending.length) return;
    const candidates = run.pending;
    run.pending = [];
    const fresh = [];
    candidates.forEach((question) => {
      const key = contentKeyOf(question);
      if (!key || run.committed.has(key)) return;
      if (question.answerStatus === 'mismatch') {
        run.pending.push(question); // 答案冲突留给人工核对后补录
        return;
      }
      if (isExistingDuplicate(run, question.content)) {
        question.duplicateStatus = 'duplicate';
        question.stagingId && run.stagingDiscarded.push(question.stagingId);
        run.stats.duplicates += 1;
        return;
      }
      fresh.push(question);
    });
    if (!fresh.length) { syncTaskStats(run); return; }

    try {
      const paperData = {
        title: run.config.paperTitle || run.fileName,
        year: run.config.year,
        subject: 'kaoyan',
      };
      let writeResult = null;
      if (!run.paperId) {
        writeResult = await window.openexam.db.importPaper(paperData, fresh);
        run.paperId = writeResult?.paperId || null;
      } else if (window.openexam?.db?.appendImportedQuestions) {
        writeResult = await window.openexam.db.appendImportedQuestions(run.paperId, fresh);
      } else {
        writeResult = await window.openexam.db.importPaper(paperData, fresh);
      }
      // 以主进程真实写入条数对齐统计：isFakeQuestion 过滤掉的伪题不再虚增「已入库」
      const savedCount = Number(writeResult?.appended ?? writeResult?.questionCount ?? fresh.length);
      const filteredCount = Number(writeResult?.filtered || 0);
      if (filteredCount > 0) {
        run.stats.discarded += filteredCount;
        recordTaskError(run, `主进程过滤了 ${filteredCount} 道无效题目（空题干或占位文案）`);
      }
      fresh.forEach((question) => {
        run.committed.add(contentKeyOf(question));
        question.committed = true;
        (run.existing ||= []).push(String(question.content));
      });
      await markStaged(run, fresh, 'committed', null, run.paperId);
      run.stats.imported += Math.max(0, savedCount);
      patchImportTask(run.id, { imported: run.stats.imported, paperId: run.paperId });
    } catch (error) {
      recordTaskError(run, `写入题库失败：${String(error?.message || error).slice(0, 180)}`);
      run.pending.unshift(...fresh); // 下一次收尾时重试
    }
    syncTaskStats(run);
  };

  // 串行化写入，避免多个识别块同时创建试卷
  const flushPending = (run) => {
    run.flushChain = (run.flushChain || Promise.resolve())
      .then(() => doFlush(run))
      .catch((error) => { recordTaskError(run, `入库异常：${String(error?.message || error).slice(0, 180)}`); });
    return run.flushChain;
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    setDragOver(false);
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile) {
      await validateAndSetFile(droppedFile);
    }
  };

  const handleFileSelect = async (e) => {
    const selectedFile = e.target.files[0];
    if (selectedFile) {
      await validateAndSetFile(selectedFile);
    }
  };

  const validateAndSetFile = async (f) => {
    const ext = f.name.split('.').pop().toLowerCase();

    if (importMode === 'ai') {
      if (['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'txt', 'md', 'markdown', 'text', 'tex'].includes(ext)) {
        setFile(f);
        setConfig(prev => ({ ...prev, paperTitle: f.name.replace(/\.[^/.]+$/, '') }));
        setStep(2);
      } else {
        await showAlert({ title: '文件类型不支持', message: '请选择 PDF、图片或 TXT/Markdown/TeX 文本文件。', tone: 'warning' });
      }
    } else {
      if (['csv', 'xls', 'xlsx', 'json'].includes(ext)) {
        setFile(f);
        setConfig(prev => ({ ...prev, paperTitle: f.name.replace(/\.[^/.]+$/, '') }));
        setStep(2);
      } else {
        await showAlert({ title: '文件类型不支持', message: '请选择 Excel、CSV 或 JSON 文件。', tone: 'warning' });
      }
    }
  };

  const validateAndSetAnswerFile = async (f) => {
    const ext = f.name.split('.').pop().toLowerCase();
    if (['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'txt', 'md', 'markdown', 'text', 'tex', 'csv', 'json'].includes(ext)) {
      setAnswerFile(f);
      return;
    }
    await showAlert({ title: '答案文件类型不支持', message: '请选择 PDF、图片、TXT/Markdown/TeX、CSV 或 JSON 文件。', tone: 'warning' });
  };

  const getFileIcon = () => {
    if (!file) return null;
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'pdf') return '📄';
    if (['doc', 'docx'].includes(ext)) return '📝';
    if (ext === 'csv') return '📊';
    if (['xls', 'xlsx'].includes(ext)) return '📊';
    if (ext === 'json') return '🧩';
    return '📁';
  };

  const formatFileSize = (bytes) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  // 分类名称映射
  const categoryNameToKey = {
    '数学': 'math',
    '英语': 'english',
    '政治': 'politics',
    '专业课': 'major',
  };

  const normalizeJsonQuestion = (rawQuestion) => {
    if (!rawQuestion || typeof rawQuestion !== 'object') return null;
    const contentHtml = String(rawQuestion.contentHtml || rawQuestion.content_html || '').trim();
    const content = String(rawQuestion.content || '').trim() || contentHtml;
    if (!content) return null;

    const questionType = normalizeImportedQuestionType(rawQuestion.type);
    const normalizedOptions = Array.isArray(rawQuestion.options)
      ? rawQuestion.options
          .map((option, index) => {
            if (option && typeof option === 'object') {
              return {
                key: String(option.key || String.fromCharCode(65 + index)).toUpperCase(),
                content: String(option.content || ''),
              };
            }
            return {
              key: String.fromCharCode(65 + index),
              content: String(option || ''),
            };
          })
          .filter((option) => option.content)
      : [];

    // 判断题通常没有 options，旧逻辑会把它们整条丢掉；这里补上「正确/错误」选项
    if (questionType === 'judge' && normalizedOptions.length === 0) {
      normalizedOptions.push({ key: 'A', content: '正确' }, { key: 'B', content: '错误' });
    }
    if (normalizedOptions.length === 0 && !['fill', 'subjective'].includes(questionType)) return null;

    const categoryRaw = String(rawQuestion.category || '').trim();
    const category = categoryNameToKey[categoryRaw] || categoryRaw || config.category;

    const normalizeJudgeAnswer = (answer) => {
      if (questionType !== 'judge') return answer;
      const raw = String(answer || '').trim().toUpperCase();
      if (['对', '正确', '是', 'T', 'TRUE', 'A', '√', '✓'].includes(raw)) return 'A';
      if (['错', '错误', '否', 'F', 'FALSE', 'B', '×', '✗'].includes(raw)) return 'B';
      return raw;
    };

    return {
      content,
      contentHtml: contentHtml || '',
      options: normalizedOptions,
      answer: normalizeJudgeAnswer(normalizeImportedAnswer(rawQuestion.answer, questionType)),
      analysis: String(rawQuestion.analysis || ''),
      tags: Array.isArray(rawQuestion.tags) ? rawQuestion.tags : String(rawQuestion.tags || '').split(/[,，、|]/).map((tag) => tag.trim()).filter(Boolean),
      category,
      subCategory: String(rawQuestion.subCategory || rawQuestion.sub_category || ''),
      chapter: String(rawQuestion.chapter || '').trim(),
      points: Array.isArray(rawQuestion.points)
        ? rawQuestion.points
        : String(rawQuestion.points || rawQuestion.knowledgePoints || '').split(/[,，、|]/).map((point) => point.trim()).filter(Boolean),
      type: questionType,
      difficulty: Number(rawQuestion.difficulty) || 2,
    };
  };

  const parseJsonFile = async (targetFile) => {
    const text = await targetFile.text();
    const parsed = JSON.parse(text);
    const candidate = Array.isArray(parsed)
      ? parsed
      : (Array.isArray(parsed?.questions) ? parsed.questions : parsed?.data?.questions);

    if (!Array.isArray(candidate)) {
      throw new Error('JSON 格式不正确，需要 questions 数组');
    }

    return candidate
      .map((item) => normalizeJsonQuestion(item))
      .filter(Boolean);
  };

  // 解析 Excel/CSV 文件
  const parseFile = async (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target.result);
          const workbook = XLSX.read(data, { type: 'array' });
          const sheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[sheetName];
          const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

          if (jsonData.length < 2) {
            reject(new Error('文件内容为空或格式不正确'));
            return;
          }

          const questions = [];
          // 模板自带一行示例（“下列说法正确的是：/ 选项A内容…”），不能当成真实题目导入
          const isTemplatePlaceholderRow = (row) => {
            const content = String(row[0] || '').trim();
            const optionA = String(row[1] || '').trim();
            const optionB = String(row[2] || '').trim();
            const placeholder = (value) => /^选项[A-D]内容$/.test(value);
            if (content === '下列说法正确的是：' && placeholder(optionA)) return true;
            return placeholder(optionA) && placeholder(optionB);
          };
          // 从第2行开始（索引1），第1行是表头
          for (let i = 1; i < jsonData.length; i++) {
            const row = jsonData[i];
            // 跳过空行
            if (!row || row.length === 0) continue;
            if (isTemplatePlaceholderRow(row)) continue;

            // 获取题目内容（第1列）
            const content = String(row[0] || '').trim();
            // 跳过空题目或示例数据的占位行
            if (!content) continue;

            // 检查是否有有效的选项（至少有A选项）
            const optionA = String(row[1] || '').trim();
            const questionType = normalizeImportedQuestionType(row[9] || (optionA ? 'single' : 'subjective'));
            if (!optionA && !['fill', 'subjective'].includes(questionType)) continue;

            const categoryName = String(row[7] || '').trim();
            const categoryKey = categoryNameToKey[categoryName] || config.category;

            questions.push({
              content: content,
              options: [
                { key: 'A', content: String(row[1] || '') },
                { key: 'B', content: String(row[2] || '') },
                { key: 'C', content: String(row[3] || '') },
                { key: 'D', content: String(row[4] || '') },
              ],
              answer: normalizeImportedAnswer(row[5], questionType),
              analysis: String(row[6] || ''),
              category: categoryKey,
              subCategory: String(row[8] || ''),
              type: questionType,
            });
          }
          resolve(questions);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.readAsArrayBuffer(file);
    });
  };

  // 解析 CSV 行（处理引号内的逗号）
  const parseCSVLine = (line) => {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  };

  const readTextFile = async (targetFile) => {
    const text = await targetFile.text();
    if (!text.trim()) throw new Error(`${targetFile.name} 内容为空`);
    return text;
  };

  // 任一块失败只记录错误并继续其它块：这是「不要求 100% 识别成功」的关键
  const runConcurrent = async (run, items, worker, limit = 3, describeError = null) => {
    const results = new Array(items.length);
    let cursor = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length && !run.cancelled) {
        const index = cursor;
        cursor += 1;
        try {
          results[index] = await worker(items[index], index);
        } catch (error) {
          results[index] = null;
          if (run.cancelled || error?.name === 'AbortError') {
            run.cancelled = true;
            return;
          }
          const text = describeError
            ? describeError(error, index)
            : String(error?.message || error).slice(0, 200);
          recordTaskError(run, text, true);
        }
      }
    });
    await Promise.all(runners);
    return results;
  };

  // 长文本一次性要求模型输出全部题目时，容易在 JSON 完成前达到输出上限。
  // 优先按 PDF 页标记分块；普通 TXT/Markdown 则按换行和字符数分块。
  const splitTextForRecognition = (text, maxChars = 2800) => {
    const source = String(text || '').trim();
    if (!source) return [];
    const blocks = source
      .split(/(?=\n?\[第\d+页\]|^\\(?:section|subsection|qhead|secA)\*?\{|^#{1,6}\s)/gm)
      .map((block) => block.trim())
      .filter(Boolean);
    const chunks = [];
    let current = '';
    const appendPiece = (piece) => {
      const value = String(piece || '').trim();
      if (!value) return;
      if (value.length <= maxChars) {
        if (current && current.length + value.length + 1 > maxChars) {
          chunks.push(current);
          current = '';
        }
        current = current ? `${current}\n${value}` : value;
        return;
      }
      const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        if (line.length > maxChars) {
          for (let offset = 0; offset < line.length; offset += maxChars) appendPiece(line.slice(offset, offset + maxChars));
        } else {
          appendPiece(line);
        }
      }
    };
    (blocks.length ? blocks : [source]).forEach(appendPiece);
    if (current) chunks.push(current);
    return chunks;
  };

  const recognizeTextInBatches = async (run, text, settings, role, label, sourceFormat = '', onQuestions = null) => {
    const chunks = splitTextForRecognition(text);
    if (!chunks.length) return role === 'answers' ? { answers: [] } : { questions: [] };
    const call = (chunk) => (role === 'answers'
      ? window.openexam.ai.structureAnswersFromText(settings, chunk, { scope: run.config.recognitionScope }, run.requestId)
      : window.openexam.ai.structureQuestionsFromText(settings, chunk, { scope: run.config.recognitionScope, sourceFormat }, run.requestId));

    if (chunks.length === 1) {
      try {
        const result = await call(chunks[0]);
        if (result?.error) throw new Error(result.error);
        const payload = result || {};
        if (role === 'questions' && onQuestions) await onQuestions(payload.questions || []);
        return payload;
      } catch (error) {
        if (run.cancelled || error?.name === 'AbortError') throw error;
        recordTaskError(run, `${label}：${String(error?.message || error).slice(0, 200)}`, true);
        return role === 'answers' ? { answers: [] } : { questions: [] };
      }
    }

    updateParseStage(run, `${label}：已拆分为 ${chunks.length} 个文本块，并发识别中...`);
    let done = 0;
    const results = await runConcurrent(run, chunks, async (chunk, index) => {
      const result = await call(chunk);
      throwIfCancelled(run);
      if (result?.error) throw new Error(result.error);
      done += 1;
      updateParseStage(run, `${label}：已完成 ${done}/${chunks.length} 个文本块`);
      if (role === 'questions' && onQuestions) await onQuestions(result?.questions || []);
      return result || {};
    }, 3, (error, index) => `${label}第 ${index + 1}/${chunks.length} 个文本块失败：${String(error?.message || error).slice(0, 180)}`);
    return role === 'answers'
      ? { answers: results.flatMap((result) => result?.answers || []) }
      : { questions: results.flatMap((result) => result?.questions || []) };
  };

  const recognizeDocument = async (run, targetFile, settings, role = 'questions', onQuestions = null) => {
    const ext = targetFile.name.split('.').pop().toLowerCase();
    const scopeSettings = {
      ...settings,
      recognitionScope: run.config.recognitionScope,
      // 主进程据此判断自动模式下扫描 PDF 是否交给 OCR 引擎 B
      recognitionSource: ext === 'pdf' ? 'pdf' : 'image',
    };
    setRecognitionEngineLabel(`${settings.aiProvider || 'AI'} · ${settings.model || settings.customModel || '当前模型'}`);
    if (role === 'answers' && ['csv', 'json'].includes(ext)) {
      const text = await readTextFile(targetFile);
      if (ext === 'json') {
        const parsed = JSON.parse(text);
        const answers = Array.isArray(parsed) ? parsed : (parsed.answers || parsed.data?.answers || []);
        return { answers: answers.map((item, index) => ({ number: String(item.number || item.index || index + 1), answer: String(item.answer || item.correctAnswer || '').trim(), analysis: String(item.analysis || '') })) };
      }
      const answers = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
        const parts = parseCSVLine(line);
        return { number: String(parts[0] || index + 1), answer: String(parts[1] || '').trim(), analysis: parts.slice(2).join(',').trim() };
      });
      return { answers };
    }
    if (['txt', 'md', 'markdown', 'text', 'tex'].includes(ext)) {
      updateParseStage(run, `${role === 'answers' ? '答案' : '题目'}文本 AI 识别`);
      const text = await readTextFile(targetFile);
      return recognizeTextInBatches(run, text, scopeSettings, role, role === 'answers' ? '答案文本识别' : '题目文本识别', ext, onQuestions);
    }

    if (ext === 'pdf') {
      updateParseStage(run, `${role === 'answers' ? '答案' : '题目'}文件：正在读取 PDF 文本层...`);
      const pdfText = await extractPdfText(run, targetFile, settings.pdfMaxPages, run.config.recognitionScope);
      if (pdfText.trim().length >= 120) {
        const result = await recognizeTextInBatches(run, pdfText, scopeSettings, role, role === 'answers' ? '答案 PDF 文本识别' : '题目 PDF 文本识别', '', onQuestions);
        updateParseStage(run, `${role === 'answers' ? '答案' : '题目'} PDF 文本识别完成`);
        return result || (role === 'answers' ? { answers: [] } : { questions: [] });
      }
    }

    const pages = ext === 'pdf'
      ? (await renderPdfToImages(run, targetFile, settings.pdfMaxPages, run.config.recognitionScope))
        .map((base64) => ({ base64, mimeType: 'image/png' }))
      : [await readFileAsBase64(targetFile)];
    if (!pages.length) {
      throw new Error('没有可识别的页面：请检查页码范围（例如「1-5」），或调大设置里的「PDF 最大页数」后重试。');
    }
    updateParseStage(run, `${role === 'answers' ? '答案' : '题目'}识别：共 ${pages.length} 页，并发处理中...`);
    let done = 0;
    const results = await runConcurrent(run, pages, async (page, pageIndex) => {
      const imageBase64 = typeof page === 'string' ? page : page.base64;
      const mimeType = typeof page === 'string' ? 'image/png' : (page.mimeType || 'image/png');
      const result = role === 'answers'
        ? await window.openexam.ai.recognizeAnswers(scopeSettings, imageBase64, mimeType, run.requestId)
        : await window.openexam.ai.recognizeQuestions(scopeSettings, imageBase64, mimeType, run.requestId);
      throwIfCancelled(run);
      if (result?.error) throw new Error(result.error);
      done += 1;
      updateParseStage(run, `${role === 'answers' ? '答案' : '题目'}识别：已完成 ${done}/${pages.length} 页`);
      if (role === 'questions' && onQuestions) await onQuestions(result?.questions || []);
      return result || {};
    }, 3, (error, index) => `${role === 'answers' ? '答案' : '题目'}第 ${index + 1}/${pages.length} 页失败：${String(error?.message || error).slice(0, 180)}`);
    if (role === 'answers') {
      return { answers: results.flatMap((result) => result?.answers || []) };
    }
    return { questions: results.flatMap((result) => result?.questions || []) };
  };

  const matchQuestionAnswersInBatches = async (run, questions, answers, settings, options = {}) => {
    // 只配置了 OCR 引擎时没有可用的 AI 模型，按题号本地对齐，避免匹配阶段报鉴权错误
    if (!isRoleConfigured('vision')) {
      updateParseStage(run, '答案本地匹配（未配置 AI 模型）');
      return questions.map((question, index) => {
        const answer = answers.find((item) => String(item?.number || '').trim() === String(index + 1)) || answers[index];
        const value = String(answer?.answer || '').trim();
        return {
          questionIndex: index + 1,
          answer: value,
          analysis: String(answer?.analysis || ''),
          status: value ? 'matched' : 'missing',
          reason: value ? '' : '仅 OCR 模式没有可用 AI 模型，答案按题号本地对齐',
          confidence: value ? 0.6 : 0,
        };
      });
    }
    const batchSize = 25;
    const batches = [];
    for (let offset = 0; offset < questions.length; offset += batchSize) {
      batches.push({ offset, questions: questions.slice(offset, offset + batchSize) });
    }
    updateParseStage(run, `题目与答案匹配：共 ${batches.length} 个批次`);
    const results = await runConcurrent(run, batches, async (batch) => {
      throwIfCancelled(run);
      const answerList = answers.length === questions.length
        ? answers.slice(batch.offset, batch.offset + batch.questions.length)
        : answers;
      const result = await window.openexam.ai.matchQuestionAnswers(
        settings,
        batch.questions,
        answerList,
        { scope: run.config.recognitionScope, solveMissing: Boolean(options.solveMissing) },
        run.requestId
      );
      throwIfCancelled(run);
      if (result?.error) throw new Error(result.error);
      updateParseStage(run, `题目与答案匹配：已完成 ${Math.min(batch.offset + batch.questions.length, questions.length)}/${questions.length} 道`);
      return (result?.matches || []).map((match) => ({
        ...match,
        questionIndex: Number(match.questionIndex) + batch.offset,
      }));
    }, 3, (error, index) => `答案匹配第 ${index + 1}/${batches.length} 批失败：${String(error?.message || error).slice(0, 180)}`);
    return results.flat();
  };

  // 答案匹配整体失败也不能丢掉已经识别好的题目，只记录提示后按原答案继续入库
  const applyAnswerMatches = async (run, answerPayload, settings, solveMissing) => {
    const questions = run.preview;
    if (!questions.length) return;
    if (!run.answerFile && !solveMissing) {
      questions.forEach((question) => {
        if (!question.answerStatus) question.answerStatus = question.answer ? 'recognition' : 'missing';
        question.answerSource = question.answerSource || 'recognition';
      });
      return;
    }
    let matches = [];
    try {
      matches = await matchQuestionAnswersInBatches(run, questions, answerPayload?.answers || [], settings, { solveMissing });
    } catch (error) {
      recordTaskError(run, `答案匹配失败：${String(error?.message || error).slice(0, 180)}`);
    }
    questions.forEach((question, index) => {
      const match = matches.find((item) => Number(item.questionIndex) === index + 1) || matches[index] || {};
      question.answer = normalizeImportedAnswer(match.answer || question.answer || '', question.type);
      question.analysis = String(match.analysis || question.analysis || '');
      question.answerStatus = match.status || (match.answer ? 'matched' : (question.answer ? 'unmatched' : 'missing'));
      question.answerReason = match.reason || '';
      question.answerConfidence = Number(match.confidence) || 0;
      question.answerSource = run.answerFile ? 'answer_file' : 'ai_solved';
    });
  };

  const finalizeTask = async (run, { cancelled = false, fatalError = null } = {}) => {
    // 无论正常完成、部分失败还是手动停止，都把已识别且不重复的题目写进题库
    await updateParseStage(run, run.autoCommit ? '正在收尾入库...' : '正在整理识别结果...');
    await flushPending(run);

    // 重复题从暂存表标记丢弃；其余仍为 pending 的题（答案冲突、写库失败、
    // 任务被中断、页面被卸载）统一补写进题库 —— 这是「传的题不会丢」的最后一道保险。
    if (run.stagingDiscarded.length) {
      await markStaged(run, run.stagingDiscarded.map((id) => ({ stagingId: id })), 'discarded', 'duplicate');
      run.stagingDiscarded = [];
    }
    if (run.autoCommit) {
      try {
        const recovery = await window.openexam?.db?.recoverStagedImports?.({ taskId: run.id, paperId: run.paperId });
        const recoveredCount = Number(recovery?.recovered || 0);
        if (recoveredCount > 0) {
          run.stats.recovered += recoveredCount;
          run.stats.imported += recoveredCount;
          if (!run.paperId && recovery?.paperIds?.[0]) run.paperId = recovery.paperIds[0];
        }
        run.recoveredAll = true;
      } catch (error) {
        recordTaskError(run, `暂存恢复失败：${String(error?.message || error).slice(0, 160)}`);
      }
    }

    const remaining = run.autoCommit
      ? run.pending.filter((question) => !run.committed.has(contentKeyOf(question))).length
      : 0;
    const hasFailures = run.stats.failedBlocks > 0 || run.errors.length > 0 || Boolean(fatalError);
    let status = 'done';
    if (cancelled) status = 'cancelled';
    else if (run.stats.imported === 0 && run.stats.recognized === 0) status = 'failed';
    else if (hasFailures || remaining > 0) status = 'partial';

    const stage = cancelled
      ? `已停止 · 入库 ${run.stats.imported} 道`
      : `完成 · 识别 ${run.stats.recognized} · 入库 ${run.stats.imported}${run.stats.recovered ? `（含恢复 ${run.stats.recovered}）` : ''} · 重复 ${run.stats.duplicates} · 失败块 ${run.stats.failedBlocks}`;
    patchImportTask(run.id, {
      status,
      stage,
      finishedAt: new Date().toISOString(),
      recognized: run.stats.recognized,
      imported: run.stats.imported,
      duplicates: run.stats.duplicates,
      failedBlocks: run.stats.failedBlocks,
      recovered: run.stats.recovered,
      paperId: run.paperId,
    });

    const summary = {
      ...run.stats,
      status,
      fileName: run.fileName,
      errors: run.errors.slice(-4),
      autoCommit: run.autoCommit,
      paperId: run.paperId,
    };
    setLastTaskSummary(summary);
    await refreshHistory();

    const reviewed = run.preview.map((question) => ({
      ...question,
      committed: Boolean(run.recoveredAll && question.duplicateStatus !== 'duplicate')
        || run.committed.has(contentKeyOf(question)),
    }));
    const duplicate = reviewed.filter((question) => question.duplicateStatus === 'duplicate').length;
    setParsedQuestions(reviewed);
    setDuplicateSummary({ unique: reviewed.length - duplicate, duplicate, review: 0 });
    if (reviewed.length > 0 && !cancelled && activeRunsRef.current.size <= 1 && stepRef.current === 3) {
      setStep(4);
    }
    if (run.autoCommit && run.stats.imported === 0 && !cancelled && !hasFailures) {
      setParseError('流程完成，但没有可入库的新题：可能文件中没有题目、全是重复题，或模型返回的 questions 数组为空。');
    }
    if (run.stats.imported > 0) {
      onImportComplete?.({
        paperId: run.paperId,
        title: run.config?.paperTitle || run.fileName,
        fileName: run.fileName,
        imported: run.stats.imported,
        source: 'auto',
      });
    }

    activeRunsRef.current.delete(run.id);
    run.disposeCanceller?.();
    recognitionRequestRef.current = '';
    refreshParsingState();
  };

  // 开始解析：新建一个后台任务，立刻返回，用户可以自由切到其它页面
  const handleStartParse = async () => {
    if (!file) return;
    const duplicateRun = Array.from(activeRunsRef.current.values())
      .find((run) => !run.cancelled && run.fileName === file.name);
    if (duplicateRun) {
      await showAlert({ title: '该文件正在识别', message: '这个文件已有一个后台任务，请等它完成或在上传记录里停止后重试。', tone: 'info' });
      return;
    }

    // 识题链路全部走「识图」角色：单独配置了视觉模型时，这里拿到的就是那份配置
    const settings = getRoleSettings('vision');
    const taskId = createImportTask({
      fileName: file.name,
      mode: importMode,
      engine: `${settings.aiProvider || ''} ${settings.model || settings.customModel || ''}`.trim(),
      autoCommit,
    });
    const run = makeRun(taskId, {
      config,
      answerFile,
      autoCommit,
      fileName: file.name,
      settings,
    });
    run.canCommitEarly = Boolean(autoCommit && !run.answerFile && !run.config.solveMissingAnswers);
    activeRunsRef.current.set(taskId, run);
    run.disposeCanceller = registerImportTaskCanceller(taskId, () => cancelRun(run));
    parsingCancelledRef.current = false;
    recognitionRequestRef.current = run.requestId;
    setParsing(true);
    setParseError(null);
    setParsedQuestions([]);
    setLastTaskSummary(null);
    updateParseStage(run, '准备识别文件...');

    const targetFile = file;
    let fatalError = null;
    let cancelled = false;

    try {
      throwIfCancelled(run);
      const ext = targetFile.name.split('.').pop().toLowerCase();

      if (['csv', 'xls', 'xlsx'].includes(ext)) {
        updateParseStage(run, '读取 Excel/CSV 模板');
        await collectQuestions(run, await parseFile(targetFile));
      } else if (ext === 'json') {
        updateParseStage(run, '读取 JSON 文件');
        await collectQuestions(run, await parseJsonFile(targetFile));
      } else {
        updateParseStage(run, '检查 AI 配置');
        setRecognitionEngineLabel(`${settings.aiProvider || 'AI'} · ${settings.model || settings.customModel || '当前模型'}`);
        if (!hasRecognitionConfig()) {
          throw new Error('没有检测到可用的 AI 模型或 OCR 服务配置；请进入「设置 → AI 模型」填写 API Key、模型和 Base URL，并先点击「测试连接」。');
        }

        updateParseStage(run, 'AI 题目识别');
        const questionPayload = await recognizeDocument(run, targetFile, settings, 'questions', (qs) => collectQuestions(run, qs));
        throwIfCancelled(run);
        // 兜底：某些分支没有逐块回调时，最后再收集一次
        const leftover = (questionPayload?.questions || [])
          .filter((question) => !run.seen.has(contentKeyOf(question)));
        if (leftover.length) await collectQuestions(run, leftover);

        let answerPayload = { answers: [] };
        if (run.answerFile) {
          updateParseStage(run, 'AI 答案识别');
          answerPayload = await recognizeDocument(run, run.answerFile, settings, 'answers');
          throwIfCancelled(run);
        }
        const solveMissing = Boolean(run.config.solveMissingAnswers);
        updateParseStage(run, run.answerFile ? '正在匹配题目与答案...' : '题目识别完成，正在整理题库...');
        await applyAnswerMatches(run, answerPayload, settings, solveMissing);
        throwIfCancelled(run);
      }
    } catch (err) {
      if (err?.name === 'AbortError' || run.cancelled) {
        cancelled = true;
      } else {
        fatalError = err;
        recordTaskError(run, `解析失败（${run.stage || parseStageRef.current}）：${String(err?.message || err).slice(0, 220)}`);
        setParseError(formatParseError(err, run.stage));
      }
    } finally {
      await finalizeTask(run, { cancelled, fatalError });
    }
  };

  // 人工补录：只写入尚未自动入库、且不是重复题的题目，避免二次写入
  const updateParsedAnswer = (index, value) => {
    setParsedQuestions((current) => current.map((question, questionIndex) => questionIndex === index
      ? { ...question, answer: normalizeImportedAnswer(value, question.type), answerStatus: 'user_reviewed', answerSource: 'user_review' }
      : question));
  };

  const handleConfirmImport = async () => {
    if (confirming) return;
    const importableQuestions = parsedQuestions.filter((question) => !question.committed
      && question.duplicateStatus !== 'duplicate'
      && question.answerStatus !== 'mismatch');
    if (importableQuestions.length === 0) {
      await showAlert({
        title: '没有需要补录的新题',
        message: '本次识别出的新题已经自动写入题库；重复题和答案待核对的题不会重复写入。',
        tone: 'info',
      });
      return;
    }
    setConfirming(true);
    try {
      const paperData = {
        title: config.paperTitle || lastTaskSummary?.fileName || '导入试卷',
        year: config.year,
        subject: 'kaoyan',
      };
      const result = await window.openexam.db.importPaper(paperData, importableQuestions);
      const savedCount = Number(result?.questionCount || importableQuestions.length);
      setParsedQuestions((current) => current.map((question) => (
        importableQuestions.includes(question) ? { ...question, committed: true } : question
      )));
      await markStaged(null, importableQuestions, 'committed', null, result?.paperId || null);
      await refreshStagingSummary();
      setLastTaskSummary((current) => current ? { ...current, imported: current.imported + savedCount } : current);
      await refreshHistory();
      await showAlert({ title: '补录成功', message: `共补录 ${savedCount} 道题目`, tone: 'success' });
      onImportComplete?.({
        paperId: result?.paperId || null,
        title: config.paperTitle,
        fileName: file?.name || '',
        imported: savedCount,
        source: 'manual',
      });
    } catch (err) {
      await showAlert({ title: '补录失败', message: err.message || '未知错误', tone: 'danger' });
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="import-page">
      <div className="import-header">
        <button className="back-btn" onClick={step === 0 && !showHistory ? onBack : () => { if (showHistory) setShowHistory(false); else setStep(step - 1); }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          返回
        </button>
        <h2>{showHistory ? '导入历史' : '导入试卷'}</h2>
        {!showHistory && step === 0 && (
          <button className="history-btn" onClick={() => setShowHistory(true)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>
            导入历史 ({importHistory.length})
          </button>
        )}
        {!showHistory && step > 0 && (
          <div className="step-indicator">
            <span className={`step ${step >= 1 ? 'active' : ''}`}>1. 选择文件</span>
            <span className="step-line" />
            <span className={`step ${step >= 2 ? 'active' : ''}`}>2. 配置选项</span>
            <span className="step-line" />
            <span className={`step ${step >= 3 ? 'active' : ''}`}>3. 预览确认</span>
          </div>
        )}
      </div>

      {(stagingSummary.pending > 0 || recoveryNotice) && (
        <div className="import-staging-banner">
          <div>
            <strong>
              {stagingSummary.pending > 0
                ? `有 ${stagingSummary.pending} 道已识别的题暂存在本地，尚未写入题库`
                : '暂存题目已处理'}
            </strong>
            <span>
              {recoveryNotice || '关闭窗口、切页或进程崩溃都不会丢失，点右侧按钮立即补写。'}
            </span>
          </div>
          {stagingSummary.pending > 0 && (
            <button className="btn-secondary" onClick={handleRecoverStaging} disabled={recovering}>
              {recovering ? '正在补写...' : '立即补写进题库'}
            </button>
          )}
        </div>
      )}

      <div className="import-content">
        {showHistory ? (
          <div className="import-history">
            {importHistory.length === 0 ? (
              <div className="empty-history">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                </svg>
                <p>暂无导入记录</p>
              </div>
            ) : (
              <div className="history-list">
                {importHistory.map(paper => (
                  <div key={paper.id} className="history-item">
                    <div className="history-icon">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                      </svg>
                    </div>
                    <div className="history-info">
                      <span className="history-title">{paper.title}</span>
                      <span className="history-meta">{paper.question_count} 道题 · {paper.year}年 · {paper.created_at?.split('T')[0] || '未知日期'}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
        <>
        {step === 0 && (
          <div className="import-mode-select">
            <h3>选择导入方式</h3>
            <div className="mode-cards">
              <div
                className={`mode-card ${!hasRecognitionConfig() ? 'disabled' : ''}`}
                onClick={() => { if (hasRecognitionConfig()) { setImportMode('ai'); setStep(1); } }}
              >
                <div className="mode-icon ai">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"/>
                    <circle cx="8" cy="14" r="1"/><circle cx="16" cy="14" r="1"/>
                  </svg>
                </div>
                <span className="mode-title">AI 识图识题</span>
                <span className="mode-desc">使用当前配置的视觉模型识别习题、题型、知识点并检查重复</span>
                {!hasRecognitionConfig() && <span className="mode-tip">需先在设置中配置 AI 或 OCR</span>}
              </div>

              <div
                className="mode-card"
                onClick={() => { setImportMode('template'); setStep(1); }}
              >
                <div className="mode-icon template">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                    <line x1="16" y1="13" x2="8" y2="13"/>
                    <line x1="16" y1="17" x2="8" y2="17"/>
                  </svg>
                </div>
                <span className="mode-title">模板导入</span>
                <span className="mode-desc">下载 CSV 模板，按格式填写后上传</span>
                <button className="mode-download" onClick={(e) => { e.stopPropagation(); downloadTemplate(); }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                  下载模板
                </button>
              </div>
            </div>

            <div className="import-task-overview">
              <div className="import-task-overview-head">
                <strong>后台任务与上传记录</strong>
                <span>{runningTasks.length ? `${runningTasks.length} 个进行中` : '当前无进行中任务'}</span>
              </div>
              {tasks.length === 0 ? (
                <p className="import-task-overview-empty">上传过的文件、识别进度、入库数量和失败原因都会保留在这里。</p>
              ) : (
                <div className="import-task-overview-list">
                  {tasks.slice(0, 6).map((task) => (
                    <div key={task.id} className="import-task-overview-row">
                      <span className={`import-task-overview-status is-${task.status}`}>
                        {TASK_STATUS_LABEL[task.status] || task.status}
                      </span>
                      <span className="import-task-overview-name" title={task.fileName}>{task.fileName}</span>
                      <span className="import-task-overview-count">
                        识别 {task.recognized || 0} · 入库 {task.imported || 0} · 重复 {task.duplicates || 0} · 失败块 {task.failedBlocks || 0}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {lastTaskSummary && (
                <p className={`import-task-overview-summary is-${lastTaskSummary.status}`}>
                  最近一次：{TASK_STATUS_LABEL[lastTaskSummary.status]} · {lastTaskSummary.fileName} · 入库 {lastTaskSummary.imported} 道
                  {lastTaskSummary.autoCommit ? '' : '（自动入库已关闭，可到识别结果页手动补录）'}
                </p>
              )}
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="import-step1">
            <div
              className={`drop-zone ${dragOver ? 'drag-over' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
            >
              <div className="drop-icon">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="17 8 12 3 7 8"/>
                  <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
              </div>
              <p className="drop-text">拖拽文件到此处，或点击选择</p>
              <p className="drop-hint">
                {importMode === 'ai' ? '支持 PDF、图片、TXT、Markdown、TeX 文本' : '支持 Excel、CSV、JSON 格式'}
              </p>
              <input
                type="file"
                accept={importMode === 'ai' ? '.pdf,.png,.jpg,.jpeg,.webp,.gif,.bmp,.txt,.md,.markdown,.text,.tex' : '.csv,.xls,.xlsx,.json'}
                onChange={handleFileSelect}
                className="file-input"
              />
            </div>
            {importMode === 'template' && (
              <button className="template-btn" onClick={downloadTemplate}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                下载导入模板
              </button>
            )}
          </div>
        )}

        {step === 2 && file && (
          <div className="config-panel">
            <div className="file-preview">
              <span className="file-icon">{getFileIcon()}</span>
              <div className="file-info">
                <span className="file-name">{file.name}</span>
                <span className="file-size">{formatFileSize(file.size)}</span>
              </div>
              <button className="change-file" onClick={() => { setFile(null); setStep(1); }}>
                更换文件
              </button>
            </div>

            {importMode === 'ai' && (
              <div className="answer-upload-panel">
                <div className="form-group">
                  <label>答案文件（可选）</label>
                  <div className="answer-file-row">
                    <input
                      type="file"
                      accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.bmp,.txt,.md,.markdown,.text,.tex,.csv,.json"
                      onChange={(event) => { const selected = event.target.files?.[0]; if (selected) validateAndSetAnswerFile(selected); }}
                    />
                    {answerFile ? <button type="button" className="change-file" onClick={() => setAnswerFile(null)}>移除答案文件</button> : null}
                  </div>
                  <small className="form-hint">上传答案页后，AI 会按题号匹配；不一致的题目会标记为待核对，不会静默写入题库。</small>
                </div>
                <div className="form-group">
                  <label>AI 识别范围（可选）</label>
                  <textarea
                    value={config.recognitionScope}
                    onChange={(event) => setConfig((prev) => ({ ...prev, recognitionScope: event.target.value }))}
                    placeholder="例如：第 3-6 页；题号 11-20；页面上半部分的选择题"
                    rows={2}
                  />
                  <small className="form-hint">范围会同时约束题目与答案识别，留空则按整个文件处理。</small>
                </div>
                <label className="import-check-row">
                  <input
                    type="checkbox"
                    checked={config.solveMissingAnswers}
                    onChange={(event) => setConfig((prev) => ({ ...prev, solveMissingAnswers: event.target.checked }))}
                  />
                  <span>未上传答案时，允许 AI 尝试解题补齐答案（会增加 token 消耗）</span>
                </label>
              </div>
            )}

            <div className="config-form">
              <div className="form-group">
                <label>试卷标题</label>
                <input
                  type="text"
                  value={config.paperTitle}
                  onChange={(e) => setConfig(prev => ({ ...prev, paperTitle: e.target.value }))}
                  placeholder="输入试卷标题"
                />
              </div>

              <div className="form-group">
                <label>学习科目</label>
                <div className="category-select">
                  {Object.entries(categoryConfig).map(([key, val]) => (
                    <button
                      key={key}
                      className={`category-option ${config.category === key ? 'selected' : ''}`}
                      style={{ '--cat-color': val.color }}
                      onClick={() => setConfig(prev => ({ ...prev, category: key }))}
                    >
                      {val.name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="form-group">
                <label>年份</label>
                <input
                  type="number"
                  value={config.year}
                  onChange={(e) => setConfig(prev => ({ ...prev, year: parseInt(e.target.value) }))}
                  min="2000"
                  max="2030"
                />
              </div>
            </div>

            <div className="config-actions">
              <button className="btn-secondary" onClick={() => setStep(1)}>上一步</button>
              <button className="btn-primary" onClick={() => setStep(3)}>下一步</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="preview-panel">
            <div className="preview-info">
              <h3>确认导入信息</h3>
              <div className="preview-item">
                <span className="preview-label">文件名</span>
              <span className="preview-value">{file?.name}{answerFile ? ` · 答案：${answerFile.name}` : ' · 未提供答案文件'}</span>
              </div>
              <div className="preview-item">
                <span className="preview-label">试卷标题</span>
                <span className="preview-value">{config.paperTitle}</span>
              </div>
              <div className="preview-item">
                <span className="preview-label">题目分类</span>
                <span className="preview-value">{categoryConfig[config.category]?.name}</span>
              </div>
              <div className="preview-item">
                <span className="preview-label">年份</span>
                <span className="preview-value">{config.year}</span>
              </div>
            </div>
            {parseError && (
              <div className="parse-error">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
                </svg>
                <span>{parseError}</span>
              </div>
            )}
            <div className="preview-note">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
              </svg>
              <span>{parsing ? (parseProgress || '正在并发识别，请稍候...') : `识别引擎：${recognitionEngineLabel || '当前配置的 AI'} · 答案不一致的题目需要人工确认`}</span>
            </div>
            <label className="import-check-row import-auto-commit">
              <input
                type="checkbox"
                checked={autoCommit}
                onChange={(event) => {
                  const next = event.target.checked;
                  setAutoCommit(next);
                  try { localStorage.setItem(AUTO_COMMIT_KEY, next ? '1' : '0'); } catch (error) { /* 忽略 */ }
                }}
              />
              <span>识别成功的新题自动写入题库（去重重后再写，不要求全部页面都识别成功）</span>
            </label>
            <div className="preview-note import-background-note">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18a8 8 0 110-16 8 8 0 010 16zm-1-13h2v5h-2zm0 7h2v2h-2z"/>
              </svg>
              <span>开始后可以立刻切到别的界面，识别会继续在后台跑；右下角「上传记录」可查看进度、停止任务或回看历史。</span>
            </div>
            <div className="config-actions">
              <button className="btn-secondary" onClick={() => setStep(2)}>上一步</button>
              {parsing && <button className="btn-secondary" onClick={cancelParsing}>停止全部后台任务</button>}
              <button className="btn-primary" onClick={handleStartParse}>
                开始解析并挂后台
              </button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="preview-panel result-panel">
            <div className="result-header">
              <div>
                <h3>AI 识别与去重审阅</h3>
                <p className="preview-subtitle">成功识别且不与题库重复的新题已自动写入题库；失败的块不会拖垮整份文件，答案冲突和重复题仍留给人工确认。</p>
              </div>
              <span className="result-count">保留 {duplicateSummary.unique} · 重复 {duplicateSummary.duplicate}</span>
            </div>
            {lastTaskSummary && (
              <div className={`import-auto-commit-summary is-${lastTaskSummary.status}`}>
                <strong>
                  {lastTaskSummary.autoCommit
                    ? `已自动入库 ${lastTaskSummary.imported} 道`
                    : '自动入库已关闭'}
                </strong>
                <span>
                  共识别 {lastTaskSummary.recognized} 道 · 重复 {lastTaskSummary.duplicates} 道 · 失败块 {lastTaskSummary.failedBlocks} 个 · 状态 {TASK_STATUS_LABEL[lastTaskSummary.status] || lastTaskSummary.status}
                </span>
                {lastTaskSummary.errors?.length > 0 && (
                  <ul>{lastTaskSummary.errors.map((text, index) => <li key={index}>{text}</li>)}</ul>
                )}
              </div>
            )}
            <div className="result-list" style={{ maxHeight: '460px', overflowY: 'auto' }}>
              {parsedQuestions.map((q, idx) => (
                <div key={idx} className={`result-item ${q.duplicateStatus === 'duplicate' ? 'is-duplicate' : ''}`}>
                  <span className="result-num">{idx + 1}</span>
                  <div className="result-content">
                    <p className="result-question">{q.content.slice(0, 80)}{q.content.length > 80 ? '...' : ''}</p>
                    <span className="result-answer">{categoryConfig[q.category]?.name || q.category}{q.chapter ? ` · ${q.chapter}` : ''} · 答案 {q.answer || '待补'}{q.answerStatus === 'mismatch' ? ` · ${q.answerReason || '答案不一致'}` : ''}</span>
                    {!q.committed && (q.answerStatus === 'mismatch' || !q.answer) && (
                      <input
                        className="result-answer-edit"
                        value={q.answer || ''}
                        placeholder="补充/核对答案"
                        aria-label="补充或核对答案"
                        onChange={(event) => updateParsedAnswer(idx, event.target.value)}
                      />
                    )}
                  </div>
                  <span className={`duplicate-badge ${q.duplicateStatus === 'duplicate' || q.answerStatus === 'mismatch' ? 'duplicate' : 'unique'}`}>{q.duplicateStatus === 'duplicate' ? '疑似重复' : q.answerStatus === 'mismatch' ? '答案待核对' : q.committed ? '已入库' : q.answerStatus === 'missing' ? '暂无答案' : '待补录'}</span>
                </div>
              ))}
            </div>
            <div className="config-actions">
              <button className="btn-secondary" onClick={() => setStep(3)}>继续上传下一份</button>
              <button className="btn-primary" onClick={() => handleConfirmImport()} disabled={pendingManualCount === 0 || confirming}>
                {confirming ? '正在补录...' : pendingManualCount > 0 ? `补录未入库的 ${pendingManualCount} 道` : '新题已全部入库'}
              </button>
            </div>
          </div>
        )}
        </>
        )}
      </div>
    </div>
  );
}
