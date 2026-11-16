import React, { useCallback, useEffect, useRef, useState } from "react";
import { getRoleSettings, isRoleConfigured } from "../store/aiSettings.js";
import { useDialog } from "../components/DialogProvider.jsx";
import { textQuality, repairGhostText } from "../../shared/textQuality.js";

/**
 * 科目管理页
 *
 * 流程：先创建科目（只填名称）→ 再上传教材（卡片上触发解析流水线）→ 最后按需设置考试日期
 * （设了日期即切备考模式，清掉即回学习模式，随时可改）。
 * 预置的数学 / 英语 / 政治 / 专业课与题库既有分类联动，可改名、可删。
 *
 * 解析流水线（速度优先）：
 * 1. 数字版 PDF 直接取文字层，不调模型；只有扫描页 / 图形页才渲染成 JPEG 交给识图模型；
 * 2. 页面懒加载 + 3 路并发，逐页结果立刻落盘（中断后同一本书可按页码续传）；
 * 3. 全文拼好后再生成知识清单、提取例题习题，题目只从带「例题 / 习题」标记的段落提取。
 */

const MODE_LABEL = { learn: "学习模式", exam: "备考模式" };
const PARSE_MODE_KEY = "openexam.textbookParseMode";
const PAGE_BUDGET_KEY = "openexam.textbookPageBudget";
const VISION_CONCURRENCY = 3;
const PAGE_TIMEOUT_MS = 90000;
const TEXT_MIN_CHARS = 220;
// 本次解析页数：0 = 全部。扫描版教材每页都要识图，分批解析更可控（已解析的页会跳过）
const PAGE_BUDGET_OPTIONS = [
  { value: 20, label: "20 页" },
  { value: 60, label: "60 页" },
  { value: 160, label: "160 页" },
  { value: 0, label: "全部" },
];
const DEFAULT_PAGE_BUDGET = 60;

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const target = new Date(`${String(dateStr).slice(0, 10)}T00:00:00`);
  const today = new Date(new Date().toDateString());
  return Math.ceil((target - today) / 86400000);
}

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/* --------------------------------------------------------------- PDF 工具 */

async function loadPdfjs() {
  const [pdfjsLib, workerSrcModule] = await Promise.all([
    import("pdfjs-dist/build/pdf.mjs"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrcModule.default;
  return pdfjsLib;
}

async function openPdfDocument(file) {
  const pdfjsLib = await loadPdfjs();
  const bytes = await file.arrayBuffer();
  return pdfjsLib.getDocument({ data: bytes }).promise;
}

/** 数字版 PDF 的文字层：按行拼接，整页文字可直接当转写结果，省掉一次识图调用 */
async function extractPageText(page) {
  const content = await page.getTextContent();
  let text = "";
  for (const item of content.items || []) {
    const str = typeof item.str === "string" ? item.str : "";
    if (str) {
      // 只在「英文/数字接英文/数字」时补空格：中文之间补空格反而把句子拆碎
      if (text && !/\s$/.test(text) && /[A-Za-z0-9,.;:)\]]$/.test(text) && /^[A-Za-z0-9([]/.test(str)) {
        text += " ";
      }
      text += str;
    }
    if (item.hasEOL) text += "\n";
  }
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 文字层是否够用：字符太少（扫描页 / 纯图页）、乱码太多、或带「幽灵文字层」就退回识图 */
function usableText(text) {
  const compact = String(text || "").replace(/\s/g, "");
  if (compact.length < TEXT_MIN_CHARS) return false;
  // \uFFFD 只是损坏的一种表现；更隐蔽的是每个字之间被塞进固定乱码字的「幽灵文字层」
  return !textQuality(text).corrupt;
}

/**
 * 扫描页渲染成 JPEG：约 1400px 宽 + 0.85 质量。
 * 返回 canvas 本身，后续按模型给的 bbox 裁插图时复用，不必重渲染一次。
 */
async function renderPageToJpeg(page) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2.2, Math.max(1.6, 1400 / Math.max(base.width, 1)));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext("2d");
  // JPEG 不支持透明：先铺白底，否则透明背景会变黑
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  return { base64: dataUrl.split(",")[1], canvas };
}

/** 释放 canvas 显存（3 路并发时每页一张 1400×2000 的图，不释放会越跑越吃内存） */
function releaseCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * 按 0-1000 归一化 bbox 从整页 canvas 里裁出单张插图。
 * 外扩 1.5% 留白，避免把图题、坐标轴的最后一个字切掉。
 */
function cropFigure(canvas, bbox) {
  if (!canvas || !Array.isArray(bbox) || bbox.length < 4) return "";
  const pad = 15;
  const [x1, y1, x2, y2] = bbox.map((v) => Number(v) || 0);
  const sx = Math.max(0, Math.floor(((x1 - pad) / 1000) * canvas.width));
  const sy = Math.max(0, Math.floor(((y1 - pad) / 1000) * canvas.height));
  const ex = Math.min(canvas.width, Math.ceil(((x2 + pad) / 1000) * canvas.width));
  const ey = Math.min(canvas.height, Math.ceil(((y2 + pad) / 1000) * canvas.height));
  const sw = ex - sx;
  const sh = ey - sy;
  if (sw < 20 || sh < 20) return "";
  const out = document.createElement("canvas");
  out.width = sw;
  out.height = sh;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, sw, sh);
  ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  const dataUrl = out.toDataURL("image/jpeg", 0.9);
  releaseCanvas(out);
  return dataUrl.split(",")[1];
}

async function readImagePage(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
  const mimeType = file.type && file.type.startsWith("image/") ? file.type : "image/png";
  return [{ page: 1, base64: dataUrl.split(",")[1], mimeType }];
}

/** 单次识图带超时：卡住的一页不能拖住整本书 */
async function transcribeWithTimeout(settings, base64, mimeType, requestId, ms = PAGE_TIMEOUT_MS, options = {}) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timeout: true }), ms);
  });
  try {
    const result = await Promise.race([
      window.openexam.ai.transcribePage(settings, base64, mimeType, requestId, options),
      timeout,
    ]);
    if (result?.__timeout) {
      window.openexam.ai.cancelRecognition?.(requestId)?.catch?.(() => {});
      return { success: false, error: `转写超时（${Math.round(ms / 1000)} 秒）` };
    }
    return result || { success: false, error: "无返回" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export default function Subjects({ onNavigate }) {
  const { toast, confirm } = useDialog();
  const [subjects, setSubjects] = useState([]);
  const [statsMap, setStatsMap] = useState({});
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [pipeline, setPipeline] = useState(null); // { subjectId, stage, detail, percent, startedAt }
  const [parseMode, setParseMode] = useState(() => {
    try {
      return localStorage.getItem(PARSE_MODE_KEY) === "precise" ? "precise" : "fast";
    } catch {
      return "fast";
    }
  });
  const [pageBudget, setPageBudget] = useState(() => {
    try {
      const raw = localStorage.getItem(PAGE_BUDGET_KEY);
      if (raw === null) return DEFAULT_PAGE_BUDGET;
      const value = Number(raw);
      return PAGE_BUDGET_OPTIONS.some((option) => option.value === value) ? value : DEFAULT_PAGE_BUDGET;
    } catch {
      return DEFAULT_PAGE_BUDGET;
    }
  });
  const [clock, setClock] = useState(Date.now());
  const [editingId, setEditingId] = useState("");
  const [editName, setEditName] = useState("");
  const [dateDraft, setDateDraft] = useState({}); // { [id]: 'YYYY-MM-DD' | '' }
  // 章节结构面板：{ subjectId, sourceKey, sourceName, totalPages, chapters, warnings, loading, saving, error, file }
  const [structurePanel, setStructurePanel] = useState(null);
  const fileRef = useRef(null);
  const pipelineSubjectRef = useRef(null);
  const cancelRef = useRef(false);

  const loadSubjects = useCallback(async () => {
    try {
      const list = await window.openexam?.subject?.list?.();
      const rows = Array.isArray(list) ? list : [];
      setSubjects(rows);
      // 并行拉各科目题库统计，展示与题库的联动
      const entries = await Promise.all(rows.map(async (row) => {
        try {
          return [row.id, await window.openexam?.subject?.stats?.(row.id) || { papers: 0, questions: 0, wrong: 0 }];
        } catch {
          return [row.id, { papers: 0, questions: 0, wrong: 0 }];
        }
      }));
      setStatsMap(Object.fromEntries(entries));
    } catch (error) {
      console.error("[Subjects] 读取失败:", error);
    }
  }, []);

  useEffect(() => { loadSubjects(); }, [loadSubjects]);

  // 解析进度由主进程广播：资料管理窗口发起的分批解析，主窗口科目卡片也同步显示
  useEffect(() => {
    const offProgress = window.openexam?.subject?.onMineruProgress?.((payload) => {
      if (!payload?.subjectId) return;
      setPipeline({
        subjectId: payload.subjectId,
        stage: payload.stage || "local",
        detail: payload.detail || "解析中",
        percent: Number(payload.percent) || 0,
        startedAt: Date.now(),
      });
      if (Number(payload.percent) >= 100) loadSubjects();
    });
    const offChanged = window.openexam?.materials?.onChanged?.(() => loadSubjects());
    return () => { offProgress?.(); offChanged?.(); };
  }, [loadSubjects]);

  // 进度条上的计时器（只在解析进行时走，避免每次进度更新重建定时器）
  const pipelineActive = Boolean(pipeline);
  useEffect(() => {
    if (!pipelineActive) return undefined;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pipelineActive]);

  const changeParseMode = (mode) => {
    setParseMode(mode);
    try { localStorage.setItem(PARSE_MODE_KEY, mode); } catch { /* 忽略隐私模式限制 */ }
  };

  const changePageBudget = (value) => {
    const next = Number(value);
    setPageBudget(next);
    try { localStorage.setItem(PAGE_BUDGET_KEY, String(next)); } catch { /* 忽略隐私模式限制 */ }
  };

  /* ------------------------------------------------------- 教材解析流水线 */

  const runTextbookPipeline = async (subject, file) => {
    const ext = String(file.name || "").split(".").pop().toLowerCase();
    const isPdf = ext === "pdf";
    if (!isPdf && !String(file.type || "").startsWith("image/")) {
      throw new Error("教材支持 PDF 或图片（jpg/png/webp）");
    }

    const startedAt = Date.now();
    const stage = (nextStage, detail, percent) => {
      setPipeline({ subjectId: subject.id, stage: nextStage, detail, percent, startedAt });
    };

    // 本地引擎（MinerU）：整本一次解析，转写零 API 成本；只有知识清单/题目提取走文本 API
    const localEngine = await window.openexam?.subject?.mineruDetect?.().catch?.(() => null);
    const pdfPath = isPdf ? String(file.path || (window.openexam?.subject?.getPathForFile?.(file)) || "") : "";
    const useLocal = Boolean(localEngine?.available) && Boolean(pdfPath);

    const settings = getRoleSettings("vision");
    const hasVision = Boolean(settings?.apiKey);
    // 没有本地解析环境、也没配识图模型时，不要先跑一遍再报错，直接说明缺什么
    if (isPdf && !useLocal && !hasVision) {
      throw new Error("本机缺少 PDF 解析环境：请到「设置 → 运行环境」一键安装；或先在设置里配置 AI 识图后逐页解析。");
    }
    let done = 0;
    let textPages = 0;
    let visionPages = 0;
    let figurePages = 0; // 累计裁出的插图张数，进度条上给用户看到
    let balanceExhausted = false; // API 余额耗尽：立即停，别把剩下的页写成失败注释
    let balanceError = "";
    let pageCount = 1;
    const useLocalRef = { current: useLocal }; // 降级后要能关掉

    const savePage = (page, markdown, source) => window.openexam?.subject?.saveTextbookPage?.({
      subjectId: subject.id,
      page,
      markdown,
      source,
      fileName: file.name,
      total: pageCount,
    }).catch?.(() => {}) || Promise.resolve();

    /* 本地引擎：MinerU 整本解析，主进程直接完成「页文件 + 插图 + 教材全文」 */
    if (useLocal) {
      stage("local", localEngine?.models?.ok
        ? "本地 MinerU 解析中，请勿关闭应用"
        : "本地 MinerU 解析中（首次使用会先准备模型，可在 设置 → 运行环境 查看进度）", 4);
      try {
        const result = await window.openexam.subject.parseTextbookLocal({
          subjectId: subject.id,
          pdfPath,
          fileName: file.name,
        });
        if (!result?.pages) throw new Error(result?.error || "本地解析无输出");
        pageCount = result.pages;
        figurePages = result.figures || 0;
        done = pageCount;
        // MinerU 只产出页文本与裁图，没有整页图；题目里「如图」这类没写图号的引用
        // 需要整页图兜底，这里用同一份 PDF 在渲染层补齐缺的页图（可断点续传）
        let figurePdf = null;
        try {
          stage("figures", "本地解析完成，补渲染整页图…", 62);
          figurePdf = await openPdfDocument(file);
          const total = figurePdf.numPages;
          let figured = new Set();
          try {
            const progress = await window.openexam?.subject?.textbookProgress?.(subject.id);
            figured = new Set(progress?.fileName === file.name ? (progress.figurePages || []) : []);
          } catch { /* 读不到进度就整本补 */ }
          for (let pageNo = 1; pageNo <= total; pageNo += 1) {
            if (figured.has(pageNo)) continue;
            const page = await figurePdf.getPage(pageNo);
            const rendered = await renderPageToJpeg(page);
            await window.openexam?.subject?.saveTextbookPageImage?.({
              subjectId: subject.id, page: pageNo, base64: rendered.base64, fileName: file.name,
            }).catch?.(() => {});
            if (pageNo % 20 === 0 || pageNo === total) {
              stage("figures", `补渲染整页图 ${pageNo}/${total}…`, 62 + Math.round((pageNo / total) * 6));
            }
          }
        } catch (error) {
          console.warn("[Subjects] 本地解析后补页图失败:", error?.message || error);
        } finally {
          // 400+ 页的 PDF 文档持有大量内存，补完页图必须主动释放
          try { await figurePdf?.destroy?.(); } catch { /* 忽略 */ }
        }
        stage("analyze", `本地解析完成 · ${pageCount} 页 · 插图 ${figurePages} 张`, 62);
      } catch (error) {
        if (!hasVision) {
          toast({
            title: "本地解析失败",
            message: `${error.message}｜可到「设置 → 运行环境」检查并安装解析环境。`,
            tone: "warning",
            duration: 9000,
          });
          throw error;
        }
        toast({
          title: "本地解析失败，改用 API 逐页",
          message: `${error.message}｜注意：逐页解析会消耗 API 余额`,
          tone: "warning",
          duration: 8000,
        });
        balanceError = ""; // 降级前重置
        useLocalRef.current = false;
      }
    }

    /* 图片教材：只有一页，直接识图 */
    if (!useLocal && !isPdf) {
      stage("transcribe", "识别图片教材…", 20);
      const [page] = await readImagePage(file);
      pageCount = 1;
      const requestId = `tb_${subject.id}_1_${Date.now()}`;
      const result = await transcribeWithTimeout(settings, page.base64, page.mimeType, requestId);
      const markdown = result?.success && String(result.markdown || "").trim()
        ? String(result.markdown).trim()
        : `<!-- 第 1 页转写失败：${result?.error || "未知原因"} -->`;
      await savePage(1, markdown, "vision");
      done = 1;
      visionPages = 1;
    } else if (!useLocal) {
      stage("convert", "读取 PDF…", 4);
      const pdf = await openPdfDocument(file);
      const total = pdf.numPages;
      pageCount = pageBudget > 0 ? Math.min(total, pageBudget) : total;

      if (total > pageCount) {
        toast({
          title: "分批解析",
          message: `本次解析前 ${pageCount} / ${total} 页，剩余页下次「重新解析」会自动接着往后走`,
          tone: "warning",
          duration: 5200,
        });
      }

      // 断点续传：同一本书、已落盘的页码直接跳过
      let savedPages = [];
      let figuredPages = [];
      try {
        const progress = await window.openexam?.subject?.textbookProgress?.(subject.id);
        if (progress?.fileName === file.name) {
          savedPages = progress.pages || [];
          figuredPages = progress.figurePages || [];
        }
      } catch { /* 读不到进度就整本重来 */ }
      // 只有「正文 + 页图/插图索引」都齐了才算完成：
      // 旧版本解析出的页没有页图，题目会缺配图，需要按新流程补跑一遍。
      const figured = new Set(figuredPages);
      const saved = new Set(savedPages.filter((n) => n >= 1 && n <= pageCount && figured.has(n)));
      const pending = [];
      for (let n = 1; n <= pageCount; n += 1) if (!saved.has(n)) pending.push(n);
      done = saved.size;

      if (saved.size) {
        toast({
          title: "接着上次的进度解析",
          message: `已完成 ${saved.size} 页，本次继续 ${pending.length} 页`,
          tone: "info",
          duration: 4600,
        });
      }

      const report = (currentStage = "transcribe") => {
        const percent = 8 + Math.round((done / Math.max(pageCount, 1)) * 44);
        const parts = [`逐页解析 ${done}/${pageCount}`];
        if (textPages) parts.push(`文字层 ${textPages}`);
        if (visionPages) parts.push(`识图 ${visionPages}`);
        if (figurePages) parts.push(`裁出插图 ${figurePages}`);
        stage(currentStage, parts.join(" · "), percent);
      };
      report();

      let cursor = 0;
      const worker = async () => {
        while (true) {
          if (cancelRef.current || balanceExhausted) return;
          const index = cursor;
          cursor += 1;
          if (index >= pending.length) return;
          const pageNo = pending[index];

          let markdown = "";
          let source = "text";
          let rendered = null;
          let pageFailed = false;
          try {
            const page = await pdf.getPage(pageNo);
            if (parseMode === "fast") {
              try {
                const text = await extractPageText(page);
                if (usableText(text)) markdown = text;
              } catch (error) {
                console.warn("[Subjects] 文字层读取失败，退回识图:", pageNo, error?.message || error);
              }
            }

            // 不管走不走识图，页图都落盘：题目引用图号时用它做兜底，Obsidian 里也能翻原页
            rendered = await renderPageToJpeg(page);
            await window.openexam?.subject?.saveTextbookPageImage?.({
              subjectId: subject.id, page: pageNo, base64: rendered.base64, fileName: file.name,
            }).catch?.(() => {});

            if (!markdown) {
              const requestId = `tb_${subject.id}_${pageNo}_${Date.now()}`;
              const result = await transcribeWithTimeout(
                settings, rendered.base64, "image/jpeg", requestId, PAGE_TIMEOUT_MS,
                { withFigures: true },
              );
              if (result?.insufficientBalance) {
                // 余额没了：这一页不落盘、不写失败注释，整条流水线停下，充值后按断点续传接着跑
                balanceExhausted = true;
                pageFailed = true;
                balanceError = result.error || "API 余额不足";
              } else {
                markdown = result?.success && String(result.markdown || "").trim()
                  ? String(result.markdown).trim()
                  : `<!-- 第 ${pageNo} 页转写失败：${result?.error || "未知原因"} -->`;
              }
              source = "vision";
              visionPages += 1;

              // 按模型给的框精确裁出单张插图，落盘并登记图号
              const figures = Array.isArray(result?.figures) ? result.figures : [];
              if (figures.length) {
                figurePages += figures.length;
                const crops = figures.map((figure) => {
                  const base64 = cropFigure(rendered.canvas, figure.bbox);
                  return base64 ? { no: figure.no, caption: figure.caption, bbox: figure.bbox, base64 } : null;
                }).filter(Boolean);
                if (crops.length) {
                  await window.openexam?.subject?.saveTextbookFigures?.({
                    subjectId: subject.id, page: pageNo, figures: crops, fileName: file.name,
                  }).catch?.(() => {});
                }
              }
            } else {
              textPages += 1;
            }
          } catch (error) {
            markdown = `<!-- 第 ${pageNo} 页转写失败：${error?.message || error} -->`;
            source = "vision";
          } finally {
            releaseCanvas(rendered?.canvas);
          }

          if (pageFailed) return; // 余额耗尽那一页不落盘，留给下次续传

          // 落盘前先修掉「幽灵文字层」：渲染图里夹带的异常高频乱码字（如「睏」）整体剔除，
          // 否则存进去的就是每字间隔的垃圾，后续生成清单 / 写题库都会失败
          const repaired = repairGhostText(markdown);
          if (repaired.repaired) {
            markdown = repaired.text;
            console.warn(`[Subjects] 第 ${pageNo} 页检测到幽灵文字层，已剔除乱码字符「${repaired.ghostChar}」共 ${repaired.removed} 处`);
          }
          await savePage(pageNo, markdown, source);
          done += 1;
          report();
        }
      };

      const lanes = Math.max(1, Math.min(VISION_CONCURRENCY, pending.length));
      await Promise.all(Array.from({ length: lanes }, () => worker()));
      pdf.destroy?.();

      if (balanceExhausted) {
        await window.openexam?.subject?.failTextbook?.({
          subjectId: subject.id,
          error: `API 余额不足：${balanceError}`,
        });
        toast({
          title: "API 余额不足，解析已暂停",
          message: `已完整录入 ${done}/${pageCount} 页。充值后点「重新解析」会从第 ${done + 1} 页继续，已完成的页不会重复收费。`,
          tone: "warning",
          duration: 12000,
        });
        return null;
      }
    }

    if (cancelRef.current) {
      await window.openexam?.subject?.failTextbook?.({ subjectId: subject.id, error: "已停止解析" });
      return null;
    }

    let savedPages = pageCount;
    if (useLocalRef.current) {
      stage("save", `本地解析完成 · ${pageCount} 页 · 插图 ${figurePages} 张`, 56);
      savedPages = pageCount;
    } else {
      stage("save", "保存教材全文…", 56);
      const savedText = await window.openexam.subject.saveTextbook({
        subjectId: subject.id,
        fileName: file.name,
        totalPages: pageCount,
      });
      if (!savedText?.pages) throw new Error("教材全文保存失败");
      savedPages = savedText.pages;
    }

    // 知识清单与例题提取互不依赖，并行跑：总耗时从「两者相加」变成「取较慢的那个」
    let questionProgress = null;
    const renderAnalyzeStage = () => {
      const parts = ["知识清单生成中"];
      if (questionProgress) parts.push(`例题提取 ${questionProgress.done}/${questionProgress.total}`);
      const percent = questionProgress
        ? 64 + Math.round((questionProgress.done / Math.max(questionProgress.total, 1)) * 30)
        : 68;
      stage("analyze", parts.join(" · "), percent);
    };
    renderAnalyzeStage();

    const requestId = `tbq_${subject.id}_${Date.now()}`;
    const offProgress = window.openexam?.subject?.onQuestionsProgress?.((payload) => {
      if (!payload || payload.requestId !== requestId) return;
      if (payload.stage === "progress") {
        questionProgress = { done: payload.done, total: payload.total, questions: payload.questions };
        renderAnalyzeStage();
      }
    });

    const inventoryTask = window.openexam.subject.generateInventory({
      subjectId: subject.id,
      settings: getRoleSettings("assistant"),
    }).then((result) => result || { success: false, error: "知识清单无返回" })
      .catch((error) => ({ success: false, error: error?.message || String(error) }));

    const questionsTask = window.openexam.subject.generateQuestions({
      subjectId: subject.id,
      settings: getRoleSettings("vision"),
      requestId,
    }).then((result) => result || { success: false, error: "题目提取无返回" })
      .catch((error) => ({ success: false, error: error?.message || String(error) }));

    const [inventory, questions] = await Promise.all([inventoryTask, questionsTask]).finally(() => offProgress?.());

    // 教材已经落盘，这两步失败只降级提示，不把整次解析判成失败
    if (!inventory?.success) {
      toast({ title: "知识清单没生成", message: `${inventory?.error || "未知原因"}（教材全文已保存，可稍后重新解析）`, tone: "warning", duration: 6000 });
    }
    if (!questions?.success) {
      toast({ title: "例题习题没提取出来", message: questions?.error || "未知原因", tone: "warning", duration: 6000 });
    } else if (questions?.partial) {
      toast({
        title: "例题提取达到时间上限",
        message: `已处理 ${questions.scanned || 0}/${questions.total || 0} 段，先把识别到的题目入库了`,
        tone: "warning",
        duration: 6000,
      });
    }

    const questionCount = questions?.success ? questions?.questions || 0 : 0;
    stage("done", `解析完成 · 共 ${pageCount} 页`, 100);
    return { ...questions, questions: questionCount, inventoryOk: Boolean(inventory?.success) };
  };

  const cancelPipeline = () => {
    cancelRef.current = true;
    setPipeline((prev) => (prev ? { ...prev, detail: "正在停止…", percent: Math.min(prev.percent || 0, 99) } : prev));
  };

  const pickTextbook = (subject) => {
    if (pipeline) {
      toast({ title: "还有教材在解析", message: "等当前解析结束或先停止，再上传下一本。", tone: "warning" });
      return;
    }
    pipelineSubjectRef.current = subject;
    fileRef.current?.click();
  };

  /** 资料管理：切到应用内资料管理页（主教材 + 补充资料） */
  const openMaterials = (subject) => {
    onNavigate?.("materials", subject);
  };

  const onFileChange = async (event) => {
    const file = event.target.files?.[0] || null;
    event.target.value = "";
    const subject = pipelineSubjectRef.current;
    if (!file || !subject) return;
    if (!isRoleConfigured("assistant")) {
      toast({ title: "还没配置 AI 模型", message: "请到「系统设置 → AI 模型」先完成配置", tone: "warning" });
      return;
    }

    cancelRef.current = false;
    try {
      await window.openexam.subject.save({ id: subject.id, textbookName: file.name, textbookStatus: "parsing" });
      const result = await runTextbookPipeline(subject, file);
      if (!result) return; // 用户主动停止，状态已在流水线里落成 failed
      const bits = [result.inventoryOk ? "知识清单已写入笔记库" : "教材全文已保存（知识清单未生成）"];
      if (result.questions) {
        const tail = result.paperTotal && result.paperTotal > result.questions ? `（这一卷共 ${result.paperTotal} 道）` : "";
        bits.push(result.appended
          ? `新增 ${result.questions} 道例题习题，已追加到原有习题卷${tail}`
          : `${result.questions} 道例题习题已入题库${tail}`);
      } else if (result.duplicate) {
        bits.push("没有新题，题库里已经有了");
      }
      toast({
        title: result.inventoryOk ? "教材解析完成" : "教材已解析，清单待补",
        message: bits.join("，"),
        tone: result.inventoryOk ? "success" : "warning",
        duration: 6000,
      });
    } catch (error) {
      await window.openexam?.subject?.failTextbook?.({ subjectId: subject.id, error: error?.message || String(error) });
      toast({ title: "教材解析中断", message: error?.message || String(error), tone: "warning", duration: 6000 });
    } finally {
      setPipeline(null);
      cancelRef.current = false;
      loadSubjects();
    }
  };

  /* ------------------------------------------------------- 科目操作 */

  const handleCreate = async () => {
    const name = String(newName || "").trim();
    if (!name) {
      toast({ title: "先给科目起个名字", tone: "warning" });
      return;
    }
    setCreating(true);
    try {
      const subject = await window.openexam.subject.save({ name });
      setNewName("");
      await loadSubjects();
      toast({
        title: "科目已创建",
        message: "下一步：在卡片上「上传教材」让 AI 建知识清单；有考试的话再设置考试日期。",
        tone: "success",
        duration: 5000,
      });
      return subject;
    } catch (error) {
      toast({ title: "创建失败", message: error?.message || String(error), tone: "danger" });
    } finally {
      setCreating(false);
    }
  };

  const startRename = (subject) => {
    setEditingId(subject.id);
    setEditName(subject.name);
  };

  const commitRename = async () => {
    const id = editingId;
    const name = String(editName || "").trim();
    setEditingId("");
    if (!id || !name) return;
    const subject = subjects.find((row) => row.id === id);
    if (!subject || subject.name === name) return;
    try {
      await window.openexam.subject.save({ id, name });
      await loadSubjects();
      toast({ title: "已改名", message: `「${subject.name}」→「${name}」`, tone: "success" });
    } catch (error) {
      toast({ title: "改名失败", message: error?.message || String(error), tone: "danger" });
    }
  };

  const handleExamDateSave = async (subject) => {
    const draft = dateDraft[subject.id];
    if (draft === undefined) {
      toast({ title: "先选择日期（或清空后保存以取消考试）", tone: "info" });
      return;
    }
    const examDate = draft ? String(draft).slice(0, 10) : null;
    try {
      await window.openexam.subject.save({ id: subject.id, examDate });
      await loadSubjects();
      toast({
        title: examDate ? "已设为备考模式" : "已切回学习模式",
        message: examDate
          ? `考试日期 ${examDate}，助教和老师会围绕倒计时安排复习`
          : "以系统掌握为目标，按教材节奏学",
        tone: "success",
      });
    } catch (error) {
      toast({ title: "保存失败", message: error?.message || String(error), tone: "danger" });
    }
  };

  const handleDelete = async (subject) => {
    const ok = await confirm({
      title: `删除科目「${subject.name}」？`,
      message: "只解绑关联数据，不删除题库 / 笔记 / 对话记录本身。预置科目删除后不会自动恢复。",
      confirmText: "删除",
      tone: "warning",
    });
    if (!ok) return;
    await window.openexam.subject.remove(subject.id);
    loadSubjects();
  };

  const goAsk = (subject) => onNavigate?.("ask-assistant", subject);

  /** 打开章节结构面板：读取已有结构表，没有则现场识别并落盘 */
  const openChapterStructure = async (subject) => {
    setStructurePanel({
      subjectId: subject.id,
      sourceKey: "auto",
      sourceName: subject.textbookName || subject.name,
      totalPages: subject.textbookPages || 0,
      chapters: [],
      warnings: [],
      file: "",
      loading: true,
      saving: false,
      error: "",
    });
    try {
      const result = await window.openexam.subject.chapterStructure({ subjectId: subject.id, source: "auto" });
      if (!result?.success) throw new Error(result?.error || "读取章节结构失败");
      setStructurePanel({
        subjectId: subject.id,
        sourceKey: result.structure?.source?.key || "primary",
        sourceName: result.structure?.source?.name || subject.textbookName || subject.name,
        totalPages: result.structure?.source?.totalPages || subject.textbookPages || 0,
        chapters: (result.structure?.chapters || []).map((item) => ({ ...item })),
        warnings: result.structure?.warnings || [],
        file: result.file || "",
        loading: false,
        saving: false,
        error: "",
      });
    } catch (error) {
      setStructurePanel((prev) => ({ ...(prev || {}), loading: false, error: error?.message || String(error) }));
    }
  };

  const updateStructureChapter = (index, field, value) => {
    setStructurePanel((prev) => {
      if (!prev) return prev;
      const chapters = prev.chapters.map((item, itemIndex) => (itemIndex === index
        ? { ...item, [field]: field === "title" ? value : (value === "" ? null : Number(value)) }
        : item));
      return { ...prev, chapters };
    });
  };

  const saveChapterStructure = async () => {
    if (!structurePanel) return;
    setStructurePanel((prev) => ({ ...prev, saving: true, error: "" }));
    try {
      const result = await window.openexam.subject.saveChapterStructure({
        subjectId: structurePanel.subjectId,
        source: structurePanel.sourceKey,
        chapters: structurePanel.chapters,
      });
      if (!result?.success) throw new Error(result?.error || "保存失败");
      setStructurePanel((prev) => ({
        ...prev,
        chapters: (result.structure?.chapters || []).map((item) => ({ ...item })),
        warnings: result.structure?.warnings || [],
        file: result.file || prev.file,
        saving: false,
      }));
      toast({ title: "章节结构已保存", message: "下次生成知识清单会按这张表取页", tone: "success" });
    } catch (error) {
      setStructurePanel((prev) => ({ ...prev, saving: false, error: error?.message || String(error) }));
    }
  };

  const rebuildChapterStructure = async () => {
    if (!structurePanel) return;
    const ok = await confirm({
      title: "按原文重新识别章节结构？",
      message: "会覆盖你手动改过的页码和标题。",
      confirmText: "重新识别",
      tone: "warning",
    });
    if (!ok) return;
    setStructurePanel((prev) => ({ ...prev, saving: true, error: "" }));
    try {
      const result = await window.openexam.subject.rebuildChapterStructure({
        subjectId: structurePanel.subjectId,
        source: structurePanel.sourceKey,
      });
      if (!result?.success) throw new Error(result?.error || "重新识别失败");
      setStructurePanel((prev) => ({
        ...prev,
        chapters: (result.structure?.chapters || []).map((item) => ({ ...item })),
        warnings: result.structure?.warnings || [],
        file: result.file || prev.file,
        saving: false,
      }));
    } catch (error) {
      setStructurePanel((prev) => ({ ...prev, saving: false, error: error?.message || String(error) }));
    }
  };

  const elapsed = pipeline ? formatElapsed(clock - (pipeline.startedAt || clock)) : "";

  return (
    <div className="page-inner subjects-page">
      <header className="subjects-header">
        <div>
          <h2>我的科目</h2>
          <p className="subjects-sub">
            先创建科目，再上传教材让 AI 建知识清单、收例题习题，最后按需设置考试日期（设了就是备考模式）。
            数学 / 英语 / 政治 / 专业课已预置并关联题库，可以直接改名或上传教材。
          </p>
        </div>
        <div className="subject-parse-controls">
          <div className="subject-parse-mode" role="group" aria-label="教材解析模式">
            <span className="subject-parse-mode-label">解析模式</span>
            <button
              type="button"
              className={parseMode === "fast" ? "is-active" : ""}
              onClick={() => changeParseMode("fast")}
              title="数字版 PDF 直接取文字层，只有扫描页才调识图模型：最快"
            >
              快速
            </button>
            <button
              type="button"
              className={parseMode === "precise" ? "is-active" : ""}
              onClick={() => changeParseMode("precise")}
              title="每页都渲染成图片交给识图模型：公式与版式更准，但慢很多"
            >
              精读
            </button>
          </div>
          <label className="subject-page-budget" title="扫描版教材每页都要识图，分批解析更可控；已解析的页下次会自动跳过">
            <span>本次解析</span>
            <select value={pageBudget} onChange={(event) => changePageBudget(event.target.value)}>
              {PAGE_BUDGET_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>
      </header>

      {/* 第一步：创建科目（只填名称） */}
      <section className="subject-create">
        <div className="subject-create-row">
          <input
            className="subject-input"
            placeholder="新建科目（可选）：如 高等数学（上）、英语四级"
            value={newName}
            maxLength={40}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && !creating) handleCreate(); }}
          />
          <button
            type="button"
            className="subject-create-btn"
            onClick={handleCreate}
            disabled={creating || !newName.trim()}
          >
            {creating ? "创建中…" : "创建科目"}
          </button>
        </div>
        {pipeline ? (
          <div className="subject-pipeline">
            <div className="subject-pipeline-bar">
              <div style={{ width: `${pipeline.percent || 8}%` }} />
            </div>
            <span>{pipeline.detail}</span>
            <span className="subject-pipeline-elapsed">{elapsed}</span>
            {pipeline.stage === "convert" || pipeline.stage === "transcribe" ? (
              <button type="button" className="subject-pipeline-cancel" onClick={cancelPipeline}>停止</button>
            ) : null}
          </div>
        ) : null}
      </section>

      <input ref={fileRef} type="file" accept=".pdf,image/*" style={{ display: "none" }} onChange={onFileChange} />

      {/* 科目列表 */}
      <div className="subject-grid">
        {subjects.map((subject) => {
          const stats = statsMap[subject.id] || { papers: 0, questions: 0, wrong: 0 };
          const days = daysUntil(subject.examDate);
          const textbookReady = subject.textbookStatus === "ready";
          const textbookFailed = subject.textbookStatus === "failed";
          const busy = pipeline?.subjectId === subject.id && pipeline.stage !== "done";
          return (
            <div key={subject.id} className={`subject-card${busy ? " is-busy" : ""}`}>
              <div className="subject-card-head">
                {editingId === subject.id ? (
                  <input
                    className="subject-input subject-rename"
                    value={editName}
                    autoFocus
                    maxLength={40}
                    onChange={(event) => setEditName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") commitRename();
                      if (event.key === "Escape") setEditingId("");
                    }}
                    onBlur={commitRename}
                  />
                ) : (
                  <strong title={subject.name}>{subject.name}</strong>
                )}
                <span className="subject-head-tools">
                  {editingId === subject.id ? (
                    <button type="button" className="subject-tool" title="保存改名" onMouseDown={(event) => { event.preventDefault(); commitRename(); }}>✓</button>
                  ) : (
                    <button type="button" className="subject-tool" title="重命名" onClick={() => startRename(subject)}>✎</button>
                  )}
                  <span className={`subject-mode-badge ${subject.mode === "exam" ? "is-exam" : ""}`}>
                    {MODE_LABEL[subject.mode]}
                  </span>
                </span>
              </div>

              <div className="subject-card-meta">
                {subject.mode === "exam" && subject.examDate ? (
                  <span className={days !== null && days <= 30 ? "is-urgent" : ""}>
                    考试 {subject.examDate}（{days !== null && days >= 0 ? `还有 ${days} 天` : "已过期"}）
                  </span>
                ) : (
                  <span>按自己的节奏学</span>
                )}
                <span>·</span>
                <span title="与题库分类联动：预置科目的题目按分类自动归属">
                  题库 {stats.questions} 题 / {stats.papers} 卷{stats.wrong ? ` / 错题 ${stats.wrong}` : ""}
                </span>
              </div>

              {/* 第二步：资料管理（应用内页面：主教材 + 补充资料） */}
              <div className="subject-card-textbook">
                <span className={textbookReady ? "is-ready" : ""}>
                  {subject.textbookName
                    ? `主教材：${subject.textbookName.slice(0, 16)}${
                      textbookReady
                        ? `（已解析 ${subject.textbookPages} 页）`
                        : subject.textbookStatus === "parsing"
                          ? "（解析中）"
                          : textbookFailed
                            ? "（上次解析中断）"
                            : ""
                    }`
                    : "主教材：未上传"}
                </span>
                <button type="button" className="subject-action" onClick={() => openMaterials(subject)} disabled={busy}>
                  资料管理
                </button>
              </div>

              {/* 第三步：考试日期（可选） */}
              <div className="subject-card-date">
                <input
                  type="date"
                  className="subject-input subject-date"
                  value={dateDraft[subject.id] ?? subject.examDate ?? ""}
                  onChange={(event) => setDateDraft((prev) => ({ ...prev, [subject.id]: event.target.value }))}
                />
                <button type="button" className="subject-action" onClick={() => handleExamDateSave(subject)} disabled={busy}>
                  {dateDraft[subject.id] === "" ? "取消考试" : "保存日期"}
                </button>
              </div>

              <div className="subject-card-actions">
                <button type="button" className="subject-action primary" onClick={() => goAsk(subject)} disabled={busy}>
                  去问助教
                </button>
                {textbookReady ? (
                  <button type="button" className="subject-action" onClick={() => onNavigate?.("notes")}>
                    知识清单
                  </button>
                ) : null}
                <button type="button" className="subject-action" onClick={() => openChapterStructure(subject)} disabled={busy}>
                  章节结构
                </button>
                <button type="button" className="subject-action danger" onClick={() => handleDelete(subject)} disabled={busy}>
                  删除
                </button>
              </div>
            </div>
          );
        })}
        {!subjects.length ? (
          <div className="subject-empty">还没有科目。在上面输入名称创建一个；数学 / 英语 / 政治 / 专业课首次启动时会自动预置。</div>
        ) : null}
      </div>

      {structurePanel ? (
        <div className="structure-overlay" onClick={() => !structurePanel.saving && setStructurePanel(null)}>
          <div className="structure-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="structure-dialog-head">
              <div>
                <strong>章节结构</strong>
                <span>{structurePanel.sourceName}{structurePanel.totalPages ? ` · 共 ${structurePanel.totalPages} 页` : ""}</span>
              </div>
              <button type="button" className="subject-action" onClick={() => setStructurePanel(null)} disabled={structurePanel.saving}>
                关闭
              </button>
            </div>
            <p className="structure-hint">
              知识清单会按这张表逐章取页。自动识别不完整或页码不对时，直接改下面的页码再保存；修改只在下次生成时生效。
            </p>
            {structurePanel.loading ? <div className="structure-loading">正在识别章节…</div> : null}
            {structurePanel.error ? <div className="structure-error">{structurePanel.error}</div> : null}
            {!structurePanel.loading ? (
              <div className="structure-list">
                {structurePanel.chapters.map((chapter, index) => (
                  <div className="structure-row" key={`${chapter.no}-${index}`}>
                    <span className={`structure-no ${chapter.auto ? "is-auto" : ""}`}>{chapter.auto ? "待核" : `第${chapter.no}章`}</span>
                    <input
                      className="subject-input structure-title"
                      value={chapter.title || ""}
                      onChange={(event) => updateStructureChapter(index, "title", event.target.value)}
                      placeholder="章节标题"
                    />
                    <input
                      className="subject-input structure-page"
                      type="number"
                      min="1"
                      value={chapter.fromPage ?? ""}
                      onChange={(event) => updateStructureChapter(index, "fromPage", event.target.value)}
                      placeholder="起"
                    />
                    <span className="structure-dash">–</span>
                    <input
                      className="subject-input structure-page"
                      type="number"
                      min="1"
                      value={chapter.toPage ?? ""}
                      onChange={(event) => updateStructureChapter(index, "toPage", event.target.value)}
                      placeholder="止"
                    />
                  </div>
                ))}
                {!structurePanel.chapters.length ? <div className="structure-loading">没有识别到章节，可点「重新识别」或先检查教材全文。</div> : null}
              </div>
            ) : null}
            {structurePanel.warnings?.length ? (
              <div className="structure-warnings">
                {structurePanel.warnings.map((warning, index) => <div key={index}>· {warning}</div>)}
              </div>
            ) : null}
            {structurePanel.file ? <div className="structure-file">已落盘：{structurePanel.file}</div> : null}
            <div className="structure-dialog-actions">
              <button type="button" className="subject-action" onClick={rebuildChapterStructure} disabled={structurePanel.loading || structurePanel.saving}>
                重新识别
              </button>
              <button type="button" className="subject-action primary" onClick={saveChapterStructure} disabled={structurePanel.loading || structurePanel.saving}>
                {structurePanel.saving ? "保存中…" : "保存章节结构"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
