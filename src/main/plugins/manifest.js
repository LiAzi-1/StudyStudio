'use strict';
/**
 * 学科分析插件的清单（manifest）校验。
 *
 * 第三方插件是「声明式」的：只有 JSON 清单 + 提示词，没有可执行代码。
 * 这里做字段级校验，任何一步不通过都返回具体原因，方便管理页直接展示。
 */

const MAX_PROMPT_CHARS = 20000;
const MAX_TEXT_CHARS = 2000;

const ENGINE_IDS = ['circuit', 'one-line', 'phasor'];
const INPUT_IDS = ['questionText', 'questionImage', 'handwritingPhoto'];
const OUTPUT_IDS = ['diagram', 'ir', 'steps', 'result', 'assumptions', 'ambiguities', 'explanation'];
const CAPABILITY_IDS = ['input:read', 'ai:extract', 'compute:local', 'diagram:render', 'ai:explain'];

const INPUT_LABELS = {
  questionText: '题干文字',
  questionImage: '题目图片',
  handwritingPhoto: '手写图照片',
};
const OUTPUT_LABELS = {
  diagram: '简图（可核对/修改）',
  ir: '结构化中间结果',
  steps: '化简与计算过程',
  result: '计算结论',
  assumptions: '计算假设',
  ambiguities: '读图歧义 / 待确认问题',
  explanation: 'AI 讲解',
};
const CAPABILITY_LABELS = {
  'input:read': '读取本次输入的题干与图片',
  'ai:extract': '调用当前 AI 配置做结构化识别',
  'compute:local': '在本机做确定性计算',
  'diagram:render': '生成可编辑简图',
  'ai:explain': '调用当前 AI 配置生成讲解',
};

function text(value, max = MAX_TEXT_CHARS) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
}

function stringList(value, max = 40, itemMax = 40) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const list = [];
  for (const item of value) {
    const normalized = text(item, itemMax);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    list.push(normalized);
    if (list.length >= max) break;
  }
  return list;
}

function validateManifest(raw, { source = 'user' } = {}) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['清单不是合法的 JSON 对象'], plugin: null };
  }

  const schemaVersion = Number(raw.schemaVersion);
  if (schemaVersion !== 1) errors.push(`schemaVersion 必须是 1（当前：${raw.schemaVersion ?? '空'}）`);

  const id = text(raw.id, 64);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$/.test(id)) {
    errors.push('id 只能由字母、数字、点、下划线、短横线组成，长度 2–64');
  }

  const name = text(raw.name, 40);
  if (!name) errors.push('缺少插件名称 name');
  if (/<script|javascript:/i.test(name)) errors.push('名称包含不允许的脚本片段');

  const version = text(raw.version, 24) || '0.0.0';
  const description = text(raw.description, MAX_TEXT_CHARS);
  if (!description) errors.push('缺少插件说明 description');
  if (/<script|javascript:/i.test(description)) errors.push('说明包含不允许的脚本片段');

  const author = text(raw.author, 80);
  const disciplines = stringList(raw.disciplines, 10, 30);

  const matchRaw = raw.match && typeof raw.match === 'object' ? raw.match : {};
  const categoryKeys = stringList(matchRaw.categoryKeys, 10, 30);
  const keywords = stringList(matchRaw.keywords, 40, 30);

  const engines = stringList(
    Array.isArray(raw.engines) ? raw.engines : (raw.engine ? [raw.engine] : []),
    4,
    30,
  );
  if (!engines.length) errors.push('至少声明一个 engine');
  engines.forEach((engine) => {
    if (!ENGINE_IDS.includes(engine)) {
      errors.push(`引擎 ${engine} 不在应用白名单内（可用：${ENGINE_IDS.join(' / ')}）`);
    }
  });

  const inputs = stringList(raw.inputs, INPUT_IDS.length, 30);
  inputs.forEach((input) => {
    if (!INPUT_IDS.includes(input)) errors.push(`不支持的输入类型：${input}`);
  });
  const outputs = stringList(raw.outputs, OUTPUT_IDS.length, 30);
  outputs.forEach((output) => {
    if (!OUTPUT_IDS.includes(output)) errors.push(`不支持的输出类型：${output}`);
  });

  const capabilities = stringList(raw.capabilities || raw.permissions, CAPABILITY_IDS.length, 40);
  capabilities.forEach((capability) => {
    if (!CAPABILITY_IDS.includes(capability)) {
      errors.push(`不支持的权限声明：${capability}（第三方插件不能申请文件 / 网络 / 执行权限）`);
    }
  });

  const promptsRaw = raw.prompts && typeof raw.prompts === 'object' ? raw.prompts : {};
  const prompts = {
    extract: text(promptsRaw.extract, MAX_PROMPT_CHARS),
    explain: text(promptsRaw.explain, MAX_PROMPT_CHARS),
  };
  if (!prompts.extract) errors.push('缺少 prompts.extract（读题 / 读图提示词）');
  if (!prompts.explain) errors.push('缺少 prompts.explain（讲解提示词）');

  if (errors.length) return { ok: false, errors, plugin: null };

  return {
    ok: true,
    errors: [],
    plugin: {
      schemaVersion: 1,
      id,
      name,
      version,
      description,
      author,
      disciplines,
      match: { categoryKeys, keywords },
      inputs: inputs.length ? inputs : INPUT_IDS.slice(),
      outputs: outputs.length ? outputs : OUTPUT_IDS.slice(),
      engines,
      capabilities: capabilities.length ? capabilities : ['input:read', 'ai:extract', 'compute:local', 'diagram:render', 'ai:explain'],
      prompts,
      source,
    },
  };
}

function describeInputs(inputs = []) {
  return inputs.map((input) => INPUT_LABELS[input] || input);
}

function describeOutputs(outputs = []) {
  return outputs.map((output) => OUTPUT_LABELS[output] || output);
}

function describeCapabilities(capabilities = []) {
  return capabilities.map((capability) => CAPABILITY_LABELS[capability] || capability);
}

module.exports = {
  ENGINE_IDS,
  INPUT_IDS,
  OUTPUT_IDS,
  CAPABILITY_IDS,
  INPUT_LABELS,
  OUTPUT_LABELS,
  CAPABILITY_LABELS,
  validateManifest,
  describeInputs,
  describeOutputs,
  describeCapabilities,
};
