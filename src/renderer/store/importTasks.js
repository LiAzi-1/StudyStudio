import { useSyncExternalStore } from 'react';

/**
 * 导入任务的全局状态。
 * 放在模块级而不是页面 state：导入页切到别的界面时不会被卸载，
 * 悬浮进度条与上传记录面板也能在任意页面读到同一份任务数据。
 */
const SETTING_KEY = 'import_tasks';
const FALLBACK_KEY = 'openexam_import_tasks';
const MAX_TASKS = 60;

let tasks = [];
let initialized = false;
let persistTimer = null;
const listeners = new Set();
// 运行中的任务把自己的取消函数登记进来，浮条可以在任意页面停止后台识别
const cancelHandlers = new Map();

const getSnapshot = () => tasks;
const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const emit = (next) => {
  tasks = next;
  listeners.forEach((listener) => {
    try { listener(); } catch (error) { console.warn('[ImportTask] listener failed', error); }
  });
};

async function persist() {
  const payload = JSON.stringify(tasks.slice(0, MAX_TASKS));
  if (window.openexam?.db?.setAppSetting) {
    try {
      // preload 暴露的签名是 (key, value)，不是单个对象
      const result = await window.openexam.db.setAppSetting(SETTING_KEY, payload);
      if (result?.success === false) throw new Error(result.error || '写入失败');
      return;
    } catch (error) {
      // 数据库不可用时降级到本地存储，记录本身不应影响识别流程
    }
  }
  try { localStorage.setItem(FALLBACK_KEY, payload); } catch (error) { /* 忽略配额错误 */ }
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => { persist().catch(() => {}); }, 150);
}

export async function initImportTasks() {
  if (initialized) return;
  initialized = true;

  let stored = [];
  if (window.openexam?.db?.getAppSetting) {
    try {
      const row = await window.openexam.db.getAppSetting(SETTING_KEY);
      const raw = typeof row === 'string' ? row : (row?.value || '');
      const parsed = JSON.parse(raw || '[]');
      if (Array.isArray(parsed)) stored = parsed;
    } catch (error) {
      // 记录损坏时从空列表开始
    }
  }
  if (!stored.length) {
    try {
      const parsed = JSON.parse(localStorage.getItem(FALLBACK_KEY) || '[]');
      if (Array.isArray(parsed)) stored = parsed;
    } catch (error) { stored = []; }
  }

  // 上次退出时仍标记为 running 的任务不可能继续执行，统一标成已中断
  const normalized = stored.slice(0, MAX_TASKS)
    .filter((task) => task && task.id)
    .map((task) => (task.status === 'running'
      ? { ...task, status: 'interrupted', stage: '应用重启，该任务已中断', finishedAt: task.finishedAt || new Date().toISOString() }
      : task));
  // 读取数据库是异步的；期间用户可能已经点了「开始解析」，
  // 直接 emit 会把刚创建的任务覆盖掉，这里把新任务合并回历史列表。
  const storedIds = new Set(normalized.map((task) => task.id));
  const createdMeanwhile = tasks.filter((task) => !storedIds.has(task.id));
  emit([...createdMeanwhile, ...normalized].slice(0, MAX_TASKS));
}

export function useImportTasks() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function createImportTask(meta = {}) {
  const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const task = {
    id,
    fileName: String(meta.fileName || '未命名文件'),
    mode: meta.mode === 'template' ? 'template' : 'ai',
    engine: String(meta.engine || ''),
    autoCommit: meta.autoCommit !== false,
    status: 'running',
    stage: '准备中',
    recognized: 0,
    imported: 0,
    duplicates: 0,
    failedBlocks: 0,
    errors: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
    paperId: null,
  };
  emit([task, ...tasks].slice(0, MAX_TASKS));
  schedulePersist();
  return id;
}

export function patchImportTask(id, patch = {}) {
  if (!id) return;
  emit(tasks.map((task) => (task.id === id ? { ...task, ...patch } : task)));
  schedulePersist();
}

export function addImportTaskError(id, message) {
  const text = String(message || '').trim().slice(0, 300);
  if (!id || !text) return;
  emit(tasks.map((task) => (task.id === id
    ? { ...task, errors: [...(Array.isArray(task.errors) ? task.errors : []), text].slice(-8) }
    : task)));
  schedulePersist();
}

export function clearFinishedImportTasks() {
  emit(tasks.filter((task) => task.status === 'running'));
  schedulePersist();
}

export function removeImportTask(id) {
  cancelHandlers.delete(id);
  emit(tasks.filter((task) => task.id !== id));
  schedulePersist();
}

export function registerImportTaskCanceller(id, handler) {
  if (!id || typeof handler !== 'function') return () => {};
  cancelHandlers.set(id, handler);
  return () => { if (cancelHandlers.get(id) === handler) cancelHandlers.delete(id); };
}

export function requestCancelImportTask(id) {
  const handler = cancelHandlers.get(id);
  if (typeof handler !== 'function') return false;
  try { handler(); } catch (error) { console.warn('[ImportTask] cancel failed', error); }
  return true;
}

export function hasImportTaskCanceller(id) {
  return cancelHandlers.has(id);
}

export function getImportTask(id) {
  return tasks.find((task) => task.id === id) || null;
}
