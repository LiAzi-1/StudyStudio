import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * 错题录入 / 编辑弹窗（考研向）
 *
 * - 题型选择置顶：单选 / 多选 / 判断 / 填空 / 主观 五类并列，答案区随题型切换
 * - 选择题：直接在选项行上点选标记正确答案；判断题：对 / 错；填空 / 主观：文本作答
 * - 支持多图上传 + AI 识图自动回填；编辑时保留复习进度
 */

const CATEGORIES = [
  { key: "", label: "未分类" },
  { key: "math", label: "数学" },
  { key: "english", label: "英语" },
  { key: "politics", label: "政治" },
  { key: "major", label: "专业课" },
];

const TYPES = [
  { key: "single", label: "单选题", icon: "◉", hint: "四选一" },
  { key: "multiple", label: "多选题", icon: "☑", hint: "多个正确答案" },
  { key: "judge", label: "判断题", icon: "⭓", hint: "对 / 错" },
  { key: "fill", label: "填空题", icon: "＿＿", hint: "填写答案" },
  { key: "subjective", label: "主观题", icon: "✎", hint: "解答 / 简答" },
];

const REASONS = ["概念不清", "审题失误", "计算错误", "方法不会", "时间不够", "粗心大意", "知识遗忘"];

const JUDGE_OPTIONS = [{ key: "A", content: "正确" }, { key: "B", content: "错误" }];
const CHOICE_TYPES = ["single", "multiple"];

const genWrongId = () => `wrong_custom_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

const readFileAsDataURL = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result || ""));
  reader.onerror = () => reject(new Error("图片读取失败"));
  reader.readAsDataURL(file);
});

const dataUrlToBase64 = (dataUrl) => {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(dataUrl || ""));
  if (!match) return { base64: "", mimeType: "image/png" };
  return { base64: match[3] || "", mimeType: match[1] || "image/png" };
};

const normalizeType = (value) => TYPES.some((t) => t.key === value) ? value : "single";

const normalizeOptionsInput = (raw) => {
  if (!Array.isArray(raw)) return [{ key: "A", content: "" }, { key: "B", content: "" }, { key: "C", content: "" }, { key: "D", content: "" }];
  const mapped = raw.map((opt, index) => ({
    key: String(opt?.key || String.fromCharCode(65 + index)).toUpperCase(),
    content: String(opt?.content ?? ""),
  }));
  return mapped.length ? mapped : [{ key: "A", content: "" }, { key: "B", content: "" }, { key: "C", content: "" }, { key: "D", content: "" }];
};

const normalizeImagesInput = (raw) => {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    if (typeof entry === "string") return { url: entry, file: entry.split("/").pop() || "", dataUrl: "" };
    return { url: String(entry?.url || ""), file: String(entry?.file || ""), dataUrl: String(entry?.dataUrl || "") };
  }).filter((entry) => entry.url || entry.dataUrl);
};

const splitKeys = (answer) => String(answer || "").toUpperCase().replace(/[^A-H]/g, "").split("");

/** 已落盘的图片（只有 url）要参与 AI 识别时，先取回 dataURL */
const fetchUrlAsDataURL = async (url) => {
  const response = await fetch(url);
  const blob = await response.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(blob);
  });
};

export default function WrongQuestionEditor({ open, item, onClose, onSaved }) {
  const isEdit = Boolean(item?.id);
  const [sourceType, setSourceType] = useState("manual");
  const [type, setType] = useState("single");
  const [category, setCategory] = useState("");
  const [content, setContent] = useState("");
  const [options, setOptions] = useState(normalizeOptionsInput(null));
  const [userAnswer, setUserAnswer] = useState("");
  const [answer, setAnswer] = useState("");
  const [analysis, setAnalysis] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [sourceLabel, setSourceLabel] = useState("");
  const [images, setImages] = useState([]);
  const [removedFiles, setRemovedFiles] = useState([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [recognizing, setRecognizing] = useState(false);
  const requestIdRef = useRef("");

  // 打开时初始化 / 回填
  useEffect(() => {
    if (!open) return;
    setError("");
    setRemovedFiles([]);
    setSaving(false);
    setRecognizing(false);
    if (item?.id) {
      setSourceType(item.source_type === "upload" ? "upload" : "manual");
      const nextType = normalizeType(item.type);
      setType(nextType);
      setCategory(String(item.category || ""));
      setContent(String(item.content || ""));
      setOptions(normalizeOptionsInput(item.options));
      setUserAnswer(String(item.user_answer || ""));
      setAnswer(String(item.answer || item.correct_answer || ""));
      setAnalysis(String(item.analysis || ""));
      setReason(String(item.reason || ""));
      setNote(String(item.note || ""));
      setSourceLabel(String(item.source_label || ""));
      setImages(normalizeImagesInput(item.images));
    } else {
      setSourceType("manual");
      setType("single");
      setCategory("");
      setContent("");
      setOptions(normalizeOptionsInput(null));
      setUserAnswer("");
      setAnswer("");
      setAnalysis("");
      setReason("");
      setNote("");
      setSourceLabel("");
      setImages([]);
    }
  }, [open, item]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape" && !saving && !recognizing) onClose?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, saving, recognizing, onClose]);

  const isChoice = CHOICE_TYPES.includes(type);
  const isJudge = type === "judge";
  const isSubjective = type === "subjective";
  const activeOptions = isJudge ? JUDGE_OPTIONS : (isChoice ? options : []);
  const correctKeys = useMemo(() => splitKeys(answer), [answer]);
  const myKeys = useMemo(() => splitKeys(userAnswer), [userAnswer]);

  if (!open) return null;

  const toggleCorrectKey = (key) => {
    if (type === "single" || isJudge) {
      setAnswer(key);
    } else if (type === "multiple") {
      const has = correctKeys.includes(key);
      const next = has ? correctKeys.filter((k) => k !== key) : [...correctKeys, key].sort();
      setAnswer(next.join(""));
    }
  };

  const toggleMyKey = (key) => {
    if (type === "single" || isJudge) {
      setUserAnswer((prev) => (splitKeys(prev)[0] === key ? "" : key));
    } else {
      const has = myKeys.includes(key);
      const next = has ? myKeys.filter((k) => k !== key) : [...myKeys, key].sort();
      setUserAnswer(next.join(""));
    }
  };

  const handlePickFiles = async (fileList) => {
    const files = Array.from(fileList || []).filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    try {
      const entries = await Promise.all(files.map(async (file) => ({
        url: "",
        file: file.name || "",
        dataUrl: await readFileAsDataURL(file),
      })));
      setSourceType("upload");
      setImages((prev) => [...prev, ...entries].slice(0, 12));
      setError("");
    } catch (err) {
      setError(err.message || "图片读取失败");
    }
  };

  const removeImageAt = (index) => {
    setImages((prev) => {
      const target = prev[index];
      if (target?.url && target?.file) {
        setRemovedFiles((files) => [...files, target.file]);
      }
      return prev.filter((_, i) => i !== index);
    });
  };

  const handleRecognize = async () => {
    const first = images.find((entry) => entry.dataUrl || entry.url);
    if (!first) {
      setError("请先上传至少一张题目图片，再点 AI 识图");
      return;
    }
    if (!window.openexam?.ai?.recognizeQuestions) {
      setError("当前环境不支持 AI 识图");
      return;
    }
    setRecognizing(true);
    setError("");
    const requestId = `wrong_recognize_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    requestIdRef.current = requestId;
    try {
      let dataUrl = first.dataUrl;
      if (!dataUrl && first.url) dataUrl = await fetchUrlAsDataURL(first.url);
      const { base64, mimeType } = dataUrlToBase64(dataUrl);
      if (!base64) throw new Error("图片内容为空");

      const sqliteSettings = await window.openexam.db.getAISettings();
      const { normalizeAISettings } = await import("../store/aiSettings.js");
      const settings = normalizeAISettings(sqliteSettings);
      if (!settings?.apiKey && !settings?.baseUrl) {
        throw new Error("请先在「设置 → AI 配置」里完成配置");
      }

      const result = await window.openexam.ai.recognizeQuestions(settings, base64, mimeType, requestId);
      if (result?.error) throw new Error(result.error);
      const question = Array.isArray(result?.questions) ? result.questions[0] : null;
      if (!question) throw new Error("AI 没能从图片里识别出题目，换个更清晰的图试试");

      const aiContent = String(question.content || "").trim();
      const aiOptions = Array.isArray(question.options)
        ? question.options.map((opt, index) => ({
          key: String(opt?.key || String.fromCharCode(65 + index)).toUpperCase(),
          content: String(opt?.content ?? (typeof opt === "string" ? opt : "")),
        })).filter((opt) => opt.content)
        : [];
      const aiAnswer = String(question.answer ?? "").trim();
      const aiAnalysis = String(question.analysis || "").trim();
      const aiType = normalizeType(String(question.type || ""));

      if (aiContent) setContent((prev) => prev || aiContent);
      if (aiOptions.length) {
        if (CHOICE_TYPES.includes(aiType) || aiType === "judge") setType(aiType);
        setOptions(normalizeOptionsInput(aiOptions));
      }
      if (aiAnswer) setAnswer(aiAnswer);
      if (aiAnalysis) setAnalysis(aiAnalysis);
      setSourceType((prev) => prev || "upload");
    } catch (err) {
      setError(err.message || "AI 识图失败");
    } finally {
      setRecognizing(false);
      requestIdRef.current = "";
    }
  };

  const handleSave = async () => {
    const trimmedContent = content.trim();
    if (!trimmedContent && images.length === 0) {
      setError("请填写题干，或至少上传一张题目图片");
      return;
    }
    if (isChoice && activeOptions.filter((opt) => opt.content.trim()).length < 2) {
      setError("选择题至少需要两个非空选项");
      return;
    }
    if ((isChoice || isJudge) && !answer.trim()) {
      setError("请点选正确答案");
      return;
    }

    const wrongId = item?.id || genWrongId();
    setSaving(true);
    setError("");
    try {
      const db = window.openexam?.db;
      if (!db?.saveCustomWrongQuestion) throw new Error("当前环境不支持保存错题");

      // 上传新图片 → 拿到正式 url
      const uploadedUrls = [];
      for (const entry of images) {
        if (entry.url) { uploadedUrls.push(entry.url); continue; }
        if (!entry.dataUrl || !db.addWrongImage) continue;
        const saved = await db.addWrongImage({ wrongId, dataUrl: entry.dataUrl, name: entry.file });
        if (!saved?.success) throw new Error(saved?.error || "图片保存失败");
        uploadedUrls.push(saved.url);
      }

      // 清掉编辑时删掉的旧图
      if (db.removeWrongImage) {
        for (const file of removedFiles) {
          await db.removeWrongImage({ wrongId, file }).catch(() => {});
        }
      }

      const saved = await db.saveCustomWrongQuestion({
        id: wrongId,
        questionId: item?.question_id || "",
        type,
        category,
        content: trimmedContent,
        options: activeOptions,
        userAnswer: userAnswer.trim(),
        answer: answer.trim(),
        analysis: analysis.trim(),
        images: uploadedUrls,
        sourceType: images.length ? (sourceType === "manual" && !trimmedContent ? "upload" : sourceType) : "manual",
        sourceLabel: sourceLabel.trim(),
        reason: reason.trim(),
        note: note.trim(),
      });
      onSaved?.(saved);
      onClose?.();
    } catch (err) {
      setError(err.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const inputStyle = {
    width: "100%",
    boxSizing: "border-box",
    padding: "8px 10px",
    borderRadius: 8,
    border: "1px solid var(--line)",
    background: "var(--surface)",
    color: "var(--text)",
    fontSize: 13,
    outline: "none",
  };
  const labelStyle = { fontSize: 12, fontWeight: 700, color: "var(--muted)", marginBottom: 6 };
  const chipStyle = (active, color = "var(--accent)") => ({
    padding: "5px 12px",
    borderRadius: 999,
    border: `1px solid ${active ? color : "var(--line)"}`,
    background: active ? "var(--surface-soft)" : "transparent",
    color: active ? color : "var(--muted)",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
  });
  const typeCardStyle = (active) => ({
    flex: 1,
    minWidth: 86,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
    padding: "10px 6px 8px",
    borderRadius: 10,
    border: `1.5px solid ${active ? "var(--accent)" : "var(--line)"}`,
    background: active ? "var(--surface-soft)" : "transparent",
    color: active ? "var(--accent)" : "var(--muted)",
    cursor: "pointer",
  });

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(15, 18, 25, 0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving && !recognizing) onClose?.();
      }}
    >
      <div
        style={{
          width: "min(720px, 100%)",
          maxHeight: "88vh",
          overflow: "auto",
          background: "var(--surface-elevated)",
          border: "1px solid var(--line)",
          borderRadius: 14,
          boxShadow: "0 18px 48px rgba(0,0,0,0.18)",
          padding: "20px 22px 22px",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700, color: "var(--text)" }}>{isEdit ? "编辑错题" : "录入错题"}</div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
              支持单选、多选、判断、填空、主观题；也可以拍照上传，让 AI 帮你识别填空。
            </div>
          </div>
          <button
            type="button"
            onClick={() => { if (!saving && !recognizing) onClose?.(); }}
            style={{ border: "none", background: "transparent", color: "var(--muted)", fontSize: 18, cursor: "pointer", lineHeight: 1 }}
            aria-label="关闭"
          >
            ×
          </button>
        </header>

        {/* 第一步：题型 */}
        <div>
          <div style={labelStyle}>题型</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {TYPES.map((entry) => (
              <button
                key={entry.key}
                type="button"
                onClick={() => { setType(entry.key); if (!CHOICE_TYPES.includes(entry.key) && entry.key !== "judge") setAnswer(""); }}
                style={typeCardStyle(type === entry.key)}
              >
                <span style={{ fontSize: 16, lineHeight: 1 }}>{entry.icon}</span>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{entry.label}</span>
                <span style={{ fontSize: 10, opacity: 0.8 }}>{entry.hint}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 科目 + 错因 */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <div style={labelStyle}>科目</div>
            <select value={category} onChange={(event) => setCategory(event.target.value)} style={inputStyle}>
              {CATEGORIES.map((entry) => (
                <option key={entry.key} value={entry.key}>{entry.label}</option>
              ))}
            </select>
          </div>
          <div>
            <div style={labelStyle}>错因</div>
            <select value={reason} onChange={(event) => setReason(event.target.value)} style={inputStyle}>
              <option value="">未选择</option>
              {REASONS.map((entry) => (
                <option key={entry} value={entry}>{entry}</option>
              ))}
            </select>
          </div>
        </div>

        {/* 题干 */}
        <div>
          <div style={labelStyle}>题干{images.length ? "（纯图片题可留空）" : ""}</div>
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={4}
            placeholder="粘贴或输入题目内容…"
            style={{ ...inputStyle, resize: "vertical", lineHeight: 1.7 }}
          />
        </div>

        {/* 图片上传 + AI 识图 */}
        <div>
          <div style={{ ...labelStyle, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>题目图片（最多 12 张，可选）</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={handleRecognize}
                disabled={recognizing || !images.length}
                style={{
                  padding: "4px 10px",
                  borderRadius: 8,
                  border: "1px solid var(--line)",
                  background: "transparent",
                  color: images.length ? "var(--accent)" : "var(--muted)",
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: images.length && !recognizing ? "pointer" : "not-allowed",
                  opacity: images.length ? 1 : 0.6,
                }}
              >
                {recognizing ? "AI 识别中…" : "🤖 AI 识图自动填充"}
              </button>
              <label
                style={{
                  padding: "4px 10px",
                  borderRadius: 8,
                  border: "1px solid var(--line)",
                  fontSize: 12,
                  fontWeight: 700,
                  color: "var(--muted)",
                  cursor: "pointer",
                }}
              >
                + 添加图片
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  style={{ display: "none" }}
                  onChange={(event) => { handlePickFiles(event.target.files); event.target.value = ""; }}
                />
              </label>
            </div>
          </div>
          {images.length ? (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {images.map((entry, index) => (
                <div
                  key={`${entry.url || entry.dataUrl.slice(0, 32)}_${index}`}
                  style={{ position: "relative", width: 96, height: 96, borderRadius: 10, overflow: "hidden", border: "1px solid var(--line)" }}
                >
                  <img src={entry.dataUrl || entry.url} alt={`错题图片 ${index + 1}`} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  <button
                    type="button"
                    onClick={() => removeImageAt(index)}
                    style={{
                      position: "absolute", top: 4, right: 4, width: 20, height: 20,
                      borderRadius: "50%", border: "none", background: "rgba(0,0,0,0.55)",
                      color: "#fff", fontSize: 12, lineHeight: 1, cursor: "pointer",
                    }}
                    aria-label="删除图片"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ padding: "10px 0", fontSize: 12, color: "var(--muted)" }}>
              上传题目照片或截图后，可用 AI 识图自动回填题干、选项和答案。
            </div>
          )}
        </div>

        {/* 答案区：按题型切换 */}
        {(isChoice || isJudge) && (
          <div>
            <div style={{ ...labelStyle, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span>
                {isJudge ? "正确答案（点击选择）" : "选项（点击左侧圆点标记正确答案）"}
                {type === "multiple" && <span style={{ fontWeight: 400 }}> · 可多选</span>}
              </span>
              {isChoice && (
                <button
                  type="button"
                  onClick={() => setOptions((prev) => {
                    const nextKey = String.fromCharCode(65 + prev.length);
                    return [...prev, { key: nextKey, content: "" }];
                  })}
                  disabled={options.length >= 8}
                  style={{ border: "none", background: "transparent", color: "var(--accent)", fontSize: 12, fontWeight: 700, cursor: options.length >= 8 ? "not-allowed" : "pointer" }}
                >
                  + 加一个选项
                </button>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {activeOptions.map((opt, index) => {
                const isCorrect = correctKeys.includes(opt.key);
                return (
                  <div
                    key={opt.key}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: isJudge ? "8px 12px" : "6px 10px",
                      borderRadius: 10,
                      border: `1px solid ${isCorrect ? "var(--success)" : "var(--line)"}`,
                      background: isCorrect ? "var(--surface-soft)" : "transparent",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => toggleCorrectKey(opt.key)}
                      title="标记为正确答案"
                      style={{
                        width: 22,
                        height: 22,
                        flexShrink: 0,
                        borderRadius: type === "multiple" ? 6 : "50%",
                        border: `1.5px solid ${isCorrect ? "var(--success)" : "var(--line)"}`,
                        background: isCorrect ? "var(--success)" : "transparent",
                        color: "#fff",
                        fontSize: 12,
                        fontWeight: 700,
                        lineHeight: 1,
                        cursor: "pointer",
                      }}
                    >
                      {isCorrect ? "✓" : ""}
                    </button>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", width: 18 }}>{opt.key}.</span>
                    {isJudge ? (
                      <span style={{ flex: 1, fontSize: 13, color: "var(--text)" }}>{opt.content}</span>
                    ) : (
                      <input
                        value={opt.content}
                        onChange={(event) => setOptions((prev) => prev.map((row, i) => i === index ? { ...row, content: event.target.value } : row))}
                        placeholder={`选项 ${opt.key} 内容`}
                        style={{ ...inputStyle, border: "none", background: "transparent", padding: "4px 0" }}
                      />
                    )}
                    {isChoice && options.length > 2 && (
                      <button
                        type="button"
                        onClick={() => setOptions((prev) => prev.filter((_, i) => i !== index).map((row, i) => ({ ...row, key: String.fromCharCode(65 + i) })))}
                        style={{ border: "none", background: "transparent", color: "var(--danger)", fontSize: 14, cursor: "pointer" }}
                        aria-label="删除选项"
                      >
                        ×
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {/* 我的错选 */}
            <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, color: "var(--muted)", fontWeight: 700 }}>我的错选：</span>
              {activeOptions.map((opt) => (
                <button key={opt.key} type="button" onClick={() => toggleMyKey(opt.key)} style={chipStyle(myKeys.includes(opt.key), "var(--danger)")}>
                  {opt.key}
                </button>
              ))}
              <span style={{ fontSize: 11, color: "var(--muted)" }}>（可留空）</span>
            </div>
          </div>
        )}

        {type === "fill" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <div style={labelStyle}>正确答案</div>
              <input
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                placeholder="填写正确答案"
                style={inputStyle}
              />
            </div>
            <div>
              <div style={labelStyle}>我当时的答案（可选）</div>
              <input
                value={userAnswer}
                onChange={(event) => setUserAnswer(event.target.value)}
                placeholder="填写当时错写的答案"
                style={inputStyle}
              />
            </div>
          </div>
        )}

        {isSubjective && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <div style={labelStyle}>参考答案 / 答题要点（可选）</div>
              <textarea
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                rows={3}
                placeholder="粘贴参考答案或关键词、得分点…"
                style={{ ...inputStyle, resize: "vertical", lineHeight: 1.7 }}
              />
            </div>
            <div>
              <div style={labelStyle}>我的作答（可选，便于对照复盘）</div>
              <textarea
                value={userAnswer}
                onChange={(event) => setUserAnswer(event.target.value)}
                rows={3}
                placeholder="当时是怎么写的…"
                style={{ ...inputStyle, resize: "vertical", lineHeight: 1.7 }}
              />
            </div>
          </div>
        )}

        {/* 解析 */}
        <div>
          <div style={labelStyle}>解析 / 正确思路（可选）</div>
          <textarea
            value={analysis}
            onChange={(event) => setAnalysis(event.target.value)}
            rows={3}
            placeholder="记录这道题的解题思路或口诀…"
            style={{ ...inputStyle, resize: "vertical", lineHeight: 1.7 }}
          />
        </div>

        {/* 来源 + 备注 */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <div style={labelStyle}>来源</div>
            <input
              value={sourceLabel}
              onChange={(event) => setSourceLabel(event.target.value)}
              placeholder="如：2026 考研数学一 第 12 题"
              style={inputStyle}
            />
          </div>
          <div>
            <div style={labelStyle}>备注</div>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="补充说明、相关知识点（可选）"
              style={inputStyle}
            />
          </div>
        </div>

        {error && (
          <div style={{ padding: "8px 12px", borderRadius: 8, background: "var(--danger-soft, rgba(220,38,38,0.08))", color: "var(--danger)", fontSize: 12, lineHeight: 1.6 }}>
            {error}
          </div>
        )}

        <footer style={{ display: "flex", justifyContent: "flex-end", gap: 10, paddingTop: 4 }}>
          <button
            type="button"
            onClick={() => { if (!saving && !recognizing) onClose?.(); }}
            style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid var(--line)", background: "transparent", color: "var(--muted)", fontWeight: 600, cursor: "pointer" }}
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || recognizing}
            className="primary-btn"
            style={{ padding: "8px 20px", borderRadius: 8, opacity: saving ? 0.7 : 1 }}
          >
            {saving ? "保存中…" : (isEdit ? "保存修改" : "保存到错题库")}
          </button>
        </footer>
      </div>
    </div>
  );
}
