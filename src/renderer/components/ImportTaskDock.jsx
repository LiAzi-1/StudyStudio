import React, { useEffect, useRef, useState } from 'react';
import {
  initImportTasks,
  useImportTasks,
  clearFinishedImportTasks,
  removeImportTask,
  hasImportTaskCanceller,
  requestCancelImportTask,
} from '../store/importTasks.js';

const STATUS_META = {
  running: { label: '识别中', tone: 'running' },
  done: { label: '已完成', tone: 'done' },
  partial: { label: '部分成功', tone: 'partial' },
  failed: { label: '失败', tone: 'failed' },
  cancelled: { label: '已停止', tone: 'muted' },
  interrupted: { label: '已中断', tone: 'muted' },
};

const DOCK_POS_KEY = 'openexam_import_dock_pos_v1';
const DOCK_DEFAULT_POS = { right: 20, top: 84 };

const clampDockPos = (pos) => {
  const maxRight = Math.max(8, window.innerWidth - 120);
  const maxTop = Math.max(8, window.innerHeight - 56);
  return {
    right: Math.min(Math.max(8, Number(pos.right) || 0), maxRight),
    top: Math.min(Math.max(8, Number(pos.top) || 0), maxTop),
  };
};

const loadDockPos = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(DOCK_POS_KEY) || 'null');
    if (saved && Number.isFinite(saved.right) && Number.isFinite(saved.top)) {
      return clampDockPos(saved);
    }
  } catch (error) {
    // 读取失败就回到默认位置
  }
  return DOCK_DEFAULT_POS;
};

const formatTime = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
};

export default function ImportTaskDock({ onOpenImport, onOpenReview }) {
  const tasks = useImportTasks();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState({});
  const [pos, setPos] = useState(loadDockPos);
  const [dragging, setDragging] = useState(false);
  const posRef = useRef(pos);
  const dragRef = useRef(null);
  const suppressClickRef = useRef(false);

  useEffect(() => { initImportTasks(); }, []);

  const applyPos = (next) => {
    const clamped = clampDockPos(next);
    posRef.current = clamped;
    setPos(clamped);
  };

  useEffect(() => {
    const handleResize = () => applyPos(posRef.current);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const handlePointerDown = (event) => {
    if (event.button !== 0) return;
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      right: posRef.current.right,
      top: posRef.current.top,
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handlePointerMove = (event) => {
    const start = dragRef.current;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!start.moved && Math.hypot(dx, dy) < 4) return;
    start.moved = true;
    setDragging(true);
    applyPos({ right: start.right - dx, top: start.top + dy });
  };

  const handlePointerEnd = () => {
    const start = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    if (!start?.moved) return;
    suppressClickRef.current = true;
    try {
      localStorage.setItem(DOCK_POS_KEY, JSON.stringify(posRef.current));
    } catch (error) {
      // 存不下就只影响下次启动的位置
    }
  };

  const handlePillClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setOpen((value) => !value);
  };

  const running = tasks.filter((task) => task.status === 'running');
  const active = running[0];
  const finishedCount = tasks.length - running.length;

  const toggleErrors = (id) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  return (
    <div
      className={`import-task-dock${open ? ' is-open' : ''}${pos.top < window.innerHeight * 0.5 ? ' is-top' : ''}`}
      style={{ right: pos.right, top: pos.top }}
    >
      {open && (
        <div className="import-task-panel">
          <div className="import-task-panel-head">
            <div>
              <strong>上传记录</strong>
              <span>{tasks.length} 条任务{running.length ? ` · ${running.length} 个进行中` : ''}</span>
            </div>
            <button type="button" className="import-task-close" onClick={() => setOpen(false)} aria-label="关闭">×</button>
          </div>

          <div className="import-task-list">
            {tasks.length === 0 ? (
              <div className="import-task-empty">还没有上传记录。导入试卷后，这里会保留每次任务的结果。</div>
            ) : tasks.map((task) => {
              const meta = STATUS_META[task.status] || STATUS_META.interrupted;
              const errors = Array.isArray(task.errors) ? task.errors : [];
              return (
                <div key={task.id} className="import-task-row">
                  <div className="import-task-row-head">
                    <span className={`import-task-status is-${meta.tone}`}>{meta.label}</span>
                    <span className="import-task-name" title={task.fileName}>{task.fileName}</span>
                    {task.status === 'running' && hasImportTaskCanceller(task.id) && (
                      <button
                        type="button"
                        className="import-task-stop"
                        title="停止识别，已识别的题目仍会自动入库"
                        onClick={() => requestCancelImportTask(task.id)}
                      >停止</button>
                    )}
                    {task.status !== 'running' && task.paperId && Number(task.imported) > 0 && onOpenReview && (
                      <button
                        type="button"
                        className="import-task-open"
                        title="打开只读看题页：直接看题干、答案与解析"
                        onClick={() => { setOpen(false); onOpenReview(task.paperId, task.fileName); }}
                      >看题</button>
                    )}
                    {task.status !== 'running' && (
                      <button
                        type="button"
                        className="import-task-remove"
                        title="删除这条记录"
                        onClick={() => removeImportTask(task.id)}
                      >×</button>
                    )}
                  </div>
                  <div className="import-task-row-meta">
                    {formatTime(task.startedAt)} · 识别 {task.recognized || 0} · 入库 {task.imported || 0}
                    {' · '}重复 {task.duplicates || 0} · 失败块 {task.failedBlocks || 0}
                  </div>
                  {task.status === 'running' && task.stage && (
                    <div className="import-task-row-stage">{task.stage}</div>
                  )}
                  {errors.length > 0 && (
                    <>
                      <button type="button" className="import-task-errors-toggle" onClick={() => toggleErrors(task.id)}>
                        {expanded[task.id] ? '收起' : '查看'} {errors.length} 条提示
                      </button>
                      {expanded[task.id] && (
                        <ul className="import-task-errors">
                          {errors.map((error, index) => <li key={`${task.id}-${index}`}>{error}</li>)}
                        </ul>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>

          <div className="import-task-panel-foot">
            <button type="button" onClick={() => { setOpen(false); onOpenImport?.(); }}>前往导入页</button>
            <button
              type="button"
              disabled={finishedCount === 0}
              onClick={() => clearFinishedImportTasks()}
            >清空已完成</button>
          </div>
        </div>
      )}

      <button
        type="button"
        className={`import-task-pill${active ? ' is-running' : ''}${dragging ? ' is-dragging' : ''}`}
        onClick={handlePillClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        title={active ? `${active.fileName}：${active.stage}` : '点击查看上传记录，按住可拖动'}
      >
        <span className="import-task-grip" aria-hidden="true"><i /><i /><i /></span>
        {active ? (
          <>
            <span className="import-task-spinner" />
            <span className="import-task-pill-text">
              后台识别中 · 已识别 {active.recognized || 0} · 已入库 {active.imported || 0}
              {running.length > 1 ? ` · 另有 ${running.length - 1} 个任务` : ''}
            </span>
          </>
        ) : (
          <>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="import-task-pill-text">上传记录{tasks.length ? ` (${tasks.length})` : ''}</span>
          </>
        )}
      </button>
    </div>
  );
}
