'use strict';
/**
 * 学科分析插件：扫描 / 校验 / 启停 / 导入 / 编排。
 *
 * 边界（与产品需求一致）：
 *   - 模型只负责「题目 → 结构化中间结果」（extract）和「结果 → 讲解」（explain）；
 *   - 所有数值由各 engine 的纯函数计算，插件与模型都不能改数；
 *   - 第三方插件只能是声明式清单（无代码执行），引擎只来自应用白名单；
 *   - 插件运行只读本次输入，不读题库 / 笔记 / 其它科目数据。
 */

const fs = require('fs');
const path = require('path');
const {
  validateManifest,
  describeInputs,
  describeOutputs,
  describeCapabilities,
  ENGINE_IDS,
} = require('./manifest.js');

const ENGINES = {
  circuit: require('./engines/circuit.js'),
  'one-line': require('./engines/oneLine.js'),
  phasor: require('./engines/phasor.js'),
};

const STATE_KEY = 'analysis_plugins';
const MAX_IMPORT_BYTES = 256 * 1024;
const MANIFEST_FILE = 'plugin.json';

let ctx = { database: null, app: null, userDataRoot: '', builtinRoot: '' };

function attach({ database, app } = {}) {
  if (database) ctx.database = database;
  if (app) ctx.app = app;
}

/** 测试 / 离线脚本用：显式指定目录，不依赖 electron */
function initForTest({ database = null, userDataRoot = '', builtinRoot = '' } = {}) {
  ctx = {
    ...ctx,
    database: database || ctx.database,
    userDataRoot: userDataRoot || ctx.userDataRoot,
    builtinRoot: builtinRoot || ctx.builtinRoot,
  };
}

function builtinRoot() {
  if (ctx.builtinRoot) return ctx.builtinRoot;
  if (process.env.OPENEXAM_PLUGINS_ROOT) return process.env.OPENEXAM_PLUGINS_ROOT;
  return path.join(__dirname, '..', '..', '..', 'plugins');
}

function userRoot() {
  if (ctx.userDataRoot) return ctx.userDataRoot;
  if (ctx.app) {
    try {
      return path.join(ctx.app.getPath('userData'), 'plugins');
    } catch {
      /* 回落临时目录，保证纯逻辑测试可用 */
    }
  }
  return path.join(require('os').tmpdir(), 'studystudio-plugins');
}

/* ------------------------------------------------------------------ 状态 */

function readState() {
  const fallback = { enabled: {}, importedAt: {} };
  try {
    const row = ctx.database?.getAppPreference?.(STATE_KEY);
    const raw = row?.value ?? '';
    if (!raw) return fallback;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return {
      enabled: parsed?.enabled && typeof parsed.enabled === 'object' ? parsed.enabled : {},
      importedAt: parsed?.importedAt && typeof parsed.importedAt === 'object' ? parsed.importedAt : {},
    };
  } catch (error) {
    console.warn('[Plugins] 读取启用状态失败:', error?.message || error);
    return fallback;
  }
}

function writeState(state) {
  try {
    ctx.database?.setAppPreference?.(STATE_KEY, JSON.stringify({
      enabled: state.enabled || {},
      importedAt: state.importedAt || {},
    }));
  } catch (error) {
    console.warn('[Plugins] 保存启用状态失败:', error?.message || error);
  }
}

function isEnabled(plugin, state) {
  const saved = state.enabled?.[plugin.id];
  if (typeof saved === 'boolean') return saved;
  // 安全默认：内置默认启用；第三方导入后默认禁用，由用户显式打开
  return Boolean(plugin.builtin);
}

/* ------------------------------------------------------------------ 扫描 */

function readManifestFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}

function loadPluginsFrom(root, builtin) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const list = [];
  entries.filter((entry) => entry.isDirectory()).forEach((entry) => {
    const dir = path.join(root, entry.name);
    const manifestPath = path.join(dir, MANIFEST_FILE);
    const base = {
      id: entry.name,
      name: entry.name,
      builtin,
      dir,
      manifestPath,
      invalid: false,
      errors: [],
    };
    if (!fs.existsSync(manifestPath)) {
      list.push({ ...base, invalid: true, errors: [`缺少 ${MANIFEST_FILE}`] });
      return;
    }
    try {
      const stat = fs.statSync(manifestPath);
      if (stat.size > MAX_IMPORT_BYTES) {
        list.push({ ...base, invalid: true, errors: [`清单超过 ${MAX_IMPORT_BYTES / 1024}KB 限制`] });
        return;
      }
      const raw = readManifestFile(manifestPath);
      const checked = validateManifest(raw, { source: builtin ? 'builtin' : 'user' });
      if (!checked.ok) {
        list.push({ ...base, id: String(raw?.id || entry.name), name: String(raw?.name || entry.name), invalid: true, errors: checked.errors });
        return;
      }
      list.push({
        ...base,
        ...checked.plugin,
        id: checked.plugin.id,
        dir,
        builtin,
        invalid: false,
        errors: [],
        installedAt: stat.mtime ? stat.mtime.toISOString() : '',
      });
    } catch (error) {
      list.push({ ...base, invalid: true, errors: [`清单读取失败：${error.message}`] });
    }
  });
  return list;
}

function engineList(plugin) {
  return (plugin.engines || []).map((id) => ({
    id,
    label: ENGINES[id]?.label || id,
    description: ENGINES[id]?.description || '',
  }));
}

function toSummary(plugin, state) {
  return {
    id: plugin.id,
    name: plugin.name || plugin.id,
    version: plugin.version || '',
    description: plugin.description || '',
    author: plugin.author || '',
    disciplines: plugin.disciplines || [],
    match: plugin.match || { categoryKeys: [], keywords: [] },
    inputs: plugin.inputs || [],
    inputLabels: describeInputs(plugin.inputs || []),
    outputs: plugin.outputs || [],
    outputLabels: describeOutputs(plugin.outputs || []),
    capabilities: plugin.capabilities || [],
    capabilityLabels: describeCapabilities(plugin.capabilities || []),
    engines: engineList(plugin),
    builtin: Boolean(plugin.builtin),
    invalid: Boolean(plugin.invalid),
    errors: plugin.errors || [],
    enabled: !plugin.invalid && isEnabled(plugin, state),
    dir: plugin.builtin ? '' : plugin.dir,
    installedAt: plugin.installedAt || '',
  };
}

/** 内置 + 第三方合并；同 id 时内置优先，第三方标为冲突而不是覆盖 */
function scanAll() {
  const state = readState();
  const builtinPlugins = loadPluginsFrom(builtinRoot(), true);
  const builtinIds = new Set(builtinPlugins.map((plugin) => plugin.id));
  const userPlugins = loadPluginsFrom(userRoot(), false).map((plugin) => {
    if (builtinIds.has(plugin.id)) {
      return { ...plugin, invalid: true, errors: [...(plugin.errors || []), 'id 与内置插件冲突，已忽略；请修改清单里的 id 后重新导入'] };
    }
    return plugin;
  });
  return { state, builtinPlugins, userPlugins };
}

function listPlugins() {
  const { state, builtinPlugins, userPlugins } = scanAll();
  return [...builtinPlugins, ...userPlugins]
    .map((plugin) => toSummary(plugin, state))
    .sort((a, b) => {
      if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
      if (a.invalid !== b.invalid) return a.invalid ? 1 : -1;
      return String(a.name).localeCompare(String(b.name), 'zh-CN');
    });
}

function findPlugin(id) {
  const { state, builtinPlugins, userPlugins } = scanAll();
  const plugin = [...builtinPlugins, ...userPlugins].find((item) => item.id === String(id || '').trim());
  if (!plugin) return null;
  return { plugin, state };
}

function getDetail(id) {
  const found = findPlugin(id);
  if (!found) return { success: false, error: '插件不存在' };
  const summary = toSummary(found.plugin, found.state);
  return {
    success: true,
    plugin: {
      ...summary,
      prompts: {
        extract: String(found.plugin.prompts?.extract || '').slice(0, 400),
        explain: String(found.plugin.prompts?.explain || '').slice(0, 400),
      },
      engineSchemas: (found.plugin.engines || []).map((engineId) => ({
        id: engineId,
        schema: ENGINES[engineId]?.describeSchema?.() || '',
      })),
    },
  };
}

function setEnabled(id, enabled) {
  const found = findPlugin(String(id || '').trim());
  if (!found) return { success: false, error: '插件不存在' };
  if (found.plugin.invalid) return { success: false, error: '插件清单无效，无法启用' };
  const { state, plugin } = found;
  state.enabled[plugin.id] = Boolean(enabled);
  writeState(state);
  return { success: true, plugin: toSummary(plugin, state) };
}

/* ------------------------------------------------------------ 学科匹配 */

function subjectKeywords(subject) {
  const profile = subject?.profile && typeof subject.profile === 'object' ? subject.profile : {};
  const extra = [subject?.name, profile?.major, profile?.course, profile?.targetSchool]
    .filter(Boolean)
    .map((item) => String(item));
  return { name: String(subject?.name || ''), text: extra.join(' ') };
}

function matchesSubject(plugin, subject) {
  if (!subject) return false;
  const match = plugin.match || {};
  const categoryKeys = match.categoryKeys || [];
  const keywords = match.keywords || [];
  if (!categoryKeys.length && !keywords.length) return false;
  if (categoryKeys.length && subject.categoryKey && categoryKeys.includes(subject.categoryKey)) return true;
  const { name, text } = subjectKeywords(subject);
  return keywords.some((keyword) => keyword && (name.includes(keyword) || text.includes(keyword)));
}

function forSubject(subjectId) {
  if (!subjectId) return { success: true, subject: null, plugins: [] };
  let subject = null;
  try {
    subject = require('../subjectManager.js').getSubject(String(subjectId));
  } catch (error) {
    return { success: false, error: `读取科目失败：${error?.message || error}`, plugins: [] };
  }
  if (!subject) return { success: true, subject: null, plugins: [] };
  const { state, builtinPlugins, userPlugins } = scanAll();
  const plugins = [...builtinPlugins, ...userPlugins]
    .filter((plugin) => !plugin.invalid && isEnabled(plugin, state) && matchesSubject(plugin, subject))
    .map((plugin) => toSummary(plugin, state));
  return {
    success: true,
    subject: { id: subject.id, name: subject.name, categoryKey: subject.categoryKey || '' },
    plugins,
  };
}

/**
 * AI 答疑用：只有「绑定科目 + 插件启用 + 匹配」时才返回提示词；
 * 不适用时返回空字符串，模型侧完全看不到插件。
 */
function buildChatPluginPrompt(subjectId) {
  const result = forSubject(subjectId);
  if (!result.success || !result.plugins.length) return '';
  const blocks = result.plugins.map((plugin) => {
    const capabilities = plugin.inputLabels.join('、') || '题干文字';
    return `### ${plugin.name}（pluginId: ${plugin.id}）
- 说明：${plugin.description}
- 输入：${capabilities}
- 它负责把题目转成结构化中间结果，并由代码完成计算和画图。你不能自己计算，也不能给出最终数值或代替它画图。
- 下面任一情况（针对某道具体题目时），必须调用这个插件，不要只用文字作答：
  1) 用户要求「画相量图 / 画 E0、I 的轨迹 / 定性分析」，尤其是同步电机、异步电机的电动势与电压相量关系、功率因数角、功角、有功 / 无功 / 励磁调节；
  2) 用户贴出电路图、单线图、接线图，要求化简、计算、分析；
  3) 用户贴出电气类题目并明确说「用插件 / 打开分析工作台 / 画图分析」。
- 定性题（题目没有具体数值、只要判断变化趋势）同样要调用：插件内置隐极同步发电机调节的分步相量图模板，不需要你再让用户补数值。
- 当前会话已锁定题目时（system 里有「本次会话锁定的题目」），直接用锁定的题干调用，不要让用户重复贴题。
- 输出动作前可以用一两句话说明将打开该插件；正文不要给出完整推导、结论数值或自画的相量图。
- 需要调用时，在回复末尾只输出：
<action>{"type":"run_analysis_plugin","pluginId":"${plugin.id}"}</action>
- 题目明显不属于该插件范围时，不要输出这个动作。`;
  });
  return `## 学科分析插件（本会话已匹配，可用）
当前科目「${result.subject.name}」匹配到以下插件：
${blocks.join('\n\n')}`;
}

/* -------------------------------------------------------------- 导入/删除 */

/** 第三方插件导入只在开发环境开放；普通用户界面不出现入口 */
function allowThirdParty() {
  // 以 `electron .` 启动时 isPackaged 在部分版本仍为 true，process.defaultApp 才是可靠信号
  if (process.defaultApp === true) return true;
  if (process.env.OPENEXAM_PLUGIN_DEV === '1') return true;
  return ctx.app?.isPackaged === false;
}

function ensureInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget.startsWith(resolvedRoot + path.sep);
}

function importFromFile(filePath) {
  if (!allowThirdParty()) return { success: false, error: '当前版本不开放第三方插件导入' };
  const source = String(filePath || '').trim();
  if (!source) return { success: false, error: '没有选择文件' };
  if (!/\.(json|ssplugin)$/i.test(source)) {
    return { success: false, error: '只支持 .json / .ssplugin 清单文件' };
  }
  let stat = null;
  try {
    stat = fs.statSync(source);
  } catch (error) {
    return { success: false, error: `文件不存在或不可读：${error.message}` };
  }
  if (!stat.isFile()) return { success: false, error: '请选择单个清单文件' };
  if (stat.size > MAX_IMPORT_BYTES) {
    return { success: false, error: `文件超过 ${MAX_IMPORT_BYTES / 1024}KB 限制` };
  }
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(source, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    return { success: false, error: `JSON 解析失败：${error.message}` };
  }
  const checked = validateManifest(raw, { source: 'user' });
  if (!checked.ok) {
    return { success: false, error: checked.errors.join('；'), errors: checked.errors };
  }

  const { builtinPlugins, userPlugins } = scanAll();
  if (builtinPlugins.some((plugin) => plugin.id === checked.plugin.id)) {
    return { success: false, error: `id「${checked.plugin.id}」与内置插件冲突，不能覆盖内置插件` };
  }
  const replaced = userPlugins.some((plugin) => plugin.id === checked.plugin.id);
  const targetDir = path.join(userRoot(), checked.plugin.id);
  if (!ensureInside(userRoot(), targetDir)) {
    return { success: false, error: '安装路径不合法' };
  }
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    const tempFile = path.join(targetDir, `${MANIFEST_FILE}.tmp`);
    fs.writeFileSync(tempFile, JSON.stringify(checked.plugin, null, 2), 'utf8');
    fs.renameSync(tempFile, path.join(targetDir, MANIFEST_FILE));
  } catch (error) {
    return { success: false, error: `写入插件目录失败：${error.message}` };
  }

  const state = readState();
  // 新导入的第三方插件默认禁用，避免未经确认就出现在答疑里
  if (!replaced) state.enabled[checked.plugin.id] = false;
  state.importedAt[checked.plugin.id] = new Date().toISOString();
  writeState(state);

  const inst = { ...checked.plugin, builtin: false, invalid: false, errors: [], dir: targetDir, installedAt: state.importedAt[checked.plugin.id] };
  return { success: true, replaced, plugin: toSummary(inst, state) };
}

function removePlugin(id) {
  if (!allowThirdParty()) return { success: false, error: '当前版本不开放第三方插件管理' };
  const { userPlugins } = scanAll();
  const plugin = userPlugins.find((item) => item.id === String(id || '').trim());
  if (!plugin) return { success: false, error: '只能删除通过本地文件导入的第三方插件' };
  if (!ensureInside(userRoot(), plugin.dir)) {
    return { success: false, error: '插件目录不在用户插件目录内，已拒绝删除' };
  }
  try {
    fs.rmSync(plugin.dir, { recursive: true, force: true });
  } catch (error) {
    return { success: false, error: `删除失败：${error.message}` };
  }
  const state = readState();
  delete state.enabled[plugin.id];
  delete state.importedAt[plugin.id];
  writeState(state);
  return { success: true };
}

/* -------------------------------------------------------------- 编排：模型 */

function engineFor(plugin, kind) {
  const list = (plugin.engines || []).filter((id) => ENGINES[id]);
  if (!list.length) throw new Error('插件没有可用的引擎');
  if (kind) {
    if (!list.includes(kind)) throw new Error(`插件不支持该题目类型：${kind}`);
    return ENGINES[kind];
  }
  return ENGINES[list[0]];
}

function buildExtractSystem(plugin) {
  const schemas = (plugin.engines || [])
    .map((id) => ENGINES[id])
    .filter(Boolean)
    .map((engine) => `#### engine: ${engine.id}（${engine.label}）\n${engine.describeSchema()}`)
    .join('\n\n');
  return `${plugin.prompts.extract}

你可以把题目转换成下面某一种「结构化中间表示」（IR）。只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。

${schemas}

通用硬约束（优先级最高）：
1. 你只负责读题、读图、结构化；不做计算、不写解题步骤、不给出结论数值。
2. 看不清、有歧义时，把问题写进 ambiguities；宁可不答，也不要猜。
3. 题目是电路图 → 用 kind=circuit；是单线图 / 电力系统接线图 → 用 kind=one-line；要求画相量图、画 E0 / I 轨迹或做电机定性分析 → 用 kind=phasor（没有具体数值时 mode=qualitative）。
4. 输出必须是能被 JSON.parse 直接解析的对象，不要出现注释、尾逗号或额外文字。`;
}

function stripCodeFences(text) {
  return String(text || '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

function parseIr(rawText) {
  const text = stripCodeFences(rawText);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON 对象');
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!parsed || typeof parsed !== 'object') throw new Error('模型返回的不是 JSON 对象');
  return parsed;
}

function normalizeAmbiguities(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => {
      const question = String(item?.question || '').trim().slice(0, 200);
      if (!question) return null;
      return {
        question,
        options: Array.isArray(item?.options) ? item.options.map((option) => String(option).slice(0, 60)).filter(Boolean).slice(0, 6) : [],
        about: String(item?.about || '').slice(0, 60),
      };
    })
    .filter(Boolean)
    .slice(0, 12);
}

function normalizeIr(plugin, ir) {
  const kind = String(ir?.kind || '').trim() || (plugin.engines || [])[0];
  if (!(plugin.engines || []).includes(kind)) {
    throw new Error(`模型返回的题目类型不受该插件支持：${kind || '空'}`);
  }
  return {
    ...ir,
    kind,
    ambiguities: normalizeAmbiguities(ir?.ambiguities),
  };
}

function resolveChatSettings(settings, hasImages) {
  const aiService = require('../ai/index.js');
  const teacher = aiService.resolveRoleSettings(settings || {}, 'teacher');
  if (!hasImages) return { settings: teacher, warning: '' };
  if (aiService.isVisionCapableSettings(teacher)) return { settings: teacher, warning: '' };
  const vision = aiService.resolveRoleSettings(settings || {}, 'vision');
  if (vision?.apiKey && aiService.isVisionCapableSettings(vision)) {
    return { settings: vision, warning: '当前模型不能读图，本次已自动切换到「识图」模型。' };
  }
  return { settings: null, warning: '', error: '当前模型不能读图，且没有配置可用的「识图」模型。请到「设置 → AI 模型」配置识图角色后重试。' };
}

async function extract({ pluginId, text, images, settings } = {}) {
  const found = findPlugin(pluginId);
  if (!found) return { success: false, error: '插件不存在' };
  const { plugin, state } = found;
  if (plugin.invalid) return { success: false, error: '插件清单无效，无法运行' };
  if (!isEnabled(plugin, state)) return { success: false, error: '插件未启用' };

  const imageList = (Array.isArray(images) ? images : []).filter((image) => image?.base64);
  const question = String(text || '').trim();
  if (!question && !imageList.length) return { success: false, error: '请先贴入题干或上传题目图片' };

  const resolved = resolveChatSettings(settings, imageList.length > 0);
  if (resolved.error) return { success: false, error: resolved.error };

  const aiService = require('../ai/index.js');
  const assistantAgent = require('../assistantAgent.js');
  const messages = assistantAgent.attachImagesToMessages(
    [{ role: 'user', content: question || '请识别图片中的题目，并按约定输出结构化 JSON。' }],
    imageList,
  );

  const result = await aiService.chat(resolved.settings, messages, {
    system: buildExtractSystem(plugin),
    maxTokens: 6000,
  });
  if (!result?.success) return { success: false, error: `识别失败：${result?.error || '未知错误'}` };

  let ir = null;
  try {
    ir = normalizeIr(plugin, parseIr(result.content));
  } catch (error) {
    return { success: false, error: `模型输出无法解析：${error.message}`, raw: String(result.content || '').slice(0, 1200) };
  }
  return {
    success: true,
    ir,
    warning: resolved.warning,
    model: resolved.settings.model || '',
    raw: String(result.content || '').slice(0, 4000),
  };
}

function solve({ pluginId, ir, ignoreAmbiguities = false, sweep } = {}) {
  const found = findPlugin(pluginId);
  if (!found) return { success: false, error: '插件不存在' };
  const { plugin } = found;
  if (plugin.invalid) return { success: false, error: '插件清单无效，无法运行' };
  try {
    const engine = engineFor(plugin, String(ir?.kind || '').trim());
    const normalized = { ...ir, kind: engine.kind, ambiguities: normalizeAmbiguities(ir?.ambiguities) };
    const result = engine.solve(normalized, { ignoreAmbiguities, sweep });
    return { success: true, kind: engine.kind, result };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
}

function explainPayload(ir, result) {
  const trimmed = {
    ir,
    result: result?.ok === false
      ? { ok: false, errors: result?.errors || [] }
      : {
        ok: true,
        qualitative: Boolean(result?.qualitative),
        scenarioLabel: result?.scenarioLabel || '',
        port: result?.port || null,
        nodeVoltages: result?.nodeVoltages || [],
        elements: result?.elements || [],
        steps: (result?.steps || []).map((step) => ({ title: step.title, detail: step.detail, value: step.value, formula: step.formula })),
        buses: result?.buses || [],
        branches: result?.branches || [],
        loads: result?.loads || [],
        phasors: result?.phasors || [],
        reference: result?.reference || null,
        unverified: Boolean(result?.unverified),
        notice: result?.notice || '',
        summary: result?.summary || [],
        assumptions: result?.assumptions || [],
      },
  };
  return JSON.stringify(trimmed, null, 1).slice(0, 20000);
}

async function explain({ pluginId, ir, result, question, settings } = {}) {
  const found = findPlugin(pluginId);
  if (!found) return { success: false, error: '插件不存在' };
  const { plugin, state } = found;
  if (plugin.invalid) return { success: false, error: '插件清单无效，无法运行' };
  if (!isEnabled(plugin, state)) return { success: false, error: '插件未启用' };

  const resolved = resolveChatSettings(settings, false);
  if (resolved.error) return { success: false, error: resolved.error };

  const system = `${plugin.prompts.explain}

你必须遵守的硬约束（最高优先级）：
1. 所有数值只能引用「计算结果」里已经出现的值；不得改写、不得重新计算、不得补充结果里没有的数值。
2. 如果结果有假设、待确认项或不支持的部分，必须在讲解里明确指出，不要掩盖。
3. 讲解结构：先说明分析方法/等效过程，再引用计算步骤和数值，最后给出结论。
4. 不要输出 <action> 块，不要编造题目里没有的条件。`;

  const content = `【题目】
${String(question || '（用户未补充题干，按结构化结果讲解）').slice(0, 4000)}

【结构化中间结果与计算结果（以此为准）】
${explainPayload(ir, result)}`;

  const aiService = require('../ai/index.js');
  const reply = await aiService.chat(resolved.settings, [{ role: 'user', content }], {
    system,
    maxTokens: 4000,
  });
  if (!reply?.success) return { success: false, error: `讲解生成失败：${reply?.error || '未知错误'}` };
  return { success: true, text: String(reply.content || '').trim(), model: resolved.settings.model || '' };
}

/* ------------------------------------------------------------ 相量图答疑 */

function assistContext({ question, ir, result }) {
  const phasors = (Array.isArray(result?.phasors) ? result.phasors : Array.isArray(ir?.phasors) ? ir.phasors : [])
    .map((item) => `${item?.label || ''}：${item?.magnitude ?? ''}${item?.unit || ''} ∠${item?.angle ?? ''}°${item?.dashed ? '（调节前，虚线）' : ''}`)
    .filter((line) => line.length > 3)
    .slice(0, 20);
  const payload = {
    question: String(question || '').slice(0, 2000),
    scenarioLabel: result?.scenarioLabel || '',
    qualitative: Boolean(result?.qualitative),
    normalized: Boolean(result?.normalized),
    summary: (result?.summary || []).slice(0, 10),
    phasors,
    guides: (result?.guides || []).map((guide) => String(guide?.label || guide?.type || '')).filter(Boolean).slice(0, 8),
    notice: result?.notice || '',
  };
  return JSON.stringify(payload, null, 1).slice(0, 12000);
}

function sanitizeAdditions(raw) {
  const list = Array.isArray(raw?.phasors) ? raw.phasors : [];
  const phasors = list.map((item, index) => {
    const quantity = String(item?.quantity || '').toLowerCase() === 'current' ? 'current' : 'voltage';
    const magnitude = Number(item?.magnitude);
    const angle = Number(item?.angle);
    const label = String(item?.label || '').trim().slice(0, 20);
    if (!label || !Number.isFinite(magnitude) || !Number.isFinite(angle)) return null;
    if (magnitude <= 0 || magnitude > 3) return null;
    return {
      id: `AI${index + 1}`,
      label,
      quantity,
      magnitude: Math.round(magnitude * 1000) / 1000,
      unit: '',
      angle: Math.round(angle * 10) / 10,
      real: Math.round(magnitude * Math.cos((angle * Math.PI) / 180) * 1000) / 1000,
      imag: Math.round(magnitude * Math.sin((angle * Math.PI) / 180) * 1000) / 1000,
      source: 'assistant',
      verified: false,
      dashed: true,
    };
  }).filter(Boolean).slice(0, 6);

  const guideList = Array.isArray(raw?.guides) ? raw.guides : [];
  const guides = guideList.map((guide) => {
    const type = String(guide?.type || '').trim();
    const label = String(guide?.label || '').trim().slice(0, 80);
    if (!['vline', 'hline', 'circle'].includes(type)) return null;
    if (type === 'vline') {
      const x = Number(guide?.x);
      if (!Number.isFinite(x)) return null;
      return { type, x: Math.round(x * 1000) / 1000, label, source: 'assistant' };
    }
    if (type === 'hline') {
      const y = Number(guide?.y);
      if (!Number.isFinite(y)) return null;
      return { type, y: Math.round(y * 1000) / 1000, label, source: 'assistant' };
    }
    const cx = Number(guide?.cx);
    const cy = Number(guide?.cy);
    const r = Number(guide?.r);
    if (![cx, cy, r].every(Number.isFinite) || r <= 0) return null;
    return { type, cx, cy, r: Math.round(r * 1000) / 1000, label, source: 'assistant' };
  }).filter(Boolean).slice(0, 4);

  const notes = (Array.isArray(raw?.notes) ? raw.notes : [])
    .map((note) => String(note || '').trim().slice(0, 100))
    .filter(Boolean)
    .slice(0, 4);

  return { phasors, guides, notes };
}

async function assist({ pluginId, question, message, history, ir, result, settings } = {}) {
  const found = findPlugin(pluginId);
  if (!found) return { success: false, error: '插件不存在' };
  const { plugin, state } = found;
  if (plugin.invalid) return { success: false, error: '插件清单无效，无法运行' };
  if (!isEnabled(plugin, state)) return { success: false, error: '插件未启用' };

  const ask = String(message || '').trim();
  if (!ask) return { success: false, error: '请输入要追问的内容' };

  const resolved = resolveChatSettings(settings, false);
  if (resolved.error) return { success: false, error: resolved.error };

  const system = `你是电机学 / 电路相量图的答疑助手，正在配合理科分析插件「${plugin.name}」讲解一张已经画好的相量图。
用户会在看完图后就相量之间的关系追问，例如「电枢电流与励磁电流是什么关系」「增大有功时其他量怎么动」。

硬约束（最高优先级）：
1. 以给定的「当前图与分析结果」为准，不得改写其中已有的数值 / 结论，也不得与图上的相量关系矛盾。
2. 只回答概念关系与变化趋势，用中文，可少量使用 LaTeX（$...$）。回答控制在 300 字以内，先直接回答问题，再补充一句依据。
3. 如需在图上补充显示关系，可以在 additions 里给出：
   - phasors：示意相量，label 用相量名（如「İ_f」「ΔE₀」），quantity 是 voltage 或 current，magnitude 用 0.05–3 的归一化相对值（U 基准 = 1），angle 用角度；这些只作示意，不要写成题目数值。
   - guides：补充轨迹，type 是 vline（需 x）/ hline（需 y）/ circle（需 cx、cy、r），坐标与相量图同一套归一化坐标。
   - notes：一句图外标注，最多 4 条，每条不超过 60 字。
4. 不需要补充图形时，additions 里三个数组都返回空数组。不要为了显得完整而硬加。
5. 只输出一个 JSON 对象，不要 Markdown 代码块、不要解释 JSON 之外的内容：
{"answer":"...","additions":{"phasors":[],"guides":[],"notes":[]}}`;

  const recent = (Array.isArray(history) ? history : [])
    .filter((item) => item?.role === 'user' || item?.role === 'assistant')
    .slice(-6)
    .map((item) => ({ role: item.role, content: String(item.content || '').slice(0, 1200) }));

  const content = `【当前图与分析结果（以此为准）】
${assistContext({ question, ir, result })}

【用户追问】
${ask}`;

  const aiService = require('../ai/index.js');
  const reply = await aiService.complete(resolved.settings, {
    system,
    messages: [...recent, { role: 'user', content }],
    maxTokens: 1200,
  });
  if (!reply?.success) return { success: false, error: `答疑失败：${reply?.error || '未知错误'}` };

  let parsed = null;
  try {
    parsed = aiService.parseAIJson(reply.content);
  } catch {
    // 模型没按 JSON 返回时，至少把正文当答案，不让用户这一问白花
    const text = stripCodeFences(reply.content);
    if (!text) return { success: false, error: '答疑没有返回内容' };
    return { success: true, answer: text.slice(0, 4000), additions: { phasors: [], guides: [], notes: [] }, model: resolved.settings.model || '' };
  }

  const answer = String(parsed?.answer || '').trim();
  if (!answer) return { success: false, error: '答疑没有返回有效回答' };
  return {
    success: true,
    answer: answer.slice(0, 4000),
    additions: sanitizeAdditions(parsed?.additions),
    model: resolved.settings.model || '',
  };
}

module.exports = {
  attach,
  initForTest,
  builtinRoot,
  userRoot,
  listPlugins,
  getDetail,
  setEnabled,
  allowThirdParty,
  forSubject,
  buildChatPluginPrompt,
  importFromFile,
  removePlugin,
  extract,
  solve,
  explain,
  assist,
  ENGINES,
  ENGINE_IDS,
};
