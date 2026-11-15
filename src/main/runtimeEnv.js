'use strict';
/**
 * 运行环境（MinerU / Python / Obsidian）的统一检测与安装。
 *
 * 之前的实现有两个硬伤：
 *   1) detectPython() 只看文件存不存在，`python` 这个候选永远返回可用 —— 假阳性，
 *      界面先显示「本地 MinerU 解析中」再抛错；
 *   2) 工作目录与模型目录写死 D 盘，没有 D 盘时直接 ENOENT。
 *
 * 这里改成：
 *   - 真执行 `python -c` 取版本、`import mineru` 取包版本，工作目录写探针文件验证可写，
 *     模型目录按实际字节数判定，解析脚本单独成项；
 *   - 默认全部落在 userData/mineru 下，可用 OPENEXAM_MINERU_ROOT 覆盖；
 *   - 检测到旧的 D 盘环境（D:\mineru-venv + D:\mineru-work\.mineru\models）时可一键复用，
 *     只写配置指向旧路径，不复制模型。
 */

const { app, BrowserWindow } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const MIN_PYTHON_MINOR = 10;
const MODEL_READY_BYTES = 200 * 1024 * 1024; // 低于 200MB 视为没下完/没下载
const DETECT_TTL_MS = 60 * 1000;

const PYTHON_DOWNLOAD_URL = 'https://www.python.org/downloads/windows/';
const PYTHON_WINGET = 'winget install -e --id Python.Python.3.12';
const OBSIDIAN_DOWNLOAD_URL = 'https://obsidian.md/download';

const PYTHON_HINT = {
  versionRange: 'Python 3.10 – 3.12（64 位）',
  winget: PYTHON_WINGET,
  downloadUrl: PYTHON_DOWNLOAD_URL,
  steps: [
    '安装时勾选「Add python.exe to PATH」',
    '装完回到这里点「重新检测」',
    '检测通过后点「一键安装解析环境」，会自动建虚拟环境并下载 MinerU 与模型',
  ],
  whyNotAuto: '不内置 Python：官方精简版没有 ensurepip/venv，无法创建独立环境；内置运行时会显著增大安装包并与 MinerU 的依赖版本强绑定。',
};

/* ------------------------------------------------------------------ 路径 */

function appRoot() {
  return process.env.OPENEXAM_MINERU_ROOT || path.join(app.getPath('userData'), 'mineru');
}

function venvPython(venvDir) {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

function appLayout() {
  const root = appRoot();
  return {
    root,
    venvDir: path.join(root, 'venv'),
    workDir: path.join(root, 'work'),
    homeDir: path.join(root, 'home'),
    cacheDir: path.join(root, 'cache'),
    configPath: path.join(root, 'env.json'),
  };
}

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(appLayout().configPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeConfig(patch = {}) {
  const lay = appLayout();
  const next = { ...readConfig(), ...patch, updatedAt: new Date().toISOString() };
  fs.mkdirSync(lay.root, { recursive: true });
  fs.writeFileSync(lay.configPath, JSON.stringify(next, null, 2), 'utf8');
  clearCache();
  return next;
}

/* 旧的 D 盘环境：只在存在时作为候选，不再作为唯一路径 */
function legacyEnvironments() {
  // 允许显式关闭旧环境探测（排查/多环境机器上避免误选旧盘）
  if (process.env.OPENEXAM_MINERU_LEGACY === '0') return [];
  const list = [];
  const push = (python, homeDir, workDir) => {
    const pythonExists = Boolean(python) && fs.existsSync(python);
    const homeExists = Boolean(homeDir) && fs.existsSync(homeDir);
    if (!pythonExists && !homeExists) return;
    list.push({
      python: pythonExists ? python : '',
      homeDir: homeExists ? homeDir : '',
      workDir: workDir || (homeExists ? path.dirname(homeDir) : ''),
      modelsBytes: homeExists ? dirBytes(path.join(homeDir, 'models')).bytes : 0,
    });
  };
  if (process.platform === 'win32') {
    push(path.join('D:', 'mineru-venv', 'Scripts', 'python.exe'), path.join('D:', 'mineru-work', '.mineru'), path.join('D:', 'mineru-work'));
  } else {
    push('/opt/mineru-venv/bin/python', '/opt/mineru-work/.mineru', '/opt/mineru-work');
  }
  return list;
}

function dirBytes(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (current) => {
    if (files > 4000) return;
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files > 4000) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        try { bytes += fs.statSync(full).size; files += 1; } catch { /* 忽略单个文件 */ }
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

function ensureWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    return { ok: true, error: '' };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

const writableCache = new Map();

/** 真的写一个探针文件：磁盘只读 / 权限受限时 access() 仍可能返回可写 */
function isWritable(dir) {
  if (!dir) return false;
  const key = path.resolve(dir);
  const hit = writableCache.get(key);
  if (hit && Date.now() - hit.at < 30000) return hit.ok;
  const result = ensureWritable(dir);
  writableCache.set(key, { ok: result.ok, at: Date.now() });
  return result.ok;
}

/** 解析脚本：开发态在项目 scripts/，打包态在 resources/mineru-scripts/ */
function extractScriptPath() {
  const devPath = path.join(__dirname, '..', '..', 'scripts', 'mineru4_extract.py');
  if (fs.existsSync(devPath)) return devPath;
  return path.join(process.resourcesPath || '', 'mineru-scripts', 'mineru4_extract.py');
}

/** Python 无控制台补丁目录（sitecustomize.py） */
function pythonNoConsoleDir() {
  const devDir = path.join(__dirname, '..', '..', 'scripts', 'python_no_console');
  if (fs.existsSync(path.join(devDir, 'sitecustomize.py'))) return devDir;
  return path.join(process.resourcesPath || '', 'mineru-scripts', 'python_no_console');
}

function pythonPathWithNoConsole(baseEnv = process.env) {
  const dir = pythonNoConsoleDir();
  return [dir, baseEnv.PYTHONPATH || ''].filter(Boolean).join(path.delimiter);
}

/** 当前生效的路径（同步，供解析器直接取用） */
function resolvePaths() {
  const cfg = readConfig();
  const lay = appLayout();
  const legacy = legacyEnvironments();

  let python = cfg.pythonPath || '';
  if (!python) {
    const venv = venvPython(lay.venvDir);
    if (fs.existsSync(venv)) python = venv;
    else if (process.env.OPENEXAM_PYTHON) python = process.env.OPENEXAM_PYTHON;
    else python = legacy.find((item) => item.python)?.python || '';
  }

  let homeDir = cfg.homeDir || '';
  if (!homeDir) {
    const appModels = dirBytes(path.join(lay.homeDir, 'models')).bytes;
    const legacyWithModels = legacy.find((item) => item.homeDir
      && item.modelsBytes >= MODEL_READY_BYTES
      && isWritable(item.homeDir)
      && isWritable(item.workDir));
    if (appModels >= MODEL_READY_BYTES) homeDir = lay.homeDir;
    else if (legacyWithModels) homeDir = legacyWithModels.homeDir;
    else homeDir = lay.homeDir;
  }

  const workDir = cfg.workDir || (path.basename(homeDir) === '.mineru' ? path.dirname(homeDir) : lay.workDir);

  return {
    root: lay.root,
    venvDir: lay.venvDir,
    homeDir,
    workDir,
    cacheDir: cfg.cacheDir || lay.cacheDir,
    configPath: lay.configPath,
    python,
  };
}

/** 给 Python 子进程的完整环境 */
function parsingEnv(extra = {}) {
  const paths = resolvePaths();
  const tmp = path.join(paths.workDir, 'tmp');
  try { fs.mkdirSync(tmp, { recursive: true }); } catch { /* 由调用方报错 */ }
  return {
    ...process.env,
    MINERU_HOME: paths.homeDir,
    MINERU_MODEL_SOURCE: extra.source || process.env.MINERU_MODEL_SOURCE || 'modelscope',
    MODELSCOPE_CACHE: path.join(paths.cacheDir, 'modelscope'),
    HF_HOME: path.join(paths.cacheDir, 'hf'),
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    PIP_NO_CACHE_DIR: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONPATH: pythonPathWithNoConsole(),
    ...(extra.env || {}),
  };
}

/* -------------------------------------------------------------- 进程执行 */

function runFile(file, args, { timeout = 20000, env } = {}) {
  return new Promise((resolve) => {
    if (!file) {
      resolve({ ok: false, code: -1, stdout: '', stderr: '', error: '命令为空' });
      return;
    }
    execFile(file, args, {
      windowsHide: true,
      timeout,
      env: env || process.env,
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error?.code ?? 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: error ? (error.killed ? `执行超时（${Math.round(timeout / 1000)} 秒）` : error.message) : '',
      });
    });
  });
}

let currentChild = null;
let cancelRequested = false;

function runStreaming(file, args, { env, timeoutMs = 30 * 60 * 1000, onLine } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const tail = [];
    const child = spawn(file, args, { env: env || process.env, windowsHide: true });
    currentChild = child;

    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        const text = line.trim();
        if (!text) continue;
        tail.push(text);
        if (tail.length > 8) tail.shift();
        try { onLine?.(text); } catch { /* 忽略回调异常 */ }
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 忽略 */ }
    }, timeoutMs);

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      currentChild = null;
      resolve({ ...payload, tail });
    };

    child.on('error', (error) => finish({ ok: false, code: -1, error: error.message }));
    child.on('close', (code) => finish({
      ok: code === 0 && !cancelRequested,
      code,
      error: cancelRequested ? '已取消' : (code === 0 ? '' : `退出码 ${code}`),
    }));
  });
}

/* ---------------------------------------------------------------- 探测 */

function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text || ''));
  return match ? `${match[1]}.${match[2]}.${match[3]}` : '';
}

async function inspectPython(command) {
  if (!command) return { ok: false, command: '', version: '', error: '未检测到 Python' };
  // 只对绝对路径做存在性判断；'python' / 'py' 这类命令名交给系统解析
  if (path.isAbsolute(command) && !fs.existsSync(command)) {
    return { ok: false, command, version: '', error: '解释器文件不存在' };
  }
  const result = await runFile(command, ['-c', 'import sys;print("%d.%d.%d" % sys.version_info[:3])'], { timeout: 15000 });
  if (!result.ok) {
    return { ok: false, command, version: '', error: result.error || '无法执行该 Python' };
  }
  const version = parseVersion(result.stdout);
  if (!version) return { ok: false, command, version: '', error: '无法读取 Python 版本' };
  const minor = Number(version.split('.')[1]);
  if (Number(version.split('.')[0]) !== 3 || minor < MIN_PYTHON_MINOR) {
    return { ok: false, command, version, error: `Python ${version} 版本过低，需要 3.${MIN_PYTHON_MINOR} 及以上` };
  }
  return { ok: true, command, version, error: '' };
}

async function inspectMineru(command) {
  if (!command) return { ok: false, version: '', error: '缺少 Python，无法检测 MinerU' };
  const result = await runFile(
    command,
    ['-c', 'import mineru, importlib.metadata as m;print(m.version("mineru"))'],
    { timeout: 90000 },
  );
  if (!result.ok) {
    const detail = result.error || (result.stderr || '').split('\n').filter(Boolean).pop() || '';
    return { ok: false, version: '', error: detail ? `import mineru 失败：${detail}` : 'import mineru 失败' };
  }
  const text = (result.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean).pop() || '';
  return { ok: true, version: text, error: '' };
}

function pythonCandidates(cfg) {
  const list = [];
  const push = (command, source) => {
    if (!command) return;
    if (list.some((item) => item.command === command)) return;
    list.push({ command, source });
  };
  push(cfg.pythonPath, 'saved');
  push(venvPython(appLayout().venvDir), 'app-venv');
  push(process.env.OPENEXAM_PYTHON, 'env');
  for (const legacy of legacyEnvironments()) push(legacy.python, 'legacy');
  if (process.platform === 'win32') push('py', 'PATH');
  push('python3', 'PATH');
  push('python', 'PATH');
  return list;
}

let cached = null;
let cachedAt = 0;
let inflight = null;

function clearCache() {
  cached = null;
  cachedAt = 0;
}

async function detectMineru({ force = false } = {}) {
  if (!force && cached && Date.now() - cachedAt < DETECT_TTL_MS) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    const cfg = readConfig();
    let paths = resolvePaths();

    let python = { ok: false, command: '', version: '', source: 'none', error: '未检测到 Python' };
    const candidates = pythonCandidates(cfg);
    // 先逐个验证 Python 本身，再优先挑 import mineru 成功的那个
    const valid = [];
    for (const item of candidates) {
      const command = item.command === 'py' ? 'py' : item.command;
      const probed = await inspectPython(command);
      if (!probed.ok) continue;
      const entry = { ...probed, source: item.source };
      if (item.command === 'py') entry.command = 'py';
      valid.push(entry);
      if (valid.length >= 3) break; // 最多验证 3 个，避免一次检测拖太久
    }

    let mineru = { ok: false, version: '', error: '未检测到 Python，无法检测 MinerU' };
    if (valid.length) {
      python = valid[0];
      for (const entry of valid) {
        const probed = await inspectMineru(entry.command === 'py' ? 'py' : entry.command);
        if (probed.ok) {
          mineru = probed;
          python = entry;
          break;
        }
        mineru = probed;
      }
    }

    // PATH 里找到的 Python 要落盘：否则后续解析拿不到解释器（resolvePaths 只认保存值/venv/旧环境）
    if (python.ok && python.source === 'PATH') {
      try {
        const saved = readConfig().pythonPath;
        if (saved !== python.command) writeConfig({ pythonPath: python.command });
      } catch { /* 保存失败不影响本次检测 */ }
      paths = resolvePaths();
    }

    const workDirCheck = ensureWritable(paths.workDir);
    const homeCheck = ensureWritable(paths.homeDir);
    const modelsCheck = ensureWritable(path.join(paths.homeDir, 'models'));
    const modelsSize = dirBytes(path.join(paths.homeDir, 'models'));
    const script = extractScriptPath();
    const scriptOk = fs.existsSync(script);

    const modelsReady = homeCheck.ok && modelsCheck.ok && modelsSize.bytes >= MODEL_READY_BYTES;
    const reusedHome = legacyEnvironments()
      .some((item) => item.homeDir && path.resolve(item.homeDir) === path.resolve(paths.homeDir));
    const models = {
      ok: modelsReady,
      path: path.join(paths.homeDir, 'models'),
      bytes: modelsSize.bytes,
      files: modelsSize.files,
      reused: reusedHome,
      error: !homeCheck.ok
        ? `模型目录不可写：${homeCheck.error}`
        : (!modelsCheck.ok ? `模型目录不可写：${modelsCheck.error}` : (modelsReady ? '' : '模型还没下载（或下载不完整）')),
    };

    const missing = [];
    if (!python.ok) missing.push('python');
    if (!mineru.ok) missing.push('mineru');
    if (!workDirCheck.ok) missing.push('workDir');
    if (!models.ok) missing.push('models');
    if (!scriptOk) missing.push('script');

    const result = {
      checkedAt: new Date().toISOString(),
      ready: missing.length === 0,
      python: { ...python, ok: python.ok },
      mineru,
      workDir: { ok: workDirCheck.ok, path: paths.workDir, error: workDirCheck.error },
      models,
      script: { ok: scriptOk, path: script, error: scriptOk ? '' : `找不到解析脚本：${script}` },
      paths,
      missing,
      canInstall: python.ok,
      needPython: !python.ok,
      pythonHint: PYTHON_HINT,
      legacy: legacyEnvironments().map((item) => ({
        ...item,
        writable: isWritable(item.homeDir) && isWritable(item.workDir),
      })),
    };
    result.message = describeMissing(result);

    cached = result;
    cachedAt = Date.now();
    return result;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

function describeMissing(env) {
  if (!env.python.ok) {
    return '缺少 Python 运行环境，PDF 解析无法启动。请到「设置 → 运行环境」按提示安装 Python 后一键安装解析环境。';
  }
  if (!env.mineru.ok) {
    return 'Python 已就绪，但缺少 MinerU 解析包。请到「设置 → 运行环境」点「一键安装解析环境」。';
  }
  if (!env.models.ok && /不可写/.test(env.models.error || '')) {
    return `${env.models.error}。可在设置里改用其它目录，或检查磁盘权限后重试。`;
  }
  if (!env.workDir.ok) {
    return `解析工作目录不可写：${env.workDir.path}。请检查磁盘权限，或在设置里复用可写的旧环境。`;
  }
  if (!env.models.ok) {
    return 'MinerU 已安装，但本地模型还没下载完成。请到「设置 → 运行环境」点「下载模型」。';
  }
  if (!env.script.ok) {
    return '缺少解析脚本，应用安装可能不完整，请重新安装应用。';
  }
  return '';
}

/* -------------------------------------------------------------- 安装流程 */

const STEP_DEFS = [
  { id: 'python', label: '检查 Python', weight: 5 },
  { id: 'venv', label: '创建虚拟环境', weight: 10 },
  { id: 'pip', label: '准备 pip', weight: 10 },
  { id: 'mineru', label: '安装 MinerU', weight: 45 },
  { id: 'models', label: '下载模型', weight: 25 },
  { id: 'verify', label: '复检环境', weight: 5 },
];

function freshState() {
  return {
    running: false,
    startedAt: null,
    finishedAt: null,
    steps: STEP_DEFS.map((step) => ({ ...step, status: 'pending', detail: '', error: '' })),
    current: '',
    percent: 0,
    bytes: 0,
    elapsed: 0,
    error: '',
    code: '',
    tail: [],
  };
}

let installState = freshState();
let lastPublish = 0;

function snapshot() {
  const done = installState.steps
    .filter((step) => step.status === 'done')
    .reduce((sum, step) => sum + step.weight, 0);
  const running = installState.steps.find((step) => step.status === 'running');
  return {
    ...installState,
    percent: Math.min(100, done + (running ? Math.round(running.weight * 0.25) : 0)),
    elapsed: installState.startedAt ? Math.round((Date.now() - installState.startedAt) / 1000) : 0,
  };
}

function publish(force = false) {
  const now = Date.now();
  if (!force && now - lastPublish < 250) return;
  lastPublish = now;
  const payload = snapshot();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('mineruEnv:progress', payload);
  }
}

function markStep(id, patch) {
  installState.steps = installState.steps.map((step) => (step.id === id ? { ...step, ...patch } : step));
  publish(true);
}

function fail(id, message, code = '') {
  installState.running = false;
  installState.finishedAt = new Date().toISOString();
  installState.error = message;
  installState.code = code;
  if (id) markStep(id, { status: 'failed', error: message });
  publish(true);
  return { success: false, code, error: message };
}

function downloaderExe(pythonPath) {
  const dir = path.dirname(pythonPath);
  return path.join(dir, process.platform === 'win32' ? 'mineru-models-download.exe' : 'mineru-models-download');
}

async function installMineru({ tier = 'basic', source = 'modelscope', force = false } = {}) {
  if (installState.running) return { success: false, error: '正在安装中，请稍候' };

  cancelRequested = false;
  installState = freshState();
  installState.running = true;
  installState.startedAt = Date.now();
  publish(true);

  const detected = await detectMineru({ force: true });

  if (!detected.python.ok) {
    markStep('python', { status: 'failed', error: detected.python.error });
    return fail('python', '需要先安装 Python 3.10–3.12（64 位），装好后点「重新检测」。', 'need-python');
  }
  markStep('python', { status: 'done', detail: `Python ${detected.python.version} · ${detected.python.command}` });

  if (detected.ready && !force) {
    installState.running = false;
    installState.finishedAt = new Date().toISOString();
    installState.percent = 100;
    for (const step of installState.steps) step.status = 'done';
    publish(true);
    return { success: true, alreadyReady: true, env: detected };
  }

  const lay = appLayout();
  const venvPy = venvPython(lay.venvDir);
  const pipIndex = process.env.OPENEXAM_PIP_INDEX || '';
  const pipBase = ['-m', 'pip', '--disable-pip-version-check'];
  const pipIndexArgs = pipIndex ? ['-i', pipIndex] : [];
  let runPython = venvPy;

  if (detected.mineru.ok) {
    // 本机已经有可导入的 mineru（例如旧 D 盘环境）：直接复用它下载模型，不重复 pip install
    runPython = detected.python.command;
    markStep('venv', { status: 'done', detail: '复用已安装的 Python' });
    markStep('pip', { status: 'done', detail: '跳过（MinerU 已安装）' });
    markStep('mineru', { status: 'done', detail: detected.mineru.version || '已安装' });
  } else {
    /* 1) 虚拟环境 */
    markStep('venv', { status: 'running', detail: '正在创建…' });
    if (!fs.existsSync(venvPy)) {
      const created = await runStreaming(detected.python.command, ['-m', 'venv', lay.venvDir], {
        timeoutMs: 10 * 60 * 1000,
        onLine: (line) => markStep('venv', { detail: line.slice(0, 160) }),
      });
      if (!created.ok) {
        return fail('venv', `创建虚拟环境失败：${created.error}${created.tail.length ? `（${created.tail.slice(-1)[0]}）` : ''}`, 'venv-failed');
      }
    }
    markStep('venv', { status: 'done', detail: lay.venvDir });

    if (cancelRequested) return fail('', '已取消', 'canceled');

    /* 2) pip */
    markStep('pip', { status: 'running', detail: '升级 pip…' });
    const pipUpgrade = await runStreaming(venvPy, [...pipBase, 'install', '--upgrade', 'pip', ...pipIndexArgs], {
      timeoutMs: 30 * 60 * 1000,
      onLine: (line) => markStep('pip', { detail: line.slice(0, 160) }),
    });
    if (!pipUpgrade.ok) {
      const tail = pipUpgrade.tail.slice(-2).join(' | ');
      markStep('pip', { status: 'failed', error: pipUpgrade.error });
      return fail('pip', `升级 pip 失败：${pipUpgrade.error}${tail ? ` · ${tail}` : ''}`, 'pip-failed');
    }
    markStep('pip', { status: 'done', detail: 'pip 已就绪' });

    if (cancelRequested) return fail('', '已取消', 'canceled');

    /* 3) mineru */
    markStep('mineru', { status: 'running', detail: '正在安装 MinerU（体积较大，请保持网络）…' });
    const install = await runStreaming(venvPy, [...pipBase, 'install', '--upgrade', 'mineru', ...pipIndexArgs], {
      timeoutMs: 90 * 60 * 1000,
      onLine: (line) => markStep('mineru', { detail: line.slice(0, 160) }),
    });
    if (!install.ok) {
      const tail = install.tail.slice(-2).join(' | ');
      return fail('mineru', `安装 MinerU 失败：${install.error}${tail ? ` · ${tail}` : ''}`, 'mineru-failed');
    }
    markStep('mineru', { status: 'done', detail: 'MinerU 已安装' });
  }

  if (cancelRequested) return fail('', '已取消', 'canceled');

  /* 4) 模型 */
  const paths = resolvePaths();
  const modelsDir = path.join(paths.homeDir, 'models');
  markStep('models', { status: 'running', detail: '准备下载模型…' });
  const sizeTimer = setInterval(() => {
    installState.bytes = dirBytes(modelsDir).bytes;
    publish();
  }, 1500);
  if (typeof sizeTimer.unref === 'function') sizeTimer.unref();

  const exe = downloaderExe(runPython);
  const modelArgs = ['--tier', tier, '--source', source];
  const childEnv = parsingEnv({ source });
  const modelsResult = fs.existsSync(exe)
    ? await runStreaming(exe, modelArgs, {
      env: childEnv,
      timeoutMs: 4 * 60 * 60 * 1000,
      onLine: (line) => markStep('models', { detail: line.slice(0, 160) }),
    })
    : await runStreaming(runPython, ['-m', 'mineru.cli.models_download', ...modelArgs], {
      env: childEnv,
      timeoutMs: 4 * 60 * 60 * 1000,
      onLine: (line) => markStep('models', { detail: line.slice(0, 160) }),
    });

  clearInterval(sizeTimer);
  installState.bytes = dirBytes(modelsDir).bytes;

  if (!modelsResult.ok) {
    const tail = modelsResult.tail.slice(-2).join(' | ');
    return fail('models', `下载模型失败：${modelsResult.error}${tail ? ` · ${tail}` : ''}`, 'models-failed');
  }
  if (installState.bytes < MODEL_READY_BYTES) {
    return fail('models', `模型下载结束但目录只有 ${(installState.bytes / 1024 / 1024).toFixed(0)} MB，可能不完整，可重试。`, 'models-incomplete');
  }
  markStep('models', { status: 'done', detail: `${(installState.bytes / 1024 / 1024).toFixed(0)} MB` });

  /* 5) 复检 */
  markStep('verify', { status: 'running', detail: '复检中…' });
  clearCache();
  const verified = await detectMineru({ force: true });
  if (!verified.ready) {
    return fail('verify', verified.message || '环境仍不完整，请重试', 'verify-failed');
  }
  markStep('verify', { status: 'done', detail: '环境可用' });

  installState.running = false;
  installState.finishedAt = new Date().toISOString();
  installState.percent = 100;
  publish(true);
  return { success: true, env: verified };
}

function cancelInstall() {
  if (!installState.running) return { success: false, error: '当前没有安装任务' };
  cancelRequested = true;
  try { currentChild?.kill(); } catch { /* 忽略 */ }
  return { success: true };
}

function getInstallState() {
  return snapshot();
}

/* ------------------------------------------------------------ Obsidian */

function queryRegistry(key, valueName) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve('');
      return;
    }
    const args = ['query', key];
    if (valueName) args.push('/v', valueName);
    else args.push('/ve');
    execFile('reg', args, { windowsHide: true, timeout: 6000 }, (error, stdout) => {
      resolve(error ? '' : String(stdout || ''));
    });
  });
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match[1];
  }
  return '';
}

/**
 * 是否装了 Obsidian：按注册表里的协议处理器 / 卸载记录判断，
 * 不看 "文件夹存不存在" —— 残留目录不代表客户端可用。
 */
async function detectObsidian() {
  const downloadUrl = OBSIDIAN_DOWNLOAD_URL;

  if (process.platform === 'win32') {
    const protocolKeys = [
      'HKCU\\Software\\Classes\\obsidian\\shell\\open\\command',
      'HKLM\\Software\\Classes\\obsidian\\shell\\open\\command',
    ];
    let exe = '';
    for (const key of protocolKeys) {
      const raw = await queryRegistry(key);
      exe = firstMatch(raw, [/REG_SZ\s+"([^"]+\.exe)"/i, /REG_SZ\s+([A-Za-z]:\\[^\r\n"]+\.exe)/i]);
      if (exe) break;
    }

    const uninstallKeys = [
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Obsidian',
      'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Obsidian',
      'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Obsidian',
    ];
    let version = '';
    let uninstallKey = '';
    for (const key of uninstallKeys) {
      const raw = await queryRegistry(key, 'DisplayVersion');
      version = firstMatch(raw, [/DisplayVersion\s+REG_SZ\s+([^\r\n]+)/i]);
      if (version) { uninstallKey = key; break; }
    }

    const installed = Boolean(exe || version);
    return {
      installed,
      ok: installed,
      version,
      exe,
      source: exe ? 'protocol-registry' : (version ? 'uninstall-registry' : 'none'),
      downloadUrl,
      detail: installed
        ? `Obsidian${version ? ` ${version}` : ''}${exe ? ` · ${exe}` : ''}`
        : '未检测到 Obsidian 客户端（可选依赖）',
    };
  }

  if (process.platform === 'darwin') {
    const appPath = '/Applications/Obsidian.app';
    const installed = fs.existsSync(appPath);
    return {
      installed,
      ok: installed,
      version: '',
      exe: installed ? appPath : '',
      source: installed ? 'app-bundle' : 'none',
      downloadUrl,
      detail: installed ? 'Obsidian 已安装' : '未检测到 Obsidian 客户端（可选依赖）',
    };
  }

  const installed = ['/usr/bin/obsidian', '/opt/Obsidian/obsidian', path.join(app.getPath('home'), '.local/bin/obsidian')]
    .some((candidate) => fs.existsSync(candidate));
  return {
    installed,
    ok: installed,
    version: '',
    exe: '',
    source: installed ? 'path' : 'none',
    downloadUrl,
    detail: installed ? 'Obsidian 已安装' : '未检测到 Obsidian 客户端（可选依赖）',
  };
}

/* ------------------------------------------------------------ 对外接口 */

async function detectAll({ force = false } = {}) {
  const [mineru, obsidian] = await Promise.all([
    detectMineru({ force }),
    detectObsidian(),
  ]);
  return { mineru, obsidian, install: snapshot() };
}

function choosePython(candidate) {
  if (!candidate || !fs.existsSync(candidate)) {
    return { success: false, error: '该文件不存在' };
  }
  writeConfig({ pythonPath: candidate, homeDir: '', workDir: '' });
  return { success: true, paths: resolvePaths() };
}

function useLegacyEnv(input = {}) {
  const legacy = legacyEnvironments().find((item) => item.python && item.python === input.python)
    || legacyEnvironments().find((item) => item.python);
  if (!legacy) return { success: false, error: '没有检测到可复用的旧环境' };
  if (!isWritable(legacy.homeDir) || !isWritable(legacy.workDir)) {
    return { success: false, error: '这套旧环境的目录当前不可写，复用后无法解析。请改用应用目录重新安装。' };
  }
  writeConfig({
    pythonPath: legacy.python,
    homeDir: legacy.homeDir || '',
    workDir: legacy.workDir || '',
  });
  return { success: true, paths: resolvePaths(), legacy };
}

module.exports = {
  appRoot,
  appLayout,
  resolvePaths,
  parsingEnv,
  extractScriptPath,
  pythonNoConsoleDir,
  pythonPathWithNoConsole,
  detectMineru,
  detectObsidian,
  detectAll,
  describeMissing,
  clearCache,
  installMineru,
  cancelInstall,
  getInstallState,
  choosePython,
  useLegacyEnv,
  legacyEnvironments,
  dirBytes,
  PYTHON_HINT,
  OBSIDIAN_DOWNLOAD_URL,
};
