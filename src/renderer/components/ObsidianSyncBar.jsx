import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const Icon = ({ d, size = 15, sw = 1.8 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

const ICONS = {
  sync: "M21 12a9 9 0 0 1-9 9 9 9 0 0 1-7.5-4M3 12a9 9 0 0 1 9-9 9 9 0 0 1 7.5 4M3 4v5h5M21 20v-5h-5",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z",
  map: "M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Zm0 0v14m6-12v14",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7.5 7.5 0 0 0-2-1.2L14.6 3h-4l-.4 2.7a7.5 7.5 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7.4 7.4 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7.5 7.5 0 0 0 2 1.2l.4 2.7h4l.4-2.7a7.5 7.5 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.06-.4.1-.8.1-1.2Z",
  chevron: "M6 9l6 6 6-6",
};

function relativeTime(value) {
  if (!value) return "还没同步过";
  const stamp = Date.parse(value);
  if (!Number.isFinite(stamp)) return "还没同步过";
  const diff = Date.now() - stamp;
  if (diff < 60_000) return "刚刚同步";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前同步`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前同步`;
  return `${Math.floor(diff / 86_400_000)} 天前同步`;
}

/**
 * 笔记页顶部的 Obsidian 联动条。
 * 之前只有两个按钮，用户看不到「同步到底有没有生效、仓库在哪、有没有冲突」，
 * 所以这里把状态、自动同步开关和仓库位置都摊开。
 */
export default function ObsidianSyncBar({ onToast, onSynced }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState("");
  const [openPanel, setOpenPanel] = useState(false);
  const panelRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const res = await window.openexam?.obsidian?.status?.();
      if (res?.ok) setStatus(res);
      else setStatus(res ? { ...res, ok: false } : null);
    } catch {
      setStatus({ ok: false, error: "读取联动状态失败" });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // 后台自动拉取到新内容时刷新一下状态
  useEffect(() => {
    const off = window.openexam?.obsidian?.onNotesPulled?.((pulled) => {
      load();
      if (Array.isArray(pulled) && pulled.length) {
        onToast?.({
          title: "Obsidian 里的改动已同步回来",
          message: pulled.map((item) => item.title).filter(Boolean).slice(0, 3).join("、"),
          tone: "success",
        });
        onSynced?.();
      }
    });
    return () => off?.();
  }, [load, onToast, onSynced]);

  useEffect(() => {
    if (!openPanel) return undefined;
    const handler = (event) => {
      if (panelRef.current && !panelRef.current.contains(event.target)) setOpenPanel(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [openPanel]);

  const run = useCallback(async (key, action, successText) => {
    if (busy) return;
    setBusy(key);
    try {
      const res = await action();
      if (res?.success === false) {
        onToast?.({ title: "操作失败", message: res.error || "未知原因", tone: "warning" });
      } else if (successText) {
        const push = res?.steps?.push;
        const pull = res?.steps?.pull;
        const bits = [];
        if (push?.written) bits.push(`推送 ${push.written} 篇`);
        if (pull?.pulled?.length) bits.push(`拉回 ${pull.pulled.length} 篇`);
        if (res?.steps?.mindmap?.groups) bits.push(`${res.steps.mindmap.groups} 个知识点分组`);
        onToast?.({
          title: successText,
          message: bits.length ? bits.join(" · ") : "已经是最新的",
          tone: "success",
        });
        onSynced?.();
      }
      await load();
    } catch (error) {
      onToast?.({ title: "操作失败", message: error.message, tone: "warning" });
    } finally {
      setBusy("");
    }
  }, [busy, load, onToast, onSynced]);

  const tone = useMemo(() => {
    if (!status?.ok) return "danger";
    if (!status.vaultExists) return "warning";
    if (status.pending > 0) return "warning";
    return "success";
  }, [status]);

  const label = useMemo(() => {
    if (!status) return "Obsidian 检测中…";
    if (!status.ok) return "联动不可用";
    if (!status.vaultExists) return "仓库待初始化";
    if (status.pending > 0) return `${status.pending} 篇待同步`;
    return `${status.syncedCount}/${status.noteCount} 篇已同步`;
  }, [status]);

  const toggleAuto = async () => {
    const next = !status?.autoSync;
    const res = await window.openexam?.obsidian?.setAutoSync?.(next);
    if (res?.success) {
      setStatus((prev) => (prev ? { ...prev, autoSync: res.enabled } : prev));
      onToast?.({
        title: res.enabled ? "已开启自动同步" : "已关闭自动同步",
        message: res.enabled ? "保存笔记后自动写进 Obsidian" : "之后需要手动点同步",
        tone: "info",
      });
    }
  };

  return (
    <div className="obs-bar" ref={panelRef}>
      <button
        type="button"
        className={`obs-pill is-${tone}`}
        onClick={() => setOpenPanel((prev) => !prev)}
        title={status?.vaultDir || ""}
      >
        <span className="obs-dot" />
        <span className="obs-pill-text">{label}</span>
        <span className="obs-pill-time">{status?.ok ? relativeTime(status.lastRun) : ""}</span>
        <Icon d={ICONS.chevron} size={12} sw={2} />
      </button>

      <button
        type="button"
        className="obs-icon-btn"
        title="立即同步（双向）"
        disabled={Boolean(busy)}
        onClick={() => run("sync", () => window.openexam.obsidian.sync(), "同步完成")}
      >
        <Icon d={ICONS.sync} size={15} />
      </button>

      {openPanel && (
        <div className="obs-panel">
          <div className="obs-panel-head">
            <b>Obsidian 联动</b>
            <span className="obs-badge">{status?.engine === "node" ? "内置引擎" : "—"}</span>
          </div>

          <div className="obs-row">
            <span>仓库位置</span>
            <code title={status?.vaultDir}>{status?.vaultDir || "—"}</code>
          </div>
          <div className="obs-row">
            <span>已登记到 Obsidian</span>
            <b className={status?.registered ? "obs-ok" : "obs-warn"}>
              {status?.registered ? "是" : "否"}
            </b>
          </div>
          <div className="obs-row">
            <span>笔记 / 已同步</span>
            <b>{status ? `${status.noteCount} / ${status.syncedCount}` : "—"}</b>
          </div>
          <div className="obs-row">
            <span>仓库内 Markdown</span>
            <b>{status ? `${status.markdownCount} 个` : "—"}</b>
          </div>
          <div className="obs-row">
            <span>Obsidian 客户端</span>
            <b className={status?.installed?.installed ? "obs-ok" : "obs-warn"}>
              {status?.installed?.installed
                ? `已安装${status.installed.version ? ` v${status.installed.version}` : ""}`
                : "未安装（可选）"}
            </b>
          </div>
          {status?.legacy?.migratedFrom && (
            <div className="obs-row">
              <span>迁移自</span>
              <code title={status.legacy.migratedFrom}>{status.legacy.migratedFrom}</code>
            </div>
          )}

          <label className="obs-toggle">
            <input type="checkbox" checked={Boolean(status?.autoSync)} onChange={toggleAuto} />
            <span>自动同步（保存笔记即推送，每 45 秒回拉 Obsidian 改动）</span>
          </label>

          <div className="obs-actions">
            <button type="button" onClick={() => run("choose", () => window.openexam.obsidian.chooseVault(), "仓库已切换")}>
              更改位置…
            </button>
            <button type="button" onClick={() => window.openexam.obsidian.openFolder()}>
              打开文件夹
            </button>
            <button
              type="button"
              onClick={async () => {
                const res = await window.openexam.obsidian.openVault();
                if (res?.success) {
                  onToast?.({
                    title: res.fallback ? "已用系统默认程序打开" : "已在 Obsidian 打开",
                    message: res.message || "笔记仓库已打开",
                    tone: res.fallback ? "info" : "success",
                  });
                } else {
                  onToast?.({ title: "打不开仓库", message: res?.error || "未知原因", tone: "warning" });
                }
              }}
            >
              用 Obsidian 打开
            </button>
            <button
              type="button"
              onClick={async () => {
                const res = await window.openexam.obsidian.openMap();
                if (res?.success) {
                  onToast?.({
                    title: res.fallback ? "已用系统默认程序打开" : "已打开知识地图",
                    message: res.message || "知识地图已打开",
                    tone: res.fallback ? "info" : "success",
                  });
                } else {
                  onToast?.({ title: "打不开知识地图", message: res?.error || "未知原因", tone: "warning" });
                }
              }}
            >
              知识地图
            </button>
            {!status?.installed?.installed ? (
              <button type="button" onClick={() => window.openexam?.app?.openExternal?.(status?.installed?.downloadUrl || "https://obsidian.md/download")}>
                下载 Obsidian
              </button>
            ) : null}
          </div>

          {status && !status.installed?.installed ? (
            <p className="obs-note">
              没装 Obsidian 不影响笔记与知识图谱：笔记照常保存，需要看文件时会用系统默认程序打开。
            </p>
          ) : null}

          {status?.python?.available === false && (
            <p className="obs-note">
              没检测到 Python 3：笔记同步、知识地图都不受影响；只有「收件箱识图整理」这类增强功能需要它。
            </p>
          )}
        </div>
      )}
    </div>
  );
}
