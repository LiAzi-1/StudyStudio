import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useDialog } from "../components/DialogProvider.jsx";

const KIND_META = {
  vocab: { label: "英语词汇", color: "var(--category-yanyu)", action: "去积累" },
  essay: { label: "专业课", color: "var(--category-changshi)", action: "去练习" },
  drill: { label: "专项题库", color: "var(--category-panduan)", action: "去刷题" },
  note: { label: "笔记", color: "var(--category-ziliao)", action: "去记录" },
  custom: { label: "自定", color: "var(--muted)", action: "标记完成" },
};

const KIND_OPTIONS = [
  { value: "vocab", label: "词语积累" },
  { value: "essay", label: "专业课练习" },
  { value: "drill", label: "专项题库练习" },
  { value: "note", label: "笔记复盘" },
  { value: "custom", label: "自定义" },
];

const REPEAT_OPTIONS = [
  { value: "daily", label: "每天" },
  { value: "weekdays", label: "工作日" },
  { value: "weekly:0,6", label: "周末" },
];

const UNIT_LABEL = { count: "个", minutes: "分钟", once: "次" };

const SUBJECT_COLORS = {
  math: "var(--accent)",
  english: "var(--category-yanyu)",
  politics: "var(--category-panduan)",
  major: "var(--category-changshi)",
};

const subjectColor = (key) => SUBJECT_COLORS[key] || "var(--info)";

const countAnswered = (answers) => {
  if (!answers || typeof answers !== "object") return 0;
  return Object.values(answers).filter((value) => {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === "object") return true;
    return String(value ?? "").trim().length > 0;
  }).length;
};

function Icon({ path, size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {path}
    </svg>
  );
}

const CheckIcon = <polyline points="20 6 9 17 4 12" />;
const PlusIcon = <><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>;
const SlidersIcon = (
  <>
    <line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" />
    <line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" />
    <line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" />
    <line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" />
  </>
);
const TrashIcon = (
  <><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>
);

function formatDate(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · ${week}`;
}

function targetText(target) {
  if (!target || target.unit === "once") return "";
  const unit = UNIT_LABEL[target.unit] || "";
  return `${target.value}${unit}`;
}

export default function Today({
  onStartDrill,
  onStartVocab,
  onStartEssay,
  onOpenNotes,
  onOpenTemplates,
  onStartReview,
  onStartDailyPractice,
  onOpenDailyReview,
  onOpenImport,
  onOpenMaterials,
}) {
  const dialog = useDialog();
  const [daily, setDaily] = useState(null);
  const [streak, setStreak] = useState(0);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [managing, setManaging] = useState(false);
  const [reviewQueue, setReviewQueue] = useState({ total: 0, groups: [] });
  const [dailyPractice, setDailyPractice] = useState({ set: null, subjects: [], record: null });
  const [dailyCategory, setDailyCategory] = useState("");
  const [startingDaily, setStartingDaily] = useState(false);

  const load = useCallback(async () => {
    if (!window.openexam?.todo) return;
    const safe = (promise) => Promise.resolve(promise).catch(() => null);
    try {
      const [data, streakData, reviewData, dailyData] = await Promise.all([
        window.openexam.todo.getDaily(),
        window.openexam.todo.getStreak(30),
        safe(window.openexam.review?.getTodayQueue?.()),
        safe(window.openexam.dailyPractice?.getToday?.()),
      ]);
      setDaily(data);
      setStreak(streakData?.streak || 0);
      if (reviewData) setReviewQueue(reviewData);
      if (dailyData) setDailyPractice(dailyData);
    } catch (error) {
      console.error("加载今日待办失败:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // 从练习/笔记页回到首页时刷新进度
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const items = daily?.items || [];
  const summary = daily?.summary || { active: 0, done: 0, percent: 0, allDone: false };
  const overdue = daily?.overdue || [];

  const reviewGroups = reviewQueue?.groups || [];
  const reviewTotal = Number(reviewQueue?.total) || 0;
  const dailySet = dailyPractice?.set || null;
  const dailySubjects = dailyPractice?.subjects || [];
  const dailyRecord = dailyPractice?.record || null;
  const dailyTotal = Number(dailySet?.totalCount) || dailySet?.questionIds?.length || 0;
  const dailyAnswered = countAnswered(dailyRecord?.answers);
  const dailyDone = dailySet?.status === "done";
  // 题库为空时，默认待办里的练习动作都会落到「暂无题目」；统一改成先去导入
  const bankEmpty = !dailySet && dailySubjects.length === 0;
  const dailyAwaitingReview = String(dailyRecord?.status || "").toLowerCase() === "awaiting_review";
  const effectiveDailyCategory = dailyCategory || dailySubjects[0]?.category || "";

  const openDailyEntry = () => {
    if (dailyAwaitingReview && dailyRecord) {
      onOpenDailyReview?.(dailyRecord);
      return;
    }
    startDailyPractice();
  };

  const startDailyPractice = async () => {
    if (!onStartDailyPractice || startingDaily) return;
    setStartingDaily(true);
    try {
      await onStartDailyPractice(dailySet?.category || effectiveDailyCategory);
    } finally {
      setStartingDaily(false);
    }
  };

  const toggleDone = async (item) => {
    const next = item.status === "done" ? "todo" : "done";
    await window.openexam.todo.updateInstance({
      id: item.id,
      status: next,
      ...(next === "todo" ? { progress: 0 } : {}),
    });
    load();
  };

  const removeItem = async (item) => {
    const ok = await dialog.confirm({
      title: "删除待办",
      message: `确定删除「${item.title}」？${item.templateId ? "明天仍会按模板生成，要彻底停掉请到待办设置。" : ""}`,
    });
    if (!ok) return;
    await window.openexam.todo.deleteInstance(item.id);
    load();
  };

  const submitDraft = async () => {
    const title = draftTitle.trim();
    if (!title) { setAdding(false); return; }
    await window.openexam.todo.addInstance({ title, kind: "custom", target: { unit: "once", value: 1 } });
    setDraftTitle("");
    setAdding(false);
    load();
  };

  const handleCarryOver = async () => {
    await window.openexam.todo.carryOver();
    load();
  };

  const handleAction = (item) => {
    const handlers = {
      drill: onStartDrill,
      vocab: onStartVocab,
      essay: onStartEssay,
      note: onOpenNotes,
    };
    const handler = handlers[item.kind];
    if (handler) handler(item);
    else toggleDone(item);
  };

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 6) return "夜里也在学";
    if (hour < 12) return "上午好";
    if (hour < 14) return "中午好";
    if (hour < 19) return "下午好";
    return "晚上好";
  }, []);

  if (loading) {
    return <div className="today-page"><div className="today-loading">加载中…</div></div>;
  }

  return (
    <div className="today-page">
      <header className="today-head">
        <div>
          <div className="today-date">{formatDate(daily?.date || "")}</div>
          <h1 className="today-title">
            {bankEmpty ? (
              <>{greeting}，先导入一份试卷，今天的练习才跑得动</>
            ) : (
              <>{greeting}，今天还有 <em>{Math.max(0, summary.active - summary.done)}</em> 件事</>
            )}
          </h1>
        </div>
        <div className="today-head-right">
          {streak > 0 && (
            <div className="today-streak" title="连续全部完成的天数">
              <span className="today-streak-num">{streak}</span>
              <span className="today-streak-label">天连续</span>
            </div>
          )}
          <button type="button" className="today-manage" onClick={() => setManaging(true)} title="待办设置">
            <Icon path={SlidersIcon} />
            <span>待办设置</span>
          </button>
        </div>
      </header>

      {!bankEmpty && (
        <div className="today-progress">
          <div className="today-progress-bar">
            <div className="today-progress-fill" style={{ width: `${summary.percent}%` }} />
          </div>
          <span className="today-progress-text">
            {summary.done} / {summary.active}
            {summary.allDone && <em className="today-progress-done">今天全清了</em>}
          </span>
        </div>
      )}

      <section className="today-quick">
        <article className="today-quick-card">
          <div className="today-quick-head">
            <div>
              <span className="today-quick-kicker">复习</span>
              <h2 className="today-quick-title">今天该复习</h2>
            </div>
            <span className={`today-quick-badge${reviewTotal ? " is-due" : ""}`}>{reviewTotal} 道</span>
          </div>

          {reviewGroups.length > 0 ? (
            <div className="today-review-groups">
              {reviewGroups.map((group) => (
                <button
                  key={group.key}
                  type="button"
                  className="today-review-row"
                  onClick={() => onStartReview?.(group.items, group)}
                >
                  <span className="today-review-dot" style={{ background: subjectColor(group.key) }} />
                  <span className="today-review-label">{group.label}</span>
                  <span className="today-review-count">{group.count} 道</span>
                  <span className="today-review-go">开始 →</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="today-quick-empty">今天没有到期的复习，按 1 / 2 / 4 / 7 / 15 / 30 天的节奏推进。</p>
          )}

          <p className="today-quick-hint">在错题本里可以把任意一道题加入今日复习。</p>
        </article>

        <article className="today-quick-card">
          <div className="today-quick-head">
            <div>
              <span className="today-quick-kicker">每日一练</span>
              <h2 className="today-quick-title">{dailySet ? dailySet.categoryLabel : "抽一组题"}</h2>
            </div>
            {dailySet && (
              <span className={`today-quick-badge${dailyDone ? " is-done" : ""}`}>
                {dailyDone ? "已完成" : dailyAwaitingReview ? "待自评" : `${dailyAnswered}/${dailyTotal}`}
              </span>
            )}
          </div>

          {dailySet ? (
            <>
              <div className="today-daily-meta">
                <span>{dailyTotal} 题 · 当天固定</span>
                <span>{dailyDone ? `正确率 ${dailySet.accuracy}%` : dailyAwaitingReview ? "自评完才算完成" : "中断后可继续"}</span>
              </div>
              <div className="today-daily-bar">
                <div
                  className="today-daily-bar-fill"
                  style={{ width: `${dailyDone ? 100 : (dailyTotal ? Math.round((dailyAnswered / dailyTotal) * 100) : 0)}%` }}
                />
              </div>
              <button type="button" className="today-quick-btn" disabled={startingDaily} onClick={openDailyEntry}>
                {startingDaily ? "准备中…" : (dailyDone ? "再练一遍" : dailyAwaitingReview ? "去自评" : "继续练习")}
              </button>
            </>
          ) : dailySubjects.length > 0 ? (
            <>
              <p className="today-quick-empty">按科目抽 10 道题，当天固定，不重复抽题。</p>
              <div className="today-daily-subjects">
                {dailySubjects.map((subject) => (
                  <button
                    key={subject.category}
                    type="button"
                    className={`today-daily-subject${effectiveDailyCategory === subject.category ? " is-active" : ""}`}
                    onClick={() => setDailyCategory(subject.category)}
                  >
                    {subject.label}
                    {subject.total > 0 && <em>{subject.total}</em>}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="today-quick-btn"
                disabled={startingDaily || !effectiveDailyCategory}
                onClick={startDailyPractice}
              >
                {startingDaily ? "准备中…" : "开始今日练习"}
              </button>
            </>
          ) : (
            <>
              <p className="today-quick-empty">题库里还没有可练习的题目，先导入一份试卷（也可以上传教材后再让 AI 出题）。</p>
              <button type="button" className="today-quick-btn" onClick={() => onOpenImport?.()}>
                导入第一份试卷
              </button>
            </>
          )}
        </article>
      </section>

      {bankEmpty && (
        <section className="today-start-card">
          <div>
            <strong>先把题库填起来</strong>
            <p>导入试卷或上传教材后，每日一练和下面的练习待办会自动可用。</p>
          </div>
          <div className="today-start-actions">
            <button type="button" className="today-quick-btn" onClick={() => onOpenImport?.()}>导入试卷</button>
            <button type="button" className="today-start-secondary" onClick={() => onOpenMaterials?.()}>上传教材</button>
          </div>
        </section>
      )}

      {overdue.length > 0 && (
        <div className="today-overdue">
          <span>有 {overdue.length} 件昨天以前没做完</span>
          <button type="button" onClick={handleCarryOver}>顺延到今天</button>
        </div>
      )}

      <ul className="today-list">
        {items.map((item) => {
          const meta = KIND_META[item.kind] || KIND_META.custom;
          const done = item.status === "done";
          const hasTarget = item.target?.unit !== "once" && Number(item.target?.value) > 0;
          const needsImport = bankEmpty && ["vocab", "essay", "drill"].includes(item.kind);
          return (
            <li key={item.id} className={`today-item${done ? " is-done" : ""}`}>
              <button
                type="button"
                className="today-check"
                style={{ "--dot": meta.color }}
                onClick={() => toggleDone(item)}
                aria-label={done ? "标记未完成" : "标记完成"}
              >
                {done && <Icon path={CheckIcon} size={13} />}
              </button>

              <div className="today-item-body">
                <div className="today-item-line">
                  <span className="today-item-title">{item.title}</span>
                  <span className="today-item-kind" style={{ "--dot": meta.color }}>{meta.label}</span>
                </div>
                {hasTarget && (
                  <div className="today-item-meta">
                    <div className="today-item-bar">
                      <div className="today-item-bar-fill" style={{ width: `${item.percent}%`, background: meta.color }} />
                    </div>
                    <span className="today-item-count">{item.progress} / {targetText(item.target)}</span>
                  </div>
                )}
              </div>

              <div className="today-item-actions">
                {!done && (
                  <button
                    type="button"
                    className="today-go"
                    onClick={() => (needsImport ? onOpenImport?.() : handleAction(item))}
                  >
                    {needsImport ? "去导入" : meta.action}
                  </button>
                )}
                <button type="button" className="today-remove" onClick={() => removeItem(item)} aria-label="删除">
                  <Icon path={TrashIcon} size={14} />
                </button>
              </div>
            </li>
          );
        })}

        <li className="today-add">
          {adding ? (
            <input
              autoFocus
              className="today-add-input"
              placeholder="加一件今天要做的事，回车确认"
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitDraft();
                if (e.key === "Escape") { setDraftTitle(""); setAdding(false); }
              }}
              onBlur={submitDraft}
            />
          ) : (
            <button type="button" className="today-add-btn" onClick={() => setAdding(true)}>
              <Icon path={PlusIcon} size={15} />
              <span>加一件今天的事</span>
            </button>
          )}
        </li>
      </ul>

      {managing && (
        <TemplateManager
          onClose={() => { setManaging(false); load(); }}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------- 待办模板设置：决定每天生成什么 */

function TemplateManager({ onClose }) {
  const dialog = useDialog();
  const [templates, setTemplates] = useState([]);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    const list = await window.openexam.todo.getTemplates();
    setTemplates(Array.isArray(list) ? list : []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleEnabled = async (tpl) => {
    await window.openexam.todo.saveTemplate({ ...tpl, enabled: !tpl.enabled });
    load();
  };

  const remove = async (tpl) => {
    const ok = await dialog.confirm({
      title: "删除待办模板",
      message: `「${tpl.title}」将不再每天生成，已完成的历史记录会保留。`,
    });
    if (!ok) return;
    await window.openexam.todo.deleteTemplate(tpl.id);
    load();
  };

  return (
    <div className="today-modal-scrim" onClick={onClose}>
      <div className="today-modal" onClick={(e) => e.stopPropagation()}>
        <header className="today-modal-head">
          <div>
            <h2>待办设置</h2>
            <p>决定每天自动生成哪些事。停用或删掉都行，也可以自己加。</p>
          </div>
          <button type="button" className="today-modal-close" onClick={onClose}>关闭</button>
        </header>

        <ul className="tpl-list">
          {templates.map((tpl) => {
            const meta = KIND_META[tpl.kind] || KIND_META.custom;
            return (
              <li key={tpl.id} className={`tpl-item${tpl.enabled ? "" : " is-off"}`}>
                <span className="tpl-dot" style={{ background: meta.color }} />
                <div className="tpl-body">
                  <div className="tpl-title">{tpl.title}</div>
                  <div className="tpl-sub">
                    {meta.label} · {REPEAT_OPTIONS.find((r) => r.value === tpl.repeatRule)?.label || "每天"}
                    {tpl.target?.unit !== "once" && ` · ${targetText(tpl.target)}`}
                  </div>
                </div>
                <button type="button" className="tpl-edit" onClick={() => setEditing(tpl)}>编辑</button>
                <button
                  type="button"
                  className={`tpl-switch${tpl.enabled ? " is-on" : ""}`}
                  onClick={() => toggleEnabled(tpl)}
                  aria-label={tpl.enabled ? "停用" : "启用"}
                >
                  <span />
                </button>
                <button type="button" className="tpl-remove" onClick={() => remove(tpl)} aria-label="删除">
                  <Icon path={TrashIcon} size={14} />
                </button>
              </li>
            );
          })}
        </ul>

        <button
          type="button"
          className="tpl-add"
          onClick={() => setEditing({ title: "", kind: "custom", target: { unit: "count", value: 1 }, repeatRule: "daily", enabled: true })}
        >
          <Icon path={PlusIcon} size={15} />
          <span>新增每日待办</span>
        </button>

        {editing && (
          <TemplateEditor
            value={editing}
            onCancel={() => setEditing(null)}
            onSaved={() => { setEditing(null); load(); }}
          />
        )}
      </div>
    </div>
  );
}

function TemplateEditor({ value, onCancel, onSaved }) {
  const [form, setForm] = useState(() => ({
    ...value,
    target: value.target || { unit: "count", value: 1 },
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const patch = (next) => setForm((prev) => ({ ...prev, ...next }));

  const save = async () => {
    if (!form.title.trim()) { setError("给它起个名字"); return; }
    setSaving(true);
    try {
      await window.openexam.todo.saveTemplate(form);
      onSaved();
    } catch (err) {
      setError(err?.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const isOnce = form.target.unit === "once";

  return (
    <div className="tpl-editor-scrim" onClick={onCancel}>
      <div className="tpl-editor" onClick={(e) => e.stopPropagation()}>
        <h3>{value.id ? "编辑待办" : "新增待办"}</h3>

        <label className="tpl-field">
          <span>名称</span>
          <input
            autoFocus
            value={form.title}
            placeholder="例如：资料分析速算 20 题"
            onChange={(e) => patch({ title: e.target.value })}
          />
        </label>

        <label className="tpl-field">
          <span>类型</span>
          <select value={form.kind} onChange={(e) => patch({ kind: e.target.value })}>
            {KIND_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
        </label>

        <label className="tpl-field">
          <span>频率</span>
          <select value={form.repeatRule} onChange={(e) => patch({ repeatRule: e.target.value })}>
            {REPEAT_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
        </label>

        <div className="tpl-field">
          <span>目标</span>
          <div className="tpl-target">
            <select
              value={form.target.unit}
              onChange={(e) => patch({ target: { ...form.target, unit: e.target.value } })}
            >
              <option value="count">做多少个</option>
              <option value="minutes">花多少分钟</option>
              <option value="once">做完就算</option>
            </select>
            {!isOnce && (
              <input
                type="number"
                min="1"
                value={form.target.value}
                onChange={(e) => patch({ target: { ...form.target, value: Math.max(1, Number(e.target.value) || 1) } })}
              />
            )}
          </div>
        </div>

        {error && <div className="tpl-error">{error}</div>}

        <div className="tpl-editor-actions">
          <button type="button" onClick={onCancel}>取消</button>
          <button type="button" className="is-primary" disabled={saving} onClick={save}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
