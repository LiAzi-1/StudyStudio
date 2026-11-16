/**
 * 手机扫码传图（局域网临时上传服务）
 *
 * 设计目标：不装 App、不常驻后台。用户在电脑上点开「手机传图」时，
 * 才在本机临时起一个 HTTP 服务，把局域网地址 + 一次性令牌编码成二维码；
 * 手机扫码打开极简上传页，拍完 / 选完图直接进入当前会话，关闭后服务立即停止。
 *
 * 安全边界：
 * - 只监听局域网可达的地址，且只接受来自私有网段 / 本机的请求；
 * - 令牌每次开启随机生成，每次成功上传后立即轮换，旧令牌作废；
 * - 单张 8MB、一次最多 4 张、只收 PNG / JPEG / WebP（GIF/BMP 由手机页先转 PNG），与电脑端规则一致。
 */

const http = require('http');
const os = require('os');
const crypto = require('crypto');

const PREFERRED_PORT = 39876;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES_PER_UPLOAD = 4;
const MAX_BODY_BYTES = 48 * 1024 * 1024;
const SESSION_TTL_MS = 10 * 60 * 1000;
const IDLE_TIMEOUT_MS = 3 * 60 * 1000;

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

let session = null;

function normalizeAddress(address) {
  return String(address || '').replace(/^::ffff:/i, '');
}

function isPrivateAddress(address) {
  const ip = normalizeAddress(address);
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (ip.includes(':')) {
    const lower = ip.toLowerCase();
    // IPv6 唯一本地地址 / 链路本地地址
    return lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
  }
  const parts = ip.split('.').map((item) => Number(item));
  if (parts.length !== 4 || parts.some((item) => Number.isNaN(item))) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
}

function listLanAddresses() {
  const result = [];
  const interfaces = os.networkInterfaces();
  Object.keys(interfaces).forEach((name) => {
    (interfaces[name] || []).forEach((item) => {
      if (!item || item.internal) return;
      if (item.family !== 'IPv4' && item.family !== 4) return;
      const address = normalizeAddress(item.address);
      if (!isPrivateAddress(address)) return;
      if (address.startsWith('169.254.')) return;
      result.push({ name, address });
    });
  });
  // 虚拟网卡（VMware / VirtualBox / WSL）排在后面，优先显示真实 Wi-Fi / 网线地址
  const virtualHint = /vmware|virtualbox|vethernet|wsl|hyper-v|loopback/i;
  result.sort((a, b) => Number(virtualHint.test(a.name)) - Number(virtualHint.test(b.name)));
  return result;
}

function tokenEquals(input, expected) {
  const left = Buffer.from(String(input || ''));
  const right = Buffer.from(String(expected || ''));
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function emit(payload) {
  if (!session?.onEvent) return;
  try {
    session.onEvent(payload);
  } catch { /* 渲染层已销毁时忽略 */ }
}

function buildUrls(port, token) {
  return session.addresses.map((item) => ({
    address: item.address,
    interfaceName: item.name,
    url: `http://${item.address}:${port}/u/${token}`,
  }));
}

function currentPayload(extra = {}) {
  if (!session) return { running: false };
  return {
    running: true,
    port: session.port,
    token: session.token,
    urls: buildUrls(session.port, session.token),
    expiresAt: session.expiresAt,
    idleDeadline: session.idleDeadline,
    uploadedCount: session.uploadedCount,
    ...extra,
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('上传内容过大，一次最多 4 张、单张 8MB'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function sendHtml(response, html) {
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'",
  });
  response.end(html);
}

/** 校验上传的图片：MIME 白名单 + 实际字节数（base64 解码后） */
function normalizeIncomingImages(input) {
  const list = Array.isArray(input) ? input : [];
  if (!list.length) return { error: '没有收到图片，请重新拍照或选择图片' };
  if (list.length > MAX_IMAGES_PER_UPLOAD) return { error: `一次最多传 ${MAX_IMAGES_PER_UPLOAD} 张图片` };

  const images = [];
  for (const item of list) {
    const mimeType = String(item?.mimeType || '').toLowerCase();
    if (!ALLOWED_MIME.has(mimeType)) {
      return { error: '只支持 PNG / JPG / WebP，请重新拍照或换一张图片' };
    }
    let base64 = String(item?.base64 || '');
    if (base64.includes(',')) base64 = base64.split(',').pop();
    if (!base64) return { error: '图片内容为空，请重新选择' };
    let buffer;
    try {
      buffer = Buffer.from(base64, 'base64');
    } catch {
      return { error: '图片数据损坏，请重新选择' };
    }
    if (!buffer.length) return { error: '图片内容为空，请重新选择' };
    if (buffer.length > MAX_IMAGE_BYTES) {
      return { error: `单张图片不能超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB` };
    }
    images.push({ base64: buffer.toString('base64'), mimeType });
  }
  return { images };
}

function mobilePage(token, { title = '传图给 AI 助教', lead = '拍照或从相册选图，图片会直接进入电脑上当前打开的会话。本次上传只在电脑端关闭前有效。' } = {}) {
  const pageTitle = escapeHtml(title);
  const pageLead = escapeHtml(lead);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f172a">
<title>${pageTitle}</title>
<style>
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin: 0; min-height: 100vh; background: #0f172a; color: #e5e7eb; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; display: flex; flex-direction: column; padding: 24px 20px calc(24px + env(safe-area-inset-bottom)); }
  h1 { font-size: 18px; margin: 4px 0 6px; }
  p.lead { margin: 0 0 22px; font-size: 13px; line-height: 1.7; color: #9ca3af; }
  .actions { display: grid; gap: 12px; }
  button.act { width: 100%; border: none; border-radius: 14px; padding: 20px 16px; font-size: 17px; font-weight: 600; color: #fff; background: #2563eb; display: flex; align-items: center; justify-content: center; gap: 10px; }
  button.act.secondary { background: #1f2937; border: 1px solid #374151; }
  button.act:disabled { opacity: .5; }
  .status { margin-top: 22px; font-size: 13px; line-height: 1.7; padding: 14px 16px; border-radius: 12px; background: #111827; border: 1px solid #1f2937; white-space: pre-wrap; }
  .status.ok { border-color: #065f46; color: #6ee7b7; }
  .status.err { border-color: #7f1d1d; color: #fca5a5; }
  .thumbs { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 16px; }
  .thumbs img { width: 72px; height: 72px; object-fit: cover; border-radius: 10px; border: 1px solid #374151; }
  .foot { margin-top: auto; padding-top: 24px; font-size: 11px; color: #6b7280; text-align: center; }
</style>
</head>
<body>
  <h1>${pageTitle}</h1>
  <p class="lead">${pageLead}</p>
  <div class="actions">
    <button class="act" id="camera" type="button">📷 拍照上传</button>
    <button class="act secondary" id="album" type="button">🖼 从相册选择</button>
  </div>
  <input id="camera-input" type="file" accept="image/*" capture="environment" style="display:none">
  <input id="album-input" type="file" accept="image/*" multiple style="display:none">
  <div class="thumbs" id="thumbs"></div>
  <div class="status" id="status">准备就绪，点击上方按钮开始。</div>
  <div class="foot">只支持同一局域网访问 · 关闭电脑端窗口后立即失效</div>
<script>
(function () {
  var token = ${JSON.stringify(token)};
  var MAX = 4, MAX_BYTES = 8 * 1024 * 1024;
  var busy = false;
  var statusEl = document.getElementById('status');
  var thumbsEl = document.getElementById('thumbs');

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  function showThumbs(items) {
    thumbsEl.innerHTML = '';
    items.forEach(function (item) {
      var img = document.createElement('img');
      img.src = item;
      thumbsEl.appendChild(img);
    });
  }

  function readAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(new Error('图片读取失败')); };
      reader.readAsDataURL(file);
    });
  }

  function convertToPng(dataUrl) {
    return new Promise(function (resolve, reject) {
      var image = new Image();
      image.onload = function () {
        var canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth || image.width;
        canvas.height = image.naturalHeight || image.height;
        canvas.getContext('2d').drawImage(image, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      };
      image.onerror = function () { reject(new Error('图片解码失败，请换一张')); };
      image.src = dataUrl;
    });
  }

  async function prepare(file) {
    var type = String(file.type || '').toLowerCase();
    if (file.size > MAX_BYTES) throw new Error('单张图片不能超过 8MB');
    var dataUrl = await readAsDataUrl(file);
    if (type === 'image/gif' || type === 'image/bmp' || type.indexOf('image/') !== 0) {
      dataUrl = await convertToPng(dataUrl);
      type = 'image/png';
    }
    if (['image/png', 'image/jpeg', 'image/webp'].indexOf(type) < 0) {
      dataUrl = await convertToPng(dataUrl);
      type = 'image/png';
    }
    return { base64: dataUrl.split(',').pop(), mimeType: type, preview: dataUrl };
  }

  async function upload(files) {
    if (busy) return;
    var list = Array.prototype.slice.call(files || []).slice(0, MAX);
    if (!list.length) return;
    busy = true;
    document.getElementById('camera').disabled = true;
    document.getElementById('album').disabled = true;
    setStatus('正在处理 ' + list.length + ' 张图片…');
    try {
      var prepared = [];
      for (var i = 0; i < list.length; i += 1) prepared.push(await prepare(list[i]));
      showThumbs(prepared.map(function (item) { return item.preview; }));
      setStatus('正在发送到电脑…');
      var response = await fetch('/api/upload?token=' + encodeURIComponent(token), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images: prepared.map(function (item) { return { base64: item.base64, mimeType: item.mimeType }; }) }),
      });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok || !data.ok) throw new Error(data.message || '上传失败，请重试');
      token = data.token || token;
      if (data.url) {
        try { window.history.replaceState(null, '', new URL(data.url).pathname); } catch (e) {}
      }
      setStatus('已发送 ' + prepared.length + ' 张到电脑，可以继续拍照或选图。', 'ok');
    } catch (error) {
      setStatus(String(error && error.message ? error.message : error), 'err');
    } finally {
      busy = false;
      document.getElementById('camera').disabled = false;
      document.getElementById('album').disabled = false;
    }
  }

  document.getElementById('camera').addEventListener('click', function () { document.getElementById('camera-input').click(); });
  document.getElementById('album').addEventListener('click', function () { document.getElementById('album-input').click(); });
  document.getElementById('camera-input').addEventListener('change', function (event) { upload(event.target.files); event.target.value = ''; });
  document.getElementById('album-input').addEventListener('change', function (event) { upload(event.target.files); event.target.value = ''; });
})();
</script>
</body>
</html>`;
}

function closeSession(reason, message = '') {
  if (!session) return;
  const current = session;
  session = null;
  clearTimeout(current.idleTimer);
  clearTimeout(current.ttlTimer);
  try {
    current.server.close();
  } catch { /* 已关闭 */ }
  current.onEvent?.({ type: 'closed', reason, message, uploadedCount: current.uploadedCount });
}

function resetIdleTimer() {
  if (!session) return;
  clearTimeout(session.idleTimer);
  session.idleDeadline = Date.now() + IDLE_TIMEOUT_MS;
  session.idleTimer = setTimeout(() => {
    closeSession('timeout', `超过 ${Math.round(IDLE_TIMEOUT_MS / 60000)} 分钟没有收到图片，已自动关闭手机传图`);
  }, IDLE_TIMEOUT_MS);
}

function rotateToken() {
  if (!session) return;
  session.token = newToken();
  session.idleDeadline = Date.now() + IDLE_TIMEOUT_MS;
}

async function handleUpload(request, response) {
  let body;
  try {
    body = await readBody(request);
  } catch (error) {
    return sendJson(response, 413, { ok: false, message: error?.message || '上传内容过大' });
  }

  let parsed;
  try {
    parsed = JSON.parse(body || '{}');
  } catch {
    return sendJson(response, 400, { ok: false, message: '上传数据格式不正确' });
  }

  const normalized = normalizeIncomingImages(parsed.images);
  if (normalized.error) return sendJson(response, 400, { ok: false, message: normalized.error });

  session.uploadedCount += normalized.images.length;
  // 上传成功即轮换令牌：旧二维码失效，电脑端会收到新地址自动刷新
  rotateToken();
  resetIdleTimer();

  emit({
    type: 'images',
    images: normalized.images,
    count: normalized.images.length,
    total: session.uploadedCount,
    ...currentPayload(),
  });

  return sendJson(response, 200, {
    ok: true,
    count: normalized.images.length,
    token: session.token,
    url: `http://${session.addresses[0]?.address || '127.0.0.1'}:${session.port}/u/${session.token}`,
    idleDeadline: session.idleDeadline,
  });
}

function createRequestHandler() {
  return (request, response) => {
    const remoteAddress = normalizeAddress(request.socket.remoteAddress);
    if (!isPrivateAddress(remoteAddress)) {
      return sendJson(response, 403, { ok: false, message: '只接受同一局域网内的请求' });
    }

    let url;
    try {
      url = new URL(request.url, 'http://localhost');
    } catch {
      return sendJson(response, 400, { ok: false, message: '请求地址不合法' });
    }

    if (!session) return sendJson(response, 410, { ok: false, message: '手机传图已关闭，请在电脑上重新开启' });

    const pathToken = decodeURIComponent(url.pathname.replace(/^\/u\//, ''));
    const queryToken = url.searchParams.get('token') || '';
    const provided = request.method === 'GET' && url.pathname.startsWith('/u/') ? pathToken : queryToken;
    if (!tokenEquals(provided, session.token)) {
      return sendJson(response, 403, { ok: false, message: '二维码已失效，请在电脑上刷新后重新扫码' });
    }

    if (request.method === 'GET' && url.pathname.startsWith('/u/')) {
      emit({ type: 'opened', userAgent: String(request.headers['user-agent'] || '') });
      return sendHtml(response, mobilePage(session.token, { title: session.title, lead: session.lead }));
    }

    if (request.method === 'POST' && url.pathname === '/api/upload') {
      return handleUpload(request, response);
    }

    return sendJson(response, 404, { ok: false, message: 'Not Found' });
  };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '0.0.0.0');
  });
}

async function start({ onEvent, title, lead } = {}) {
  if (session) {
    return { success: true, reused: true, ...currentPayload() };
  }

  const addresses = listLanAddresses();
  if (!addresses.length) {
    return {
      success: false,
      code: 'NO_LAN',
      error: '没有找到局域网地址',
      hint: '请确认电脑已连接 Wi-Fi 或网线，并且没有被 VPN 独占网络；连接后重试。',
    };
  }

  const server = http.createServer(createRequestHandler());
  let port;
  let portNote = '';
  try {
    port = await listen(server, PREFERRED_PORT);
  } catch (error) {
    if (error?.code === 'EADDRINUSE') {
      try {
        port = await listen(server, 0);
        portNote = `端口 ${PREFERRED_PORT} 被占用，已自动改用 ${port}`;
      } catch (retryError) {
        return {
          success: false,
          code: retryError?.code || 'LISTEN_FAILED',
          error: `启动本地上传服务失败：${retryError?.message || retryError}`,
          hint: '检查是否有安全软件拦截本地端口监听，关闭后重试。',
        };
      }
    } else if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      return {
        success: false,
        code: error.code,
        error: '系统拒绝了本地端口监听请求',
        hint: 'Windows 防火墙或安全软件拦截了监听。请在弹窗里允许「专用网络」访问；没有弹窗时到「Windows 安全中心 → 防火墙和网络保护 → 允许应用通过防火墙」放行本应用后重试。',
      };
    } else {
      return {
        success: false,
        code: error?.code || 'LISTEN_FAILED',
        error: `无法启动本地上传服务：${error?.message || error}`,
        hint: '确认电脑网络正常、没有开启会隔离设备的 VPN 或代理后重试。',
      };
    }
  }

  const token = newToken();
  session = {
    server,
    port,
    token,
    addresses,
    onEvent: typeof onEvent === 'function' ? onEvent : null,
    uploadedCount: 0,
    expiresAt: Date.now() + SESSION_TTL_MS,
    idleDeadline: Date.now() + IDLE_TIMEOUT_MS,
    idleTimer: null,
    ttlTimer: null,
    portNote,
    title: String(title || '').trim().slice(0, 40) || '传图给 AI 助教',
    lead: String(lead || '').trim().slice(0, 120) || '拍照或从相册选图，图片会直接进入电脑上当前打开的会话。本次上传只在电脑端关闭前有效。',
  };
  resetIdleTimer();
  session.ttlTimer = setTimeout(() => {
    closeSession('expired', '手机传图已开启 10 分钟，已自动关闭。需要时请重新开启。');
  }, SESSION_TTL_MS);

  return { success: true, portNote, ...currentPayload() };
}

function stop(reason = 'user') {
  if (!session) return { success: true, running: false };
  closeSession(reason, '');
  return { success: true, running: false };
}

function status() {
  return currentPayload();
}

module.exports = {
  start,
  stop,
  status,
  listLanAddresses,
  isPrivateAddress,
  constants: {
    PREFERRED_PORT,
    MAX_IMAGE_BYTES,
    MAX_IMAGES_PER_UPLOAD,
    SESSION_TTL_MS,
    IDLE_TIMEOUT_MS,
  },
};
