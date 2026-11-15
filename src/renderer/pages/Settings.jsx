import React, { useState, useEffect, useRef } from 'react';
import { DEFAULT_AI_SETTINGS, normalizeAISettings } from '../store/aiSettings.js';
import AIConfigPanel from '../components/AIConfigPanel.jsx';
import RuntimeEnvPanel from '../components/RuntimeEnvPanel.jsx';
import appLogo from '../assets/openexam-app-icon.png';
import { useDialog } from '../components/DialogProvider.jsx';
import {
  getFontScale,
  setFontScale,
  resetFontScale,
  DEFAULT_FONT_SCALE,
  FONT_SCALE_MIN,
  FONT_SCALE_MAX,
  FONT_SCALE_STEP,
  FONT_SCALE_PRESETS,
  QUESTION_FONT_SCALE_KEY,
} from '../../shared/displaySettings.js';

const RESETTABLE_LOCAL_KEYS = ['openexam_settings', 'openexam_onboarding_done_v1', 'openexam_ai_active_session', 'openexam_question_context', QUESTION_FONT_SCALE_KEY];

const AVATAR_PREVIEW = 168;
const AVATAR_OUTPUT = 256;

const formatBytes = (bytes) => {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const formatBackupTime = (iso) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const loadImage = (src) => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error('图片解析失败'));
  image.src = src;
});

const NavIcon = ({ type }) => {
  const common = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' };
  if (type === 'ai') {
    return (
      <svg {...common}>
        <rect x="4" y="8" width="16" height="10" rx="2" />
        <path d="M9 8V6a3 3 0 016 0v2" />
        <circle cx="9" cy="13" r="1" fill="currentColor" stroke="none" />
        <circle cx="15" cy="13" r="1" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (type === 'runtime') {
    return (
      <svg {...common}>
        <rect x="3" y="4" width="18" height="7" rx="2" />
        <rect x="3" y="13" width="18" height="7" rx="2" />
        <path d="M7 7.5h.01M7 16.5h.01" />
      </svg>
    );
  }
  if (type === 'import') {
    return (
      <svg {...common}>
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
        <path d="M14 2v6h6" />
        <path d="M12 18v-6" />
        <path d="M9 15l3 3 3-3" />
      </svg>
    );
  }
  if (type === 'user') {
    return (
      <svg {...common}>
        <circle cx="12" cy="8.5" r="3.6" />
        <path d="M5 20c0-3.4 3.1-5.6 7-5.6s7 2.2 7 5.6" />
      </svg>
    );
  }
  if (type === 'display') {
    return (
      <svg {...common}>
        <path d="M4 7V5h16v2" />
        <path d="M9 19h6" />
        <path d="M12 5v14" />
        <path d="M7 19v-3M17 19v-3" />
        <path d="M7 9v6M17 9v6" />
      </svg>
    );
  }
  if (type === 'data') {
    return (
      <svg {...common}>
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
        <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  );
};

export default function Settings({ onBack, profile, initialSection = 'ai', onProfileSaved }) {
  const [settings, setSettings] = useState(DEFAULT_AI_SETTINGS);
  const [showKey, setShowKey] = useState(false);
  const [testStatus, setTestStatus] = useState(null);
  const [activeSection, setActiveSection] = useState('ai');
  const [persistStatus, setPersistStatus] = useState('loading');
  const [lastSavedAt, setLastSavedAt] = useState('');
  const [connectionState, setConnectionState] = useState(null);
  const [appInfo, setAppInfo] = useState(null);
  const [updateState, setUpdateState] = useState(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [backupBusy, setBackupBusy] = useState('');
  const [localBackups, setLocalBackups] = useState(null);
  const [fontScale, setFontScaleState] = useState(() => getFontScale());
  const [nameValue, setNameValue] = useState(String(profile?.name || '考生用户'));
  const [avatarPreview, setAvatarPreview] = useState(String(profile?.avatar || ''));
  const [avatarSrc, setAvatarSrc] = useState('');
  const [avatarNat, setAvatarNat] = useState({ w: 0, h: 0 });
  const [avatarZoom, setAvatarZoom] = useState(1);
  const [avatarOffset, setAvatarOffset] = useState({ x: 0, y: 0 });
  const [avatarBusy, setAvatarBusy] = useState(false);
  const avatarDragRef = useRef(null);
  const avatarFileRef = useRef(null);
  const { alert: showAlert, confirm: showConfirm, toast: showToast } = useDialog();

  useEffect(() => {
    setNameValue(String(profile?.name || '考生用户'));
    setAvatarPreview(String(profile?.avatar || ''));
    setAvatarSrc('');
    setAvatarNat({ w: 0, h: 0 });
    setAvatarZoom(1);
    setAvatarOffset({ x: 0, y: 0 });
  }, [profile?.name, profile?.avatar]);

  useEffect(() => {
    if (initialSection) setActiveSection(initialSection);
  }, [initialSection]);

  // 进入「数据管理」时读取本地备份列表；备份/恢复后会主动刷新
  useEffect(() => {
    if (activeSection !== 'data') return undefined;
    let mounted = true;
    const loadLocalBackups = async () => {
      try {
        const result = await window.openexam?.db?.listLocalBackups?.();
        if (mounted && result?.success) setLocalBackups(result);
      } catch (error) {
        console.error('读取本地备份列表失败:', error);
      }
    };
    loadLocalBackups();
    return () => { mounted = false; };
  }, [activeSection]);

  const avatarBaseScale = avatarNat.w && avatarNat.h ? AVATAR_PREVIEW / Math.min(avatarNat.w, avatarNat.h) : 1;
  const avatarDrawW = avatarNat.w * avatarBaseScale * avatarZoom;
  const avatarDrawH = avatarNat.h * avatarBaseScale * avatarZoom;

  const clampAvatarOffset = (offset, zoomValue = avatarZoom) => {
    if (!avatarNat.w || !avatarNat.h) return { x: 0, y: 0 };
    const width = avatarNat.w * avatarBaseScale * zoomValue;
    const height = avatarNat.h * avatarBaseScale * zoomValue;
    const maxX = Math.max(0, (width - AVATAR_PREVIEW) / 2);
    const maxY = Math.max(0, (height - AVATAR_PREVIEW) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, offset.x)),
      y: Math.min(maxY, Math.max(-maxY, offset.y)),
    };
  };

  const handleAvatarFile = async (file) => {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      await showAlert({ title: '无法使用该文件', message: '请选择 PNG、JPG 或 WebP 图片。', tone: 'warning' });
      return;
    }
    setAvatarBusy(true);
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('读取图片失败'));
        reader.readAsDataURL(file);
      });
      const image = await loadImage(dataUrl);
      setAvatarSrc(dataUrl);
      setAvatarNat({ w: image.naturalWidth, h: image.naturalHeight });
      setAvatarZoom(1);
      setAvatarOffset({ x: 0, y: 0 });
    } catch (error) {
      await showAlert({ title: '读取图片失败', message: error.message || '请换一张图片重试。', tone: 'danger' });
    } finally {
      setAvatarBusy(false);
    }
  };

  const buildAvatarDataUrl = async () => {
    if (!avatarSrc) return avatarPreview;
    const image = await loadImage(avatarSrc);
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_OUTPUT;
    canvas.height = AVATAR_OUTPUT;
    const ctx = canvas.getContext('2d');
    const ratio = AVATAR_OUTPUT / AVATAR_PREVIEW;
    ctx.fillStyle = '#e8f3ed';
    ctx.fillRect(0, 0, AVATAR_OUTPUT, AVATAR_OUTPUT);
    ctx.drawImage(
      image,
      ((AVATAR_PREVIEW - avatarDrawW) / 2 + avatarOffset.x) * ratio,
      ((AVATAR_PREVIEW - avatarDrawH) / 2 + avatarOffset.y) * ratio,
      avatarDrawW * ratio,
      avatarDrawH * ratio,
    );
    return canvas.toDataURL('image/jpeg', 0.9);
  };

  const handleApplyAvatar = async () => {
    if (!avatarSrc) return;
    const next = await buildAvatarDataUrl();
    setAvatarPreview(next);
    setAvatarSrc('');
    setAvatarNat({ w: 0, h: 0 });
    setAvatarZoom(1);
    setAvatarOffset({ x: 0, y: 0 });
  };

  const handleClearAvatar = () => {
    setAvatarPreview('');
    setAvatarSrc('');
    setAvatarNat({ w: 0, h: 0 });
  };

  const handleSaveProfile = async () => {
    const nextName = String(nameValue || '').replace(/\s+/g, ' ').trim().slice(0, 24) || '考生用户';
    try {
      const avatar = await buildAvatarDataUrl();
      let saved = { name: nextName, avatar };
      if (window.openexam?.app?.saveProfile) {
        const result = await window.openexam.app.saveProfile(saved);
        if (result?.profile) saved = result.profile;
      }
      setNameValue(saved.name);
      setAvatarPreview(saved.avatar || '');
      setAvatarSrc('');
      onProfileSaved?.(saved);
      showToast({ title: '个人资料已保存', message: '顶部与侧栏的头像会立即更新。', tone: 'success' });
    } catch (error) {
      await showAlert({ title: '保存失败', message: error.message || '未知错误', tone: 'danger' });
    }
  };

  const handleAvatarPointerDown = (event) => {
    if (!avatarSrc) return;
    avatarDragRef.current = { x: event.clientX, y: event.clientY, offset: avatarOffset };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleAvatarPointerMove = (event) => {
    const start = avatarDragRef.current;
    if (!start) return;
    setAvatarOffset(clampAvatarOffset({
      x: start.offset.x + event.clientX - start.x,
      y: start.offset.y + event.clientY - start.y,
    }));
  };

  const handleAvatarPointerUp = () => {
    avatarDragRef.current = null;
  };

  const handleFontScaleChange = (next) => {
    const applied = setFontScale(next);
    setFontScaleState(applied);
  };

  const handleResetFontScale = () => {
    const applied = resetFontScale();
    setFontScaleState(applied);
    showToast({ title: '已恢复默认', message: '文字大小已还原为标准。', tone: 'success' });
  };

  useEffect(() => {
    let mounted = true;
    let dispose = () => {};

    const loadAppState = async () => {
      try {
        if (window.openexam?.app?.getInfo) {
          const info = await window.openexam.app.getInfo();
          if (mounted) setAppInfo(info || null);
        }

        if (window.openexam?.app?.getUpdateState) {
          const state = await window.openexam.app.getUpdateState();
          if (mounted) setUpdateState(state || null);
        }

        if (window.openexam?.app?.onUpdateState) {
          dispose = window.openexam.app.onUpdateState((payload) => {
            if (mounted) setUpdateState(payload || null);
          });
        }
      } catch (error) {
        console.error('读取应用状态失败:', error);
      }
    };

    loadAppState();
    return () => {
      mounted = false;
      dispose();
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const loadSettings = async () => {
      let next = normalizeAISettings(null);
      try {
        const localSaved = localStorage.getItem('openexam_settings');
        if (localSaved) {
          next = normalizeAISettings(JSON.parse(localSaved));
        }
      } catch (e) {}

      try {
        if (window.openexam?.db?.getAISettings) {
          const sqliteSettings = await window.openexam.db.getAISettings();
          if (sqliteSettings && typeof sqliteSettings === 'object') {
            next = normalizeAISettings(sqliteSettings);
            localStorage.setItem('openexam_settings', JSON.stringify(next));
          }
          setPersistStatus('sqlite');
        } else {
          setPersistStatus('local');
        }
      } catch (error) {
        console.error('读取 SQLite 配置失败:', error);
        setPersistStatus('local');
      }

      try {
        if (window.openexam?.db?.getAIConnectionState) {
          const state = await window.openexam.db.getAIConnectionState();
          if (mounted) setConnectionState(state || null);
        }
      } catch (error) {
        console.error('读取连接状态失败:', error);
      }

      if (mounted) setSettings(next);
    };

    loadSettings();
    return () => { mounted = false; };
  }, []);

  const handleSave = async () => {
    const normalized = normalizeAISettings(settings);
    setSettings(normalized);
    localStorage.setItem('openexam_settings', JSON.stringify(normalized));
    const now = new Date().toISOString();
    setLastSavedAt(now);
    try {
      if (window.openexam?.db?.saveAISettings) {
        await window.openexam.db.saveAISettings(normalized);
        setPersistStatus('sqlite');
      }
    } catch (error) {
      console.error('写入 SQLite 配置失败:', error);
      setPersistStatus('local');
    }
    showToast({ title: '配置已保存', message: persistStatus === 'sqlite' ? '已同步写入本地数据库。' : '已保存到本地缓存。', tone: 'success' });
    setTestStatus('saved');
    setTimeout(() => setTestStatus(null), 2000);
  };

  const handleTest = async () => {
    if (!settings.apiKey || !settings.aiProvider) {
      await showAlert({ title: '缺少 AI 配置', message: '请先填写 API Key 并选择服务商。', tone: 'warning' });
      return;
    }
    setTestStatus('testing');
    try {
      if (window.openexam?.ai) {
        const result = await window.openexam.ai.testConnection(settings);
        const state = {
          status: result.success ? 'success' : 'error',
          provider: settings.aiProvider || '',
          model: settings.model || '',
          apiBase: settings.apiBase || '',
          checkedAt: new Date().toISOString(),
          error: result.success ? '' : (result.error || ''),
        };
        setConnectionState(state);
        if (window.openexam?.db?.saveAIConnectionState) {
          await window.openexam.db.saveAIConnectionState(state);
        }
        if (result.success) {
          showToast({ title: '连接成功', message: '当前 AI 服务已验证可用。', tone: 'success' });
          setTestStatus('success');
        } else {
          showToast({ title: '连接失败', message: result.error || '未知错误', tone: 'danger' });
          setTestStatus('error'); console.error('连接失败:', result.error);
        }
      } else {
        showToast({ title: '连接成功', message: '当前环境已通过连接测试。', tone: 'success' });
        setTestStatus('success');
      }
    } catch (e) {
      showToast({ title: '测试失败', message: e?.message || '未知错误', tone: 'danger' });
      setTestStatus('error');
      console.error('测试连接失败:', e);
    }
    setTimeout(() => setTestStatus(null), 3000);
  };

  const formatTime = (value) => {
    if (!value) return '-';
    try {
      return new Date(value).toLocaleString();
    } catch (error) {
      return value;
    }
  };

  const getUpdateSummary = () => {
    if (!updateState) return '可在此查看版本与 GitHub Release 更新状态';

    const statusMap = {
      idle: '已接入自动更新，可随时手动检查',
      checking: '正在检查 GitHub Release 更新',
      available: '发现新版本，可前往 Release 页面下载',
      downloading: '正在后台下载更新包',
      downloaded: '更新包已下载完成，可重启安装',
      'up-to-date': '当前已经是最新版本',
      'manual-update': '发现新版本，当前平台建议手动下载安装',
      dev: '当前为开发环境，仅展示更新状态',
      error: updateState.message || '更新检查失败，可稍后重试',
    };

    return statusMap[updateState.status] || updateState.message || '更新状态未知';
  };

  const handleCheckUpdates = async () => {
    if (!window.openexam?.app?.checkForUpdates || checkingUpdate) return;
    setCheckingUpdate(true);
    try {
      const result = await window.openexam.app.checkForUpdates();
      setUpdateState(result || null);
    } catch (error) {
      await showAlert({ title: '检查更新失败', message: error.message || '未知错误', tone: 'warning' });
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleOpenLink = async (targetUrl) => {
    if (!targetUrl) return;
    try {
      if (window.openexam?.app?.openExternal) {
        await window.openexam.app.openExternal(targetUrl);
      } else {
        window.open(targetUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (error) {
      console.error('打开链接失败:', error);
    }
  };

  const handleUpdatePrimary = async () => {
    if (!updateState) {
      await handleCheckUpdates();
      return;
    }

    if (updateState.status === 'downloaded' && appInfo?.canAutoInstall && window.openexam?.app?.quitAndInstallUpdate) {
      await window.openexam.app.quitAndInstallUpdate();
      return;
    }

    if ([ 'available', 'manual-update', 'error' ].includes(updateState.status) || (!appInfo?.canAutoInstall && updateState.latestVersion && updateState.latestVersion !== appInfo?.version)) {
      const target = updateState.releaseUrl || appInfo?.releaseUrl || 'https://github.com/lmk1010/OpenExam/releases';
      if (window.openexam?.app?.openReleasePage) {
        await window.openexam.app.openReleasePage();
      } else {
        await handleOpenLink(target);
      }
      return;
    }

    await handleCheckUpdates();
  };

  const updatePrimaryLabel = (() => {
    if (checkingUpdate || updateState?.status === 'checking') return '检查中...';
    if (updateState?.status === 'downloaded' && appInfo?.canAutoInstall) return '重启安装';
    if ([ 'available', 'manual-update', 'error' ].includes(updateState?.status) || (!appInfo?.canAutoInstall && updateState?.latestVersion && updateState.latestVersion !== appInfo?.version)) return '前往 Release';
    return '检查更新';
  })();

  const collectBackupClientState = () => {
    return RESETTABLE_LOCAL_KEYS.reduce((result, key) => {
      const value = localStorage.getItem(key);
      if (value !== null) result[key] = value;
      return result;
    }, {});
  };

  const restoreBackupClientState = (payload = {}) => {
    RESETTABLE_LOCAL_KEYS.forEach((key) => localStorage.removeItem(key));
    if (!payload || typeof payload !== 'object') return;
    RESETTABLE_LOCAL_KEYS.forEach((key) => {
      if (typeof payload[key] === 'string') localStorage.setItem(key, payload[key]);
    });
  };

  const handleExportAllData = async () => {
    if (backupBusy) return;

    try {
      setBackupBusy('export');
      if (window.openexam?.db?.exportBackupFile) {
        const result = await window.openexam.db.exportBackupFile(collectBackupClientState());
        if (result?.canceled) return;
        await showAlert({ title: '导出成功', message: result?.filePath || '备份文件已保存', tone: 'success' });
        return;
      }

      if (!window.openexam?.db?.exportAllData) {
        await showAlert({ title: '暂不支持', message: '当前环境不支持导出。', tone: 'warning' });
        return;
      }

      const payload = await window.openexam.db.exportAllData();
      const backup = {
        ...payload,
        kind: 'openexam-backup',
        version: 2,
        client_state: collectBackupClientState(),
      };
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      const filename = `openexam-backup-${stamp}.json`;
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
      await showAlert({ title: '导出成功', message: filename, tone: 'success' });
    } catch (error) {
      await showAlert({ title: '导出失败', message: error.message || '未知错误', tone: 'danger' });
    } finally {
      setBackupBusy('');
    }
  };

  const handleImportBackupData = async () => {
    if (backupBusy) return;
    if (!window.openexam?.db?.importBackupFile) {
      await showAlert({ title: '暂不支持', message: '当前环境不支持导入。', tone: 'warning' });
      return;
    }

    const confirmed = await showConfirm({
      title: '导入备份',
      message: '导入备份会覆盖当前用户数据、练习历史、错题、本地会话和自定义内容，是否继续？',
      confirmText: '继续导入',
      cancelText: '取消',
      tone: 'warning',
    });
    if (!confirmed) return;

    try {
      setBackupBusy('import');
      const result = await window.openexam.db.importBackupFile();
      if (result?.canceled) return;
      restoreBackupClientState(result?.clientState || {});
      await showAlert({
        title: '导入成功',
        message: `已恢复 ${result?.stats?.papers || 0} 套试卷、${result?.stats?.questions || 0} 道题，应用将立即刷新。`,
        tone: 'success',
      });
      window.location.reload();
    } catch (error) {
      await showAlert({ title: '导入失败', message: error.message || '未知错误', tone: 'danger' });
    } finally {
      setBackupBusy('');
    }
  };

  const handleResetUserData = async () => {
    if (!window.openexam?.db?.resetUserData) {
      await showAlert({ title: '暂不支持', message: '当前环境不支持重置用户数据。', tone: 'warning' });
      return;
    }

    const confirmed = await showConfirm({
      title: '重置用户数据',
      message: '该操作会保留题库，但会清空练习进度、错题、本地 AI 会话、设置和自定义内容，恢复到首次打开状态。是否继续？',
      confirmText: '确认重置',
      cancelText: '取消',
      tone: 'danger',
    });
    if (!confirmed) return;

    try {
      const result = await window.openexam.db.resetUserData();
      RESETTABLE_LOCAL_KEYS.forEach((key) => localStorage.removeItem(key));
      await showAlert({
        title: '已重置成功',
        message: `已重置为新用户状态，题库保留 ${result?.preserved?.papers || 0} 套 / ${result?.preserved?.questions || 0} 题`,
        tone: 'success',
      });
      window.location.reload();
    } catch (error) {
      await showAlert({ title: '重置失败', message: error.message || '未知错误', tone: 'danger' });
    }
  };

  const handleCreateLocalBackup = async () => {
    if (backupBusy) return;
    if (!window.openexam?.db?.createLocalBackup) {
      await showAlert({ title: '暂不支持', message: '当前环境不支持本地备份。', tone: 'warning' });
      return;
    }
    try {
      setBackupBusy('local');
      const result = await window.openexam.db.createLocalBackup();
      if (!result?.success) throw new Error(result?.error || '备份失败');
      setLocalBackups(result);
      showToast({
        title: '备份完成',
        message: result.backup?.name ? `${result.backup.name}（${formatBytes(result.backup.size)}）` : '已生成本地备份',
        tone: 'success',
      });
    } catch (error) {
      await showAlert({ title: '备份失败', message: error.message || '未知错误', tone: 'danger' });
    } finally {
      setBackupBusy('');
    }
  };

  const handleRestoreLocalBackup = async (backup) => {
    if (backupBusy) return;
    if (!window.openexam?.db?.restoreLocalBackup) {
      await showAlert({ title: '暂不支持', message: '当前环境不支持从本地备份恢复。', tone: 'warning' });
      return;
    }

    const confirmed = await showConfirm({
      title: '从本地备份恢复',
      message: `将用 ${formatBackupTime(backup.createdAt)} 的${backup.kind === 'auto' ? '自动' : '手动'}备份覆盖当前数据库（题库、练习记录、错题、设置与 AI 会话等）。备份之后产生的改动会丢失，是否继续？`,
      confirmText: '确认恢复',
      cancelText: '取消',
      tone: 'danger',
    });
    if (!confirmed) return;

    try {
      setBackupBusy('restore');
      const result = await window.openexam.db.restoreLocalBackup(backup.name);
      if (!result?.success) throw new Error(result?.error || '恢复失败');
      await showAlert({
        title: '恢复完成',
        message: `已加载 ${formatBackupTime(backup.createdAt)} 的数据，点击确定后界面会自动刷新。`,
        tone: 'success',
      });
      window.location.reload();
    } catch (error) {
      await showAlert({ title: '恢复失败', message: error.message || '未知错误', tone: 'danger' });
    } finally {
      setBackupBusy('');
    }
  };

  const navItems = [
    { id: 'profile', label: '个人资料', icon: <NavIcon type="user" /> },
    { id: 'ai', label: 'AI 模型', icon: <NavIcon type="ai" /> },
    { id: 'runtime', label: '运行环境', icon: <NavIcon type="runtime" /> },
    { id: 'import', label: '导入设置', icon: <NavIcon type="import" /> },
    { id: 'display', label: '显示设置', icon: <NavIcon type="display" /> },
    { id: 'data', label: '数据管理', icon: <NavIcon type="data" /> },
    { id: 'about', label: '关于', icon: <NavIcon type="about" /> },
  ];

  return (
    <section className="main-panel module-page" style={{ padding: "0 20px", gap: 20, overflow: "auto" }}>
      <header style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
        <div className="breadcrumb" style={{ margin: 0 }}>设置 &gt; 系统选项</div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, borderBottom: "1px solid var(--line)", paddingBottom: 16 }}>
          <div style={{ width: 28, height: 28, borderRadius: 8, background: "var(--accent-soft-bg)", display: "grid", placeItems: "center", color: "var(--accent)" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
            </svg>
          </div>
          <h2 style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.5px", margin: 0 }}>系统设置</h2>
          {onBack && (
            <button onClick={onBack} style={{ marginLeft: "auto", background: "var(--surface)", border: "1px solid var(--line)", padding: "6px 12px", borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, transition: "all 0.2s" }} onMouseOver={e => { e.target.style.background = "var(--surface-soft)"; }} onMouseOut={e => { e.target.style.background = "var(--surface)"; }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
              返回
            </button>
          )}
        </div>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 32, flex: 1, minHeight: 0, paddingBottom: 20 }}>
        {/* Navigation */}
        <nav style={{ display: "flex", flexDirection: "column", gap: 6, paddingRight: 20, borderRight: "1px solid var(--line)" }}>
          {navItems.map(item => (
            <button key={item.id} onClick={() => setActiveSection(item.id)}
              style={{
                display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 8, border: "none", cursor: "pointer", transition: "all 0.2s", fontSize: 13, fontWeight: activeSection === item.id ? 600 : 500,
                ...(activeSection === item.id ? { background: "var(--accent)", color: "#fff", boxShadow: "0 8px 18px rgba(15,23,42,0.08)" } : { background: "transparent", color: "var(--muted)" })
              }}
              onMouseOver={e => { if (activeSection !== item.id) e.currentTarget.style.background = "var(--surface-soft)"; }}
              onMouseOut={e => { if (activeSection !== item.id) e.currentTarget.style.background = "transparent"; }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>

        {/* Content Area */}
        <div style={{ display: "flex", flexDirection: "column", gap: 24, overflow: "auto", paddingRight: 8 }}>
          {activeSection === 'profile' && (
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              <div>
                <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>个人资料</h3>
                <p style={{ fontSize: 12, color: "var(--muted)" }}>名字和头像只保存在本机数据库，重启或重装后仍会保留。</p>
              </div>

              <div className="profile-editor">
                <div className="profile-avatar-col">
                  <div
                    className={`profile-avatar-preview${avatarSrc ? " is-cropping" : ""}`}
                    onPointerDown={handleAvatarPointerDown}
                    onPointerMove={handleAvatarPointerMove}
                    onPointerUp={handleAvatarPointerUp}
                    onPointerCancel={handleAvatarPointerUp}
                  >
                    {avatarSrc ? (
                      <img
                        src={avatarSrc}
                        alt=""
                        draggable={false}
                        style={{
                          width: avatarDrawW,
                          height: avatarDrawH,
                          left: (AVATAR_PREVIEW - avatarDrawW) / 2 + avatarOffset.x,
                          top: (AVATAR_PREVIEW - avatarDrawH) / 2 + avatarOffset.y,
                        }}
                      />
                    ) : avatarPreview ? (
                      <img src={avatarPreview} alt="" />
                    ) : (
                      <span className="profile-avatar-letter">{Array.from(nameValue.trim())[0] || "考"}</span>
                    )}
                  </div>

                  <div className="profile-avatar-actions">
                    <button type="button" className="profile-btn" onClick={() => avatarFileRef.current?.click()} disabled={avatarBusy}>
                      {avatarBusy ? "读取中…" : "选择图片"}
                    </button>
                    {avatarSrc && (
                      <button type="button" className="profile-btn is-primary" onClick={handleApplyAvatar}>应用裁剪</button>
                    )}
                    {!avatarSrc && avatarPreview && (
                      <button type="button" className="profile-btn" onClick={handleClearAvatar}>移除头像</button>
                    )}
                  </div>
                  <input
                    ref={avatarFileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    style={{ display: "none" }}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      handleAvatarFile(file);
                    }}
                  />

                  {avatarSrc && (
                    <label className="profile-zoom">
                      <span>缩放</span>
                      <input
                        type="range"
                        min="1"
                        max="3"
                        step="0.01"
                        value={avatarZoom}
                        onChange={(event) => {
                          const next = Number(event.target.value);
                          setAvatarZoom(next);
                          setAvatarOffset((prev) => clampAvatarOffset(prev, next));
                        }}
                      />
                    </label>
                  )}
                  <p className="profile-hint">
                    {avatarSrc ? "拖动图片调位置，滑杆缩放，圆内就是最终头像。" : "支持 PNG / JPG / WebP，建议使用正方形图片。"}
                  </p>
                </div>

                <div className="profile-fields">
                  <label htmlFor="profile-name">名字</label>
                  <input
                    id="profile-name"
                    value={nameValue}
                    maxLength={24}
                    placeholder="例如：小林"
                    onChange={(event) => setNameValue(event.target.value)}
                  />
                  <p className="profile-hint">显示在右上角与头像旁，最多 24 个字。</p>
                  <button type="button" className="profile-btn is-primary" onClick={handleSaveProfile} style={{ alignSelf: "flex-start", marginTop: 6 }}>
                    保存资料
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'ai' && (
            <AIConfigPanel
              settings={settings}
              onChange={setSettings}
              onSave={handleSave}
              onTestBase={handleTest}
              baseTestStatus={testStatus}
              persistStatus={persistStatus}
              connectionState={connectionState}
              lastSavedAt={lastSavedAt}
              showKey={showKey}
              setShowKey={setShowKey}
            />
          )}

          {activeSection === 'runtime' && (
            <RuntimeEnvPanel />
          )}

          {activeSection === 'import' && (
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              <div>
                <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>导入设置</h3>
                <p style={{ fontSize: 12, color: "var(--muted)" }}>未配置 AI 时，可使用模板文件导入题目</p>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "16px 0", background: "transparent", borderRadius: 0, borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
                <div style={{ color: "var(--accent)", display: "grid", placeItems: "center" }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
                  </svg>
                </div>
                <div style={{ flex: 1 }}>
                  <h4 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 4px 0", color: "var(--text)" }}>题目导入模板</h4>
                  <p style={{ fontSize: 11, color: "var(--muted)", margin: 0 }}>支持 CSV 格式，包含题目、选项、答案、解析等必需字段</p>
                </div>
                <button onClick={downloadTemplate} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 6, border: "1px solid var(--accent)", background: "transparent", color: "var(--accent)", fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.2s" }} onMouseOver={e => { e.target.style.background = "var(--accent)"; e.target.style.color = "#fff"; }} onMouseOut={e => { e.target.style.background = "transparent"; e.target.style.color = "var(--accent)"; }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  下载模板
                </button>
              </div>
            </div>
          )}

          {activeSection === 'display' && (
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              <div>
                <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>显示设置</h3>
                <p style={{ fontSize: 12, color: "var(--muted)" }}>仅调整题目文字大小（题干、选项、解析、答案），界面其余部分保持不变，设置会立即生效并自动保存</p>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "18px 0", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <h4 style={{ fontSize: 14, fontWeight: 600, margin: 0, color: "var(--text)" }}>题目字体大小</h4>
                    <p style={{ fontSize: 11, color: "var(--muted)", margin: 0 }}>作用于做题、对答案、错题本中的题目文字，当前 {Math.round(fontScale * 100)}%</p>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {FONT_SCALE_PRESETS.map((preset) => {
                      const active = Math.abs(fontScale - preset.value) < 0.001;
                      return (
                        <button
                          key={preset.id}
                          onClick={() => handleFontScaleChange(preset.value)}
                          style={{
                            padding: "8px 14px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600, transition: "all 0.2s", border: active ? "1px solid var(--accent)" : "1px solid var(--line)",
                            background: active ? "var(--accent)" : "var(--surface)", color: active ? "#fff" : "var(--text)",
                          }}
                          onMouseOver={e => { if (!active) e.currentTarget.style.background = "var(--surface-soft)"; }}
                          onMouseOut={e => { if (!active) e.currentTarget.style.background = "var(--surface)"; }}
                        >
                          {preset.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <span style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap" }}>标准 {Math.round(FONT_SCALE_MIN * 100)}%</span>
                  <input
                    type="range"
                    min={FONT_SCALE_MIN}
                    max={FONT_SCALE_MAX}
                    step={FONT_SCALE_STEP}
                    value={fontScale}
                    onChange={(e) => handleFontScaleChange(parseFloat(e.target.value))}
                    style={{ flex: 1, accentColor: "var(--accent)", cursor: "pointer" }}
                  />
                  <span style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap" }}>超大 {Math.round(FONT_SCALE_MAX * 100)}%</span>
                  <span style={{ minWidth: 48, textAlign: "right", fontSize: 13, fontWeight: 700, color: "var(--accent)" }}>{Math.round(fontScale * 100)}%</span>
                </div>

                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                  <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.6 }}>
                    提示：仅题目文字放大，按钮、导航与间距不变。
                  </div>
                  <button
                    onClick={handleResetFontScale}
                    disabled={Math.abs(fontScale - DEFAULT_FONT_SCALE) < 0.001}
                    style={{
                      padding: "8px 14px", borderRadius: 8, border: "1px solid var(--line)", background: "transparent", color: "var(--muted)", fontSize: 12, fontWeight: 600,
                      cursor: Math.abs(fontScale - DEFAULT_FONT_SCALE) < 0.001 ? "not-allowed" : "pointer", opacity: Math.abs(fontScale - DEFAULT_FONT_SCALE) < 0.001 ? 0.5 : 1,
                    }}
                  >
                    恢复默认
                  </button>
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <h4 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: "var(--text)" }}>预览（题目实际显示效果）</h4>
                <div
                  style={{
                    padding: "18px 20px", borderRadius: 14, background: "var(--surface-soft)", border: "1px solid var(--line)",
                    display: "flex", flexDirection: "column", gap: 10, pointerEvents: "none",
                    fontSize: "calc(15px * var(--question-font-scale, 1))",
                  }}
                >
                  <div style={{ fontWeight: 500, lineHeight: 1.85, color: "var(--text)" }}>
                    1. 下列关于函数 <span style={{ fontWeight: 600 }}>f(x) = x² + 2x</span> 的说法正确的是：
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, lineHeight: 1.7, color: "var(--text)" }}>
                    <div>A. 函数在 x = 0 处取得最小值</div>
                    <div>B. 函数的图象关于 y 轴对称</div>
                    <div>C. 函数在区间 [0, +∞) 上单调递增</div>
                    <div>D. 函数没有零点</div>
                  </div>
                  <div style={{ fontSize: "0.8em", lineHeight: 1.7, color: "var(--muted)" }}>
                    【答案】C　【解析】f(x) = (x + 1)² − 1，对称轴 x = −1，在 [0, +∞) 上单调递增。
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'data' && (
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              <div>
                <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>数据管理</h3>
                <p style={{ fontSize: 12, color: "var(--muted)" }}>支持导出完整备份、导入恢复个人历史与自定义内容，也可一键重置当前账号状态</p>
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                {['练习记录', '错题进度', 'AI 会话', 'AI 配置', '自定义试卷', '导入题库'].map((item) => (
                  <span key={item} style={{ padding: "0", borderRadius: 0, background: "transparent", border: "none", fontSize: 11, color: "var(--muted)", fontWeight: 600 }}>{item}</span>
                ))}
              </div>

              <div style={{ borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)", padding: "18px 0", display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <div>
                    <h4 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 4px 0", color: "var(--text)" }}>本地自动备份</h4>
                    <p style={{ fontSize: 11, color: "var(--muted)", margin: 0, lineHeight: 1.7 }}>
                      启动时每天自动备份一次，数据库以 SQLite 在线快照保存（包含 WAL 中尚未合并的数据，不用停用应用）。
                      最多保留 {localBackups?.limits?.maxCount ?? 10} 份且总大小不超过 {formatBytes(localBackups?.limits?.maxBytes ?? 1024 * 1024 * 1024)}，超出后从最旧的开始淘汰。
                    </p>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          const result = await window.openexam?.db?.listLocalBackups?.();
                          if (result?.success) setLocalBackups(result);
                        } catch (error) {
                          console.error('刷新本地备份列表失败:', error);
                        }
                      }}
                      disabled={!!backupBusy}
                      style={{ padding: "7px 12px", borderRadius: 6, border: "1px solid var(--line)", background: "transparent", color: "var(--muted)", fontSize: 12, fontWeight: 600, cursor: backupBusy ? "not-allowed" : "pointer" }}
                    >刷新</button>
                    <button
                      type="button"
                      onClick={handleCreateLocalBackup}
                      disabled={!!backupBusy}
                      style={{ padding: "7px 12px", borderRadius: 6, border: "1px solid var(--accent)", background: "var(--accent)", color: "#fff", fontSize: 12, fontWeight: 600, cursor: backupBusy ? "wait" : "pointer", opacity: backupBusy ? 0.7 : 1 }}
                    >{backupBusy === 'local' ? '正在备份…' : '立即备份'}</button>
                  </div>
                </div>

                <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 11, color: "var(--muted)" }}>
                  <span>当前占用 <strong style={{ color: "var(--text)" }}>{formatBytes(localBackups?.totalBytes)}</strong> / {formatBytes(localBackups?.limits?.maxBytes ?? 1024 * 1024 * 1024)}</span>
                  <span>共 {localBackups?.count ?? 0} 份</span>
                  <span style={{ wordBreak: "break-all" }}>目录：{localBackups?.directory || '读取中…'}</span>
                </div>

                {localBackups === null ? (
                  <div style={{ fontSize: 11, color: "var(--muted)" }}>正在读取备份列表…</div>
                ) : (localBackups.backups || []).length === 0 ? (
                  <div style={{ fontSize: 11, color: "var(--muted)" }}>还没有备份。点「立即备份」生成第一份，或下次启动时等待自动备份。</div>
                ) : (
                  <div>
                    {(localBackups.backups || []).map((backup) => (
                      <div key={backup.name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderTop: "1px solid var(--line)", fontSize: 12 }}>
                        <span style={{ padding: "1px 6px", borderRadius: 999, fontSize: 10, fontWeight: 700, color: backup.kind === 'auto' ? 'var(--accent)' : 'var(--text)', background: backup.kind === 'auto' ? 'var(--accent-soft-bg)' : 'var(--surface-soft)' }}>
                          {backup.kind === 'auto' ? '自动' : '手动'}
                        </span>
                        <span style={{ color: "var(--text)" }}>{formatBackupTime(backup.createdAt)}</span>
                        <span style={{ marginLeft: "auto", color: "var(--muted)" }}>{formatBytes(backup.size)}</span>
                        <button
                          type="button"
                          onClick={() => handleRestoreLocalBackup(backup)}
                          disabled={!!backupBusy}
                          style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid var(--line)", background: "transparent", color: "var(--text)", fontSize: 11, fontWeight: 600, cursor: backupBusy ? "not-allowed" : "pointer", opacity: backupBusy ? 0.6 : 1 }}
                        >{backupBusy === 'restore' ? '恢复中…' : '恢复'}</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 0, borderTop: "1px solid var(--line)" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "16px 16px 16px 0", background: "transparent", borderRadius: 0, borderRight: "1px solid var(--line)", minWidth: 0 }}>
                  <div style={{ color: "var(--accent)", display: "grid", placeItems: "center", width: 20 }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                  </div>
                  <div>
                    <h4 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 4px 0", color: "var(--text)" }}>导出完整备份</h4>
                    <p style={{ fontSize: 11, color: "var(--muted)", margin: 0, lineHeight: 1.6 }}>保存当前账号的题库、自定义试卷、做题历史、错题、设置与 AI 会话</p>
                  </div>
                  <button onClick={handleExportAllData} disabled={backupBusy === 'export'} style={{ marginTop: "auto", padding: "8px 0", borderRadius: 6, border: "1px solid var(--accent)", background: "transparent", color: "var(--accent)", fontSize: 12, fontWeight: 600, cursor: backupBusy === 'export' ? 'wait' : 'pointer', opacity: backupBusy === 'export' ? 0.7 : 1 }}>{backupBusy === 'export' ? '正在导出…' : '导出备份文件'}</button>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "16px", background: "transparent", borderRadius: 0, borderRight: "1px solid var(--line)", minWidth: 0 }}>
                  <div style={{ color: "#566eff", display: "grid", placeItems: "center", width: 20 }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  </div>
                  <div>
                    <h4 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 4px 0", color: "var(--text)" }}>导入恢复</h4>
                    <p style={{ fontSize: 11, color: "var(--muted)", margin: 0, lineHeight: 1.6 }}>从备份文件恢复同一套体验，包含个人历史、错题、设置、聊天记录与自定义内容</p>
                  </div>
                  <button onClick={handleImportBackupData} disabled={backupBusy === 'import'} style={{ marginTop: "auto", padding: "8px 0", borderRadius: 6, border: "1px solid #566eff", background: "transparent", color: "#566eff", fontSize: 12, fontWeight: 600, cursor: backupBusy === 'import' ? 'wait' : 'pointer', opacity: backupBusy === 'import' ? 0.7 : 1 }}>{backupBusy === 'import' ? '正在导入…' : '选择备份文件'}</button>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "16px 0 16px 16px", background: "transparent", borderRadius: 0, minWidth: 0 }}>
                  <div style={{ color: "var(--danger)", display: "grid", placeItems: "center", width: 20 }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                  </div>
                  <div>
                    <h4 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 4px 0", color: "var(--danger)" }}>重置用户数据</h4>
                    <p style={{ fontSize: 11, color: "var(--muted)", margin: 0, lineHeight: 1.6 }}>保留内置题库，清空练习进度、错题、AI 会话、设置与自定义内容</p>
                  </div>
                  <button onClick={handleResetUserData} disabled={!!backupBusy} style={{ marginTop: "auto", padding: "8px 0", borderRadius: 6, border: "none", background: "var(--danger)", color: "#fff", fontSize: 12, fontWeight: 600, cursor: backupBusy ? 'not-allowed' : 'pointer', opacity: backupBusy ? 0.7 : 1 }}>恢复新用户状态</button>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'about' && (
            <div style={{ display: "flex", flexDirection: "column", gap: 20, flex: 1, minHeight: 300, justifyContent: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 18, padding: "18px 0", borderRadius: 0, background: "transparent", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)", boxShadow: "none" }}>
                <div className="app-logo app-logo--about">
                  <img src={appLogo} alt="OpenExam" className="app-logo-image" />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <h3 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: "var(--text)", letterSpacing: "-0.5px" }}>StudyStudio</h3>
                    <span style={{ fontSize: 12, color: "var(--accent)", fontWeight: 700 }}>v{appInfo?.version || '0.2.0'}</span>
                  </div>
                  <p style={{ fontSize: 13, color: "var(--muted)", margin: 0 }}>考研智能学习空间 · 本地优先 · 多模型 AI 识图</p>
                  <div style={{ display: "flex", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
                    <button type="button" onClick={() => handleOpenLink('https://github.com/lmk1010/OpenExam')} style={{ fontSize: 13, color: "var(--accent)", fontWeight: 600, padding: "0", borderRadius: 0, border: "none", background: "transparent", cursor: "pointer" }}>GitHub 仓库</button>
                    <button type="button" onClick={() => handleOpenLink('https://github.com/lmk1010/OpenExam/issues')} style={{ fontSize: 13, color: "var(--accent)", fontWeight: 600, padding: "0", borderRadius: 0, border: "none", background: "transparent", cursor: "pointer" }}>反馈问题</button>
                    <button type="button" onClick={() => handleOpenLink(appInfo?.releaseUrl || 'https://github.com/lmk1010/OpenExam/releases')} style={{ fontSize: 13, color: "var(--text)", fontWeight: 600, padding: "8px 14px", borderRadius: 12, border: "1px solid var(--line)", background: "var(--surface)", cursor: "pointer" }}>Release 页面</button>
                  </div>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr", gap: 16 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "20px 22px", borderRadius: 18, background: "var(--surface-soft)", border: "1px solid var(--line)" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                    <div>
                      <h4 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>在线更新</h4>
                      <p style={{ fontSize: 12, color: "var(--muted)", margin: "6px 0 0 0" }}>{getUpdateSummary()}</p>
                    </div>
                    <button type="button" onClick={handleUpdatePrimary} disabled={checkingUpdate || updateState?.status === 'checking'} style={{ minWidth: 108, height: 38, borderRadius: 12, border: "none", background: "var(--accent)", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", opacity: checkingUpdate || updateState?.status === 'checking' ? 0.7 : 1 }}>{updatePrimaryLabel}</button>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
                    <div style={{ padding: "12px 14px", borderRadius: 14, background: "var(--surface)", border: "1px solid var(--line)" }}>
                      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>当前版本</div>
                      <strong style={{ fontSize: 16 }}>{appInfo?.version ? `v${appInfo.version}` : '-'}</strong>
                    </div>
                    <div style={{ padding: "12px 14px", borderRadius: 14, background: "var(--surface)", border: "1px solid var(--line)" }}>
                      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>最新版本</div>
                      <strong style={{ fontSize: 16 }}>{updateState?.latestVersion ? `v${updateState.latestVersion}` : '-'}</strong>
                    </div>
                    <div style={{ padding: "12px 14px", borderRadius: 14, background: "var(--surface)", border: "1px solid var(--line)" }}>
                      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>更新方式</div>
                      <strong style={{ fontSize: 14 }}>{appInfo?.canAutoInstall ? '自动下载 / 安装' : '检测后手动下载'}</strong>
                    </div>
                    <div style={{ padding: "12px 14px", borderRadius: 14, background: "var(--surface)", border: "1px solid var(--line)" }}>
                      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>上次检查</div>
                      <strong style={{ fontSize: 14 }}>{formatTime(updateState?.lastCheckedAt)}</strong>
                    </div>
                  </div>
                  {updateState?.message && (
                    <div style={{ fontSize: 12, color: updateState?.status === 'error' ? 'var(--danger)' : 'var(--muted)', lineHeight: 1.7 }}>
                      {updateState.message}
                      {updateState?.error ? `：${updateState.error}` : ''}
                    </div>
                  )}
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "20px 22px", borderRadius: 18, background: "var(--surface-soft)", border: "1px solid var(--line)" }}>
                  <h4 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>Release 提示</h4>
                  <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.8 }}>
                    <div>Windows：可直接通过应用内更新下载安装。</div>
                    <div>macOS：检测到新版后会打开 GitHub Release 下载。</div>
                    <div>若 macOS 首次打开被拦截，请按 Release 说明移除隔离属性。</div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function downloadTemplate() {
  const headers = ['题目内容', '选项A', '选项B', '选项C', '选项D', '正确答案', '解析', '分类', '子分类'];
  const example = ['下列说法正确的是：', '选项A内容', '选项B内容', '选项C内容', '选项D内容', 'A', '解析内容', 'yanyu', 'xuanci'];
  const csvContent = [headers.join(','), example.join(',')].join('\n');
  const BOM = '\uFEFF';
  const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '题目导入模板.csv';
  a.click();
  URL.revokeObjectURL(url);
}
