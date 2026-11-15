import React, { useCallback, useEffect, useState } from "react";

export const CITATION_TOKEN = /\[\[C(\d+)\]\]/g;

/** 持久化前去掉引用标记，避免重新打开会话时出现裸标记 */
export function stripCitationMarkers(text) {
  return String(text || "").replace(CITATION_TOKEN, "").replace(/[ \t]{2,}/g, " ");
}

export function CitationChip({ citation, onClick }) {
  if (!citation) return null;
  const label = citation.page ? `教材 p.${citation.page}` : (citation.materialName || "资料");
  const title = [citation.subjectName, citation.materialName, citation.page ? `第 ${citation.page} 页` : "", citation.section]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      type="button"
      className="citation-chip"
      title={title || "查看引用原文"}
      onClick={() => onClick?.(citation)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        margin: "0 2px",
        padding: "1px 6px",
        borderRadius: 999,
        border: "1px solid var(--accent, #4f76e8)",
        background: "var(--accent-soft-bg, rgba(79,118,232,.12))",
        color: "var(--accent, #4f76e8)",
        fontSize: 10,
        lineHeight: 1.5,
        fontWeight: 600,
        cursor: "pointer",
        verticalAlign: "baseline",
      }}
    >
      {label}
    </button>
  );
}

function MetaLine({ citation }) {
  const parts = [citation.subjectName, citation.materialName, citation.page ? `第 ${citation.page} 页` : "", citation.section]
    .filter(Boolean);
  return <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.7 }}>{parts.join(" · ")}</div>;
}

export default function CitationSheet({ citation, onClose }) {
  const [pageState, setPageState] = useState({ page: null, text: "", prevPage: null, nextPage: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadPage = useCallback(async (target) => {
    if (!citation?.subjectId || !target) return;
    setLoading(true);
    setError("");
    try {
      const result = await window.openexam?.subject?.textbookPage?.(citation.subjectId, target);
      if (result?.success && String(result.text || "").trim()) {
        setPageState({
          page: result.page,
          text: result.text,
          prevPage: result.prevPage ?? null,
          nextPage: result.nextPage ?? null,
        });
      } else {
        setPageState({ page: null, text: "", prevPage: null, nextPage: null });
        setError(result?.error || `没有找到第 ${target} 页的原文`);
      }
    } catch (err) {
      setPageState({ page: null, text: "", prevPage: null, nextPage: null });
      setError(err?.message || "读取教材页失败");
    } finally {
      setLoading(false);
    }
  }, [citation?.subjectId]);

  useEffect(() => {
    setPageState({ page: null, text: "", prevPage: null, nextPage: null });
    setError("");
    if (citation?.page) loadPage(citation.page);
  }, [citation, loadPage]);

  if (!citation) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(0,0,0,.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          width: "min(760px, 94vw)",
          maxHeight: "84vh",
          overflow: "auto",
          background: "var(--panel, #fff)",
          color: "var(--text, #1f2430)",
          borderRadius: 14,
          border: "1px solid var(--border, rgba(127,127,127,.22))",
          boxShadow: "0 24px 70px rgba(0,0,0,.35)",
          padding: 18,
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>引用出处</div>
            <MetaLine citation={citation} />
          </div>
          <button type="button" onClick={onClose} aria-label="关闭引用" style={{ border: "none", background: "transparent", color: "var(--muted)", fontSize: 18, cursor: "pointer" }}>×</button>
        </div>

        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)", marginBottom: 6 }}>回答引用的原文片段</div>
          <div style={{ fontSize: 12.5, lineHeight: 1.85, whiteSpace: "pre-wrap", background: "var(--accent-soft-bg, rgba(79,118,232,.08))", borderLeft: "3px solid var(--accent, #4f76e8)", borderRadius: 8, padding: "10px 12px" }}>
            {citation.excerpt || "这段引用没有可展示的原文片段。"}
          </div>
        </div>

        {citation.page ? (
          <div style={{ marginTop: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)" }}>
                {pageState.page ? `教材原文 · 第 ${pageState.page} 页` : `定位到教材第 ${citation.page} 页`}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button type="button" disabled={!pageState.prevPage || loading} onClick={() => loadPage(pageState.prevPage)} style={{ fontSize: 11, padding: "3px 9px", borderRadius: 7, border: "1px solid var(--border, rgba(127,127,127,.25))", background: "transparent", color: "var(--text)", cursor: pageState.prevPage ? "pointer" : "not-allowed", opacity: pageState.prevPage ? 1 : .4 }}>上一页</button>
                <button type="button" disabled={!pageState.nextPage || loading} onClick={() => loadPage(pageState.nextPage)} style={{ fontSize: 11, padding: "3px 9px", borderRadius: 7, border: "1px solid var(--border, rgba(127,127,127,.25))", background: "transparent", color: "var(--text)", cursor: pageState.nextPage ? "pointer" : "not-allowed", opacity: pageState.nextPage ? 1 : .4 }}>下一页</button>
              </div>
            </div>
            {loading ? <div style={{ fontSize: 12, color: "var(--muted)" }}>正在读取教材页…</div> : null}
            {!loading && error ? <div style={{ fontSize: 12, color: "var(--muted)" }}>{error}（不会用编造内容补位）</div> : null}
            {!loading && !error && pageState.text ? (
              <div style={{ maxHeight: "34vh", overflow: "auto", fontSize: 12.5, lineHeight: 1.85, whiteSpace: "pre-wrap", border: "1px solid var(--border, rgba(127,127,127,.18))", borderRadius: 8, padding: "10px 12px", background: "var(--bg, rgba(127,127,127,.04))" }}>
                {pageState.text}
              </div>
            ) : null}
            {!loading && !error && !pageState.text ? (
              <button type="button" onClick={() => loadPage(citation.page)} style={{ fontSize: 11, padding: "4px 10px", borderRadius: 7, border: "1px solid var(--accent, #4f76e8)", background: "transparent", color: "var(--accent, #4f76e8)", cursor: "pointer" }}>查看第 {citation.page} 页原文</button>
            ) : null}
          </div>
        ) : (
          <div style={{ marginTop: 14, fontSize: 11, color: "var(--muted)" }}>
            这条引用来自补充资料，没有教材页码；以上为回答实际引用的原文片段。
          </div>
        )}
      </div>
    </div>
  );
}
