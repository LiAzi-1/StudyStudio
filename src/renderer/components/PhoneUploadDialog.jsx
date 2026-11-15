import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import { useDialog } from '../components/DialogProvider.jsx';

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

function formatRemaining(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

/**
 * 手机扫码传图
 *
 * 打开即起临时局域网服务，界面显示二维码与可访问地址；
 * 图片到达后回调给会话输入区，关闭弹窗 / 超时 / 退出应用时服务立即停止，不常驻。
 */
export default function PhoneUploadDialog({ onClose, onImages, onNotice }) {
  const { toast } = useDialog();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState('starting');
  const [activeIndex, setActiveIndex] = useState(0);
  const [now, setNow] = useState(Date.now());
  const closedRef = useRef(false);
  const callbacksRef = useRef({ onClose, onImages, onNotice });
  callbacksRef.current = { onClose, onImages, onNotice };

  const stopServer = useCallback(async () => {
    try { await window.openexam?.phoneUpload?.stop?.(); } catch { /* 已关闭 */ }
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setStatus('starting');
    try {
      const result = await window.openexam.phoneUpload.start();
      if (!result?.success) {
        setError({ error: result?.error || '启动手机传图失败', hint: result?.hint || '', code: result?.code || '' });
        setStatus('error');
        return;
      }
      setInfo(result);
      setStatus('waiting');
      if (result.portNote) toast({ message: result.portNote, tone: 'info' });
    } catch (err) {
      setError({ error: err?.message || String(err), hint: '请重试；如果反复失败，检查安全软件是否拦截了本地端口监听。', code: 'START_FAILED' });
      setStatus('error');
    }
  }, [toast]);

  useEffect(() => {
    const off = window.openexam?.phoneUpload?.onEvent?.((payload) => {
      if (!payload || closedRef.current) return;
      if (payload.type === 'opened') {
        setStatus((prev) => (prev === 'received' ? prev : 'opened'));
        return;
      }
      if (payload.type === 'images') {
        const incoming = (payload.images || []).map((image) => ({
          base64: image.base64,
          mimeType: image.mimeType,
          dataUrl: `data:${image.mimeType};base64,${image.base64}`,
        }));
        callbacksRef.current.onImages?.(incoming);
        setStatus('received');
        setInfo((prev) => (prev ? {
          ...prev,
          token: payload.token,
          urls: payload.urls,
          idleDeadline: payload.idleDeadline,
          uploadedCount: payload.total,
        } : prev));
        setNow(Date.now());
        return;
      }
      if (payload.type === 'closed') {
        closedRef.current = true;
        const message = payload.reason === 'timeout'
          ? (payload.message || '超过 3 分钟没有收到图片，已自动关闭手机传图')
          : payload.reason === 'expired'
            ? (payload.message || '手机传图已自动关闭，需要时请重新开启')
            : '';
        if (message) callbacksRef.current.onNotice?.(message);
        if (payload.reason !== 'user' && payload.reason !== 'quit') callbacksRef.current.onClose?.();
      }
    });
    start();
    return () => {
      off?.();
      closedRef.current = true;
      stopServer();
    };
  }, [start, stopServer]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const urls = info?.urls || [];
  const activeUrl = urls[Math.min(activeIndex, Math.max(urls.length - 1, 0))]?.url || '';

  const qrSvg = useMemo(() => {
    if (!activeUrl) return '';
    try {
      const qr = qrcode(0, 'M');
      qr.addData(activeUrl);
      qr.make();
      return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    } catch {
      return '';
    }
  }, [activeUrl]);

  const remaining = info?.idleDeadline ? info.idleDeadline - now : 0;

  const statusText = status === 'starting'
    ? '正在启动本地上传服务…'
    : status === 'waiting'
      ? `等待手机扫码，剩余 ${formatRemaining(remaining)}`
      : status === 'opened'
        ? `手机已连接，等待图片 · 剩余 ${formatRemaining(remaining)}`
        : status === 'received'
          ? `已收到 ${info?.uploadedCount || 0} 张，可继续拍照 · 剩余 ${formatRemaining(remaining)}`
          : '';

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 70, background: 'rgba(8,14,24,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose?.(); }}
    >
      <div style={{ width: 'min(460px, 100%)', maxHeight: '88vh', overflow: 'auto', ...CARD, background: 'var(--surface-elevated)', padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <strong style={{ fontSize: 14 }}>手机传图</strong>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>扫码拍照，图片直接进入当前会话</span>
          <button type="button" onClick={onClose} style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 16 }}>×</button>
        </div>

        {error ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ ...CARD, borderColor: 'var(--danger)', padding: '12px 14px', background: 'var(--surface-soft)' }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--danger)' }}>{error.error}</div>
              {error.hint ? <div style={{ fontSize: 11.5, lineHeight: 1.8, color: 'var(--muted)', marginTop: 6 }}>{error.hint}</div> : null}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" onClick={onClose} style={BTN(false)}>关闭</button>
              <button type="button" onClick={start} style={BTN(true)}>重试</button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 220, height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff', borderRadius: 12, padding: 8, border: '1px solid var(--line)' }}>
              {qrSvg ? (
                <div style={{ width: '100%', height: '100%' }} dangerouslySetInnerHTML={{ __html: qrSvg }} />
              ) : (
                <span style={{ fontSize: 11, color: '#6b7280' }}>正在生成二维码…</span>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--muted)' }}>
              <span style={{
                width: 7, height: 7, borderRadius: 4,
                background: status === 'received' || status === 'opened' ? 'var(--ai-success)' : 'var(--accent)',
                display: 'inline-block',
              }} />
              {statusText}
            </div>

            <div style={{ width: '100%', ...CARD, background: 'var(--surface-soft)', padding: '10px 12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>手机访问地址</span>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(activeUrl);
                      toast({ message: '地址已复制', tone: 'success' });
                    } catch {
                      toast({ message: '复制失败，请手动选中地址复制', tone: 'info' });
                    }
                  }}
                  style={{ marginLeft: 'auto', ...BTN(false), padding: '2px 8px', fontSize: 10.5 }}
                >复制</button>
              </div>
              <div style={{ fontSize: 12, marginTop: 4, wordBreak: 'break-all', fontFamily: 'Consolas, monospace' }}>{activeUrl || '—'}</div>
              {urls.length > 1 ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                  {urls.map((item, index) => (
                    <button
                      key={item.url}
                      type="button"
                      onClick={() => setActiveIndex(index)}
                      style={{
                        ...BTN(index === activeIndex), padding: '2px 8px', fontSize: 10.5,
                        borderColor: index === activeIndex ? 'var(--accent)' : 'var(--line)',
                      }}
                    >
                      {item.address}（{item.interfaceName}）
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div style={{ fontSize: 10.5, color: 'var(--muted)', lineHeight: 1.8, width: '100%' }}>
              · 手机和电脑要连同一个 Wi-Fi；二维码只在本次开启期间有效，上传成功后会立即换新码，超过 3 分钟没有收到图片会自动关闭。
              <br />
              · 手机打不开地址时：确认 Windows 防火墙允许本应用访问「专用网络」，并检查路由器是否开启了 AP 隔离。
              <br />
              · 关闭本窗口后上传服务立即停止，不会在后台常驻。
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, width: '100%' }}>
              <button
                type="button"
                onClick={async () => {
                  closedRef.current = true;
                  await stopServer();
                  onClose?.();
                }}
                style={BTN(false)}
              >关闭并停止</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
