import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDialog } from "../components/DialogProvider.jsx";
import ObsidianSyncBar from "../components/ObsidianSyncBar.jsx";
import { NoteSubjectGrid, NoteTreeView } from "../components/NoteTree.jsx";

const SOURCE_LABEL = {
  question: "题目",
  vocab: "词语",
  essay: "专业课",
  paper: "试卷",
};

function Icon({ path, size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{path}</svg>
  );
}

const SearchIcon = <><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></>;
const PlusIcon = <><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>;
const PinIcon = <path d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6z" />;
const TrashIcon = <><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>;
const SparkIcon = <><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /><circle cx="12" cy="12" r="4" /></>;
const MapIcon = <><path d="M9 3 3 6v15l6-3 6 3 6-3V3l-6 3-6-3z" /><path d="M9 3v15M15 6v15" /></>;
const ExternalIcon = <><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" /></>;
const ImageIcon = <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></>;

/** 笔记图片在正文里的引用：![说明](openexam-asset://note-assets/<noteId>/<file>) */
const IMAGE_RE = /!\[[^\]]*\]\((openexam-asset:\/\/note-assets\/[^)\s]+)\)/g;

function genNoteId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

/** 从正文里摘出已引用的图片，去重后给缩略图条用 */
function collectImages(content) {
  const list = [];
  for (const match of String(content || "").matchAll(IMAGE_RE)) {
    const url = match[1];
    if (list.some((item) => item.url === url)) continue;
    const file = decodeURIComponent(url.split("/").pop() || "");
    list.push({ url, raw: match[0], file });
  }
  return list;
}

function relTime(iso) {
  if (!iso) return "";
  const t = new Date(iso.replace(" ", "T") + (iso.includes("Z") ? "" : "Z"));
  const diff = Date.now() - t.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return `${t.getMonth() + 1}/${t.getDate()}`;
}

/** 搜索命中片段：主进程用 ⟦⟧ 包住关键词 */
function Snippet({ text }) {
  if (!text) return null;
  const parts = String(text).split(/(⟦[^⟧]*⟧)/g);
  return (
    <p className="note-card-snippet">
      {parts.map((part, i) =>
        part.startsWith("⟦") && part.endsWith("⟧")
          ? <mark key={i}>{part.slice(1, -1)}</mark>
          : <React.Fragment key={i}>{part}</React.Fragment>
      )}
    </p>
  );
}

/** AI 不可用时，用本地分类结果拼一份 meta，至少让分类先落地 */
function buildLocalMeta(result) {
  if (!result) return null;
  return {
    ai: false,
    fallback: true,
    at: new Date().toISOString(),
    title: result.title || "",
    summary: result.summary || "",
    subject: result.subject || "",
    topic: result.topic || "",
    noteType: result.noteType || "",
    difficulty: result.difficulty || 3,
    mastery: result.mastery || "",
    keyConcepts: result.keyConcepts || [],
    knowledgePoints: (result.knowledgePoints || []).map((item) => ({
      id: item.id,
      label: item.label,
      note: item.note || "",
    })),
  };
}

/** 分类标签行：编辑器与笔记卡片共用 */
function MetaChips({ meta, compact = false }) {
  if (!meta) return null;
  const points = meta.knowledgePoints || [];
  const hasAny = meta.subject || meta.topic || meta.noteType || points.length;
  if (!hasAny) return null;

  return (
    <div className={`note-meta-chips${compact ? " is-compact" : ""}`}>
      {meta.subject && <span className="note-chip is-subject">{meta.subject}</span>}
      {meta.topic && <span className="note-chip">{meta.topic}</span>}
      {meta.noteType && <span className="note-chip is-type">{meta.noteType}</span>}
      {!compact && points.map((point) => (
        <span key={point.id} className="note-chip is-kp" title={point.id}>
          {point.label}
        </span>
      ))}
      {!compact && meta.difficulty ? (
        <span className="note-chip is-quiet">难度 {meta.difficulty}</span>
      ) : null}
      {!compact && meta.mastery ? (
        <span className="note-chip is-quiet">{meta.mastery}</span>
      ) : null}
      {!compact && meta.fallback ? (
        <span className="note-chip is-quiet" title="AI 不可用，按关键词归类">本地分类</span>
      ) : null}
    </div>
  );
}

export default function Notes({ initialDraft = null, onBack }) {
  const dialog = useDialog();
  const [notes, setNotes] = useState([]);
  const [tags, setTags] = useState([]);
  const [keyword, setKeyword] = useState("");
  const [activeTag, setActiveTag] = useState("");
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [openingObs, setOpeningObs] = useState("");
  const [tree, setTree] = useState(null);
  const [treeLoading, setTreeLoading] = useState(true);
  const [activeSubjectId, setActiveSubjectId] = useState(null);

  const load = useCallback(async (kw = keyword, tag = activeTag) => {
    if (!window.openexam?.note) return;
    const isSearch = kw.trim().length > 0;
    setLoading(true);
    if (!isSearch) setTreeLoading(true);
    try {
      const [res, tagList, treeRes] = await Promise.all([
        isSearch
          ? window.openexam.note.search(kw, { limit: 100 })
          : window.openexam.note.list({ limit: 200, tag: tag || undefined }),
        window.openexam.note.tags(),
        isSearch ? null : window.openexam.note.tree(),
      ]);
      setNotes(res?.items || []);
      setTags(Array.isArray(tagList) ? tagList : []);
      if (treeRes) setTree(treeRes);
    } catch (error) {
      console.error("加载笔记失败:", error);
    } finally {
      setLoading(false);
      setTreeLoading(false);
    }
  }, [keyword, activeTag]);

  const activeSubject = useMemo(() => {
    if (activeSubjectId === null || !tree?.subjects) return null;
    return tree.subjects.find((item) => item.id === activeSubjectId) || null;
  }, [activeSubjectId, tree]);

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 搜索输入防抖
  useEffect(() => {
    const timer = setTimeout(() => load(keyword, activeTag), 220);
    return () => clearTimeout(timer);
  }, [keyword, activeTag]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (initialDraft) setSelected({ ...initialDraft });
  }, [initialDraft]);

  // 新建时就把 ID 定下来：图片要按笔记 ID 落盘，不能等保存后才生成
  // 在某个学科下新建时，顺手把学科绑定和分类带上，笔记直接落进该学科的树里
  const createNote = (subject = null) => setSelected({
    id: genNoteId(),
    content: "",
    tags: subject?.name ? [subject.name] : [],
    subjectId: subject?.id || null,
    meta: subject?.id ? { category: "subject", subject: subject.name } : undefined,
  });

  /** 树里只有摘要，打开时再拉全文 */
  const openNoteById = useCallback(async (id) => {
    if (!id) return;
    const full = await window.openexam.note.get(id);
    if (full) setSelected(full);
  }, []);

  const handleSaved = async () => {
    setSelected(null);
    load();
  };

  const removeNote = async (note) => {
    const ok = await dialog.confirm({ title: "删除笔记", message: `「${note.title}」删掉后无法恢复。` });
    if (!ok) return;
    await window.openexam.note.remove(note.id);
    if (selected?.id === note.id) setSelected(null);
    load();
  };

  const togglePin = async (note) => {
    await window.openexam.note.save({ ...note, pinned: !note.pinned });
    load();
  };

  const openMindmap = useCallback(async () => {
    const res = await window.openexam?.obsidian?.openMap?.();
    if (res?.success) {
      if (res.fallback) dialog.toast({ message: res.message || "本机没装 Obsidian，已用系统默认程序打开", tone: "info" });
      return;
    }
    if (res?.code === "obsidian-missing") {
      const download = await dialog.confirm({
        title: "没装 Obsidian",
        message: `${res.error || "打开知识地图需要 Obsidian"}。笔记与题库不受影响。`,
        confirmText: "下载 Obsidian",
        cancelText: "稍后再说",
        tone: "info",
      });
      if (download) window.openexam?.app?.openExternal?.(res.downloadUrl || "https://obsidian.md/download");
      return;
    }
    dialog.toast({ message: res?.error || "打不开知识地图", tone: "warning" });
  }, [dialog]);

  /** 从笔记卡片直接跳到 Obsidian 里对应的那篇（不是整个仓库） */
  const openInObsidian = useCallback(async (note) => {
    if (!window.openexam?.obsidian?.openNote) {
      dialog.toast({ message: "Obsidian 联动没有加载", tone: "warning" });
      return;
    }
    setOpeningObs(note.id);
    try {
      const res = await window.openexam.obsidian.openNote(note.id);
      if (res?.success) {
        if (res.fallback) {
          dialog.toast({
            title: "已用系统默认程序打开",
            message: res.message || "本机没装 Obsidian，笔记已用默认程序打开；应用内也能直接阅读。",
            tone: "info",
          });
          return;
        }
        dialog.toast({
          title: "已在 Obsidian 打开",
          message: `${res.file}｜在那边改完会自动回流到应用`,
          tone: "success",
        });
        return;
      }
      if (res?.code === "obsidian-missing") {
        const download = await dialog.confirm({
          title: "没装 Obsidian",
          message: `${res.error || "打开笔记需要 Obsidian"}。笔记内容仍保存在应用里，可以直接在笔记页阅读。`,
          confirmText: "下载 Obsidian",
          cancelText: "稍后再说",
          tone: "info",
        });
        if (download) window.openexam?.app?.openExternal?.(res.downloadUrl || "https://obsidian.md/download");
        return;
      }
      dialog.toast({ title: "打不开 Obsidian 笔记", message: res?.error || "未知原因", tone: "warning" });
    } catch (error) {
      dialog.toast({ title: "打不开 Obsidian 笔记", message: error.message, tone: "warning" });
    } finally {
      setOpeningObs("");
    }
  }, [dialog]);

  const obsToast = useCallback((payload) => {
    dialog.toast({
      title: payload?.title,
      message: payload?.message,
      tone: payload?.tone || "info",
    });
  }, [dialog]);

  const searching = keyword.trim().length > 0;
  // 搜索或按标签筛选时回退成平铺列表，其余时候走「学科 → 树状图」
  const flatMode = searching || Boolean(activeTag);

  return (
    <div className="notes-page">
      <header className="notes-head">
        <div>
          <h1>笔记</h1>
          <p>随手记下的东西都在这，全文可搜，AI 助教能读懂并归类。</p>
        </div>
        <div className="notes-head-actions">
          <ObsidianSyncBar onToast={obsToast} onSynced={load} />
          <button type="button" className="notes-ghost" onClick={openMindmap} title="打开 Obsidian 知识地图">
            <Icon path={MapIcon} size={15} />
            <span>知识地图</span>
          </button>
          <button type="button" className="notes-new" onClick={() => createNote(activeSubject)}>
            <Icon path={PlusIcon} size={15} />
            <span>新建笔记</span>
          </button>
        </div>
      </header>

      <div className="notes-toolbar">
        <div className="notes-search">
          <Icon path={SearchIcon} size={15} />
          <input
            value={keyword}
            placeholder="搜标题、正文、标签…"
            onChange={(e) => setKeyword(e.target.value)}
          />
          {keyword && (
            <button type="button" className="notes-search-clear" onClick={() => setKeyword("")}>清除</button>
          )}
        </div>
      </div>

      {tags.length > 0 && !searching && (
        <div className="notes-tags">
          <button
            type="button"
            className={`notes-tag${activeTag ? "" : " is-active"}`}
            onClick={() => setActiveTag("")}
          >
            全部 <em>{notes.length}</em>
          </button>
          {tags.map(({ tag, count }) => (
            <button
              key={tag}
              type="button"
              className={`notes-tag${activeTag === tag ? " is-active" : ""}`}
              onClick={() => setActiveTag(activeTag === tag ? "" : tag)}
            >
              {tag} <em>{count}</em>
            </button>
          ))}
        </div>
      )}

      {flatMode ? (
        loading ? (
          <div className="notes-empty">加载中…</div>
        ) : notes.length === 0 ? (
          <div className="notes-empty">
            {searching ? (
              <>没搜到「{keyword}」相关的笔记</>
            ) : (
              <>
                <strong>还没有笔记</strong>
                <span>刷题时想到什么、专业课漏了哪个点，随手记一条，以后能搜回来。</span>
                <button type="button" onClick={() => createNote(activeSubject)}>记第一条</button>
              </>
            )}
          </div>
        ) : (
          <div className="notes-grid">
            {notes.map((note) => (
              <article key={note.id} className={`note-card${note.pinned ? " is-pinned" : ""}`} onClick={() => setSelected(note)}>
                <div className="note-card-head">
                  <h3>{note.title || "未命名笔记"}</h3>
                  <div className="note-card-tools" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className={openingObs === note.id ? "is-on" : ""}
                      onClick={() => openInObsidian(note)}
                      aria-label="在 Obsidian 中打开"
                      title="在 Obsidian 中打开这篇笔记"
                      disabled={openingObs === note.id}
                    >
                      <Icon path={ExternalIcon} size={14} />
                    </button>
                    <button type="button" className={note.pinned ? "is-on" : ""} onClick={() => togglePin(note)} aria-label="置顶">
                      <Icon path={PinIcon} size={14} />
                    </button>
                    <button type="button" onClick={() => removeNote(note)} aria-label="删除">
                      <Icon path={TrashIcon} size={14} />
                    </button>
                  </div>
                </div>

                {note.snippet
                  ? <Snippet text={note.snippet} />
                  : (
                    <p className="note-card-body">
                      {String(note.content || "").replace(IMAGE_RE, " ").replace(/^#{1,4}\s+/gm, "").slice(0, 140)}
                    </p>
                  )}

                <MetaChips meta={note.meta} compact />

                <footer className="note-card-foot">
                  {note.sourceType && (
                    <span className="note-card-source">
                      {SOURCE_LABEL[note.sourceType] || note.sourceType}
                      {note.sourceLabel ? ` · ${note.sourceLabel}` : ""}
                    </span>
                  )}
                  {(() => {
                    const count = collectImages(note.content).length;
                    return count > 0 ? <span className="note-card-tag">图 {count}</span> : null;
                  })()}
                  {note.tags.map((tag) => <span key={tag} className="note-card-tag">{tag}</span>)}
                  <time>{relTime(note.updatedAt)}</time>
                </footer>
              </article>
            ))}
          </div>
        )
      ) : activeSubject ? (
        <NoteTreeView
          key={activeSubject.id || "unbound"}
          subject={activeSubject}
          onBack={() => setActiveSubjectId(null)}
          onOpenNote={openNoteById}
        />
      ) : (
        <NoteSubjectGrid
          subjects={tree?.subjects || []}
          loading={treeLoading}
          onPick={(subject) => setActiveSubjectId(subject.id)}
        />
      )}

      {selected && (
        <NoteEditor
          note={selected}
          onClose={() => setSelected(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------ 笔记编辑器 */

export function NoteEditor({ note, onClose, onSaved }) {
  // 草稿也可能没有 ID（比如从题目页带过来的 draft），这里先定下来，图片才有归属目录
  const noteId = useMemo(() => note.id || genNoteId(), [note.id]);
  const [content, setContent] = useState(note.content || "");
  const [tagInput, setTagInput] = useState((note.tags || []).join(" "));
  const [meta, setMeta] = useState(note.meta || null);
  const [titleOverride, setTitleOverride] = useState(note.meta?.title || "");
  const [history, setHistory] = useState([]);
  const [tutoring, setTutoring] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [hint, setHint] = useState("");
  const [hintTone, setHintTone] = useState("idle");
  const [saving, setSaving] = useState(false);
  const areaRef = useRef(null);
  const fileInputRef = useRef(null);

  const attachments = useMemo(() => collectImages(content), [content]);

  useEffect(() => {
    areaRef.current?.focus();
    const el = areaRef.current;
    if (el) el.selectionStart = el.selectionEnd = el.value.length;
  }, []);

  const dirty = useMemo(
    () => content !== (note.content || "")
      || tagInput !== (note.tags || []).join(" ")
      || JSON.stringify(meta) !== JSON.stringify(note.meta || null),
    [content, tagInput, meta, note]
  );

  /** 只写库、不关闭编辑器：编辑器里点「在 Obsidian 中打开」时先落盘用 */
  const flush = useCallback(async () => {
    // 手写 / AI 整理（没带分类）的笔记统一归入学科笔记；清单笔记保持 inventory
    const nextMeta = { ...(meta || {}) };
    if (!nextMeta.category) {
      nextMeta.category = Array.isArray(nextMeta.chapters) && nextMeta.chapters.length ? 'inventory' : 'subject';
    }
    return window.openexam.note.save({
      id: noteId,
      title: titleOverride || undefined,
      content,
      tags: tagInput,
      meta: nextMeta,
      subjectId: note.subjectId || undefined,
      sourceType: note.sourceType,
      sourceId: note.sourceId,
      sourceLabel: note.sourceLabel,
      pinned: note.pinned,
    });
  }, [noteId, content, tagInput, meta, titleOverride, note]);

  const save = useCallback(async () => {
    if (!content.trim()) { onClose(); return; }
    setSaving(true);
    try {
      await flush();
      onSaved();
    } catch (error) {
      console.error("保存笔记失败:", error);
      setSaving(false);
    }
  }, [content, flush, onClose, onSaved]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(); }
      if (e.key === "Escape" && !dirty) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, dirty, onClose]);

  const snapshot = useCallback(
    () => ({ content, tagInput, meta, titleOverride }),
    [content, tagInput, meta, titleOverride]
  );

  /* -------------------------------------------------------- 图片上传 */

  /** 在光标处插入文本（图片 markdown 走这里） */
  const insertAtCursor = useCallback((text) => {
    const el = areaRef.current;
    const start = el ? (el.selectionStart ?? el.value.length) : null;
    const end = el ? (el.selectionEnd ?? start) : null;
    const caret = start === null ? 0 : start;

    setContent((prev) => {
      const at = start === null ? prev.length : start;
      const to = end === null ? at : end;
      return prev.slice(0, at) + text + prev.slice(to);
    });

    if (el) {
      requestAnimationFrame(() => {
        el.focus();
        const pos = caret + text.length;
        el.selectionStart = el.selectionEnd = pos;
      });
    }
  }, []);

  /** 粘贴截图 / 拖入文件 / 选文件，最终都走这里 */
  const uploadFiles = useCallback(async (files) => {
    const list = Array.from(files || []).filter((file) => String(file.type || "").startsWith("image/"));
    if (!list.length) return;
    if (!window.openexam?.note?.addImage) {
      setHint("图片上传没有加载，重启应用再试");
      setHintTone("warn");
      return;
    }

    setUploading(true);
    const marks = [];
    for (const file of list) {
      try {
        const dataUrl = await fileToDataUrl(file);
        const res = await window.openexam.note.addImage({ noteId, dataUrl, name: file.name });
        if (!res?.success) {
          setHint(res?.error || "图片上传失败");
          setHintTone("warn");
          continue;
        }
        const alt = String(file.name || "图片").replace(/\.[^.]+$/, "").trim() || "图片";
        marks.push(`![${alt}](${res.url})`);
      } catch (error) {
        setHint(`图片上传失败：${error.message}`);
        setHintTone("warn");
      }
    }
    setUploading(false);

    if (marks.length) {
      insertAtCursor(`\n${marks.join("\n")}\n`);
      setHint(`已插入 ${marks.length} 张图片`);
      setHintTone("ok");
    }
  }, [noteId, insertAtCursor]);

  const handlePaste = useCallback((event) => {
    const items = event.clipboardData?.items;
    if (!items || !items.length) return;
    const files = [];
    for (const item of items) {
      if (item.kind === "file" && String(item.type || "").startsWith("image/")) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (!files.length) return;
    event.preventDefault();
    uploadFiles(files);
  }, [uploadFiles]);

  const handleDrop = useCallback((event) => {
    setDragOver(false);
    const files = event.dataTransfer?.files;
    if (!files || !files.length) return;
    const images = Array.from(files).filter((file) => String(file.type || "").startsWith("image/"));
    if (!images.length) return;
    event.preventDefault();
    uploadFiles(images);
  }, [uploadFiles]);

  const removeAttachment = useCallback(async (item) => {
    setContent((prev) => prev.split(item.raw).join("").replace(/\n{3,}/g, "\n\n"));
    await window.openexam?.note?.removeImage?.({ noteId, file: item.file });
  }, [noteId]);

  /** 让 AI 助教读懂笔记：规范化正文 + 精细化分类 */
  const runTutor = useCallback(async () => {
    if (tutoring || !content.trim()) return;
    if (!window.openexam?.note?.tutor) {
      setHint("AI 助教没有加载，重启应用再试");
      setHintTone("warn");
      return;
    }

    setTutoring(true);
    setHint("正在读你的笔记…");
    setHintTone("busy");

    try {
      const res = await window.openexam.note.tutor({
        content,
        title: titleOverride || note.title || "",
        tags: tagInput,
        // 挂在自建科目上的笔记不走行测考点树，需要把科目带过去
        subjectId: note.subjectId || undefined,
      });

      if (res?.success) {
        setHistory((prev) => [...prev, snapshot()]);
        setContent(res.result.body || content);
        setTagInput((res.result.tags || []).join(" "));
        setMeta(res.meta || null);
        setTitleOverride(res.result.title || "");
        setHint(`已整理并归类 · ${res.model || "AI"}`);
        setHintTone("ok");
      } else if (res?.result) {
        // AI 不可用：正文不动，只落地本地分类
        setHistory((prev) => [...prev, snapshot()]);
        setMeta(buildLocalMeta(res.result));
        setHint(`${res.error || "AI 不可用"}，已按关键词归类`);
        setHintTone("warn");
      } else {
        setHint(res?.error || "AI 整理失败");
        setHintTone("warn");
      }
    } catch (error) {
      setHint(`AI 整理失败：${error.message}`);
      setHintTone("warn");
    } finally {
      setTutoring(false);
    }
  }, [tutoring, content, tagInput, titleOverride, note.title, snapshot]);

  const undo = useCallback(() => {
    setHistory((prev) => {
      if (!prev.length) return prev;
      const last = prev[prev.length - 1];
      setContent(last.content);
      setTagInput(last.tagInput);
      setMeta(last.meta);
      setTitleOverride(last.titleOverride);
      setHint("已撤销整理");
      setHintTone("idle");
      return prev.slice(0, -1);
    });
  }, []);

  /** 编辑器里跳转：有未保存的改动先落盘，免得 Obsidian 打开的是旧稿 */
  const openThisInObsidian = useCallback(async () => {
    setHint("正在打开 Obsidian…");
    setHintTone("busy");
    try {
      if (dirty && content.trim()) await flush();
      const res = await window.openexam?.obsidian?.openNote?.(noteId);
      if (!res?.success) {
        setHint(res?.error || "打不开 Obsidian 笔记");
        setHintTone("warn");
        return;
      }
      setHint(`已在 Obsidian 打开：${res.file}`);
      setHintTone("ok");
    } catch (error) {
      setHint(error.message);
      setHintTone("warn");
    }
  }, [dirty, content, flush, noteId]);

  const openMap = useCallback(async () => {
    const res = await window.openexam?.obsidian?.openMap?.();
    if (!res?.success) {
      setHint(res?.error || "打不开知识地图");
      setHintTone("warn");
    }
  }, []);

  const wordCount = content.replace(/\s/g, "").length;
  const tutored = !!meta?.ai;

  return (
    <div className="note-editor-scrim" onClick={() => (dirty ? save() : onClose())}>
      <div
        className={`note-editor${dragOver ? " is-dragover" : ""}`}
        onClick={(e) => e.stopPropagation()}
        onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget)) return;
          setDragOver(false);
        }}
        onDrop={handleDrop}
      >
        {note.sourceLabel && (
          <div className="note-editor-source">
            来自{SOURCE_LABEL[note.sourceType] || "练习"}：{note.sourceLabel}
          </div>
        )}

        <textarea
          ref={areaRef}
          className="note-editor-area"
          value={content}
          placeholder="第一行会成为标题。&#10;&#10;想到什么写什么 —— 错因、易混知识点、专业课复盘。&#10;截图可以直接粘贴进来，也能把图片拖到这儿。&#10;写完点「AI 助教整理」，它会补小标题、归到考点、生成可跳转的知识地图。"
          onChange={(e) => setContent(e.target.value)}
          onPaste={handlePaste}
        />

        <div className="note-attachments">
          <button
            type="button"
            className="note-attach-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            <Icon path={ImageIcon} size={14} />
            <span>{uploading ? "上传中…" : "插入图片"}</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              uploadFiles(e.target.files);
              e.target.value = "";
            }}
          />
          {attachments.length > 0 ? (
            <div className="note-attach-list">
              {attachments.map((item) => (
                <span key={item.url} className="note-attach-thumb" title={item.file}>
                  <img src={item.url} alt="" />
                  <button type="button" onClick={() => removeAttachment(item)} aria-label="移除图片">×</button>
                </span>
              ))}
            </div>
          ) : (
            <span className="note-attach-tip">粘贴截图或拖入图片都行</span>
          )}
        </div>

        {dragOver && <div className="note-drop-hint">松手就插入图片</div>}

        <div className="note-editor-ai">
          <button
            type="button"
            className={`note-tutor-btn${tutored ? " is-done" : ""}`}
            onClick={runTutor}
            disabled={tutoring || !content.trim()}
          >
            <Icon path={SparkIcon} size={14} />
            <span>{tutoring ? "AI 正在读…" : tutored ? "重新整理" : "AI 助教整理"}</span>
          </button>
          {history.length > 0 && (
            <button type="button" className="note-tutor-ghost" onClick={undo}>撤销整理</button>
          )}
          <button
            type="button"
            className="note-tutor-ghost is-obs"
            onClick={openThisInObsidian}
            title="在 Obsidian 中打开这篇笔记（会先保存当前改动）"
          >
            <Icon path={ExternalIcon} size={13} />
            <span>在 Obsidian 中打开</span>
          </button>
          {tutored && (
            <button type="button" className="note-tutor-ghost" onClick={openMap}>看知识地图</button>
          )}
          {hint && <span className="note-tutor-hint" data-tone={hintTone}>{hint}</span>}
        </div>

        <MetaChips meta={meta} />

        <div className="note-editor-foot">
          <input
            className="note-editor-tags"
            value={tagInput}
            placeholder="标签，空格分隔"
            onChange={(e) => setTagInput(e.target.value)}
          />
          <span className="note-editor-count">{wordCount} 字</span>
          <button type="button" className="note-editor-cancel" onClick={onClose}>取消</button>
          <button type="button" className="note-editor-save" disabled={saving || !content.trim()} onClick={save}>
            {saving ? "保存中…" : "保存"}
            <kbd>⌘S</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
