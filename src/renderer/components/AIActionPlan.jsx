import React from 'react';

function PlanList({ title, items }) {
  if (!items?.length) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>{title}</div>
      <ul style={{ margin: '4px 0 0', paddingLeft: 16, fontSize: 11.5, lineHeight: 1.7, color: 'var(--text)' }}>
        {items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}
      </ul>
    </div>
  );
}

const planTime = (value) => {
  const text = String(value || '').replace('T', ' ');
  return text.slice(0, 16) || '未知时间';
};

export function ActionPlanView({ plan, choice, onChoose }) {
  if (!plan) {
    return <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)' }}>正在生成执行计划…</div>;
  }
  const choiceValue = choice?.field === plan.choiceField ? choice.value : '';
  return (
    <div style={{ marginTop: 10, borderTop: '1px dashed var(--line)', paddingTop: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, color: 'var(--muted)' }}>执行计划（确认后才会写入）</div>
      {plan.target ? (
        <div style={{ marginTop: 6, fontSize: 11.5, lineHeight: 1.7 }}><strong>目标：</strong>{plan.target}</div>
      ) : null}
      <PlanList title="作用范围" items={plan.scope} />
      <PlanList title="写入与快照" items={plan.write} />
      <PlanList title="预计消耗" items={plan.cost} />
      {plan.needsChoice ? (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#b7791f' }}>
            {plan.choiceField === 'section' ? '请选择要修改的小节' : '请选择要修改的笔记'}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
            {(plan.candidates || []).map((item) => {
              const value = plan.choiceField === 'section' ? item.title : item.id;
              const checked = choiceValue === value;
              return (
                <label
                  key={value}
                  style={{
                    display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 8px',
                    border: `1px solid ${checked ? 'var(--accent)' : 'var(--line)'}`,
                    borderRadius: 8, background: checked ? 'var(--surface-soft)' : 'transparent',
                    fontSize: 11.5, lineHeight: 1.6, cursor: 'pointer',
                  }}
                >
                  <input type="radio" checked={checked} onChange={() => onChoose?.(value)} style={{ marginTop: 2 }} />
                  <span>
                    {plan.choiceField === 'section'
                      ? `${item.title}（第 ${item.startLine}–${item.endLine} 行）`
                      : `《${item.title}》｜${item.subjectName || '未绑定科目'}｜${planTime(item.updatedAt)}｜${item.chars || 0} 字`}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ) : null}
      {plan.availableSections?.length && !plan.needsChoice ? (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)' }}>
          可用小节：{plan.availableSections.slice(0, 10).map((section) => section.title).join('、')}
        </div>
      ) : null}
      {plan.warnings?.length ? (
        <ul style={{ margin: '8px 0 0', paddingLeft: 16, fontSize: 11, lineHeight: 1.6, color: '#b7791f' }}>
          {plan.warnings.map((item, index) => <li key={`warn-${index}`}>{item}</li>)}
        </ul>
      ) : null}
      {plan.error ? (
        <div style={{ marginTop: 8, fontSize: 11.5, lineHeight: 1.7, color: plan.needsChoice ? '#b7791f' : 'var(--danger)', whiteSpace: 'pre-wrap' }}>
          {plan.error}
        </div>
      ) : null}
    </div>
  );
}

function DiffBlock({ label, tone, lines }) {
  if (!lines?.length) return null;
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: tone }}>{label}</div>
      <pre style={{
        margin: '3px 0 0', padding: '6px 8px', borderRadius: 6, background: 'var(--surface-soft)',
        fontSize: 10.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 180, overflow: 'auto',
      }}>{lines.join('\n')}</pre>
    </div>
  );
}

export function ActionDiffView({ diff }) {
  if (!diff) return null;
  if (diff.type === 'inventory') {
    const differences = diff.differences || [];
    return (
      <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px dashed var(--line)' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>实际执行范围</div>
        {differences.length ? (
          <ul style={{ margin: '5px 0 0', paddingLeft: 16, fontSize: 11, lineHeight: 1.7, color: '#b7791f' }}>
            {differences.map((item, index) => <li key={`diff-${index}`}>{item}</li>)}
          </ul>
        ) : (
          <div style={{ marginTop: 5, fontSize: 11, color: 'var(--ai-success)' }}>实际范围与计划一致。</div>
        )}
      </div>
    );
  }
  if (diff.type !== 'note') return null;
  const hunk = diff.diff?.hunks?.[0];
  return (
    <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px dashed var(--line)' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>实际改动</div>
      <div style={{ marginTop: 5, fontSize: 11.5, lineHeight: 1.7 }}>
        {diff.operationLabel || diff.operation}
        {diff.section ? ` · 「${diff.section.title}」（第 ${diff.section.startLine}–${diff.section.endLine} 行）` : ''}
        {diff.wholeNote ? ' · 整篇重写' : ''}
        {hunk ? ` · 第 ${hunk.beforeStart}–${hunk.beforeEnd} 行 → 第 ${hunk.afterStart}–${hunk.afterEnd} 行` : ''}
      </div>
      {diff.diff?.changedSections?.length ? (
        <div style={{ marginTop: 4, fontSize: 11, color: 'var(--muted)' }}>涉及小节：{diff.diff.changedSections.join('、')}</div>
      ) : null}
      <DiffBlock label="修改前" tone="var(--danger)" lines={hunk?.removedPreview} />
      <DiffBlock label="修改后" tone="var(--ai-success)" lines={hunk?.addedPreview} />
      {diff.snapshotPath ? (
        <div style={{ marginTop: 6, fontSize: 10.5, color: 'var(--muted)', wordBreak: 'break-all' }}>旧版快照：{diff.snapshotPath}</div>
      ) : null}
    </div>
  );
}
