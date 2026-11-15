/**
 * 分享链接导入（脆弱能力，依赖对方未公开接口 / 页面结构）
 *
 * DeepSeek 实测（2026-11）：分享页是 SPA 空壳，正文由前端再调接口取；
 * `GET https://chat.deepseek.com/api/v0/share/content?share_id=<id>` 无需登录/Cookie，
 * 但必须带浏览器 User-Agent，否则会被 WAF 拦成 429；图片的 `signed_path` 拼到
 * `https://files.deepseeksvc.com/api` 后补 `ty=p`。
 *
 * 豆包实测（2026-11）：单次 GET 分享页即可拿到完整对话，正文嵌在内联脚本
 * `<script data-fn-args='[...]'>` 的 `share_info` / `message_snapshot.message_list` 里，
 * 不需要 Cookie、签名或登录；页面自己的 `/im/message/share/get` 反而要求内部 Base 参数。
 *
 * 这里只做「读取 + 当场下载附件」，不保存会过期的外链；
 * 任何结构变化都按 API_CHANGED 处理，并给出可执行的替代方案。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { app } = require('electron');

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SHARE_API = 'https://chat.deepseek.com/api/v0/share/content';
const FILES_BASE = 'https://files.deepseeksvc.com/api';
const REQUEST_TIMEOUT_MS = 20000;
const MAX_MESSAGES = 300;
const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_TOTAL_IMAGES = 8;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const STAGING_TTL_MS = 60 * 60 * 1000;
const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;

const ALTERNATIVES = [
  '在对方应用里全选复制对话全文，粘贴到「粘贴对话原文」框',
  '截几张关键对话的截图，用「选择文件 / 截图」上传',
  '在浏览器里用「打印 → 另存为 PDF」，再把内容复制成文本导入',
];

function failure(code, error, hint, alternatives = ALTERNATIVES, extra = {}) {
  return { success: false, code, error, hint, alternatives, ...extra };
}

function parseShareId(input) {
  const raw = String(input || '').trim();
  if (!raw) return { error: failure('INVALID_LINK', '还没有填分享链接', '把分享页地址整个粘贴进来，例如 https://chat.deepseek.com/share/xxxx 或 https://www.doubao.com/thread/xxxx') };

  if (SHARE_ID_PATTERN.test(raw)) return { provider: 'deepseek', shareId: raw };

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: failure('INVALID_LINK', '这不是一个有效的链接', '需要形如 https://chat.deepseek.com/share/xxxx 或 https://www.doubao.com/thread/xxxx 的分享链接。') };
  }

  if (/(^|\.)doubao\.com$/i.test(parsed.hostname)) {
    const match = parsed.pathname.match(/\/thread\/([A-Za-z0-9_-]+)/);
    if (!match || !SHARE_ID_PATTERN.test(match[1])) {
      return { error: failure('INVALID_LINK', '没能从豆包链接里认出对话 ID', '请确认复制的是「分享对话」页面的完整地址，形如 https://www.doubao.com/thread/xxxx。') };
    }
    return { provider: 'doubao', shareId: match[1] };
  }

  if (!/(^|\.)deepseek\.com$/i.test(parsed.hostname)) {
    return { error: failure('INVALID_LINK', '目前只支持 DeepSeek 与豆包的分享链接', `收到的是 ${parsed.hostname} 的地址。其它平台的分享页结构不同，请改用复制全文或截图。`) };
  }

  const match = parsed.pathname.match(/\/share\/([A-Za-z0-9_-]+)/);
  if (!match || !SHARE_ID_PATTERN.test(match[1])) {
    return { error: failure('INVALID_LINK', '没能从链接里认出分享 ID', '请确认复制的是「分享对话」页面的完整地址，而不是对话首页。') };
  }
  return { provider: 'deepseek', shareId: match[1] };
}

function requestBuffer(url, { timeoutMs = REQUEST_TIMEOUT_MS, maxBytes = 0, redirects = 3, accept = 'application/json, text/plain, */*' } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(Object.assign(new Error('链接格式不正确'), { code: 'NETWORK' }));
      return;
    }

    const request = https.request({
      hostname: target.hostname,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: accept,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Referer: /doubao\.com$/i.test(target.hostname) ? 'https://www.doubao.com/' : 'https://chat.deepseek.com/',
      },
      timeout: timeoutMs,
    }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location && redirects > 0) {
        response.resume();
        const next = new URL(response.headers.location, target).toString();
        requestBuffer(next, { timeoutMs, maxBytes, redirects: redirects - 1, accept }).then(resolve, reject);
        return;
      }

      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (maxBytes && size > maxBytes) {
          request.destroy();
          reject(Object.assign(new Error('内容超过大小限制'), { code: 'TOO_LARGE' }));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        resolve({
          status,
          headers: response.headers,
          buffer: Buffer.concat(chunks),
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    request.on('timeout', () => {
      request.destroy(Object.assign(new Error('请求超时'), { code: 'TIMEOUT' }));
    });
    request.on('error', (error) => reject(error));
    request.end();
  });
}

function mapNetworkError(error) {
  if (error?.code === 'TIMEOUT') {
    return failure('NETWORK', '读取分享超时了', 'DeepSeek 响应有点慢，或本地网络不稳。检查网络后重试。');
  }
  return failure('NETWORK', `网络请求失败：${error?.message || error}`, '确认电脑能正常打开 chat.deepseek.com 后重试；公司网络 / 代理可能拦住了这个域名。');
}

async function fetchSharePayload(shareId) {
  let response;
  try {
    response = await requestBuffer(`${SHARE_API}?share_id=${encodeURIComponent(shareId)}`, { maxBytes: 32 * 1024 * 1024 });
  } catch (error) {
    return { error: mapNetworkError(error) };
  }

  if (response.status === 429 || response.status === 403) {
    return {
      error: failure(
        'RATE_LIMITED',
        `请求被 DeepSeek 的安全校验拦住了（HTTP ${response.status}）`,
        '这是对方的风控限流。等 30-60 秒再试；不要连续快速读取同一个链接。',
      ),
    };
  }
  if (response.status !== 200) {
    return {
      error: failure('NETWORK', `读取分享失败（HTTP ${response.status}）`, '对方服务暂时不可用或已调整访问策略，稍后重试；也可以改用复制全文。'),
    };
  }

  let payload;
  try {
    payload = JSON.parse(response.text);
  } catch {
    return {
      error: failure(
        'API_CHANGED',
        '对方返回的不是可解析的数据',
        '分享接口可能改版了。这是依赖 DeepSeek 未公开接口的脆弱能力，对方改版后随时会失效；请改用复制全文或截图。',
      ),
    };
  }

  const data = payload?.data;
  if (!data || typeof data !== 'object') {
    return {
      error: failure(
        'API_CHANGED',
        '分享接口返回了没见过的结构',
        '网页确实有响应，但没有预期的 data 字段，说明接口结构变了。请改用复制全文或截图。',
      ),
    };
  }

  if (data.biz_code !== 0) {
    const message = String(data.biz_msg || '');
    if (data.biz_code === 1 || /not exist|deleted|cancel/i.test(message)) {
      return {
        error: failure(
          'SHARE_GONE',
          '分享已删除或已取消',
          '链接可能被作者删除、取消分享，或复制时缺了一段。请让对方重新分享，或直接把对话全文复制给你。',
        ),
      };
    }
    return {
      error: failure(
        'API_CHANGED',
        `分享接口返回了业务错误（biz_code=${data.biz_code}${message ? `：${message}` : ''}）`,
        '这不是常见的「链接失效」错误，更像是接口规则变了。请改用复制全文或截图。',
      ),
    };
  }

  const bizData = data.biz_data;
  if (!bizData || !Array.isArray(bizData.messages)) {
    return {
      error: failure(
        'API_CHANGED',
        '分享内容里没有找到消息列表',
        '接口仍能返回，但消息字段的结构变了。请改用复制全文或截图。',
      ),
    };
  }
  return { bizData };
}

function resolveFileUrl(signedPath) {
  if (!signedPath) return '';
  if (/^https?:\/\//i.test(signedPath)) {
    try {
      const url = new URL(signedPath);
      if (!url.searchParams.has('ty')) url.searchParams.set('ty', 'p');
      return url.toString();
    } catch {
      return '';
    }
  }
  const hasTy = /[?&]ty=/.test(signedPath);
  const separator = signedPath.includes('?') ? '&' : '?';
  return `${FILES_BASE}${signedPath}${hasTy ? '' : `${separator}ty=p`}`;
}

function extensionForMime(mimeType) {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  return '';
}

function stagingRoot() {
  return path.join(app.getPath('userData'), 'share-import');
}

function stagingDir(importId) {
  return path.join(stagingRoot(), importId);
}

function cleanupStaging() {
  const root = stagingRoot();
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  entries.forEach((entry) => {
    if (!entry.isDirectory()) return;
    const dir = path.join(root, entry.name);
    try {
      if (now - fs.statSync(dir).mtimeMs > STAGING_TTL_MS) fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* 单个目录清理失败不影响导入 */ }
  });
}

async function downloadImage(signedPath) {
  const url = resolveFileUrl(signedPath);
  if (!url) return { error: '没有可下载的图片地址' };
  let response;
  try {
    response = await requestBuffer(url, { maxBytes: MAX_IMAGE_BYTES });
  } catch (error) {
    if (error?.code === 'TOO_LARGE') return { error: '图片超过 8MB，已跳过' };
    return { error: `图片下载失败：${error?.message || error}` };
  }
  if (response.status !== 200) return { error: `图片下载失败（HTTP ${response.status}）` };

  let mimeType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!mimeType.startsWith('image/')) {
    const match = String(response.headers['content-disposition'] || '').match(/\.(png|jpe?g|webp)/i);
    if (match) mimeType = match[1].toLowerCase().startsWith('jp') ? 'image/jpeg' : `image/${match[1].toLowerCase()}`;
  }
  if (!extensionForMime(mimeType)) return { error: `图片格式 ${mimeType || '未知'} 暂不支持` };
  if (!response.buffer.length) return { error: '图片内容为空' };
  return { buffer: response.buffer, mimeType };
}

function pickTitle(bizData, firstUserText) {
  const title = String(bizData.title || '').trim();
  if (title && !/^(shared conversation|deepseek|分享的对话)$/i.test(title)) return title.slice(0, 40);
  const fallback = String(firstUserText || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return fallback || '导入的分享对话';
}

/* ------------------------------------------------------ 豆包分享（SSR 内联数据） */

const DOUBAO_ORIGIN = 'https://www.doubao.com';

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

/**
 * 豆包分享页把首屏数据塞在 `<script data-fn-args=...>` 里，实测有两种变体：
 * A: ["thread_(token)/page", "shareInfo", { data: { share_info, message_snapshot } }]
 * B: ["thread_(token)/page", [{ key:"shareInfo", routerDataFnArgs:["{...}"] }]]
 * 属性引号也可能是单引号或双引号，所以先宽松取出再递归找带 share_info / message_snapshot 的对象。
 */
function findDoubaoShareData(node, depth = 0) {
  if (!node || depth > 8) return null;
  if (typeof node === 'string') {
    const trimmed = node.trim();
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length > 20
      && (trimmed.includes('message_snapshot') || trimmed.includes('share_info'))) {
      try {
        return findDoubaoShareData(JSON.parse(trimmed), depth + 1);
      } catch {
        return null;
      }
    }
    return null;
  }
  if (typeof node !== 'object') return null;
  if (node.message_snapshot || node.share_info) return node;
  for (const value of Object.values(node)) {
    const found = findDoubaoShareData(value, depth + 1);
    if (found) return found;
  }
  return null;
}

function extractDoubaoShareData(html) {
  const pattern = /<script[^>]*data-fn-args=(["'])([\s\S]*?)\1/g;
  let match;
  while ((match = pattern.exec(html))) {
    let parsed;
    try {
      parsed = JSON.parse(decodeHtmlEntities(match[2]));
    } catch {
      continue;
    }
    const data = findDoubaoShareData(parsed);
    if (data) return { data };
  }
  if (html.includes('message_snapshot') || html.includes('share_info')) return { error: 'structure' };
  return { error: 'gone' };
}

function doubaoBlocks(message) {
  let blocks = [];
  if (Array.isArray(message?.content_block) && message.content_block.length) {
    blocks = message.content_block;
  } else if (typeof message?.content === 'string' && message.content.trim()) {
    const raw = message.content.trim();
    if (raw.startsWith('[') || raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw);
        blocks = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        return { text: raw, nonText: 0 };
      }
    } else {
      return { text: raw, nonText: 0 };
    }
  }

  const texts = [];
  let nonText = 0;
  blocks.forEach((block) => {
    const content = block?.content || {};
    const text = content?.text_block?.text
      || block?.text_block?.text
      || (typeof content?.text === 'string' ? content.text : '');
    if (text) texts.push(String(text));
    else if (block) nonText += 1;
  });
  return { text: texts.join('\n\n').trim(), nonText };
}

function doubaoThinking(message) {
  const raw = message?.thinking_content;
  if (!raw) return '';
  if (Array.isArray(raw)) return doubaoBlocks({ content_block: raw }).text;
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      return doubaoBlocks({ content: trimmed }).text;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

async function prepareDoubao({ shareId, includeThinking = false }) {
  let response;
  try {
    response = await requestBuffer(`${DOUBAO_ORIGIN}/thread/${encodeURIComponent(shareId)}`, {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      maxBytes: 8 * 1024 * 1024,
    });
  } catch (error) {
    return mapNetworkError(error);
  }

  if (response.status === 429 || response.status === 403) {
    return failure(
      'RATE_LIMITED',
      `请求被豆包的安全校验拦住了（HTTP ${response.status}）`,
      '这是对方的风控限流。等 30-60 秒再试，不要连续快速读取同一个链接。',
    );
  }
  if (response.status !== 200) {
    return failure('NETWORK', `读取豆包分享失败（HTTP ${response.status}）`, '对方服务暂时不可用，稍后重试；也可以改用复制全文。');
  }

  const extracted = extractDoubaoShareData(response.text);
  if (extracted.error === 'gone') {
    return failure(
      'SHARE_GONE',
      '分享已删除或未公开',
      '链接可能被作者删除、取消分享，或复制时缺了一段。请让对方重新分享，或直接把对话全文复制给你。',
    );
  }
  if (extracted.error === 'structure') {
    return failure(
      'API_CHANGED',
      '豆包分享页的数据结构变了',
      '页面里仍能提到分享数据，但没能按现有结构解析出来。这项能力依赖对方页面结构，改版后可能失效；请改用复制全文或截图。',
    );
  }

  const data = extracted.data;
  const shareInfo = data.share_info || {};
  const snapshot = data.message_snapshot || {};
  const rawMessages = (Array.isArray(snapshot.message_list) ? [...snapshot.message_list] : [])
    .sort((left, right) => Number(left.index_in_conv || 0) - Number(right.index_in_conv || 0))
    .slice(0, MAX_MESSAGES);

  if (!rawMessages.length) {
    return failure(
      'INCOMPLETE',
      '这段分享还没生成完',
      '分享里没有可读取的消息，作者可能还在生成或中途停止了。等对话完成后再分享，或让对方复制全文给你。',
    );
  }

  const importId = `share_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const dir = stagingDir(importId);
  fs.mkdirSync(dir, { recursive: true });

  const messages = [];
  let nonTextBlocks = 0;
  let firstUserText = '';

  for (const raw of rawMessages) {
    const userType = Number(raw.user_type);
    const role = userType === 1 ? 'user' : userType === 2 ? 'assistant' : '';
    if (!role) continue;

    const parsed = doubaoBlocks(raw);
    nonTextBlocks += parsed.nonText;
    let content = parsed.text;
    if (role === 'user' && content && !firstUserText) firstUserText = content;

    if (role === 'assistant' && includeThinking) {
      const thinking = doubaoThinking(raw);
      if (thinking) content = `${content}${content ? '\n\n---\n' : ''}**【模型思考过程】**\n${thinking}`;
    }

    if (!content) continue;
    messages.push({ role, content, images: [] });
  }

  if (!messages.length) {
    return failure(
      'INCOMPLETE',
      '分享内容还没生成完',
      '能读到消息条目，但正文为空，可能仍在生成中。等回答生成完再试，或让对方复制全文给你。',
    );
  }

  const title = String(shareInfo.share_name || '').trim().slice(0, 40) || firstUserText.slice(0, 40) || '导入的分享对话';
  const warnings = [];
  if (nonTextBlocks > 0) warnings.push(`有 ${nonTextBlocks} 处非文本内容（图片 / 文件 / 卡片）未导入。`);
  if (rawMessages.length >= MAX_MESSAGES) warnings.push(`分享超过 ${MAX_MESSAGES} 条消息，只读取了最早的 ${MAX_MESSAGES} 条。`);

  return {
    success: true,
    importId,
    shareId,
    provider: 'doubao',
    title,
    summary: `${messages.length} 条消息`,
    messages,
    stats: { messageCount: messages.length, imageCount: 0, skippedImages: 0 },
    warning: warnings.join(' '),
  };
}

/**
 * 读取分享链接 → 解析消息 → 当场下载附件到暂存目录
 * 预览只需要 dataUrl；正式入库时按 importId 从暂存目录搬到应用数据目录。
 */
async function fetchAndPrepare({ url, includeThinking = false } = {}) {
  const parsed = parseShareId(url);
  if (parsed.error) return parsed.error;
  if (parsed.provider === 'doubao') {
    cleanupStaging();
    return prepareDoubao({ shareId: parsed.shareId, includeThinking });
  }

  cleanupStaging();

  const payload = await fetchSharePayload(parsed.shareId);
  if (payload.error) return payload.error;
  const { bizData } = payload;

  const rawMessages = [...bizData.messages]
    .sort((left, right) => Number(left.inserted_at || 0) - Number(right.inserted_at || 0))
    .slice(0, MAX_MESSAGES);

  const incomplete = rawMessages.find((message) => {
    const status = String(message.status || '').toUpperCase();
    return message.incomplete_message || (status && status !== 'FINISHED' && status !== 'COMPLETE');
  });
  if (incomplete) {
    return failure(
      'INCOMPLETE',
      '这段分享还没生成完',
      '作者分享时回答仍在生成，或对话被中途停止。等生成完成后再分享，或请对方把完整内容复制给你。',
    );
  }

  const importId = `share_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const dir = stagingDir(importId);
  fs.mkdirSync(dir, { recursive: true });

  const messages = [];
  let totalImages = 0;
  let skippedImages = 0;
  let firstUserText = '';

  for (const raw of rawMessages) {
    const role = String(raw.role || '').toUpperCase() === 'USER' ? 'user' : 'assistant';
    const fragments = Array.isArray(raw.fragments) ? raw.fragments : [];

    const texts = [];
    const thinkings = [];
    const files = [];
    fragments.forEach((fragment) => {
      const type = String(fragment?.type || '').toUpperCase();
      if (type === 'REQUEST' || type === 'RESPONSE') {
        if (fragment.content) texts.push(String(fragment.content));
      } else if (type === 'THINK') {
        if (fragment.content) thinkings.push(String(fragment.content));
      } else if (type === 'FILE' && Array.isArray(fragment.files)) {
        files.push(...fragment.files);
      }
    });

    let content = texts.join('\n\n').trim();
    if (role === 'user' && content && !firstUserText) firstUserText = content;
    if (!content && !files.length) continue;

    if (role === 'assistant' && includeThinking && thinkings.length) {
      content = `${content}${content ? '\n\n---\n' : ''}**【模型思考过程】**\n${thinkings.join('\n\n').trim()}`;
    }
    if (!content && files.length) content = '（图片）';

    const images = [];
    for (const file of files) {
      if (file?.is_image === false) { skippedImages += 1; continue; }
      if (file?.audit_result && file.audit_result !== 'pass') { skippedImages += 1; continue; }
      if (!file?.signed_path) { skippedImages += 1; continue; }
      if (images.length >= MAX_IMAGES_PER_MESSAGE || totalImages >= MAX_TOTAL_IMAGES) { skippedImages += 1; continue; }

      const downloaded = await downloadImage(file.signed_path);
      if (downloaded.error) { skippedImages += 1; continue; }

      totalImages += 1;
      const fileName = `${String(images.length + 1).padStart(2, '0')}.${extensionForMime(downloaded.mimeType)}`;
      fs.writeFileSync(path.join(dir, fileName), downloaded.buffer);
      images.push({
        file: fileName,
        name: file.file_name || fileName,
        mimeType: downloaded.mimeType,
        width: file.width || 0,
        height: file.height || 0,
        dataUrl: `data:${downloaded.mimeType};base64,${downloaded.buffer.toString('base64')}`,
      });
    }

    messages.push({ role, content, images });
  }

  if (!messages.length) {
    return failure(
      'EMPTY',
      '分享里没有可导入的对话内容',
      '这条分享可能只有图片或内容已被清空。请改用截图，或让对方复制全文给你。',
    );
  }

  const warnings = [];
  if (skippedImages > 0) warnings.push(`有 ${skippedImages} 张图片未能导入（格式不支持、超过 8MB 或超出数量上限）。`);
  if (rawMessages.length >= MAX_MESSAGES) warnings.push(`分享超过 ${MAX_MESSAGES} 条消息，只读取了最早的 ${MAX_MESSAGES} 条。`);

  return {
    success: true,
    importId,
    shareId: parsed.shareId,
    provider: 'deepseek',
    title: pickTitle(bizData, firstUserText),
    summary: `${messages.length} 条消息${totalImages ? ` · ${totalImages} 张图片` : ''}，图片已下载到本地暂存`,
    messages,
    stats: { messageCount: messages.length, imageCount: totalImages, skippedImages },
    warning: warnings.join(' '),
  };
}

/** 预览确认后入库：建「导入」会话，把暂存图片搬进会话资源目录 */
function commit({ database, importId, title, subjectId, messages }) {
  const dir = stagingDir(String(importId || ''));
  if (!importId || !/^share_[A-Za-z0-9_]+$/.test(importId) || !fs.existsSync(dir)) {
    return failure(
      'IMPORT_EXPIRED',
      '这次读取的分享内容已过期',
      '暂存内容只保留 1 小时，或已经被导入过一次。请重新读取分享链接。',
    );
  }

  const list = Array.isArray(messages) ? messages : [];
  if (!list.length) return failure('EMPTY', '没有可导入的消息', '返回上一步重新读取分享。', []);

  const aiAssets = require('./aiAssets.js');
  const session = database.createAIChatSession({
    title: String(title || '').trim().slice(0, 60) || '导入的分享对话',
    subjectId: subjectId || null,
    source: 'imported',
  });

  let imageCount = 0;
  list.forEach((message, index) => {
    const role = message?.role === 'assistant' ? 'assistant' : 'user';
    const content = String(message?.content || '').trim();
    const messageId = `${session.id}_share_${index}`;
    const savedImages = [];

    (Array.isArray(message?.images) ? message.images : []).forEach((image) => {
      const fileName = path.basename(String(image?.file || ''));
      if (!fileName || !/^[A-Za-z0-9._-]+$/.test(fileName)) return;
      const filePath = path.join(dir, fileName);
      if (!fs.existsSync(filePath)) return;
      try {
        const base64 = fs.readFileSync(filePath).toString('base64');
        const saved = aiAssets.saveImages({
          sessionId: session.id,
          messageId,
          images: [{ base64, mimeType: image.mimeType }],
        });
        if (saved?.success) {
          savedImages.push(...(saved.images || []));
          imageCount += 1;
        }
      } catch { /* 单张图片失败不影响整条消息导入 */ }
    });

    database.addAIChatMessage({
      sessionId: session.id,
      id: messageId,
      role,
      content: content || '（图片）',
      meta: { imported: true, via: 'deepseek_share', images: savedImages },
      skipSubjectSync: true,
    });
  });

  try {
    require('./subjectManager.js').syncSubjectChatFile(session.id);
  } catch { /* 科目文件夹同步失败不影响导入 */ }

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 暂存清理失败可下次启动再清 */ }

  return {
    success: true,
    sessionId: session.id,
    title: session.title,
    count: list.length,
    images: imageCount,
  };
}

module.exports = {
  fetchAndPrepare,
  commit,
  parseShareId,
  cleanupStaging,
  constants: {
    MAX_MESSAGES,
    MAX_TOTAL_IMAGES,
    MAX_IMAGE_BYTES,
    STAGING_TTL_MS,
  },
};
