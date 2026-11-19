'use strict';
/**
 * 合并后的 AI 助教后端：一套人设、一套动作协议、一份会话历史。
 *
 * 旧的形态里，AI 老师走 ai:chatStreamStart（只答疑），AI 助教走 assistant:chatStreamStart
 * （只做事），两套 system prompt 各自维护。这里把它们合成一个入口：
 *   - 人设与动作协议来自 assistantAgent（唯一一份）
 *   - 方法论来自 goodLearningSkill（唯一一份）
 *   - 科目 / 教材 RAG 来自 subjectContext（原老师侧逻辑）
 *   - 题目上下文来自会话锁定的 context
 * 图片沿用 assistantAgent 的挂载逻辑与识图角色回落。
 */

const assistantAgent = require('./assistantAgent.js');
const aiService = require('./ai/index.js');
const { buildSubjectBlock } = require('./subjectContext.js');
const { validateCitations } = require('./materialContext.js');
const { buildQuestionContextPrompt } = require('../shared/aiContext.js');

function resolveUnifiedRoute(settings, hasImages) {
  // 合并后默认用「老师」角色（答疑是主场景）；没有单独配置时自动回落到通用配置
  const teacher = aiService.resolveRoleSettings(settings, 'teacher');
  const base = {
    settings: teacher,
    role: 'teacher',
    model: teacher.model || '',
    fallback: false,
    warning: '',
  };
  if (!hasImages) return base;
  if (aiService.isVisionCapableSettings(teacher)) return base;

  const vision = aiService.resolveRoleSettings(settings, 'vision');
  if (vision?.apiKey && aiService.isVisionCapableSettings(vision)) {
    return {
      settings: vision,
      role: 'vision',
      model: vision.model || '',
      fallback: true,
      warning: '当前模型不能读图，本次已自动切换到「识图」模型处理图片。',
    };
  }
  return {
    ...base,
    warning: '当前模型不能读图，且没有可用的「识图」模型。图片可能无法被正确识别，请到「设置 → AI 模型」配置识图角色。',
  };
}

/* ------------------------------------------------------------ 输出范围判定 */

const SUMMARY_VERB = '(总结|归纳|梳理)';
const SUMMARY_OBJECT = '(知识点|考点|要点|概念|公式|结论|笔记)';
// 用户明确点名要的其它产出：出现这些词就不算「只要知识点总结」
const EXTRA_REQUEST_RE = /(拓展|延伸|扩展|补充|建议|规划|计划|例题|习题|练习|刷题|真题|推荐|书单|鼓励|下一步|学习安排)/;
// 「不要拓展 / 不要建议」是在限制范围，先把这些否定句摘掉再判定
const NEGATED_EXTRA_RE = /(不要|不用|不需要|无需|别|勿|不必)[^。；\n]{0,8}(拓展|延伸|扩展|补充|建议|规划|计划|例题|习题|练习|推荐|鼓励|下一步)/g;

/**
 * 判断这一轮用户是否只要「知识点总结」。
 * 只做轻量意图判定，不改变其它意图（讲解 / 整理 / 提问）的输出方式。
 */
function wantsKnowledgeSummaryOnly(text) {
  const source = String(text || '').trim();
  if (!source) return false;

  const cleaned = source.replace(NEGATED_EXTRA_RE, '');
  // 「只要 / 仅需…总结」「总结…知识点」「知识点总结」三种说法都算总结意图
  const explicit = new RegExp(`(只|仅|只需要|仅需|只要|只做|仅做|只给|仅给|只输出|只写|只整理)[^。；\\n]{0,16}${SUMMARY_VERB}`).test(cleaned);
  const named = new RegExp(`${SUMMARY_VERB}[^。；\\n]{0,24}${SUMMARY_OBJECT}`).test(cleaned);
  const noun = new RegExp(`${SUMMARY_OBJECT}(的)?${SUMMARY_VERB}`).test(cleaned);
  if (!explicit && !named && !noun) return false;

  // 同时还要例题 / 建议 / 计划时属于复合意图，按正常回答处理
  return !EXTRA_REQUEST_RE.test(cleaned);
}

/** 只要知识点总结时追加的硬约束：放在 system 末尾，优先级高于方法论里的扩写要求 */
const SUMMARY_ONLY_SCOPE_PROMPT = `## 本轮输出范围（最高优先级，覆盖上面的方法论与格式要求）
用户这一轮只要「知识点总结」。
- 只输出该知识点本身：定义与适用条件、关键性质或公式、必要的使用要点。结构清晰，可以直接落进笔记。
- 不追加拓展、延伸阅读、背景故事、相关知识点、例题或练习、学习建议、下一步安排、鼓励或寒暄。
- 不要为了显得完整而补充用户没问的内容；资料没覆盖的部分直接不写，不要用推测填充。
- 如果本轮调用 write_notes，笔记正文同样只写上述范围，不要写成一节课、学习计划或知识清单。
- 这一条优先于 Good Learning 方法论中关于每日学习、完整例题、举一反三和收尾建议的要求。`;

function userMessageText(message) {
  const raw = message?.content ?? message?.text;
  if (typeof raw === 'string') return raw;
  if (!Array.isArray(raw)) return '';
  return raw
    .map((part) => {
      if (typeof part === 'string') return part;
      return typeof part?.text === 'string' ? part.text : '';
    })
    .join('\n');
}

function buildSystem({ database, subjectId, messages, questionContext }) {
  const context = assistantAgent.buildContextSnapshot(database);
  const subjectBlock = buildSubjectBlock(subjectId, { messages });
  let system = assistantAgent.buildSystemPrompt(context, subjectBlock.text);
  const notesBlock = assistantAgent.buildNotesContext(database, { subjectId, messages });
  if (notesBlock) {
    system += `\n\n${notesBlock}`;
  }
  // 学科分析插件：只有「绑定科目 + 插件启用 + 匹配」时才注入，不适用时模型看不到
  try {
    const pluginBlock = require('./plugins/index.js').buildChatPluginPrompt(subjectId);
    if (pluginBlock) system += `\n\n${pluginBlock}`;
  } catch (error) {
    console.warn('[Plugins] 注入插件提示词失败:', error?.message || error);
  }
  if (questionContext) {
    system += `\n\n## 本次会话锁定的题目\n用户正在追问下面这道题。讲解与动作都要围绕它，不要把上下文丢掉；如果用户换了新题，以新题为准。\n\n${buildQuestionContextPrompt(questionContext)}`;
  }

  const lastUser = [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find((message) => message?.role === 'user' || message?.type === 'user');
  if (wantsKnowledgeSummaryOnly(userMessageText(lastUser))) {
    system += `\n\n${SUMMARY_ONLY_SCOPE_PROMPT}`;
  }
  return { system, citations: subjectBlock.citations || [] };
}

function stripCitationMarkers(text) {
  return String(text || '').replace(/\[\[cite:\d+\]\]/g, '').replace(/【\d+】/g, '');
}

/** 组装消息：挂图片 + 把题目上下文并到本轮用户消息里 */
function buildMessages({ messages, images, questionContext }) {
  const list = (Array.isArray(messages) ? messages : []).map((message) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: stripCitationMarkers(message.content),
  }));
  if (questionContext) {
    const index = (() => {
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (list[i].role === 'user') return i;
      }
      return -1;
    })();
    if (index >= 0) {
      list[index] = {
        ...list[index],
        content: `${buildQuestionContextPrompt(questionContext)}\n\n[用户问题]\n${list[index].content}`,
      };
    }
  }
  return assistantAgent.attachImagesToMessages(list, images);
}

/* ------------------------------------------------------ 外部对话导入 */

const IMPORT_SYSTEM_PROMPT = `你是聊天记录整理助手。用户会给你一段从其它 AI 产品搬来的对话：可能是复制的纯文本、导出的文件内容，或若干张聊天截图。
请把它整理成结构化对话，只输出一个 JSON 对象，不要输出任何解释、不要加代码块以外的文字。

输出格式：
{
  "title": "12-24 字，概括这段对话在聊什么",
  "summary": "一两句话概括（可留空）",
  "topics": ["涉及的知识点或任务"],
  "messages": [
    { "role": "user", "content": "用户说的话" },
    { "role": "assistant", "content": "AI 的回复" }
  ]
}

规则：
1. 只保留真实的对话内容，删掉界面噪音：时间戳、复制 / 点赞 / 重新生成等按钮文字、模型名、网页导航、导出工具的水印。
2. role 只能是 user 或 assistant。用户发的记 user，AI 的回复记 assistant；分不清时按语气和内容判断，不要造第三种角色。
3. 逐字保留原文，不要改写、不要压缩、不要补充原文没有的信息；公式、代码块、Markdown 原样保留。
4. 同一轮被拆成多段的消息合并成一条；连续同一角色的相邻消息也合并成一条。
5. 如果给的是聊天截图，按从上到下顺序逐条抄录双方对话；看不清的写「[截图此处不清晰]」，不要猜。
6. 最多输出 200 条消息。超出时保留最近的内容，并在 summary 里注明「原文较长，已截断」。
7. 如果内容完全不是对话（空白、广告、单条公告），messages 返回空数组。`;

const MAX_IMPORT_CHARS = 24000;
const MAX_IMPORT_MESSAGES = 300;
const MAX_IMPORT_MESSAGE_CHARS = 8000;

function fallbackTitle(text) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  return source.slice(0, 24) || '导入的对话';
}

/** 只接受 user / assistant 两种角色，去掉空消息，合并相邻同角色消息 */
function normalizeImportedMessages(messages) {
  const list = (Array.isArray(messages) ? messages : [])
    .map((message) => {
      if (!message || typeof message !== 'object') return null;
      const role = String(message.role || '').trim();
      const content = String(message.content || '').trim().slice(0, MAX_IMPORT_MESSAGE_CHARS);
      if (role !== 'user' && role !== 'assistant') return null;
      if (!content) return null;
      return { role, content };
    })
    .filter(Boolean);

  const merged = [];
  for (const message of list) {
    const previous = merged[merged.length - 1];
    if (previous && previous.role === message.role) {
      previous.content = `${previous.content}\n\n${message.content}`;
    } else {
      merged.push({ ...message });
    }
  }
  return merged.slice(-MAX_IMPORT_MESSAGES);
}

/**
 * 把外部聊天记录整理成结构化对话。
 * 文本走「老师」角色，带截图时按 resolveUnifiedRoute 自动落识图模型；
 * 只做结构还原，不改写内容，落库前还要用户在预览里确认。
 */
async function structureChatLog({ settings, text, images }) {
  const rawText = String(text || '').trim();
  const imageList = Array.isArray(images) ? images.filter((item) => item?.base64) : [];
  if (!rawText && !imageList.length) {
    return { success: false, error: '没有可整理的内容：请粘贴文字、选择文件或上传截图' };
  }

  const route = resolveUnifiedRoute(settings, imageList.length > 0);
  const truncated = rawText.length > MAX_IMPORT_CHARS;
  const clipped = truncated ? rawText.slice(-MAX_IMPORT_CHARS) : rawText;

  const parts = [];
  if (clipped) {
    parts.push({ type: 'text', text: `以下是需要整理的聊天记录原文：\n\n<chat_log>\n${clipped}\n</chat_log>` });
  }
  if (imageList.length) {
    parts.push({ type: 'text', text: clipped ? '另外附上聊天截图，请把截图里的对话也按顺序补进 messages。' : '以下是聊天截图，请按从上到下的顺序逐条抄录对话。' });
  }

  const payload = assistantAgent.attachImagesToMessages(
    [{ role: 'user', content: parts.length === 1 && !imageList.length ? parts[0].text : parts }],
    imageList,
  );

  const result = await aiService.complete(route.settings, {
    system: IMPORT_SYSTEM_PROMPT,
    messages: payload,
    maxTokens: 4096,
    fast: true,
  });

  if (!result?.success) {
    return { success: false, error: result?.error || 'AI 整理失败', model: route.model, warning: route.warning };
  }

  const parsed = assistantAgent.parseLooseJSON(result.content || '');
  if (!parsed || typeof parsed !== 'object') {
    return {
      success: false,
      error: '没能从模型返回里解析出对话结构，可以重试一次，或先把原文粘贴得更干净些',
      model: route.model,
      warning: route.warning,
    };
  }

  const messages = normalizeImportedMessages(parsed.messages);
  const title = String(parsed.title || '').replace(/\s+/g, ' ').trim().slice(0, 40) || fallbackTitle(rawText);
  const topics = (Array.isArray(parsed.topics) ? parsed.topics : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 12);

  const warning = [
    route.warning,
    truncated ? `原文超过 ${MAX_IMPORT_CHARS} 字，只整理了最近的部分。` : '',
    !messages.length ? '没有识别出有效对话，请检查原文或截图是否清晰。' : '',
  ].filter(Boolean).join(' ');

  return {
    success: messages.length > 0,
    error: messages.length ? '' : '没有识别出有效对话',
    title,
    summary: String(parsed.summary || '').trim().slice(0, 300),
    topics,
    messages,
    model: route.model,
    fallback: route.fallback,
    warning,
  };
}

/** 预览确认后一次性写入：建会话 + 逐条落消息，避免渲染层循环 IPC */
function importChatLog({ database, title, subjectId, messages }) {
  const list = normalizeImportedMessages(messages);
  if (!list.length) return { success: false, error: '没有可导入的消息' };

  const session = database.createAIChatSession({
    title: String(title || '').trim().slice(0, 60) || '导入的对话',
    subjectId: subjectId || null,
    source: 'imported',
  });

  list.forEach((message) => {
    database.addAIChatMessage({
      sessionId: session.id,
      role: message.role,
      content: message.content,
      meta: { imported: true },
      skipSubjectSync: true,
    });
  });

  try {
    require('./subjectManager.js').syncSubjectChatFile(session.id);
  } catch { /* 科目文件夹同步失败不影响导入结果 */ }

  return { success: true, sessionId: session.id, title: session.title, count: list.length };
}

function finishResult({ result, citations, route, subjectId }) {
  const parsed = assistantAgent.parseAssistantReply(result?.content || '');
  const cited = validateCitations(parsed.reply || '', citations || []);
  let action = parsed.action;
  let actionError = parsed.actionError;
  // 动作只能绑定「当前科目匹配 + 已启用」的插件，模型自报的 id 不作数
  if (action?.type === 'run_analysis_plugin') {
    let matched = null;
    try {
      matched = (require('./plugins/index.js').forSubject(subjectId)?.plugins || [])
        .find((plugin) => plugin.id === action.pluginId);
    } catch { /* 插件模块异常时按不可用处理 */ }
    if (!matched) {
      action = null;
      actionError = '该学科分析插件在当前科目不可用，已忽略这次调用';
    }
  }
  return {
    success: Boolean(result?.success),
    content: cited.content,
    citations: cited.citations,
    action,
    actionError,
    role: route.role,
    model: route.model,
    fallback: route.fallback,
    warning: route.warning,
    error: result?.error || '',
  };
}

async function chat({ settings, database, messages, images, subjectId, questionContext }) {
  const hasImages = assistantAgent.hasImageMessages(messages) || (Array.isArray(images) && images.length > 0);
  const route = resolveUnifiedRoute(settings, hasImages);
  const { system, citations } = buildSystem({ database, subjectId, messages, questionContext });
  const payload = buildMessages({ messages, images, questionContext });
  const result = await aiService.chat(route.settings, payload, { system, maxTokens: 8192 });
  return finishResult({ result, citations, route, subjectId });
}

async function chatStream({ settings, database, messages, images, subjectId, questionContext, onDelta, signal }) {
  const hasImages = assistantAgent.hasImageMessages(messages) || (Array.isArray(images) && images.length > 0);
  const route = resolveUnifiedRoute(settings, hasImages);
  const { system, citations } = buildSystem({ database, subjectId, messages, questionContext });
  const payload = buildMessages({ messages, images, questionContext });
  const result = await aiService.chatStream(route.settings, payload, {
    system,
    maxTokens: 8192,
    signal,
    onDelta: (delta) => { try { onDelta?.(delta); } catch { /* 忽略 */ } },
  });
  return finishResult({ result, citations, route, subjectId });
}

module.exports = {
  resolveUnifiedRoute,
  wantsKnowledgeSummaryOnly,
  buildSystem,
  buildMessages,
  chat,
  chatStream,
  structureChatLog,
  importChatLog,
};
