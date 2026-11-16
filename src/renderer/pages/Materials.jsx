import React, { useCallback, useEffect, useRef, useState } from "react";
import "../materials.css";

/**
 * 资料管理（应用内页面，按科目展示）。
 *
 * 主教材 = 权威来源，上传后走本地 MinerU 分批 OCR（仅 PDF）；
 * 补充资料 = 辅助，PDF 走 MinerU、PPTX 直接提取幻灯片文字、MD/TXT 直接可读。
 * 支持把文件拖到对应区域上传，进度通过 subject:mineruProgress 广播接收。
 */

const AUTO_PARSE_KINDS = new Set(["pdf", "pptx"]);
const SUPPLEMENTARY_EXTS = new Set(["pdf", "pptx", "md", "markdown", "txt", "png", "jpg", "jpeg", "webp"]);

const STATUS_TEXT = {
  none: "未上传",
  parsing: "解析中",
  ready: "已解析",
  failed: "解析失败",
  pending: "待解析",
};

function extOf(name) {
  const match = /\.([^.\\/]+)$/.exec(String(name || ""));
  return match ? match[1].toLowerCase() : "";
}

function fileNameOf(filePath) {
  return String(filePath || "").split(/[\\/]/).pop() || "学习资料";
}

function formatSize(size) {
  const n = Number(size) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function Materials({ subjectId, onBack, embedded = false, onOpenSettings }) {
  const [subject, setSubject] = useState(null);
  const [data, setData] = useState({ primary: null, supplementary: [] });
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState(null);
  const [envIssue, setEnvIssue] = useState("");
  const [envCheck, setEnvCheck] = useState({ loading: true });
  const [envInstall, setEnvInstall] = useState(null);
  const [primaryRetry, setPrimaryRetry] = useState(null);
  const [progress, setProgress] = useState(null);
  const [tasks, setTasks] = useState({});
  const [dragZone, setDragZone] = useState("");
  const dragDepth = useRef({ primary: 0, supplementary: 0 });
  // 进度完成后的延时刷新/自动消失：组件卸载时必须清掉，避免卸载后 setState
  const timersRef = useRef([]);
  const later = useCallback((fn, ms) => {
    const id = setTimeout(() => {
      timersRef.current = timersRef.current.filter((item) => item !== id);
      fn();
    }, ms);
    timersRef.current.push(id);
  }, []);
  useEffect(() => () => {
    timersRef.current.forEach((id) => clearTimeout(id));
    timersRef.current = [];
  }, []);

  const refresh = useCallback(async () => {
    if (!subjectId) return;
    try {
      const [s, list] = await Promise.all([
        window.openexam?.subject?.get?.(subjectId),
        window.openexam?.materials?.list?.(subjectId),
      ]);
      if (s) setSubject(s);
      if (list) {
        const supplementary = list.supplementary || [];
        const nextTasks = {};
        for (const item of supplementary) {
          if (item.parseTask) nextTasks[item.id] = item.parseTask;
        }
        setTasks(nextTasks);
        setData({ primary: list.primary || null, supplementary });
      }
    } catch (error) {
      setNotice({ tone: "error", text: `读取资料失败：${error?.message || error}` });
    }
  }, [subjectId]);

  useEffect(() => { refresh(); }, [refresh]);

  const refreshEnv = useCallback(async () => {
    try {
      const result = await window.openexam?.runtimeEnv?.detect?.();
      setEnvCheck({ loading: false, ...(result?.mineru || {}) });
    } catch (error) {
      // 检测本身失败时不挡上传，交给主进程预检兜底
      setEnvCheck({ loading: false, error: error?.message || String(error) });
    }
  }, []);

  // 进入资料管理就做一次 PDF 环境体检，别等用户选完文件才报错
  useEffect(() => { refreshEnv(); }, [refreshEnv]);
  useEffect(() => {
    window.openexam?.runtimeEnv?.getState?.().then((state) => {
      if (state?.running) setEnvInstall(state);
    }).catch(() => {});
    const off = window.openexam?.runtimeEnv?.onProgress?.((payload) => setEnvInstall(payload));
    return () => { off?.(); };
  }, []);

  useEffect(() => {
    const offChanged = window.openexam?.materials?.onChanged?.((payload) => {
      if (!payload?.subjectId || payload.subjectId === subjectId) refresh();
    });
    const offProgress = window.openexam?.subject?.onMineruProgress?.((payload) => {
      if (!payload?.subjectId || payload.subjectId !== subjectId) return;
      if (payload.materialId) {
        // 每份资料各自的进度；完成时刷新清单拿最终状态
        setTasks((current) => ({
          ...current,
          [payload.materialId]: {
            ...(current[payload.materialId] || {}),
            id: payload.materialId,
            status: "running",
            percent: Number(payload.percent) || 0,
            detail: payload.detail || "",
          },
        }));
        if (payload.percent >= 100) later(refresh, 600);
        return;
      }
      setProgress(payload);
      if (payload.percent >= 100) {
        later(() => setProgress(null), 1200);
        refresh();
      }
    });
    return () => { offChanged?.(); offProgress?.(); };
  }, [subjectId, refresh, later]);

  const flash = (tone, text) => {
    setNotice({ tone, text });
    later(() => setNotice(null), 6000);
  };

  const runPrimaryUpload = async (filePath, fileName) => {
    if (envCheck.ready === false) {
      setEnvIssue("PDF 解析环境还没准备好，请先在上方完成安装，或打开「设置 → 运行环境」查看缺什么。");
      return;
    }
    setPrimaryRetry(null);
    setBusy("primary");
    setEnvIssue("");
    try {
      const result = await window.openexam?.materials?.uploadPrimary?.({ subjectId, pdfPath: filePath, fileName });
      if (!result?.success) {
        // 缺 Python / MinerU / 模型：主进程在进入解析前就拦下并说明了缺什么
        if (result?.code === "mineru-not-ready") {
          setEnvIssue(result.error || "本地解析环境未就绪");
        } else {
          // 解析中断/失败：保留文件路径，提供「重试上次文件」
          setPrimaryRetry({ filePath, fileName });
        }
        throw new Error(result?.error || "主教材解析失败");
      }
      flash("ok", `主教材解析完成，共 ${result.pages} 页`);
      await refresh();
    } catch (error) {
      flash("error", error?.message || String(error));
      await refresh();
    } finally {
      setBusy("");
      setProgress(null);
      refreshEnv();
    }
  };

  const cancelPrimary = async () => {
    try {
      await window.openexam?.materials?.cancelPrimary?.(subjectId);
    } catch (error) {
      flash("error", error?.message || String(error));
    }
  };

  const startEnvInstall = async () => {
    setEnvInstall((prev) => ({ ...(prev || {}), running: true }));
    try {
      const result = await window.openexam?.runtimeEnv?.install?.({});
      if (result?.success) {
        flash("ok", result.alreadyReady ? "解析环境已就绪" : "解析环境安装完成，现在可以上传 PDF 了");
      } else if (result?.error) {
        setEnvIssue(result.error);
      }
    } catch (error) {
      setEnvIssue(error?.message || String(error));
    } finally {
      setEnvInstall((prev) => ({ ...(prev || {}), running: false }));
      await refreshEnv();
    }
  };

  const uploadPrimary = async () => {
    try {
      const picked = await window.openexam?.materials?.pickPrimary?.();
      if (!picked?.success) throw new Error(picked?.error || "选择文件失败");
      if (!picked.path) return;
      await runPrimaryUpload(picked.path, fileNameOf(picked.path));
    } catch (error) {
      flash("error", error?.message || String(error));
    }
  };

  /** 批量登记补充资料，并自动排队解析 PDF / PPTX */
  const addMaterialPaths = async (filePaths, preErrors = []) => {
    const paths = (filePaths || []).filter(Boolean);
    const problems = [...preErrors];
    if (!paths.length) {
      if (problems.length) flash("error", problems.join("；"));
      return;
    }
    setBusy("add");
    const added = [];
    try {
      for (const filePath of paths) {
        const name = fileNameOf(filePath);
        const result = await window.openexam?.materials?.add?.({ subjectId, filePath, name });
        if (result?.success) added.push(result.entry);
        else problems.push(`《${name}》添加失败：${result?.error || "未知原因"}`);
      }
      await refresh();
      const auto = added.filter((entry) => entry.status === "pending" && AUTO_PARSE_KINDS.has(entry.kind));
      const parts = [];
      if (added.length) parts.push(`已添加 ${added.length} 份资料${auto.length ? "，已加入解析队列" : ""}`);
      parts.push(...problems);
      if (parts.length) flash(problems.length ? "error" : "ok", parts.join("；"));
      // 只入队，不等待解析完成：任务由主进程执行，页面切走也不中断
      const queued = {};
      for (const entry of auto) {
        const result = await window.openexam?.materials?.parse?.({ subjectId, id: entry.id });
        if (result?.success) {
          if (result.task) queued[entry.id] = result.task;
        } else {
          problems.push(`《${entry.name}》入队失败：${result?.error || "未知原因"}`);
        }
      }
      if (Object.keys(queued).length) setTasks((current) => ({ ...current, ...queued }));
      if (problems.length) flash("error", problems.join("；"));
    } catch (error) {
      flash("error", error?.message || String(error));
    } finally {
      setBusy("");
      setProgress(null);
    }
  };

  const addFiles = async () => {
    try {
      const picked = await window.openexam?.materials?.pickFiles?.();
      if (!picked?.success) throw new Error(picked?.error || "选择文件失败");
      await addMaterialPaths(picked.files || []);
    } catch (error) {
      flash("error", error?.message || String(error));
    }
  };

  /* ------------------------------------------------------- 拖拽上传 */

  const resetDrag = () => {
    dragDepth.current.primary = 0;
    dragDepth.current.supplementary = 0;
    setDragZone("");
  };

  const readDroppedFiles = (event) => Array.from(event.dataTransfer?.files || []).map((file) => {
    const filePath = file?.path || window.openexam?.subject?.getPathForFile?.(file) || "";
    return { name: file?.name || fileNameOf(filePath), path: filePath };
  });

  const dragHandlers = (zone) => ({
    onDragEnter: (event) => {
      event.preventDefault();
      event.stopPropagation();
      dragDepth.current[zone] += 1;
      setDragZone(zone);
    },
    onDragOver: (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      if (dragZone !== zone) setDragZone(zone);
    },
    onDragLeave: (event) => {
      event.preventDefault();
      event.stopPropagation();
      dragDepth.current[zone] = Math.max(0, dragDepth.current[zone] - 1);
      if (!dragDepth.current[zone]) setDragZone((current) => (current === zone ? "" : current));
    },
  });

  const dropPrimary = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    resetDrag();
    const items = readDroppedFiles(event);
    if (!items.length) {
      flash("error", "没有读到拖入的文件，请改用「上传主教材」选择 PDF");
      return;
    }
    if (items.length !== 1) {
      flash("error", "主教材一次只能上传一份 PDF");
      return;
    }
    const item = items[0];
    if (extOf(item.name) !== "pdf") {
      flash("error", `主教材只支持 PDF，《${item.name}》未上传`);
      return;
    }
    if (!item.path) {
      flash("error", "无法读取文件路径，请改用「上传主教材」选择 PDF");
      return;
    }
    await runPrimaryUpload(item.path, item.name);
  };

  const dropSupplementary = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    resetDrag();
    const items = readDroppedFiles(event);
    if (!items.length) {
      flash("error", "没有读到拖入的文件，请改用「+ 添加学习资料」选择文件");
      return;
    }
    const errors = [];
    const accepted = [];
    for (const item of items) {
      const ext = extOf(item.name);
      if (!item.path) {
        errors.push(`《${item.name}》无法读取文件路径`);
      } else if (ext === "ppt") {
        errors.push(`《${item.name}》是旧版 .ppt，请另存为 .pptx 或导出 PDF`);
      } else if (!SUPPLEMENTARY_EXTS.has(ext)) {
        errors.push(`《${item.name}》格式（${ext ? `.${ext}` : "未知"}）不支持`);
      } else {
        accepted.push(item.path);
      }
    }
    await addMaterialPaths(accepted, errors);
  };

  const parseOne = async (item) => {
    try {
      const result = await window.openexam?.materials?.parse?.({ subjectId, id: item.id });
      if (!result?.success) throw new Error(result?.error || "加入解析队列失败");
      if (result.task) setTasks((current) => ({ ...current, [item.id]: result.task }));
      flash("ok", result.already
        ? `《${item.name}》已经解析完成`
        : `《${item.name}》已加入解析队列${result.concurrency ? `（同时最多 ${result.concurrency} 份）` : ""}`);
      await refresh();
    } catch (error) {
      flash("error", error?.message || String(error));
    }
  };

  const removeOne = async (item) => {
    if (!window.confirm(`确定移除《${item.name}》？原始文件与转写都会删除。`)) return;
    const result = await window.openexam?.materials?.remove?.({ subjectId, id: item.id });
    if (!result?.success) flash("error", result?.error || "删除失败");
    await refresh();
  };

  const primary = data.primary || {};
  const materials = data.supplementary || [];
  const isPrimaryBusy = busy === "primary";
  const showProgress = Boolean(progress && isPrimaryBusy);
  const envBlocked = envCheck.ready === false && !envCheck.error;
  const envMissing = Array.isArray(envCheck.missing) ? envCheck.missing : [];
  const envMissingText = envMissing.map((key) => ({
    python: "Python 3.10–3.12（64 位）",
    mineru: "MinerU 包",
    models: "本地模型",
    workDir: "工作目录",
    script: "解析脚本",
  }[key] || key)).join("、");
  const envInstallRunning = Boolean(envInstall?.running);
  const envInstallPercent = Math.max(0, Math.min(100, Number(envInstall?.percent) || 0));

  return (
    <div
      className={`materials-window${embedded ? " is-embedded" : ""}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        if (!event.dataTransfer?.files?.length) return;
        event.preventDefault();
        resetDrag();
        flash("error", "请把文件拖到上方「主教材」或「补充资料」区域内");
      }}
    >
      {!embedded ? (
        <header className="materials-header">
          <div>
            <button type="button" className="materials-back" onClick={onBack}>← 返回科目</button>
            <div className="materials-eyebrow">资料管理</div>
            <h1>{subject?.name || "科目"}</h1>
            <p>主教材是学习与出题的权威依据；补充资料只作辅助，冲突时以主教材为准。</p>
          </div>
          <span className="materials-mode-tag">{subject?.examDate ? "备考模式" : "学习模式"}</span>
        </header>
      ) : null}

      {envBlocked ? (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16, padding: '14px 16px',
          border: '1px solid var(--m-border)', borderRadius: 10, background: 'var(--warning-soft)',
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--warning)' }}>PDF 解析环境还没准备好</div>
          <div style={{ fontSize: 12.5, lineHeight: 1.7, color: 'var(--m-muted)' }}>
            缺少：{envMissingText || "解析组件"}。MinerU 和模型体积较大（模型至少数百 MB），首次安装通常要十几分钟到半小时，取决于网速。
            {envCheck.python?.ok ? ' Python 已就绪，可以直接在这里开始安装。' : ' 需要先安装 Python 3.10–3.12（64 位），再回来继续。'}
          </div>
          {envInstallRunning ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div className="materials-progress-bar" style={{ flex: 1 }}>
                <div style={{ width: `${envInstallPercent}%` }} />
              </div>
              <span style={{ fontSize: 12, color: 'var(--m-muted)' }}>{envInstall?.detail || '安装中…'} {envInstallPercent}%</span>
            </div>
          ) : null}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {envCheck.python?.ok ? (
              <button type="button" className="materials-btn is-primary" onClick={startEnvInstall} disabled={envInstallRunning}>
                {envInstallRunning ? '安装中…' : (envMissing.length ? '一键安装解析环境' : '重新检测')}
              </button>
            ) : (
              <button type="button" className="materials-btn is-primary" onClick={() => onOpenSettings?.("runtime")}>
                去安装 Python
              </button>
            )}
            <button type="button" className="materials-btn" onClick={() => onOpenSettings?.("runtime")}>打开运行环境设置</button>
            <button type="button" className="materials-btn is-ghost" onClick={refreshEnv} disabled={envInstallRunning}>重新检测</button>
          </div>
        </div>
      ) : null}

      {envIssue ? (
        <div className="materials-notice is-error" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ flex: 1, minWidth: 220 }}>{envIssue}</span>
          <button type="button" className="materials-btn is-primary" onClick={() => onOpenSettings?.("runtime")}>
            去安装解析环境
          </button>
        </div>
      ) : null}

      {notice ? <div className={`materials-notice is-${notice.tone}`}>{notice.text}</div> : null}

      {showProgress ? (
        <div className="materials-progress">
          <div className="materials-progress-bar">
            <div style={{ width: `${Math.min(100, Number(progress?.percent) || 0)}%` }} />
          </div>
          <span>{progress?.detail || "解析中…"}</span>
          <strong>{Math.min(100, Number(progress?.percent) || 0)}%</strong>
          <button type="button" className="materials-btn is-mini" onClick={cancelPrimary}>停止解析</button>
        </div>
      ) : null}

      {/* 主教材 */}
      <section
        className={`materials-section${dragZone === "primary" ? " is-drop-active" : ""}`}
        {...dragHandlers("primary")}
        onDrop={dropPrimary}
      >
        {dragZone === "primary" ? <div className="materials-drop-hint">松开即可上传主教材（仅 PDF）</div> : null}
        <div className="materials-section-head">
          <div>
            <h2><span className="materials-badge is-primary">主教材</span>权威来源</h2>
            <p className="materials-section-sub">知识清单、概念定义、章节范围与例题都以它为准。</p>
          </div>
          <button
            type="button"
            className="materials-btn is-primary"
            onClick={uploadPrimary}
            disabled={Boolean(busy) || envBlocked}
            title={envBlocked ? "先完成上方的 PDF 解析环境安装" : undefined}
          >
            {isPrimaryBusy ? "解析中…" : primary.name ? "更换主教材" : "上传主教材"}
          </button>
        </div>

        {primary.name ? (
          <div className="materials-primary-card">
            <div className="materials-file-icon">PDF</div>
            <div className="materials-file-main">
              <div className="materials-file-name" title={primary.name}>{primary.name}</div>
              <div className="materials-file-meta">
                状态 {STATUS_TEXT[primary.status] || primary.status}
                {primary.status === "ready" ? ` · 已解析 ${primary.pages} 页` : ""}
                {primary.chars ? ` · 全文 ${formatSize(primary.chars)}` : ""}
              </div>
              <div className="materials-file-path">教材/教材全文.md</div>
            </div>
            <span className={`materials-status is-${primary.status}`}>{STATUS_TEXT[primary.status] || primary.status}</span>
          </div>
        ) : (
          <div className="materials-empty">
            还没有主教材。把 PDF 拖到本区域，或点击「上传主教材」；解析会按页显示进度，过程中可以随时停止。
          </div>
        )}
        {primaryRetry && !isPrimaryBusy ? (
          <div className="materials-hint" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span>上次没解析成功：{primaryRetry.fileName}</span>
            <button
              type="button"
              className="materials-btn is-mini"
              onClick={() => runPrimaryUpload(primaryRetry.filePath, primaryRetry.fileName)}
            >
              重试上次文件
            </button>
          </div>
        ) : null}
        {primary.status === "failed" ? (
          <p className="materials-hint">上次解析中断，重新点击「更换主教材」会从上次已完成的页码继续。</p>
        ) : null}
      </section>

      {/* 补充资料 */}
      <section
        className={`materials-section${dragZone === "supplementary" ? " is-drop-active" : ""}`}
        {...dragHandlers("supplementary")}
        onDrop={dropSupplementary}
      >
        {dragZone === "supplementary" ? <div className="materials-drop-hint">松开即可添加资料（PDF / PPTX / Markdown / TXT / 图片）</div> : null}
        <div className="materials-section-head">
          <div>
            <h2><span className="materials-badge">补充资料</span>辅助参考</h2>
            <p className="materials-section-sub">课堂笔记、习题答案、讲义等；引用时会标注资料名，不覆盖主教材。</p>
          </div>
          <button type="button" className="materials-btn" onClick={addFiles} disabled={Boolean(busy)}>
            {busy === "add" ? "添加中…" : "+ 添加学习资料"}
          </button>
        </div>

        {materials.length ? (
          <div className="materials-list">
            {materials.map((item) => {
              const task = tasks[item.id];
              const parsing = Boolean(task) || item.status === "parsing";
              const needsReparse = item.status === "ready" && Boolean(item.missingPages?.length);
              const canParse = (item.status !== "ready" || needsReparse) && AUTO_PARSE_KINDS.has(item.kind) && !parsing && !busy;
              const taskText = task
                ? (task.status === "queued"
                  ? `排队中${task.position ? `（第 ${task.position} 位）` : ""}`
                  : `解析中 ${Math.round(Number(task.percent) || 0)}%`)
                : "";
              return (
                <div className="materials-row" key={item.id}>
                  <div className="materials-file-icon is-small">{String(item.ext || "").replace(".", "").toUpperCase() || "FILE"}</div>
                  <div className="materials-file-main">
                    <div className="materials-file-name" title={item.name}>{item.name}</div>
                    <div className="materials-file-meta">
                      {formatSize(item.size)} · {task ? taskText : (STATUS_TEXT[item.status] || item.status)}
                      {!task && item.chars ? ` · 转写 ${item.chars} 字` : ""}
                      {!task && item.missingPages?.length
                        ? ` · ${item.pages}/${item.totalPages || item.pages} 页，未转出：第 ${item.missingPages.slice(0, 6).join("、")}${item.missingPages.length > 6 ? "…" : ""} 页`
                        : ""}
                      {!task && item.error ? ` · ${String(item.error).slice(0, 60)}` : ""}
                    </div>
                    {task ? (
                      <>
                        <div className="materials-row-progress">
                          <div style={{ width: `${Math.max(2, Math.min(100, Number(task.percent) || 0))}%` }} />
                        </div>
                        {task.detail ? <div className="materials-row-detail" title={task.detail}>{task.detail}</div> : null}
                      </>
                    ) : null}
                  </div>
                  <div className="materials-row-actions">
                    {canParse ? (
                      <button type="button" className="materials-btn is-mini" onClick={() => parseOne(item)}>{needsReparse ? "重新解析" : "解析"}</button>
                    ) : null}
                    {!task && item.status === "ready" && item.hasText ? <span className="materials-ready">可供 AI 参考</span> : null}
                    {task ? <span className="materials-ready">{task.status === "queued" ? "排队中…" : "解析中…"}</span> : null}
                    <button type="button" className="materials-btn is-mini is-ghost" onClick={() => removeOne(item)} disabled={Boolean(busy) || parsing}>移除</button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="materials-empty">
            还没有补充资料。支持 PDF / PPTX（自动转写）与 Markdown / TXT（直接可读），也可以把文件直接拖进来。
          </div>
        )}
      </section>

      <footer className="materials-footer">
        资料变更后会自动同步给学习模式 Skill：主教材原文优先注入，补充资料按相关度辅助引用。
      </footer>
    </div>
  );
}
