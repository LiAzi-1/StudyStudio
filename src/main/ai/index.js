/**
 * AI 服务统一接口
 * - OpenAI SDK 统一承接 OpenAI / OpenAI 兼容协议
 * - OpenAI 原生支持 Responses API 与 Chat Completions API
 * - MiniMax / Kimi / GLM / 其他兼容服务默认走 Chat Completions
 * - Claude 仍保留 Anthropic SDK
 */

const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { buildTaxonomyGuide, buildSubjectTaxonomyGuide, normalizeClassification } = require('../../shared/knowledgeTaxonomy');
const { TEXTBOOK_FORMAT_GUIDE, formatAIResult, formatQuestions } = require('../../shared/textbookFormat');

const OPENAI_COMPATIBLE_PROVIDERS = {
  openai: {
    sdkType: 'openai',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.4',
    defaultFormat: 'responses',
    supportedFormats: ['responses', 'chat_completions'],
  },
  minimax: {
    sdkType: 'openai',
    baseURL: 'https://api.minimax.chat/v1',
    defaultModel: 'MiniMax-M1',
    defaultFormat: 'chat_completions',
    supportedFormats: ['chat_completions'],
  },
  kimi: {
    sdkType: 'openai',
    baseURL: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-128k',
    defaultFormat: 'chat_completions',
    supportedFormats: ['chat_completions'],
  },
  glm: {
    sdkType: 'openai',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4.5-air',
    defaultFormat: 'chat_completions',
    supportedFormats: ['chat_completions'],
  },
  deepseek: {
    sdkType: 'openai',
    baseURL: 'https://api.deepseek.com/v1',
    // deepseek-flash = DeepSeek-V4.1-Flash，是目前唯一支持图像理解的模型
    defaultModel: 'deepseek-flash',
    defaultFormat: 'chat_completions',
    supportedFormats: ['chat_completions'],
    supportsVision: true,
    visionModels: ['deepseek-flash'],
  },
  doubao: {
    sdkType: 'openai',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-1-5-pro-32k',
    defaultFormat: 'chat_completions',
    supportedFormats: ['chat_completions'],
  },
  qwen: {
    sdkType: 'openai',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-turbo',
    defaultFormat: 'chat_completions',
    supportedFormats: ['chat_completions'],
  },
  custom: {
    sdkType: 'openai',
    baseURL: '',
    defaultModel: '',
    defaultFormat: 'chat_completions',
    supportedFormats: ['responses', 'chat_completions'],
  },
  openai_compatible: {
    sdkType: 'openai',
    baseURL: '',
    defaultModel: '',
    defaultFormat: 'chat_completions',
    supportedFormats: ['responses', 'chat_completions'],
  },
  anthropic: {
    sdkType: 'anthropic',
    baseURL: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-20250514',
    defaultFormat: 'messages',
    supportedFormats: ['messages'],
  },
};

function getProviderConfig(providerId) {
  return OPENAI_COMPATIBLE_PROVIDERS[providerId] || OPENAI_COMPATIBLE_PROVIDERS.custom;
}

/** DeepSeek 官方已收敛为 deepseek-flash / deepseek-v4-pro，旧名字自动升级 */
const LEGACY_DEEPSEEK_MODELS = {
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
};

/** 明确不能读图的模型：DeepSeek 只有 deepseek-flash 支持图像理解 */
const TEXT_ONLY_VISION_MODELS = new Set([
  'deepseek-v4-pro',
  'deepseek-chat',
  'deepseek-reasoner',
  'qwen-turbo',
  'moonshot-v1-128k',
  'moonshot-v1-32k',
]);

/**
 * 「服务商支持视觉」不等于「任意模型都能识图」。
 * 渲染层有一份同名判断，主进程这里再算一次：图片请求必须在这里确认模型真能读图，
 * 否则纯文本模型会「看不见就编」，把编造的题目写进题库。
 */
function isVisionCapableSettings(settings) {
  const normalized = normalizeAISettings(settings);
  const provider = getProviderConfig(normalized.aiProvider);
  if (provider.supportsVision === false) return false;
  const model = String(normalized.model || '').trim().toLowerCase();
  if (!model) return true;
  if (Array.isArray(provider.visionModels) && provider.visionModels.length) {
    return provider.visionModels.includes(model);
  }
  return !TEXT_ONLY_VISION_MODELS.has(model);
}

/**
 * 纯文本模型收到图片不会报错，而是「看不见就编」——实测 deepseek-v4-pro
 * 会凭空返回一道不存在的题目。这里在调用前直接拦住，避免脏题目入库。
 */
function assertVisionModel(settings, routeHint = '图片识别') {
  const providerId = String(settings?.aiProvider || '');
  const model = String(settings?.model || settings?.customModel || '').trim().toLowerCase();
  if (providerId === 'deepseek' && TEXT_ONLY_VISION_MODELS.has(model)) {
    throw new Error(`当前模型 ${model} 不支持图片输入，${routeHint}会返回编造内容。请到「设置 → AI 模型」把模型换成 deepseek-flash，或改用 OCR 引擎 B。`);
  }
}

function normalizeAISettings(input) {
  const settings = input && typeof input === 'object' ? { ...input } : {};
  const provider = getProviderConfig(settings.aiProvider || 'custom');
  const preferredModel = String(settings.customModel || '').trim() || String(settings.model || '').trim();
  const supportedFormats = provider.supportedFormats || ['chat_completions'];
  const upgradedModel = (settings.aiProvider === 'deepseek' && LEGACY_DEEPSEEK_MODELS[preferredModel])
    ? LEGACY_DEEPSEEK_MODELS[preferredModel]
    : preferredModel;

  return {
    ...settings,
    aiProvider: settings.aiProvider || 'custom',
    apiKey: String(settings.apiKey || '').trim(),
    apiBase: String(settings.apiBase || provider.baseURL || '').trim(),
    model: upgradedModel || provider.defaultModel,
    apiFormat: supportedFormats.includes(settings.apiFormat)
      ? settings.apiFormat
      : (provider.defaultFormat || supportedFormats[0] || 'chat_completions'),
  };
}

/**
 * 三类 AI 角色：识图 / 助教 / 老师。
 * 渲染层会在调用前就把角色配置解析好；主进程里读库的模块（如笔记助教）
 * 需要自己解析一次，所以这里也提供同样的逻辑。
 */
const AI_ROLE_IDS = ['vision', 'assistant', 'teacher'];

function resolveRoleSettings(input, role) {
  const settings = normalizeAISettings(input);
  if (!role || !AI_ROLE_IDS.includes(role)) return settings;

  const roleConfig = settings.aiRoles && typeof settings.aiRoles === 'object'
    ? settings.aiRoles[role]
    : null;
  if (!roleConfig || roleConfig.mode !== 'custom') return settings;

  return normalizeAISettings({
    ...settings,
    aiProvider: roleConfig.aiProvider || settings.aiProvider,
    apiKey: String(roleConfig.apiKey || '').trim() || settings.apiKey,
    apiBase: roleConfig.apiBase || '',
    model: roleConfig.model || '',
    customModel: roleConfig.customModel || '',
    apiFormat: roleConfig.apiFormat || settings.apiFormat,
  });
}

/**
 * 网关防呆：把 Base URL 填成管理后台域名时，SDK 会拿到 HTTP 200 的 HTML 网页而不是报错。
 * 这类响应一路走到 JSON 解析，最后只会显示「模型返回的不是完整 JSON」，把配置问题伪装成模型问题。
 * 因此在 SDK 出口统一校验响应结构，直接把配置问题报出来。
 */
function isAsyncIterable(value) {
  return Boolean(value && typeof value === 'object' && typeof value[Symbol.asyncIterator] === 'function');
}

function looksLikeHtml(value) {
  const text = String(value || '').trim();
  return /^<(?:!doctype\s+html|html|head|body|div|script|!--)/i.test(text) || /<html[\s>]/i.test(text);
}

function describeBadApiResponse(response) {
  if (typeof response === 'string') {
    const preview = response.trim().slice(0, 120).replace(/\s+/g, ' ');
    return looksLikeHtml(response)
      ? `收到网页 HTML（${preview || '空页面'}…），当前地址不是 API 接口`
      : `收到纯文本（${preview || '空内容'}）`;
  }
  if (!response || typeof response !== 'object') {
    return `收到 ${response === null ? 'null' : typeof response} 类型内容`;
  }
  const keys = Object.keys(response).slice(0, 8).join(', ');
  return `响应对象缺少模型结果字段（实际字段：${keys || '无'}）`;
}

function hasModelResult(response, kind) {
  if (!response || typeof response !== 'object') return false;
  if (kind === 'chat_completions') return Array.isArray(response.choices);
  if (kind === 'responses') {
    return Array.isArray(response.output) || 'output_text' in response || typeof response.id === 'string';
  }
  return Array.isArray(response.content) || typeof response.id === 'string';
}

function assertApiResponse(response, kind, settings) {
  if (isAsyncIterable(response)) return response; // 流式响应逐块读取，不做整体结构校验

  const host = toSafeApiHost(settings?.apiBase);
  const hint = host
    ? `当前 Base URL 是 ${host}，请确认它指向 API 接口地址（OpenAI 兼容网关通常需要在域名后补 /v1），并检查模型名、API Key 分组和可用通道。`
    : '请确认 Base URL 指向 API 接口地址（OpenAI 兼容网关通常需要在域名后补 /v1）。';

  const fail = (detail) => {
    const error = new Error(`AI 接口返回的不是模型结果：${detail}。${hint}`);
    error.code = 'INVALID_API_RESPONSE';
    throw error;
  };

  if (typeof response === 'string') return fail(describeBadApiResponse(response));
  if (!response || typeof response !== 'object') return fail(describeBadApiResponse(response));
  if (response.error && typeof response.error === 'object') {
    return fail(`服务端返回错误：${String(response.error.message || JSON.stringify(response.error)).slice(0, 200)}`);
  }
  if (!hasModelResult(response, kind)) return fail(describeBadApiResponse(response));
  return response;
}

/** SDK 在解析到非 JSON 内容时会抛出很晦涩的异常，这里补上配置级提示 */
function enrichApiError(error, settings) {
  if (error?.code === 'INVALID_API_RESPONSE') return error; // 已经是配置级提示，不要二次包装
  const message = String(error?.message || error || '');
  const suspicious = /<!doctype|<html|<head|<body/i.test(message)
    || /cannot use 'in' operator|unexpected token|is not valid json|could not parse|syntaxerror/i.test(message);
  if (!suspicious) return error;

  const host = toSafeApiHost(settings?.apiBase);
  const hint = host
    ? `当前 Base URL 是 ${host}，请确认它指向 API 接口地址（OpenAI 兼容网关通常需要在域名后补 /v1），并检查模型名、API Key 分组和可用通道。`
    : '请确认 Base URL 指向 API 接口地址（OpenAI 兼容网关通常需要在域名后补 /v1）。';
  const preview = message.slice(0, 120).replace(/\s+/g, ' ');
  const enriched = new Error(`AI 接口返回的不是模型结果：服务端返回了网页或非 JSON 内容（${preview}）。${hint}`);
  enriched.code = 'INVALID_API_RESPONSE';
  enriched.cause = error;
  return enriched;
}

/** 包装 SDK 的 create：所有调用点共用同一套响应校验，流式请求跳过 */
function guardClientCreate(client, type, settings) {
  const wrap = (resource, kind) => {
    if (!resource || typeof resource.create !== 'function') return;
    const originalCreate = resource.create.bind(resource);
    resource.create = (...args) => {
      const pending = originalCreate(...args);
      // 流式请求必须原样返回 SDK 的 APIPromise：Anthropic 的 stream() 依赖 .withResponse()
      if (args?.[0]?.stream === true || args?.[1]?.stream === true || isAsyncIterable(pending)) return pending;
      return Promise.resolve(pending)
        .then((response) => assertApiResponse(response, kind, settings))
        .catch((error) => { throw enrichApiError(error, settings); });
    };
  };

  if (type === 'anthropic') {
    wrap(client?.messages, 'messages');
  } else {
    wrap(client?.chat?.completions, 'chat_completions');
    wrap(client?.responses, 'responses');
  }
  return client;
}

/** 模型文本为空时给出配置级提示，避免退化成「JSON 解析失败」 */
function ensureModelText(text, routeHint = '') {
  if (String(text || '').trim()) return text;
  throw new Error(`AI 接口没有返回可用的模型文本${routeHint}：请检查 Base URL 是否需要补 /v1、模型名是否正确、API Key 分组是否有可用通道`);
}

function createClient(inputSettings) {
  const settings = normalizeAISettings(inputSettings);
  const provider = getProviderConfig(settings.aiProvider);

  if (provider.sdkType === 'anthropic') {
    return {
      type: 'anthropic',
      client: guardClientCreate(new Anthropic({ apiKey: settings.apiKey }), 'anthropic', settings),
      model: settings.model || provider.defaultModel,
      settings,
      provider,
    };
  }

  const client = guardClientCreate(new OpenAI({
    apiKey: settings.apiKey,
    baseURL: settings.apiBase || provider.baseURL || undefined,
  }), 'openai', settings);

  if (settings.aiProvider === 'deepseek' && settings.__thinking === 'disabled') {
    disableDeepSeekThinking(client);
  }

  return {
    type: 'openai',
    client,
    model: settings.model || provider.defaultModel,
    settings,
    provider,
  };
}

/**
 * DeepSeek 官方接口默认开启思考模式（effort=high），推理 token 与正文共用 max_tokens。
 * 识题 / 批改这类「只允许输出 JSON」的任务，思维链会吃掉输出预算，
 * 最终表现为「模型返回了内容但不是完整 JSON」。这类任务显式关闭思考。
 */
function structuredSettings(inputSettings) {
  return withoutThinking(inputSettings);
}

/**
 * 机械性任务（逐页转写 / 生成知识清单）不需要思维链。
 * DeepSeek 的推理 token 与正文共用 max_tokens：开着思考既慢，又会让长输出被截断。
 * 只有需要「先想清楚再答」的任务（答疑、批改）才保留思考。
 */
function withoutThinking(inputSettings) {
  const settings = normalizeAISettings(inputSettings);
  if (settings.aiProvider !== 'deepseek') return settings;
  return { ...settings, __thinking: 'disabled' };
}

function disableDeepSeekThinking(client) {
  const resource = client?.chat?.completions;
  if (!resource || typeof resource.create !== 'function') return;
  const originalCreate = resource.create.bind(resource);
  resource.create = (body, options) => {
    const payload = body && typeof body === 'object' ? { ...body } : body;
    if (payload && typeof payload === 'object' && !payload.thinking) {
      payload.thinking = { type: 'disabled' };
    }
    return originalCreate(payload, options);
  };
}

/**
 * 读取服务端的结束原因。
 * - chat.completions：choices[0].finish_reason（length 表示达到 max_tokens）
 * - Responses：status / incomplete_details.reason
 * - Anthropic：stop_reason（max_tokens 表示被截断）
 */
function extractFinishReason(response, type = 'openai') {
  if (!response) return '';
  if (type === 'anthropic') return String(response.stop_reason || '');
  const normalized = response?.response && typeof response.response === 'object' ? response.response : response;
  const choice = normalized?.choices?.[0];
  if (choice?.finish_reason) return String(choice.finish_reason);
  if (normalized?.incomplete_details?.reason) return String(normalized.incomplete_details.reason);
  if (normalized?.status) return String(normalized.status);
  return '';
}

const TRUNCATED_FINISH_REASONS = new Set(['length', 'max_tokens', 'max_output_tokens', 'incomplete', 'max_output']);

function isTruncatedFinish(reason) {
  return TRUNCATED_FINISH_REASONS.has(String(reason || '').toLowerCase());
}

/**
 * 输出预算：优先用设置里的显式值（inventoryMaxTokens / maxOutputTokens），
 * 否则按服务商能力上限取默认值。知识清单等长文任务不再写死 8192。
 */
function resolveMaxOutputTokens(settings, fallback = 8192) {
  const explicit = Number(settings?.inventoryMaxTokens ?? settings?.maxOutputTokens);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const provider = String(settings?.aiProvider || '').toLowerCase();
  const caps = { deepseek: 8192, anthropic: 8192, openai: 16384 };
  return caps[provider] || fallback;
}

function extractResponseText(response) {  if (!response) return '';
  const normalizedResponse = response?.response && typeof response.response === 'object'
    ? response.response
    : response;

  const normalizeTextNode = (node) => {
    if (typeof node === 'string') return node;
    if (!node || typeof node !== 'object') return '';

    if (typeof node.text === 'string') return node.text;
    if (typeof node.value === 'string') return node.value;
    if (typeof node.content === 'string') return node.content;

    if (node.text && typeof node.text === 'object') {
      if (typeof node.text.value === 'string') return node.text.value;
      if (Array.isArray(node.text)) {
        return node.text.map((part) => normalizeTextNode(part)).filter(Boolean).join('');
      }
    }

    if (Array.isArray(node.content)) {
      return node.content.map((part) => normalizeTextNode(part)).filter(Boolean).join('');
    }

    return '';
  };

  if (typeof normalizedResponse.output_text === 'string' && normalizedResponse.output_text.trim()) {
    return normalizedResponse.output_text;
  }

  if (Array.isArray(normalizedResponse.output_text)) {
    const text = normalizedResponse.output_text.map((part) => normalizeTextNode(part)).filter(Boolean).join('');
    if (text.trim()) return text;
  }

  if (Array.isArray(normalizedResponse.output)) {
    const parts = [];
    for (const item of normalizedResponse.output) {
      if (Array.isArray(item?.content)) {
        for (const content of item.content) {
          const text = normalizeTextNode(content);
          if (text) parts.push(text);
        }
      } else {
        const text = normalizeTextNode(item);
        if (text) parts.push(text);
      }
    }
    const joined = parts.join('');
    if (joined.trim()) return joined;
  }

  const completionLike = normalizedResponse?.choices?.[0]?.message?.content;
  if (typeof completionLike === 'string' && completionLike.trim()) return completionLike;
  if (Array.isArray(completionLike)) {
    const text = completionLike.map((part) => normalizeTextNode(part)).filter(Boolean).join('\n');
    if (text.trim()) return text;
  }

  const fallback = normalizeTextNode(normalizedResponse?.message) || normalizeTextNode(normalizedResponse?.content);
  return fallback || '';
}

function normalizeStringContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item?.type === 'text' && typeof item.text === 'string') return item.text;
        if (item?.type === 'input_text' && typeof item.text === 'string') return item.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content || '');
}

/**
 * 统一的内容片段结构：{ type:'text' | 'image', ... }
 * 渲染层 / 主进程都按这个结构传，各家协议的分歧留给 formatContentForProvider 处理。
 */
function normalizeContentParts(content) {
  const raw = Array.isArray(content) ? content : [content];
  const parts = [];

  raw.forEach((item) => {
    if (item === null || item === undefined) return;
    if (typeof item === 'string') {
      if (item.trim()) parts.push({ type: 'text', text: item });
      return;
    }
    if (typeof item !== 'object') return;

    const type = String(item.type || '');
    if (type === 'text' || type === 'input_text' || (!type && item.text !== undefined)) {
      const text = String(item.text ?? '');
      if (text) parts.push({ type: 'text', text });
      return;
    }

    // 图片：既接受裸 base64，也接受 data URL
    const rawBase64 = String(item.base64 || item.data || '');
    const inlineUrl = String(item.image_url || item.url || '');
    let base64 = rawBase64.replace(/^data:[^;,]*;base64,/, '');
    let mimeType = String(item.mimeType || item.media_type || '').trim();
    if (!base64 && inlineUrl) {
      const matched = inlineUrl.match(/^data:([^;,]*);base64,(.*)$/);
      if (matched) {
        base64 = matched[2];
        if (!mimeType) mimeType = matched[1];
      }
    }
    if (!base64) return;
    parts.push({ type: 'image', base64, mimeType: mimeType || 'image/png' });
  });

  return parts;
}

/**
 * 把统一内容片段转成目标协议的 content 字段。
 * - responses：input_text / input_image
 * - chat_completions：纯文本仍用字符串，带图才升级成 image_url 数组
 * - messages（Claude）：text / image(base64 source)
 */
function formatContentForProvider(content, format) {
  const parts = normalizeContentParts(content);
  const hasImage = parts.some((part) => part.type === 'image');

  if (format === 'responses') {
    return parts.map((part) => (part.type === 'image'
      ? { type: 'input_image', image_url: `data:${part.mimeType};base64,${part.base64}` }
      : { type: 'input_text', text: part.text }));
  }

  if (format === 'messages') {
    return parts.map((part) => (part.type === 'image'
      ? { type: 'image', source: { type: 'base64', media_type: part.mimeType, data: part.base64 } }
      : { type: 'text', text: part.text }));
  }

  if (!hasImage) return parts.map((part) => part.text).join('\n');
  return parts.map((part) => (part.type === 'image'
    ? { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.base64}` } }
    : { type: 'text', text: part.text }));
}

function toResponsesInput(messages) {
  return (messages || []).map((message) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: formatContentForProvider(message.content, 'responses'),
  }));
}

function buildOpenAICompletionPayload(model, instructions, messages, maxOutputTokens) {
  return {
    model,
    messages: [
      ...(instructions ? [{ role: 'system', content: instructions }] : []),
      ...messages.map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: formatContentForProvider(message.content, 'chat_completions'),
      })),
    ],
    max_tokens: maxOutputTokens,
  };
}

async function createOpenAITextResponse(client, model, apiFormat, options) {
  const detailed = await createOpenAITextResponseDetailed(client, model, apiFormat, options);
  return detailed.text;
}

async function createOpenAITextResponseDetailed(client, model, apiFormat, { instructions = '', messages = [], maxOutputTokens = 4096, signal }) {
  const completionPayload = buildOpenAICompletionPayload(model, instructions, messages, maxOutputTokens);

  if (apiFormat === 'responses') {
    const response = await client.responses.create({
      model,
      instructions: instructions || undefined,
      input: toResponsesInput(messages),
      max_output_tokens: maxOutputTokens,
    }, signal ? { signal } : undefined);

    const primaryText = extractResponseText(response);
    if (primaryText.trim()) {
      return { text: primaryText, finishReason: extractFinishReason(response, 'openai') };
    }

    // 一些兼容网关对 Responses 成功返回但不带 output_text，自动回退到 chat.completions
    let fallbackError = null;
    try {
      const completionFallback = await client.chat.completions.create(completionPayload, signal ? { signal } : undefined);
      const fallbackText = extractResponseText(completionFallback);
      if (fallbackText.trim()) {
        return { text: fallbackText, finishReason: extractFinishReason(completionFallback, 'openai') };
      }
    } catch (error) {
      fallbackError = error;
    }
    return {
      text: ensureModelText('', `（Responses 返回为空${fallbackError ? `，回退 chat.completions 也失败：${compactError(fallbackError)}` : ''}）`),
      finishReason: extractFinishReason(response, 'openai'),
    };
  }

  const completion = await client.chat.completions.create(completionPayload, signal ? { signal } : undefined);
  return {
    text: ensureModelText(extractResponseText(completion), '（chat.completions）'),
    finishReason: extractFinishReason(completion, 'openai'),
  };
}

async function createOpenAITextResponseStream(client, model, apiFormat, { instructions = '', messages = [], maxOutputTokens = 4096, signal, onDelta }) {
  const emit = (value) => {
    if (typeof value !== 'string' || !value) return;
    if (typeof onDelta === 'function') onDelta(value);
  };
  const completionPayload = buildOpenAICompletionPayload(model, instructions, messages, maxOutputTokens);

  if (apiFormat === 'responses') {
    try {
      const responseStream = await client.responses.create({
        model,
        instructions: instructions || undefined,
        input: toResponsesInput(messages),
        max_output_tokens: maxOutputTokens,
        stream: true,
      }, signal ? { signal } : undefined);

      let text = '';
      for await (const event of responseStream) {
        if (signal?.aborted) throw new Error('请求已取消');
        if (event?.type === 'response.output_text.delta' && typeof event.delta === 'string') {
          text += event.delta;
          emit(event.delta);
        }
        if (event?.type === 'response.error') {
          throw new Error(event.error?.message || 'Responses 流式输出失败');
        }
      }
      if (text.trim()) return text;
    } catch (streamError) {
      if (signal?.aborted) throw streamError;
      // Responses 流式失败时，自动回退 chat.completions stream
    }
  }

  const completionStream = await client.chat.completions.create({
    ...completionPayload,
    stream: true,
  }, signal ? { signal } : undefined);

  let text = '';
  for await (const chunk of completionStream) {
    if (signal?.aborted) throw new Error('请求已取消');
    const delta = chunk?.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta) {
      text += delta;
      emit(delta);
      continue;
    }
    if (Array.isArray(delta)) {
      const piece = delta
        .map((item) => normalizeStringContent(item))
        .filter(Boolean)
        .join('\n');
      if (piece) {
        text += piece;
        emit(piece);
      }
    }
  }
  return text;
}

async function recognizeWithOpenAI(client, model, apiFormat, imageBase64, mimeType = 'image/png', prompt = OCR_PROMPT, signal) {
  const imageUrl = `data:${mimeType};base64,${imageBase64}`;

  if (apiFormat === 'responses') {
    const response = await client.responses.create({
      model,
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          { type: 'input_image', image_url: imageUrl },
        ],
      }],
      max_output_tokens: 8192,
    }, signal ? { signal } : undefined);
    return ensureModelText(extractResponseText(response), '（Responses 视觉识别）');
  }

  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ],
    max_tokens: 8192,
  }, signal ? { signal } : undefined);

  // 部分兼容网关返回数组型 content，统一走通用提取，避免 String(array) 变成 [object Object]
  return ensureModelText(extractResponseText(response), '（视觉识别）');
}

async function recognizeWithClaude(client, model, imageBase64, mimeType = 'image/png', prompt = OCR_PROMPT, signal) {
  const response = await client.messages.create({
    model,
    max_tokens: 8192,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mimeType,
              data: imageBase64,
            },
          },
          { type: 'text', text: prompt },
        ],
      },
    ],
  }, signal ? { signal } : undefined);

  return ensureModelText(extractClaudeText(response), '（Claude 视觉识别）');
}

function extractClaudeText(response) {
  return (response?.content || [])
    .map((item) => (item?.type === 'text' ? String(item.text || '') : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * 从模型输出里提取 JSON。
 * expectedKeys 传入调用方期望的顶层字段（如 ['questions']）：模型输出被截断时，
 * 外层 JSON 不完整但内部小对象仍可解析，此时不能把选项/片段当成最终结果返回。
 */
function extractJSONObject(text, expectedKeys = []) {
  const raw = String(text || '').trim();
  // 网关可能返回结构合法的响应对象，但把后台网页塞进 content。
  // 这时不能退化成「JSON 解析失败」，要直接给出配置级提示。
  if (looksLikeHtml(raw) && !/^[{[]/.test(raw)) {
    const error = new Error('AI 接口返回的不是模型结果：模型文本里是网页 HTML。请检查 Base URL 是否需要补 /v1、模型名是否正确、API Key 分组是否有可用通道');
    error.code = 'INVALID_API_RESPONSE';
    throw error;
  }
  const expected = Array.isArray(expectedKeys) ? expectedKeys.filter(Boolean) : [];
  const candidates = [];
  const pushCandidate = (value) => {
    const candidate = String(value || '').trim();
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  };
  const fencedMatches = raw.match(/```(?:json)?\s*([\s\S]*?)```/gi) || [];
  fencedMatches.forEach((block) => pushCandidate(block.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '')));

  // 扫描平衡的大括号/方括号，避免贪婪正则被题目中的 TeX 大括号干扰。
  let rootStart = -1;
  let rootClosed = true;
  for (let start = 0; start < raw.length; start += 1) {
    if (raw[start] !== '{' && raw[start] !== '[') continue;
    if (rootStart < 0) rootStart = start;
    const stack = [];
    let inString = false;
    let escaped = false;
    let closed = false;
    for (let index = start; index < raw.length; index += 1) {
      const char = raw[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{' || char === '[') stack.push(char);
      else if (char === '}' || char === ']') {
        const expected = char === '}' ? '{' : '[';
        if (stack[stack.length - 1] !== expected) break;
        stack.pop();
        if (!stack.length) {
          pushCandidate(raw.slice(start, index + 1));
          closed = true;
          break;
        }
      }
    }
    if (start === rootStart && !closed) rootClosed = false;
  }

  // 最外层 JSON 没写完时，内部选项/片段对象仍能解析成功，绝不能当成最终题目返回。
  if (expected.length && !rootClosed) {
    const error = new Error('无法解析返回结果：最外层 JSON 未闭合，模型输出可能被截断，请减少单次识别页数或缩小识别范围');
    error.raw = raw;
    throw error;
  }

  let lastError = null;
  let firstObject = null;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) {
        // 选项对象也有 content，但没有题干结构；截断输出里的 options 数组不能被当成题目列表
        const questionLike = parsed.some((item) => item && typeof item === 'object'
          && typeof item.content === 'string' && item.content.trim()
          && (!('key' in item) || Array.isArray(item.options) || 'type' in item || 'answer' in item));
        const wrapped = questionLike
          ? { questions: parsed }
          : parsed.some((item) => item && typeof item === 'object' && ('number' in item || 'answer' in item))
            ? { answers: parsed }
            : { items: parsed };
        if (!expected.length || expected.some((key) => key in wrapped)) return wrapped;
        if (!firstObject) firstObject = wrapped;
        continue;
      }
      if (parsed && typeof parsed === 'object') {
        if (!expected.length || expected.some((key) => key in parsed)) return parsed;
        if (!firstObject) firstObject = parsed;
      }
    } catch (error) {
      lastError = error;
    }
  }

  // 模型偶尔只返回单道题 / 单条答案对象，补一层包装，避免结果静默变成空数组
  if (firstObject && expected.includes('questions') && typeof firstObject.content === 'string' && firstObject.content.trim()) {
    return { questions: [firstObject] };
  }
  if (firstObject && expected.includes('answers') && typeof firstObject.answer === 'string') {
    return { answers: [firstObject] };
  }

  const error = expected.length
    ? new Error(`无法解析返回结果：响应里缺少 ${expected.join(' / ')} 字段，可能是输出被截断或格式不符${lastError ? `（${lastError.message}）` : ''}`)
    : candidates.length
      ? new Error(`无法解析返回结果：JSON 格式错误（${lastError?.message || '格式不合法或输出被截断'}）`)
      : new Error('无法解析返回结果：响应中没有完整 JSON 对象或数组');
  error.raw = raw;
  throw error;
}

/**
 * 教材页转写：把一页教材图片转成 Markdown（不走题目 JSON 结构化）。
 * 保留标题层级、公式（$...$）、例题与习题的题号，供知识清单与题目提取使用。
 */
const TRANSCRIBE_PROMPT = `你是教材转写助手。把这一页教材内容完整转写为 Markdown：
- 保留标题层级（# / ## / ###）、列表、表格；
- 数学公式用 $...$ 或 $$...$$ 的 LaTeX 语法，不要退化成 Unicode 上下标；中文、单位、说明留在公式外（如「需要 $\\frac{24}{7} \\approx 3.4$ 小时」），块级公式单独占行；
- 例题和习题保留原始题号，用「**例 1.2**」「**习题 3.5**」一类的加粗标记开头，题目下方如有答案/解析一并保留并标明；
- 概念定义、定理、公式原文照录，不要总结、不要省略、不要添加教材里没有的内容；
- 图片转写不出来时写「（本页含图：图注）」；
- 只输出转写正文，不要任何开场白或说明。`;

/**
 * 带插图定位的转写：除了正文，还要模型把本页「实质插图」的框给出来，
 * 渲染层据此从页图里精确裁出单张插图，题目按图号引用时就能挂上对应图片。
 * bbox 用 0-1000 归一化坐标，比让模型猜像素坐标稳得多。
 */
const TRANSCRIBE_WITH_FIGURES_PROMPT = `你是教材转写助手。把这一页教材内容完整转写为 Markdown，并列出本页实质插图的位置。

只输出一个 JSON 对象（不要代码块标记、不要任何说明）：
{
  "markdown": "这一页的完整转写正文",
  "figures": [
    {"no": "图 2-40", "bbox": [120, 210, 880, 470], "caption": "两个串联水箱方框图"}
  ]
}

markdown 字段的要求：
- 保留标题层级（# / ## / ###）、列表、表格；
- 数学公式用 $...$ 或 $$...$$ 的 LaTeX 语法，不要退化成 Unicode 上下标；中文、单位、说明留在公式外（如「需要 $\\frac{24}{7} \\approx 3.4$ 小时」），块级公式单独占行；
- 例题和习题保留原始题号，用「**例 1.2**」「**习题 3.5**」一类的加粗标记开头，题目下方如有答案/解析一并保留并标明；
- 概念定义、定理、公式原文照录，不要总结、不要省略、不要添加教材里没有的内容；
- 插图处写明图号，例如「（本页含图：图 2-40 两个串联水箱方框图）」；
- 正文里的换行、引号要按 JSON 字符串规则正确转义。

figures 字段的要求：
- bbox 是插图（含图题、坐标轴、图例）在整页图片中的位置，格式为 [左, 上, 右, 下]，
  使用 0-1000 的整数归一化坐标，左上角 [0,0]、右下角 [1000,1000]；
- 只框插图本身，不要把正文段落、页眉页脚框进去；
- 只框有实质内容的插图（方框图、结构图、曲线图、波形图、示意图、电路图）；
  封面装饰、页眉图标、出版社 logo、纯文字表格一律不框；
- no 写教材里印刷的图号（如「图 2-40」「图3.5(a)」）；看不清图号就写「图 第N页」；
- 本页没有插图时 figures 给空数组 [];

只输出 JSON。`;

async function transcribePage(settings, imageBase64, mimeType = 'image/png', options = {}) {
  const signal = options?.signal;
  assertVisionModel(settings, '教材转写');
  // 转写是照抄任务，不需要思考：关掉后单页响应明显更快，也不会被推理 token 挤掉正文
  const { type, client, model, settings: normalizedSettings } = createClient(withoutThinking(settings));

  if (type === 'anthropic') {
    const response = await client.messages.create({
      model,
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
          { type: 'text', text: TRANSCRIBE_PROMPT },
        ],
      }],
    }, signal ? { signal } : undefined);
    return ensureModelText(extractClaudeText(response), '（Claude 教材转写）');
  }

  return recognizeWithOpenAI(client, model, normalizedSettings.apiFormat, imageBase64, mimeType, TRANSCRIBE_PROMPT, signal);
}

/**
 * 教材页转写 + 插图定位。模型偶尔会输出不完整 JSON，这时降级成「只有正文、没有插图」，
 * 保证正文转写不丢——页图仍然会落盘，后续还能靠整页图兜底，绝不能因为解析失败让整页白跑。
 */
async function transcribePageWithFigures(settings, imageBase64, mimeType = 'image/jpeg', options = {}) {
  const signal = options?.signal;
  assertVisionModel(settings, '教材转写');
  const { type, client, model, settings: normalizedSettings } = createClient(withoutThinking(settings));

  let raw;
  if (type === 'anthropic') {
    const response = await client.messages.create({
      model,
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
          { type: 'text', text: TRANSCRIBE_WITH_FIGURES_PROMPT },
        ],
      }],
    }, signal ? { signal } : undefined);
    raw = ensureModelText(extractClaudeText(response), '（Claude 教材转写）');
  } else {
    raw = await recognizeWithOpenAI(client, model, normalizedSettings.apiFormat, imageBase64, mimeType, TRANSCRIBE_WITH_FIGURES_PROMPT, signal);
  }

  const text = String(raw || '').trim();
  try {
    const parsed = extractJSONObject(text, ['markdown']);
    const markdown = String(parsed?.markdown || '').trim();
    if (!markdown) throw new Error('markdown 为空');
    const figures = (Array.isArray(parsed?.figures) ? parsed.figures : [])
      .map((item) => ({
        no: String(item?.no || '').trim().slice(0, 40),
        caption: String(item?.caption || '').trim().slice(0, 120),
        bbox: normalizeBBox(item?.bbox),
      }))
      .filter((item) => item.bbox)
      .slice(0, 8);
    return { markdown, figures, degraded: false };
  } catch (error) {
    // 模型可能直接吐了 markdown 文本：去掉可能的 ```json 围栏后当正文用
    const fallback = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    console.warn('[AI] 插图定位解析失败，本页降级为纯转写:', error?.message || error);
    return { markdown: fallback, figures: [], degraded: true };
  }
}

/** bbox 只接受 0-1000 的四个数，且要有有效面积；脏坐标直接丢弃而不是裁出一张黑图 */
function normalizeBBox(input) {
  if (!Array.isArray(input) || input.length < 4) return null;
  const nums = input.slice(0, 4).map((v) => Number(v));
  if (nums.some((v) => !Number.isFinite(v))) return null;
  let [x1, y1, x2, y2] = nums.map((v) => Math.max(0, Math.min(1000, Math.round(v))));
  if (x1 > x2) [x1, x2] = [x2, x1];
  if (y1 > y2) [y1, y2] = [y2, y1];
  if (x2 - x1 < 40 || y2 - y1 < 40) return null;
  return [x1, y1, x2, y2];
}

async function structureQuestionsFromText(settings, rawText, options = {}) {
  const { type, client, model, settings: normalizedSettings } = createClient(structuredSettings(settings));
  const signal = options?.signal;
  const scope = String(options.scope || '').trim();
  const sourceFormat = String(options.sourceFormat || '').toLowerCase();
  const sourceHint = sourceFormat === 'tex'
    ? '原始材料是 TeX 源码：忽略 documentclass、宏包、导言区和排版命令，只提取正文中的题目；把原有数学公式原样保留为 $...$ / $$...$$ 的 LaTeX，不要退化成 Unicode 上下标或纯文本。'
    : '';
  const prompt = `${OCR_PROMPT}\n\n${sourceHint ? `${sourceHint}\n` : ''}${scope ? `只处理用户指定范围：${scope}。\n` : ''}以下是原始文本，请你整理为标准 JSON：\n\n${rawText}`;

  if (type === 'anthropic') {
    const response = await client.messages.create({
      model,
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
    }, signal ? { signal } : undefined);
    return ensureModelText(extractClaudeText(response), '（Claude 文本识题）');
  }

  return createOpenAITextResponse(client, model, normalizedSettings.apiFormat, {
    messages: [{ role: 'user', content: prompt }],
    maxOutputTokens: 8192,
    signal,
  });
}

async function structureAnswersFromText(settings, rawText, options = {}) {
  const { type, client, model, settings: normalizedSettings } = createClient(structuredSettings(settings));
  const signal = options?.signal;
  const scope = String(options.scope || normalizedSettings.recognitionScope || '').trim();
  const prompt = `${ANSWER_KEY_PROMPT}\n${scope ? `只处理用户指定范围：${scope}\n` : ''}以下是答案文本：\n\n${rawText}`;
  if (type === 'anthropic') {
    const response = await client.messages.create({ model, max_tokens: 8192, messages: [{ role: 'user', content: prompt }] }, signal ? { signal } : undefined);
    return ensureModelText(extractClaudeText(response), '（Claude 答案识别）');
  }
  return createOpenAITextResponse(client, model, normalizedSettings.apiFormat, {
    messages: [{ role: 'user', content: prompt }],
    maxOutputTokens: 8192,
    signal,
  });
}

/** 自动模式下：扫描 PDF（渲染成图片后也保留 pdf 来源标记）优先交给 OCR 引擎 B */
function shouldUseOCREngine(settings, mimeType) {
  if (!settings?.ocrEnabled || !settings?.ocrApiUrl) return false;
  if (settings.recognizeEngine === 'ocr') return true;
  if (settings.recognizeEngine !== 'auto') return false;
  return mimeType === 'application/pdf' || settings.recognitionSource === 'pdf';
}

async function recognizeWithOCREngine(settings, imageBase64, mimeType = 'image/png', signal, role = 'questions') {
  const normalizedSettings = normalizeAISettings(settings);
  if (!normalizedSettings.ocrEnabled || !normalizedSettings.ocrApiUrl) {
    throw new Error('OCR 引擎未配置');
  }

  const resultKey = role === 'answers' ? 'answers' : 'questions';
  const ocrPrompt = role === 'answers' ? ANSWER_KEY_PROMPT : OCR_PROMPT;
  const headers = { 'Content-Type': 'application/json' };
  if (normalizedSettings.ocrApiKey) {
    headers.Authorization = `Bearer ${normalizedSettings.ocrApiKey}`;
    headers['X-API-Key'] = normalizedSettings.ocrApiKey;
  }

  const response = await fetch(normalizedSettings.ocrApiUrl, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      imageBase64,
      mimeType,
      role,
      responseMode: normalizedSettings.ocrResponseMode,
      prompt: withRecognitionScope(ocrPrompt, normalizedSettings),
    }),
  });

  if (!response.ok) {
    throw new Error(`OCR 请求失败：${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json()
    : { text: await response.text() };

  const directList = payload?.[resultKey] ?? payload?.data?.[resultKey];
  if (Array.isArray(directList)) return { [resultKey]: directList };

  const fallbackList = payload?.questions || payload?.data?.questions || payload?.answers || payload?.data?.answers;
  if (Array.isArray(fallbackList)) {
    if (resultKey === 'answers') {
      const answers = fallbackList
        .filter((item) => item && (item.number || item.answer))
        .map((item, index) => ({
          number: String(item.number || index + 1),
          answer: String(item.answer || ''),
          analysis: String(item.analysis || ''),
        }));
      if (answers.length) return { answers };
    } else {
      return { questions: fallbackList };
    }
  }

  const textNode = payload?.text ?? payload?.content ?? payload?.data?.text;
  const text = String(Array.isArray(textNode) ? normalizeStringContent(textNode) : (textNode || '')).trim();
  if (!text) {
    throw new Error(resultKey === 'answers'
      ? 'OCR 返回为空：没有拿到答案表（需要 answers 数组或含 number/answer 的题目结构）'
      : 'OCR 返回为空：没有拿到题目结构或可解析文本');
  }

  const parsed = normalizedSettings.ocrResponseMode === 'json_questions'
    ? text
    : role === 'answers'
      ? await structureAnswersFromText(settings, text, { scope: normalizedSettings.recognitionScope, signal })
      : await structureQuestionsFromText(settings, text, { scope: normalizedSettings.recognitionScope, signal });
  // OCR 引擎（含 json_questions 直出）也必须走教材格式层，否则会绕过统一规范
  return formatAIResult(extractJSONObject(parsed, [resultKey]));
}

const ANSWER_KEY_PROMPT = `你是一个严谨的考研答案识别助手。请识别图片或文本中的答案表，并只输出 JSON：

{
  "answers": [
    {"number": "1", "answer": "A", "analysis": "答案页中提供的解析，没有则为空"}
  ]
}

要求：保留题号和原始答案，不要自行解题；无法确认的 answer 留空，并在 analysis 中说明。
答案表中的填空 / 主观题答案常常是公式或英文，必须原样保留大小写与数学含义，并用 $...$ 写数学公式（如 $\\frac{1}{2}$、$f(x)$），禁止改成大写、禁止写成 Unicode 上下标。
${TEXTBOOK_FORMAT_GUIDE}`;

// 通用 AI 识图/文本识题 prompt
const OCR_PROMPT = `你是一个专业的考研题目识别助手。请识别图片或文本中的考试题目，并按以下 JSON 格式输出：

{
  "questions": [
    {
      "content": "题目内容",
      "options": [
        {"key": "A", "content": "选项A内容"},
        {"key": "B", "content": "选项B内容"},
        {"key": "C", "content": "选项C内容"},
        {"key": "D", "content": "选项D内容"}
      ],
      "answer": "选择/判断/填空答案；主观题没有标准答案时留空",
      "analysis": "解析内容（如果有）",
      "category": "math|english|politics|major",
      "subCategory": "模块编码，只能取下方清单里的值",
      "chapter": "章节名，必须原样取自下方清单",
      "points": ["知识点"],
      "type": "single|multiple|judge|fill|subjective",
      "page": 该题所在页码（输入文本带 <!-- 第 N 页 --> 标记时填 N，取题目前方最近的标记；没有标记或判断不了填 null）
    }
  ]
}

注意：
1. 如果材料中有多道题目，请全部识别
2. 如果没有解析，analysis 字段留空字符串
3. 如果没有答案，answer 字段留空字符串；主观题即使没有答案也要保留题目
4. category 必须只从 math、english、politics、major 中选择；无法判断时结合题干和选项推断最可能的考研科目
5. 分类固定为「科目 → 模块 → 章节 → 知识点」四层，不要自己增加层级，也不要把章节和知识点混在一起
6. subCategory 只能取下方清单中该科目的模块编码（如 math 的 gaoshu / daishu / gaiilv）
7. chapter 必须从对应模块的章节清单里原样挑一个；确实都不合适时填「其他」，禁止自造长章节名
8. points 只写 1-2 个教材标准名词（2-8 个汉字），例如「泰勒公式」「洛必达法则」「基础解系」；
   禁止写成句子或罗列一串公式，禁止带「考点」「知识点」「掌握」「理解」等前缀，禁止重复章节名或模块名
9. options 对填空题和主观题可以为空数组
10. 题干引用插图时必须保留教材原图号，写成「图 2-5」「如图 2-5 所示」；不要简化成「图 2」「如图」；原书确实没有编号时才写「如图」
11. 输入文本里出现 <!-- 第 N 页 --> 标记时，必须给每题填 page=N（该题题干在标记之后、下一个标记之前）；没有标记时 page 填 null，不要猜页码
12. 只输出 JSON，不要其他内容

${TEXTBOOK_FORMAT_GUIDE}

分类清单（科目 / 模块编码（模块名）章节清单；知识点示例）：
${buildTaxonomyGuide()}`;

function withRecognitionScope(prompt, settings) {
  const scope = String(settings?.recognitionScope || '').trim();
  return scope ? `${prompt}\n\n用户指定识别范围：${scope}。范围外内容不要输出。` : prompt;
}

async function recognizeQuestions(settings, imageBase64, mimeType = 'image/png', options = {}) {
  const normalizedSettings = normalizeAISettings(settings);
  const signal = options?.signal;

  if (shouldUseOCREngine(normalizedSettings, mimeType)) {
    return recognizeWithOCREngine(normalizedSettings, imageBase64, mimeType, signal, 'questions');
  }

  try {
    assertVisionModel(normalizedSettings, '题目识别');
  } catch (error) {
    return { questions: [], error: error.message };
  }
  const { type, client, model, settings: clientSettings } = createClient(structuredSettings(normalizedSettings));

  let resultText;
  if (type === 'anthropic') {
    resultText = await recognizeWithClaude(client, model, imageBase64, mimeType, withRecognitionScope(OCR_PROMPT, normalizedSettings), signal);
  } else {
    resultText = await recognizeWithOpenAI(client, model, clientSettings.apiFormat, imageBase64, mimeType, withRecognitionScope(OCR_PROMPT, normalizedSettings), signal);
  }

  try {
    ensureModelText(resultText, '（题目识别）');
    return formatAIResult(extractJSONObject(resultText, ['questions']));
  } catch (error) {
    console.error('解析 AI 返回结果失败:', error);
    return { questions: [], error: `AI 题目识别结果无法解析：${error.message || '模型未返回合法 JSON'}`, raw: resultText };
  }
}

async function recognizeAnswers(settings, imageBase64, mimeType = 'image/png', options = {}) {
  const normalizedSettings = normalizeAISettings(settings);
  const signal = options?.signal;

  if (shouldUseOCREngine(normalizedSettings, mimeType)) {
    return recognizeWithOCREngine(normalizedSettings, imageBase64, mimeType, signal, 'answers');
  }

  try {
    assertVisionModel(normalizedSettings, '答案识别');
  } catch (error) {
    return { answers: [], error: error.message };
  }
  const { type, client, model, settings: clientSettings } = createClient(structuredSettings(normalizedSettings));
  const prompt = withRecognitionScope(ANSWER_KEY_PROMPT, normalizedSettings);
  let resultText = '';
  if (type === 'anthropic') {
    const response = await client.messages.create({
      model,
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
          { type: 'text', text: prompt },
        ],
      }],
    }, signal ? { signal } : undefined);
    resultText = extractClaudeText(response);
  } else {
    const imageUrl = `data:${mimeType};base64,${imageBase64}`;
    if (clientSettings.apiFormat === 'responses') {
      const response = await client.responses.create({
        model,
        input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: imageUrl }] }],
        max_output_tokens: 8192,
      }, signal ? { signal } : undefined);
      resultText = extractResponseText(response);
    } else {
      const response = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: imageUrl } }] }],
        max_tokens: 8192,
      }, signal ? { signal } : undefined);
      resultText = extractResponseText(response);
    }
  }
  try {
    ensureModelText(resultText, '（答案识别）');
    return formatAIResult(extractJSONObject(resultText, ['answers']));
  } catch (error) {
    return { answers: [], error: `AI 答案识别结果无法解析：${error.message || '模型未返回合法 JSON'}`, raw: resultText };
  }
}

async function matchQuestionAnswers(settings, questions = [], answers = [], options = {}) {
  const { type, client, model, settings: normalizedSettings } = createClient(structuredSettings(settings));
  const signal = options?.signal;
  const scope = String(options.scope || normalizedSettings.recognitionScope || '').trim();
  const solveMissing = Boolean(options.solveMissing);
  const prompt = `你是考研题库质检助手。请将题目与答案表按题号或内容匹配，判断答案是否一致。${solveMissing ? '答案表没有覆盖的题目可以谨慎解题，并在 reason 中写明“AI 推导”。' : '不要重新解题；答案表没有覆盖的题目标记 missing。'}\n${scope ? `识别范围：${scope}\n` : ''}输出严格 JSON：
{"matches":[{"questionIndex":1,"answer":"A","analysis":"答案页原解析","status":"matched|mismatch|missing","reason":"不一致原因或空字符串","confidence":0.0}]}

answer 必须原样沿用答案表里的答案：客观题是选项字母，填空/主观题是文本或公式，禁止改成大写、禁止丢弃大小写；analysis / reason 里的数学公式用 $...$ 书写。
${TEXTBOOK_FORMAT_GUIDE}

题目：${JSON.stringify(questions)}
答案表：${JSON.stringify(answers)}`;
  let resultText = '';
  if (type === 'anthropic') {
    const response = await client.messages.create({ model, max_tokens: 4096, messages: [{ role: 'user', content: prompt }] }, signal ? { signal } : undefined);
    resultText = extractClaudeText(response);
  } else {
    resultText = await createOpenAITextResponse(client, model, normalizedSettings.apiFormat, {
      messages: [{ role: 'user', content: prompt }],
      maxOutputTokens: 4096,
      signal,
    });
  }
  try {
    ensureModelText(resultText, '（题目答案匹配）');
    return formatAIResult(extractJSONObject(resultText, ['matches']));
  } catch (error) {
    return { matches: [], error: `题目答案匹配结果无法解析：${error.message || '模型未返回合法 JSON'}`, raw: resultText };
  }
}

const TEACHER_SYSTEM = `你是一位经验丰富、耐心细致的学习辅导老师，名叫"小开"。你的任务是：
1. 帮助学生理解题目、掌握知识点、提升学习能力
2. 用通俗易懂的语言解释，必要时举例说明
3. 鼓励学生思考，不直接给答案，引导式教学
4. 回答时使用清晰的结构（分点、标题等）
5. 如果学生问的不是学习相关问题，礼貌地引导回学习话题`;

/**
 * 题库重新分类：只重跑「分类」这一件事，不重新识题、不重新解题。
 *
 * 入参 items 是精简过的题干（已截断），一次 10-15 道，控制 token。
 * 输出强制走「科目 → 模块 → 章节 → 知识点」四层，落库前再用共享规则清洗一遍，
 * 避免模型又冒出一堆长句知识点。
 */
async function classifyQuestions(settings, items = [], options = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return { results: [] };
  const { type, client, model, settings: normalizedSettings } = createClient(structuredSettings(settings));
  const signal = options?.signal;
  const taxonomy = options?.taxonomy || null;
  const categories = Array.from(new Set(list.map((item) => String(item?.category || '').trim()).filter(Boolean)));
  const guide = taxonomy
    ? buildSubjectTaxonomyGuide(taxonomy)
    : buildTaxonomyGuide(categories.length ? categories : undefined);
  const payload = list.map((item, index) => ({
    i: index + 1,
    content: String(item?.content || '').replace(/\s+/g, ' ').slice(0, 220),
    options: String(item?.options || '').slice(0, 160),
  }));
  const prompt = taxonomy
    ? `你是题库的分类助手。请按这门科目自己的教材知识清单，给下面的题目打上「子类别 → 章节 → 知识点」三级分类，不要解题，不要复述题干。
输出严格 JSON：
{"results":[{"i":1,"subCategory":"控制系统的数学模型","chapter":"传递函数的定义、性质与零极点","points":["传递函数","零极点"]}]}

规则：
1. i 必须与题目编号一一对应，不能漏题
2. subCategory 只能原样取清单里的「子类别」
3. chapter 只能原样取该子类别下的「章节」，禁止自造章节名；确实无法判断就把 chapter 写成空字符串
4. points 只写 1-2 个题干或知识点示例里真实出现过的教材标准名词（2-10 个汉字），不要写句子、不要带「考点/知识点/掌握」前缀、不要重复章节名，禁止编造
5. 只输出 JSON

分类清单：
${guide}

题目：
${JSON.stringify(payload)}`
    : `你是考研题库的分类助手。请给下面的题目打上「科目 → 模块 → 章节 → 知识点」四级分类，不要解题，不要复述题干。
输出严格 JSON：
{"results":[{"i":1,"category":"math","subCategory":"gaoshu","chapter":"一元函数微分学","points":["泰勒公式"]}]}

规则：
1. i 必须与题目编号一一对应，不能漏题
2. category 只能是 math / english / politics / major
3. subCategory 只能取清单里该科目的模块编码
4. chapter 必须从对应模块的章节清单里原样挑一个，都不合适填「其他」
5. points 只写 1-2 个教材标准名词（2-8 个汉字），不要写句子、不要带「考点/知识点/掌握」前缀、不要重复章节名
6. 只输出 JSON

分类清单：
${guide}

题目：
${JSON.stringify(payload)}`;

  let resultText = '';
  if (type === 'anthropic') {
    const response = await client.messages.create({ model, max_tokens: 4096, messages: [{ role: 'user', content: prompt }] }, signal ? { signal } : undefined);
    resultText = extractClaudeText(response);
  } else {
    resultText = await createOpenAITextResponse(client, model, normalizedSettings.apiFormat, {
      messages: [{ role: 'user', content: prompt }],
      maxOutputTokens: 4096,
      signal,
    });
  }

  try {
    ensureModelText(resultText, '（题库分类）');
    const parsed = extractJSONObject(resultText, ['results']);
    const rows = Array.isArray(parsed?.results) ? parsed.results : [];
    const results = rows.map((row) => {
      const index = Number(row?.i ?? row?.index ?? 0) - 1;
      const item = list[index] || {};
      const normalized = normalizeClassification({
        category: row?.category || item.category || '',
        subCategory: row?.subCategory || row?.sub_category || '',
        chapter: row?.chapter || '',
        points: row?.points || row?.tags || row?.knowledgePoints,
      }, taxonomy ? { taxonomy } : {});
      return { index, ...normalized };
    }).filter((row) => row.index >= 0 && row.index < list.length && row.category);
    return { results };
  } catch (error) {
    return { results: [], error: `题库分类结果无法解析：${error.message || '模型未返回合法 JSON'}`, raw: resultText };
  }
}

async function chat(settings, messages, options = {}) {
  const { type, client, model, settings: normalizedSettings } = createClient(settings);
  const systemPrompt = options.system || TEACHER_SYSTEM;
  const maxTokens = Number(options.maxTokens) > 0 ? Number(options.maxTokens) : 4096;
  const fullMessages = [{ role: 'system', content: systemPrompt }, ...(messages || [])];

  try {
    if (type === 'anthropic') {
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: fullMessages.filter((message) => message.role !== 'system').map((message) => ({
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: formatContentForProvider(message.content, 'messages'),
        })),
      });
      return { success: true, content: extractClaudeText(response) };
    }

    const text = await createOpenAITextResponse(client, model, normalizedSettings.apiFormat, {
      instructions: systemPrompt,
      messages: fullMessages.filter((message) => message.role !== 'system'),
      maxOutputTokens: maxTokens,
    });
    return { success: true, content: text };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function chatStream(settings, messages, options = {}) {
  const { onDelta, signal } = options;
  const { type, client, model, settings: normalizedSettings } = createClient(settings);
  const systemPrompt = options.system || TEACHER_SYSTEM;
  const maxTokens = Number(options.maxTokens) > 0 ? Number(options.maxTokens) : 4096;
  const fullMessages = [{ role: 'system', content: systemPrompt }, ...(messages || [])];

  if (type === 'anthropic') {
    const stream = client.messages.stream({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: fullMessages.filter((message) => message.role !== 'system').map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: formatContentForProvider(message.content, 'messages'),
      })),
    });

    let text = '';
    stream.on('text', (piece) => {
      if (!piece) return;
      text += piece;
      if (typeof onDelta === 'function') onDelta(piece);
    });

    if (signal) {
      if (signal.aborted) {
        stream.abort();
      } else {
        signal.addEventListener('abort', () => stream.abort(), { once: true });
      }
    }

    await stream.finalMessage();
    return { success: true, content: text };
  }

  const text = await createOpenAITextResponseStream(client, model, normalizedSettings.apiFormat, {
    instructions: systemPrompt,
    messages: fullMessages.filter((message) => message.role !== 'system'),
    maxOutputTokens: maxTokens,
    signal,
    onDelta,
  });

  return { success: true, content: text };
}

const CATEGORY_NAMES = {
  math: '考研数学', english: '考研英语', politics: '考研政治', major: '专业课',
};

const EXAM_TRACK_NAMES = {
  kaoyan: '考研',
};

const FOCUS_NAMES = {
  standard: '通用组卷',
  idiom: '成语练习',
  current_affairs: '时政热点',
  computer: '计算机基础',
  custom: '自定义方向',
};

const DIFFICULTY_NAMES = {
  1: '入门级（非常简单）', 2: '简单', 3: '中等', 4: '较难', 5: '困难（需要深入思考）',
};

function getTargetCategories(config = {}) {
  const mixed = Array.isArray(config?.mixedCategories) ? config.mixedCategories.filter(Boolean) : [];
  if (config?.mode === 'mixed' && mixed.length) return mixed;
  const single = String(config?.category || '').trim();
  return single ? [single] : ['changshi'];
}

function getTrackLabel(config = {}) {
  if (config?.track === 'self') {
    return String(config?.customTrackName || '').trim() || EXAM_TRACK_NAMES.self;
  }
  return EXAM_TRACK_NAMES[config?.track] || EXAM_TRACK_NAMES.kaoyan;
}

function getFocusLabel(config = {}) {
  if (config?.focus === 'custom') {
    return String(config?.customFocusName || '').trim() || FOCUS_NAMES.custom;
  }
  return FOCUS_NAMES[config?.focus] || FOCUS_NAMES.standard;
}

function getFocusDirective(config = {}) {
  if (config?.focus === 'idiom') {
    return '重点出成语辨析、近义词辨析、词语搭配与语境判断题，优先言语题型。';
  }
  if (config?.focus === 'current_affairs') {
    return '重点结合近年政策热点、科技产业动态和重大会议部署，题干保持客观严谨。';
  }
  if (config?.focus === 'computer') {
    return '重点覆盖计算机基础、操作系统、网络、数据库、数据结构与编程常识。';
  }
  if (config?.focus === 'custom') {
    const custom = String(config?.customFocusName || '').trim();
    return custom ? `重点方向：${custom}` : '';
  }
  return '';
}

function getCurrentAffairsDirective(config = {}) {
  const enabled = Boolean(config?.includeCurrentAffairs) || config?.focus === 'current_affairs';
  if (!enabled) return '';
  const days = Math.max(7, Math.min(180, Number(config?.currentAffairsDays) || 30));
  const keywords = String(config?.currentAffairsKeywords || '').trim();
  return `请优先结合最近 ${days} 天公开时政信息命题${keywords ? `，重点关注：${keywords}` : ''}。若模型无法联网检索，请使用近两年稳定热点并在解析中加“时效提示”。`;
}

function buildGeneratePrompt(config) {
  const targetCategories = getTargetCategories(config);
  const catName = targetCategories.map((key) => CATEGORY_NAMES[key] || key).join('、');
  const diffName = DIFFICULTY_NAMES[config.difficulty] || '中等';
  const count = Math.max(1, Number(config?.count) || 10);
  const trackName = getTrackLabel(config);
  const focusName = getFocusLabel(config);
  const modeText = config?.mode === 'mixed' ? '综合组卷' : '专项组卷';
  const focusDirective = getFocusDirective(config);
  const currentAffairsDirective = getCurrentAffairsDirective(config);
  const analysisMode = config?.analysisMode === 'thinking'
    ? 'analysis 字段使用“解题思路：...；答案依据：...”格式，控制在 120 字内'
    : 'analysis 字段保持简要解析，控制在 60 字内';
  const categoryLimit = config?.mode === 'mixed'
    ? `category 必须从 [${targetCategories.join(', ')}] 中选择`
    : `category 固定为 "${targetCategories[0]}"`;
  const defaultCategory = targetCategories[0] || 'changshi';

  return `你是一位资深的考试命题专家。请根据以下要求生成高质量考试题。

要求：
- 考试类目: ${trackName}
- 训练方向: ${focusName}
- 组卷模式: ${modeText}
- 科目分类: ${catName}
- 难度等级: ${diffName}
- 题目数量: ${count} 道
- 题目类型: 单选题（4个选项）
${focusDirective ? `- 方向约束: ${focusDirective}` : ''}
${currentAffairsDirective ? `- 时政约束: ${currentAffairsDirective}` : ''}
${config.customPrompt ? `- 额外要求: ${config.customPrompt}` : ''}

请严格按以下 JSON 格式输出，不要输出其他内容：
{
  "questions": [
    {
      "content": "题目内容（完整的题干描述）",
      "options": [
        {"key": "A", "content": "选项A"},
        {"key": "B", "content": "选项B"},
        {"key": "C", "content": "选项C"},
        {"key": "D", "content": "选项D"}
      ],
      "answer": "正确答案字母",
      "analysis": "题目解析",
      "difficulty": ${config.difficulty},
      "category": "${defaultCategory}",
      "subCategory": ""
    }
  ]
}

注意：
1. 每道题目必须有完整题干、4个选项、正确答案和解析
2. 题目质量要高，不能有常识性错误
3. 难度要符合要求，不能过简单也不能过难
4. ${analysisMode}
5. ${categoryLimit}
6. 只输出 JSON，不要有其他文字

${TEXTBOOK_FORMAT_GUIDE}`;
}

function getGenerateMaxOutputTokens(config) {
  const count = Math.max(1, Number(config?.count) || 10);
  const perQuestion = (config?.analysisMode === 'thinking' ? 360 : 300) + (config?.includeCurrentAffairs ? 50 : 0);
  return Math.max(1200, Math.min(10000, count * perQuestion));
}

function normalizeGeneratedOptions(question) {
  const raw = question?.options;
  if (Array.isArray(raw)) {
    const list = raw
      .filter((item) => item && typeof item === 'object')
      .map((item, index) => ({
        key: String(item.key || String.fromCharCode(65 + index)).toUpperCase(),
        content: String(item.content || '').trim(),
      }))
      .filter((item) => item.content);
    if (list.length >= 2) return list.slice(0, 6);
  }

  const fallbackKeys = ['A', 'B', 'C', 'D', 'E', 'F'];
  const fallback = fallbackKeys
    .map((key) => {
      const direct = question?.[key] ?? question?.[`option${key}`] ?? question?.[`option_${key.toLowerCase()}`];
      return { key, content: String(direct || '').trim() };
    })
    .filter((item) => item.content);
  return fallback;
}

function normalizeGeneratedQuestions(rawQuestions, config) {
  const list = Array.isArray(rawQuestions) ? rawQuestions : [];
  const targetCategories = getTargetCategories(config);
  return list.map((question, index) => {
    const content = String(question?.content || '').trim();
    const options = normalizeGeneratedOptions(question);
    const answer = String(question?.answer || '').trim().toUpperCase();
    if (!content || options.length < 2) return null;
    const fallbackCategory = targetCategories[index % Math.max(targetCategories.length, 1)] || 'changshi';
    let category = String(question?.category || '').trim();
    if (!category) {
      category = fallbackCategory;
    } else if (config?.mode === 'mixed' && targetCategories.length && !targetCategories.includes(category)) {
      category = fallbackCategory;
    }
    return {
      // 出卷只产单选题；显式带上 type，格式层才会按客观题规则规范答案字母
      type: 'single',
      content,
      options,
      answer,
      analysis: String(question?.analysis || '').trim(),
      difficulty: Math.max(1, Math.min(5, Number(question?.difficulty) || Number(config?.difficulty) || 3)),
      category,
      subCategory: String(question?.subCategory || question?.sub_category || '').trim(),
    };
  }).filter(Boolean);
}

async function createOpenAIGenerateText(client, model, normalizedSettings, prompt, maxOutputTokens) {
  const startedAt = Date.now();
  // 对 responses 模式优先走 chat.completions，很多兼容网关该路径更快
  if (normalizedSettings.apiFormat === 'responses') {
    let fastError = null;
    try {
      const fastStartedAt = Date.now();
      const completion = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxOutputTokens,
      });
      const content = completion.choices?.[0]?.message?.content;
      if (typeof content === 'string' && content.trim()) {
        return {
          text: content,
          route: 'chat_completions_fast',
          routeElapsedMs: Date.now() - fastStartedAt,
          elapsedMs: Date.now() - startedAt,
        };
      }
      if (Array.isArray(content)) {
        const text = content
          .map((item) => normalizeStringContent(item))
          .filter(Boolean)
          .join('\n');
        if (text.trim()) {
          return {
            text,
            route: 'chat_completions_fast',
            routeElapsedMs: Date.now() - fastStartedAt,
            elapsedMs: Date.now() - startedAt,
          };
        }
      }
      fastError = new Error('chat_completions_fast 返回为空');
    } catch (error) {
      fastError = error;
    }

    const fallbackStartedAt = Date.now();
    const text = await createOpenAITextResponse(client, model, normalizedSettings.apiFormat, {
      messages: [{ role: 'user', content: prompt }],
      maxOutputTokens,
    });
    return {
      text,
      route: 'responses_fallback',
      routeElapsedMs: Date.now() - fallbackStartedAt,
      elapsedMs: Date.now() - startedAt,
      fastError: compactError(fastError),
    };
  }

  const genericStartedAt = Date.now();
  const text = await createOpenAITextResponse(client, model, normalizedSettings.apiFormat, {
    messages: [{ role: 'user', content: prompt }],
    maxOutputTokens,
  });
  return {
    text,
    route: normalizedSettings.apiFormat || 'chat_completions',
    routeElapsedMs: Date.now() - genericStartedAt,
    elapsedMs: Date.now() - startedAt,
  };
}

function compactError(error) {
  if (!error) return '';
  const msg = String(error.message || error || '').trim();
  return msg || '未知错误';
}

function toSafeApiHost(apiBase) {
  const value = String(apiBase || '').trim();
  if (!value) return '';
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}`;
  } catch (error) {
    return value;
  }
}

async function generatePaper(settings, config) {
  // 出卷要一次吐完整份 JSON，思维链会和正文抢输出预算，同样关闭思考模式
  const { type, client, model, settings: normalizedSettings } = createClient(structuredSettings(settings));
  const prompt = buildGeneratePrompt(config);
  const maxOutputTokens = getGenerateMaxOutputTokens(config);
  const requestId = `gen_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const startedAt = Date.now();

  console.info(`[AI][Generate][${requestId}] start`, {
    provider: normalizedSettings.aiProvider || '',
    model,
    apiFormat: normalizedSettings.apiFormat || '',
    apiBase: toSafeApiHost(normalizedSettings.apiBase),
    track: config?.track,
    focus: config?.focus,
    mode: config?.mode,
    category: config?.category,
    mixedCategories: Array.isArray(config?.mixedCategories) ? config.mixedCategories.join(',') : '',
    difficulty: config?.difficulty,
    count: config?.count,
    maxOutputTokens,
  });

  try {
    let resultText = '';

    if (type === 'anthropic') {
      const routeStartedAt = Date.now();
      const response = await client.messages.create({
        model,
        max_tokens: maxOutputTokens,
        messages: [{ role: 'user', content: prompt }],
      });
      resultText = extractClaudeText(response);
      console.info(`[AI][Generate][${requestId}] route`, {
        route: 'anthropic_messages',
        routeElapsedMs: Date.now() - routeStartedAt,
      });
    } else {
      const routeResult = await createOpenAIGenerateText(client, model, normalizedSettings, prompt, maxOutputTokens);
      resultText = routeResult.text;
      console.info(`[AI][Generate][${requestId}] route`, {
        route: routeResult.route,
        routeElapsedMs: routeResult.routeElapsedMs,
        fastError: routeResult.fastError || '',
      });
    }

    console.info(`[AI][Generate][${requestId}] model_response`, {
      elapsedMs: Date.now() - startedAt,
      textLength: String(resultText || '').length,
    });

    const parsed = extractJSONObject(resultText);
    const questions = formatQuestions(normalizeGeneratedQuestions(parsed.questions, config));
    if (!questions.length) {
      throw new Error('题目格式不完整：缺少有效选项');
    }
    console.info(`[AI][Generate][${requestId}] success`, {
      elapsedMs: Date.now() - startedAt,
      questions: questions.length,
    });
    return { success: true, questions, debugId: requestId };
  } catch (error) {
    const rawPreview = typeof error?.raw === 'string'
      ? error.raw.slice(0, 400)
      : '';
    console.error(`[AI][Generate][${requestId}] failed`, {
      elapsedMs: Date.now() - startedAt,
      error: compactError(error),
      stack: String(error?.stack || '').split('\n').slice(0, 3).join(' | '),
      rawPreview,
    });
    return { success: false, error: compactError(error) || '出卷失败', questions: [], debugId: requestId };
  }
}

async function testConnection(settings) {
  try {
    const { type, client, model, settings: normalizedSettings } = createClient(settings);
    let kind;
    let response;

    if (type === 'anthropic') {
      kind = 'messages';
      response = await client.messages.create({
        model,
        max_tokens: 32,
        messages: [{ role: 'user', content: 'Hi' }],
      });
    } else if (normalizedSettings.apiFormat === 'responses') {
      kind = 'responses';
      response = await client.responses.create({
        model,
        input: 'Hi',
        max_output_tokens: 32,
      });
    } else {
      kind = 'chat_completions';
      response = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 32,
      });
    }

    // 不能只判断「调用没抛错」：HTTP 200 的后台 HTML 同样不会抛错
    assertApiResponse(response, kind, normalizedSettings);

    if (kind === 'chat_completions' && Array.isArray(response.choices) && !response.choices.length) {
      throw new Error('AI 接口返回了空的 choices 数组：请确认模型名、API Key 分组和可用通道');
    }
    if (kind === 'responses' && Array.isArray(response.output) && !response.output.length
      && !String(response.output_text || '').trim()) {
      throw new Error('AI 接口返回了空的 output 数组：请确认模型名、API Key 分组和可用通道');
    }
    if (kind === 'messages' && Array.isArray(response.content) && !response.content.length) {
      throw new Error('AI 接口返回了空的 content 数组：请确认模型名、API Key 分组和可用通道');
    }

    return {
      success: true,
      model,
      apiFormat: normalizedSettings.apiFormat || kind,
      apiBase: toSafeApiHost(normalizedSettings.apiBase),
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/* ==================================================================
   专业课主观题批改
   ================================================================== */

const ESSAY_GRADER_SYSTEM = `你是一位经验丰富的考研专业课主观题阅卷老师。你的任务是按评分标准客观批改考生答案，不是鼓励，也不是教学。
批改必须做到：
1. 逐条对照采分点，明确指出考生写到了哪些、漏了哪些
2. 漏点要说清楚"材料里在哪、为什么该写、为什么考生会漏"
3. 打分严格按要点覆盖为主，语言表述为辅，不放水
4. 只输出 JSON，不要任何解释性文字、不要代码块标记`;

const ESSAY_TYPE_LABEL = {
  guina: '归纳概括',
  duice: '提出对策',
  fenxi: '综合分析',
  guanche: '贯彻执行',
  dazuowen: '大作文',
};

function buildEssayGradePrompt(payload = {}) {
  const {
    essayType = 'guina',
    material = '',
    requirement = '',
    wordLimit,
    referenceAnswer = '',
    scoringPoints = [],
    answer = '',
  } = payload;

  const typeLabel = ESSAY_TYPE_LABEL[essayType] || '归纳概括';
  const limitText = wordLimit ? `${wordLimit} 字以内` : '未限制字数';

  const reference = referenceAnswer
    ? `\n【参考答案】\n${referenceAnswer}\n`
    : '';
  const points = Array.isArray(scoringPoints) && scoringPoints.length
    ? `\n【已知采分点】\n${scoringPoints.map((p, i) => `${i + 1}. ${typeof p === 'string' ? p : p.text || ''}`).join('\n')}\n`
    : '\n【采分点】未提供，请你先从材料中自行提炼应得的采分点，再据此批改。\n';

  return `请批改下面这道考研专业课主观题「${typeLabel}」题。

【给定材料】
${material}

【题目要求】
${requirement}
字数要求：${limitText}
${points}${reference}
【考生答案】
${answer}

按下面的 JSON 结构输出批改结果：
{
  "score": 得分数字,
  "maxScore": 满分数字,
  "wordCount": 考生答案字数,
  "dimensions": [
    {"name":"要点覆盖","score":数字,"max":数字,"comment":"一句话点评"},
    {"name":"概括层次","score":数字,"max":数字,"comment":"..."},
    {"name":"语言规范","score":数字,"max":数字,"comment":"..."},
    {"name":"字数控制","score":数字,"max":数字,"comment":"..."}
  ],
  "points": [
    {"text":"采分点内容","hit":true或false,"evidence":"材料出处或考生原文","why":"漏掉时说明为什么该写、为什么容易漏"}
  ],
  "summary": "整体评价，两三句话",
  "improvements": ["下次要注意的具体动作，两到四条"]
}

要点覆盖占分最重。points 数组要把所有采分点都列出来，命中的 hit 为 true。`;
}

async function callModelForJSON(settings, system, prompt, maxOutputTokens = 4096) {
  const { type, client, model, settings: normalized } = createClient(structuredSettings(settings));
  if (type === 'anthropic') {
    const response = await client.messages.create({
      model,
      max_tokens: maxOutputTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
    });
    return extractClaudeText(response);
  }
  return createOpenAITextResponse(client, model, normalized.apiFormat, {
    instructions: system,
    messages: [{ role: 'user', content: prompt }],
    maxOutputTokens,
  });
}

async function gradeEssay(settings, payload) {
  try {
    const text = await callModelForJSON(
      settings,
      ESSAY_GRADER_SYSTEM,
      buildEssayGradePrompt(payload),
      4096
    );
    const parsed = extractJSONObject(text);
    if (!parsed) {
      return { success: false, error: '模型没有返回可解析的批改结果，请重试' };
    }
    return { success: true, review: parsed };
  } catch (error) {
    return { success: false, error: compactError(error) };
  }
}

/** 缺答案题目让 AI 先给参考答案：只依据题干与选项作答，不编造出处 */
const SOLVE_ANSWER_SYSTEM = `你是试题作答助手。用户会给你一道题（可能来自教材或资料，也可能只有题干）。
只根据题目本身作答，不要引用题目里没有出现的教材页码、章节或原文。

输出要求：
- 只输出一个 JSON 对象，不要 Markdown 代码块或额外解释。
- 客观题（single / multiple / judge）：answer 只写选项字母，如 "A"、"AB"；判断题用 "A" 表示正确、"B" 表示错误。
- 填空 / 主观题：answer 写参考答案，analysis 写解题步骤与评分要点。
- 没有把握时不要硬编：在 analysis 里说明哪一步不确定，answer 给出最可能的答案。

格式：{"answer":"参考答案","analysis":"简要解析"}`;

function formatSolveOptions(options) {
  const list = Array.isArray(options) ? options : [];
  return list.map((option, index) => {
    const fallbackKey = String.fromCharCode(65 + (index % 26));
    if (typeof option === 'string') return `${fallbackKey}. ${option}`;
    const key = String(option?.key || fallbackKey).toUpperCase();
    return `${key}. ${String(option?.content || '')}`;
  }).filter((line) => line.replace(/^[A-H]\.\s*/, '').trim()).join('\n');
}

function buildSolveAnswerPrompt(question = {}) {
  const type = String(question.type || 'single').toLowerCase();
  const typeLabel = {
    single: '单选', multiple: '多选', judge: '判断', fill: '填空', subjective: '主观',
  }[type] || type;
  const content = String(question.content || question.contentHtml || question.content_html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .trim();
  const material = String(question.material || question.material_html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .trim()
    .slice(0, 1200);
  const options = formatSolveOptions(question.options);
  return [
    `题型：${typeLabel}`,
    material ? `材料：\n${material}` : '',
    `题干：\n${content}`,
    options ? `选项：\n${options}` : '',
  ].filter(Boolean).join('\n\n');
}

async function solveQuestionAnswer(settings, payload = {}) {
  try {
    if (!String(settings?.apiKey || '').trim()) {
      return { success: false, error: '还没配置 AI 模型，请先到「设置 → AI 模型」完成配置' };
    }
    const question = payload || {};
    const content = String(question.content || question.contentHtml || question.content_html || '')
      .replace(/<[^>]+>/g, ' ')
      .trim();
    if (!content) return { success: false, error: '题目内容为空，无法生成答案' };

    const result = await complete(structuredSettings(settings), {
      system: SOLVE_ANSWER_SYSTEM,
      messages: [{ role: 'user', content: buildSolveAnswerPrompt(question) }],
      maxTokens: 2048,
    });
    if (!result?.success) return { success: false, error: result?.error || 'AI 生成答案失败' };

    const parsed = extractJSONObject(result.content, ['answer']);
    const answer = String(parsed?.answer || '').trim();
    if (!answer) {
      return {
        success: false,
        error: result.truncated ? '模型输出被截断，请重试' : '模型没有返回可解析的答案，请重试',
      };
    }
    return {
      success: true,
      answer,
      analysis: String(parsed?.analysis || '').trim(),
      truncated: Boolean(result.truncated),
    };
  } catch (error) {
    return { success: false, error: compactError(error) };
  }
}

const ESSAY_OCR_SYSTEM = `你是考研专业课主观题录入助手。从图片里原样提取材料和题目，不要改写、不要总结、不要补充。只输出 JSON。`;

/** 从图片里提取专业课主观题：材料 / 题干 / 要求 / 字数 */
async function recognizeEssay(settings, imageBase64, mimeType = 'image/png') {
  const prompt = `识别这张图片里的考研专业课主观题，按下面的 JSON 输出：
{
  "title": "题目标题，没有就用题干前 20 字",
  "essayType": "guina|duice|fenxi|guanche|dazuowen 之一",
  "material": "给定材料全文，保留段落编号和换行",
  "requirement": "作答要求原文",
  "wordLimit": 字数上限数字，没有则 null,
  "province": "省份，认不出填 null",
  "year": 年份数字，认不出填 null
}
材料要一字不漏地抄下来，这是批改的依据。`;

  try {
    assertVisionModel(normalizeAISettings(settings), '主观题图片识别');
    const { type, client, model, settings: normalized } = createClient(structuredSettings(settings));
    let text = '';
    if (type === 'anthropic') {
      const response = await client.messages.create({
        model,
        max_tokens: 8192,
        system: ESSAY_OCR_SYSTEM,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
            { type: 'text', text: prompt },
          ],
        }],
      });
      text = extractClaudeText(response);
    } else {
      const response = await client.chat.completions.create({
        model,
        max_tokens: 8192,
        messages: [
          { role: 'system', content: ESSAY_OCR_SYSTEM },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
              { type: 'text', text: prompt },
            ],
          },
        ],
      });
      text = extractResponseText(response);
      void normalized;
    }

    ensureModelText(text, '（专业课主观题识图）');
    const parsed = extractJSONObject(text);
    if (!parsed) return { success: false, error: '没能从图片里识别出专业课主观题，换一张更清晰的试试' };
    return { success: true, prompt: parsed };
  } catch (error) {
    return { success: false, error: compactError(error) };
  }
}

/* ==================================================================
   主观题手写答案：上传照片 → 识别 + 对照采分点批改
   主观题不再要求用户在界面里输入文字，只有想批改时才拍照上传。
   ================================================================== */

const HANDWRITTEN_GRADE_SYSTEM = `你是考研主观题阅卷助手。用户会上传一张手写答案的照片。
第一步：尽量逐字识别照片里的手写内容，不改写、不替考生补充，看不清的地方标注 [?]。
第二步：对照题目、参考答案与解析逐点批改，明确指出命中和遗漏的采分点。
只输出 JSON，不要任何解释性文字、不要代码块标记。`;

function buildHandwrittenGradePrompt(payload = {}) {
  const {
    content = '', options = [], answer = '', analysis = '', material = '',
  } = payload || {};
  const optionText = Array.isArray(options) && options.length
    ? options.map((opt) => `${opt?.key || ''}. ${opt?.content || ''}`).join('\n')
    : '';
  return `请批改这张手写答案照片。

【题目】
${String(content || '').slice(0, 3000)}
${optionText ? `\n【选项】\n${optionText}\n` : ''}${String(material || '').trim() ? `\n【材料】\n${String(material).slice(0, 3000)}\n` : ''}
【参考答案 / 评分要点】
${String(answer || '').trim() || '（题库未提供参考答案，请你先自行提炼合理采分点再批改）'}

【题库解析】
${String(analysis || '').trim() || '（无）'}

按下面的 JSON 结构输出，只输出 JSON：
{
  "recognizedAnswer": "照片里识别出的手写答案原文，识别不清处用 [?] 标注",
  "score": 得分数字,
  "maxScore": 满分数字（题目没给分值时按 10 分）,
  "points": [
    {"text": "采分点内容", "hit": true 或 false, "comment": "命中或漏掉的原因"}
  ],
  "summary": "整体评价，两三句话",
  "improvements": ["下次要注意的具体动作，两到四条"]
}

要点覆盖占分最重，points 要列出全部采分点。照片完全无法辨认时，recognizedAnswer 写空字符串，并在 summary 里说明需要重拍。`;
}

async function gradeHandwrittenAnswer(settings, payload = {}, imageBase64, mimeType = 'image/png') {
  const base64 = String(imageBase64 || '').trim();
  if (!base64) return { success: false, error: '没有读到图片内容，请重新选择一张手写答案照片' };
  const normalizedMime = /^image\//.test(String(mimeType || '')) ? mimeType : 'image/png';
  const prompt = buildHandwrittenGradePrompt(payload);

  try {
    assertVisionModel(normalizeAISettings(settings), '手写答案批改');
    const { type, client, model } = createClient(structuredSettings(settings));
    let text = '';
    if (type === 'anthropic') {
      const response = await client.messages.create({
        model,
        max_tokens: 8192,
        system: HANDWRITTEN_GRADE_SYSTEM,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: normalizedMime, data: base64 } },
            { type: 'text', text: prompt },
          ],
        }],
      });
      text = extractClaudeText(response);
    } else {
      // 手写答案照片走视觉聊天接口；OpenAI 兼容网关（含 DeepSeek 类配置）普遍支持该形式
      const response = await client.chat.completions.create({
        model,
        max_tokens: 8192,
        messages: [
          { role: 'system', content: HANDWRITTEN_GRADE_SYSTEM },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:${normalizedMime};base64,${base64}` } },
              { type: 'text', text: prompt },
            ],
          },
        ],
      });
      text = extractResponseText(response);
    }
    ensureModelText(text, '（手写答案批改）');
    const review = extractJSONObject(text, ['recognizedAnswer', 'points', 'score']);
    return { success: true, review };
  } catch (error) {
    return { success: false, error: compactError(error) };
  }
}

/**
 * 通用补全：不注入「AI 导师」人设。
 * 笔记整理这类结构化任务需要自己的 system prompt，复用 chat() 会被人设带偏。
 */
async function complete(settings, { system = '', messages = [], maxTokens = 4096, signal, fast = false } = {}) {
  try {
    // fast：长文整理类任务（知识清单等）关掉思维链，把输出预算全部留给正文
    const { type, client, model, settings: normalizedSettings } = createClient(fast ? withoutThinking(settings) : settings);
    const chatMessages = (messages || []).filter((message) => message.role !== 'system');

    if (type === 'anthropic') {
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: system || undefined,
        messages: chatMessages.map((message) => ({
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: formatContentForProvider(message.content, 'messages'),
        })),
      }, signal ? { signal } : undefined);
      const finishReason = extractFinishReason(response, 'anthropic');
      return {
        success: true,
        content: extractClaudeText(response),
        finishReason,
        truncated: isTruncatedFinish(finishReason),
      };
    }

    const detailed = await createOpenAITextResponseDetailed(client, model, normalizedSettings.apiFormat, {
      instructions: system,
      messages: chatMessages,
      maxOutputTokens: maxTokens,
      signal,
    });
    return {
      success: true,
      content: detailed.text,
      finishReason: detailed.finishReason,
      truncated: isTruncatedFinish(detailed.finishReason),
    };
  } catch (error) {
    return { success: false, error: compactError(error) };
  }
}

module.exports = {
  AI_ROLE_IDS,
  resolveRoleSettings,
  resolveMaxOutputTokens,
  extractFinishReason,
  isTruncatedFinish,
  isVisionCapableSettings,
  assertVisionModel,
  formatContentForProvider,
  recognizeQuestions,
  recognizeAnswers,
  transcribePage,
  transcribePageWithFigures,
  structureQuestionsFromText,
  structureAnswersFromText,
  parseAIJson: extractJSONObject,
  matchQuestionAnswers,
  classifyQuestions,
  gradeEssay,
  solveQuestionAnswer,
  recognizeEssay,
  gradeHandwrittenAnswer,
  testConnection,
  chat,
  chatStream,
  complete,
  generatePaper,
};
