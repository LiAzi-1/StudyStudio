import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useDialog } from '../components/DialogProvider.jsx';
import { getAISettings, isAssistantConfigured } from '../store/aiSettings.js';
import {
  MAX_ASSISTANT_IMAGES,
  readFileAsBase64,
} from '../utils/imageInput.js';

const CARD = { border: '1px solid var(--line)', borderRadius: 12, background: 'var(--surface)' };

const BTN = (primary) => ({
  padding: '7px 13px',
  borderRadius: 8,
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  border: primary ? '1px solid var(--accent)' : '1px solid var(--line)',
  background: primary ? 'var(--accent)' : 'transparent',
  color: primary ? 'var(--ai-on-accent)' : 'var(--text)',
});

const TEXT_INPUT = {
  display: 'block',
  width: '100%',
  marginTop: 4,
  padding: '7px 9px',
  borderRadius: 8,
  border: '1px solid var(--line)',
  background: 'var(--surface-soft)',
  color: 'var(--text)',
  fontSize: 12,
  fontFamily: 'inherit',
};

const TEXT_EXTENSIONS = ['txt', 'md', 'markdown', 'json', 'log', 'csv'];

function isImageFile(file) {
  return String(file?.type || '').startsWith('image/');
}

function isTextFile(file) {
  const ext = String(file?.name || '').split('.').pop().toLowerCase();
  return isImageFile(file) || TEXT_EXTENSIONS.includes(ext);
}

/**
 * 外部对话导入
 *
 * 支持四种形态：粘贴纯文本、上传文本文件、上传聊天截图（复用识图链路）、粘贴 DeepSeek 分享链接。
 * 分享链接依赖对方未公开接口（需要浏览器 UA，否则会被 WAF 挡成 429），属于脆弱能力：
 * 对方改版、删除分享、限流都会失败，因此失败时按类型给出替代做法，不把它说成官方支持。
 */
export default function AIChatImportDialog({ onClose, onImported, subjectId = '' }) {
  const { toast } = useDialog();
  const [text, setText] = useState('');
  const [fileNames, setFileNames] = useState([]);
  const [images, setImages] = useState([]);
  const [phase, setPhase] = useState('input');
  const [result, setResult] = useState(null);
  const [title, setTitle] = useState('');
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState(null);
  const [shareUrl, setShareUrl] = useState('');
  const [includeThinking, setIncludeThinking] = useState(false);
  const fileRef = useRef(null);

  const canParse = useMemo(() => Boolean(text.trim()) || images.length > 0, [images.length, text]);

  const handleFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList || []).filter((file) => file && isTextFile(file));
    const skipped = Array.from(fileList || []).length - files.length;
    if (skipped > 0) toast({ message: `已跳过 ${skipped} 个不支持的文件（只接受文本文件与图片）`, tone: 'info' });

    for (const file of files) {
      if (isImageFile(file)) {
        try {
          const { base64, mimeType } = await readFileAsBase64(file);
          setImages((prev) => {
            if (prev.length >= MAX_ASSISTANT_IMAGES) {
              toast({ message: `一次最多识别 ${MAX_ASSISTANT_IMAGES} 张截图`, tone: 'info' });
              return prev;
            }
            return [...prev, { base64, mimeType, dataUrl: `data:${mimeType};base64,${base64}`, name: file.name }];
          });
        } catch (err) {
          toast({ title: '截图读取失败', message: err?.message || String(err), tone: 'warning' });
        }
        continue;
      }
      try {
        const content = await file.text();
        setText((prev) => `${prev}${prev ? '\n\n' : ''}【文件：${file.name}】\n${content}`);
        setFileNames((prev) => [...prev, file.name]);
      } catch (err) {
        toast({ title: '文件读取失败', message: err?.message || String(err), tone: 'warning' });
      }
    }
  }, [toast]);

  const parse = useCallback(async () => {
    if (!isAssistantConfigured()) {
      toast({ title: '还没配置 AI 模型', message: '整理对话需要先到「设置 → AI 模型」配置模型。', tone: 'warning' });
      return;
    }
    setPhase('parsing');
    setError(null);
    try {
      const res = await window.openexam.aiChat.structureChatLog({
        settings: getAISettings(),
        text,
        images: images.map(({ base64, mimeType }) => ({ base64, mimeType })),
      });
      if (!res?.success) {
        setError({ error: res?.error || '整理失败', hint: res?.hint || '', alternatives: res?.alternatives || [] });
        setPhase('input');
        return;
      }
      setResult(res);
      setTitle(res.title || '导入的对话');
      setMessages(res.messages || []);
      setPhase('preview');
      if (res.warning) toast({ message: res.warning, tone: 'info' });
    } catch (err) {
      setError({ error: err?.message || String(err), hint: '请稍后重试，或改用复制全文 / 截图。', alternatives: [] });
      setPhase('input');
    }
  }, [images, text, toast]);

  /** 读取 DeepSeek 分享链接：主进程抓接口并当场下载附件，不经过 AI 整理模型 */
  const readShare = useCallback(async () => {
    const url = shareUrl.trim();
    if (!url) {
      toast({ message: '先把分享链接粘贴进来', tone: 'info' });
      return;
    }
    setPhase('parsing');
    setError(null);
    try {
      const res = await window.openexam.aiChat.importShareLink({ url, includeThinking });
      if (!res?.success) {
        setError({
          error: res?.error || '读取分享失败',
          hint: res?.hint || '',
          alternatives: res?.alternatives || [],
        });
        setPhase('input');
        return;
      }
      setResult(res);
      setTitle(res.title || '导入的分享对话');
      setMessages(res.messages || []);
      setPhase('preview');
      if (res.warning) toast({ message: res.warning, tone: 'info' });
    } catch (err) {
      setError({ error: err?.message || String(err), hint: '请稍后重试，或改用复制全文 / 截图。', alternatives: [] });
      setPhase('input');
    }
  }, [includeThinking, shareUrl, toast]);

  const doImport = useCallback(async () => {
    if (!messages.length) return;
    setPhase('importing');
    try {
      const isShareImport = Boolean(result?.importId);
      const res = isShareImport
        ? await window.openexam.aiChat.commitShareImport({
          importId: result.importId,
          title,
          subjectId: subjectId || null,
          messages: messages.map((message) => ({
            role: message.role,
            content: message.content,
            images: (message.images || []).map((image) => ({ file: image.file, mimeType: image.mimeType, name: image.name })),
          })),
        })
        : await window.openexam.aiChat.importChatLog({ title, subjectId: subjectId || null, messages });
      if (!res?.success) {
        toast({ title: '导入失败', message: res?.error || res?.hint || '未知错误', tone: 'danger' });
        setPhase('preview');
        return;
      }
      toast({
        title: '已导入对话',
        message: `《${res.title}》· ${res.count} 条消息${res.images ? `、${res.images} 张图片` : ''}`,
        tone: 'success',
      });
      onImported?.(res.sessionId);
      onClose?.();
    } catch (err) {
      toast({ title: '导入失败', message: err?.message || String(err), tone: 'danger' });
      setPhase('preview');
    }
  }, [messages, onClose, onImported, result, subjectId, title, toast]);

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 70, background: 'rgba(8,14,24,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose?.(); }}
    >
      <div style={{ width: 'min(760px, 100%)', maxHeight: '88vh', overflow: 'auto', ...CARD, background: 'var(--surface-elevated)', padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <strong style={{ fontSize: 14 }}>导入外部对话</strong>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>把其它 AI 里的聊天记录搬进来，继续追问</span>
          <button type="button" onClick={onClose} style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 16 }}>×</button>
        </div>

        {phase === 'input' || phase === 'parsing' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ ...CARD, background: 'var(--surface-soft)', padding: '10px 12px', fontSize: 11.5, lineHeight: 1.8 }}>
              <strong style={{ fontSize: 12 }}>支持四种方式：粘贴文字 / 上传文本文件 / 上传聊天截图 / 粘贴 DeepSeek 分享链接</strong>
            </div>

            <div style={{ ...CARD, padding: '10px 12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 12 }}>分享链接（DeepSeek / 豆包）</strong>
                <span style={{ fontSize: 10.5, color: 'var(--ai-warning-text)' }}>依赖对方页面结构或未公开接口，改版可能失效，不属于官方支持</span>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <input
                  value={shareUrl}
                  onChange={(event) => setShareUrl(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') readShare(); }}
                  placeholder="https://chat.deepseek.com/share/... 或 https://www.doubao.com/thread/..."
                  style={{ ...TEXT_INPUT, marginTop: 0, flex: 1 }}
                />
                <button
                  type="button"
                  onClick={readShare}
                  disabled={phase === 'parsing' || !shareUrl.trim()}
                  style={{ ...BTN(true), opacity: phase === 'parsing' || !shareUrl.trim() ? 0.55 : 1, whiteSpace: 'nowrap' }}
                >读取分享</button>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 10.5, color: 'var(--muted)' }}>
                <input type="checkbox" checked={includeThinking} onChange={(event) => setIncludeThinking(event.target.checked)} />
                同时导入思考过程（默认不导入）
              </label>
              <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 6, lineHeight: 1.7 }}>
                会读取对方分享页或网页接口里的对话，并把附件图片当场下载到本地，不保留会过期的外链。链接失效、对话未生成完或页面结构改版时会按原因提示，可以改用下面的复制全文 / 截图。
              </div>
            </div>

            <label style={{ fontSize: 11, color: 'var(--muted)' }}>
              粘贴对话原文（任意 AI）
              <textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                rows={9}
                placeholder="把 ChatGPT / 豆包 / 文心等对话全选复制，粘到这里（时间戳、按钮文字会自动清理）"
                style={{ ...TEXT_INPUT, lineHeight: 1.7, resize: 'vertical' }}
              />
            </label>

            {fileNames.length ? (
              <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>已读取文件：{fileNames.join('、')}</div>
            ) : null}

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" onClick={() => fileRef.current?.click()} style={BTN(false)}>选择文件 / 截图</button>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept=".txt,.md,.markdown,.json,.log,.csv,text/plain,image/*"
                style={{ display: 'none' }}
                onChange={async (event) => {
                  await handleFiles(event.target.files);
                  event.target.value = '';
                }}
              />
              <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>文本：.txt / .md / .json / .log / .csv；截图最多 {MAX_ASSISTANT_IMAGES} 张</span>
            </div>

            {images.length ? (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {images.map((image, index) => (
                  <div key={`${index}-${image.name || ''}`} style={{ position: 'relative' }}>
                    <img src={image.dataUrl} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--line)' }} />
                    <button
                      type="button"
                      onClick={() => setImages((prev) => prev.filter((_, i) => i !== index))}
                      style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: 9, border: 'none', background: 'var(--danger)', color: '#fff', cursor: 'pointer', fontSize: 11, lineHeight: '18px', padding: 0 }}
                    >×</button>
                  </div>
                ))}
              </div>
            ) : null}

            {error ? (
              <div style={{ ...CARD, borderColor: 'var(--danger)', padding: '10px 12px', background: 'var(--surface-soft)' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--danger)' }}>{error.error}</div>
                {error.hint ? <div style={{ fontSize: 11.5, lineHeight: 1.8, color: 'var(--muted)', marginTop: 4 }}>{error.hint}</div> : null}
                {error.alternatives?.length ? (
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 11, lineHeight: 1.9, color: 'var(--muted)' }}>
                    {error.alternatives.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                ) : null}
              </div>
            ) : null}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
              <button type="button" onClick={onClose} style={BTN(false)}>取消</button>
              <button
                type="button"
                onClick={parse}
                disabled={!canParse || phase === 'parsing'}
                style={{ ...BTN(true), opacity: !canParse || phase === 'parsing' ? 0.55 : 1 }}
              >
                {phase === 'parsing' ? '正在整理…' : '开始整理'}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={{ fontSize: 11, color: 'var(--muted)' }}>
              会话标题
              <input value={title} onChange={(event) => setTitle(event.target.value)} style={TEXT_INPUT} />
            </label>

            {result?.summary ? (
              <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.7 }}>{result.summary}</div>
            ) : null}

            {result?.importId ? (
              <div style={{ fontSize: 10.5, color: 'var(--ai-warning-text)', lineHeight: 1.7 }}>
                通过分享链接读取（依赖对方页面结构 / 未公开接口，可能改版）。附件图片已下载到本地暂存，不会保留外链；确认后写入会话。
              </div>
            ) : null}

            {result?.topics?.length ? (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {result.topics.map((topic) => (
                  <span key={topic} style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 999, background: 'var(--surface-soft)', border: '1px solid var(--line)', color: 'var(--muted)' }}>{topic}</span>
                ))}
              </div>
            ) : null}

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>共 {messages.length} 条消息，确认无误后再导入（可删掉不需要的条目）</span>
              <button type="button" onClick={() => setPhase('input')} style={{ marginLeft: 'auto', ...BTN(false), padding: '3px 8px', fontSize: 10.5 }}>{result?.importId ? '返回重新读取' : '返回修改原文'}</button>
            </div>

            <div style={{ maxHeight: '46vh', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8, paddingRight: 4 }}>
              {messages.map((message, index) => (
                <div key={`${index}-${message.role}`} style={{ ...CARD, padding: '8px 10px', background: message.role === 'user' ? 'var(--accent-soft-bg)' : 'var(--surface)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: message.role === 'user' ? 'var(--accent)' : 'var(--muted)' }}>
                      {message.role === 'user' ? '我' : 'AI'}
                    </span>
                    <button
                      type="button"
                      onClick={() => setMessages((prev) => prev.filter((_, i) => i !== index))}
                      style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 11 }}
                      title="不导入这条"
                    >移除</button>
                  </div>
                  <div style={{ fontSize: 12, lineHeight: 1.7, whiteSpace: 'pre-wrap', maxHeight: 110, overflow: 'auto' }}>{message.content}</div>
                  {(message.images || []).length ? (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                      {message.images.map((image, imageIndex) => (
                        <img
                          key={`${imageIndex}-${image.file || image.name || ''}`}
                          src={image.dataUrl}
                          alt={image.name || '附件图片'}
                          title={image.name || ''}
                          style={{ width: 76, height: 76, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--line)' }}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
              {!messages.length ? <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>没有剩余消息，返回上一步重新整理。</div> : null}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" onClick={onClose} style={BTN(false)}>取消</button>
              <button
                type="button"
                onClick={doImport}
                disabled={!messages.length || phase === 'importing'}
                style={{ ...BTN(true), opacity: !messages.length || phase === 'importing' ? 0.55 : 1 }}
              >
                {phase === 'importing' ? '正在导入…' : `导入 ${messages.length} 条消息`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
