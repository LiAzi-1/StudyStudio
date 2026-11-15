import React, { useCallback, useEffect, useRef, useState } from 'react';

const formatMB = (bytes) => {
  const value = Number(bytes) || 0;
  if (value < 1024 * 1024) return `${Math.max(0, Math.round(value / 1024))} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(0)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const toneOf = (ok, optional = false) => {
  if (ok) return 'success';
  return optional ? 'idle' : 'warning';
};

const TONE_COLORS = {
  success: { color: '#1a7f5a', background: 'rgba(26,127,90,0.10)', border: '1px solid rgba(26,127,90,0.25)' },
  warning: { color: '#b45309', background: 'rgba(180,83,9,0.10)', border: '1px solid rgba(180,83,9,0.25)' },
  danger: { color: 'var(--danger)', background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.25)' },
  idle: { color: 'var(--muted)', background: 'var(--surface-soft)', border: '1px solid var(--line)' },
};

function StatusPill({ tone = 'idle', children }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 999,
      fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', ...TONE_COLORS[tone] || TONE_COLORS.idle,
    }}>
      {children}
    </span>
  );
}

const cardStyle = {
  display: 'flex', flexDirection: 'column', gap: 12,
  padding: '16px 18px', borderRadius: 14, border: '1px solid var(--line)', background: 'var(--surface)',
};

const rowStyle = {
  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
  fontSize: 12, color: 'var(--muted)', minWidth: 0,
};

const codeStyle = {
  fontSize: 11, color: 'var(--text)', background: 'var(--surface-soft)',
  border: '1px solid var(--line)', borderRadius: 6, padding: '2px 6px',
  maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};

const btn = (primary) => ({
  padding: '7px 13px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
  border: primary ? '1px solid var(--accent)' : '1px solid var(--line)',
  background: primary ? 'var(--accent)' : 'transparent',
  color: primary ? '#fff' : 'var(--text)',
});

const STEP_ICON = { pending: '○', running: '◍', done: '●', failed: '×' };

export default function RuntimeEnvPanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [detectError, setDetectError] = useState('');
  const [install, setInstall] = useState(null);
  const [notice, setNotice] = useState('');
  const mountedRef = useRef(true);

  const openExternal = useCallback((url) => {
    if (!url) return;
    try {
      window.openexam?.app?.openExternal?.(url);
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }, []);

  const refresh = useCallback(async (force = false) => {
    setLoading(true);
    setDetectError('');
    try {
      const result = await window.openexam?.runtimeEnv?.detect?.({ force });
      if (mountedRef.current) setData(result || null);
    } catch (error) {
      if (mountedRef.current) setDetectError(error?.message || '检测失败');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh(false);
    window.openexam?.runtimeEnv?.getState?.().then((state) => {
      if (mountedRef.current && state) setInstall(state);
    }).catch(() => {});
    const off = window.openexam?.runtimeEnv?.onProgress?.((payload) => {
      if (mountedRef.current) setInstall(payload);
    });
    return () => {
      mountedRef.current = false;
      off?.();
    };
  }, [refresh]);

  const startInstall = async () => {
    setNotice('');
    setInstall((prev) => (prev ? { ...prev, running: true } : prev));
    const result = await window.openexam?.runtimeEnv?.install?.({});
    if (result?.success) {
      setNotice(result.alreadyReady ? '环境已就绪，无需重复安装。' : '安装完成，现在可以解析 PDF 教材了。');
      await refresh(true);
    } else if (result?.error) {
      setNotice(result.error);
    }
  };

  const cancelInstall = async () => {
    await window.openexam?.runtimeEnv?.cancel?.();
  };

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice('命令已复制，粘贴到 PowerShell 或 CMD 里执行即可。');
    } catch {
      setNotice(`复制失败，请手动输入：${text}`);
    }
  };

  const useLegacy = async (legacy) => {
    const result = await window.openexam?.runtimeEnv?.useLegacy?.({ python: legacy.python });
    if (result?.success) {
      setNotice('已切换为复用旧环境，无需重复下载模型。');
      await refresh(true);
    } else {
      setNotice(result?.error || '复用旧环境失败');
    }
  };

  const mineru = data?.mineru;
  const obsidian = data?.obsidian;
  const running = Boolean(install?.running);
  const hasFailed = install?.steps?.some((step) => step.status === 'failed');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 4px 0' }}>运行环境</h3>
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0, lineHeight: 1.7 }}>
            PDF 教材解析需要 Python 与 MinerU（必需）；Obsidian 只影响「在 Obsidian 里打开」，笔记与知识图谱不依赖它（可选）。
          </p>
        </div>
        <button type="button" onClick={() => refresh(true)} disabled={loading || running} style={{ ...btn(false), opacity: loading ? 0.6 : 1 }}>
          {loading ? '检测中…' : '重新检测'}
        </button>
      </div>

      {detectError ? (
        <div style={{ ...cardStyle, borderColor: 'rgba(220,38,38,0.35)', color: 'var(--danger)', fontSize: 12 }}>
          检测失败：{detectError}
        </div>
      ) : null}

      {/* 安装进度 */}
      {(install && (running || install.steps?.some((step) => step.status !== 'pending'))) ? (
        <div style={cardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 13 }}>{running ? '正在安装解析环境' : (hasFailed ? '安装未完成' : '安装进度')}</strong>
            <StatusPill tone={running ? 'warning' : (hasFailed ? 'danger' : 'success')}>
              {running ? `进行中 ${install.percent || 0}%` : (hasFailed ? '有步骤失败' : '已完成')}
            </StatusPill>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>用时 {install.elapsed || 0}s</span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              {running ? (
                <button type="button" onClick={cancelInstall} style={btn(false)}>取消</button>
              ) : (
                <button type="button" onClick={startInstall} style={btn(true)}>重试安装</button>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {(install.steps || []).map((step) => (
              <div key={step.id} style={{ display: 'flex', gap: 9, fontSize: 12, alignItems: 'baseline' }}>
                <span style={{
                  width: 12, textAlign: 'center',
                  color: step.status === 'failed' ? 'var(--danger)' : (step.status === 'done' ? '#1a7f5a' : 'var(--muted)'),
                }}>{STEP_ICON[step.status] || '○'}</span>
                <span style={{ minWidth: 88, color: step.status === 'pending' ? 'var(--muted)' : 'var(--text)', fontWeight: step.status === 'running' ? 700 : 500 }}>{step.label}</span>
                <span style={{ color: step.status === 'failed' ? 'var(--danger)' : 'var(--muted)', wordBreak: 'break-all', flex: 1 }}>
                  {step.status === 'failed' ? step.error : (step.detail || '')}
                  {step.id === 'models' && running && install.bytes ? ` · 已下载 ${formatMB(install.bytes)}` : ''}
                </span>
              </div>
            ))}
          </div>

          {install.error ? (
            <div style={{ fontSize: 12, color: 'var(--danger)', lineHeight: 1.7 }}>
              {install.error}
              {install.code === 'need-python' ? '（先安装 Python，再回来点「重试安装」）' : ''}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Python */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 13 }}>Python</strong>
          <StatusPill tone={toneOf(mineru?.python?.ok)}>
            {mineru?.python?.ok ? `可用 ${mineru.python.version}` : (loading ? '检测中…' : '未就绪')}
          </StatusPill>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>PDF 解析必需 · 需要 3.10–3.12（64 位）</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button type="button" onClick={() => window.openexam?.runtimeEnv?.choosePython?.().then((res) => { if (res?.success) { setNotice('已保存 Python 路径'); refresh(true); } else if (res?.error) setNotice(res.error); })} style={btn(false)}>
              指定 Python…
            </button>
            <button type="button" onClick={() => refresh(true)} disabled={loading} style={btn(false)}>重试检测</button>
          </div>
        </div>
        {mineru?.python?.command ? (
          <div style={rowStyle}><span>解释器</span><code style={codeStyle} title={mineru.python.command}>{mineru.python.command}</code></div>
        ) : null}
        {!loading && !mineru?.python?.ok ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', borderRadius: 10, background: 'var(--surface-soft)', border: '1px dashed var(--line)' }}>
            <div style={{ fontSize: 12, color: 'var(--text)', fontWeight: 600 }}>{mineru?.python?.error || '未检测到 Python'}</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.8 }}>
              需要 {data?.mineru?.pythonHint?.versionRange || 'Python 3.10–3.12（64 位）'}。可任选一种方式安装：
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" onClick={() => copyText(data?.mineru?.pythonHint?.winget || 'winget install -e --id Python.Python.3.12')} style={btn(false)}>复制 winget 命令</button>
              <button type="button" onClick={() => openExternal(data?.mineru?.pythonHint?.downloadUrl || 'https://www.python.org/downloads/windows/')} style={btn(false)}>打开官网下载</button>
            </div>
            <code style={{ ...codeStyle, whiteSpace: 'normal', fontSize: 11 }}>{data?.mineru?.pythonHint?.winget || 'winget install -e --id Python.Python.3.12'}</code>
            <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.7 }}>
              {(data?.mineru?.pythonHint?.steps || []).map((line) => <div key={line}>· {line}</div>)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.7 }}>{data?.mineru?.pythonHint?.whyNotAuto}</div>
          </div>
        ) : null}
      </div>

      {/* MinerU */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 13 }}>MinerU 解析引擎</strong>
          <StatusPill tone={toneOf(mineru?.mineru?.ok, false)}>
            {mineru?.mineru?.ok ? `已安装${mineru.mineru.version ? ` ${mineru.mineru.version}` : ''}` : (loading ? '检测中…' : '未就绪')}
          </StatusPill>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>PDF 解析必需</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={startInstall}
              disabled={running || !mineru?.python?.ok || Boolean(mineru?.ready)}
              title={!mineru?.python?.ok ? '先安装 Python' : (mineru?.ready ? '环境已就绪' : '')}
              style={{ ...btn(true), opacity: running || !mineru?.python?.ok || mineru?.ready ? 0.55 : 1 }}
            >
              {mineru?.ready
                ? '环境已就绪'
                : (mineru?.python?.ok && mineru?.mineru?.ok ? '下载模型' : '一键安装解析环境')}
            </button>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 8 }}>
          <div style={rowStyle}>
            <StatusPill tone={toneOf(mineru?.mineru?.ok)}>{mineru?.mineru?.ok ? '✓' : '!'}</StatusPill>
            <span>mineru 包</span>
            <span style={{ color: 'var(--text)', marginLeft: 'auto' }}>{mineru?.mineru?.ok ? (mineru.mineru.version || '已安装') : '未安装'}</span>
          </div>
          <div style={rowStyle}>
            <StatusPill tone={toneOf(mineru?.models?.ok)}>{mineru?.models?.ok ? '✓' : '!'}</StatusPill>
            <span>本地模型</span>
            <span style={{ color: 'var(--text)', marginLeft: 'auto' }}>
              {mineru?.models?.ok ? `${formatMB(mineru.models.bytes)}${mineru.models.reused ? '（复用旧环境）' : ''}` : formatMB(mineru?.models?.bytes || 0)}
            </span>
          </div>
          <div style={rowStyle}>
            <StatusPill tone={toneOf(mineru?.workDir?.ok)}>{mineru?.workDir?.ok ? '✓' : '!'}</StatusPill>
            <span>工作目录</span>
            <code style={{ ...codeStyle, marginLeft: 'auto' }} title={mineru?.workDir?.path}>{mineru?.workDir?.path || '—'}</code>
          </div>
          <div style={rowStyle}>
            <StatusPill tone={toneOf(mineru?.script?.ok)}>{mineru?.script?.ok ? '✓' : '!'}</StatusPill>
            <span>解析脚本</span>
            <span style={{ color: 'var(--text)', marginLeft: 'auto' }}>{mineru?.script?.ok ? '已就位' : '缺失'}</span>
          </div>
        </div>

        {mineru?.models?.path ? (
          <div style={{ ...rowStyle, fontSize: 11 }}>
            <span>模型目录</span>
            <code style={codeStyle} title={mineru.models.path}>{mineru.models.path}</code>
          </div>
        ) : null}

        {mineru?.missing?.length ? (
          <div style={{ fontSize: 12, color: '#b45309', lineHeight: 1.7 }}>
            当前缺失：{mineru.missing.map((key) => ({
              python: 'Python', mineru: 'MinerU 包', models: '本地模型', workDir: '工作目录', script: '解析脚本',
            }[key] || key)).join('、')}。上传 PDF 前会先检查，缺项不会进入解析流程。
          </div>
        ) : null}
      </div>

      {/* 旧环境复用 */}
      {(data?.mineru?.legacy || []).length ? (
        <div style={{ ...cardStyle, gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 13 }}>检测到旧环境</strong>
            <StatusPill tone="idle">可复用，不用重复下载</StatusPill>
          </div>
          {(data.mineru.legacy || []).map((legacy) => (
            <div key={`${legacy.python}-${legacy.homeDir}`} style={{ ...rowStyle, justifyContent: 'space-between' }}>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                <code style={codeStyle} title={legacy.python}>{legacy.python || '（无解释器）'}</code>
                <code style={codeStyle} title={legacy.homeDir}>{legacy.homeDir || '（无模型目录）'}</code>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 11 }}>模型 {formatMB(legacy.modelsBytes)}</span>
                {legacy.writable === false ? <StatusPill tone="warning">目录不可写</StatusPill> : null}
                <button
                  type="button"
                  onClick={() => useLegacy(legacy)}
                  disabled={legacy.writable === false || !legacy.python}
                  title={legacy.writable === false ? '这套旧环境的目录当前不可写，复用后会解析失败' : ''}
                  style={{ ...btn(false), opacity: legacy.writable === false || !legacy.python ? 0.5 : 1 }}
                >
                  复用这套环境
                </button>
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {/* Obsidian */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 13 }}>Obsidian</strong>
          <StatusPill tone={obsidian?.installed ? 'success' : 'idle'}>
            {obsidian?.installed ? `已安装${obsidian.version ? ` ${obsidian.version}` : ''}` : '未安装（可选）'}
          </StatusPill>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>可选依赖 · 不影响笔记、知识图谱与题库</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button type="button" onClick={() => refresh(true)} disabled={loading} style={btn(false)}>重试检测</button>
            <button type="button" onClick={() => openExternal(obsidian?.downloadUrl || 'https://obsidian.md/download')} style={btn(false)}>
              下载 Obsidian
            </button>
            <button type="button" onClick={() => window.openexam?.obsidian?.openVault?.().then((res) => setNotice(res?.message || res?.error || '已打开仓库'))} style={btn(false)}>
              打开仓库
            </button>
          </div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.8 }}>
          没装 Obsidian 时：应用仍会自动创建仓库、笔记照常写入；点「用 Obsidian 打开」会回落到系统默认程序，并在这里说明原因。
        </div>
        {obsidian?.exe ? (
          <div style={rowStyle}><span>客户端</span><code style={codeStyle} title={obsidian.exe}>{obsidian.exe}</code></div>
        ) : null}
      </div>

      {notice ? (
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.7 }}>{notice}</div>
      ) : null}
    </div>
  );
}
