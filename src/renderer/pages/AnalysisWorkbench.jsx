import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AnalysisDiagram from '../components/AnalysisDiagram.jsx';
import AIMessageContent from '../components/AIMessageContent.jsx';
import { getAISettings } from '../store/aiSettings.js';
import { readFileAsBase64, MAX_ASSISTANT_IMAGES } from '../utils/imageInput.js';

/**
 * 学科分析工作台。
 *
 * 流程（与插件机制一致）：
 *   题干/图片 → 模型只做结构化抽取 → 代码校验并画图 → 用户核对/修改 →
 *   代码确定性计算 → 模型只做讲解。
 * 所有数值都来自 `plugins:solve` 的返回，界面不自己算。
 */

const BTN = (primary) => ({
  border: primary ? '1px solid var(--accent)' : '1px solid var(--line)',
  background: primary ? 'var(--accent)' : 'var(--surface)',
  color: primary ? '#fff' : 'var(--text)',
  borderRadius: 8,
  padding: '7px 12px',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
});

const CARD = {
  border: '1px solid var(--line)',
  borderRadius: 12,
  background: 'var(--surface)',
  padding: 14,
};

const INPUT = {
  width: '100%',
  padding: '6px 8px',
  borderRadius: 7,
  border: '1px solid var(--line)',
  background: 'var(--surface-soft)',
  color: 'var(--text)',
  fontSize: 12,
  boxSizing: 'border-box',
};

const ELEMENT_TYPES = [
  { id: 'resistor', label: '电阻' },
  { id: 'voltage_source', label: '电压源' },
  { id: 'current_source', label: '电流源' },
  { id: 'switch', label: '开关' },
  { id: 'capacitor', label: '电容' },
  { id: 'inductor', label: '电感' },
  { id: 'wire', label: '导线' },
];

function uniqueId(prefix, list) {
  let index = list.length + 1;
  const ids = new Set((list || []).map((item) => String(item?.id || '')));
  while (ids.has(`${prefix}${index}`)) index += 1;
  return `${prefix}${index}`;
}

function currentSettings() {
  try {
    return getAISettings();
  } catch {
    return {};
  }
}

export default function AnalysisWorkbench({ pluginId, seed, onBack, onOpenSettings }) {
  const [plugin, setPlugin] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [text, setText] = useState(seed?.text || '');
  const [images, setImages] = useState(Array.isArray(seed?.images) ? seed.images : []);
  const [ir, setIr] = useState(null);
  const [result, setResult] = useState(null);
  const [explanation, setExplanation] = useState('');
  const [explainError, setExplainError] = useState('');
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState('');
  const [dirty, setDirty] = useState(false);
  const [clarify, setClarify] = useState({});
  const [extraClarify, setExtraClarify] = useState('');
  const fileRef = useRef(null);
  const autoRan = useRef(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const detail = await window.openexam.plugins.detail(pluginId);
        if (!alive) return;
        if (!detail?.success) {
          setLoadError(detail?.error || '插件不存在');
          return;
        }
        setPlugin(detail.plugin);
      } catch (err) {
        if (alive) setLoadError(err?.message || String(err));
      }
    })();
    return () => { alive = false; };
  }, [pluginId]);

  const solve = useCallback(async (nextIr, options = {}) => {
    if (!nextIr) return null;
    setBusy('solve');
    setError('');
    try {
      const res = await window.openexam.plugins.solve({ pluginId, ir: nextIr, ignoreAmbiguities: Boolean(options.ignoreAmbiguities) });
      if (!res?.success) {
        setError(res?.error || '计算失败');
        setResult(null);
        return null;
      }
      setResult(res.result);
      setDirty(false);
      if (options.explain) {
        // 不做自动讲解：讲解是一次额外模型调用，由用户决定
      }
      return res.result;
    } finally {
      setBusy('');
    }
  }, [pluginId]);

  const extract = useCallback(async (clarifyText = '') => {
    const merged = [text, clarifyText].filter(Boolean).join('\n\n');
    setBusy('extract');
    setError('');
    setWarning('');
    setRaw('');
    setExplanation('');
    setExplainError('');
    try {
      const res = await window.openexam.plugins.extract({
        pluginId,
        text: merged,
        images: images.map(({ base64, mimeType }) => ({ base64, mimeType })),
        settings: currentSettings(),
      });
      if (!res?.success) {
        setError(res?.error || '识别失败');
        setRaw(res?.raw || '');
        return;
      }
      setWarning(res.warning || '');
      setRaw(res.raw || '');
      setIr(res.ir);
      setDirty(false);
      await solve(res.ir, { ignoreAmbiguities: false });
    } finally {
      setBusy('');
    }
  }, [pluginId, text, images, solve]);

  // 从答疑带入题目时自动跑一次；只在首次挂载时触发
  useEffect(() => {
    if (autoRan.current) return;
    if (!plugin) return;
    if (!(seed?.text || (seed?.images || []).length)) return;
    autoRan.current = true;
    extract();
  }, [plugin, seed, extract]);

  const addImages = useCallback(async (files) => {
    const list = Array.from(files || []).slice(0, MAX_ASSISTANT_IMAGES);
    const next = [];
    for (const file of list) {
      try {
        const { base64, mimeType } = await readFileAsBase64(file);
        if (base64) next.push({ base64, mimeType, dataUrl: `data:${mimeType};base64,${base64}` });
      } catch (err) {
        setWarning(err?.message || String(err));
      }
    }
    if (next.length) setImages((prev) => [...prev, ...next].slice(0, MAX_ASSISTANT_IMAGES));
  }, []);

  const explain = useCallback(async () => {
    if (!ir || !result) return;
    setBusy('explain');
    setExplainError('');
    try {
      const res = await window.openexam.plugins.explain({
        pluginId,
        ir,
        result,
        question: text,
        settings: currentSettings(),
      });
      if (!res?.success) {
        setExplainError(res?.error || '讲解生成失败');
        return;
      }
      setExplanation(res.text || '');
    } finally {
      setBusy('');
    }
  }, [pluginId, ir, result, text]);

  const updateIr = (updater) => {
    setIr((prev) => {
      if (!prev) return prev;
      const next = typeof updater === 'function' ? updater(prev) : updater;
      return next;
    });
    setDirty(true);
  };

  const updateElement = (index, patch) => updateIr((prev) => ({
    ...prev,
    elements: (prev.elements || []).map((element, i) => (i === index ? { ...element, ...patch } : element)),
  }));

  const removeElement = (index) => updateIr((prev) => ({
    ...prev,
    elements: (prev.elements || []).filter((_, i) => i !== index),
  }));

  const addNode = (prefix = 'n') => updateIr((prev) => {
    const nodes = Array.isArray(prev.nodes) ? prev.nodes : [];
    return { ...prev, nodes: [...nodes, { id: uniqueId(prefix, nodes), label: '' }] };
  });

  const addElement = () => updateIr((prev) => {
    let nodes = Array.isArray(prev.nodes) ? prev.nodes : [];
    if (nodes.length < 2) {
      nodes = nodes.slice();
      while (nodes.length < 2) nodes.push({ id: uniqueId('n', nodes), label: '' });
    }
    const elements = Array.isArray(prev.elements) ? prev.elements : [];
    return {
      ...prev,
      nodes,
      elements: [...elements, {
        id: uniqueId('E', elements),
        label: '',
        type: 'resistor',
        from: nodes[0].id,
        to: nodes[1].id,
        value: 1,
        unit: 'Ω',
      }],
    };
  });

  const updateBus = (index, patch) => updateIr((prev) => ({
    ...prev,
    buses: (prev.buses || []).map((bus, i) => (i === index ? { ...bus, ...patch } : bus)),
  }));
  const updateBranch = (index, patch) => updateIr((prev) => ({
    ...prev,
    branches: (prev.branches || []).map((branch, i) => (i === index ? { ...branch, ...patch } : branch)),
  }));
  const updateLoad = (index, patch) => updateIr((prev) => ({
    ...prev,
    loads: (prev.loads || []).map((load, i) => (i === index ? { ...load, ...patch } : load)),
  }));
  const updatePhasor = (index, patch) => updateIr((prev) => ({
    ...prev,
    phasors: (prev.phasors || []).map((item, i) => (i === index ? { ...item, ...patch } : item)),
  }));
  const addPhasor = () => updateIr((prev) => {
    const list = Array.isArray(prev.phasors) ? prev.phasors : [];
    return {
      ...prev,
      phasors: [...list, {
        id: uniqueId('P', list), label: '', quantity: 'voltage',
        magnitude: 100, unit: 'V', angle: 0,
      }],
    };
  });
  const addBus = () => updateIr((prev) => {
    const buses = Array.isArray(prev.buses) ? prev.buses : [];
    return { ...prev, buses: [...buses, { id: uniqueId('B', buses), label: '', voltage: 0, unit: 'kV' }] };
  });
  const addBranch = () => updateIr((prev) => {
    const buses = Array.isArray(prev.buses) ? prev.buses : [];
    if (buses.length < 2) return prev;
    const branches = Array.isArray(prev.branches) ? prev.branches : [];
    return {
      ...prev,
      branches: [...branches, {
        id: uniqueId('L', branches), label: '', type: 'line',
        from: buses[0].id, to: buses[1].id, r: 0.1, x: 0.1, unit: 'Ω',
      }],
    };
  });
  const addLoad = () => updateIr((prev) => {
    const buses = Array.isArray(prev.buses) ? prev.buses : [];
    if (!buses.length) return prev;
    const loads = Array.isArray(prev.loads) ? prev.loads : [];
    return { ...prev, loads: [...loads, { id: uniqueId('LD', loads), label: '', bus: buses[0].id, p: 100, unit: 'kW', pf: 0.9 }] };
  });

  const ambiguityList = useMemo(() => {
    const fromIr = Array.isArray(ir?.ambiguities) ? ir.ambiguities : [];
    const fromResult = Array.isArray(result?.ambiguities) ? result.ambiguities : [];
    const merged = [...fromIr, ...fromResult];
    const seen = new Set();
    return merged.filter((item) => {
      const key = String(item?.question || '');
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [ir, result]);

  const clarificationText = useMemo(() => {
    const parts = Object.entries(clarify).map(([question, choice]) => `关于「${question}」：${choice}`);
    if (extraClarify.trim()) parts.push(extraClarify.trim());
    return parts.length ? `【读图澄清】\n${parts.join('\n')}` : '';
  }, [clarify, extraClarify]);

  const nodes = Array.isArray(ir?.nodes) ? ir.nodes : [];
  const isOneLine = ir?.kind === 'one-line';
  const isPhasor = ir?.kind === 'phasor';
  const stepDiagrams = (result?.steps || []).filter((step) => step.diagram);

  if (loadError) {
    return (
      <section className="main-panel module-page" style={{ padding: 24 }}>
        <div style={{ ...CARD, color: 'var(--danger)' }}>{loadError}</div>
      </section>
    );
  }

  return (
    <section className="main-panel module-page" style={{ padding: '16px 20px 28px', overflow: 'auto' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {onBack ? <button type="button" style={BTN(false)} onClick={onBack}>← 返回</button> : null}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{plugin?.name || pluginId}</h2>
            <span style={{ fontSize: 10.5, padding: '2px 7px', borderRadius: 999, background: 'var(--accent-soft-bg)', color: 'var(--accent)', fontWeight: 600 }}>
              {plugin?.builtin ? '内置插件' : '第三方插件'}
            </span>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>v{plugin?.version || '—'}</span>
          </div>
          <p style={{ margin: 0, fontSize: 11.5, color: 'var(--muted)', maxWidth: 760, lineHeight: 1.6 }}>
            {plugin?.description || ''}
          </p>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {onOpenSettings ? <button type="button" style={BTN(false)} onClick={() => onOpenSettings('plugins')}>插件管理</button> : null}
        </div>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 360px) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
        {/* 输入与澄清 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={CARD}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>题目输入</div>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={6}
              placeholder="贴入题干文字；也可以只上传题目图片 / 手写图照片。"
              style={{ ...INPUT, resize: 'vertical', lineHeight: 1.6 }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <button type="button" style={BTN(false)} onClick={() => fileRef.current?.click()}>＋ 图片</button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: 'none' }}
                onChange={async (event) => { await addImages(event.target.files); event.target.value = ''; }}
              />
              <button
                type="button"
                style={{ ...BTN(true), marginLeft: 'auto', opacity: busy === 'extract' ? 0.6 : 1 }}
                disabled={busy === 'extract'}
                onClick={() => extract(clarificationText)}
              >
                {busy === 'extract' ? '识别中…' : '识别并画简图'}
              </button>
            </div>
            {images.length ? (
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                {images.map((image, index) => (
                  <div key={`${index}-${image.dataUrl?.slice(-10)}`} style={{ position: 'relative' }}>
                    <img src={image.dataUrl} alt="" style={{ width: 52, height: 52, objectFit: 'cover', borderRadius: 7, border: '1px solid var(--line)' }} />
                    <button
                      type="button"
                      onClick={() => setImages((prev) => prev.filter((_, i) => i !== index))}
                      style={{ position: 'absolute', top: -6, right: -6, width: 17, height: 17, borderRadius: 9, border: 'none', background: 'var(--danger)', color: '#fff', cursor: 'pointer', fontSize: 10, lineHeight: '17px', padding: 0 }}
                    >×</button>
                  </div>
                ))}
              </div>
            ) : null}
            <textarea
              value={extraClarify}
              onChange={(event) => setExtraClarify(event.target.value)}
              rows={2}
              placeholder="补充说明（可选）：比如「右边那个电阻是 5Ω」「开关是断开的」"
              style={{ ...INPUT, marginTop: 8, resize: 'vertical', lineHeight: 1.6 }}
            />
            <p style={{ margin: '8px 0 0', fontSize: 10.5, color: 'var(--muted)', lineHeight: 1.6 }}>
              模型只负责读题/读图并转成结构化结果；计算与画图由本机代码完成。
            </p>
          </div>

          {ambiguityList.length ? (
            <div style={{ ...CARD, borderColor: 'var(--warning, #d97706)' }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6, color: 'var(--warning, #b45309)' }}>读图有歧义，请先确认</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {ambiguityList.map((item, index) => (
                  <div key={`${item.question}-${index}`}>
                    <div style={{ fontSize: 11.5, lineHeight: 1.6 }}>{item.question}</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 5 }}>
                      {(item.options || []).map((option) => {
                        const active = clarify[item.question] === option;
                        return (
                          <button
                            key={option}
                            type="button"
                            onClick={() => setClarify((prev) => ({ ...prev, [item.question]: option }))}
                            style={{
                              ...BTN(false),
                              padding: '4px 9px',
                              fontSize: 11,
                              ...(active ? { background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' } : {}),
                            }}
                          >{option}</button>
                        );
                      })}
                      <input
                        value={clarify[item.question] && !(item.options || []).includes(clarify[item.question]) ? clarify[item.question] : ''}
                        onChange={(event) => setClarify((prev) => ({ ...prev, [item.question]: event.target.value }))}
                        placeholder="或填写实际情况"
                        style={{ ...INPUT, width: 150, padding: '3px 7px', fontSize: 11 }}
                      />
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  style={{ ...BTN(true), alignSelf: 'flex-start', opacity: busy === 'extract' ? 0.6 : 1 }}
                  disabled={busy === 'extract'}
                  onClick={() => extract(clarificationText)}
                >带着澄清重新识别</button>
              </div>
            </div>
          ) : null}
        </div>

        {/* 简图 + 编辑 + 结果 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          {error ? (
            <div style={{ ...CARD, borderColor: 'var(--danger)', color: 'var(--danger)', fontSize: 12, lineHeight: 1.7 }}>
              {error}
              {raw ? (
                <details style={{ marginTop: 8 }}>
                  <summary style={{ cursor: 'pointer', fontSize: 11 }}>查看模型原始输出</summary>
                  <pre style={{ whiteSpace: 'pre-wrap', fontSize: 10.5, maxHeight: 220, overflow: 'auto' }}>{raw}</pre>
                </details>
              ) : null}
            </div>
          ) : null}

          {warning ? (
            <div style={{ ...CARD, borderColor: 'var(--line)', fontSize: 11.5, color: 'var(--muted)' }}>{warning}</div>
          ) : null}

          {!ir ? (
            <div style={{ ...CARD, minHeight: 260, display: 'grid', placeItems: 'center', color: 'var(--muted)', fontSize: 12 }}>
              还没有结构化结果。贴入题干或上传图片后点「识别并画简图」。
            </div>
          ) : (
            <>
              <div style={CARD}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 700 }}>简图（请核对）</span>
                  <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                    {isPhasor ? '电压 / 电流相量' : isOneLine ? '母线 + 支路 + 负荷' : '元件 + 连接'}
                    {' · '}
                    共 {isPhasor ? (ir.phasors || []).length : ((ir.elements || []).length || (ir.buses || []).length)} 个
                  </span>
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                    <button type="button" style={{ ...BTN(false), opacity: busy === 'solve' ? 0.6 : 1 }} disabled={busy === 'solve'} onClick={() => solve(ir)}>
                      {busy === 'solve' ? '计算中…' : dirty ? '重新计算（有修改）' : '重新计算'}
                    </button>
                  </div>
                </div>
                <div style={{ border: '1px solid var(--line)', borderRadius: 10, background: 'var(--surface-soft)', overflow: 'hidden' }}>
                  <AnalysisDiagram ir={ir} result={result} />
                </div>
                {result?.needsClarification ? (
                  <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--warning, #b45309)' }}>
                    还有 {result.ambiguities?.length || 0} 个歧义未确认，确认后才会计算。
                  </div>
                ) : null}
              </div>

              {/* 分步化简图：每一步都复用原始节点布局，避免相邻步骤位置跳动 */}
              {stepDiagrams.length ? (
                <div style={CARD}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>分步化简图</span>
                    <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>高亮部分为这一步新产生的等效元件；节点位置与上图一致</span>
                  </div>
                  <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 6 }}>
                    {stepDiagrams.map((step, index) => (
                      <div key={index} style={{ flex: '0 0 300px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--surface-soft)', padding: 8 }}>
                        <div style={{ fontSize: 11.5, fontWeight: 700, marginBottom: 4 }}>
                          第 {index + 1} 步 · {step.title}
                        </div>
                        <AnalysisDiagram ir={step.diagram} result={null} />
                        <div style={{ fontSize: 10.5, color: 'var(--muted)', lineHeight: 1.6, marginTop: 4 }}>
                          {step.detail}
                          {step.formula ? <div>依据：{step.formula}</div> : null}
                          {step.value ? <div style={{ color: 'var(--text)', fontWeight: 600 }}>{step.value}</div> : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* 结构化编辑 */}
              <div style={CARD}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 700 }}>结构化结果（可直接修改）</span>
                  <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>改完点上面的「重新计算」</span>
                </div>
                {isPhasor ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 12 }}>参考轴</strong>
                      <input
                        style={{ ...INPUT, width: 120, padding: '3px 6px' }}
                        value={ir.reference?.label || ''}
                        placeholder="参考相量名"
                        onChange={(e) => updateIr((prev) => ({ ...prev, reference: { ...(prev.reference || {}), label: e.target.value } }))}
                      />
                      <span style={{ color: 'var(--muted)' }}>角度</span>
                      <input
                        style={{ ...INPUT, width: 70, padding: '3px 6px' }}
                        value={ir.reference?.angle ?? 0}
                        onChange={(e) => updateIr((prev) => ({ ...prev, reference: { ...(prev.reference || {}), angle: e.target.value } }))}
                      />
                      <span style={{ color: 'var(--muted)' }}>°</span>
                      <button type="button" style={BTN(false)} onClick={addPhasor}>＋ 相量</button>
                    </div>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                      <thead>
                        <tr>{['', '名称', '类型', '幅值', '单位', '角度(°)'].map((head) => (
                          <th key={head} style={{ textAlign: 'left', padding: 3, color: 'var(--muted)', fontWeight: 500 }}>{head}</th>
                        ))}</tr>
                      </thead>
                      <tbody>
                        {(ir.phasors || []).map((item, index) => (
                          <tr key={index}>
                            <td style={{ padding: 3 }}>
                              <button type="button" style={{ ...BTN(false), padding: '1px 6px', fontSize: 10 }}
                                onClick={() => updateIr((prev) => ({ ...prev, phasors: (prev.phasors || []).filter((_, i) => i !== index) }))}>删</button>
                            </td>
                            <td style={{ padding: 3 }}><input style={{ ...INPUT, padding: '3px 6px' }} value={item.label || ''} onChange={(e) => updatePhasor(index, { label: e.target.value })} /></td>
                            <td style={{ padding: 3 }}>
                              <select style={{ ...INPUT, padding: '3px 6px' }} value={item.quantity || 'voltage'} onChange={(e) => updatePhasor(index, { quantity: e.target.value })}>
                                <option value="voltage">电压</option>
                                <option value="current">电流</option>
                              </select>
                            </td>
                            <td style={{ padding: 3 }}><input style={{ ...INPUT, padding: '3px 6px' }} value={item.magnitude ?? ''} onChange={(e) => updatePhasor(index, { magnitude: e.target.value })} /></td>
                            <td style={{ padding: 3 }}><input style={{ ...INPUT, width: 56, padding: '3px 6px' }} value={item.unit || ''} onChange={(e) => updatePhasor(index, { unit: e.target.value })} /></td>
                            <td style={{ padding: 3 }}><input style={{ ...INPUT, padding: '3px 6px' }} value={item.angle ?? 0} onChange={(e) => updatePhasor(index, { angle: e.target.value })} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : isOneLine ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                        <strong style={{ fontSize: 12 }}>母线</strong>
                        <button type="button" style={BTN(false)} onClick={addBus}>＋ 母线</button>
                      </div>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                        <thead><tr>{['', 'id', '名称', '电压(kV)'].map((head) => <th key={head} style={{ textAlign: 'left', padding: 3, color: 'var(--muted)', fontWeight: 500 }}>{head}</th>)}</tr></thead>
                        <tbody>
                          {(ir.buses || []).map((bus, index) => (
                            <tr key={index}>
                              <td style={{ padding: 3 }}>
                                <button type="button" style={{ ...BTN(false), padding: '1px 6px', fontSize: 10 }}
                                  onClick={() => updateIr((prev) => ({ ...prev, buses: (prev.buses || []).filter((_, i) => i !== index) }))}>删</button>
                              </td>
                              <td style={{ padding: 3 }}><input style={{ ...INPUT, padding: '3px 6px' }} value={bus.id || ''} onChange={(e) => updateBus(index, { id: e.target.value })} /></td>
                              <td style={{ padding: 3 }}><input style={{ ...INPUT, padding: '3px 6px' }} value={bus.label || ''} onChange={(e) => updateBus(index, { label: e.target.value })} /></td>
                              <td style={{ padding: 3 }}><input style={{ ...INPUT, padding: '3px 6px' }} value={bus.voltage ?? ''} onChange={(e) => updateBus(index, { voltage: e.target.value })} /></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                        <strong style={{ fontSize: 12 }}>支路</strong>
                        <button type="button" style={BTN(false)} onClick={addBranch}>＋ 支路</button>
                      </div>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                        <thead><tr>{['', 'id', '类型', 'from', 'to', 'R(Ω)', 'X(Ω)', '变比'].map((head) => <th key={head} style={{ textAlign: 'left', padding: 3, color: 'var(--muted)', fontWeight: 500 }}>{head}</th>)}</tr></thead>
                        <tbody>
                          {(ir.branches || []).map((branch, index) => (
                            <tr key={index}>
                              <td style={{ padding: 3 }}>
                                <button type="button" style={{ ...BTN(false), padding: '1px 6px', fontSize: 10 }}
                                  onClick={() => updateIr((prev) => ({ ...prev, branches: (prev.branches || []).filter((_, i) => i !== index) }))}>删</button>
                              </td>
                              <td style={{ padding: 3 }}><input style={{ ...INPUT, padding: '3px 6px' }} value={branch.id || ''} onChange={(e) => updateBranch(index, { id: e.target.value })} /></td>
                              <td style={{ padding: 3 }}>
                                <select style={{ ...INPUT, padding: '3px 6px' }} value={branch.type || 'line'} onChange={(e) => updateBranch(index, { type: e.target.value })}>
                                  <option value="line">线路</option>
                                  <option value="transformer">变压器</option>
                                </select>
                              </td>
                              <td style={{ padding: 3 }}><input style={{ ...INPUT, padding: '3px 6px' }} value={branch.from || ''} onChange={(e) => updateBranch(index, { from: e.target.value })} /></td>
                              <td style={{ padding: 3 }}><input style={{ ...INPUT, padding: '3px 6px' }} value={branch.to || ''} onChange={(e) => updateBranch(index, { to: e.target.value })} /></td>
                              <td style={{ padding: 3 }}><input style={{ ...INPUT, padding: '3px 6px' }} value={branch.r ?? ''} onChange={(e) => updateBranch(index, { r: e.target.value })} /></td>
                              <td style={{ padding: 3 }}><input style={{ ...INPUT, padding: '3px 6px' }} value={branch.x ?? ''} onChange={(e) => updateBranch(index, { x: e.target.value })} /></td>
                              <td style={{ padding: 3 }}><input style={{ ...INPUT, padding: '3px 6px' }} value={branch.ratio || ''} onChange={(e) => updateBranch(index, { ratio: e.target.value })} /></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                        <strong style={{ fontSize: 12 }}>负荷</strong>
                        <button type="button" style={BTN(false)} onClick={addLoad}>＋ 负荷</button>
                      </div>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                        <thead><tr>{['', 'id', '母线', 'P(kW)', '功率因数'].map((head) => <th key={head} style={{ textAlign: 'left', padding: 3, color: 'var(--muted)', fontWeight: 500 }}>{head}</th>)}</tr></thead>
                        <tbody>
                          {(ir.loads || []).map((load, index) => (
                            <tr key={index}>
                              <td style={{ padding: 3 }}>
                                <button type="button" style={{ ...BTN(false), padding: '1px 6px', fontSize: 10 }}
                                  onClick={() => updateIr((prev) => ({ ...prev, loads: (prev.loads || []).filter((_, i) => i !== index) }))}>删</button>
                              </td>
                              <td style={{ padding: 3 }}><input style={{ ...INPUT, padding: '3px 6px' }} value={load.id || ''} onChange={(e) => updateLoad(index, { id: e.target.value })} /></td>
                              <td style={{ padding: 3 }}><input style={{ ...INPUT, padding: '3px 6px' }} value={load.bus || ''} onChange={(e) => updateLoad(index, { bus: e.target.value })} /></td>
                              <td style={{ padding: 3 }}><input style={{ ...INPUT, padding: '3px 6px' }} value={load.p ?? ''} onChange={(e) => updateLoad(index, { p: e.target.value })} /></td>
                              <td style={{ padding: 3 }}><input style={{ ...INPUT, padding: '3px 6px' }} value={load.pf ?? ''} onChange={(e) => updateLoad(index, { pf: e.target.value })} /></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                        <strong style={{ fontSize: 12 }}>节点</strong>
                        <button type="button" style={BTN(false)} onClick={() => addNode('n')}>＋ 节点</button>
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {nodes.map((node, index) => (
                          <div key={index} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                            <span style={{ color: 'var(--muted)' }}>{node.id}</span>
                            <input
                              style={{ ...INPUT, width: 70, padding: '3px 6px' }}
                              value={node.label || ''}
                              placeholder="显示名"
                              onChange={(event) => updateIr((prev) => ({
                                ...prev,
                                nodes: (prev.nodes || []).map((item, i) => (i === index ? { ...item, label: event.target.value } : item)),
                              }))}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                        <strong style={{ fontSize: 12 }}>元件与连接</strong>
                        <button type="button" style={BTN(false)} onClick={addElement}>＋ 元件</button>
                      </div>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                        <thead>
                          <tr>{['', 'id', '类型', 'from', 'to', '数值', '单位', '状态'].map((head) => (
                            <th key={head} style={{ textAlign: 'left', padding: 3, color: 'var(--muted)', fontWeight: 500 }}>{head}</th>
                          ))}</tr>
                        </thead>
                        <tbody>
                          {(ir.elements || []).map((element, index) => (
                            <tr key={index}>
                              <td style={{ padding: 3 }}>
                                <button type="button" style={{ ...BTN(false), padding: '1px 6px', fontSize: 10 }} onClick={() => removeElement(index)}>删</button>
                              </td>
                              <td style={{ padding: 3 }}><input style={{ ...INPUT, padding: '3px 6px' }} value={element.id || ''} onChange={(e) => updateElement(index, { id: e.target.value })} /></td>
                              <td style={{ padding: 3 }}>
                                <select style={{ ...INPUT, padding: '3px 6px' }} value={element.type || 'resistor'} onChange={(e) => updateElement(index, { type: e.target.value })}>
                                  {ELEMENT_TYPES.map((type) => <option key={type.id} value={type.id}>{type.label}</option>)}
                                </select>
                              </td>
                              <td style={{ padding: 3 }}>
                                <select style={{ ...INPUT, padding: '3px 6px' }} value={element.from || ''} onChange={(e) => updateElement(index, { from: e.target.value })}>
                                  {nodes.map((node) => <option key={node.id} value={node.id}>{node.label || node.id}</option>)}
                                </select>
                              </td>
                              <td style={{ padding: 3 }}>
                                <select style={{ ...INPUT, padding: '3px 6px' }} value={element.to || ''} onChange={(e) => updateElement(index, { to: e.target.value })}>
                                  {nodes.map((node) => <option key={node.id} value={node.id}>{node.label || node.id}</option>)}
                                </select>
                              </td>
                              <td style={{ padding: 3 }}><input style={{ ...INPUT, padding: '3px 6px' }} value={element.value ?? ''} onChange={(e) => updateElement(index, { value: e.target.value })} /></td>
                              <td style={{ padding: 3 }}><input style={{ ...INPUT, width: 52, padding: '3px 6px' }} value={element.unit || ''} onChange={(e) => updateElement(index, { unit: e.target.value })} /></td>
                              <td style={{ padding: 3 }}>
                                {element.type === 'switch' ? (
                                  <select style={{ ...INPUT, padding: '3px 6px' }} value={element.state || 'closed'} onChange={(e) => updateElement(index, { state: e.target.value })}>
                                    <option value="closed">闭合</option>
                                    <option value="open">断开</option>
                                  </select>
                                ) : <span style={{ color: 'var(--muted)' }}>—</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5 }}>
                      <strong style={{ fontSize: 12 }}>待求端口</strong>
                      <select
                        style={{ ...INPUT, width: 120, padding: '3px 6px' }}
                        value={ir.port?.plus || ''}
                        onChange={(e) => updateIr((prev) => ({ ...prev, port: { plus: e.target.value, minus: prev.port?.minus || '' } }))}
                      >
                        <option value="">不设端口</option>
                        {nodes.map((node) => <option key={node.id} value={node.id}>{node.label || node.id}</option>)}
                      </select>
                      <span style={{ color: 'var(--muted)' }}>→</span>
                      <select
                        style={{ ...INPUT, width: 120, padding: '3px 6px' }}
                        value={ir.port?.minus || ''}
                        onChange={(e) => updateIr((prev) => ({ ...prev, port: { plus: prev.port?.plus || '', minus: e.target.value } }))}
                      >
                        <option value="">—</option>
                        {nodes.map((node) => <option key={node.id} value={node.id}>{node.label || node.id}</option>)}
                      </select>
                    </div>
                  </div>
                )}
                <details style={{ marginTop: 10 }}>
                  <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--muted)' }}>查看完整结构化 JSON</summary>
                  <pre style={{ whiteSpace: 'pre-wrap', fontSize: 10.5, maxHeight: 240, overflow: 'auto', background: 'var(--surface-soft)', padding: 8, borderRadius: 8 }}>
                    {JSON.stringify(ir, null, 2)}
                  </pre>
                </details>
              </div>

              {/* 计算结果 */}
              {result ? (
                <div style={CARD}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>计算结果</span>
                    {result.ok ? <span style={{ fontSize: 10.5, color: 'var(--ai-success, #16a34a)', fontWeight: 600 }}>已完成</span> : null}
                  </div>

                  {Array.isArray(result.errors) && result.errors.length ? (
                    <div style={{ fontSize: 11.5, color: 'var(--danger)', lineHeight: 1.7, marginBottom: 8 }}>
                      {result.errors.map((item, index) => <div key={index}>· {item}</div>)}
                    </div>
                  ) : null}

                  {result.unverified ? (
                    <div style={{ border: '1px solid var(--warning, #d97706)', background: '#fffbeb', color: '#92400e', borderRadius: 8, padding: '7px 10px', fontSize: 11.5, lineHeight: 1.7, marginBottom: 10 }}>
                      {result.notice || '交流求解尚未接入，本结果未做数值验算。'}
                    </div>
                  ) : null}

                  {result.port ? (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                      {[
                        ['开路电压 U_oc', `${result.port.uoc} V`],
                        ['短路电流 I_sc', result.port.isc === null ? '—' : `${result.port.isc} A`],
                        ['等效电阻 R_eq', result.port.req === null ? '—' : `${result.port.req} Ω`],
                      ].map(([label, value]) => (
                        <div key={label} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '6px 10px', background: 'var(--surface-soft)' }}>
                          <div style={{ fontSize: 10, color: 'var(--muted)' }}>{label}</div>
                          <div style={{ fontSize: 13, fontWeight: 700 }}>{value}</div>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {Array.isArray(result.summary) && result.summary.length ? (
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.7, marginBottom: 8 }}>
                      {result.summary.map((item, index) => <div key={index}>· {item}</div>)}
                    </div>
                  ) : null}

                  {Array.isArray(result.steps) && result.steps.length ? (
                    <div style={{ marginBottom: 10 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 5 }}>化简与计算过程</div>
                      <ol style={{ margin: 0, paddingLeft: 18, fontSize: 11.5, lineHeight: 1.75 }}>
                        {result.steps.map((step, index) => (
                          <li key={index} style={{ marginBottom: 5 }}>
                            <strong>{step.title}</strong>
                            {step.detail ? <span style={{ color: 'var(--muted)' }}>：{step.detail}</span> : null}
                            {step.value ? <div style={{ fontSize: 11, color: 'var(--text)' }}>{step.value}</div> : null}
                            {step.formula ? <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{step.formula}</div> : null}
                          </li>
                        ))}
                      </ol>
                    </div>
                  ) : null}

                  {isPhasor && Array.isArray(result.phasors) && result.phasors.length ? (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                      <thead>
                        <tr>{['相量', '类型', '幅值', '相位', '直角坐标', '来源'].map((head) => (
                          <th key={head} style={{ textAlign: 'left', padding: 3, color: 'var(--muted)', fontWeight: 500 }}>{head}</th>
                        ))}</tr>
                      </thead>
                      <tbody>
                        {result.phasors.map((item) => (
                          <tr key={item.id}>
                            <td style={{ padding: 3 }}>{item.label}</td>
                            <td style={{ padding: 3 }}>{item.quantity === 'current' ? '电流' : '电压'}</td>
                            <td style={{ padding: 3 }}>{item.magnitude} {item.unit}</td>
                            <td style={{ padding: 3 }}>{item.angle}°</td>
                            <td style={{ padding: 3 }}>{item.real} {item.imag >= 0 ? '+' : '−'} j{Math.abs(item.imag)}</td>
                            <td style={{ padding: 3, color: 'var(--muted)' }}>{item.source === 'computed' ? '计算值（未验算）' : '题目给定'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : null}

                  {!isOneLine && Array.isArray(result.nodeVoltages) && result.nodeVoltages.length ? (
                    <div style={{ marginBottom: 10 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>节点电压</div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {result.nodeVoltages.map((node) => (
                          <span key={node.node} style={{ fontSize: 11, border: '1px solid var(--line)', borderRadius: 6, padding: '2px 7px' }}>
                            {node.label}: {node.voltage} V
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {!isOneLine && Array.isArray(result.elements) && result.elements.length ? (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                      <thead>
                        <tr>{['元件', '电压', '电流', '功率'].map((head) => (
                          <th key={head} style={{ textAlign: 'left', padding: 3, color: 'var(--muted)', fontWeight: 500 }}>{head}</th>
                        ))}</tr>
                      </thead>
                      <tbody>
                        {result.elements.map((element) => (
                          <tr key={element.id}>
                            <td style={{ padding: 3 }}>{element.label}</td>
                            <td style={{ padding: 3 }}>{element.voltage} V</td>
                            <td style={{ padding: 3 }}>{element.current} A</td>
                            <td style={{ padding: 3 }}>{element.power} W</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : null}

                  {isOneLine && Array.isArray(result.buses) && result.buses.length ? (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, marginBottom: 8 }}>
                      <thead>
                        <tr>{['母线', '计算电压(kV)', '标称(kV)'].map((head) => (
                          <th key={head} style={{ textAlign: 'left', padding: 3, color: 'var(--muted)', fontWeight: 500 }}>{head}</th>
                        ))}</tr>
                      </thead>
                      <tbody>
                        {result.buses.map((bus) => (
                          <tr key={bus.id}>
                            <td style={{ padding: 3 }}>{bus.label}</td>
                            <td style={{ padding: 3 }}>{bus.voltage}</td>
                            <td style={{ padding: 3 }}>{bus.nominal}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : null}

                  {Array.isArray(result.assumptions) && result.assumptions.length ? (
                    <div style={{ fontSize: 10.5, color: 'var(--muted)', lineHeight: 1.7 }}>
                      <div style={{ fontWeight: 600, marginBottom: 2 }}>计算假设</div>
                      {result.assumptions.map((item, index) => <div key={index}>· {item}</div>)}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {/* 讲解 */}
              {result?.ok ? (
                <div style={CARD}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>讲解</span>
                    <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>数值以上面的计算结果为准</span>
                    <button
                      type="button"
                      style={{ ...BTN(true), marginLeft: 'auto', opacity: busy === 'explain' ? 0.6 : 1 }}
                      disabled={busy === 'explain'}
                      onClick={explain}
                    >
                      {busy === 'explain' ? '生成中…' : explanation ? '重新生成讲解' : '生成讲解'}
                    </button>
                  </div>
                  {explainError ? <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>{explainError}</div> : null}
                  {explanation ? (
                    <div style={{ fontSize: 12.5, lineHeight: 1.8 }}>
                      <AIMessageContent content={explanation} />
                    </div>
                  ) : (
                    <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>还没有讲解。计算结果不依赖讲解，可以先核对上面的数值。</div>
                  )}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
