import React, { useState } from 'react';
import {
  AI_PROVIDERS,
  AI_ROLES,
  AI_ROLE_IDS,
  getAIProvider,
  normalizeAISettings,
  isVisionCapable,
  getRoleSettings,
} from '../store/aiSettings.js';
import CustomSelect from './CustomSelect.jsx';
import ProviderLogo from './ProviderLogo.jsx';
import { useDialog } from './DialogProvider.jsx';

// 自定义网关常把管理后台域名当成 API 地址填进来，此时 /chat/completions 会返回 HTML 网页
const isBareHostBaseUrl = (value) => {
  const text = String(value || '').trim();
  if (!text) return false;
  try {
    const url = new URL(text);
    return !url.pathname || url.pathname === '/';
  } catch (error) {
    return false;
  }
};

const inputStyle = {
  padding: '8px 12px',
  borderRadius: 6,
  border: '1px solid var(--line)',
  background: 'var(--surface)',
  fontSize: 13,
  outline: 'none',
  color: 'var(--text)',
};

const labelStyle = { fontSize: 11, fontWeight: 600, color: 'var(--text)' };
const hintStyle = { fontSize: 11, lineHeight: 1.7, color: 'var(--muted)' };
const warnStyle = {
  fontSize: 11,
  lineHeight: 1.7,
  color: 'var(--warning, #b45309)',
  background: 'var(--surface)',
  border: '1px solid var(--line)',
  borderRadius: 6,
  padding: '6px 8px',
};
const dangerStyle = {
  ...warnStyle,
  color: 'var(--danger, #dc2626)',
  background: 'var(--surface-soft)',
};

const Field = ({ label, children, hint }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <label style={labelStyle}>{label}</label>
    {children}
    {hint ? <div style={hintStyle}>{hint}</div> : null}
  </div>
);

function ProviderGrid({ activeId, onSelect }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 12 }}>
      {AI_PROVIDERS.map((provider) => {
        const active = activeId === provider.id;
        return (
          <button
            key={provider.id}
            type="button"
            onClick={() => onSelect(provider.id)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 10,
              padding: '16px 10px',
              borderRadius: 10,
              border: '1px solid',
              cursor: 'pointer',
              transition: 'all 0.2s',
              ...(active
                ? { background: 'var(--accent-soft-bg)', borderColor: 'var(--accent)', color: 'var(--text)', boxShadow: '0 10px 22px rgba(15,23,42,0.06)' }
                : { background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--muted)' }),
            }}
          >
            <div className="provider-logo-wrap" style={{ color: active ? 'var(--accent)' : 'inherit' }}>
              <ProviderLogo type={provider.icon} size={20} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: active ? 600 : 500 }}>
              {provider.name}
              {provider.supportsVision && (
                <span style={{ fontSize: 9, padding: '2px 4px', borderRadius: 4, background: 'var(--accent-soft-bg)', color: 'var(--accent)' }}>视觉</span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function ModelForm({ value, onPatch, showKey, setShowKey, apiKeyPlaceholder }) {
  const provider = getAIProvider(value.aiProvider);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '16px 0', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }}>
      <Field
        label="API Key"
        hint={apiKeyPlaceholder ? '留空表示沿用「通用配置」里的 Key，只改模型时不必重复填写。' : ''}
      >
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type={showKey ? 'text' : 'password'}
            value={value.apiKey}
            onChange={(e) => onPatch({ apiKey: e.target.value })}
            placeholder={apiKeyPlaceholder || 'sk-...'}
            style={{ ...inputStyle, flex: 1 }}
          />
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            style={{ width: 36, height: 36, borderRadius: 6, border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--muted)', display: 'grid', placeItems: 'center', cursor: 'pointer' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {showKey ? <><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /><line x1="1" y1="1" x2="23" y2="23" /></> : <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></>}
            </svg>
          </button>
        </div>
      </Field>

      <Field label="Base URL">
        <input
          type="text"
          value={value.apiBase}
          onChange={(e) => onPatch({ apiBase: e.target.value })}
          placeholder={provider?.baseUrl || '输入 API 地址'}
          style={inputStyle}
        />
        {provider?.sdkType !== 'anthropic' && isBareHostBaseUrl(value.apiBase) && (
          <div style={warnStyle}>
            当前地址只有域名。多数 OpenAI 兼容网关需要补齐 API 路径（常见为 <code>/v1</code>），否则接口会返回后台网页而不是模型结果，导入时会报「JSON 解析失败」。
          </div>
        )}
      </Field>

      {provider?.sdkType !== 'anthropic' && (
        <Field label="接口格式">
          <CustomSelect
            value={value.apiFormat}
            onChange={(nextValue) => onPatch({ apiFormat: nextValue })}
            options={(provider?.supportedFormats || []).map((format) => ({
              value: format,
              label: format === 'responses'
                ? 'Responses API'
                : format === 'chat_completions'
                  ? 'Chat Completions API'
                  : format,
            }))}
          />
        </Field>
      )}

      <Field label="模型">
        {value.aiProvider === 'custom' ? (
          <input
            type="text"
            value={value.customModel || ''}
            onChange={(e) => onPatch({ customModel: e.target.value })}
            placeholder="输入模型名称"
            style={inputStyle}
          />
        ) : (
          <CustomSelect
            value={value.model}
            onChange={(nextValue) => onPatch({ model: nextValue })}
            options={(provider?.models || []).map((model) => ({ value: model, label: model }))}
          />
        )}
      </Field>
    </div>
  );
}

function RecognitionEngineBlock({ settings, onChange }) {
  return (
    <div style={{ marginTop: 4, paddingTop: 18, borderTop: '1px dashed var(--line)', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>文档识别引擎</div>
        <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.7 }}>
          引擎 A 复用「识图」角色的模型；引擎 B 用独立 OCR 服务，适合扫描 PDF 或复杂版式。
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
        {[['auto', '自动选择'], ['ai', '仅 AI 引擎'], ['ocr', '仅 OCR 引擎']].map(([key, label]) => {
          const active = settings.recognizeEngine === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onChange({ recognizeEngine: key })}
              style={{
                padding: '10px 12px',
                borderRadius: 8,
                border: active ? '1px solid var(--accent)' : '1px solid var(--line)',
                background: active ? 'var(--accent-soft-bg)' : 'var(--surface)',
                color: active ? 'var(--accent)' : 'var(--text)',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      <Field label="PDF 最大识别页数">
        <input
          type="number"
          min="1"
          max="20"
          value={settings.pdfMaxPages}
          onChange={(e) => onChange({ pdfMaxPages: e.target.value })}
          style={inputStyle}
        />
      </Field>

      <div style={{ padding: 14, borderRadius: 10, background: 'var(--surface-soft)', border: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>OCR 引擎 B</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.7 }}>
              可接第三方 OCR URL。建议你的 OCR 服务返回 <code>{'{ questions: [...] }'}</code>，或返回纯文本再交给系统解析。
            </div>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={Boolean(settings.ocrEnabled)} onChange={(e) => onChange({ ocrEnabled: e.target.checked })} />
            启用 OCR
          </label>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="OCR URL">
            <input
              type="text"
              value={settings.ocrApiUrl}
              onChange={(e) => onChange({ ocrApiUrl: e.target.value })}
              placeholder="https://your-ocr.example.com/recognize"
              style={inputStyle}
            />
          </Field>
          <Field label="OCR Key">
            <input
              type="text"
              value={settings.ocrApiKey}
              onChange={(e) => onChange({ ocrApiKey: e.target.value })}
              placeholder="可选"
              style={inputStyle}
            />
          </Field>
        </div>

        <Field label="OCR 返回格式">
          <CustomSelect
            value={settings.ocrResponseMode}
            onChange={(nextValue) => onChange({ ocrResponseMode: nextValue })}
            options={[
              { value: 'json_questions', label: '返回结构化题目 JSON' },
              { value: 'text', label: '返回纯文本，再交给 AI 结构化' },
            ]}
          />
        </Field>
      </div>
    </div>
  );
}

export default function AIConfigPanel({
  settings,
  onChange,
  onSave,
  onTestBase,
  baseTestStatus,
  persistStatus,
  connectionState,
  lastSavedAt,
  showKey,
  setShowKey,
  initialTab = 'base',
}) {
  const [tab, setTab] = useState(
    initialTab === 'base' || AI_ROLE_IDS.includes(initialTab) ? initialTab : 'base'
  );
  const [roleTest, setRoleTest] = useState({});
  const { toast: showToast, alert: showAlert } = useDialog();

  const patchBase = (patch) => {
    onChange((prev) => normalizeAISettings({ ...prev, ...patch }));
  };

  const patchRole = (roleId, patch) => {
    onChange((prev) => normalizeAISettings({
      ...prev,
      aiRoles: {
        ...(prev.aiRoles || {}),
        [roleId]: { ...(prev.aiRoles?.[roleId] || {}), ...patch },
      },
    }));
  };

  const changeProvider = (current, applyPatch, providerId) => {
    const provider = getAIProvider(providerId);
    const sameProvider = current.aiProvider === providerId;
    applyPatch({
      aiProvider: providerId,
      apiBase: sameProvider ? current.apiBase : (provider?.baseUrl || ''),
      model: sameProvider ? current.model : (provider?.models?.[0] || ''),
      customModel: providerId === 'custom' ? (current.customModel || '') : '',
      apiFormat: provider?.defaultFormat || current.apiFormat,
    });
  };

  const activeRole = AI_ROLES.find((role) => role.id === tab) || null;
  const baseProvider = getAIProvider(settings.aiProvider);
  const baseVisionOk = isVisionCapable(settings);

  const formatTime = (value) => {
    if (!value) return '-';
    try {
      return new Date(value).toLocaleString();
    } catch (error) {
      return value;
    }
  };

  const testRole = async (roleId) => {
    const target = getRoleSettings(roleId, settings);
    if (!target?.apiKey || !target?.aiProvider) {
      await showAlert({ title: '缺少配置', message: '请先填写 API Key 并选择服务商，或改成「跟随通用配置」。', tone: 'warning' });
      return;
    }
    setRoleTest((prev) => ({ ...prev, [roleId]: 'testing' }));
    try {
      const result = await window.openexam.ai.testConnection(target);
      const status = result?.success ? 'success' : 'error';
      setRoleTest((prev) => ({ ...prev, [roleId]: status }));
      if (result?.success) {
        showToast({ title: '连接成功', message: `${getRoleLabel(roleId)}角色可用。`, tone: 'success' });
      } else {
        showToast({ title: '连接失败', message: result?.error || '未知错误', tone: 'danger' });
      }
    } catch (error) {
      setRoleTest((prev) => ({ ...prev, [roleId]: 'error' }));
      showToast({ title: '测试失败', message: error?.message || '未知错误', tone: 'danger' });
    }
  };

  const tabs = [{ id: 'base', name: '通用', desc: '默认配置' }, ...AI_ROLES.map((role) => ({ id: role.id, name: role.name, desc: role.tagline }))];

  const actionRow = (onTest, testStatus) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
      <button
        type="button"
        onClick={onTest}
        disabled={testStatus === 'testing'}
        style={{ flex: 1, padding: '10px 0', borderRadius: 6, border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', fontSize: 13, fontWeight: 600, cursor: testStatus === 'testing' ? 'wait' : 'pointer' }}
      >
        {testStatus === 'testing' ? '测试中...' : testStatus === 'success' ? '✓ 连接成功' : testStatus === 'error' ? '× 连接失败' : '测试连接'}
      </button>
      <button
        type="button"
        onClick={onSave}
        style={{ flex: 1, padding: '10px 0', borderRadius: 6, border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', boxShadow: '0 8px 18px rgba(15,23,42,0.08)' }}
      >
        保存配置
      </button>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>AI 模型配置</h3>
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0, lineHeight: 1.7 }}>
          按用途分成三类角色：<strong>识图</strong> 负责把图片变成题目，<strong>助教</strong> 负责分类、笔记和任务安排，<strong>老师</strong> 负责讲题和批改。
          每个角色都可以单独指定模型，不单独设置就跟随「通用」配置。
        </p>
      </div>

      <div style={{
        padding: '12px 14px', borderRadius: 12, border: '1px solid var(--accent-border, var(--line))',
        background: 'var(--accent-soft-bg)', fontSize: 12, lineHeight: 1.75, color: 'var(--text)',
        display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        <div>
          <strong>第一次配置？</strong>
          推荐先用 <strong>DeepSeek</strong>（文本讲题、出卷便宜）配「通用 / 老师」；识图角色再单独选 <strong>通义千问 qwen-vl</strong> 这类能读图的模型。
          去对应开放平台注册并创建 API Key，粘贴到下面的「API Key」即可；Base URL 和模型名保持默认，不需要改。
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => window.openexam?.app?.openExternal?.('https://platform.deepseek.com/api_keys')}
            style={{ padding: '5px 10px', borderRadius: 7, border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--text)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
          >
            去 DeepSeek 申请 Key
          </button>
          <button
            type="button"
            onClick={() => window.openexam?.app?.openExternal?.('https://bailian.console.aliyun.com/?tab=model#/api-key')}
            style={{ padding: '5px 10px', borderRadius: 7, border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--text)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
          >
            去通义千问申请 Key
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {tabs.map((item) => {
          const active = tab === item.id;
          const effective = item.id === 'base' ? settings : getRoleSettings(item.id, settings);
          const configured = Boolean(effective?.apiKey && effective?.model);
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '9px 14px',
                borderRadius: 9,
                border: '1px solid',
                fontSize: 12.5,
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.2s',
                ...(active
                  ? { background: 'var(--accent-soft-bg)', borderColor: 'var(--accent)', color: 'var(--accent)' }
                  : { background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--muted)' }),
              }}
            >
              {item.name}
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: configured ? 'var(--success, #16a34a)' : 'var(--line)',
                }}
              />
            </button>
          );
        })}
      </div>

      {tab === 'base' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ ...hintStyle, fontSize: 11.5 }}>
            通用配置是所有角色的默认值。识图 / 助教 / 老师没有单独设置时，都使用这里的服务商与模型。
          </div>

          <ProviderGrid
            activeId={settings.aiProvider}
            onSelect={(providerId) => changeProvider(settings, patchBase, providerId)}
          />

          {settings.aiProvider && (
            <ModelForm
              value={settings}
              onPatch={patchBase}
              showKey={showKey}
              setShowKey={setShowKey}
            />
          )}

          {baseProvider && !baseVisionOk && (
            <div style={warnStyle}>
              通用配置当前模型不能读图片。识图角色如果单独配置了能读图的模型，识图导入不受影响；否则请换用支持视觉的模型
              {settings.aiProvider === 'deepseek' ? '（DeepSeek 用 deepseek-flash，deepseek-v4-pro 不支持图片）' : '。'}
            </div>
          )}

          {actionRow(onTestBase, baseTestStatus)}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
            <div style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--surface)' }}>
              <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 4 }}>配置存储</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: persistStatus === 'sqlite' ? 'var(--success)' : 'var(--text)' }}>
                {persistStatus === 'loading' ? '读取中...' : persistStatus === 'sqlite' ? 'SQLite 持久化' : '仅本地缓存'}
              </div>
              <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>最近保存: {formatTime(lastSavedAt)}</div>
            </div>
            <div style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--surface)' }}>
              <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 4 }}>连接状态</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: connectionState?.status === 'success' ? 'var(--success)' : connectionState?.status === 'error' ? 'var(--danger)' : 'var(--text)' }}>
                {connectionState?.status === 'success' ? '已验证可用' : connectionState?.status === 'error' ? '验证失败' : '未验证'}
              </div>
              <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>最近验证: {formatTime(connectionState?.checkedAt)}</div>
            </div>
          </div>
        </div>
      )}

      {activeRole && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ padding: '14px 16px', borderRadius: 12, border: '1px solid var(--line)', background: 'var(--surface-soft)', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{activeRole.name}</span>
              <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{activeRole.tagline}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.75 }}>{activeRole.description}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {activeRole.features.map((feature) => (
                <span key={feature} style={{ fontSize: 10.5, padding: '3px 8px', borderRadius: 999, background: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--muted)' }}>{feature}</span>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            {[
              { value: 'shared', label: '跟随通用配置' },
              { value: 'custom', label: '单独配置' },
            ].map((option) => {
              const active = settings.aiRoles?.[activeRole.id]?.mode === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    if (option.value === 'custom') {
                      const current = settings.aiRoles?.[activeRole.id] || {};
                      patchRole(activeRole.id, {
                        mode: 'custom',
                        aiProvider: current.aiProvider || settings.aiProvider,
                        apiBase: current.aiBase || settings.apiBase,
                        model: current.model || settings.model,
                        customModel: current.customModel || settings.customModel,
                        apiFormat: current.apiFormat || settings.apiFormat,
                      });
                    } else {
                      patchRole(activeRole.id, { mode: 'shared' });
                    }
                  }}
                  style={{
                    padding: '8px 14px',
                    borderRadius: 8,
                    border: active ? '1px solid var(--accent)' : '1px solid var(--line)',
                    background: active ? 'var(--accent-soft-bg)' : 'var(--surface)',
                    color: active ? 'var(--accent)' : 'var(--muted)',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  {option.label}
                </button>
              );
            })}
          </div>

          {settings.aiRoles?.[activeRole.id]?.mode === 'custom' ? (
            <>
              <ProviderGrid
                activeId={settings.aiRoles?.[activeRole.id]?.aiProvider || settings.aiProvider}
                onSelect={(providerId) => changeProvider(
                  settings.aiRoles?.[activeRole.id] || settings,
                  (patch) => patchRole(activeRole.id, patch),
                  providerId
                )}
              />
              <ModelForm
                value={settings.aiRoles?.[activeRole.id] || {}}
                onPatch={(patch) => patchRole(activeRole.id, patch)}
                showKey={showKey}
                setShowKey={setShowKey}
                apiKeyPlaceholder="留空沿用通用 Key"
              />
            </>
          ) : (
            <div style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--surface)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 12, color: 'var(--muted)', flex: 1, minWidth: 200 }}>
                当前生效：
                <strong style={{ color: 'var(--text)', marginLeft: 6 }}>
                  {baseProvider?.name || settings.aiProvider || '未配置'} / {settings.model || settings.customModel || '未选模型'}
                </strong>
              </div>
              <button
                type="button"
                onClick={() => setTab('base')}
                style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--text)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
              >
                去修改通用配置
              </button>
            </div>
          )}

          {(() => {
            const effective = getRoleSettings(activeRole.id, settings);
            const visionOk = isVisionCapable(effective);
            if (activeRole.id === 'vision' && !visionOk) {
              return (
                <div style={dangerStyle}>
                  识图角色必须使用能读图的模型，当前「{getAIProvider(effective.aiProvider)?.name || effective.aiProvider} / {effective.model || '未选模型'}」不支持图片输入。
                  请换成 deepseek-flash、qwen-vl、glm-4v、豆包 vision 或 Claude 等视觉模型。
                </div>
              );
            }
            if (activeRole.id === 'teacher' && !visionOk) {
              return (
                <div style={hintStyle}>
                  老师模型不支持读图时，主观题手写批改会自动改用「识图」角色的模型；讲题、答疑不受影响。
                </div>
              );
            }
            if (activeRole.id === 'vision' && visionOk) {
              return <div style={hintStyle}>当前模型支持图片输入，可用于识图导入与手写答案批改。</div>;
            }
            return null;
          })()}

          {activeRole.id === 'vision' && (
            <RecognitionEngineBlock settings={settings} onChange={patchBase} />
          )}

          {actionRow(
            () => testRole(activeRole.id),
            roleTest[activeRole.id] || null
          )}
        </div>
      )}
    </div>
  );
}

function getRoleLabel(roleId) {
  const role = AI_ROLES.find((item) => item.id === roleId);
  return role ? `「${role.name}」` : '';
}
