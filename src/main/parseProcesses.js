'use strict';
/**
 * 解析子进程登记表。
 *
 * MinerU 提取器（materialParser / textbookMineru 里 spawn 的 python 进程）在应用退出时
 * 必须被结束，否则关掉窗口后它们会继续跑，留下孤儿进程占着内存与解析服务。
 */

const children = new Set();

/** 登记一个解析子进程；进程结束（或启动失败）后自动移除 */
function track(child) {
  if (!child || typeof child.once !== 'function') return child;
  children.add(child);
  const forget = () => { children.delete(child); };
  child.once('exit', forget);
  child.once('error', forget);
  return child;
}

/** 结束所有仍在运行的解析子进程（应用退出时调用） */
function killAll() {
  for (const child of [...children]) {
    children.delete(child);
    try { child.kill(); } catch { /* 进程可能已退出 */ }
  }
}

module.exports = { track, killAll };
