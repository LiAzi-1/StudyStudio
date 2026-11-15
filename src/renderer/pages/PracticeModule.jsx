import React, { useState, useEffect } from 'react';
import { getRoleSettings, isRoleConfigured } from '../store/aiSettings.js';
import { useDialog } from '../components/DialogProvider.jsx';
import PaperList from './PaperList.jsx';
import PracticeHistory from './PracticeHistory.jsx';

// 分类配置
const categoryConfig = {
  math: { name: '数学', color: '#2563eb' },
  english: { name: '英语', color: '#0f766e' },
  politics: { name: '政治', color: '#b45309' },
  major: { name: '专业课', color: '#7c3aed' },
};

// 默认子分类配置
const defaultSubCategories = {
  math: ['gaoshu', 'daishu', 'gaiilv'],
  english: ['wanxing', 'yuedu', 'fanyi', 'xiezuo'],
  politics: ['makesi', 'maogai', 'shixi', 'shiju'],
  major: ['major'],
};

const TRACK_LABELS = {
  kaoyan: '考研',
};

// 子分类中文映射
const subCategoryNames = {
  // 言语理解
  xuanci: '选词填空',
  yueduan: '片段阅读',
  yuju: '语句表达',
  wenzhang: '文章阅读',
  // 数量关系
  jisuan: '数学运算',
  tuili: '数字推理',
  // 判断推理
  tuxing: '图形推理',
  dingyi: '定义判断',
  leibi: '类比推理',
  luoji: '逻辑判断',
  // 资料分析
  wenzi: '文字资料',
  biaoge: '表格资料',
  tubiao: '图形资料',
  zonghe: '综合资料',
  zengzhang: '增长率',
  // 常识判断
  zhengzhi: '政治',
  jingji: '经济',
  falv: '法律',
  keji: '科技',
  renwen: '人文',
  dili: '地理',
  gongcheng: '工程问题',
  gaoshu: '高等数学', daishu: '线性代数', gaiilv: '概率论与数理统计',
  wanxing: '完形填空', yuedu: '阅读理解', fanyi: '翻译', xiezuo: '英语写作',
  makesi: '马克思主义基本原理', maogai: '毛中特', shixi: '思想道德与法治', shiju: '形势与政策', major: '专业课综合',
};

// 简约图标组件
const Icons = {
  yanyu: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
    </svg>
  ),
  shuliang: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
    </svg>
  ),
  panduan: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  ),
  ziliao: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
    </svg>
  ),
  changshi: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
    </svg>
  ),
  default: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/>
    </svg>
  ),
  arrow: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6"/>
    </svg>
  )
};

// 检查是否在 Electron 环境
const isElectron = () => window.openexam?.db;

// 页内 tab（内联样式，不改 styles.css）
const PRACTICE_TABS = [
  { key: 'subjects', label: '科目浏览' },
  { key: 'papers', label: '试卷与模拟考' },
  { key: 'history', label: '练习记录' },
];

const TAB_BAR_STYLE = {
  display: 'flex', gap: 4, margin: '0 0 16px', padding: 4,
  background: 'var(--surface-elevated)', border: '1px solid var(--line)', borderRadius: 10,
};

export default function PracticeModule({ onStartPractice, onImport, onHistory, onGoAIGenerate, initialTab = 'subjects', onOpenPaper, onReviewPaper, onOpenRecord, initialKeyword = '', focusToken = 0, focusSubject = null }) {
  const [activeTab, setActiveTab] = useState(initialTab);
  useEffect(() => { setActiveTab(initialTab); }, [initialTab]);
  const [expandedId, setExpandedId] = useState(null);
  const [modules, setModules] = useState([]);
  const [subCategories, setSubCategories] = useState({});
  const [loading, setLoading] = useState(true);
  const [showConfig, setShowConfig] = useState(false);
  const [practiceConfig, setPracticeConfig] = useState({
    questionCount: 10,
    mode: 'practice', // practice | memorize | mock
    shuffle: true,
    showAnswer: false,
    durationMinutes: 30,
  });

  // 重新分类：按上传批次重跑「科目/模块/章节/知识点」，避免全库重跑烧 token
  const [refreshKey, setRefreshKey] = useState(0);
  const [showReclassify, setShowReclassify] = useState(false);
  const [batches, setBatches] = useState([]);
  const [batchLoading, setBatchLoading] = useState(false);
  const [selectedBatchId, setSelectedBatchId] = useState('');
  const [onlyMissing, setOnlyMissing] = useState(true);
  const [reclassifying, setReclassifying] = useState(false);
  const [reclassifyProgress, setReclassifyProgress] = useState({ done: 0, total: 0 });
  const [reclassifyNotice, setReclassifyNotice] = useState('');
  // 细粒度重新分类：勾选题目
  const [reclassifyMode, setReclassifyMode] = useState('paper'); // 'paper' | 'questions'
  const [questionRows, setQuestionRows] = useState([]);
  const [questionLoading, setQuestionLoading] = useState(false);
  const [selectedQuestionIds, setSelectedQuestionIds] = useState([]);
  const reclassifyRequestRef = React.useRef('');
  const { alert: showAlert } = useDialog();

  // 我的科目 → 该科目下上传的题库文件，点进去直接看题
  const [subjectPapers, setSubjectPapers] = useState([]);
  const [expandedSubject, setExpandedSubject] = useState(null);
  // 从科目内进入时默认只看当前科目，仍可切回全部题库
  const [showAllPractice, setShowAllPractice] = useState(false);
  const scopedSubjectId = focusSubject?.id || '';
  useEffect(() => { setShowAllPractice(false); }, [scopedSubjectId]);
  const scopePractice = Boolean(scopedSubjectId) && !showAllPractice;
  const scopedModules = focusSubject?.categoryKey
    ? modules.filter((mod) => mod.id === focusSubject.categoryKey)
    : [];
  const visibleModules = scopePractice ? scopedModules : modules;
  const visibleSubjectPapers = scopePractice
    ? subjectPapers.filter((entry) => entry.id === scopedSubjectId)
    : subjectPapers;

  useEffect(() => {
    if (!scopedSubjectId || showAllPractice) return;
    if (subjectPapers.some((entry) => entry.id === scopedSubjectId)) setExpandedSubject(scopedSubjectId);
  }, [scopedSubjectId, showAllPractice, subjectPapers]);

  useEffect(() => {
    if (!isElectron() || activeTab !== 'subjects') return undefined;
    let cancelled = false;
    (async () => {
      try {
        const [subjects, papers] = await Promise.all([
          window.openexam.subject?.list?.() || Promise.resolve([]),
          window.openexam.db.getPapers(),
        ]);
        if (cancelled) return;
        const list = Array.isArray(subjects) ? subjects : [];
        const allPapers = Array.isArray(papers) ? papers : [];
        const rows = list.map((subject) => {
          const matched = allPapers.filter((paper) => {
            if (String(paper.subject_id || '') === String(subject.id)) return true;
            // 预置科目的历史题库没有 subject_id，按分类联动归属
            return Boolean(subject.categoryKey)
              && !paper.subject_id
              && (paper.subject === subject.categoryKey || paper.category === subject.categoryKey);
          });
          return {
            ...subject,
            papers: matched,
            questionCount: matched.reduce((sum, p) => sum + (Number(p.question_count) || 0), 0),
          };
        }).filter((row) => row.papers.length > 0);
        setSubjectPapers(rows);
      } catch (error) {
        console.error('加载科目题库失败:', error);
      }
    })();
    return () => { cancelled = true; };
  }, [activeTab, refreshKey]);

  // 加载数据
  useEffect(() => {
    const loadData = async () => {
      if (!isElectron()) {
        // 非 Electron 环境，显示所有默认分类
        const defaultModules = Object.entries(categoryConfig).map(([id, cfg]) => ({
          id,
          name: cfg.name,
          color: cfg.color,
          count: 0,
          done: 0
        }));
        setModules(defaultModules);
        setLoading(false);
        return;
      }

      try {
        // 获取分类统计
        const categoryStats = await window.openexam.db.getCategoryStats();

        // 合并默认分类和数据库统计，确保所有分类都显示
        const moduleData = Object.entries(categoryConfig).map(([id, cfg]) => {
          const dbStat = categoryStats.find(cat => cat.category === id);
          return {
            id,
            name: cfg.name,
            color: cfg.color,
            count: dbStat?.total || 0,
            done: dbStat?.done || 0,
            accuracy: dbStat?.accuracy || 0,
            incomplete: dbStat?.incomplete || 0,
            rawTotal: dbStat?.rawTotal || dbStat?.total || 0,
          };
        });

        // 自建科目（如「自动控制原理」）作为独立分类列出，不再混进「专业课」
        const customModules = (Array.isArray(categoryStats) ? categoryStats : [])
          .filter((cat) => cat?.isCustom)
          .map((cat, index) => ({
            id: cat.category,
            name: cat.label || '自建科目',
            color: ['#3f8fb0', '#c2685e', '#6f9c4a', '#b07cc6'][index % 4],
            count: cat.total || 0,
            done: cat.done || 0,
            accuracy: cat.accuracy || 0,
            incomplete: cat.incomplete || 0,
            rawTotal: cat.rawTotal || cat.total || 0,
            isCustom: true,
          }));

        setModules([...moduleData, ...customModules]);
      } catch (err) {
        console.error('加载数据失败:', err);
      }
      setLoading(false);
    };

    loadData();
  }, [refreshKey]);

  // 勾选模式：加载当前选中试卷的题目，供逐题勾选
  useEffect(() => {
    if (!showReclassify || reclassifyMode !== 'questions' || !selectedBatchId || !isElectron()) return;
    let cancelled = false;
    setQuestionLoading(true);
    (async () => {
      try {
        const rows = await window.openexam.db.getQuestions(selectedBatchId);
        if (!cancelled) {
          setQuestionRows(Array.isArray(rows) ? rows : []);
          setSelectedQuestionIds([]);
        }
      } catch (error) {
        if (!cancelled) setReclassifyNotice(`读取题目失败：${error?.message || error}`);
      } finally {
        if (!cancelled) setQuestionLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [showReclassify, reclassifyMode, selectedBatchId]);

  // 加载子分类
  const loadSubCategories = async (category) => {
    if (subCategories[category]) return;

    // 获取默认子分类
    const defaultSubs = defaultSubCategories[category] || [];

    if (!isElectron()) {
      // 非 Electron 环境，显示默认子分类
      const subs = defaultSubs.map(sub => ({ subCategory: sub, count: 0 }));
      setSubCategories(prev => ({ ...prev, [category]: subs }));
      return;
    }

    try {
      const dbSubs = await window.openexam.db.getSubCategoryStats(category);

      // 合并默认子分类和数据库统计
      const mergedSubs = defaultSubs.map(sub => {
        const dbSub = dbSubs.find(s => s.subCategory === sub);
        return { subCategory: sub, count: dbSub?.count || 0 };
      });

      // 添加数据库中有但默认列表没有的子分类
      dbSubs.forEach(dbSub => {
        if (!defaultSubs.includes(dbSub.subCategory) && dbSub.subCategory) {
          mergedSubs.push(dbSub);
        }
      });

      setSubCategories(prev => ({ ...prev, [category]: mergedSubs }));
    } catch (err) {
      console.error('加载子分类失败:', err);
    }
  };

  // 开始练习（直接开始）
  const handleStartPractice = (category, subCategory) => {
    onStartPractice?.(category, subCategory, practiceConfig);
  };

  // 打开配置弹窗
  const openConfig = () => {
    setShowConfig(true);
  };

  // 保存配置
  const saveConfig = () => {
    setShowConfig(false);
  };

  const handleExpand = (id) => {
    if (expandedId === id) {
      setExpandedId(null);
    } else {
      setExpandedId(id);
      loadSubCategories(id);
    }
  };

  const formatBatchDate = (value) => String(value || '').replace('T', ' ').slice(0, 16) || '未知时间';

  const openReclassify = async () => {
    setShowReclassify(true);
    setReclassifyNotice('');
    setReclassifyProgress({ done: 0, total: 0 });
    if (!isElectron()) return;
    setBatchLoading(true);
    try {
      const rows = await window.openexam.db.getReclassifyBatches();
      setBatches(Array.isArray(rows) ? rows : []);
      setSelectedBatchId((current) => current || rows?.[0]?.id || '');
    } catch (error) {
      setReclassifyNotice(`读取上传批次失败：${error?.message || error}`);
    } finally {
      setBatchLoading(false);
    }
  };

  const isQuestionMissing = (row) => {
    const chapter = String(row.chapter || '').trim();
    const tags = Array.isArray(row.tags) ? row.tags : String(row.tags || '').split(',').filter(Boolean);
    // 兜底章节不算已分类，否则「只补缺失」会把它们当成补全过而跳过
    const fallback = ['其他', '自拟', '未分类', '待分类', '未归类章节'];
    return !chapter || fallback.includes(chapter) || tags.length === 0;
  };

  const toggleQuestion = (id) => {
    setSelectedQuestionIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  const toggleAllQuestions = () => {
    setSelectedQuestionIds((current) => current.length === questionRows.length ? [] : questionRows.map((row) => String(row.id)));
  };

  // 整卷 / 勾选题目共用同一套进度监听、取消与回写刷新流程
  const runReclassify = async (invoke, total) => {
    if (reclassifying) return;
    if (!isRoleConfigured('assistant')) {
      await showAlert({ title: '需要先配置 AI', message: '重新分类要调用当前配置的模型，请先到「设置 → AI 模型」完成配置并测试连接。', tone: 'warning' });
      return;
    }
    const requestId = `reclassify_${Date.now()}`;
    reclassifyRequestRef.current = requestId;
    setReclassifying(true);
    setReclassifyNotice('');
    setReclassifyProgress({ done: 0, total: Number(total) || 0 });
    const off = window.openexam.ai?.onReclassifyProgress?.((payload) => {
      if (!payload || payload.requestId !== requestId) return;
      setReclassifyProgress({ done: Number(payload.done) || 0, total: Number(payload.total) || 0 });
    });
    try {
      const result = await invoke(requestId);
      if (result?.error) {
        setReclassifyNotice(result.error);
      } else if (!result?.total) {
        setReclassifyNotice('所选题目已经都有章节和知识点，没有需要重新分类的题目。');
      } else {
        setReclassifyNotice(`完成：写入 ${Number(result.changed || 0)} 道${result.skipped ? ` · 跳过 ${result.skipped} 道（无法判断）` : ''}${result.failed ? ` · ${result.failed} 个批次失败` : ''}${result.cancelled ? ' · 已中途停止' : ''}。`);
      }
      setRefreshKey((key) => key + 1);
      const rows = await window.openexam.db.getReclassifyBatches();
      setBatches(Array.isArray(rows) ? rows : []);
      if (reclassifyMode === 'questions' && selectedBatchId) {
        const fresh = await window.openexam.db.getQuestions(selectedBatchId);
        setQuestionRows(Array.isArray(fresh) ? fresh : []);
        setSelectedQuestionIds([]);
      }
    } catch (error) {
      setReclassifyNotice(`重新分类失败：${error?.message || error}`);
    } finally {
      off?.();
      reclassifyRequestRef.current = '';
      setReclassifying(false);
    }
  };

  const startReclassify = () => runReclassify(
    (requestId) => window.openexam.ai.reclassifyPaper(getRoleSettings('assistant'), selectedBatchId, { onlyMissing }, requestId),
    batches.find((batch) => batch.id === selectedBatchId)?.total || 0
  );

  const startReclassifySelected = () => {
    if (!selectedQuestionIds.length) return;
    return runReclassify(
      (requestId) => window.openexam.ai.reclassifyQuestions(getRoleSettings('assistant'), selectedQuestionIds, { onlyMissing }, requestId),
      selectedQuestionIds.length
    );
  };

  const stopReclassify = () => {
    const requestId = reclassifyRequestRef.current;
    if (requestId) window.openexam.ai?.cancelRecognition?.(requestId);
  };

  if (loading) {
    return <div className="practice-page"><div className="loading-state">加载中...</div></div>;
  }

  const totalCount = modules.reduce((sum, m) => sum + m.count, 0);

  return (
    <div className="practice-page">
      {/* 页内 tab：科目浏览 / 试卷与模拟考 / 练习记录 */}
      <div style={TAB_BAR_STYLE}>
        {PRACTICE_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            style={{
              flex: 1, height: 34, borderRadius: 7, border: 'none', cursor: 'pointer',
              fontSize: 13, fontWeight: 600,
              background: activeTab === tab.key ? 'var(--accent)' : 'transparent',
              color: activeTab === tab.key ? '#fff' : 'var(--muted)',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'subjects' && (
        <>
      {/* 顶部：只显示题量，不再堆一排总览数字；每个科目自己的题数 / 已写 / 正确率在下方列表里看 */}
      <div className="practice-summary">
        <div className="summary-item">
          <span className="summary-value">{totalCount.toLocaleString()}</span>
          <span className="summary-label">题库共多少题</span>
        </div>
        <div className="summary-actions">
          <button className="summary-btn outline" onClick={openConfig}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
            练习设置
          </button>
          <button className="summary-btn outline" onClick={() => setActiveTab('history')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            练习历史
          </button>
          <button className="summary-btn outline" onClick={openReclassify} title="按上传批次重跑科目/章节/知识点分类">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>
              <path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
            </svg>
            重新分类
          </button>
          <button className="summary-btn" onClick={() => onImport?.()}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            导入试卷
          </button>
        </div>
      </div>

      {focusSubject ? (
        <div className="practice-scope-note">
          <span>当前科目：<strong>{focusSubject.name}</strong>{scopePractice ? ' · 题库练习已按该科目筛选' : ' · 正在查看全部题库'}</span>
          <button type="button" className="practice-scope-link" onClick={() => setShowAllPractice((value) => !value)}>
            {showAllPractice ? '只看当前科目' : '查看全部题库'}
          </button>
        </div>
      ) : null}

      {visibleModules.some((mod) => mod.id === 'ziliao' && mod.incomplete > 0) && (
        <div className="practice-quality-notice" style={{
          margin: '0 0 12px',
          padding: '10px 12px',
          borderRadius: 10,
          border: '1px solid var(--warning-border)',
          background: 'var(--warning-soft)',
          color: 'var(--text)',
          fontSize: 12,
          lineHeight: 1.55,
        }}>
          资料分析有部分题目缺少原始图表/文字材料，专项练习已自动隐藏这些不完整题目
          {(() => {
            const ziliao = modules.find((mod) => mod.id === 'ziliao');
            return ziliao ? `（可练 ${ziliao.count} / 原 ${ziliao.rawTotal}）` : '';
          })()}
          。完整材料补齐后会自动恢复。
        </div>
      )}

      {/* 模块列表 */}
      <div className="practice-list">
        {visibleModules.length === 0 ? (
          scopePractice && visibleSubjectPapers.length > 0 ? null : (
            <div className="empty-state">
              <p>{scopePractice ? '当前科目暂无专项练习题目' : '暂无题目数据'}</p>
            </div>
          )
        ) : (
          visibleModules.map(mod => {
            const Icon = Icons[mod.id] || Icons.default;
            const isExpanded = expandedId === mod.id;
            const progress = mod.count > 0 ? Math.round(mod.done / mod.count * 100) : 0;
            const subs = subCategories[mod.id] || [];

            return (
              <div key={mod.id} className={`practice-item ${isExpanded ? 'expanded' : ''}`}>
                <div className="practice-item-main" onClick={() => handleExpand(mod.id)}>
                  <div className="practice-icon" style={{ color: mod.color }}>
                    <Icon />
                  </div>
                  <div className="practice-info">
                    <div className="practice-name">{mod.name}</div>
                    <div className="practice-meta">
                      <span>{mod.count.toLocaleString()} 题</span>
                      {mod.id === 'ziliao' && mod.incomplete > 0 ? (
                        <>
                          <span className="meta-dot">·</span>
                          <span style={{ color: 'var(--warning)' }}>已隐藏缺材料 {mod.incomplete}</span>
                        </>
                      ) : null}
                      <span className="meta-dot">·</span>
                      <span>已写 {mod.done}</span>
                      <span className="meta-dot">·</span>
                      <span style={{ color: mod.done > 0 ? 'var(--accent)' : undefined }}>正确率 {mod.accuracy}%</span>
                    </div>
                  </div>
                  <div className="practice-progress">
                    <div className="progress-bar-mini">
                      <div className="progress-fill-mini" style={{ width: `${progress}%`, background: mod.color }} />
                    </div>
                    <span className="progress-text">{progress}%</span>
                  </div>
                  <button
                    className="practice-start-btn"
                    onClick={(e) => { e.stopPropagation(); handleStartPractice(mod.id, 'all'); }}
                    disabled={mod.count === 0}
                  >
                    开始
                  </button>
                  <div className={`practice-arrow ${isExpanded ? 'rotated' : ''}`}>
                    <Icons.arrow />
                  </div>
                </div>

                {isExpanded && (
                  <div className="practice-subs">
                    {subs.map(sub => (
                      <button key={sub.subCategory} className="sub-item" onClick={() => handleStartPractice(mod.id, sub.subCategory)} disabled={sub.count === 0}>
                        <span className="sub-name">{subCategoryNames[sub.subCategory] || sub.subCategory || '未分类'}</span>
                        <span className="sub-count">{sub.count} 题</span>
                        <Icons.arrow />
                      </button>
                    ))}
                    <button className="sub-item primary" onClick={() => handleStartPractice(mod.id, 'all')} disabled={mod.count === 0}>
                      <span className="sub-name">全部练习</span>
                      <span className="sub-count">{mod.count} 题</span>
                      <Icons.arrow />
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* 我的科目 · 已上传题库：科目是独立分组，下面直接列题文件，点「看题」进试卷 */}
      {visibleSubjectPapers.length > 0 && (
        <div style={{ marginTop: 22 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, margin: '0 0 10px' }}>
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
              {scopePractice && focusSubject ? `${focusSubject.name} · 已上传题库` : '我的科目 · 已上传题库'}
            </h3>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>点开科目看该科目下的题文件，可直接看题</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {visibleSubjectPapers.map((entry) => {
              const open = expandedSubject === entry.id;
              return (
                <div key={entry.id} style={{ border: '1px solid var(--line)', borderRadius: 10, background: 'var(--surface-elevated)', overflow: 'hidden' }}>
                  <button
                    type="button"
                    onClick={() => setExpandedSubject(open ? null : entry.id)}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', color: 'var(--text)' }}
                  >
                    <span style={{ fontWeight: 700, fontSize: 13 }}>{entry.name}</span>
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>{entry.papers.length} 卷 / {entry.questionCount} 题</span>
                    <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 12 }}>{open ? '收起 ▴' : '展开 ▾'}</span>
                  </button>
                  {open && (
                    <div style={{ borderTop: '1px solid var(--line)', padding: '6px 12px 10px' }}>
                      {entry.papers.map((paper) => (
                        <div key={paper.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0' }}>
                          <span style={{ flex: 1, minWidth: 0, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{paper.title || '未命名试卷'}</span>
                          <span style={{ fontSize: 11, color: 'var(--muted)' }}>{Number(paper.question_count) || 0} 题</span>
                          <button
                            type="button"
                            className="summary-btn outline"
                            style={{ height: 26, padding: '0 10px', fontSize: 11 }}
                            onClick={() => onOpenPaper?.(paper.id)}
                          >
                            看题
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {scopePractice && visibleSubjectPapers.length === 0 ? (
        <div className="practice-scope-empty">
          当前科目还没有已上传的题库。可切到「资料」标签上传主教材，或在「查看全部题库」里浏览其他科目。
        </div>
      ) : null}
        </>
      )}

      {activeTab === 'papers' && (
        <PaperList
          embedded
          onOpenPaper={onOpenPaper}
          onReviewPaper={onReviewPaper}
          initialKeyword={initialKeyword}
          focusToken={focusToken}
          onGoAIGenerate={onGoAIGenerate}
        />
      )}

      {activeTab === 'history' && (
        <PracticeHistory
          onBack={() => setActiveTab('subjects')}
          onOpenRecord={onOpenRecord}
        />
      )}

      {/* 练习配置弹窗 */}
      {showConfig && (
        <div className="config-overlay" onClick={() => setShowConfig(false)}>
          <div className="config-modal" onClick={e => e.stopPropagation()}>
            <h3>练习设置</h3>

            <div className="config-group">
              <label>练习模式</label>
              <div className="config-options">
                <button
                  className={`config-option ${practiceConfig.mode === 'practice' ? 'active' : ''}`}
                  onClick={() => setPracticeConfig(prev => ({ ...prev, mode: 'practice', showAnswer: false }))}
                >
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                  <span className="option-label">做题模式</span>
                  <span className="option-desc">选择答案后显示对错</span>
                </button>
                <button
                  className={`config-option ${practiceConfig.mode === 'memorize' ? 'active' : ''}`}
                  onClick={() => setPracticeConfig(prev => ({ ...prev, mode: 'memorize', showAnswer: true }))}
                >
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
                    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
                  </svg>
                  <span className="option-label">背题模式</span>
                  <span className="option-desc">直接显示答案和解析</span>
                </button>
                <button
                  className={`config-option ${practiceConfig.mode === 'mock' ? 'active' : ''}`}
                  onClick={() => setPracticeConfig(prev => ({ ...prev, mode: 'mock', showAnswer: false }))}
                >
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                  </svg>
                  <span className="option-label">模考模式</span>
                  <span className="option-desc">倒计时交卷，隐藏解析</span>
                </button>
              </div>
            </div>

            {practiceConfig.mode === 'mock' && (
              <div className="config-group">
                <label>模考时长（分钟）</label>
                <div className="config-counts">
                  {[15, 30, 60, 90, 120].map(num => (
                    <button
                      key={num}
                      className={`count-btn ${practiceConfig.durationMinutes === num ? 'active' : ''}`}
                      onClick={() => setPracticeConfig(prev => ({ ...prev, durationMinutes: num }))}
                    >
                      {num}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="config-group">
              <label>每次练习题数</label>
              <div className="config-counts">
                {[5, 10, 15, 20, 30, 50].map(num => (
                  <button
                    key={num}
                    className={`count-btn ${practiceConfig.questionCount === num ? 'active' : ''}`}
                    onClick={() => setPracticeConfig(prev => ({ ...prev, questionCount: num }))}
                  >
                    {num}题
                  </button>
                ))}
              </div>
            </div>

            <div className="config-group">
              <label>其他设置</label>
              <div className="config-toggles">
                <label className="toggle-item">
                  <input
                    type="checkbox"
                    checked={practiceConfig.shuffle}
                    onChange={e => setPracticeConfig(prev => ({ ...prev, shuffle: e.target.checked }))}
                  />
                  <span>随机打乱题目顺序</span>
                </label>
              </div>
            </div>

            <div className="config-actions">
              <button className="btn-secondary" onClick={() => setShowConfig(false)}>取消</button>
              <button className="btn-primary" onClick={saveConfig}>保存设置</button>
            </div>
          </div>
        </div>
      )}

      {/* 重新分类弹窗：整卷（按上传批次）或勾选题目 */}
      {showReclassify && (
        <div className="config-overlay" onClick={() => { if (!reclassifying) setShowReclassify(false); }}>
          <div className="config-modal reclassify-modal" onClick={(event) => event.stopPropagation()}>
            <h3>重新分类题库</h3>

            <div style={{ display: 'flex', gap: 6, margin: '0 0 10px' }}>
              <button
                type="button"
                onClick={() => setReclassifyMode('paper')}
                disabled={reclassifying}
                style={{
                  flex: 1, height: 30, borderRadius: 7, cursor: 'pointer', fontSize: 12, fontWeight: 600,
                  border: '1px solid var(--line)',
                  background: reclassifyMode === 'paper' ? 'var(--accent)' : 'var(--surface-elevated)',
                  color: reclassifyMode === 'paper' ? '#fff' : 'var(--muted)',
                }}
              >整个题文件重新分类</button>
              <button
                type="button"
                onClick={() => setReclassifyMode('questions')}
                disabled={reclassifying}
                style={{
                  flex: 1, height: 30, borderRadius: 7, cursor: 'pointer', fontSize: 12, fontWeight: 600,
                  border: '1px solid var(--line)',
                  background: reclassifyMode === 'questions' ? 'var(--accent)' : 'var(--surface-elevated)',
                  color: reclassifyMode === 'questions' ? '#fff' : 'var(--muted)',
                }}
              >勾选题目重新分类</button>
            </div>

            <p className="reclassify-desc">
              {reclassifyMode === 'paper'
                ? '只重跑「科目 → 模块 → 章节 → 知识点」四级分类，不改题干和答案。选一个上传批次可以精确控制 token 消耗，重新分类后知识图谱会按新层级重排。'
                : '先选一份试卷，再勾选具体题目，只重跑这些题目的「科目 → 模块 → 章节 → 知识点」四级分类，不改题干和答案，最省 token。'}
            </p>

            <div className="reclassify-batches">
              {batchLoading && <div className="reclassify-empty">正在读取上传批次...</div>}
              {!batchLoading && batches.length === 0 && <div className="reclassify-empty">还没有可分类的题目，先去「导入试卷」上传一份吧。</div>}
              {!batchLoading && batches.map((batch) => {
                const active = selectedBatchId === batch.id;
                return (
                  <button
                    key={batch.id}
                    type="button"
                    className={`reclassify-batch ${active ? 'active' : ''}`}
                    onClick={() => setSelectedBatchId(batch.id)}
                    disabled={reclassifying}
                  >
                    <div className="reclassify-batch-main">
                      <span className="reclassify-batch-name">{batch.title}</span>
                      <span className="reclassify-batch-meta">{batch.total} 题 · {formatBatchDate(batch.createdAt)}</span>
                    </div>
                    <span className={`reclassify-batch-tag ${batch.pending > 0 ? 'is-pending' : ''}`}>
                      {batch.pending > 0 ? `待分类 ${batch.pending}` : '已分类'}
                    </span>
                  </button>
                );
              })}
            </div>

            {reclassifyMode === 'questions' && (
              <div style={{ margin: '10px 0', border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', background: 'var(--surface-elevated)', fontSize: 12 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--text)' }}>
                    <input type="checkbox" checked={questionRows.length > 0 && selectedQuestionIds.length === questionRows.length} onChange={toggleAllQuestions} disabled={reclassifying || !questionRows.length} />
                    全选
                  </label>
                  <span style={{ color: 'var(--muted)' }}>已选 {selectedQuestionIds.length} / {questionRows.length} 题</span>
                </div>
                <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                  {questionLoading && <div className="reclassify-empty">正在读取题目...</div>}
                  {!questionLoading && !selectedBatchId && <div className="reclassify-empty">请先在上方选择一份试卷。</div>}
                  {!questionLoading && selectedBatchId && questionRows.length === 0 && <div className="reclassify-empty">这份试卷暂无题目。</div>}
                  {!questionLoading && questionRows.map((row, index) => (
                    <label
                      key={row.id}
                      style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '7px 10px', borderTop: '1px solid var(--line)', cursor: 'pointer', fontSize: 12 }}
                    >
                      <input type="checkbox" checked={selectedQuestionIds.includes(String(row.id))} onChange={() => toggleQuestion(String(row.id))} disabled={reclassifying} />
                      <span style={{ flex: 1, color: 'var(--text)', lineHeight: 1.45 }}>
                        <span style={{ color: 'var(--muted)', marginRight: 6 }}>#{index + 1}</span>
                        {String(row.content || '').replace(/\s+/g, ' ').slice(0, 88) || '（无题干）'}
                      </span>
                      <span style={{ color: isQuestionMissing(row) ? 'var(--warning)' : 'var(--muted)', whiteSpace: 'nowrap' }}>
                        {isQuestionMissing(row) ? '待分类' : '已分类'}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <label className="import-check-row">
              <input type="checkbox" checked={onlyMissing} onChange={(event) => setOnlyMissing(event.target.checked)} disabled={reclassifying} />
              <span>只处理缺少章节/知识点的题（最省 token；取消勾选会覆盖已有分类）</span>
            </label>

            {(reclassifying || reclassifyProgress.total > 0) && (
              <div className="reclassify-progress">
                <div className="reclassify-progress-bar">
                  <div style={{ width: `${reclassifyProgress.total ? Math.round((reclassifyProgress.done / reclassifyProgress.total) * 100) : 0}%` }} />
                </div>
                <span>{reclassifyProgress.done} / {reclassifyProgress.total} 道</span>
              </div>
            )}

            {reclassifyNotice && <p className="reclassify-notice">{reclassifyNotice}</p>}

            <div className="config-actions">
              <button className="btn-secondary" onClick={() => setShowReclassify(false)} disabled={reclassifying}>
                {reclassifying ? '后台继续（关闭）' : '取消'}
              </button>
              {reclassifying ? (
                <button className="btn-primary" onClick={stopReclassify}>停止</button>
              ) : reclassifyMode === 'paper' ? (
                <button className="btn-primary" onClick={startReclassify} disabled={!selectedBatchId || batchLoading}>
                  开始重新分类
                </button>
              ) : (
                <button className="btn-primary" onClick={startReclassifySelected} disabled={!selectedQuestionIds.length || questionLoading}>
                  重新分类选中题目
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
