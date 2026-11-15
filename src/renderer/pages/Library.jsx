import React, { useEffect, useMemo, useState } from "react";
import Materials from "./Materials.jsx";
import PracticeModule from "./PracticeModule.jsx";
import "../library.css";

/**
 * 科目内的「资料 / 题库练习」合并页。
 *
 * 入口只保留「我的科目 → 科目卡片 → 资料管理」；不再提供独立的左侧导航入口。
 * 两个标签共用同一个当前科目：资料管理读写该科目资料，题库练习默认展开该科目题库。
 */
export default function Library({
  subjectId = "",
  tab = "materials",
  practiceInitialTab = "subjects",
  onTabChange,
  onBack,
  onSelectSubject,
  onImport,
  onStartPractice,
  onHistory,
  onGoAIGenerate,
  onOpenPaper,
  onReviewPaper,
  onOpenRecord,
  onOpenSettings,
  initialKeyword = "",
  focusToken = 0,
}) {
  const [subjects, setSubjects] = useState([]);
  const [loading, setLoading] = useState(true);
  // 首次只挂载当前标签；访问过的标签保留挂载，兼顾切换后不丢内部状态与初始内存占用
  const [mounted, setMounted] = useState(() => ({
    materials: tab === "materials",
    practice: tab === "practice",
  }));

  useEffect(() => {
    setMounted((current) => (current[tab] ? current : { ...current, [tab]: true }));
  }, [tab]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await window.openexam?.subject?.list?.();
        if (!cancelled) setSubjects(Array.isArray(list) ? list : []);
      } catch {
        if (!cancelled) setSubjects([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const activeSubject = useMemo(
    () => subjects.find((item) => item.id === subjectId) || subjects[0] || null,
    [subjects, subjectId],
  );

  useEffect(() => {
    if (activeSubject && activeSubject.id !== subjectId) onSelectSubject?.(activeSubject.id);
  }, [activeSubject, subjectId, onSelectSubject]);

  const activeMaterials = tab === "materials";
  const activePractice = tab === "practice";

  return (
    <div className="library-page">
      <header className="library-header">
        <div className="library-heading">
          <button type="button" className="materials-back" onClick={onBack}>← 返回科目</button>
          <div className="materials-eyebrow">资料与题库</div>
          <h1>{activeSubject?.name || "学习资料"}</h1>
          <p>资料与题库共用当前科目；切换标签不会离开该科目。</p>
        </div>
        {activeSubject ? (
          <label className="library-subject-picker">
            <span>当前科目</span>
            <select
              value={activeSubject.id}
              onChange={(event) => onSelectSubject?.(event.target.value)}
            >
              {subjects.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </label>
        ) : null}
      </header>

      <div className="library-tabs" role="tablist" aria-label="资料与题库">
        <button
          type="button"
          role="tab"
          aria-selected={activeMaterials}
          className={`library-tab${activeMaterials ? " is-active" : ""}`}
          onClick={() => onTabChange?.("materials")}
        >
          资料
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activePractice}
          className={`library-tab${activePractice ? " is-active" : ""}`}
          onClick={() => onTabChange?.("practice")}
        >
          题库练习
        </button>
      </div>

      <div className="library-body">
        {loading ? (
          <div className="library-empty">正在读取科目…</div>
        ) : !activeSubject ? (
          <div className="library-empty">还没有科目，请先回到科目列表创建科目。</div>
        ) : (
          <>
            <div className={`library-panel${activeMaterials ? " is-active" : ""}`}>
              {mounted.materials || activeMaterials ? <Materials subjectId={activeSubject.id} embedded onOpenSettings={onOpenSettings} /> : null}
            </div>
            <div className={`library-panel is-practice${activePractice ? " is-active" : ""}`}>
              {mounted.practice || activePractice ? (
                <PracticeModule
                  initialTab={practiceInitialTab}
                  onImport={onImport}
                  onStartPractice={onStartPractice}
                  onHistory={onHistory}
                  onGoAIGenerate={onGoAIGenerate}
                  onOpenPaper={onOpenPaper}
                  onReviewPaper={onReviewPaper}
                  onOpenRecord={onOpenRecord}
                  initialKeyword={initialKeyword}
                  focusToken={focusToken}
                  focusSubject={activeSubject}
                />
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
