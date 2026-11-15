import React, { useEffect, useMemo, useState } from "react";
import RichQuestionContent, { mathToPlainText } from "../components/RichQuestionContent.jsx";
import WrongQuestionEditor from "../components/WrongQuestionEditor.jsx";
import { useDialog } from "../components/DialogProvider.jsx";

const CN = { math: "数学", english: "英语", politics: "政治", major: "专业课" };
const FILTERS = [{ key: "due", label: "待复习" }, { key: "all", label: "全部" }, { key: "learning", label: "熟悉中" }, { key: "mastered", label: "已掌握" }];
const SOURCE_FILTERS = [
  { key: "all", label: "全部来源" },
  { key: "platform", label: "平台练习" },
  { key: "manual", label: "手动录入" },
  { key: "upload", label: "图片上传" },
];
const SOURCE_META = {
  platform: { label: "平台练习", color: "var(--info)" },
  manual: { label: "手动录入", color: "var(--accent)" },
  upload: { label: "图片上传", color: "var(--warning)" },
};
const STAGES = [
  { name: "新错题", color: "var(--danger)" },
  { name: "1天复习", color: "var(--warning)" },
  { name: "2天复习", color: "var(--info)" },
  { name: "4天复习", color: "var(--accent)" },
  { name: "7天复习", color: "var(--info)" },
  { name: "15天巩固", color: "var(--accent)" },
  { name: "30天掌握", color: "var(--success)" },
];
const parseTime = (value) => value ? new Date(String(value).replace(" ", "T") + "Z") : null;
const formatTime = (value, due) => {
  const date = parseTime(value); if (!date) return "立即复习";
  const diff = Math.round((date.getTime() - Date.now()) / 3600000);
  if (due || diff <= 0) return "现在可复习";
  if (diff < 24) return `${diff} 小时后`;
  const days = Math.round(diff / 24); return `${days} 天后`;
};
const formatShort = (value) => {
  const date = parseTime(value); if (!date) return "刚刚";
  const diff = Date.now() - date.getTime();
  if (diff < 3600000) return `${Math.max(1, Math.floor(diff / 60000))} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)} 天前`;
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
};
const stageMeta = (stage = 0) => STAGES[Math.max(0, Math.min(stage, STAGES.length - 1))];
const sortByUrgency = (a, b) => (Number(b.is_due) - Number(a.is_due)) || ((parseTime(a.next_review_at)?.getTime() || 0) - (parseTime(b.next_review_at)?.getTime() || 0)) || ((parseTime(b.added_at)?.getTime() || 0) - (parseTime(a.added_at)?.getTime() || 0));

const normalizeOptions = (options) => Array.isArray(options) ? options.map((opt) => ({
  key: String(opt?.key || ""),
  content: String(opt?.content || ""),
})).filter((opt) => opt.key) : [];

const matchKeyword = (item, keyword) => {
  if (!keyword) return true;
  const haystack = [
    item.content, item.content_html, item.answer, item.correct_answer,
    item.category, item.sub_category, item.source_label, item.reason, item.note,
  ].map((part) => String(part || "")).join(" ").toLowerCase();
  return haystack.includes(keyword.toLowerCase());
};

export default function WrongBook({ onRedo, onAskAI }) {
  const { confirm: showConfirm, toast: showToast } = useDialog();
  const [list, setList] = useState([]), [loading, setLoading] = useState(true), [filter, setFilter] = useState("due"), [expandedId, setExpandedId] = useState(null), [busyId, setBusyId] = useState(""), [error, setError] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all"), [keyword, setKeyword] = useState("");
  const [editorOpen, setEditorOpen] = useState(false), [editingItem, setEditingItem] = useState(null);

  const loadList = async () => {
    if (!window.openexam?.db?.getWrongQuestions) return setLoading(false);
    setLoading(true); setError("");
    try { const rows = await window.openexam.db.getWrongQuestions(); setList((rows || []).sort(sortByUrgency)); }
    catch (e) { setError(e.message || "错题读取失败"); }
    setLoading(false);
  };
  useEffect(() => { loadList(); }, []);

  const stats = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10); const catCount = {};
    list.forEach((item) => { catCount[item.category] = (catCount[item.category] || 0) + 1; });
    const weakest = Object.entries(catCount).sort((a, b) => b[1] - a[1])[0];
    return {
      due: list.filter((item) => item.is_due).length,
      today: list.filter((item) => String(item.added_at || "").startsWith(today)).length,
      mastered: list.filter((item) => (item.review_stage || 0) >= STAGES.length - 1 && !item.is_due).length,
      weakest: weakest ? CN[weakest[0]] || weakest[0] : "暂无",
    };
  }, [list]);

  const filtered = useMemo(() => list.filter((item) => {
    const stageOk = filter === "all"
      || (filter === "due" && item.is_due)
      || (filter === "learning" && !item.is_due && (item.review_stage || 0) < STAGES.length - 1)
      || (filter === "mastered" && !item.is_due && (item.review_stage || 0) >= STAGES.length - 1);
    const sourceOk = sourceFilter === "all" || (item.source_type || "platform") === sourceFilter;
    return stageOk && sourceOk && matchKeyword(item, keyword.trim());
  }).sort(sortByUrgency), [list, filter, sourceFilter, keyword]);

  const startRedo = (sourceList, filterOverride) => {
    if (typeof onRedo !== "function") return;
    const source = Array.isArray(sourceList) && sourceList.length
      ? sourceList
      : (filtered.length ? filtered : list);
    const nextFilter = filterOverride || filter;
    const seen = new Set();
    const questions = source.map((item, index) => {
      const id = String(item.question_id || item.id || `wrong_redo_${index}`);
      if (seen.has(id)) return null;
      seen.add(id);
      return {
        id,
        type: item.type || "single",
        category: item.category || "",
        sub_category: item.sub_category || "",
        content: item.content || "",
        content_html: item.content_html || "",
        options: normalizeOptions(item.options),
        answer: item.answer || item.correct_answer || "",
        analysis: item.analysis || "",
        analysis_html: item.analysis_html || "",
        paper_id: item.paper_id || null,
      };
    }).filter((item) => item && item.content && item.answer && item.options.length > 0);

    if (!questions.length) {
      setError("当前筛选下没有可重做的完整题目（图片题可点开对照复习）");
      return;
    }
    onRedo(questions, { filter: nextFilter, count: questions.length });
  };
  const focusDue = () => {
    setFilter("due");
    const dueItems = list.filter((item) => item.is_due);
    if (dueItems.length) {
      startRedo(dueItems, "due");
      return;
    }
    const first = list.find((item) => item.is_due);
    if (first) setExpandedId(first.id);
  };
  const updateReview = async (item, outcome) => {
    if (!window.openexam?.db?.reviewWrongQuestion) return;
    const key = `${item.id}:${outcome}`; setBusyId(key); setError("");
    try {
      const updated = await window.openexam.db.reviewWrongQuestion({ id: item.id, outcome });
      setList((prev) => prev.map((row) => row.id === updated.id ? updated : row).sort(sortByUrgency)); setExpandedId(updated.id);
    } catch (e) { setError(e.message || "复习状态更新失败"); }
    setBusyId("");
  };

  // 主动加入今日复习：只把到期时间提前，不改原来的阶梯进度
  const addToTodayReview = async (item) => {
    if (!window.openexam?.review?.addToday) return;
    setBusyId(`${item.id}:add`); setError("");
    try {
      const updated = await window.openexam.review.addToday(item.id);
      setList((prev) => prev.map((row) => row.id === updated.id ? updated : row).sort(sortByUrgency));
      showToast?.({ title: "今日复习", message: "已加入今日复习队列", tone: "success" });
    } catch (e) { setError(e.message || "加入今日复习失败"); }
    setBusyId("");
  };

  const openCreate = () => { setEditingItem(null); setEditorOpen(true); };
  const openEdit = (item) => { setEditingItem(item); setEditorOpen(true); };
  const handleSaved = async () => {
    await loadList();
    showToast?.({ title: "错题库", message: "已保存到错题库", tone: "success" });
  };
  const handleDelete = async (item) => {
    const ok = await showConfirm({
      title: "删除错题",
      message: `删除后无法恢复（含题目图片）。确定删除这道${SOURCE_META[item.source_type || "platform"]?.label || ""}错题吗？`,
    });
    if (!ok) return;
    try {
      await window.openexam.db.removeWrongQuestion({ id: item.id });
      setList((prev) => prev.filter((row) => row.id !== item.id));
      if (expandedId === item.id) setExpandedId(null);
      showToast?.({ title: "错题库", message: "错题已删除", tone: "success" });
    } catch (e) {
      setError(e.message || "删除失败");
    }
  };

  return (
    <section className="main-panel" style={{ padding: "0 22px 22px", display: "flex", flexDirection: "column", gap: 20, overflow: "auto", height: "100%", boxSizing: "border-box" }}>
      <header style={{ padding: "16px 0 0", display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="breadcrumb" style={{ margin: 0 }}>我的 &gt; 错题本</div>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap", paddingBottom: 14, borderBottom: "1px solid var(--line)" }}>
          <div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>今日复习台</div>
            <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.6px", lineHeight: 1 }}>
              {stats.due}
              <span style={{ fontSize: 14, fontWeight: 500, marginLeft: 8, color: "var(--muted)" }}>道待复习</span>
            </div>
            <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.6, color: "var(--muted)", maxWidth: 420 }}>
              平台上做错的题会自动收进来，也支持手动录入或上传自己整理的错题。
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button type="button" onClick={openCreate} className="primary-btn" style={{ padding: "8px 14px", borderRadius: 8 }}>＋ 录入错题</button>
            <button type="button" onClick={focusDue} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid var(--line)", background: "transparent", color: "var(--text)", fontWeight: 600, cursor: "pointer" }}>开始今日复习</button>
            <button type="button" onClick={loadList} style={{ padding: "8px 14px", borderRadius: 8, border: "none", background: "transparent", color: "var(--muted)", fontWeight: 600, cursor: "pointer" }}>刷新</button>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 0 }}>
          {[
            { label: "今日新增", value: `+${stats.today}`, tone: "var(--danger)" },
            { label: "已掌握", value: stats.mastered, tone: "var(--success)" },
            { label: "累计错题", value: list.length, tone: "var(--accent)" },
            { label: "薄弱板块", value: stats.weakest, tone: "var(--warning)" },
          ].map((card, index, arr) => (
            <div
              key={card.label}
              style={{
                padding: "4px 16px 4px 0",
                borderRight: index < arr.length - 1 ? "1px solid var(--line)" : "none",
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              <span style={{ fontSize: 11, color: "var(--muted)" }}>{card.label}</span>
              <span style={{ fontSize: typeof card.value === "number" ? 22 : 15, fontWeight: 700, color: card.tone, letterSpacing: "-0.3px" }}>{card.value}</span>
            </div>
          ))}
        </div>
      </header>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", borderBottom: "1px solid var(--line)", paddingBottom: 0 }}>
            {FILTERS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setFilter(item.key)}
                style={{
                  padding: "8px 0",
                  border: "none",
                  borderBottom: filter === item.key ? "2px solid var(--accent)" : "2px solid transparent",
                  background: "transparent",
                  color: filter === item.key ? "var(--accent)" : "var(--muted)",
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                  marginBottom: -1,
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>按紧急度排序 · {filtered.length} 道</div>
            <button
              type="button"
              onClick={startRedo}
              disabled={!list.length}
              style={{
                padding: "6px 0",
                border: "none",
                background: "transparent",
                color: "var(--accent)",
                fontSize: 12,
                fontWeight: 700,
                cursor: list.length ? "pointer" : "not-allowed",
                opacity: list.length ? 1 : 0.55,
              }}
            >
              按当前筛选重做
            </button>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {SOURCE_FILTERS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                onClick={() => setSourceFilter(entry.key)}
                style={{
                  padding: "4px 12px",
                  borderRadius: 999,
                  border: `1px solid ${sourceFilter === entry.key ? "var(--accent)" : "var(--line)"}`,
                  background: sourceFilter === entry.key ? "var(--surface-soft)" : "transparent",
                  color: sourceFilter === entry.key ? "var(--accent)" : "var(--muted)",
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索题干、答案、错因、来源…"
            style={{
              flex: 1,
              minWidth: 180,
              maxWidth: 320,
              padding: "6px 12px",
              borderRadius: 999,
              border: "1px solid var(--line)",
              background: "var(--surface)",
              color: "var(--text)",
              fontSize: 12,
              outline: "none",
            }}
          />
        </div>
      </div>

      {error && (
        <div style={{ padding: "10px 0", borderTop: "1px solid var(--danger-border)", borderBottom: "1px solid var(--danger-border)", color: "var(--danger)", fontSize: 12 }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: "80px 0", textAlign: "center", color: "var(--muted)" }}>错题加载中…</div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: "72px 0", textAlign: "center", color: "var(--muted)", borderTop: "1px dashed var(--line)", borderBottom: "1px dashed var(--line)", display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
          <span>{list.length === 0 ? "错题本还是空的。平台做错的题会自动收进来，也可以自己录入。" : "当前筛选下暂无错题，状态很棒。"}</span>
          {list.length === 0 && (
            <button type="button" onClick={openCreate} className="primary-btn" style={{ padding: "8px 18px", borderRadius: 8 }}>＋ 录入第一道错题</button>
          )}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {filtered.map((item) => {
            const meta = stageMeta(item.review_stage);
            const source = SOURCE_META[item.source_type || "platform"] || SOURCE_META.platform;
            const open = expandedId === item.id;
            const busyRemember = busyId === `${item.id}:remembered`;
            const busyAgain = busyId === `${item.id}:again`;
            const images = Array.isArray(item.images) ? item.images : [];
            return (
              <article key={item.id} style={{ borderBottom: "1px solid var(--line)", background: "transparent", overflow: "hidden" }}>
                <button type="button" onClick={() => setExpandedId(open ? null : item.id)} style={{ width: "100%", padding: 0, border: "none", background: "transparent", textAlign: "left", cursor: "pointer" }}>
                  <div style={{ padding: "16px 0", display: "flex", flexDirection: "column", gap: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 11 }}>
                      <span style={{ color: "var(--text)", fontWeight: 700 }}>{CN[item.category] || item.category || "未分类"}</span>
                      <span style={{ padding: "1px 8px", borderRadius: 999, border: `1px solid ${source.color}`, color: source.color, fontWeight: 700, fontSize: 10 }}>{source.label}</span>
                      <span style={{ color: meta.color, fontWeight: 600 }}>{meta.name}</span>
                      <span style={{ color: item.is_due ? "var(--accent)" : "var(--muted)", fontWeight: 600 }}>{item.is_due ? "待处理" : formatTime(item.next_review_at, item.is_due)}</span>
                      {item.reason && <span style={{ color: "var(--warning)", fontWeight: 600 }}>错因：{item.reason}</span>}
                      <span style={{ marginLeft: "auto", color: "var(--muted)" }}>{item.paper_title || "未关联试卷"}</span>
                    </div>
                    <div style={{ fontSize: 14, lineHeight: 1.75, color: "var(--text)", fontWeight: 600 }}>
                      {open ? <RichQuestionContent value={item.content_html || item.content} /> : (() => {
                        if (!item.content && images.length) return `📷 图片题 · ${images.length} 张图`;
                        const preview = mathToPlainText(item.content_html || item.content);
                        return preview.length <= 110 ? preview : `${preview.slice(0, 110)}...`;
                      })()}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10, fontSize: 12 }}>
                      <div>
                        <div style={{ color: "var(--muted)", marginBottom: 4 }}>你的答案</div>
                        <div style={{ color: "var(--danger)", fontWeight: 700 }}><RichQuestionContent value={item.user_answer || "未作答"} className="tb-inline" /></div>
                      </div>
                      <div>
                        <div style={{ color: "var(--muted)", marginBottom: 4 }}>【答案】</div>
                        <div style={{ color: "var(--success)", fontWeight: 700 }}><RichQuestionContent value={item.correct_answer || item.answer || "-"} className="tb-inline" /></div>
                      </div>
                      <div>
                        <div style={{ color: "var(--muted)", marginBottom: 4 }}>复习次数</div>
                        <div style={{ color: "var(--text)", fontWeight: 700 }}>{item.review_count || 0} 次</div>
                      </div>
                      <div>
                        <div style={{ color: "var(--muted)", marginBottom: 4 }}>加入时间</div>
                        <div style={{ color: "var(--text)", fontWeight: 700 }}>{formatShort(item.added_at)}</div>
                      </div>
                    </div>
                  </div>
                </button>
                {open && (
                  <div style={{ borderTop: "1px solid var(--line)", padding: "0 0 18px", display: "flex", flexDirection: "column", gap: 14 }}>
                    {images.length > 0 && (
                      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
                        {images.map((url, index) => (
                          <a key={url} href={url} target="_blank" rel="noreferrer" style={{ display: "block", width: 132, height: 132, borderRadius: 10, overflow: "hidden", border: "1px solid var(--line)" }}>
                            <img src={url} alt={`错题图片 ${index + 1}`} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                          </a>
                        ))}
                      </div>
                    )}
                    {Array.isArray(item.options) && item.options.length > 0 && (
                      <div style={{ display: "grid", gap: 0, marginTop: 12 }}>
                        {item.options.map((opt) => (
                          <div
                            key={opt.key}
                            style={{
                              padding: "10px 0",
                              borderBottom: "1px solid var(--line)",
                              fontSize: 12,
                              lineHeight: 1.6,
                              color: "var(--text)",
                            }}
                          >
                            <strong style={{ marginRight: 8, color: opt.key === (item.answer || item.correct_answer) ? "var(--success)" : opt.key === item.user_answer ? "var(--danger)" : "var(--text)" }}>{opt.key}．</strong>
                            <RichQuestionContent value={opt.content} className="rich-question-option" style={{ display: "inline-block", verticalAlign: "top", width: "calc(100% - 28px)" }} />
                          </div>
                        ))}
                      </div>
                    )}
                    {(item.analysis_html || item.analysis) && (
                      <div style={{ padding: "12px 0", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)", fontSize: 12, lineHeight: 1.8, color: "var(--text)" }}>
                        <div className="tb-label tb-label-plain" style={{ fontSize: 11, marginBottom: 6 }}>【解析】</div>
                        <RichQuestionContent value={item.analysis_html || item.analysis} className="rich-question-analysis" />
                      </div>
                    )}
                    {item.note && (
                      <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.7 }}>
                        <strong style={{ color: "var(--text)" }}>备注：</strong>{item.note}
                      </div>
                    )}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                      <div style={{ fontSize: 12, color: "var(--muted)" }}>
                        上次复习 {item.last_review ? formatShort(item.last_review) : "尚未开始"} · 下次 {formatTime(item.next_review_at, item.is_due)}
                      </div>
                      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                        <button type="button" onClick={() => onAskAI?.(item)} style={{ padding: "8px 0", border: "none", background: "transparent", color: "var(--accent)", fontWeight: 700, cursor: "pointer" }}>问 AI</button>
                        {!item.is_due && (
                          <button
                            type="button"
                            onClick={() => addToTodayReview(item)}
                            disabled={!!busyId}
                            style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--accent-border-soft)", background: "transparent", color: "var(--accent)", fontWeight: 700, cursor: busyId ? "wait" : "pointer" }}
                          >
                            {busyId === `${item.id}:add` ? "加入中…" : "加入今日复习"}
                          </button>
                        )}
                        <button type="button" onClick={() => openEdit(item)} style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--line)", background: "transparent", color: "var(--text)", fontWeight: 700, cursor: "pointer" }}>编辑</button>
                        <button type="button" onClick={() => handleDelete(item)} style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--danger-border)", background: "transparent", color: "var(--danger)", fontWeight: 700, cursor: "pointer" }}>删除</button>
                        <button type="button" onClick={() => updateReview(item, "again")} disabled={busyAgain || !!busyId} style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--danger-border)", background: "transparent", color: "var(--danger)", fontWeight: 700, cursor: busyId ? "wait" : "pointer" }}>{busyAgain ? "处理中..." : "继续复习"}</button>
                        <button type="button" onClick={() => updateReview(item, "remembered")} disabled={busyRemember || !!busyId} className="primary-btn" style={{ padding: "8px 14px", borderRadius: 8, boxShadow: "none" }}>{busyRemember ? "处理中..." : "记住了"}</button>
                      </div>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      <WrongQuestionEditor
        open={editorOpen}
        item={editingItem}
        onClose={() => setEditorOpen(false)}
        onSaved={handleSaved}
      />
    </section>
  );
}
