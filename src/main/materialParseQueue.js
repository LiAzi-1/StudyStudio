'use strict';
/**
 * 补充资料解析队列（主进程常驻）。
 *
 * 渲染层只负责「入队」，真正的解析任务在这里执行：
 *   - 页面切走、返回科目列表都不会中断；
 *   - 同时最多跑 MAX_CONCURRENT 份，其余排队，避免多份 MinerU 把机器拖死；
 *   - 每份任务各自维护进度，通过回调广播给渲染层。
 */

const MAX_CONCURRENT = Math.max(1, Math.min(4, Number(process.env.OPENEXAM_PARSE_CONCURRENCY) || 2));

const tasks = new Map();
const waiting = [];
let running = 0;

function keyOf(subjectId, id) {
  return `${subjectId}::${id}`;
}

function snapshot(task) {
  return {
    id: task.id,
    subjectId: task.subjectId,
    name: task.name,
    status: task.status,
    percent: Math.max(0, Math.min(100, Number(task.percent) || 0)),
    detail: task.detail || '',
    position: task.status === 'queued' ? Math.max(0, waiting.indexOf(task.key) + 1) : 0,
    startedAt: task.startedAt || null,
  };
}

function getTask(subjectId, id) {
  const task = tasks.get(keyOf(subjectId, id));
  return task ? snapshot(task) : null;
}

function listTasks(subjectId) {
  return [...tasks.values()].filter((task) => task.subjectId === subjectId).map(snapshot);
}

function pump() {
  while (running < MAX_CONCURRENT) {
    const key = waiting.shift();
    if (!key) return;
    const task = tasks.get(key);
    if (!task) continue;
    task.status = 'running';
    task.percent = 1;
    task.detail = '开始解析';
    task.startedAt = Date.now();
    running += 1;
    try { task.onStateChange?.(); } catch { /* 忽略 */ }

    Promise.resolve()
      .then(() => task.run((percent, detail) => {
        task.percent = Number(percent) || 0;
        task.detail = String(detail || '');
        try { task.onProgress?.(snapshot(task)); } catch { /* 忽略 */ }
      }))
      .catch((error) => {
        task.error = error?.message || String(error);
      })
      .finally(() => {
        running -= 1;
        tasks.delete(key);
        try { task.onStateChange?.(); } catch { /* 忽略 */ }
        pump();
      });
  }
}

/**
 * 入队一份解析任务；重复入队直接返回已有任务。
 * @returns {{task:object, reused:boolean}}
 */
function enqueue({ subjectId, id, name, run, onProgress, onStateChange }) {
  const key = keyOf(subjectId, id);
  const existing = tasks.get(key);
  if (existing) return { task: snapshot(existing), reused: true };

  const task = {
    key,
    subjectId,
    id,
    name: name || '',
    status: 'queued',
    percent: 0,
    detail: '排队等待解析',
    startedAt: null,
    run,
    onProgress,
    onStateChange,
  };
  tasks.set(key, task);
  waiting.push(key);
  pump();
  return { task: snapshot(task), reused: false };
}

function hasTask(subjectId, id) {
  return tasks.has(keyOf(subjectId, id));
}

module.exports = {
  MAX_CONCURRENT,
  enqueue,
  getTask,
  listTasks,
  hasTask,
};
