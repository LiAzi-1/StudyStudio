import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAISettings, isAssistantConfigured } from '../store/aiSettings.js';
import { useDialog } from '../components/DialogProvider.jsx';
import AIMessageContent from '../components/AIMessageContent.jsx';
import AIChatImportDialog from '../components/AIChatImportDialog.jsx';
import PhoneUploadDialog from '../components/PhoneUploadDialog.jsx';
import CitationSheet from '../components/CitationSources.jsx';
import LuoCat from '../components/LuoCat.jsx';
import { describeAction, applyAIAction } from '../utils/aiActions.js';
import {
  MAX_ASSISTANT_IMAGES,
  readFileAsBase64,
  extractClipboardImages,
  extractDroppedImages,
} from '../utils/imageInput.js';

const ACTIVE_SESSION_KEY = 'openexam_ai_active_session';
const QUESTION_CONTEXT_KEY = 'openexam_question_context';
const DRAFT_KEY = 'openexam_ai_draft_v1';

const SUGGESTIONS = [
  { label: '讲这道题', prompt: '请一步一步讲清楚这道题，指出我容易卡住的步骤' },
  { label: '总结知识点', prompt: '只总结这类题涉及的知识点和通用解题方法，不要拓展、不要延伸阅读、不要写学习建议或鼓励语，结构清晰能直接存成笔记' },
  { label: '收进错题本', prompt: '把这轮讲过的题收进错题本，标注我的错因' },
  { label: '安排今天', prompt: '根据我现在的进度，帮我调整今天的学习任务' },
];

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

export default function AIConversation({ onNavigate, incomingSubjectId = '', onOpenSettings }) {
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

  const activeIdRef = useRef('');
  const loadingRef = useRef(false);
  const requestIdRef = useRef('');
  const streamTextRef = useRef('');
  const messagesRef = useRef([]);
  const listRef = useRef(null);
  const fileRef = useRef(null);

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

  const selectSession = useCallback(async (sessionId, rows = []) => {
    const target = rows.find((item) => item.id === sessionId);
    setActiveId(sessionId || '');
    activeIdRef.current = sessionId || '';
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
  }, [loadMessages]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadSubjects();
      const rows = await loadSessions();
      if (cancelled) return;
      const saved = localStorage.getItem(ACTIVE_SESSION_KEY);
      const target = rows.find((item) => item.id === saved) || rows[0];
      if (target) await selectSession(target.id, rows);
      // 从题目页“问 AI”带过来的上下文
      try {
        const raw = localStorage.getItem(QUESTION_CONTEXT_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed?.questionId) setPinnedContext((prev) => prev || parsed);
      } catch { /* 忽略 */ }
    })();
    return () => { cancelled = true; };
  }, [loadSessions, loadSubjects, selectSession]);

  useEffect(() => {
    if (incomingSubjectId) setSubjectId(incomingSubjectId);
  }, [incomingSubjectId]);

  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  useEffect(() => { loadingRef.current = loading; }, [loading]);
  useEffect(() => { streamTextRef.current = streamText; }, [streamText]);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, streamText]);

  const patchMessage = useCallback((messageId, patch) => {
    setMessages((prev) => prev.map((item) => (item.id === messageId ? { ...item, meta: { ...item.meta, ...patch } } : item)));
  }, []);

  const handleEvent = useCallback(async (payload) => {
    if (!payload || payload.requestId !== requestIdRef.current) return;
    if (payload.type === 'delta') {
      setStreamText((prev) => prev + String(payload.delta || ''));
      return;
    }
    if (payload.type === 'cancelled') {
      setLoading(false);
      setStreamText('');
      toast({ message: '已停止生成', tone: 'info' });
      return;
    }
    if (payload.type === 'error') {
      setLoading(false);
      setStreamText('');
      toast({ title: 'AI 请求失败', message: payload.error || '未知错误', tone: 'danger' });
      return;
    }
    if (payload.type !== 'done') return;

    setLoading(false);
    const sessionId = activeIdRef.current;
    const text = String(payload.content || '').trim();
    if (!sessionId || !text) { setStreamText(''); return; }
    const meta = {
      citations: payload.citations || [],
      action: payload.action || null,
      actionStatus: payload.action ? 'pending' : '',
      actionResult: '',
      model: payload.model || '',
      role: payload.role || '',
    };
    try {
      const saved = await window.openexam.db.addAIChatMessage({ sessionId, role: 'assistant', content: text, meta });
      setMessages((prev) => [...prev, normalizeRow(saved)]);
    } catch (error) {
      toast({ title: '保存回复失败', message: error?.message || String(error), tone: 'warning' });
    }
    setStreamText('');
    if (payload.warning) toast({ message: payload.warning, tone: 'info' });
    await loadSessions();
  }, [loadSessions, toast]);

  useEffect(() => {
    const off = window.openexam?.aiChat?.onEvent?.(handleEvent);
    return () => off?.();
  }, [handleEvent]);

  const ensureSession = useCallback(async (firstText) => {
    if (activeIdRef.current) return activeIdRef.current;
    const title = String(firstText || '').replace(/\s+/g, ' ').trim().slice(0, 24) || '新会话';
    const session = await window.openexam.db.createAIChatSession({ title, subjectId: subjectId || null });
    const rows = await loadSessions();
    setActiveId(session.id);
    activeIdRef.current = session.id;
    localStorage.setItem(ACTIVE_SESSION_KEY, session.id);
    setSessions(rows.length ? rows : [session]);
    return session.id;
  }, [loadSessions, subjectId]);

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
    if (!text && !images.length) return;
    if (!isAssistantConfigured()) {
      toast({ title: '还没配置 AI 模型', message: '请到「设置 → AI 模型」给「老师」或「识图」角色配置模型。', tone: 'warning' });
      return;
    }

    const sessionId = await ensureSession(text);
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    let storedImages = [];
    if (images.length) {
      try {
        const saved = await window.openexam.aiChat.saveMessageImages({ sessionId, messageId, images });
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

    const history = [...messagesRef.current.map((item) => ({
      role: item.role,
      content: item.content,
    })), { role: 'user', content: text }];

    const requestId = `aichat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    requestIdRef.current = requestId;
    setLoading(true);
    setStreamText('');
    setInput('');
    setImages([]);

    const res = await window.openexam.aiChat.chatStreamStart({
      requestId,
      settings: getAISettings(),
      messages: history,
      images: images.map(({ base64, mimeType }) => ({ base64, mimeType })),
      subjectId: subjectId || null,
      questionContext: pinnedContext || null,
    });
    if (!res?.success) {
      setLoading(false);
      toast({ title: '发送失败', message: res?.error || '未知错误', tone: 'danger' });
    }
    await loadSessions();
  }, [ensureSession, images, input, loadSessions, messages, pinnedContext, subjectId, toast]);

  const stop = useCallback(async () => {
    if (!requestIdRef.current) return;
    try { await window.openexam?.aiChat?.chatStreamCancel?.(requestIdRef.current); } catch { /* 忽略 */ }
  }, []);

  const newSession = useCallback(async () => {
    setActiveId('');
    activeIdRef.current = '';
    setMessages([]);
    setPinnedContext(null);
    setStreamText('');
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
    await loadSessions();
  }, [loadSessions, prompt]);

  const deleteSession = useCallback(async (session) => {
    const ok = await confirm({
      title: '删除会话',
      message: `删除「${session.title}」及其中的图片？此操作不可撤销。`,
      confirmText: '删除',
      tone: 'danger',
    });
    if (!ok) return;
    await window.openexam.db.deleteAIChatSession(session.id);
    const rows = await loadSessions();
    if (session.id === activeIdRef.current) {
      if (rows[0]) await selectSession(rows[0].id, rows);
      else await newSession();
    }
  }, [confirm, loadSessions, newSession, selectSession]);

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

  const runAction = useCallback(async (message) => {
    if (!message?.meta?.action) return;
    patchMessage(message.id, { actionStatus: 'applying', actionResult: '' });
    try {
      const summary = await applyAIAction(message.meta.action, {
        subjectId: sessions.find((item) => item.id === activeId)?.subject_id || subjectId,
        subjects,
        toast,
        onNavigate,
        loadSubjects,
        settings: getAISettings(),
        isConfigured: isAssistantConfigured(),
      });
      const meta = { ...message.meta, actionStatus: 'done', actionResult: summary };
      await window.openexam.aiChat.updateMessageMeta({ messageId: message.id, meta });
      setMessages((prev) => prev.map((item) => (item.id === message.id ? { ...item, meta } : item)));
    } catch (error) {
      const meta = { ...message.meta, actionStatus: 'error', actionResult: `执行失败：${error?.message || String(error)}` };
      await window.openexam.aiChat.updateMessageMeta({ messageId: message.id, meta });
      setMessages((prev) => prev.map((item) => (item.id === message.id ? { ...item, meta } : item)));
      toast({ title: '动作执行失败', message: error?.message || String(error), tone: 'danger' });
    }
  }, [activeId, loadSubjects, onNavigate, patchMessage, sessions, subjectId, subjects, toast]);

  const ignoreAction = useCallback(async (message) => {
    const meta = { ...message.meta, actionStatus: 'ignored' };
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
          meta: { kind: 'knowledge', subject: subject?.name || '' },
        });
        toast({ title: '已生成笔记', message: modal.title, tone: 'success' });
      }
      setModal(null);
    } catch (error) {
      toast({ title: '保存失败', message: error?.message || String(error), tone: 'danger' });
    }
  };

  const activeSession = sessions.find((item) => item.id === activeId);

  return (
    <section style={{ display: 'flex', gap: 0, height: '100%', minHeight: 0, borderTop: '1px solid var(--line)' }}>
      {/* 会话列表 */}
      <aside style={{ width: 224, flexShrink: 0, borderRight: '1px solid var(--line)', background: 'var(--surface)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button type="button" onClick={newSession} style={{ ...BTN(true), width: '100%' }}>＋ 新对话</button>
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
          {sessions.map((session) => (
            <div
              key={session.id}
              onClick={() => selectSession(session.id, sessions)}
              style={{
                padding: '8px 10px', borderRadius: 8, cursor: 'pointer', marginBottom: 4,
                background: session.id === activeId ? 'var(--accent-soft-bg)' : 'transparent',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ flex: 1, fontSize: 12, fontWeight: session.id === activeId ? 700 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {session.title || '新会话'}
                </span>
                <button type="button" title="重命名" onClick={(event) => { event.stopPropagation(); renameSession(session); }} style={{ border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 11 }}>✎</button>
                <button type="button" title="删除" onClick={(event) => { event.stopPropagation(); deleteSession(session); }} style={{ border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 12 }}>×</button>
              </div>
              <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
                {session.source === 'imported' ? '导入 · ' : ''}
                {session.message_count ? `${session.message_count} 条消息` : '还没有消息'}
              </div>
            </div>
          ))}
          {!sessions.length ? <div style={{ fontSize: 11, color: 'var(--muted)', padding: 10 }}>还没有会话，直接提问就会创建。</div> : null}
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

        <div ref={listRef} style={{ flex: 1, overflow: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
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

          {messages.map((message) => {
            const isUser = message.role === 'user';
            const action = message.meta?.action;
            return (
              <div key={message.id} style={{ display: 'flex', flexDirection: 'column', alignItems: isUser ? 'flex-end' : 'flex-start', gap: 6 }}>
                <div style={{
                  maxWidth: 'min(720px, 88%)',
                  padding: '10px 13px',
                  borderRadius: 12,
                  background: isUser ? 'var(--ai-user-bg)' : 'var(--surface-elevated)',
                  border: isUser ? '1px solid var(--ai-user-bg)' : '1px solid var(--line)',
                  color: isUser ? '#fff' : 'var(--text)',
                  fontSize: 12.5,
                  lineHeight: 1.75,
                  wordBreak: 'break-word',
                  overflowWrap: 'anywhere',
                }}>
                  {(message.meta?.images || []).length ? (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: message.content ? 8 : 0 }}>
                      {message.meta.images.map((image) => (
                        <MessageImage key={image.path} path={image.path} />
                      ))}
                    </div>
                  ) : null}
                  {isUser
                    ? <div style={{ whiteSpace: 'pre-wrap' }}>{message.content}</div>
                    : <AIMessageContent content={message.content} citations={message.meta?.citations || []} onOpenCitation={setCitation} />}
                </div>

                {!isUser && message.content ? (
                  <div style={{ display: 'flex', gap: 8, paddingLeft: 2 }}>
                    <button type="button" onClick={() => openBankModal(message)} style={{ ...BTN(false), fontSize: 11, padding: '4px 9px' }}>收进题库</button>
                    <button type="button" onClick={() => openNoteModal(message)} style={{ ...BTN(false), fontSize: 11, padding: '4px 9px' }}>转成笔记</button>
                  </div>
                ) : null}

                {action ? (
                  <div style={{ maxWidth: 'min(680px, 88%)', padding: 12, ...CARD, background: 'var(--surface-elevated)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, fontWeight: 700 }}>{describeAction(action).label}</span>
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>{describeAction(action).detail}</span>
                      {message.meta.actionStatus === 'done' ? <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600, color: 'var(--ai-success)' }}>已执行</span> : null}
                      {message.meta.actionStatus === 'ignored' ? <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted)' }}>已忽略</span> : null}
                    </div>
                    {message.meta.actionResult ? (
                      <div style={{ marginTop: 8, fontSize: 11.5, color: message.meta.actionStatus === 'error' ? 'var(--danger)' : 'var(--muted)', whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
                        {message.meta.actionResult}
                      </div>
                    ) : null}
                    {!message.meta.actionStatus || message.meta.actionStatus === 'pending' ? (
                      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        <button type="button" onClick={() => runAction(message)} style={BTN(true)}>执行</button>
                        <button type="button" onClick={() => ignoreAction(message)} style={BTN(false)}>忽略</button>
                      </div>
                    ) : null}
                    {message.meta.actionStatus === 'applying' ? <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)' }}>执行中…</div> : null}
                  </div>
                ) : null}
              </div>
            );
          })}

          {streamText ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
              <div style={{ maxWidth: 'min(720px, 88%)', padding: '10px 13px', borderRadius: 12, background: 'var(--surface-elevated)', border: '1px solid var(--line)', fontSize: 12.5, lineHeight: 1.75 }}>
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

        {/* 输入区 */}
        <div
          style={{ borderTop: '1px solid var(--line)', background: 'var(--surface)', padding: '10px 20px 14px' }}
          onDragOver={(event) => { event.preventDefault(); }}
          onDrop={async (event) => {
            event.preventDefault();
            await addImages(extractDroppedImages(event));
          }}
        >
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
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
                  event.preventDefault();
                  send();
                }
              }}
              placeholder="问问题、贴题目，或让我帮你录题 / 写笔记 / 调计划（Enter 发送，Shift+Enter 换行）"
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
