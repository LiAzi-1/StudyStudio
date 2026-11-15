const { defineConfig } = require("vite");
const react = require("@vitejs/plugin-react");
const path = require("path");

/**
 * pdf.js 的 worker 在 Electron 30（Chromium 124）里会因为缺少 Promise.try 直接崩掉，
 * 表现是 getDocument() 永远 pending（界面卡在「读取 PDF…」）。
 * worker 是独立作用域，主线程的 polyfill 进不去，只能在构建产物里补。
 */
const PDF_WORKER_POLYFILL = [
  'if (typeof Promise.try !== "function") {',
  '  Object.defineProperty(Promise, "try", {',
  '    configurable: true,',
  '    writable: true,',
  '    value: function (fn) {',
  '      var args = Array.prototype.slice.call(arguments, 1);',
  '      return new Promise(function (resolve) { resolve(fn.apply(null, args)); });',
  '    }',
  '  });',
  '}',
  "",
].join("\n");

function pdfWorkerPromiseTry() {
  return {
    name: "pdf-worker-promise-try",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== "asset") continue;
        if (!/pdf\.worker[^/\\]*\.(mjs|js)$/.test(file.fileName)) continue;
        const code = typeof file.source === "string"
          ? file.source
          : Buffer.from(file.source).toString("utf8");
        // 只有真正用到 Promise.try 的 worker 本体才需要注入
        if (!code.includes("Promise.try")) continue;
        file.source = PDF_WORKER_POLYFILL + code;
      }
    },
  };
}

module.exports = defineConfig({
  base: "./",
  plugins: [react(), pdfWorkerPromiseTry()],
  root: path.resolve(__dirname, "src/renderer"),
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true
  },
  server: {
    // 必须写死 127.0.0.1。不写的话 Vite 5 在这台机器上只监听 IPv6（[::1]），
    // 而 npm run dev 里的 wait-on 走 IPv4 —— 它会一直等不到，electron 那半边
    // 永远不启动，表现就是「跑了 npm run dev，什么都没出来」。
    host: "127.0.0.1",
    port: 5189,
    strictPort: true
  }
});
