import React, { useRef, useState } from 'react';
import { getGradingSettings, getAIProvider, isVisionCapable } from '../store/aiSettings.js';

/**
 * 主观题不需要在界面里输入文字答案。
 * 只有用户想让 AI 批改时，才选择一张手写答案照片上传。
 * 选择题 / 填空题仍然走 ExamRoom 里原有的输入控件。
 */
const SUPPORTED_MIMES = ['image/png', 'image/jpeg', 'image/webp'];
const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
};

const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result || ''));
  reader.onerror = () => reject(new Error('图片读取失败，请重试'));
  reader.readAsDataURL(file);
});

// 视觉模型一般只收 PNG/JPEG/WebP；gif/bmp 先转成 PNG
const normalizeImage = (dataUrl, mimeType) => {
  if (SUPPORTED_MIMES.includes(mimeType)) {
    return Promise.resolve({ dataUrl, mimeType });
  }
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth || image.width;
      canvas.height = image.naturalHeight || image.height;
      canvas.getContext('2d').drawImage(image, 0, 0);
      resolve({ dataUrl: canvas.toDataURL('image/png'), mimeType: 'image/png' });
    };
    image.onerror = () => reject(new Error('图片解码失败，请改用 PNG / JPG 格式'));
    image.src = dataUrl;
  });
};

const btn = {
  border: '1px solid var(--line)', borderRadius: 8, padding: '8px 13px',
  background: 'var(--surface)', color: 'var(--text)', fontSize: 12,
  fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
};

export default function SubjectiveGrader({ question, onAskAI, answerVisible = true }) {
  const [image, setImage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [review, setReview] = useState(null);
  const [showRecognized, setShowRecognized] = useState(false);
  const fileRef = useRef(null);

  // 批改默认用「老师」角色；老师模型不能读图时自动退到「识图」角色
  const grading = getGradingSettings();
  const settings = grading.settings;
  const provider = getAIProvider(settings.aiProvider);
  const textOnlyModel = !isVisionCapable(settings);
  const visionHint = textOnlyModel
    ? `当前「${provider?.name || settings.aiProvider || '模型'} / ${settings.model || ''}」不能读图片。请到「设置 → AI 模型」给「识图」或「老师」换一个能读图的模型：DeepSeek 用 deepseek-flash，其它可选 qwen-vl、glm-4v、Claude、豆包 vision。`
    : '';
  const fallbackHint = grading.fallback
    ? `老师模型不能读图，本次批改使用「识图」角色：${provider?.name || settings.aiProvider} / ${settings.model}。`
    : '';

  const handlePick = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError('');
    setReview(null);
    setShowRecognized(false);
    try {
      const ext = String(file.name || '').split('.').pop().toLowerCase();
      const rawMime = file.type || MIME_BY_EXT[ext] || 'image/png';
      const dataUrl = await readAsDataUrl(file);
      const normalized = await normalizeImage(dataUrl, rawMime);
      setImage({
        ...normalized,
        base64: normalized.dataUrl.includes(',') ? normalized.dataUrl.split(',')[1] : normalized.dataUrl,
        name: file.name,
      });
    } catch (err) {
      setError(err?.message || '图片读取失败');
    }
  };

  const handleGrade = async () => {
    if (!image) { fileRef.current?.click(); return; }
    if (!settings?.apiKey || !settings?.model) {
      setError('还没有可用的 AI 模型配置。请到「设置 → AI 模型」填写 API Key / 模型 / Base URL 并测试连接。');
      return;
    }
    if (!window.openexam?.ai?.gradeHandwrittenAnswer) {
      setError('当前运行的版本没有图片批改能力，请重新打包后再试。');
      return;
    }
    setBusy(true);
    setError('');
    setReview(null);
    try {
      const result = await window.openexam.ai.gradeHandwrittenAnswer(
        settings,
        {
          content: question?.content || '',
          options: Array.isArray(question?.options) ? question.options : [],
          answer: question?.answer || '',
          analysis: question?.analysis || question?.analysis_html || '',
          material: question?.material_html || question?.material || '',
        },
        image.base64,
        image.mimeType
      );
      if (!result?.success) {
        setError(`${result?.error || '批改失败，请换一张更清晰的照片重试'}${visionHint ? `\n${visionHint}` : ''}`);
      } else setReview(result.review || null);
    } catch (err) {
      setError(err?.message || '批改失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  const points = Array.isArray(review?.points) ? review.points : [];
  const improvements = Array.isArray(review?.improvements) ? review.improvements : [];

  return (
    <div style={{ marginTop: 12, padding: '14px 16px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--surface-soft)' }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 6 }}>
        {answerVisible ? '想让 AI 按评分要点逐点评分？' : '这道题写在纸上作答'}
      </div>
      <div style={{ fontSize: 11.5, lineHeight: 1.7, color: 'var(--muted)', marginBottom: 12 }}>
        {answerVisible
          ? '参考答案在上面。想让 AI 逐点打分，可以拍一张手写答案传上来，会先识别再逐点评分。'
          : '参考答案在交卷后的成绩页「对答案」里给，做题时先别看。想让 AI 批改，拍一张手写答案传上来，会先识别再逐点评分。'}
      </div>

      {visionHint && (
        <div style={{ marginBottom: 12, padding: '9px 12px', borderRadius: 7, background: 'var(--warning-soft)', border: '1px solid var(--warning-border)', color: 'var(--warning)', fontSize: 11.5, lineHeight: 1.7 }}>
          {visionHint}
        </div>
      )}

      {!visionHint && fallbackHint && (
        <div style={{ marginBottom: 12, fontSize: 11, lineHeight: 1.7, color: 'var(--muted)' }}>
          {fallbackHint}
        </div>
      )}

      <input ref={fileRef} type="file" accept="image/*" onChange={handlePick} style={{ display: 'none' }} />

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" style={btn} onClick={() => fileRef.current?.click()} disabled={busy}>
          {image ? '重新选图' : '选择手写答案照片'}
        </button>
        <button
          type="button"
          disabled={busy || !image}
          onClick={handleGrade}
          style={{ ...btn, borderColor: 'var(--accent-border-soft)', background: 'var(--accent-soft-bg)', color: 'var(--accent)', opacity: !image || busy ? 0.55 : 1 }}
        >
          {busy ? 'AI 批改中…' : '开始 AI 批改'}
        </button>
        {onAskAI && (
          <button type="button" style={btn} onClick={onAskAI}>问 AI 老师讲解</button>
        )}
      </div>

      {image && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12 }}>
          <img src={image.dataUrl} alt="手写答案预览" style={{ width: 76, height: 58, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--line)' }} />
          <span style={{ fontSize: 11, color: 'var(--muted)' }} title={image.name}>{image.name} · 已就绪</span>
        </div>
      )}

      {error && (
        <div style={{ marginTop: 12, padding: '9px 12px', borderRadius: 7, background: 'var(--danger-soft, #fee2e2)', color: 'var(--danger, #b91c1c)', fontSize: 11.5, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
          {error}
        </div>
      )}

      {review && (
        <div style={{ marginTop: 14, padding: '14px 16px', borderRadius: 9, background: 'var(--surface)', border: '1px solid var(--accent-border-soft)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <strong style={{ fontSize: 12.5, color: 'var(--text)' }}>AI 批改结果</strong>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--accent)' }}>
              {Number(review.score) || 0} / {Number(review.maxScore) || 10} 分
            </span>
          </div>

          <button
            type="button"
            onClick={() => setShowRecognized((value) => !value)}
            style={{ ...btn, padding: '4px 9px', fontSize: 11, fontWeight: 500 }}
          >
            {showRecognized ? '收起' : '查看'}识别出的手写答案
          </button>
          {showRecognized && (
            <div style={{ marginTop: 8, padding: '9px 11px', borderRadius: 7, background: 'var(--surface-soft)', fontSize: 11.5, lineHeight: 1.75, color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {review.recognizedAnswer || '（没有识别到可辨认的文字，建议重拍一张更清晰的照片）'}
            </div>
          )}

          {points.length > 0 && (
            <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'flex', flexDirection: 'column', gap: 7 }}>
              {points.map((point, index) => (
                <li key={index} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 11.5, lineHeight: 1.65 }}>
                  <span style={{ flex: 'none', fontSize: 11, fontWeight: 700, color: point?.hit ? 'var(--success)' : 'var(--danger)' }}>
                    {point?.hit ? '✓ 命中' : '✗ 遗漏'}
                  </span>
                  <span style={{ color: 'var(--text)' }}>
                    {String(point?.text || '')}
                    {point?.comment ? <span style={{ color: 'var(--muted)' }}> — {String(point.comment)}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {review.summary && (
            <p style={{ margin: '12px 0 0', fontSize: 11.5, lineHeight: 1.75, color: 'var(--text)' }}>{String(review.summary)}</p>
          )}
          {improvements.length > 0 && (
            <div style={{ marginTop: 10, fontSize: 11.5, lineHeight: 1.8, color: 'var(--muted)' }}>
              <strong style={{ color: 'var(--text)' }}>下次注意：</strong>
              {improvements.map((item, index) => <div key={index}>· {String(item)}</div>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
