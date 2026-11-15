/**
 * 运行时补丁
 *
 * Electron 30 内置 Chromium 124，而 `Promise.try` 要到 Chrome 128 才提供；
 * pdf.js 4.x / 5.x 的主线程与 worker 都在用它，缺了这个 API：
 *   - worker 启动即抛 `Promise.try is not a function`，不再回应任何消息；
 *   - 主线程侧 `getDocument()` 永远等不到响应，界面就卡在「读取 PDF…」。
 * 这里补一份语义等价的最小实现（fn 同步抛错时返回 rejected promise）。
 *
 * worker 是独立作用域，拿不到这里的补丁，构建时会把同样的片段注入
 * pdf.worker 资源（见 vite.config.js 的 pdfWorkerPromiseTry 插件）。
 */
export function installPolyfills() {
  if (typeof Promise.try !== "function") {
    Object.defineProperty(Promise, "try", {
      configurable: true,
      writable: true,
      value: function promiseTry(fn, ...args) {
        return new Promise((resolve) => resolve(fn(...args)));
      },
    });
  }
}
