import React, { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * 设置 → 学科插件：管理内置 / 第三方分析插件。
 *
 * 这里只调用 plugins IPC；插件的校验、启用状态、导入与删除都在主进程完成。
 */

const BTN = (primary) => ({
  border: primary ? '1px solid var(--accent)' : '1px solid var(--line)',
  background: primary ? 'var(--accent)' : 'var(--surface)',
  color: primary ? '#fff' : 'var(--text)',
  borderRadius: 7,
  padding: '5px 10px',
  fontSize: 11.5,
  fontWeight: 600,
  cursor: 'pointer',
});

const CARD = {
  border: '1px solid var(--line)',
  borderRadius: 10,
  background: 'var(--surface)',
  padding: 12,
};

function Toggle({ checked, disabled, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        width: 38,
        height: 21,
        borderRadius: 999,
        border: 'none',
        padding: 2,
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: checked ? 'var(--accent)' : 'var(--line-strong, #cbd5e1)',
        opacity: disabled ? 0.5 : 1,
        display: 'flex',
        justifyContent: checked ? 'flex-end' : 'flex-start',
        alignItems: 'center',
        transition: 'background 0.2s',
      }}
    >
      <span style={{ width: 17, height: 17, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.2)' }} />
    </button>
  );
}

export default function PluginManager({ onOpenAnalysis }) {
  const [plugins, setPlugins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [detailId, setDetailId] = useState('');
  const [detail, setDetail] = useState(null);
  const [discipline, setDiscipline] = useState('');
  const [allowThirdParty, setAllowThirdParty] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await window.openexam.plugins.list();
      setPlugins(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
    window.openexam?.plugins?.devMode?.()
      .then((res) => setAllowThirdParty(Boolean(res?.allowThirdParty)))
      .catch(() => setAllowThirdParty(false));
  }, [reload]);

  const disciplines = useMemo(() => {
    const set = new Set();
    plugins.forEach((plugin) => (plugin.disciplines || []).forEach((item) => set.add(item)));
    return [...set];
  }, [plugins]);

  const visible = useMemo(
    () => plugins.filter((plugin) => (!discipline || (plugin.disciplines || []).includes(discipline))),
    [plugins, discipline],
  );

  const toggle = async (plugin) => {
    setBusyId(plugin.id);
    setError('');
    try {
      const res = await window.openexam.plugins.setEnabled(plugin.id, !plugin.enabled);
      if (!res?.success) throw new Error(res?.error || '操作失败');
      setPlugins((prev) => prev.map((item) => (item.id === plugin.id ? { ...item, enabled: res.plugin.enabled } : item)));
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusyId('');
    }
  };

  const showDetail = async (plugin) => {
    if (detailId === plugin.id) {
      setDetailId('');
      setDetail(null);
      return;
    }
    setDetailId(plugin.id);
    setDetail(null);
    try {
      const res = await window.openexam.plugins.detail(plugin.id);
      if (res?.success) setDetail(res.plugin);
      else setError(res?.error || '读取详情失败');
    } catch (err) {
      setError(err?.message || String(err));
    }
  };

  const importFile = async () => {
    setError('');
    setNotice('');
    try {
      const res = await window.openexam.plugins.importFile();
      if (res?.canceled) return;
      if (!res?.success) throw new Error(res?.error || '导入失败');
      setNotice(`已导入「${res.plugin?.name || '插件'}」${res.replaced ? '（覆盖了同名插件）' : ''}；第三方插件默认禁用，请确认后手动启用。`);
      await reload();
    } catch (err) {
      setError(err?.message || String(err));
    }
  };

  const remove = async (plugin) => {
    const ok = window.confirm?.(`删除第三方插件「${plugin.name}」？该操作只删除插件清单，不影响题库与笔记。`) ?? false;
    if (!ok) return;
    setBusyId(plugin.id);
    setError('');
    try {
      const res = await window.openexam.plugins.remove(plugin.id);
      if (!res?.success) throw new Error(res?.error || '删除失败');
      setPlugins((prev) => prev.filter((item) => item.id !== plugin.id));
      if (detailId === plugin.id) { setDetailId(''); setDetail(null); }
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusyId('');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>学科插件</h3>
          <p style={{ fontSize: 12, color: 'var(--muted)', maxWidth: 640, lineHeight: 1.7 }}>
            插件按学科归类，负责把特定学科的题目转成结构化结果并由代码完成确定性计算。
            内置插件随应用分发{allowThirdParty ? '；开发模式下可导入 / 删除第三方插件。' : '；当前版本不开放第三方插件导入。'}
          </p>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {allowThirdParty ? <button type="button" style={BTN(true)} onClick={importFile}>从本地文件导入</button> : null}
          <button type="button" style={BTN(false)} onClick={reload} disabled={loading}>{loading ? '刷新中…' : '刷新'}</button>
        </div>
      </div>

      {notice ? (
        <div style={{ ...CARD, borderColor: 'var(--ai-success, #16a34a)', color: 'var(--ai-success, #15803d)', fontSize: 11.5 }}>{notice}</div>
      ) : null}
      {error ? (
        <div style={{ ...CARD, borderColor: 'var(--danger)', color: 'var(--danger)', fontSize: 11.5, whiteSpace: 'pre-wrap' }}>{error}</div>
      ) : null}

      {disciplines.length ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {['', ...disciplines].map((item) => (
            <button
              key={item || 'all'}
              type="button"
              onClick={() => setDiscipline(item)}
              style={{
                ...BTN(false),
                padding: '4px 10px',
                ...(discipline === item ? { background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' } : {}),
              }}
            >{item || '全部学科'}</button>
          ))}
        </div>
      ) : null}

      {!visible.length && !loading ? (
        <div style={{ ...CARD, fontSize: 12, color: 'var(--muted)' }}>还没有安装任何插件。</div>
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {visible.map((plugin) => (
          <div key={plugin.id} style={{ ...CARD, opacity: plugin.invalid ? 0.85 : 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>{plugin.name}</span>
              <span style={{
                fontSize: 10, padding: '1px 6px', borderRadius: 999, fontWeight: 600,
                background: plugin.builtin ? 'var(--accent-soft-bg)' : 'var(--surface-soft)',
                color: plugin.builtin ? 'var(--accent)' : 'var(--muted)',
                border: plugin.builtin ? 'none' : '1px solid var(--line)',
              }}>{plugin.builtin ? '内置' : '第三方'}</span>
              {plugin.invalid ? (
                <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, background: '#fee2e2', color: '#b91c1c', fontWeight: 600 }}>不可用</span>
              ) : null}
              <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>v{plugin.version || '—'}</span>
              {(plugin.disciplines || []).map((item) => (
                <span key={item} style={{ fontSize: 10, color: 'var(--muted)', border: '1px solid var(--line)', borderRadius: 999, padding: '1px 7px' }}>{item}</span>
              ))}
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                <button type="button" style={BTN(false)} onClick={() => showDetail(plugin)}>
                  {detailId === plugin.id ? '收起详情' : '说明与权限'}
                </button>
                {!plugin.invalid && plugin.enabled ? (
                  <button type="button" style={BTN(false)} onClick={() => onOpenAnalysis?.(plugin.id)}>打开分析</button>
                ) : null}
                {!plugin.builtin && allowThirdParty ? (
                  <button type="button" style={{ ...BTN(false), color: 'var(--danger)' }} onClick={() => remove(plugin)} disabled={busyId === plugin.id}>删除</button>
                ) : null}
                <Toggle
                  checked={Boolean(plugin.enabled)}
                  disabled={plugin.invalid || busyId === plugin.id}
                  onChange={() => toggle(plugin)}
                />
              </div>
            </div>

            <p style={{ margin: '6px 0 0', fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.65 }}>{plugin.description}</p>

            {plugin.invalid && plugin.errors?.length ? (
              <div style={{ marginTop: 6, fontSize: 11, color: 'var(--danger)', lineHeight: 1.6 }}>
                {plugin.errors.map((item, index) => <div key={index}>· {item}</div>)}
              </div>
            ) : null}

            {detailId === plugin.id ? (
              <div style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                {!detail ? (
                  <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>读取中…</div>
                ) : (
                  <>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 3 }}>适用学科 / 课程</div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.7 }}>
                        {(detail.disciplines || []).join('、') || '未声明'}
                        {detail.match?.keywords?.length ? <div>关键词：{detail.match.keywords.join('、')}</div> : null}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 3 }}>接受的输入</div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.7 }}>
                        {(detail.inputLabels || []).map((item) => <div key={item}>· {item}</div>)}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 3 }}>输出</div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.7 }}>
                        {(detail.outputLabels || []).map((item) => <div key={item}>· {item}</div>)}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 3 }}>权限与能力</div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.7 }}>
                        {(detail.capabilityLabels || []).map((item) => <div key={item}>· {item}</div>)}
                        <div style={{ marginTop: 3 }}>不读取题库 / 笔记 / 其它科目数据，不发起额外网络请求。</div>
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 3 }}>分析引擎</div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.7 }}>
                        {(detail.engines || []).map((engine) => <div key={engine.id}>· {engine.label}：{engine.description}</div>)}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 3 }}>来源</div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.7 }}>
                        {detail.builtin ? '随应用内置分发' : (detail.dir || '本地导入')}
                        {detail.installedAt ? <div>导入时间：{new Date(detail.installedAt).toLocaleString('zh-CN')}</div> : null}
                      </div>
                    </div>
                  </>
                )}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
