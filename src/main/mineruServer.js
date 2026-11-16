'use strict';
/**
 * MinerU 4.x 本地服务守护。
 *
 * 4.x 改成「文档中心」架构：`mineru parse` 只是个客户端，真正干活的 doclib server
 * 必须常驻。之前它靠手工后台任务跑，会话一结束就被回收，应用点「上传教材」直接失败。
 * 这里让 Electron 主进程在解析前自行确保服务可用：
 *   1) 探测 127.0.0.1:15980；
 *   2) 不通则以后台常驻方式拉起 `python -m mineru.doclib.app`；
 *   3) 轮询等待端口就绪，再给 managed OCR 子服务一点预热时间。
 *
 * 路径统一由 runtimeEnv 决定（应用数据目录 / 可复用的旧 D 盘环境），不再写死盘符。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const runtimeEnv = require('./runtimeEnv.js');

const HOST = '127.0.0.1';
const PORT = 15980;
const OCR_PORT = 16580;

function home() {
  return runtimeEnv.resolvePaths().homeDir;
}

function pythonExe() {
  return runtimeEnv.resolvePaths().python;
}

function pythonNoConsoleDir() {
  return runtimeEnv.pythonNoConsoleDir();
}

function pythonPathWithNoConsole(baseEnv = process.env) {
  return runtimeEnv.pythonPathWithNoConsole(baseEnv);
}

function serverEnv() {
  return runtimeEnv.parsingEnv();
}

function probe(port, timeout = 800) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* 忽略 */ }
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, HOST);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * 读取日志在 fromOffset 之后新增内容的尾部。
 * 从偏移量开始读，避免把上一次启动失败留下的旧 traceback 当成这一次的原因。
 */
function logTail(logPath, fromOffset = 0, maxLines = 15) {
  try {
    const buffer = fs.readFileSync(logPath);
    const text = buffer.subarray(Math.min(fromOffset, buffer.length)).toString('utf8');
    return text
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .slice(-maxLines)
      .join('\n')
      .slice(-2000);
  } catch {
    return '';
  }
}

/** 确保 doclib server 与 managed OCR 服务可用；返回是否已由本次调用拉起 */
async function ensureRunning({ onProgress, waitMs = 90000 } = {}) {
  const emit = (detail) => {
    try { onProgress?.({ stage: 'server', detail, percent: 2 }); } catch { /* 忽略 */ }
  };

  if (await probe(PORT)) {
    emit('MinerU 服务已就绪');
    await waitOcrIfConfigured(emit);
    return { ok: true, started: false };
  }

  const paths = runtimeEnv.resolvePaths();
  const py = paths.python;
  if (!py) {
    return {
      ok: false,
      code: 'mineru-not-ready',
      error: '缺少 Python 运行环境，请到「设置 → 运行环境」一键安装后再解析 PDF。',
    };
  }

  emit('正在启动 MinerU 本地服务…');
  const logDir = paths.workDir;
  try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* 忽略 */ }
  const logPath = path.join(logDir, 'openexam-mineru-server.log');
  let logOffset = 0;
  try { logOffset = fs.statSync(logPath).size; } catch { /* 首次启动还没有日志 */ }
  const out = fs.openSync(logPath, 'a');
  const child = spawn(py, ['-m', 'mineru.doclib.app'], {
    cwd: logDir,
    env: serverEnv(),
    // Windows 上 detached 会让子进程自己新分配一个控制台窗口 —— 即使同时传了
    // windowsHide（实测：只有 windowsHide 时无控制台，加上 detached 就有），
    // 这就是「开始解析时弹出的黑框」。Windows 不会因为父进程退出就回收子进程，
    // 所以只有 POSIX 需要 detached 做 setsid；unref() 依旧让主进程能正常退出。
    detached: process.platform !== 'win32',
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  let exitInfo = null;
  child.once('exit', (code, signal) => { exitInfo = { code, signal }; });
  child.unref();
  try { fs.closeSync(out); } catch { /* 子进程持有句柄，主进程可关 */ }

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    if (await probe(PORT)) {
      emit('MinerU 服务已启动，等待 OCR 引擎就绪…');
      await waitOcrIfConfigured(emit);
      return { ok: true, started: true, pid: child.pid };
    }
    // 启动即崩溃（例如 import 阶段报错）时立刻返回真实原因，不必空等到超时
    const exited = exitInfo || (child.exitCode !== null ? { code: child.exitCode, signal: child.signalCode } : null);
    if (exited) {
      const tail = logTail(logPath, logOffset);
      const reason = exited.code !== null && exited.code !== undefined ? `退出码 ${exited.code}` : `信号 ${exited.signal || '未知'}`;
      return {
        ok: false,
        error: `MinerU 服务进程已退出（${reason}），日志：${logPath}${tail ? `\n${tail}` : ''}`,
      };
    }
  }
  const tail = logTail(logPath, logOffset);
  return {
    ok: false,
    error: `MinerU 服务启动超时（${Math.round(waitMs / 1000)}s），日志：${logPath}${tail ? `\n${tail}` : ''}`,
  };
}

/** managed 模式下 doclib 会拉起 OCR 子服务（16580），首次加载 ONNX 模型需十几秒 */
async function waitOcrIfConfigured(emit, timeoutMs = 60000) {
  if ((process.env.OPENEXAM_MINERU_TIER || 'basic') === 'flash') return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(OCR_PORT)) { emit('OCR 引擎已就绪'); return; }
    await sleep(1000);
  }
  // 不阻断：flash 或 remote 配置下没有这个端口，解析时会有明确报错
  emit('OCR 引擎尚未就绪，解析时将继续等待');
}

function status() {
  return probe(PORT);
}

module.exports = { ensureRunning, status, serverEnv, home, pythonExe, pythonNoConsoleDir, pythonPathWithNoConsole };
