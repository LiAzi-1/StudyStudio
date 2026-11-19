import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAISettings, isAssistantConfigured } from '../store/aiSettings.js';
import { useDialog } from '../components/DialogProvider.jsx';
import AIMessageContent from '../components/AIMessageContent.jsx';
import AIChatImportDialog from '../components/AIChatImportDialog.jsx';
import PhoneUploadDialog from '../components/PhoneUploadDialog.jsx';
import CitationSheet from '../components/CitationSources.jsx';
import LuoCat from '../components/LuoCat.jsx';
import { describeAction, applyAIAction, buildActionPlan } from '../utils/aiActions.js';
import { ActionPlanView, ActionDiffView } from './AIActionPlan.jsx';
import {
  MAX_ASSISTANT_IMAGES,
  readFileAsBase64,
  extractClipboardImages,
  extractDroppedImages,
} from '../utils/imageInput.js';

const ACTIVE_SESSION_KEY = 'openexam_ai_active_session';
const QUESTION_CONTEXT_KEY = 'openexam_question_context';
// 从学科分析工作台返回时恢复发起会话（一次性）
const RETURN_SESSION_KEY = 'openexam_ai_return_session';
// 从工作台带回的预填问题（只填输入框，不新建会话）
const PREFILL_KEY = 'openexam_ai_prefill';
// 题目页「问 AI」写入的待提问内容：合并成 AIConversation 后曾漏掉消费，导致点按钮只跳页
const AUTOFILL_KEY = 'openexam_ai_autofill';
const DRAFT_KEY = 'openexam_ai_draft_v1';

const SUGGESTIONS = [
  { label: '讲这道题', prompt: '请一步一步讲清楚这道题，指出我容易卡住的步骤' },
  { label: '总结知识点', prompt: '只总结这类题涉及的知识点和通用解题方法，不要拓展、不要延伸阅读、不要写学习建议或鼓励语，结构清晰能直接存成笔记' },
  { label: '收进错题本', prompt: '把这轮讲过的题收进错题本，标注我的错因' },
  { label: '安排今天', prompt: '根据我现在的进度，帮我调整今天的学习任务' },
];

// 续写指令只随请求发给模型，不落库、不展示，避免污染对话记录
const CONTINUE_PROMPT = '请从上面中断的位置继续输出，不要重复已经写过的内容，不要重新开头，也不要解释自己在续写。';

const parseMeta = (raw) => {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
};

const normalizeRow = (row) => ({
  id: row.id,
  role: row.role,
  content: row.content || '',
  createdAt: row.created_at,
  meta: parseMeta(row.meta),
});

const stripCitations = (text) => String(text || '').replace(/\[\[C\d+\]\]/g, '');

const CARD = {
  border: '1px solid var(--line)',
  borderRadius: 12,
  background: 'var(--surface)',
};

const BTN = (primary) => ({
  padding: '6px 12px',
  borderRadius: 8,
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  border: primary ? '1px solid var(--accent)' : '1px solid var(--line)',
  background: primary ? 'var(--accent)' : 'var(--surface-soft)',
  color: primary ? 'var(--ai-on-accent)' : 'var(--text)',
});

function Modal({ title, children, onClose, footer }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(8,14,24,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
      <div style={{ width: 'min(620px, 100%)', maxHeight: '82vh', overflow: 'auto', ...CARD, padding: 20, background: 'var(--surface-elevated)' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
          <strong style={{ fontSize: 14 }}>{title}</strong>
          <button type="button" onClick={onClose} style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 16 }}>×</button>
        </div>
        {children}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>{footer}</div>
      </div>
    </div>
  );
}

export default function AIConversation({ onNavigate, incomingSubjectId = '', onOpenSettings, onOpenAnalysis }) {
  const { toast, confirm, prompt } = useDialog();
  const [subjects, setSubjects] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [activeId, setActiveId] = useState('');
  const [messages, setMessages] = useState([]);
  // 去设置配好 AI 再回来时，不丢掉已经打了一半的问题
  const [input, setInput] = useState(() => {
    try { return sessionStorage.getItem(DRAFT_KEY) || ''; } catch { return ''; }
  });
  const [images, setImages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [subjectId, setSubjectId] = useState(incomingSubjectId || '');
  const [pinnedContext, setPinnedContext] = useState(null);
  const [citation, setCitation] = useState(null);
  const [modal, setModal] = useState(null);
  const [imageStats, setImageStats] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [planChoices, setPlanChoices] = useState({});
  // 会话搜索：null 表示未搜索，直接用全量列表
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [editing, setEditing] = useState(null);
  // 每条用户消息选中的回答版本下标；缺省展示最新一版
  const [versionPick, setVersionPick] = useState({});
  const [showJump, setShowJump] = useState(false);
  const [streamMode, setStreamMode] = useState('new');
  // 当前科目可用的学科分析插件（按科目匹配 + 已启用）；为空时完全不出现入口
  const [analysisPlugins, setAnalysisPlugins] = useState([]);

  const activeIdRef = useRef('');
  const loadingRef = useRef(false);
  const requestIdRef = useRef('');
  const streamTextRef = useRef('');
  const listRef = useRef(null);
  const fileRef = useRef(null);
  const inputRef = useRef(null);
  // 「问 AI」带入问题后聚焦输入框，让用户直接按 Enter 发送
  const focusInputRef = useRef(false);
  const planBuildingRef = useRef(new Set());
  const pendingRef = useRef(null);
  const stickRef = useRef(true);
  const searchQueryRef = useRef('');
  // 「问 AI」带过来的题目所属科目：创建会话时直接写进 subject_id
  const pendingSubjectRef = useRef('');

  useEffect(() => {
    try {
      if (input) sessionStorage.setItem(DRAFT_KEY, input);
      else sessionStorage.removeItem(DRAFT_KEY);
    } catch { /* 存不下只影响跨页保留草稿 */ }
  }, [input]);

  // 每次进入页面重新判断：用户可能刚从设置里配置好模型
  const assistantConfigured = isAssistantConfigured();

  const loadSubjects = useCallback(async () => {
    try {
      const list = await window.openexam?.subject?.list?.();
      setSubjects(Array.isArray(list) ? list : []);
    } catch { setSubjects([]); }
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const list = await window.openexam?.db?.getAIChatSessions?.(100);
      const rows = Array.isArray(list) ? list : [];
      setSessions(rows);
      return rows;
    } catch {
      setSessions([]);
      return [];
    }
  }, []);

  const loadMessages = useCallback(async (sessionId) => {
    if (!sessionId) { setMessages([]); return; }
    try {
      const rows = await window.openexam?.db?.getAIChatMessages?.(sessionId, 500);
      setMessages(Array.isArray(rows) ? rows.map(normalizeRow) : []);
    } catch {
      setMessages([]);
    }
  }, []);

  // 搜索态下刷新列表要连搜索结果一起重算，否则重命名 / 置顶后列表还是旧的
  const refreshList = useCallback(async () => {
    const rows = await loadSessions();
    const keyword = searchQueryRef.current.trim();
    if (keyword) {
      try {
        const found = await window.openexam?.db?.searchAIChatSessions?.(keyword, 100);
        setSearchResults(Array.isArray(found) ? found : []);
      } catch { setSearchResults([]); }
    }
    return rows;
  }, [loadSessions]);

  useEffect(() => {
    searchQueryRef.current = searchQuery;
    const keyword = searchQuery.trim();
    if (!keyword) {
      setSearchResults(null);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const found = await window.openexam?.db?.searchAIChatSessions?.(keyword, 100);
        if (!cancelled) setSearchResults(Array.isArray(found) ? found : []);
      } catch {
        if (!cancelled) setSearchResults([]);
      }
    }, 220);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [searchQuery]);

  const selectSession = useCallback(async (sessionId, rows = []) => {
    const target = rows.find((item) => item.id === sessionId);
    setActiveId(sessionId || '');
    activeIdRef.current = sessionId || '';
    setVersionPick({});
    setEditing(null);
    setPinnedContext(parseMeta(target?.context_json)?.questionId ? parseMeta(target.context_json) : null);
    if (sessionId) {
      localStorage.setItem(ACTIVE_SESSION_KEY, sessionId);
      await loadMessages(sessionId);
      try {
        const stats = await window.openexam?.aiChat?.imageStats?.(sessionId);
        setImageStats(stats || null);
      } catch { setImageStats(null); }
    } else {
      setMessages([]);
    }
    stickRef.current = true;
    setShowJump(false);
  }, [loadMessages]);

  useEffect(() => {
    let cancelled = false;

    // 先同步消费「题目页问 AI」写入的 localStorage，再做 IPC 刷新。
    // 之前放在 await 之后，用户在加载期间按回车会丢掉题目上下文（第一轮答「没收到题目」）。
    let pendingAsk = null;
    try {
      const rawAsk = localStorage.getItem(AUTOFILL_KEY);
      if (rawAsk) {
        pendingAsk = JSON.parse(rawAsk);
        localStorage.removeItem(AUTOFILL_KEY);
      }
    } catch { /* 忽略 */ }

    // 工作台「返回会话 / 记入笔记」带回的一次性恢复信息
    let returnSessionId = '';
    let prefillPrompt = '';
    try {
      returnSessionId = String(localStorage.getItem(RETURN_SESSION_KEY) || '').trim();
      const rawPrefill = localStorage.getItem(PREFILL_KEY);
      if (rawPrefill) {
        prefillPrompt = String(JSON.parse(rawPrefill)?.prompt || '');
      }
    } catch { /* 忽略 */ }
    try {
      localStorage.removeItem(RETURN_SESSION_KEY);
      localStorage.removeItem(PREFILL_KEY);
    } catch { /* 忽略 */ }

    // 只有确实带着「待提问」时才恢复题目上下文；否则保持空白新会话，避免挂上上次的旧题
    if (pendingAsk?.prompt) {
      // 题库新提问优先：清掉工作台带回的会话恢复信息
      returnSessionId = '';
      prefillPrompt = '';
      let pendingContext = null;
      try {
        const raw = localStorage.getItem(QUESTION_CONTEXT_KEY);
        pendingContext = raw ? JSON.parse(raw) : null;
      } catch { /* 忽略 */ }

      if (pendingContext?.questionId) {
        setPinnedContext(pendingContext);
        localStorage.removeItem(QUESTION_CONTEXT_KEY);
        const nextSubject = String(pendingContext.subjectId || pendingContext.subject_id || '').trim();
        if (nextSubject) {
          pendingSubjectRef.current = nextSubject;
          setSubjectId(nextSubject);
        }
      }

      // 从题库跳过来必须是一次独立提问：清掉当前会话与消息，发送时新建会话
      setActiveId('');
      activeIdRef.current = '';
      setMessages([]);
      setStreamText('');
      streamTextRef.current = '';
      setEditing(null);
      localStorage.removeItem(ACTIVE_SESSION_KEY);
      setInput(String(pendingAsk.prompt));
      focusInputRef.current = true;
      if (!isAssistantConfigured()) {
        toast({
          title: 'AI 还没配置',
          message: '题目已带入，但讲题需要模型：请到「设置 → AI 模型」配置「老师」或「识图」角色。',
          tone: 'warning',
        });
      }
    }

    (async () => {
      await loadSubjects();
      // 只刷新左侧会话列表，不自动恢复上一次会话：打开助教页默认就是空白新会话
      const rows = await loadSessions();
      if (cancelled) return;
      if (returnSessionId) {
        const target = rows.find((item) => item.id === returnSessionId);
        if (target) {
          await selectSession(returnSessionId, rows);
          if (target.subject_id) setSubjectId(target.subject_id);
        }
      }
      if (prefillPrompt) {
        setInput(prefillPrompt);
        focusInputRef.current = true;
      }
    })();
    return () => { cancelled = true; };
  }, [loadSessions, loadSubjects, selectSession, toast]);

  // 预填问题后把焦点交给输入框；等 React 把 value 写进 textarea 再聚焦
  useEffect(() => {
    if (!focusInputRef.current) return;
    focusInputRef.current = false;
    const timer = setTimeout(() => inputRef.current?.focus?.(), 60);
    return () => clearTimeout(timer);
  }, [input]);

  useEffect(() => {
    if (incomingSubjectId) setSubjectId(incomingSubjectId);
  }, [incomingSubjectId]);

  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  useEffect(() => { loadingRef.current = loading; }, [loading]);
  useEffect(() => { streamTextRef.current = streamText; }, [streamText]);

  // 只有用户本来就贴着底部时才自动跟随，否则不打断向上翻阅
  useEffect(() => {
    if (!listRef.current || !stickRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, streamText]);

  const handleListScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distance < 80;
    stickRef.current = nearBottom;
    setShowJump(!nearBottom);
  }, []);

  const jumpToBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    stickRef.current = true;
    setShowJump(false);
  }, []);

  /**
   * 一问多答：回答按 meta.replyTo 归到对应的用户消息下。
   * 老数据没有 replyTo 时按位置回退到上一条用户消息，保证历史会话照常显示。
   */
  const groups = useMemo(() => {
    const list = [];
    const byUserId = new Map();
    let current = null;
    for (const message of messages) {
      if (message.role === 'user') {
        const group = { user: message, replies: [] };
        list.push(group);
        byUserId.set(message.id, group);
        current = group;
        continue;
      }
      const target = message.meta?.replyTo ? byUserId.get(message.meta.replyTo) : null;
      if (target) { target.replies.push(message); continue; }
      if (current) { current.replies.push(message); continue; }
      list.push({ user: null, replies: [message] });
    }
    return list;
  }, [messages]);

  const pickReply = useCallback((group) => {
    if (!group?.replies?.length) return null;
    const total = group.replies.length;
    const chosen = group.user ? versionPick[group.user.id] : undefined;
    const index = Number.isInteger(chosen) ? Math.min(Math.max(chosen, 0), total - 1) : total - 1;
    return { message: group.replies[index], index, total };
  }, [versionPick]);

  /**
   * 生成上下文：按轮次取当前展示的那版回答，跳过被中断的残稿。
   * includeUser=false 时停在指定用户消息之前（编辑重发用，等价于从这条消息分叉）。
   */
  const buildHistory = useCallback((upToUserId, { includeUser = true } = {}) => {
    const out = [];
    for (const group of groups) {
      if (group.user && upToUserId && group.user.id === upToUserId) {
        if (includeUser) out.push({ role: 'user', content: group.user.content });
        break;
      }
      if (group.user) out.push({ role: 'user', content: group.user.content });
      const picked = pickReply(group);
      if (picked?.message?.content && !picked.message.meta?.interrupted) {
        out.push({ role: 'assistant', content: picked.message.content });
      }
    }
    return out;
  }, [groups, pickReply]);

  const patchMessage = useCallback((messageId, patch) => {
    setMessages((prev) => prev.map((item) => (item.id === messageId ? { ...item, meta: { ...item.meta, ...patch } } : item)));
  }, []);

  const saveAssistantMessage = useCallback(async ({ sessionId, replyTo, content, meta }) => {
    const payloadMeta = { ...meta };
    if (replyTo) payloadMeta.replyTo = replyTo;
    try {
      const saved = await window.openexam.db.addAIChatMessage({ sessionId, role: 'assistant', content, meta: payloadMeta });
      const row = normalizeRow(saved);
      // 生成期间用户可能已经切到别的会话，别把消息追加到当前列表里
      if (activeIdRef.current === sessionId) setMessages((prev) => [...prev, row]);
      return row;
    } catch (error) {
      toast({ title: '保存回复失败', message: error?.message || String(error), tone: 'warning' });
      return null;
    }
  }, [toast]);

  const handleEvent = useCallback(async (payload) => {
    if (!payload || payload.requestId !== requestIdRef.current) return;
    if (payload.type === 'delta') {
      const next = streamTextRef.current + String(payload.delta || '');
      streamTextRef.current = next;
      setStreamText(next);
      return;
    }

    const pending = pendingRef.current;
    if (payload.type === 'cancelled') {
      setLoading(false);
      loadingRef.current = false;
      // 中断前已经吐出来的内容落库为「中断版」，用户可以据此继续生成
      const partial = String(streamTextRef.current || '').trim();
      setStreamText('');
      streamTextRef.current = '';
      requestIdRef.current = '';
      pendingRef.current = null;
      setStreamMode('new');
      if (partial && pending?.sessionId) {
        await saveAssistantMessage({
          sessionId: pending.sessionId,
          replyTo: pending.replyTo,
          content: (pending.prefix || '') + partial,
          meta: { interrupted: true, model: '', role: '' },
        });
        if (pending.replyTo) {
          setVersionPick((prev) => {
            if (!(pending.replyTo in prev)) return prev;
            const next = { ...prev };
            delete next[pending.replyTo];
            return next;
          });
        }
        await refreshList();
      }
      toast({ message: '已停止生成', tone: 'info' });
      return;
    }
    if (payload.type === 'error') {
      setLoading(false);
      loadingRef.current = false;
      setStreamText('');
      streamTextRef.current = '';
      requestIdRef.current = '';
      pendingRef.current = null;
      setStreamMode('new');
      toast({ title: 'AI 请求失败', message: payload.error || '未知错误', tone: 'danger' });
      return;
    }
    if (payload.type !== 'done') return;

    setLoading(false);
    loadingRef.current = false;
    const sessionId = pending?.sessionId || activeIdRef.current;
    const text = String(payload.content || '').trim();
    requestIdRef.current = '';
    pendingRef.current = null;
    setStreamMode('new');
    if (!sessionId || !text) { setStreamText(''); streamTextRef.current = ''; return; }
    const meta = {
      citations: payload.citations || [],
      action: payload.action || null,
      actionStatus: payload.action ? 'pending' : '',
      actionResult: '',
      model: payload.model || '',
      role: payload.role || '',
    };
    await saveAssistantMessage({
      sessionId,
      replyTo: pending?.replyTo || '',
      content: (pending?.prefix || '') + text,
      meta,
    });
    // 新一轮回答落库后回到最新版本，避免用户停留在旧版上以为没生成
    if (pending?.replyTo) {
      setVersionPick((prev) => {
        if (!(pending.replyTo in prev)) return prev;
        const next = { ...prev };
        delete next[pending.replyTo];
        return next;
      });
    }
    setStreamText('');
    streamTextRef.current = '';
    if (payload.warning) toast({ message: payload.warning, tone: 'info' });
    await refreshList();
  }, [refreshList, saveAssistantMessage, toast]);

  useEffect(() => {
    const off = window.openexam?.aiChat?.onEvent?.(handleEvent);
    return () => off?.();
  }, [handleEvent]);

  /** 统一发起一次生成；replyTo 指向这条回答所属的用户消息 */
  const startGeneration = useCallback(async ({ history, replyTo, sessionId, sendImages = [], prefix = '', mode = 'new' }) => {
    const requestId = `aichat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    requestIdRef.current = requestId;
    pendingRef.current = { sessionId, replyTo: replyTo || '', prefix: prefix || '' };
    streamTextRef.current = '';
    setStreamText('');
    setStreamMode(mode);
    setLoading(true);
    loadingRef.current = true;

    // 会话已有绑定科目时以会话为准：插件注入、题库回写都依赖这个 id，
    // 否则打开历史会话但没有重新选科目时，模型看不到学科分析插件。
    const sessionSubjectId = sessions.find((item) => item.id === sessionId)?.subject_id || subjectId || null;
    const res = await window.openexam.aiChat.chatStreamStart({
      requestId,
      sessionId,
      settings: getAISettings(),
      messages: history,
      images: sendImages.map(({ base64, mimeType }) => ({ base64, mimeType })),
      subjectId: sessionSubjectId,
      questionContext: pinnedContext || null,
    });
    if (!res?.success) {
      setLoading(false);
      loadingRef.current = false;
      setStreamMode('new');
      requestIdRef.current = '';
      pendingRef.current = null;
      toast({ title: '发送失败', message: res?.error || '未知错误', tone: 'danger' });
    }
    await refreshList();
  }, [pinnedContext, refreshList, sessions, subjectId, toast]);

  const ensureSession = useCallback(async (firstText) => {
    if (activeIdRef.current) return activeIdRef.current;
    // 从题目页过来时用「第 N 题 · 试卷名」做标题，比统一的提问模板更好检索
    const title = pinnedContext
      ? `第${pinnedContext.index || '?'}题 · ${String(pinnedContext.paperTitle || '答疑').trim()}`.slice(0, 40)
      : (String(firstText || '').replace(/\s+/g, ' ').trim().slice(0, 24) || '新会话');
    // 科目：优先左侧选择器（用户在界面上可改），其次题目上下文带来的科目
    const sessionSubjectId = subjectId || pendingSubjectRef.current || null;
    const session = await window.openexam.db.createAIChatSession({ title, subjectId: sessionSubjectId });
    pendingSubjectRef.current = '';
    const rows = await loadSessions();
    setActiveId(session.id);
    activeIdRef.current = session.id;
    localStorage.setItem(ACTIVE_SESSION_KEY, session.id);
    setSessions(rows.length ? rows : [session]);
    return session.id;
  }, [loadSessions, pinnedContext, subjectId]);

  /**
   * 打开分析工作台前先把会话落实：
   * 从题库「问 AI」过来时可能还没发过消息、没有会话，如果直接打开工作台，
   * 求解结果就没有会话可绑定，这道题也就不会被记录。
   * 这里先建会话并把锁定题目写进 context，再带着 sessionId / questionId 进入工作台。
   */
  const openAnalysisWithSession = useCallback(async (pluginIdentifier, seedBase = {}) => {
    if (!onOpenAnalysis) return;
    let sessionId = activeIdRef.current || activeId || '';
    const question = pinnedContext;
    const seedText = String(seedBase?.text || '').trim();
    if (!sessionId && (question?.questionId || seedText)) {
      try {
        sessionId = await ensureSession(seedText || String(question?.content || ''));
        if (question?.questionId) {
          await window.openexam.aiChat.setSessionContext({ sessionId, context: question });
          localStorage.removeItem(QUESTION_CONTEXT_KEY);
        }
      } catch (error) {
        toast({ title: '创建会话失败', message: error?.message || String(error), tone: 'danger' });
      }
    }
    const sessionSubjectId = sessions.find((item) => item.id === sessionId)?.subject_id
      || subjectId
      || pinnedContext?.subjectId
      || '';
    onOpenAnalysis(pluginIdentifier, {
      ...seedBase,
      sessionId,
      subjectId: sessionSubjectId,
      questionId: String(question?.questionId || ''),
    });
  }, [activeId, ensureSession, onOpenAnalysis, pinnedContext, sessions, subjectId, toast]);

  const addImages = useCallback(async (files) => {
    const incoming = Array.from(files || []).slice(0, MAX_ASSISTANT_IMAGES);
    const next = [];
    for (const file of incoming) {
      try {
        const { base64, mimeType } = await readFileAsBase64(file);
        if (base64) next.push({ base64, mimeType, dataUrl: `data:${mimeType};base64,${base64}` });
      } catch (error) {
        toast({ title: '图片读取失败', message: error?.message || String(error), tone: 'warning' });
      }
    }
    if (!next.length) return;
    setImages((prev) => {
      const merged = [...prev, ...next].slice(0, MAX_ASSISTANT_IMAGES);
      if (prev.length + next.length > MAX_ASSISTANT_IMAGES) {
        toast({ message: `一次最多 ${MAX_ASSISTANT_IMAGES} 张图片`, tone: 'info' });
      }
      return merged;
    });
  }, [toast]);

  /** 手机端已按同一套规则校验过格式与大小，这里只负责并入输入区并限流 */
  const addPhoneImages = useCallback((incoming) => {
    const list = Array.isArray(incoming) ? incoming.filter((item) => item?.base64) : [];
    if (!list.length) return;
    setImages((prev) => {
      const merged = [...prev, ...list].slice(0, MAX_ASSISTANT_IMAGES);
      if (prev.length + list.length > MAX_ASSISTANT_IMAGES) {
        toast({ message: `一次最多 ${MAX_ASSISTANT_IMAGES} 张图片，多余的已忽略`, tone: 'info' });
      }
      return merged;
    });
    toast({ message: `已收到手机发来的 ${list.length} 张图片`, tone: 'success' });
  }, [toast]);

  const send = useCallback(async (override) => {
    if (loadingRef.current) return;
    const text = String(override ?? input).trim();
    const attached = images;
    if (!text && !attached.length) return;
    if (!isAssistantConfigured()) {
      toast({ title: '还没配置 AI 模型', message: '请到「设置 → AI 模型」给「老师」或「识图」角色配置模型。', tone: 'warning' });
      return;
    }

    const sessionId = await ensureSession(text);
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    let storedImages = [];
    if (attached.length) {
      try {
        const saved = await window.openexam.aiChat.saveMessageImages({ sessionId, messageId, images: attached });
        storedImages = saved?.images || [];
      } catch { /* 图片落盘失败不影响本轮提问 */ }
    }

    try {
      const saved = await window.openexam.db.addAIChatMessage({
        id: messageId,
        sessionId,
        role: 'user',
        content: text,
        meta: { images: storedImages },
      });
      setMessages((prev) => [...prev, normalizeRow(saved)]);
    } catch (error) {
      toast({ title: '消息保存失败', message: error?.message || String(error), tone: 'danger' });
      return;
    }

    if (pinnedContext) {
      await window.openexam.aiChat.setSessionContext({ sessionId, context: pinnedContext });
      // 上下文已写进会话，清掉全局临时值，避免下一次新会话串题
      localStorage.removeItem(QUESTION_CONTEXT_KEY);
    }

    const history = [...buildHistory(null), { role: 'user', content: text }];
    setInput('');
    setImages([]);
    await startGeneration({ history, replyTo: messageId, sessionId, sendImages: attached });
  }, [buildHistory, ensureSession, images, input, pinnedContext, startGeneration, toast]);

  /** 重新生成：用这条用户消息之前的上下文再来一次，结果作为新版本追加 */
  const regenerate = useCallback(async (userMessage) => {
    if (loadingRef.current) {
      toast({ message: '正在生成，先停止再重新生成', tone: 'info' });
      return;
    }
    if (!isAssistantConfigured()) {
      toast({ title: '还没配置 AI 模型', message: '请到「设置 → AI 模型」给「老师」或「识图」角色配置模型。', tone: 'warning' });
      return;
    }
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    const history = buildHistory(userMessage.id);
    if (!history.length) return;
    await startGeneration({ history, replyTo: userMessage.id, sessionId });
  }, [buildHistory, startGeneration, toast]);

  const beginEdit = useCallback((message) => {
    setEditing({ id: message.id, text: message.content });
  }, []);

  /** 编辑后重发：保留原消息，新消息以 editedFrom 指向旧版，回答作为新的一轮追加 */
  const submitEdit = useCallback(async () => {
    const nextText = String(editing?.text || '').trim();
    if (!nextText || !editing) return;
    if (loadingRef.current) {
      toast({ message: '正在生成，先停止再编辑重发', tone: 'info' });
      return;
    }
    if (!isAssistantConfigured()) {
      toast({ title: '还没配置 AI 模型', message: '请到「设置 → AI 模型」给「老师」或「识图」角色配置模型。', tone: 'warning' });
      return;
    }
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    try {
      const saved = await window.openexam.db.addAIChatMessage({
        id: messageId,
        sessionId,
        role: 'user',
        content: nextText,
        meta: { editedFrom: editing.id },
      });
      setMessages((prev) => [...prev, normalizeRow(saved)]);
    } catch (error) {
      toast({ title: '消息保存失败', message: error?.message || String(error), tone: 'danger' });
      return;
    }
    const history = [...buildHistory(editing.id, { includeUser: false }), { role: 'user', content: nextText }];
    setEditing(null);
    await startGeneration({ history, replyTo: messageId, sessionId });
  }, [buildHistory, editing, startGeneration, toast]);

  /** 继续生成：把中断版当助手前缀，追加一条不可见的续写指令，结果并入新版 */
  const continueReply = useCallback(async (userMessage, replyMessage) => {
    if (loadingRef.current) return;
    if (!isAssistantConfigured()) {
      toast({ title: '还没配置 AI 模型', message: '请到「设置 → AI 模型」给「老师」或「识图」角色配置模型。', tone: 'warning' });
      return;
    }
    const sessionId = activeIdRef.current;
    if (!sessionId || !replyMessage?.content) return;
    const history = [
      ...buildHistory(userMessage?.id || null),
      { role: 'assistant', content: replyMessage.content },
      { role: 'user', content: CONTINUE_PROMPT },
    ];
    await startGeneration({
      history,
      replyTo: userMessage?.id || '',
      sessionId,
      prefix: replyMessage.content,
      mode: 'continue',
    });
  }, [buildHistory, startGeneration, toast]);

  const copyMessage = useCallback(async (message) => {
    const raw = String(message?.content || '');
    // 复制时去掉引用角标，粘贴到别处不会留下 [[C1]] 这类标记
    const text = message?.role === 'assistant' ? stripCitations(raw) : raw;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast({ message: '已复制这条消息', tone: 'success' });
    } catch {
      toast({ message: '复制失败，请手动选中文本', tone: 'warning' });
    }
  }, [toast]);

  const stop = useCallback(async () => {
    if (!requestIdRef.current) return;
    try { await window.openexam?.aiChat?.chatStreamCancel?.(requestIdRef.current); } catch { /* 忽略 */ }
  }, []);

  // Esc 停止生成；输入框里正在用中文输入法组词时不拦截
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== 'Escape' || !loadingRef.current) return;
      event.preventDefault();
      stop();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [stop]);

  const newSession = useCallback(async () => {
    pendingSubjectRef.current = '';
    setActiveId('');
    activeIdRef.current = '';
    setMessages([]);
    setPinnedContext(null);
    setStreamText('');
    streamTextRef.current = '';
    setVersionPick({});
    setEditing(null);
    localStorage.removeItem(ACTIVE_SESSION_KEY);
  }, []);

  const renameSession = useCallback(async (session) => {
    const next = await prompt({
      title: '重命名会话',
      message: '给这段对话起个方便找的名字',
      defaultValue: session.title || '',
      confirmText: '保存',
    });
    if (!next) return;
    await window.openexam.db.renameAIChatSession(session.id, next);
    await refreshList();
  }, [prompt, refreshList]);

  const togglePin = useCallback(async (session) => {
    const pinned = !session.pinned_at;
    await window.openexam.db.setAIChatSessionPinned(session.id, pinned);
    await refreshList();
    toast({ message: pinned ? '已置顶' : '已取消置顶', tone: 'info' });
  }, [refreshList, toast]);

  const deleteSession = useCallback(async (session) => {
    const ok = await confirm({
      title: '删除会话',
      message: `删除「${session.title}」及其中的图片？此操作不可撤销。`,
      confirmText: '删除',
      tone: 'danger',
    });
    if (!ok) return;
    await window.openexam.db.deleteAIChatSession(session.id);
    const rows = await refreshList();
    if (session.id === activeIdRef.current) {
      if (rows[0]) await selectSession(rows[0].id, rows);
      else await newSession();
    }
  }, [confirm, newSession, refreshList, selectSession]);

  const cleanupImages = useCallback(async () => {
    const res = await window.openexam?.aiChat?.cleanupImages?.();
    if (res?.success) {
      toast({ message: `已清理到每个会话最多 200 张（共处理 ${res.sessions} 个会话）`, tone: 'success' });
      if (activeId) {
        const stats = await window.openexam.aiChat.imageStats(activeId);
        setImageStats(stats || null);
      }
    } else {
      toast({ message: res?.error || '清理失败', tone: 'warning' });
    }
  }, [activeId, toast]);

  const effectiveSubjectId = useMemo(
    () => sessions.find((item) => item.id === activeId)?.subject_id || subjectId || '',
    [sessions, activeId, subjectId],
  );

  // 只有「科目匹配 + 插件启用」才拿得到插件；不需要时入口不出现
  useEffect(() => {
    let alive = true;
    if (!effectiveSubjectId || !window.openexam?.plugins?.forSubject) {
      setAnalysisPlugins([]);
      return () => { alive = false; };
    }
    window.openexam.plugins.forSubject(effectiveSubjectId)
      .then((res) => { if (alive) setAnalysisPlugins(res?.success ? (res.plugins || []) : []); })
      .catch(() => { if (alive) setAnalysisPlugins([]); });
    return () => { alive = false; };
  }, [effectiveSubjectId]);

  const actionCtx = useMemo(() => ({
    subjectId: sessions.find((item) => item.id === activeId)?.subject_id || subjectId,
    subjects,
    toast,
    onNavigate,
    loadSubjects,
    settings: getAISettings(),
    isConfigured: assistantConfigured,
  }), [sessions, activeId, subjectId, subjects, toast, onNavigate, loadSubjects, assistantConfigured]);

  // 计划只读生成：不写库、不调用模型；用户确认后才真正执行
  useEffect(() => {
    for (const message of messages) {
      const action = message.meta?.action;
      if (!action) continue;
      // 打开插件不是写库动作，不生成执行计划，卡片里直接给入口
      if (action.type === 'run_analysis_plugin') continue;
      if (message.meta.actionStatus && message.meta.actionStatus !== 'pending') continue;
      if (message.meta.actionPlan) continue;
      if (planBuildingRef.current.has(message.id)) continue;
      planBuildingRef.current.add(message.id);
      buildActionPlan(action, actionCtx)
        .then((plan) => patchMessage(message.id, { actionPlan: plan }))
        .catch((error) => patchMessage(message.id, {
          actionPlan: { type: action.type, label: describeAction(action).label, error: error?.message || String(error) },
        }))
        .finally(() => { planBuildingRef.current.delete(message.id); });
    }
  }, [messages, actionCtx, patchMessage]);

  const choosePlan = useCallback(async (message, plan, value) => {
    if (!plan || !value) return;
    setPlanChoices((prev) => ({ ...prev, [message.id]: { field: plan.choiceField || 'noteId', value } }));
    const nextAction = { ...message.meta.action };
    if (plan.choiceField === 'section') nextAction.section = value;
    else {
      nextAction.noteId = value;
      nextAction.titleQuery = '';
    }
    try {
      const next = await buildActionPlan(nextAction, actionCtx);
      patchMessage(message.id, { actionPlan: next });
    } catch {
      // 重新生成计划失败时保留原计划，用户仍可取消
    }
  }, [actionCtx, patchMessage]);

  const runAction = useCallback(async (message) => {
    const baseAction = message?.meta?.action;
    if (!baseAction) return;
    const plan = message.meta?.actionPlan || null;
    const choice = planChoices[message.id];
    const choiceValue = plan && choice?.field === plan.choiceField ? choice.value : '';
    if (plan?.needsChoice && !choiceValue) {
      toast({ message: '请先在计划里选择要修改的目标', tone: 'warning' });
      return;
    }
    if (plan?.error && !plan?.needsChoice) {
      toast({ message: plan.error, tone: 'warning' });
      return;
    }

    const action = { ...baseAction };
    if (choiceValue && plan?.choiceField === 'noteId') {
      action.noteId = choiceValue;
      action.titleQuery = '';
    }
    if (choiceValue && plan?.choiceField === 'section') {
      action.section = choiceValue;
    }

    patchMessage(message.id, { actionStatus: 'applying', actionResult: '' });
    try {
      const result = await applyAIAction(action, { ...actionCtx, plan });
      const summary = typeof result === 'string' ? result : (result?.summary || '');
      const extraMeta = result && typeof result === 'object' ? (result.extraMeta || {}) : {};
      const meta = { ...message.meta, actionStatus: 'done', actionResult: summary, ...extraMeta };
      await window.openexam.aiChat.updateMessageMeta({ messageId: message.id, meta });
      setMessages((prev) => prev.map((item) => (item.id === message.id ? { ...item, meta } : item)));
    } catch (error) {
      const meta = { ...message.meta, actionStatus: 'error', actionResult: `执行失败：${error?.message || String(error)}` };
      await window.openexam.aiChat.updateMessageMeta({ messageId: message.id, meta });
      setMessages((prev) => prev.map((item) => (item.id === message.id ? { ...item, meta } : item)));
      toast({ title: '动作执行失败', message: error?.message || String(error), tone: 'danger' });
    }
  }, [actionCtx, patchMessage, planChoices, toast]);

  const ignoreAction = useCallback(async (message) => {
    // 取消：只更新本地状态，不发起任何写入请求
    const meta = { ...message.meta, actionStatus: 'ignored', actionResult: '' };
    await window.openexam.aiChat.updateMessageMeta({ messageId: message.id, meta });
    setMessages((prev) => prev.map((item) => (item.id === message.id ? { ...item, meta } : item)));
  }, []);

  const lastUserText = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'user' && messages[index].content) return messages[index].content;
    }
    return '';
  }, [messages]);

  const openBankModal = (message) => {
    setModal({
      type: 'bank',
      message,
      title: `AI 答疑 · ${new Date().toLocaleDateString('zh-CN')}`,
      content: pinnedContext?.content || lastUserText,
      answer: pinnedContext?.answer || '',
      analysis: stripCitations(message.content),
      options: pinnedContext?.options || [],
      category: pinnedContext?.category || 'xingce',
    });
  };

  const openNoteModal = (message) => {
    setModal({
      type: 'note',
      message,
      title: pinnedContext ? `第${pinnedContext.index || '?'}题 · ${pinnedContext.paperTitle || '答疑笔记'}` : 'AI 答疑笔记',
      content: message.content,
    });
  };

  const saveModal = async () => {
    if (!modal) return;
    try {
      if (modal.type === 'bank') {
        const result = await window.openexam.db.importPaper(
          {
            title: modal.title || 'AI 答疑题目',
            subject: modal.category || 'xingce',
            category: modal.category || 'xingce',
            subjectId: subjectId || null,
            type: 'imported',
          },
          [{
            type: pinnedContext?.type || 'single',
            content: modal.content,
            options: modal.options,
            answer: modal.answer,
            analysis: modal.analysis,
            category: modal.category,
          }],
        );
        toast({ title: '已收进题库', message: `《${result?.title || modal.title}》`, tone: 'success' });
      } else {
        const subject = subjects.find((item) => item.id === subjectId);
        await window.openexam.note.save({
          title: modal.title,
          content: modal.content,
          tags: subject ? [subject.name, '答疑笔记'] : ['AI 助教'],
          sourceType: 'subject',
          sourceId: subjectId || null,
          sourceLabel: 'AI 助教',
          subjectId: subjectId || null,
          meta: { kind: 'qa', category: 'qa', subject: subject?.name || '' },
        });
        toast({ title: '已生成笔记', message: modal.title, tone: 'success' });
      }
      setModal(null);
    } catch (error) {
      toast({ title: '保存失败', message: error?.message || String(error), tone: 'danger' });
    }
  };

  const activeSession = sessions.find((item) => item.id === activeId);
  const searching = Boolean(searchQuery.trim());
  const visibleSessions = searchResults ?? sessions;

  return (
    <section style={{ display: 'flex', gap: 0, height: '100%', minHeight: 0, borderTop: '1px solid var(--line)' }}>
      {/* 会话列表 */}
      <aside style={{ width: 224, flexShrink: 0, borderRight: '1px solid var(--line)', background: 'var(--surface)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button type="button" onClick={newSession} style={{ ...BTN(true), width: '100%' }}>＋ 新对话</button>
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="搜索标题或消息内容"
            style={{ width: '100%', padding: '6px 8px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--surface-soft)', color: 'var(--text)', fontSize: 12, boxSizing: 'border-box' }}
          />
          <button type="button" onClick={() => setImportOpen(true)} style={{ ...BTN(false), width: '100%' }}>导入外部对话</button>
          <select
            value={subjectId}
            onChange={(event) => setSubjectId(event.target.value)}
            style={{ width: '100%', padding: '6px 8px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--text)', fontSize: 12 }}
            title="新建会话时绑定的科目"
          >
            <option value="">不绑定科目</option>
            {subjects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '0 8px 8px' }}>
          {visibleSessions.map((session) => (
            <div
              key={session.id}
              onClick={() => selectSession(session.id, visibleSessions)}
              style={{
                padding: '8px 10px', borderRadius: 8, cursor: 'pointer', marginBottom: 4,
                background: session.id === activeId ? 'var(--accent-soft-bg)' : 'transparent',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ flex: 1, fontSize: 12, fontWeight: session.id === activeId ? 700 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {session.title || '新会话'}
                </span>
                <button
                  type="button"
                  title={session.pinned_at ? '取消置顶' : '置顶'}
                  onClick={(event) => { event.stopPropagation(); togglePin(session); }}
                  style={{ border: 'none', background: 'transparent', color: session.pinned_at ? 'var(--accent)' : 'var(--muted)', cursor: 'pointer', fontSize: 11, padding: 0 }}
                >{session.pinned_at ? '★' : '☆'}</button>
                <button type="button" title="重命名" onClick={(event) => { event.stopPropagation(); renameSession(session); }} style={{ border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 11 }}>✎</button>
                <button type="button" title="删除" onClick={(event) => { event.stopPropagation(); deleteSession(session); }} style={{ border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 12 }}>×</button>
              </div>
              <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
                {session.subject_id ? `${subjects.find((item) => item.id === session.subject_id)?.name || '已绑定科目'} · ` : ''}
                {session.source === 'imported' ? '导入 · ' : ''}
                {session.message_count ? `${session.message_count} 条消息` : '还没有消息'}
                {session.pinned_at ? ' · 已置顶' : ''}
              </div>
              {searching && session.match_snippet ? (
                <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {session.match_snippet}
                </div>
              ) : null}
            </div>
          ))}
          {!visibleSessions.length ? (
            <div style={{ fontSize: 11, color: 'var(--muted)', padding: 10 }}>
              {searching ? '没有匹配的会话，换个关键词试试。' : '还没有会话，直接提问就会创建。'}
            </div>
          ) : null}
        </div>
        <div style={{ padding: 10, borderTop: '1px solid var(--line)', fontSize: 10, color: 'var(--muted)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span>图片按会话保存{imageStats?.count ? `：当前 ${imageStats.count} 张` : ''}</span>
          <button type="button" onClick={cleanupImages} style={{ ...BTN(false), padding: '5px 8px', fontSize: 11 }}>清理旧图片</button>
        </div>
      </aside>

      {/* 主对话区 */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        <header style={{ padding: '14px 20px 10px', borderBottom: '1px solid var(--line)', background: 'var(--surface)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 15 }}>AI 助教</strong>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>答疑讲解 · 帮你做事</span>
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted)' }}>
              {activeSession?.subject_id ? `科目：${subjects.find((item) => item.id === activeSession.subject_id)?.name || '已绑定'}` : ''}
            </span>
          </div>
          {!assistantConfigured ? (
            <div style={{
              marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              padding: '9px 12px', borderRadius: 9, border: '1px solid var(--warning-border)',
              background: 'var(--warning-soft)', fontSize: 11.5, lineHeight: 1.6,
            }}>
              <span style={{ flex: 1, minWidth: 220 }}>
                AI 还没配置，讲题、录题和写笔记都用不了。先配置一个「老师」或「识图」角色即可。
              </span>
              <button type="button" onClick={() => onOpenSettings?.()} style={{ ...BTN(true), padding: '5px 11px' }}>
                去配置 AI
              </button>
            </div>
          ) : null}
          {pinnedContext ? (
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 8, background: 'var(--surface-soft)', border: '1px solid var(--line)' }}>
              <span style={{ fontSize: 11, color: 'var(--accent)', whiteSpace: 'nowrap' }}>当前题目</span>
              <span style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {pinnedContext.paperTitle || ''} · 第{pinnedContext.index || '?'}题 · {String(pinnedContext.content || '').slice(0, 40)}
              </span>
              <button type="button" onClick={() => setPinnedContext(null)} style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 12 }}>解除</button>
            </div>
          ) : null}
        </header>

        <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex' }}>
        <div
          ref={listRef}
          onScroll={handleListScroll}
          style={{ flex: 1, overflow: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}
        >
          {!messages.length && !streamText ? (
            <div style={{ margin: 'auto 0', maxWidth: 520 }}>
              <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.9 }}>
                把题目拍照或直接输入，我可以讲题；需要时也能帮你录题库、记错题、写笔记、调计划 —— 动作会先给你确认。
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
                {SUGGESTIONS.map((item) => (
                  <button key={item.label} type="button" onClick={() => send(item.prompt)} style={{ ...BTN(false), fontSize: 11, padding: '6px 10px' }}>
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {groups.map((group, groupIndex) => {
            const user = group.user;
            const picked = pickReply(group);
            const reply = picked?.message || null;
            const isEditing = Boolean(user && editing?.id === user.id);
            return (
              <React.Fragment key={user?.id || reply?.id || `group-${groupIndex}`}>
                {user ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                    {isEditing ? (
                      <div style={{ width: 'min(720px, 88%)', padding: 10, ...CARD, background: 'var(--surface-elevated)' }}>
                        <textarea
                          value={editing.text}
                          onChange={(event) => setEditing((prev) => (prev ? { ...prev, text: event.target.value } : prev))}
                          rows={3}
                          style={{
                            width: '100%', resize: 'vertical', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--line)',
                            background: 'var(--surface-soft)', color: 'var(--text)', fontSize: 12.5, lineHeight: 1.6, fontFamily: 'inherit', boxSizing: 'border-box',
                          }}
                        />
                        <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
                          <button type="button" onClick={() => setEditing(null)} style={BTN(false)}>取消</button>
                          <button type="button" onClick={submitEdit} disabled={!String(editing.text || '').trim()} style={{ ...BTN(true), opacity: String(editing.text || '').trim() ? 1 : 0.5 }}>保存并重发</button>
                        </div>
                      </div>
                    ) : (
                      <div style={{
                        maxWidth: 'min(720px, 88%)',
                        padding: '10px 13px',
                        borderRadius: 12,
                        background: 'var(--ai-user-bg)',
                        border: '1px solid var(--ai-user-bg)',
                        color: '#fff',
                        fontSize: 12.5,
                        lineHeight: 1.75,
                        wordBreak: 'break-word',
                        overflowWrap: 'anywhere',
                      }}>
                        {(user.meta?.images || []).length ? (
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: user.content ? 8 : 0 }}>
                            {user.meta.images.map((image) => (
                              <MessageImage key={image.path} path={image.path} />
                            ))}
                          </div>
                        ) : null}
                        <div style={{ whiteSpace: 'pre-wrap' }}>{user.content}</div>
                      </div>
                    )}
                    {!isEditing && user.content ? (
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button type="button" onClick={() => copyMessage(user)} style={{ ...BTN(false), fontSize: 11, padding: '4px 9px' }}>复制</button>
                        <button type="button" onClick={() => beginEdit(user)} style={{ ...BTN(false), fontSize: 11, padding: '4px 9px' }}>编辑</button>
                        {!group.replies.length ? (
                          <button type="button" onClick={() => regenerate(user)} style={{ ...BTN(false), fontSize: 11, padding: '4px 9px' }}>重新生成</button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {reply ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
                    {reply.content || reply.meta?.interrupted ? (
                      <div style={{
                        maxWidth: 'min(720px, 88%)',
                        padding: '10px 13px',
                        borderRadius: 12,
                        background: 'var(--surface-elevated)',
                        border: '1px solid var(--line)',
                        color: 'var(--text)',
                        fontSize: 12.5,
                        lineHeight: 1.75,
                        wordBreak: 'break-word',
                        overflowWrap: 'anywhere',
                      }}>
                        <AIMessageContent content={reply.content} citations={reply.meta?.citations || []} onOpenCitation={setCitation} />
                        {reply.meta?.interrupted ? (
                          <div style={{ marginTop: 8, fontSize: 10.5, color: 'var(--warning)' }}>这条回答在生成过程中被中断，可以继续生成。</div>
                        ) : null}
                      </div>
                    ) : null}

                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', paddingLeft: 2 }}>
                      {reply.content ? (
                        <button type="button" onClick={() => copyMessage(reply)} style={{ ...BTN(false), fontSize: 11, padding: '4px 9px' }}>复制</button>
                      ) : null}
                      {user ? (
                        <button type="button" onClick={() => regenerate(user)} style={{ ...BTN(false), fontSize: 11, padding: '4px 9px' }}>重新生成</button>
                      ) : null}
                      {reply.meta?.interrupted && user ? (
                        <button type="button" onClick={() => continueReply(user, reply)} style={{ ...BTN(false), fontSize: 11, padding: '4px 9px' }}>继续生成</button>
                      ) : null}
                      {reply.content ? (
                        <>
                          <button type="button" onClick={() => openBankModal(reply)} style={{ ...BTN(false), fontSize: 11, padding: '4px 9px' }}>收进题库</button>
                          <button type="button" onClick={() => openNoteModal(reply)} style={{ ...BTN(false), fontSize: 11, padding: '4px 9px' }}>转成笔记</button>
                        </>
                      ) : null}
                      {picked.total > 1 && user ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--muted)' }}>
                          <button
                            type="button"
                            title="上一版"
                            disabled={picked.index <= 0}
                            onClick={() => setVersionPick((prev) => ({ ...prev, [user.id]: picked.index - 1 }))}
                            style={{ ...BTN(false), padding: '2px 7px', fontSize: 11, opacity: picked.index <= 0 ? 0.45 : 1, cursor: picked.index <= 0 ? 'not-allowed' : 'pointer' }}
                          >‹</button>
                          <span>第 {picked.index + 1}/{picked.total} 版{picked.index === picked.total - 1 ? '（最新）' : ''}</span>
                          <button
                            type="button"
                            title="下一版"
                            disabled={picked.index >= picked.total - 1}
                            onClick={() => setVersionPick((prev) => ({ ...prev, [user.id]: picked.index + 1 }))}
                            style={{ ...BTN(false), padding: '2px 7px', fontSize: 11, opacity: picked.index >= picked.total - 1 ? 0.45 : 1, cursor: picked.index >= picked.total - 1 ? 'not-allowed' : 'pointer' }}
                          >›</button>
                        </div>
                      ) : null}
                    </div>

                    {reply.meta?.action ? (() => {
                      const action = reply.meta.action;
                      // 学科分析插件：不是写库动作，给一个直接进入工作台的入口
                      if (action.type === 'run_analysis_plugin') {
                        const plugin = analysisPlugins.find((item) => item.id === action.pluginId);
                        return (
                          <div style={{ maxWidth: 'min(680px, 88%)', padding: 12, ...CARD, background: 'var(--surface-elevated)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 12, fontWeight: 700 }}>学科分析 · {plugin?.name || action.pluginId}</span>
                              {plugin?.builtin ? <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, background: 'var(--accent-soft-bg)', color: 'var(--accent)', fontWeight: 600 }}>内置</span> : null}
                            </div>
                            <div style={{ marginTop: 4, fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.7 }}>
                              由插件把题干/图片转成结构化中间结果并做确定性计算；数值以代码计算为准，模型只负责讲解。
                            </div>
                            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                              {plugin ? (
                                <button
                                  type="button"
                                  style={BTN(true)}
                                  onClick={() => openAnalysisWithSession(action.pluginId, {
                                    text: [String(pinnedContext?.content || ''), String(user?.content || '')]
                                      .filter(Boolean)
                                      .join('\n\n'),
                                    images: [],
                                    sessionId: activeIdRef.current || activeId,
                                    subjectId: sessions.find((item) => item.id === (activeIdRef.current || activeId))?.subject_id || subjectId || '',
                                  })}
                                >打开分析工作台</button>
                              ) : (
                                <span style={{ fontSize: 11, color: 'var(--muted)' }}>该插件在当前科目不可用（未匹配或已禁用）</span>
                              )}
                              <button type="button" style={BTN(false)} onClick={() => ignoreAction(reply)}>取消</button>
                            </div>
                          </div>
                        );
                      }
                      const plan = reply.meta.actionPlan || null;
                      const planChoice = planChoices[reply.id];
                      const choiceValue = plan && planChoice?.field === plan.choiceField ? planChoice.value : '';
                      const pending = !reply.meta.actionStatus || reply.meta.actionStatus === 'pending';
                      const planBlocked = Boolean(plan) && (
                        (Boolean(plan.error) && !plan.needsChoice)
                        || (plan.needsChoice && !choiceValue)
                      );
                      return (
                        <div style={{ maxWidth: 'min(680px, 88%)', padding: 12, ...CARD, background: 'var(--surface-elevated)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 12, fontWeight: 700 }}>{describeAction(action).label}</span>
                            <span style={{ fontSize: 11, color: 'var(--muted)' }}>{describeAction(action).detail}</span>
                            {reply.meta.actionStatus === 'done' ? <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600, color: 'var(--ai-success)' }}>已执行</span> : null}
                            {reply.meta.actionStatus === 'ignored' ? <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted)' }}>已取消</span> : null}
                          </div>
                          {pending ? (
                            <ActionPlanView
                              plan={plan}
                              choice={planChoice}
                              onChoose={(value) => choosePlan(reply, plan, value)}
                            />
                          ) : null}
                          {reply.meta.actionResult ? (
                            <div style={{ marginTop: 8, fontSize: 11.5, color: reply.meta.actionStatus === 'error' ? 'var(--danger)' : 'var(--muted)', whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
                              {reply.meta.actionResult}
                            </div>
                          ) : null}
                          {reply.meta.actionDiff ? <ActionDiffView diff={reply.meta.actionDiff} /> : null}
                          {pending ? (
                            <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
                              <button
                                type="button"
                                disabled={!plan || planBlocked}
                                onClick={() => runAction(reply)}
                                style={{ ...BTN(true), opacity: !plan || planBlocked ? 0.5 : 1, cursor: !plan || planBlocked ? 'not-allowed' : 'pointer' }}
                              >
                                确认执行
                              </button>
                              <button type="button" onClick={() => ignoreAction(reply)} style={BTN(false)}>取消</button>
                              {!plan ? <span style={{ fontSize: 11, color: 'var(--muted)' }}>正在生成计划…</span> : null}
                            </div>
                          ) : null}
                          {reply.meta.actionStatus === 'applying' ? <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)' }}>执行中…</div> : null}
                        </div>
                      );
                    })() : null}
                  </div>
                ) : null}
              </React.Fragment>
            );
          })}

          {streamText ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
              <div style={{ maxWidth: 'min(720px, 88%)', padding: '10px 13px', borderRadius: 12, background: 'var(--surface-elevated)', border: '1px solid var(--line)', fontSize: 12.5, lineHeight: 1.75 }}>
                {streamMode === 'continue' ? <div style={{ fontSize: 10.5, color: 'var(--muted)', marginBottom: 6 }}>接着上一版继续写…</div> : null}
                <AIMessageContent content={streamText} citations={[]} />
              </div>
            </div>
          ) : null}
          {loading && !streamText ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted)' }}>
              <LuoCat size={18} className="luo-cat-bob" />
              正在思考…
            </div>
          ) : null}
        </div>
          {showJump ? (
            <button
              type="button"
              onClick={jumpToBottom}
              style={{
                position: 'absolute', bottom: 14, left: '50%', transform: 'translateX(-50%)',
                padding: '6px 12px', borderRadius: 16, border: '1px solid var(--line)',
                background: 'var(--surface-elevated)', color: 'var(--text)', fontSize: 11, cursor: 'pointer',
                boxShadow: '0 4px 14px rgba(0,0,0,0.18)', zIndex: 5,
              }}
            >
              回到底部 ↓
            </button>
          ) : null}
        </div>

        {/* 输入区 */}
        <div
          style={{ borderTop: '1px solid var(--line)', background: 'var(--surface)', padding: '10px 20px 14px' }}
          onDragOver={(event) => { event.preventDefault(); }}
          onDrop={async (event) => {
            event.preventDefault();
            await addImages(extractDroppedImages(event));
          }}
        >
          {analysisPlugins.length && onOpenAnalysis ? (
            <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>学科分析：</span>
              {analysisPlugins.map((plugin) => (
                <button
                  key={plugin.id}
                  type="button"
                  onClick={() => openAnalysisWithSession(plugin.id, {
                    text: [String(pinnedContext?.content || ''), String(input || '')].filter(Boolean).join('\n\n'),
                    images,
                    sessionId: activeIdRef.current || activeId,
                    subjectId: sessions.find((item) => item.id === (activeIdRef.current || activeId))?.subject_id || subjectId || '',
                  })}
                  style={{ ...BTN(false), padding: '4px 9px', fontSize: 11 }}
                  title={plugin.description}
                >
                  用「{plugin.name}」分析本题
                </button>
              ))}
            </div>
          ) : null}
          {images.length ? (
            <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              {images.map((image, index) => (
                <div key={`${index}-${image.dataUrl.slice(-12)}`} style={{ position: 'relative' }}>
                  <img src={image.dataUrl} alt="" style={{ width: 54, height: 54, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--line)' }} />
                  <button
                    type="button"
                    onClick={() => setImages((prev) => prev.filter((_, i) => i !== index))}
                    style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: 9, border: 'none', background: 'var(--danger)', color: '#fff', cursor: 'pointer', fontSize: 11, lineHeight: '18px', padding: 0 }}
                  >×</button>
                </div>
              ))}
            </div>
          ) : null}

          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
            <button type="button" onClick={() => fileRef.current?.click()} title="上传图片" style={{ ...BTN(false), padding: '8px 10px' }}>图片</button>
            <button type="button" onClick={() => setPhoneOpen(true)} title="手机扫码传图（同一局域网）" style={{ ...BTN(false), padding: '8px 10px' }}>手机传图</button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: 'none' }}
              onChange={async (event) => {
                await addImages(event.target.files);
                event.target.value = '';
              }}
            />
            <textarea
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onPaste={async (event) => {
                const files = extractClipboardImages(event);
                if (files.length) {
                  event.preventDefault();
                  await addImages(files);
                }
              }}
              onKeyDown={(event) => {
                // 中文输入法组词时 Enter 是在确认候选词，不能当成发送
                const composing = event.nativeEvent?.isComposing || event.isComposing || event.keyCode === 229;
                if (event.key === 'Enter' && !event.shiftKey && !composing) {
                  event.preventDefault();
                  send();
                }
              }}
              placeholder="问问题、贴题目，或让我帮你录题 / 写笔记 / 调计划（Enter 发送，Shift+Enter 换行，Esc 停止生成）"
              rows={2}
              style={{
                flex: 1, resize: 'none', padding: '9px 12px', borderRadius: 10, border: '1px solid var(--line)',
                background: 'var(--surface-soft)', color: 'var(--text)', fontSize: 12.5, lineHeight: 1.6, fontFamily: 'inherit',
              }}
            />
            {loading ? (
              <button type="button" onClick={stop} style={BTN(false)}>停止</button>
            ) : (
              <button type="button" onClick={() => send()} disabled={!input.trim() && !images.length} style={{ ...BTN(true), opacity: !input.trim() && !images.length ? 0.5 : 1 }}>发送</button>
            )}
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 6 }}>
            图片会随会话保存，每个会话最多保留 200 张；写题库、记错题、改计划等动作执行前都会先让你确认。
          </div>
        </div>
      </div>

      {citation ? <CitationSheet citation={citation} onClose={() => setCitation(null)} /> : null}

      {phoneOpen ? (
        <PhoneUploadDialog
          onClose={() => setPhoneOpen(false)}
          onImages={addPhoneImages}
          onNotice={(message) => toast({ message, tone: 'info' })}
        />
      ) : null}

      {importOpen ? (
        <AIChatImportDialog
          subjectId={activeSession?.subject_id || subjectId || ''}
          onClose={() => setImportOpen(false)}
          onImported={async (sessionId) => {
            const rows = await loadSessions();
            if (sessionId) await selectSession(sessionId, rows);
          }}
        />
      ) : null}

      {modal ? (
        <Modal
          title={modal.type === 'bank' ? '收进题库' : '转成笔记'}
          onClose={() => setModal(null)}
          footer={(
            <>
              <button type="button" onClick={() => setModal(null)} style={BTN(false)}>取消</button>
              <button type="button" onClick={saveModal} style={BTN(true)}>保存</button>
            </>
          )}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={{ fontSize: 11, color: 'var(--muted)' }}>
              标题
              <input value={modal.title} onChange={(event) => setModal({ ...modal, title: event.target.value })} style={{ display: 'block', width: '100%', marginTop: 4, padding: '7px 9px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--text)', fontSize: 12 }} />
            </label>
            <label style={{ fontSize: 11, color: 'var(--muted)' }}>
              {modal.type === 'bank' ? '题目' : '内容'}
              <textarea value={modal.content} onChange={(event) => setModal({ ...modal, content: event.target.value })} rows={4} style={{ display: 'block', width: '100%', marginTop: 4, padding: '7px 9px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--text)', fontSize: 12, fontFamily: 'inherit' }} />
            </label>
            {modal.type === 'bank' ? (
              <label style={{ fontSize: 11, color: 'var(--muted)' }}>
                答案
                <input value={modal.answer} onChange={(event) => setModal({ ...modal, answer: event.target.value })} style={{ display: 'block', width: '100%', marginTop: 4, padding: '7px 9px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--text)', fontSize: 12 }} />
              </label>
            ) : null}
            <label style={{ fontSize: 11, color: 'var(--muted)' }}>
              {modal.type === 'bank' ? '解析（来自本轮回答，可改）' : '正文'}
              <textarea value={modal.analysis || modal.content} onChange={(event) => setModal({ ...modal, analysis: event.target.value })} rows={8} style={{ display: 'block', width: '100%', marginTop: 4, padding: '7px 9px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--text)', fontSize: 12, fontFamily: 'inherit' }} />
            </label>
            <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>保存前请确认内容正确；保存后可在题库 / 笔记页继续编辑。</div>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}

function MessageImage({ path }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let alive = true;
    window.openexam?.aiChat?.readImage?.(path).then((res) => {
      if (alive && res?.success) setSrc(res.dataUrl);
    }).catch(() => {});
    return () => { alive = false; };
  }, [path]);
  if (!src) return <div style={{ width: 54, height: 54, borderRadius: 8, background: 'var(--surface-soft)' }} />;
  return <img src={src} alt="" style={{ width: 54, height: 54, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--line)' }} />;
}
