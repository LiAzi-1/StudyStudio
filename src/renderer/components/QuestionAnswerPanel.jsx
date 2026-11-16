import React, { useEffect, useRef, useState } from 'react';
import RichQuestionContent from './RichQuestionContent.jsx';
import PhoneUploadDialog from './PhoneUploadDialog.jsx';
import { useDialog } from './DialogProvider.jsx';
import { getAnswerImages, isAnswerSupplemented } from '../utils/questionAnswer.js';

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

const S = {
  label: { fontSize: 12, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap' },
  badge: { fontSize: 10.5, fontWeight: 600, padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap' },
  button: {
    padding: '6px 11px', borderRadius: 8, border: '1px solid var(--line)',
    background: 'var(--surface)', color: 'var(--text)', fontSize: 11.5,
    fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
  },
  primary: { borderColor: 'var(--warning-border, var(--accent-border-soft))', background: 'var(--warning-soft, var(--accent-soft-bg))', color: 'var(--warning, var(--accent))' },
  notice: { fontSize: 11, lineHeight: 1.7, color: 'var(--muted)' },
};

const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result || ''));
  reader.onerror = () => reject(new Error('图片读取失败，请重试'));
  reader.readAsDataURL(file);
});

/**
 * 题目答案卡片：展示文字/图片答案，缺答案时给出补充入口。
 * 图片由主进程落到 question-assets/answers/<题目>/ 下，数据库只保存 openexam-asset:// 引用。
 */
export default function QuestionAnswerPanel({ question, onUpdated, editable = true, compact = false, showLabel = true, label = '【答案】' }) {
  const { confirm, toast } = useDialog();
  const [images, setImages] = useState(() => getAnswerImages(question));
  const [textAnswer, setTextAnswer] = useState(() => String(question?.answer || '').toString());
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => String(question?.answer || '').toString());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [preview, setPreview] = useState('');
  const fileRef = useRef(null);

  const imageKey = getAnswerImages(question).join('|');
  useEffect(() => {
    setImages(getAnswerImages(question));
    setTextAnswer(String(question?.answer || '').toString());
    setDraft(String(question?.answer || '').toString());
    setEditing(false);
    setNotice('');
    setPhoneOpen(false);
    setPreview('');
  }, [question?.id]);

  useEffect(() => {
    setImages(getAnswerImages(question));
    setTextAnswer(String(question?.answer || '').toString());
    setDraft(String(question?.answer || '').toString());
  }, [question?.answer, imageKey]);

  const hasAnswer = Boolean(textAnswer.trim()) || images.length > 0;
  const supplemented = isAnswerSupplemented(question);
  const questionId = String(question?.id || '').trim();

  const applyUpdated = (updated) => {
    if (!updated) return;
    setImages(getAnswerImages(updated));
    setTextAnswer(String(updated.answer || '').toString());
    setDraft(String(updated.answer || '').toString());
    onUpdated?.(updated);
  };

  const saveText = async () => {
    if (!questionId) return;
    if (!window.openexam?.question?.updateAnswer) {
      setNotice('当前版本不支持补答案，请重启应用后再试。');
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      const nextText = draft.trim();
      const hasImages = images.length > 0;
      const answerStatus = nextText || hasImages ? 'user_supplemented' : 'missing';
      const updated = await window.openexam.question.updateAnswer({
        questionId,
        answer: nextText,
        answerSource: 'user_text',
        answerStatus,
      });
      applyUpdated(updated);
      setEditing(false);
      toast({ message: nextText || hasImages ? '答案已保存' : '已清空答案', tone: 'success' });
    } catch (error) {
      setNotice(error?.message || '保存答案失败');
    } finally {
      setBusy(false);
    }
  };

  const addImageDataUrl = async (dataUrl) => {
    if (!questionId || !dataUrl) return null;
    if (!window.openexam?.question?.addAnswerImage) {
      setNotice('当前版本不支持上传答案图片，请重启应用后再试。');
      return null;
    }
    const result = await window.openexam.question.addAnswerImage({ questionId, dataUrl });
    if (!result?.success) {
      setNotice(result?.error || '保存答案图片失败');
      return null;
    }
    applyUpdated(result.question);
    return result;
  };

  const handleFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (fileRef.current) fileRef.current.value = '';
    setBusy(true);
    setNotice('');
    let added = 0;
    try {
      for (const file of files) {
        if (!String(file.type || '').startsWith('image/')) {
          setNotice('只支持图片文件');
          continue;
        }
        if (file.size > MAX_IMAGE_BYTES) {
          setNotice(`单张图片不能超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB`);
          continue;
        }
        const dataUrl = await readAsDataUrl(file);
        const result = await addImageDataUrl(dataUrl);
        if (result) added += 1;
      }
      if (added) toast({ message: `已添加 ${added} 张答案图片`, tone: 'success' });
    } catch (error) {
      setNotice(error?.message || '读取图片失败');
    } finally {
      setBusy(false);
    }
  };

  const handlePhoneImages = async (incoming) => {
    const list = Array.isArray(incoming) ? incoming : [];
    if (!list.length) return;
    setBusy(true);
    let added = 0;
    try {
      for (const item of list) {
        const dataUrl = item?.dataUrl || (item?.base64 ? `data:${item.mimeType || 'image/png'};base64,${item.base64}` : '');
        const result = await addImageDataUrl(dataUrl);
        if (result) added += 1;
      }
      if (added) toast({ message: `手机已上传 ${added} 张答案图片`, tone: 'success' });
    } catch (error) {
      setNotice(error?.message || '保存手机图片失败');
    } finally {
      setBusy(false);
    }
  };

  const removeImage = async (url) => {
    if (!questionId) return;
    const ok = await confirm({
      title: '删除这张答案图片？',
      message: '图片会从这道题的答案里移除，删除后不可恢复。',
      confirmText: '删除',
      cancelText: '取消',
      tone: 'warning',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const result = await window.openexam?.question?.removeAnswerImage?.({ questionId, url });
      if (!result?.success) {
        setNotice(result?.error || '删除失败');
        return;
      }
      applyUpdated(result.question);
      toast({ message: '已删除答案图片', tone: 'success' });
    } catch (error) {
      setNotice(error?.message || '删除失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        {showLabel ? <span style={S.label}>{label}</span> : null}
        {!hasAnswer ? (
          <span style={{ ...S.badge, color: 'var(--warning, #b45309)', background: 'var(--warning-soft, #fef3c7)' }}>缺答案</span>
        ) : null}
        {supplemented && hasAnswer ? (
          <span style={{ ...S.badge, color: 'var(--success, #047857)', background: 'var(--success-soft, #d1fae5)' }}>答案已补充</span>
        ) : null}
        {images.length > 0 ? (
          <span style={{ ...S.badge, color: 'var(--accent)', background: 'var(--accent-soft-bg)' }}>{images.length} 张图片答案</span>
        ) : null}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
          multiple
          style={{ display: 'none' }}
          onChange={(event) => handleFiles(event.target.files)}
        />
        {editable ? (
          <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' }}>
            <button
              type="button"
              style={S.button}
              onClick={() => fileRef.current?.click()}
              disabled={busy}
            >
              {hasAnswer ? '上传图片' : '上传图片补答案'}
            </button>
            <button
              type="button"
              style={{ ...S.button, ...(hasAnswer ? {} : S.primary) }}
              onClick={() => setPhoneOpen(true)}
              disabled={busy}
            >
              手机扫码补答案
            </button>
            <button
              type="button"
              style={S.button}
              onClick={() => setEditing((value) => !value)}
              disabled={busy}
            >
              {hasAnswer ? '编辑文字答案' : '输入文字答案'}
            </button>
          </div>
        ) : null}
      </div>

      {hasAnswer ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {textAnswer.trim() ? (
            <RichQuestionContent value={textAnswer} className="tb-inline tb-answer-text" />
          ) : (
            <span style={S.notice}>这道题目前只有图片答案，文字答案解析可以参考图片。</span>
          )}
          {images.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {images.map((url) => (
                <div key={url} style={{ position: 'relative', width: 132, height: 100 }}>
                  <button
                    type="button"
                    onClick={() => setPreview(url)}
                    title="点击预览大图"
                    style={{ width: '100%', height: '100%', padding: 0, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--line)', background: 'var(--surface)', cursor: 'zoom-in' }}
                  >
                    <img src={url} alt="答案图片" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  </button>
                  {editable ? (
                    <button
                      type="button"
                      onClick={() => removeImage(url)}
                      disabled={busy}
                      title="删除这张答案图片"
                      style={{ position: 'absolute', top: -7, right: -7, width: 22, height: 22, borderRadius: 11, border: '1px solid var(--danger, #dc2626)', background: 'var(--surface)', color: 'var(--danger, #dc2626)', fontSize: 13, lineHeight: '18px', cursor: 'pointer' }}
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <div style={{ fontSize: 12, lineHeight: 1.8, color: 'var(--muted)' }}>
          这道题还没有答案。可以直接输入文字答案，也可以拍照 / 上传图片，或点「手机扫码传图」用手机拍下自己的解答。
        </div>
      )}

      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 10, border: '1px solid var(--line)', background: 'var(--surface-soft)' }}>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={compact ? 3 : 4}
            placeholder="输入文字答案：客观题填选项字母（如 A），主观题写参考答案，支持公式"
            style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--text)', font: 'inherit', fontSize: 12.5, lineHeight: 1.7 }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" style={{ ...S.button, ...S.primary }} onClick={saveText} disabled={busy}>
              {busy ? '保存中…' : '保存文字答案'}
            </button>
            <button type="button" style={S.button} onClick={() => { setDraft(textAnswer); setEditing(false); }} disabled={busy}>
              取消
            </button>
            <span style={S.notice}>图片上传后立即保存，可在上方预览或删除。</span>
          </div>
        </div>
      ) : null}

      {notice ? (
        <div style={{ fontSize: 11.5, lineHeight: 1.7, color: 'var(--danger, #b91c1c)', background: 'var(--danger-soft, #fee2e2)', borderRadius: 7, padding: '7px 10px' }}>
          {notice}
        </div>
      ) : null}

      {phoneOpen ? (
        <PhoneUploadDialog
          title="手机扫码补答案"
          subtitle="手机拍下这道题的解答，图片直接成为答案图片"
          mobileTitle="拍答案给 StudyStudio"
          mobileLead="拍照或从相册选图，图片会直接保存为这道题的答案图片。本次上传只在电脑端关闭前有效。"
          onClose={() => setPhoneOpen(false)}
          onImages={handlePhoneImages}
          onNotice={(message) => toast({ message, tone: 'info' })}
        />
      ) : null}

      {preview ? (
        <div
          onClick={() => setPreview('')}
          style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(8,14,24,0.78)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 28, cursor: 'zoom-out' }}
        >
          <img src={preview} alt="答案图片预览" style={{ maxWidth: '92vw', maxHeight: '88vh', objectFit: 'contain', borderRadius: 10, boxShadow: '0 24px 60px rgba(0,0,0,0.45)' }} />
        </div>
      ) : null}
    </div>
  );
}
