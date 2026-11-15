const OPENAI_FORMATS = ['responses', 'chat_completions'];

export const AI_PROVIDERS = [
  { id: 'openai', name: 'OpenAI', icon: 'openai', sdkType: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.3-chat-latest', 'gpt-5.2', 'gpt-5.2-mini', 'gpt-5', 'gpt-5-mini', 'gpt-5-codex', 'gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.1-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini', 'codex-mini-latest', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'], supportsVision: true, supportedFormats: OPENAI_FORMATS, defaultFormat: 'responses' },
  { id: 'minimax', name: 'MiniMax', icon: 'minimax', sdkType: 'openai', baseUrl: 'https://api.minimax.chat/v1', models: ['MiniMax-M1', 'MiniMax-Text-01', 'abab-6.5s-chat'], supportsVision: true, supportedFormats: ['chat_completions'], defaultFormat: 'chat_completions' },
  { id: 'kimi', name: 'Kimi', icon: 'kimi', sdkType: 'openai', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-128k', 'moonshot-v1-32k', 'kimi-k2-0711-preview'], supportsVision: true, supportedFormats: ['chat_completions'], defaultFormat: 'chat_completions' },
  { id: 'glm', name: '智谱 GLM', icon: 'glm', sdkType: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4.5', 'glm-4.5-air', 'glm-4v', 'glm-4'], supportsVision: true, supportedFormats: ['chat_completions'], defaultFormat: 'chat_completions' },
  { id: 'deepseek', name: 'DeepSeek', icon: 'deepseek', sdkType: 'openai', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-flash', 'deepseek-v4-pro'], supportsVision: true, visionModels: ['deepseek-flash'], supportedFormats: ['chat_completions'], defaultFormat: 'chat_completions' },
  { id: 'doubao', name: '豆包', icon: 'doubao', sdkType: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-1-5-vision-pro-32k', 'doubao-1-5-pro-32k'], supportsVision: true, supportedFormats: ['chat_completions'], defaultFormat: 'chat_completions' },
  { id: 'qwen', name: '通义千问', icon: 'qwen', sdkType: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-vl-max', 'qwen-vl-plus', 'qwen-turbo'], supportsVision: true, supportedFormats: ['chat_completions'], defaultFormat: 'chat_completions' },
  { id: 'custom', name: 'OpenAI 兼容', icon: 'custom', sdkType: 'openai', baseUrl: '', models: [], supportsVision: true, supportedFormats: OPENAI_FORMATS, defaultFormat: 'chat_completions' },
  { id: 'anthropic', name: 'Claude', icon: 'claude', sdkType: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', models: ['claude-sonnet-4-20250514', 'claude-3-5-sonnet-20241022'], supportsVision: true, supportedFormats: ['messages'], defaultFormat: 'messages' },
];

/**
 * 三类 AI 角色：识图 / 助教 / 老师。
 * 每个角色可以「跟随通用配置」，也可以单独指定服务商与模型，
 * 例如识图用 deepseek-flash（便宜、能读图），老师用更强的推理模型。
 */
export const AI_ROLES = [
  {
    id: 'vision',
    name: '识图',
    tagline: '图片 / PDF → 结构化题目',
    description: '把拍照、截图、扫描 PDF 转成题目和答案。必须是能读图的模型，否则识别会失败或编造内容。',
    features: ['拍照 / 截图识题', 'PDF 逐页识别', '答案页识别', '题号与答案匹配'],
    needVision: true,
  },
  {
    id: 'assistant',
    name: '助教',
    tagline: '题型分类 · 笔记整理 · 任务安排',
    description: '负责题型与知识点分类、笔记整理、学情诊断和每日任务安排。纯文本模型即可胜任。',
    features: ['题型 / 知识点分类', '笔记整理', '学情诊断与 7 天计划'],
    needVision: false,
  },
  {
    id: 'teacher',
    name: '老师',
    tagline: '讲解题目 · 批改主观题',
    description: '负责讲题、答疑和主观题批改。批改手写照片需要能读图；不能读图时会自动借用「识图」模型。',
    features: ['AI 讲题 / 答疑', '主观题批改', '综合组卷'],
    needVision: false,
  },
];

export const AI_ROLE_IDS = AI_ROLES.map((role) => role.id);

const DEFAULT_ROLE_CONFIG = {
  mode: 'shared',
  aiProvider: 'custom',
  apiKey: '',
  apiBase: '',
  model: '',
  customModel: '',
  apiFormat: 'chat_completions',
};

export const DEFAULT_AI_SETTINGS = {
  aiProvider: 'custom',
  apiKey: '',
  apiBase: '',
  model: '',
  customModel: '',
  apiFormat: 'chat_completions',
  aiRoles: AI_ROLE_IDS.reduce((result, id) => ({ ...result, [id]: { ...DEFAULT_ROLE_CONFIG } }), {}),
  recognizeEngine: 'auto',
  pdfMaxPages: 6,
  ocrEnabled: false,
  ocrProvider: 'custom',
  ocrApiUrl: '',
  ocrApiKey: '',
  ocrResponseMode: 'json_questions',
};

export function getAIProvider(providerId) {
  return AI_PROVIDERS.find((provider) => provider.id === providerId) || null;
}

/**
 * 「服务商支持视觉」不等于「任意模型都能识图」。
 * 这里列出明确不能读图的模型，用于给出准确提示而不是让用户撞 400。
 * DeepSeek：只有 deepseek-flash 支持图像理解，deepseek-v4-pro 与旧的
 * deepseek-chat / deepseek-reasoner 都是纯文本。
 */
const TEXT_ONLY_MODELS = new Set([
  'deepseek-v4-pro',
  'deepseek-chat',
  'deepseek-reasoner',
  'deepseek-v4-flash',
  'qwen-turbo',
  'moonshot-v1-128k',
  'moonshot-v1-32k',
]);

/**
 * DeepSeek 官方已把模型收敛为 deepseek-flash / deepseek-v4-pro，
 * 旧名字虽然还能调用，但不再提供视觉能力，这里做一次性迁移。
 */
const LEGACY_MODEL_ALIASES = {
  deepseek: {
    'deepseek-chat': 'deepseek-flash',
    'deepseek-reasoner': 'deepseek-flash',
    'deepseek-v4-flash': 'deepseek-flash',
    'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  },
};

export function isVisionCapable(input) {
  const settings = input && typeof input === 'object' ? input : getAISettings();
  const provider = getAIProvider(settings?.aiProvider);
  if (!provider || provider.supportsVision === false) return false;
  const model = String(settings?.customModel || settings?.model || '').trim().toLowerCase();
  if (!model) return Boolean(provider.supportsVision);
  if (Array.isArray(provider.visionModels) && provider.visionModels.length) {
    return provider.visionModels.includes(model);
  }
  return !TEXT_ONLY_MODELS.has(model);
}

function upgradeLegacyModel(providerId, model) {
  const aliasMap = LEGACY_MODEL_ALIASES[providerId];
  if (aliasMap && aliasMap[model]) return { model: aliasMap[model], upgraded: true };
  return { model, upgraded: false };
}

/**
 * 单个角色的配置归一化。
 * 注意不能直接复用 normalizeAISettings：角色配置不含 recognizeEngine 等全局项，
 * 套用默认值会把整份默认配置塞进角色里，存库后越来越臃肿。
 */
function normalizeRoleConfig(input, fallbackProvider = 'custom') {
  const raw = input && typeof input === 'object' ? input : {};
  const aiProvider = String(raw.aiProvider || fallbackProvider || 'custom');
  const provider = getAIProvider(aiProvider);
  const customModel = String(raw.customModel || '').trim();
  const rawModel = customModel || String(raw.model || '').trim();
  const upgraded = upgradeLegacyModel(aiProvider, rawModel);
  const model = upgraded.model || provider?.models?.[0] || '';
  const supportedFormats = provider?.supportedFormats || ['chat_completions'];

  return {
    mode: raw.mode === 'custom' ? 'custom' : 'shared',
    aiProvider,
    apiKey: String(raw.apiKey || '').trim(),
    apiBase: String(raw.apiBase || '').trim(),
    model,
    customModel: upgraded.upgraded ? '' : customModel,
    apiFormat: supportedFormats.includes(raw.apiFormat)
      ? raw.apiFormat
      : (provider?.defaultFormat || supportedFormats[0] || 'chat_completions'),
  };
}

export function normalizeAISettings(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const settings = { ...DEFAULT_AI_SETTINGS, ...raw };
  const provider = getAIProvider(settings.aiProvider);

  if (provider?.baseUrl && !String(settings.apiBase || '').trim()) {
    settings.apiBase = provider.baseUrl;
  }

  const preferredModel = String(settings.customModel || '').trim() || String(settings.model || '').trim();
  settings.model = preferredModel || provider?.models?.[0] || '';

  // 旧模型名（如 deepseek-chat）自动升级到当前可用的等价模型，避免配置停留在已下线的纯文本模型上
  const aliasMap = LEGACY_MODEL_ALIASES[settings.aiProvider];
  if (aliasMap && aliasMap[settings.model]) {
    settings.model = aliasMap[settings.model];
    settings.customModel = '';
  }

  const allowedFormats = provider?.supportedFormats || ['chat_completions'];
  settings.apiFormat = allowedFormats.includes(settings.apiFormat)
    ? settings.apiFormat
    : (provider?.defaultFormat || allowedFormats[0] || 'chat_completions');

  // 三类角色的配置：旧版本没有 aiRoles，这里补成「全部跟随通用配置」，行为与升级前一致
  const rawRoles = raw.aiRoles && typeof raw.aiRoles === 'object' ? raw.aiRoles : {};
  settings.aiRoles = AI_ROLE_IDS.reduce((result, id) => {
    result[id] = normalizeRoleConfig(rawRoles[id], settings.aiProvider);
    return result;
  }, {});

  settings.recognizeEngine = ['auto', 'ai', 'ocr'].includes(settings.recognizeEngine)
    ? settings.recognizeEngine
    : 'auto';
  settings.pdfMaxPages = Math.max(1, Math.min(20, Number(settings.pdfMaxPages) || 6));
  settings.ocrEnabled = Boolean(settings.ocrEnabled && String(settings.ocrApiUrl || '').trim());
  settings.ocrProvider = settings.ocrProvider || 'custom';
  settings.ocrApiUrl = String(settings.ocrApiUrl || '').trim();
  settings.ocrApiKey = String(settings.ocrApiKey || '').trim();
  settings.ocrResponseMode = ['json_questions', 'text'].includes(settings.ocrResponseMode)
    ? settings.ocrResponseMode
    : 'json_questions';

  return settings;
}

/**
 * 获取 AI 配置
 * 从 localStorage 读取设置页保存的配置
 */
export function getAISettings() {
  try {
    const saved = localStorage.getItem('openexam_settings');
    if (saved) return normalizeAISettings(JSON.parse(saved));
  } catch (e) {}
  return normalizeAISettings(null);
}

/**
 * 检查 AI 是否已配置
 */
export function isAIConfigured() {
  const s = getAISettings();
  return !!(s && s.aiProvider && s.apiKey && s.model);
}

export function isOCRConfigured() {
  const s = getAISettings();
  return Boolean(s.ocrEnabled && s.ocrApiUrl);
}

export function getRoleMeta(roleId) {
  return AI_ROLES.find((role) => role.id === roleId) || null;
}

/**
 * 取出某个角色实际生效的配置（扁平结构，可直接交给主进程的识别 / 对话函数）。
 * 角色设为「跟随通用配置」时直接返回通用配置；单独配置时只覆盖服务商相关字段，
 * 识别引擎、PDF 页数这类全局项仍然沿用通用配置。
 */
export function getRoleSettings(roleId, input) {
  const settings = input && typeof input === 'object' ? normalizeAISettings(input) : getAISettings();
  if (!AI_ROLE_IDS.includes(roleId)) return settings;

  const roleConfig = settings.aiRoles?.[roleId];
  if (!roleConfig || roleConfig.mode !== 'custom') return settings;

  return normalizeAISettings({
    ...settings,
    aiProvider: roleConfig.aiProvider || settings.aiProvider,
    apiKey: roleConfig.apiKey || settings.apiKey,
    apiBase: roleConfig.apiBase || '',
    model: roleConfig.model || '',
    customModel: roleConfig.customModel || '',
    apiFormat: roleConfig.apiFormat || settings.apiFormat,
  });
}

export function isRoleConfigured(roleId) {
  const settings = getRoleSettings(roleId);
  return Boolean(settings?.aiProvider && settings?.model && settings?.apiKey);
}

/**
 * 左侧「AI 助教」面板是否可用。
 * 助教角色没配也没关系：用户发图时主进程会自动改用「识图」模型，
 * 所以只要有一个角色配好就能用。
 */
export function isAssistantConfigured() {
  return isRoleConfigured('assistant') || isRoleConfigured('vision');
}

/**
 * 主观题手写批改要读图：优先用「老师」，老师模型不能读图时自动退到「识图」模型。
 * 返回的 fallback=true 时，界面上要说明这一跳转，避免用户以为配置没生效。
 */
export function getGradingSettings() {
  const teacher = getRoleSettings('teacher');
  if (isVisionCapable(teacher)) return { settings: teacher, role: 'teacher', fallback: false };

  const vision = getRoleSettings('vision');
  if (vision?.apiKey && isVisionCapable(vision)) {
    return { settings: vision, role: 'vision', fallback: true };
  }

  return { settings: teacher, role: 'teacher', fallback: false };
}
