import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Today from "./pages/Today.jsx";
import Notes from "./pages/Notes.jsx";
import PracticeHistory from "./pages/PracticeHistory.jsx";
import ExamRoom from "./pages/ExamRoom.jsx";
import ExamResult from "./pages/ExamResult.jsx";
import ImportPaper from "./pages/ImportPaper.jsx";
import Subjects from "./pages/Subjects.jsx";
import Library from "./pages/Library.jsx";
import Settings from "./pages/Settings.jsx";
import AIHub from "./pages/AIHub.jsx";
import AIGenerate from "./pages/AIGenerate.jsx";
import WrongBook from "./pages/WrongBook.jsx";
import Analytics from "./pages/Analytics.jsx";
import GrowthCenter from "./pages/GrowthCenter.jsx";
import AchievementCenter from "./pages/AchievementCenter.jsx";
import OnboardingTour from "./components/OnboardingTour.jsx";
import ImportTaskDock from "./components/ImportTaskDock.jsx";
import { actions, getState } from "./store/examStore.js";
import { normalizeAISettings } from "./store/aiSettings.js";
import { initImportTasks } from "./store/importTasks.js";
import appLogo from "./assets/openexam-app-icon.png";
import { useDialog } from "./components/DialogProvider.jsx";

function PageView({ fullscreen = false, children, className = "" }) {
  return (
    <div className={`page-view${fullscreen ? " is-fullscreen" : ""}${className ? ` ${className}` : ""}`}>
      {children}
    </div>
  );
}

const DynamicChart = ({ data, onHover }) => {
  const containerRef = React.useRef(null);
  const [dims, setDims] = React.useState({ w: 600, h: 130 });
  const [animated, setAnimated] = React.useState(false);
  const [hoverIdx, setHoverIdx] = React.useState(null);

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    if (width > 0 && height > 0) setDims({ w: width, h: height });
    const ro = new ResizeObserver(entries => {
      const r = entries[0].contentRect;
      if (r.width > 0 && r.height > 0) setDims({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  React.useEffect(() => {
    setAnimated(false);
    const t = setTimeout(() => setAnimated(true), 80);
    return () => clearTimeout(t);
  }, [data, dims.w]);

  const W = dims.w, H = dims.h;
  const PAD_R = 8, PAD_T = 10, PAD_B = 8;
  const chartW = W - PAD_R;
  const chartH = H - PAD_T - PAD_B;

  const hasData = data && data.length > 0 && data.some(d => d.total > 0);

  if (!hasData) {
    const days = (data && data.length) ? data : Array.from({ length: 7 }, (_, i) => ({ total: 0, date: '' }));
    const baseline = PAD_T + chartH * 0.72;
    const pts = days.map((_, i) => ({
      x: days.length === 1 ? chartW / 2 : (i / (days.length - 1)) * chartW,
      y: baseline,
    }));
    const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    return (
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }}>
        <svg width={W || 600} height={H || 130} viewBox={`0 0 ${W || 600} ${H || 130}`} style={{ display: 'block' }}>
          {[0.25, 0.5, 0.75].map((t, i) => {
            const y = PAD_T + chartH * (1 - t);
            return <line key={i} x1="0" y1={y} x2={W || 600} y2={y} stroke="currentColor" strokeOpacity="0.06" strokeWidth="1" />;
          })}
          <path d={line} fill="none" stroke="var(--accent)" strokeOpacity="0.22" strokeWidth="2" strokeDasharray="5 6" strokeLinecap="round" />
          {pts.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r="3" fill="var(--surface)" stroke="var(--accent)" strokeOpacity="0.28" strokeWidth="1.5" />
          ))}
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, pointerEvents: 'none' }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', opacity: 0.72 }}>暂无刷题数据</span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>开始练习后这里会显示 7 日趋势</span>
        </div>
      </div>
    );
  }

  const maxVal = Math.max(...data.map(d => d.total), 1);

  const pts = data.map((d, i) => ({
    x: data.length === 1 ? chartW / 2 : (i / (data.length - 1)) * chartW,
    y: PAD_T + chartH * (1 - d.total / maxVal),
    ...d
  }));

  const toPath = (points) => points.map((p, i) => {
    if (i === 0) return `M${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    const prev = points[i - 1];
    const cpx = ((prev.x + p.x) / 2).toFixed(1);
    return `C${cpx},${prev.y.toFixed(1)} ${cpx},${p.y.toFixed(1)} ${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  }).join(' ');

  const linePath = toPath(pts);
  const bottomY = (PAD_T + chartH).toFixed(1);
  const areaPath = `${linePath} L${pts[pts.length - 1].x.toFixed(1)},${bottomY} L${pts[0].x.toFixed(1)},${bottomY} Z`;
  const pathLen = W * 2;
  const gridYs = [0.25, 0.5, 0.75].map(t => PAD_T + chartH * (1 - t));
  const activeIdx = hoverIdx !== null ? hoverIdx : pts.length - 1;

  return (
    <div ref={containerRef} style={{ position: 'absolute', inset: 0 }}
      onMouseLeave={() => { setHoverIdx(null); onHover?.(null); }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
        <defs>
          <linearGradient id="dcLine" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.72"/>
            <stop offset="100%" stopColor="var(--accent-strong)" stopOpacity="0.98"/>
          </linearGradient>
          <linearGradient id="dcArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.14"/>
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0"/>
          </linearGradient>
        </defs>

        {/* 网格线 */}
        {gridYs.map((y, i) => (
          <line key={i} x1="0" y1={y.toFixed(1)} x2={W} y2={y.toFixed(1)}
            stroke="currentColor" strokeOpacity="0.07" strokeWidth="1"/>
        ))}
        <line x1="0" y1={bottomY} x2={W} y2={bottomY}
          stroke="currentColor" strokeOpacity="0.1" strokeWidth="1"/>

        {/* 面积 */}
        <path d={areaPath} fill="url(#dcArea)"/>

        {/* 折线动画 */}
        <path d={linePath} fill="none" stroke="url(#dcLine)"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          strokeDasharray={`${pathLen} ${pathLen}`}
          strokeDashoffset={animated ? 0 : pathLen}
          style={{ transition: animated ? 'stroke-dashoffset 1s cubic-bezier(0.4,0,0.2,1)' : 'none' }}
        />

        {/* 活跃竖虚线 */}
        {pts[activeIdx] && (
          <line x1={pts[activeIdx].x.toFixed(1)} y1={PAD_T}
            x2={pts[activeIdx].x.toFixed(1)} y2={bottomY}
            stroke="var(--accent)" strokeWidth="1" strokeDasharray="3,3" opacity="0.28"/>
        )}

        {/* hover 触发热区 */}
        {pts.map((p, i) => {
          const prevX = i > 0 ? (pts[i-1].x + p.x) / 2 : 0;
          const nextX = i < pts.length - 1 ? (pts[i+1].x + p.x) / 2 : W;
          return (
            <rect key={i} x={prevX} y={0} width={nextX - prevX} height={H}
              fill="transparent" style={{ cursor: 'pointer' }}
              onMouseEnter={() => { setHoverIdx(i); onHover?.(p); }}/>
          );
        })}
      </svg>

      {/* 正圆数据点 — 用 div 避免 SVG 变形 */}
      {animated && pts.map((p, i) => {
        const active = i === activeIdx;
        return (
          <div key={i} style={{
            position: 'absolute', pointerEvents: 'none',
            left: p.x, top: p.y,
            transform: 'translate(-50%, -50%)',
            width: active ? 10 : 6, height: active ? 10 : 6,
            borderRadius: '50%',
            background: active ? 'var(--surface-elevated)' : 'var(--accent)',
            border: active ? '2.5px solid var(--accent)' : 'none',
            boxShadow: active ? '0 0 0 3px var(--accent-soft-bg-strong), 0 4px 10px rgba(15,23,42,0.16)' : 'none',
            transition: 'all 0.15s ease',
          }}/>
        );
      })}
    </div>
  );
};


function App() {
  return <AppMain />;
}

export default App;

function AppMain() {
  const ONBOARDING_STORAGE_KEY = "openexam_onboarding_done_v1";
  const [theme, setTheme] = useState("light");
  const [page, setPageRaw] = useState("today");
  // 后台导入完成时用它判断用户是否还停留在导入页，避免打断其它界面
  const pageRef = useRef(page);
  const [currentPaperId, setCurrentPaperId] = useState(null);
  const [examResult, setExamResult] = useState(null);
  const [resultReturnPage, setResultReturnPage] = useState("practice");
  const [activeTab, setActiveTab] = useState("今日");
  const [practiceQuestions, setPracticeQuestions] = useState(null); // 专项练习题目
  const [practiceConfig, setPracticeConfig] = useState(null); // 练习配置
  const [examResumeRecord, setExamResumeRecord] = useState(null);
  const [paperSearchKeyword, setPaperSearchKeyword] = useState("");
  const [paperSearchFocusToken, setPaperSearchFocusToken] = useState(0);
  // 题库练习默认落在「科目浏览」；从顶部搜索进入时直接展开「试卷与模拟考」
  const [practiceView, setPracticeView] = useState("subjects");
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  const [assistantSubjectId, setAssistantSubjectId] = useState("");
  const [materialsSubjectId, setMaterialsSubjectId] = useState("");
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingClosing, setOnboardingClosing] = useState(false);
  const [appRevealActive, setAppRevealActive] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [profile, setProfile] = useState({ name: "考生用户", avatar: "" });
  const [settingsSection, setSettingsSection] = useState("ai");
  const userMenuRef = useRef(null);
  const onboardingCloseTimerRef = useRef(null);
  const appRevealTimerRef = useRef(null);
  const updatePromptedVersionRef = useRef("");
  const displayName = String(profile?.name || "考生用户").trim() || "考生用户";
  const avatarLetter = Array.from(displayName)[0] || "考";
  const { alert: showAlert, confirm: showConfirm } = useDialog();

  // 导入任务在常驻页面里继续跑，切到别的界面不再中断识别
  const setPage = (nextPage) => {
    pageRef.current = nextPage;
    setPageRaw(nextPage);
  };

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    if (window.openexam?.setTheme) {
      window.openexam.setTheme(theme);
    }
  }, [theme]);

  // 上传记录在任何页面都要能读到，包括全屏考试页
  useEffect(() => { initImportTasks(); }, []);

  useEffect(() => {
    const syncAISettingsFromSQLite = async () => {
      try {
        if (!window.openexam?.db?.getAISettings) return;
        const sqliteSettings = await window.openexam.db.getAISettings();
        if (sqliteSettings && typeof sqliteSettings === "object") {
          localStorage.setItem("openexam_settings", JSON.stringify(normalizeAISettings(sqliteSettings)));
        }
      } catch (error) {
        console.error("同步 AI 配置失败:", error);
      }
    };
    syncAISettingsFromSQLite();
  }, []);

  useEffect(() => {
    let mounted = true;

    const loadProfile = async () => {
      try {
        if (!window.openexam?.app?.getProfile) return;
        const result = await window.openexam.app.getProfile();
        if (mounted && result && typeof result === "object") {
          setProfile({
            name: String(result.name || "考生用户") || "考生用户",
            avatar: typeof result.avatar === "string" ? result.avatar : "",
          });
        }
      } catch (error) {
        console.error("读取用户信息失败:", error);
      }
    };

    loadProfile();

    try {
      const done = localStorage.getItem(ONBOARDING_STORAGE_KEY) === "1";
      if (!done) setShowOnboarding(true);
    } catch (error) {
      setShowOnboarding(true);
    }

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const handlePointerDown = (event) => {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target)) {
        setUserMenuOpen(false);
      }
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setUserMenuOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!window.openexam?.app?.onUpdateState) return undefined;
    const dispose = window.openexam.app.onUpdateState(async (payload) => {
      if (!payload || payload.status !== 'downloaded' || !payload.canAutoInstall) return;
      const version = String(payload.latestVersion || 'downloaded');
      if (updatePromptedVersionRef.current === version) return;
      updatePromptedVersionRef.current = version;
      const confirmed = await showConfirm({
        title: '更新已就绪',
        message: `StudyStudio ${payload.latestVersion || ''} 已下载完成，是否现在重启安装？`.trim(),
        confirmText: '立即安装',
        cancelText: '稍后',
        tone: 'success',
      });
      if (confirmed && window.openexam?.app?.quitAndInstallUpdate) {
        await window.openexam.app.quitAndInstallUpdate();
      }
    });
    return () => dispose?.();
  }, [showConfirm]);

  useEffect(() => {
    setUserMenuOpen(false);
  }, [page]);

  useEffect(() => () => {
    if (onboardingCloseTimerRef.current) window.clearTimeout(onboardingCloseTimerRef.current);
    if (appRevealTimerRef.current) window.clearTimeout(appRevealTimerRef.current);
  }, []);

  const finishOnboarding = async (payload = {}) => {
    if (onboardingClosing) return;
    const nextName = String(payload?.name || displayName).trim() || "考生用户";

    setProfile((prev) => ({ ...prev, name: nextName }));

    try {
      localStorage.setItem(ONBOARDING_STORAGE_KEY, "1");
    } catch (error) {
      // ignore storage failures
    }

    if (onboardingCloseTimerRef.current) window.clearTimeout(onboardingCloseTimerRef.current);
    if (appRevealTimerRef.current) window.clearTimeout(appRevealTimerRef.current);

    setOnboardingClosing(true);
    setAppRevealActive(true);

    onboardingCloseTimerRef.current = window.setTimeout(() => {
      setShowOnboarding(false);
      setOnboardingClosing(false);
    }, 420);

    appRevealTimerRef.current = window.setTimeout(() => {
      setAppRevealActive(false);
    }, 720);

    try {
      if (window.openexam?.app?.saveProfile) {
        const result = await window.openexam.app.saveProfile({ name: nextName, avatar: profile.avatar });
        if (result?.profile) {
          setProfile(result.profile);
        }
      }
    } catch (error) {
      console.error("保存用户信息失败:", error);
    }
  };

  const handleProfileSaved = (next) => {
    if (!next || typeof next !== "object") return;
    setProfile((prev) => ({ ...prev, ...next }));
  };

  const handleOnboardingNavigate = ({ page: targetPage, tab }) => {    if (tab !== undefined) setActiveTab(tab);
    if (targetPage) setPage(targetPage);
  };

  const onboarding = (
    <OnboardingTour
      open={showOnboarding}
      closing={onboardingClosing}
      onFinish={() => finishOnboarding({ name: displayName })}
      onSkip={() => finishOnboarding({ name: displayName })}
      onNavigate={handleOnboardingNavigate}
    />
  );

  const appStageClassName = [
    "app-stage",
    showOnboarding && !onboardingClosing ? "is-covered" : "",
    appRevealActive ? "is-revealing" : "",
  ].filter(Boolean).join(" ");

  const getReturnTab = (targetPage) => ({
    practice: "题库练习",
    "ai-generate": "AI出卷",
    "wrong-book": "",
    home: "学习中心",
  }[targetPage] || "今日");

  const hasAnyAnswer = (record) => {
    if (!record?.answers || typeof record.answers !== 'object') return false;
    return Object.values(record.answers).some((value) => {
      if (Array.isArray(value)) return value.length > 0;
      if (value && typeof value === 'object') {
        const raw = value.userAnswer ?? value.answer ?? '';
        return String(raw).trim().length > 0;
      }
      return String(value || '').trim().length > 0;
    });
  };

  const findResumableRecord = async (paperId) => {
    if (!paperId || !window.openexam?.db?.getPracticeRecords) return null;
    const records = await window.openexam.db.getPracticeRecords();
    return (records || []).find((record) => (
      record?.paper_id === paperId &&
      ['ongoing', 'paused'].includes(String(record?.status || '').toLowerCase()) &&
      hasAnyAnswer(record)
    )) || null;
  };

  const archiveRecord = async (record) => {
    if (!record?.id || !window.openexam?.db?.savePracticeRecord) return;
    await window.openexam.db.savePracticeRecord({
      id: record.id,
      paperId: record.paper_id || record.paperId || null,
      category: record.category || null,
      subCategory: record.sub_category || record.subCategory || null,
      startTime: record.start_time || record.startTime || new Date().toISOString(),
      endTime: new Date().toISOString(),
      duration: Number(record.duration || 0),
      status: 'abandoned',
      answers: record.answers || {},
      correctCount: Number(record.correct_count || record.correctCount || 0),
      totalCount: Number(record.total_count || record.totalCount || 0),
      accuracy: Number(record.accuracy || 0),
      score: Number(record.score || 0),
      meta: record.meta || null,
    });
  };

  const buildPracticeSessionKey = (category, subCategory = 'all') => `practice_${category}__${subCategory || 'all'}`;

  const writeAIContext = (question, extra = {}) => {
    if (!question) return;
    try {
      localStorage.setItem('openexam_question_context', JSON.stringify({
        questionId: question.id || question.question_id || '',
        paperTitle: extra.paperTitle || '',
        index: extra.index || '?',
        total: extra.total || '?',
        category: question.category || '',
        subCategory: question.sub_category || question.subCategory || '',
        content: question.content || '',
        options: Array.isArray(question.options) ? question.options : [],
        answer: question.answer || question.correct_answer || '',
        analysis: question.analysis || '',
        userAnswer: extra.userAnswer || question.user_answer || '',
        updatedAt: new Date().toISOString(),
      }));
      localStorage.setItem('openexam_ai_autofill', JSON.stringify({
        prompt: extra.prompt || '请讲解这道题：拆解考点、说明为什么选这个答案、再给一个类似练习。',
        at: Date.now(),
      }));
    } catch (error) {
      console.error('写入 AI 上下文失败:', error);
    }
  };

  const goAskAI = (question, extra = {}) => {
    writeAIContext(question, extra);
    setActiveTab('');
    setAiTab('teacher');
    setPage('ai-teacher');
  };

  const handleStartExam = async (paperId, options = {}) => {
    await actions.startExam(paperId);
    setExamResumeRecord(options.resumeRecord || null);
    setCurrentPaperId(paperId);
    setPracticeConfig(options.mock ? {
      mode: 'mock',
      title: options.title || '整卷练习',
      sourcePaperId: paperId,
      durationMinutes: Number(options.durationMinutes || 120),
    } : { sourcePaperId: paperId, title: options.title || '' });
    setResultReturnPage(options.returnPage || "practice");
    setPage("exam");
  };

  // 看题模式：只读浏览题干、答案与解析，不计时、不交卷、不要求做完
  const handleOpenReview = async (paperId, title = '') => {
    const id = String(paperId || '').trim();
    if (!id) return;
    try {
      const ok = await actions.startExam(id);
      if (ok === false) {
        await showAlert({ title: '无法打开试卷', message: '这份试卷已不存在或没有题目。', tone: 'warning' });
        return;
      }
    } catch (err) {
      await showAlert({ title: '无法打开试卷', message: err?.message || '读取题目失败。', tone: 'danger' });
      return;
    }
    setActiveTab('题库练习');
    setExamResumeRecord(null);
    setCurrentPaperId(id);
    setPracticeConfig({ mode: 'review', title: title || '看题', sourcePaperId: id });
    setResultReturnPage('practice');
    setPage('exam');
  };

  // 后台任务入库完成：仍停留在导入页就直接打开看题；切走了只留在上传记录里
  const handleImportComplete = (payload = {}) => {
    setActiveTab('题库练习');
    const paperId = String(payload?.paperId || '').trim();
    if (!paperId || pageRef.current !== 'import') return;
    handleOpenReview(paperId, payload?.title || payload?.fileName || '导入试卷');
  };

  const handleStartSavedPractice = async (paperId, paperTitle, returnPage = "practice", resumeRecord = null) => {
    if (!window.openexam?.db?.getQuestions) {
      await showAlert({ title: '无法开始练习', message: '数据库未连接，请稍后重试。', tone: 'warning' });
      return;
    }

    try {
      const questions = await window.openexam.db.getQuestions(paperId);
      if (!questions.length) {
        await showAlert({ title: '暂无题目', message: '这份自定义练习还没有可用题目。', tone: 'info' });
        return;
      }
      setPracticeQuestions(questions);
      setPracticeConfig({ mode: 'practice', title: paperTitle || 'AI 自定义练习', sourcePaperId: paperId });
      setExamResumeRecord(resumeRecord || null);
      setResultReturnPage(returnPage);
      setPage("practice-exam");
    } catch (err) {
      console.error('加载练习失败:', err);
      await showAlert({ title: '加载练习失败', message: '未能读取这份练习，请稍后再试。', tone: 'danger' });
    }
  };

  const handleOpenPaper = async (paper, returnPage = "practice") => {
    const target = paper && typeof paper === 'object' ? paper : { id: paper };
    if (!target?.id) return;
    let resumeRecord = target.resumeRecord || null;
    if (!resumeRecord) {
      try { resumeRecord = await findResumableRecord(target.id); } catch (error) { console.error('加载继续记录失败:', error); }
    }
    if (resumeRecord && !target.mock) {
      const answeredCount = Object.keys(resumeRecord.answers || {}).length;
      const continueResume = await showConfirm({
        title: '检测到未完成作答',
        message: `这套题有 ${answeredCount} 题已作答，是否继续上次进度？`,
        confirmText: '继续作答',
        cancelText: '重新开始',
        tone: 'info',
      });
      if (!continueResume) {
        try { await archiveRecord(resumeRecord); } catch (error) { console.error('更新旧记录状态失败:', error); }
        resumeRecord = null;
      }
    }
    if (target.type === 'ai_practice') {
      await handleStartSavedPractice(target.id, target.title, returnPage, resumeRecord);
      return;
    }
    await handleStartExam(target.id, {
      returnPage,
      resumeRecord: target.mock ? null : resumeRecord,
      mock: Boolean(target.mock),
      title: target.title,
      durationMinutes: Number(target.duration || 120),
    });
  };

  const handleFinishExam = (result) => {
    // 每日一练的完成状态由 practice_records 同步（见 savePracticeRecord），
    // 待自评的练习不能在这里直接标完成。
    setExamResumeRecord(null);
    setExamResult(result);
    setPage("result");
  };

  // 开始专项练习
  const handleStartPractice = async (category, subCategory, config) => {
    if (!window.openexam?.db) {
      await showAlert({ title: '无法开始练习', message: '数据库未连接，请稍后重试。', tone: 'warning' });
      return;
    }

    const sessionKey = buildPracticeSessionKey(category, subCategory || 'all');
    let resumeRecord = null;
    try { resumeRecord = await findResumableRecord(sessionKey); } catch (error) { console.error(error); }
    if (resumeRecord) {
      const answeredCount = Object.keys(resumeRecord.answers || {}).length;
      const continueResume = await showConfirm({
        title: '检测到未完成专项练习',
        message: `该专项有 ${answeredCount} 题已作答，是否继续上次进度？`,
        confirmText: '继续作答',
        cancelText: '重新开始',
        tone: 'info',
      });
      if (!continueResume) {
        try { await archiveRecord(resumeRecord); } catch (error) { console.error(error); }
        resumeRecord = null;
      }
    }

    try {
      let questions = [];
      if (resumeRecord?.meta?.questions?.length) {
        questions = resumeRecord.meta.questions;
      } else if (resumeRecord?.meta?.questionIds?.length && window.openexam.db.getQuestionsByIds) {
        questions = await window.openexam.db.getQuestionsByIds(resumeRecord.meta.questionIds);
      } else {
        questions = await window.openexam.db.getQuestionsByCategory(
          category,
          subCategory,
          config?.questionCount || 10,
          config?.shuffle !== false
        );
      }

      if (!questions.length) {
        await showAlert({ title: '暂无题目', message: '当前筛选分类下还没有题目。', tone: 'info' });
        return;
      }

      const mode = config?.mode || 'practice';
      const titlePrefix = mode === 'mock' ? '模考' : (mode === 'memorize' ? '背题' : '专项');
      setPracticeQuestions(questions);
      setPracticeConfig({
        ...config,
        mode,
        category,
        subCategory,
        sourcePaperId: sessionKey,
        title: config?.title || `${titlePrefix} · ${category}`,
        durationMinutes: Number(config?.durationMinutes || Math.max(10, Math.ceil(questions.length * 1.2))),
      });
      setExamResumeRecord(resumeRecord);
      setResultReturnPage("practice");
      setPage("practice-exam");
    } catch (err) {
      console.error('加载题目失败:', err);
      await showAlert({ title: '加载题目失败', message: '题目读取异常，请稍后重试。', tone: 'danger' });
    }
  };

  // 知识图谱底层节点 → 该知识点下的题目，直接进练习
  const handleStartKnowledgePractice = async (node) => {
    if (!node?.category) {
      await showAlert({ title: '无法定位题目', message: '这个节点没有关联到具体科目。', tone: 'warning' });
      return;
    }
    if (!window.openexam?.db?.getQuestionsByKnowledge) {
      await showAlert({ title: '无法开始练习', message: '数据库未连接，请稍后重试。', tone: 'warning' });
      return;
    }
    try {
      const questions = await window.openexam.db.getQuestionsByKnowledge({
        category: node.category,
        subCategory: node.subCategory || '',
        chapter: node.chapter || '',
        point: node.point || '',
        limit: 120,
      });
      if (!questions.length) {
        await showAlert({ title: '暂无题目', message: `「${node.label}」下还没有可练习的题目。`, tone: 'info' });
        return;
      }
      const scope = [node.chapter, node.point].filter(Boolean).join(' · ') || node.label || node.category;
      setPracticeQuestions(questions);
      setPracticeConfig({
        mode: 'practice',
        category: node.category,
        subCategory: node.subCategory || 'all',
        sourcePaperId: `kg_${String(node.id || node.label || 'node').replace(/[^\w:-]/g, '_')}`.slice(0, 120),
        title: `知识点练习 · ${scope}`,
        questionCount: questions.length,
        shuffle: false,
        durationMinutes: Math.max(10, Math.ceil(questions.length * 1.2)),
      });
      setExamResumeRecord(null);
      setResultReturnPage('home');
      setPage('practice-exam');
    } catch (err) {
      console.error('按知识点取题失败:', err);
      await showAlert({ title: '加载题目失败', message: '题目读取异常，请稍后重试。', tone: 'danger' });
    }
  };

  const handleStartWrongRedo = async (questions, meta = {}) => {
    if (!Array.isArray(questions) || questions.length === 0) {
      await showAlert({ title: '暂无可重做题目', message: '当前筛选下没有可重做的错题。', tone: 'info' });
      return;
    }
    setPracticeQuestions(questions);
    setPracticeConfig({
      mode: 'wrong-redo',
      title: meta.title || `错题重做（${questions.length}题）`,
      category: 'wrong-book',
      sourcePaperId: `wrong_redo_${meta.filter || 'all'}`,
      filter: meta.filter || 'all',
    });
    setExamResumeRecord(null);
    setResultReturnPage(meta.returnPage || "wrong-book");
    setPage("practice-exam");
  };

  // 今日复习队列 → 按科目分组直接进入错题重做
  const handleStartTodayReview = async (items, group = {}) => {
    const rows = Array.isArray(items) ? items : [];
    const seen = new Set();
    const questions = rows.map((item, index) => {
      const questionId = String(item.question_id || item.id || `today_review_${index}`);
      if (seen.has(questionId)) return null;
      seen.add(questionId);
      return {
        id: questionId,
        type: item.type || 'single',
        category: item.category || '',
        sub_category: item.sub_category || '',
        content: item.content || '',
        content_html: item.content_html || '',
        options: Array.isArray(item.options) ? item.options : [],
        answer: item.answer || item.correct_answer || '',
        analysis: item.analysis || '',
        analysis_html: item.analysis_html || '',
        paper_id: item.paper_id || null,
      };
    }).filter((item) => item && item.content && item.answer && item.options.length > 0);

    if (!questions.length) {
      await showAlert({
        title: '暂无可重做题目',
        message: '这组到期复习里是图片题或缺少选项的题，请到错题本里对照复习。',
        tone: 'info',
      });
      return;
    }
    await handleStartWrongRedo(questions, {
      filter: 'today-due',
      returnPage: 'today',
      title: `今日复习 · ${group.label || '错题'}`,
    });
  };

  // 每日一练：当天固定题组，若已有未完成记录则直接续做
  const handleStartDailyPractice = async (category) => {
    if (!window.openexam?.dailyPractice?.ensure || !window.openexam?.db?.getQuestionsByIds) {
      await showAlert({ title: '无法开始', message: '数据库未连接，请稍后重试。', tone: 'warning' });
      return;
    }
    try {
      const data = await window.openexam.dailyPractice.ensure({ category });
      if (String(data?.record?.status || '').toLowerCase() === 'awaiting_review') {
        await handleOpenPracticeRecord(data.record, 'today');
        return;
      }
      const set = data?.set;
      const ids = Array.isArray(set?.questionIds) ? set.questionIds : [];
      if (!ids.length) {
        await showAlert({ title: '暂无题目', message: '今天的每日一练还没有可用题目。', tone: 'info' });
        return;
      }
      const loaded = await window.openexam.db.getQuestionsByIds(ids);
      const byId = new Map((loaded || []).map((q) => [q.id, q]));
      const questions = ids.map((id) => byId.get(id)).filter(Boolean);
      if (!questions.length) {
        await showAlert({ title: '题目已失效', message: '今天的题目已不可用，请明天再试。', tone: 'warning' });
        return;
      }
      const sessionKey = set.sessionKey || `daily_${set.date}`;
      let resumeRecord = null;
      try { resumeRecord = await findResumableRecord(sessionKey); } catch (error) { console.error('加载每日一练进度失败:', error); }
      setPracticeQuestions(questions);
      setPracticeConfig({
        mode: 'daily',
        title: `每日一练 · ${set.categoryLabel || '今日'}`,
        category: set.category,
        sourcePaperId: sessionKey,
        dailyDate: set.date,
        questionCount: questions.length,
        durationMinutes: Math.max(10, Math.ceil(questions.length * 1.5)),
      });
      setExamResumeRecord(resumeRecord);
      setResultReturnPage('today');
      setPage('practice-exam');
    } catch (error) {
      console.error('开始每日一练失败:', error);
      await showAlert({ title: '无法开始每日一练', message: error?.message || '题目读取异常，请稍后重试。', tone: 'danger' });
    }
  };

  const handleOpenPracticeRecord = async (record, returnPage = 'history') => {
    if (!record) return;
    const status = String(record.status || '').toLowerCase();
    const meta = record.meta || {};
    if (['ongoing', 'paused'].includes(status)) {
      if (record.paper_id && !String(record.paper_id).startsWith('practice_') && !String(record.paper_id).startsWith('wrong_redo_')) {
        await handleOpenPaper({ id: record.paper_id, title: record.paper_title, type: meta.mode === 'ai_practice' ? 'ai_practice' : undefined, resumeRecord: record }, returnPage);
        return;
      }
      let questions = meta.questions || [];
      if (!questions.length && meta.questionIds?.length && window.openexam?.db?.getQuestionsByIds) {
        questions = await window.openexam.db.getQuestionsByIds(meta.questionIds);
      }
      if (!questions.length && record.paper_id && window.openexam?.db?.getQuestions) {
        questions = await window.openexam.db.getQuestions(record.paper_id);
      }
      if (!questions.length) {
        await showAlert({ title: '无法继续', message: '未找到该次练习的题目快照。', tone: 'warning' });
        return;
      }
      setPracticeQuestions(questions);
      setPracticeConfig({
        mode: meta.mode || 'practice',
        title: meta.title || record.paper_title || '继续练习',
        category: record.category || null,
        subCategory: record.sub_category || null,
        sourcePaperId: record.paper_id || buildPracticeSessionKey(record.category || 'mixed', record.sub_category || 'all'),
        durationMinutes: meta.durationMinutes,
      });
      setExamResumeRecord(record);
      setResultReturnPage(returnPage);
      setPage('practice-exam');
      return;
    }

    // completed / awaiting_review -> 结果页（awaiting_review 继续完成自评）
    let questions = meta.questions || [];
    if (!questions.length && meta.questionIds?.length && window.openexam?.db?.getQuestionsByIds) {
      questions = await window.openexam.db.getQuestionsByIds(meta.questionIds);
    }
    if (!questions.length && record.paper_id && window.openexam?.db?.getQuestions) {
      questions = await window.openexam.db.getQuestions(record.paper_id);
    }
    setExamResult({
      totalCount: Number(record.total_count || questions.length || 0),
      correctCount: Number(record.correct_count || 0),
      wrongCount: Math.max(0, Number(record.total_count || 0) - Number(record.correct_count || 0)),
      unanswered: 0,
      accuracy: Number(record.accuracy || 0),
      status,
      timeElapsed: Number(record.duration || 0),
      answers: record.answers || {},
      verdicts: meta.verdicts || {},
      questions,
      recordId: record.id,
      config: {
        title: meta.title || record.paper_title || '历史练习',
        category: record.category,
        mode: meta.mode,
        sourcePaperId: record.paper_id,
        dailyDate: String(record.paper_id || '').startsWith('daily_') ? String(record.paper_id).slice(6) : undefined,
      },
      paperTitle: meta.title || record.paper_title || '历史练习',
    });
    setResultReturnPage(returnPage);
    setPage('result');
  };

  // 每日一练提交后还有主观题没自评：从今日页直接回到结果页继续自评
  const handleOpenDailyReview = (record) => handleOpenPracticeRecord(record, 'today');

  const handleRedoWrongFromResult = (result) => {
    const questions = result?.questions || [];
    const answers = result?.answers || {};
    const verdicts = result?.verdicts || result?.subjectiveVerdicts || {};
    const wrong = questions.filter((q) => {
      // 结果页里手动判过对错的（主观题、纸上作答的选择题等）以自评为准
      if (verdicts[q.id]) return verdicts[q.id] === 'wrong';
      const ua = answers[q.id];
      if (ua == null || ua === '') return false;
      const uaText = Array.isArray(ua) ? ua.join(',') : String(ua);
      const caText = Array.isArray(q.answer) ? q.answer.join(',') : String(q.answer || '');
      return uaText !== caText;
    });
    if (!wrong.length) {
      showAlert({ title: '没有错题', message: '本次没有答错的题目可重做。', tone: 'info' });
      return;
    }
    handleStartWrongRedo(wrong.map((q) => ({
      ...q,
      options: Array.isArray(q.options) ? q.options : [],
    })), { filter: 'result' });
  };

  const handlePracticeWeakFromResult = (category) => {
    if (!category) {
      setActiveTab('题库练习');
      setPage('practice');
      return;
    }
    handleStartPractice(category, 'all', { questionCount: 10, mode: 'practice', shuffle: true });
  };

  const handleAskAIFromResult = (result) => {
    const questions = result?.questions || [];
    const firstWrong = questions.find((q) => {
      const ua = result?.answers?.[q.id];
      if (ua == null || ua === '') return true;
      return String(ua) !== String(q.answer || '');
    }) || questions[0];
    goAskAI(firstWrong, {
      paperTitle: result?.paperTitle || result?.config?.title || '',
      prompt: '请根据本次练习表现，总结薄弱点并讲解最需要复盘的题目。',
    });
  };

  const handleAskAIFromExam = (question, extra = {}) => {
    goAskAI(question, {
      ...extra,
      prompt: extra.prompt || '请讲解这道题：拆解考点、说明为什么选这个答案、再给一个类似练习。',
    });
  };

  const handleStartRecommend = async (item) => {
    if (!item) return;
    if (item.action === 'wrong_redo' || item.type === 'wrong_due') {
      const rows = await window.openexam?.db?.getWrongQuestions?.({ dueOnly: true }) || [];
      const seen = new Set();
      const questions = rows.map((row, index) => {
        const id = String(row.question_id || row.id || `wrong_${index}`);
        if (seen.has(id)) return null;
        seen.add(id);
        return {
          id,
          type: row.type || 'single',
          category: row.category || '',
          sub_category: row.sub_category || '',
          content: row.content || '',
          content_html: row.content_html || '',
          options: Array.isArray(row.options) ? row.options : [],
          answer: row.answer || row.correct_answer || '',
          analysis: row.analysis || '',
          analysis_html: row.analysis_html || '',
          paper_id: row.paper_id || null,
        };
      }).filter((q) => q && q.content && q.answer && q.options.length);
      await handleStartWrongRedo(questions, { filter: 'due' });
      return;
    }
    if (item.category) {
      await handleStartPractice(item.category, item.subCategory || 'all', {
        questionCount: item.count || 10,
        mode: 'practice',
        shuffle: true,
        title: item.title,
      });
    }
  };

  const handleExitExam = () => {
    actions.resetExam();
    setExamResumeRecord(null);
    setCurrentPaperId(null);
    setActiveTab(getReturnTab(resultReturnPage));
    setPage(resultReturnPage);
  };

  const handleBackToList = () => {
    actions.resetExam();
    setExamResult(null);
    setCurrentPaperId(null);
    setPracticeQuestions(null);
    setPracticeConfig(null);
    setExamResumeRecord(null);
    setActiveTab(getReturnTab(resultReturnPage));
    setPage(resultReturnPage);
  };

  const handleTabChange = (tab) => {
    setActiveTab(tab);
    const tabPageMap = {
      "今日": "today",
      "学习中心": "home",
      "题库练习": "practice",
      "AI出卷": "ai-generate",
      "我的成长": "growth",
    };
    // 点导航进入题库练习时回到科目浏览；顶部搜索会单独把视图切到试卷列表
    if (tab === "题库练习") setPracticeView("subjects");
    setPage(tabPageMap[tab] || "home");
  };

  const handleUserMenuNavigate = (nextPage, nextTab) => {
    if (typeof nextTab === 'string' && nextTab) setActiveTab(nextTab);
    setPage(nextPage);
    setUserMenuOpen(false);
  };

  // 顶部搜索直接展开「题库练习 → 试卷与模拟考」
  const handleOpenPaperSearch = () => {
    setActiveTab("题库练习");
    setPracticeView("papers");
    setPage("practice");
    setPaperSearchFocusToken((token) => token + 1);
  };

  const handleGoToAIGenerate = () => {
    setActiveTab("AI出卷");
    setPage("ai-generate");
  };

  // 助教执行完动作后带用户去看结果页；科目页的「去问助教」直接打开合并后的 AI 助教并绑定科目
  const handleSubjectNavigate = (target, subject) => {
    if (target === "ask-assistant") {
      setAssistantSubjectId(subject?.id || "");
      setPage("ai-teacher");
      return;
    }
    if (target === "notes") {
      setActiveTab("");
      setPage("notes");
      return;
    }
    if (target === "materials") {
      setActiveTab("");
      setMaterialsSubjectId(subject?.id || "");
      setPage("materials");
      return;
    }
    if (target === "papers") {
      setActiveTab("题库练习");
      setMaterialsSubjectId(subject?.id || "");
      setPracticeView("papers");
      setPage("practice");
      return;
    }
    if (target === "wrong-book") {
      setActiveTab("");
      setPage("wrong-book");
      return;
    }
    if (target === "today") {
      setActiveTab("今日");
      setPage("today");
    }
  };

  const handleAssistantNavigate = (target) => handleSubjectNavigate(target, null);

  // 考试模式全屏
  if (page === "exam" && currentPaperId) {
    return (
      <div className={`app theme-${theme}`}>
        <div className={appStageClassName}>
          <PageView key="exam" fullscreen>
            <ExamRoom
              paperId={currentPaperId}
              config={practiceConfig}
              resumeRecord={examResumeRecord}
              onFinish={handleFinishExam}
              onExit={handleExitExam}
              onAskAI={handleAskAIFromExam}
              onSwitchToPractice={() => {
                setExamResumeRecord(null);
                setPracticeConfig({ mode: 'practice', title: practiceConfig?.title || '', sourcePaperId: currentPaperId });
              }}
            />
          </PageView>
        </div>
        <ImportTaskDock onOpenImport={() => setPage("import")} onOpenReview={handleOpenReview} />
        {onboarding}
      </div>
    );
  }

  // 专项练习模式
  if (page === "practice-exam" && practiceQuestions) {
    return (
      <div className={`app theme-${theme}`}>
        <div className={appStageClassName}>
          <PageView key="practice-exam" fullscreen>
            <ExamRoom
              questions={practiceQuestions}
              config={practiceConfig}
              resumeRecord={examResumeRecord}
              onFinish={handleFinishExam}
              onAskAI={handleAskAIFromExam}
              onExit={() => {
                setPracticeQuestions(null);
                setPracticeConfig(null);
                setExamResumeRecord(null);
                setActiveTab(getReturnTab(resultReturnPage));
                setPage(resultReturnPage);
              }}
            />
          </PageView>
        </div>
        <ImportTaskDock onOpenImport={() => setPage("import")} onOpenReview={handleOpenReview} />
        {onboarding}
      </div>
    );
  }

  // 结果页全屏
  if (page === "result" && examResult) {
    return (
      <div className={`app theme-${theme}`}>
        <div className={appStageClassName}>
          <PageView key="result" fullscreen>
            <ExamResult
              result={examResult}
              onBack={handleBackToList}
              onRedoWrong={(next) => handleRedoWrongFromResult(next || examResult)}
              onPracticeWeak={handlePracticeWeakFromResult}
              onAskAI={(question, extra) => question ? goAskAI(question, extra || {}) : handleAskAIFromResult(examResult)}
            />
          </PageView>
        </div>
        <ImportTaskDock onOpenImport={() => setPage("import")} onOpenReview={handleOpenReview} />
        {onboarding}
      </div>
    );
  }

  return (
    <div className={`app theme-${theme}`}>
      <div className={appStageClassName}>
        <div className={`frame ${sidebarExpanded ? 'sidebar-expanded' : ''}`}>
        <aside className="rail">
          <button className="rail-menu" aria-label="菜单" onClick={() => setSidebarExpanded(!sidebarExpanded)}>
            <span /><span /><span />
          </button>
          <div className="rail-icons">
            <div className="rail-slider" />
            {/* 科目：学习平台入口，自建科目 + 教材解析 */}
            <button className={`rail-icon subjects ${['subjects', 'materials'].includes(page) ? 'active' : ''}`} data-tip="我的科目" onClick={() => { setActiveTab(''); setPage('subjects'); }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
              </svg>
              <span className="rail-icon-text">我的科目</span>
            </button>
            {/* 资料与题库统一从「我的科目」的科目卡片进入，不再单独占用左侧导航 */}
            <button className={`rail-icon notes ${page === 'notes' ? 'active' : ''}`} data-tip="笔记" onClick={() => { setActiveTab(''); setPage('notes'); }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="15" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>
              </svg>
              <span className="rail-icon-text">笔记</span>
            </button>
            {/* 错题本 */}
            <button className={`rail-icon wrong-book ${page === 'wrong-book' ? 'active' : ''}`} data-tip="错题本" onClick={() => { setActiveTab(''); setPage('wrong-book'); }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6m0-6l6 6"/>
              </svg>
              <span className="rail-icon-text">错题本</span>
            </button>
            {/* 分析报告 */}
            <button className={`rail-icon analytics ${page === 'analytics' ? 'active' : ''}`} data-tip="分析报告" onClick={() => { setActiveTab(''); setPage('analytics'); }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 20V10M12 20V4M6 20v-6"/>
              </svg>
              <span className="rail-icon-text">分析报告</span>
            </button>
            {/* AI 助教：合并页（答疑讲解 + 录题库 / 录错题 / 调计划） */}
            <button className={`rail-icon ai-teacher ${page === 'ai-teacher' ? 'active' : ''}`} data-tip="AI 助教" onClick={() => { setActiveTab(''); setPage('ai-teacher'); }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2a2 2 0 012 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 017 7h1a1 1 0 011 1v3a1 1 0 01-1 1h-1v1a2 2 0 01-2 2H5a2 2 0 01-2-2v-1H2a1 1 0 01-1-1v-3a1 1 0 011-1h1a7 7 0 017-7h1V5.73A2 2 0 0112 2z"/>
                <circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/>
              </svg>
              <span className="rail-icon-text">AI 助教</span>
            </button>
          </div>
          <div className="rail-divider" />
          <div className="rail-bottom">
            <button
              className="rail-user"
              data-tip="个人资料"
              onClick={() => { setSettingsSection('profile'); setPage('settings'); }}
            >
              {profile.avatar ? <img src={profile.avatar} alt="" /> : avatarLetter}
            </button>
            <button className={`rail-bottom-icon home-icon ${!['wrong-book','analytics','ai-teacher','notes'].includes(page) ? 'active' : ''}`} data-tip="工作区" onClick={() => { setActiveTab('今日'); setPage('today'); }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
                <polyline points="9 22 9 12 15 12 15 22"/>
              </svg>
              <span className="rail-icon-text">主控制台</span>
            </button>
            <button className={`rail-bottom-icon settings-icon ${page === 'settings' ? 'active' : ''}`} data-tip="系统设置" onClick={() => setPage('settings')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
              </svg>
              <span className="rail-icon-text">系统设置</span>
            </button>
          </div>
        </aside>

        <section className="workspace">
          <header className="workspace-header">
            <div className="workspace-header-main">
              <button className="app-brand" type="button" onClick={() => { setActiveTab('今日'); setPage('today'); }}>
                <img src={appLogo} alt="StudyStudio" className="app-brand-logo" />
                <div className="app-brand-copy">
                  <strong>StudyStudio</strong>
                </div>
              </button>
              <nav className="tabs">
                {["今日", "学习中心", "题库练习", "AI出卷", "我的成长"].map(tab => (
                  <button key={tab} className={`tab ${activeTab === tab ? "active" : ""}`} onClick={() => handleTabChange(tab)}>
                    {tab}
                  </button>
                ))}
              </nav>
            </div>
            <div className="header-actions">
              <button className="search" type="button" onClick={handleOpenPaperSearch} title="搜索试卷">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                </svg>
              </button>
              <HomeNotifyBell
                onStartRecommend={handleStartRecommend}
                onOpenAnalytics={() => { setActiveTab(''); setPage('analytics'); }}
              />
              <div className="header-divider"></div>
              <div className="user">
                <div className="user-menu-host" ref={userMenuRef}>
                  <button
                    className="user-trigger"
                    type="button"
                    onClick={() => setUserMenuOpen((open) => !open)}
                    aria-expanded={userMenuOpen}
                  >
                    <span className="user-name">{displayName}</span>
                    <div className="avatar-wrap">
                      <div className="avatar">
                        {profile.avatar ? <img src={profile.avatar} alt="" /> : avatarLetter}
                      </div>
                      <svg className="avatar-arrow" width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M7 10l5 5 5-5z"/>
                      </svg>
                    </div>
                  </button>

                  {userMenuOpen && (
                    <div className="user-menu">
                      <div className="user-menu-head">
                        <div className="user-menu-avatar">
                          {profile.avatar ? <img src={profile.avatar} alt="" /> : avatarLetter}
                        </div>
                        <div>
                          <div className="user-menu-title">{displayName}</div>
                          <div className="user-menu-subtitle">本地学习账户</div>
                        </div>
                      </div>
                      <button type="button" className="user-menu-item" onClick={() => { setSettingsSection("profile"); handleUserMenuNavigate("settings"); }}>个人资料</button>
                      <button type="button" className="user-menu-item" onClick={() => handleUserMenuNavigate("home", "学习中心")}>学习中心</button>
                      <button type="button" className="user-menu-item" onClick={() => handleUserMenuNavigate("growth", "我的成长")}>我的成长</button>
                      <button type="button" className="user-menu-item" onClick={() => handleUserMenuNavigate("achievements", "我的成长")}>成就列表</button>
                      <button
                        type="button"
                        className="user-menu-item"
                        onClick={() => {
                          setTheme(theme === "light" ? "dark" : "light");
                          setUserMenuOpen(false);
                        }}
                      >
                        {theme === "light" ? "切换深色模式" : "切换浅色模式"}
                      </button>
                      <button type="button" className="user-menu-item danger" onClick={() => handleUserMenuNavigate("settings")}>系统设置</button>
                    </div>
                  )}
                </div>
                <button className="theme-toggle" onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
                  {theme === "light" ? "☾" : "☀"}
                </button>
                <button className="settings-btn" onClick={() => setPage("settings")}> 
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                  </svg>
                </button>
              </div>
            </div>
          </header>

          <div className="workspace-body">
            <PageView key={page === "materials" || page === "practice" ? "library" : page} className={page === "import" ? "is-hidden" : ""}>
              {page === "today" ? (
                <Today
                  onStartDrill={() => { setActiveTab('题库练习'); setPage('practice'); }}
                  onStartVocab={() => { setActiveTab('题库练习'); handleStartPractice('yanyu', 'xuanci', { questionCount: 15, mode: 'practice', shuffle: true }); }}
                  onStartEssay={() => { setActiveTab('题库练习'); setPage('practice'); }}
                  onOpenNotes={() => { setActiveTab(''); setPage('notes'); }}
                  onStartReview={handleStartTodayReview}
                  onStartDailyPractice={handleStartDailyPractice}
                  onOpenDailyReview={handleOpenDailyReview}
                />
              ) : page === "notes" ? (
                <Notes onBack={() => { setActiveTab('今日'); setPage('today'); }} />
              ) : (page === "practice" || page === "materials") ? (
                <Library
                  subjectId={materialsSubjectId}
                  tab={page === "materials" ? "materials" : "practice"}
                  practiceInitialTab={practiceView}
                  onSelectSubject={setMaterialsSubjectId}
                  onBack={() => { setActiveTab(""); setPage("subjects"); }}
                  onTabChange={(tab) => {
                    setActiveTab(tab === "practice" ? "题库练习" : "");
                    setPage(tab === "practice" ? "practice" : "materials");
                  }}
                  onImport={() => setPage("import")}                  onStartPractice={handleStartPractice}
                  onHistory={() => setPage("history")}
                  onGoAIGenerate={handleGoToAIGenerate}
                  onOpenPaper={(paper) => handleOpenPaper(paper, 'practice')}
                  onReviewPaper={(paper) => handleOpenReview(paper?.id, paper?.title)}
                  onOpenSettings={(section) => { setSettingsSection(section || "runtime"); setPage("settings"); }}
                  onOpenRecord={handleOpenPracticeRecord}
                  initialKeyword={paperSearchKeyword}
                  focusToken={paperSearchFocusToken}
                />
              ) : page === "history" ? (
                <PracticeHistory onBack={() => setPage("practice")} onOpenRecord={handleOpenPracticeRecord} />
              ) : page === "import" ? null
              : page === "settings" ? (
                <Settings
                  onBack={() => setPage("home")}
                  profile={profile}
                  initialSection={settingsSection}
                  onProfileSaved={handleProfileSaved}
                />
              ) : page === "ai-generate" ? (
                <AIGenerate onOpenPaper={(paper) => handleOpenPaper(paper, 'ai-generate')} />
              ) : page === "subjects" ? (
                <Subjects onNavigate={handleSubjectNavigate} />
              ) : page === "ai-teacher" ? (
                <AIHub
                  onNavigate={handleAssistantNavigate}
                  assistantSubjectId={assistantSubjectId}
                />
              ) : page === "wrong-book" ? (
                <WrongBook
                  onRedo={handleStartWrongRedo}
                  onAskAI={(item) => goAskAI({
                    id: item.question_id || item.id,
                    category: item.category,
                    sub_category: item.sub_category,
                    content: item.content,
                    options: item.options,
                    answer: item.answer || item.correct_answer,
                    analysis: item.analysis,
                    user_answer: item.user_answer,
                  }, { paperTitle: item.paper_title || '', prompt: '请讲解这道错题：指出我错在哪、正确思路是什么、再给一个变式。' })}
                />
              ) : page === "analytics" ? (
                <Analytics onOpenSettings={() => setPage("settings")} onStartRecommend={handleStartRecommend} onStartPractice={(category) => handleStartPractice(category, 'all', { questionCount: 10, mode: 'practice', shuffle: true })} />
              ) : page === "growth" ? (
                <GrowthCenter onOpenAchievements={() => { setActiveTab("我的成长"); setPage("achievements"); }} onStartPractice={() => { setActiveTab('题库练习'); setPage('practice'); }} />
              ) : page === "achievements" ? (
                <AchievementCenter onBack={() => { setActiveTab("我的成长"); setPage("growth"); }} />
              ) : (
                <OriginalHomePage
                  onGoAIGenerate={handleGoToAIGenerate}
                  onOpenPractice={() => { setActiveTab('题库练习'); setPage('practice'); }}
                  onOpenWrongBook={() => { setActiveTab(''); setPage('wrong-book'); }}
                  onOpenHistory={() => setPage('history')}
                  onOpenAnalytics={() => { setActiveTab(''); setPage('analytics'); }}
                  onOpenNotes={() => { setActiveTab(''); setPage('notes'); }}
                  onStartRecommend={handleStartRecommend}
                  onStartCategory={(category) => handleStartPractice(category, 'all', { questionCount: 10, mode: 'practice', shuffle: true })}
                  onStartKnowledgePractice={handleStartKnowledgePractice}
                />
              )}
            </PageView>
            {/* 常驻挂载：切到其它页面时只隐藏，识别任务继续在后台跑 */}
            <div className={`page-view import-paper-host${page === "import" ? "" : " is-hidden"}`}>
              <ImportPaper
                onBack={() => setPage("practice")}
                onImportComplete={handleImportComplete}
              />
            </div>
          </div>
        </section>
        </div>
      </div>
      {showOnboarding || onboardingClosing ? null : (
        <ImportTaskDock onOpenImport={() => setPage("import")} onOpenReview={handleOpenReview} />
      )}
      {onboarding}
    </div>
  );
}

// 右上角通知：承接今日推荐，不占首页主内容
function HomeNotifyBell({ onStartRecommend, onOpenAnalytics }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const hostRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!window.openexam?.db?.getSmartRecommend) return;
      try {
        const rec = await window.openexam.db.getSmartRecommend({ limit: 5 });
        if (!cancelled) setItems(Array.isArray(rec) ? rec : []);
      } catch (error) {
        console.error('加载推荐通知失败:', error);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (event) => {
      if (!hostRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const count = items.length;

  return (
    <div className="home-notify" ref={hostRef}>
      <button
        type="button"
        className={`home-notify-btn${open ? ' is-open' : ''}`}
        title="今日提醒"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 01-3.46 0" />
        </svg>
        {count > 0 && <span className="home-notify-badge">{count > 9 ? '9+' : count}</span>}
      </button>

      {open && (
        <div className="home-notify-panel">
          <div className="home-notify-head">
            <strong>今日提醒</strong>
            <button type="button" onClick={() => { setOpen(false); onOpenAnalytics?.(); }}>分析报告</button>
          </div>
          {count === 0 ? (
            <div className="home-notify-empty">暂无提醒，保持当前节奏即可</div>
          ) : (
            <div className="home-notify-list">
              {items.map((item) => (
                <button
                  key={item.id || item.title}
                  type="button"
                  className="home-notify-item"
                  onClick={() => {
                    setOpen(false);
                    onStartRecommend?.(item);
                  }}
                >
                  <span className="home-notify-title">{item.title}</span>
                  <span className="home-notify-desc">{item.reason}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 知识图谱浮层：一次只画一层。
 *
 * 旧版把「科目→模块→知识点→考点」整棵树塞进一张图，几百个节点挤在四列里，
 * 连线全是直线，既看不清也点不动。现在改成放射状 + 逐层下钻：
 *   点饼图 → 数学 → 高等数学 → 一元函数微分学 → 泰勒公式
 * 每次只显示当前节点和它的直接子节点，连线用贝塞尔曲线向外发散。
 *
 * 布局按容器实际尺寸算（椭圆分布，1 单位 = 1 px），
 * 不再用固定 viewBox 等比缩放 —— 1200×680 的窗口里缩放会把字缩到看不清。
 */
// 单层最多画 20 个节点，多出来的折成「其他 N 个」，避免节点糊成一团
const KG_MAX_CHILDREN = 20;
const KG_RING_CAPS = [8, 12];
const KG_RING_FRACTIONS = [0.62, 1];
// 胶囊宽度按字数估算：4 字约 92px，8 字约 150px，上限 180px
const kgPillWidth = (label) => Math.min(180, Math.max(104, 34 + String(label || '').length * 14.5));

function KnowledgeGraphOverlay({ graph, onClose, focusCategory = '', focusLabel = '', onOpenQuestions }) {
  const tree = Array.isArray(graph?.tree) ? graph.tree : [];
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [trail, setTrail] = useState([]);
  const [activeNode, setActiveNode] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [size, setSize] = useState({ w: 1080, h: 620 });
  const svgRef = useRef(null);
  const dragRef = useRef(null);
  const movedRef = useRef(false);

  // 聚焦键既可能是四科 key（major），也可能是自建科目的完整节点 id（subject:subj_xxx）；
  // 统一补成 subject:<key>，否则自建科目会被拼成 subject:subject:xxx 而聚焦失败。
  const focusRaw = String(focusCategory || '').trim();
  const focusId = focusRaw
    ? (focusRaw.startsWith('subject:') ? focusRaw : `subject:${focusRaw}`)
    : '';
  const focusExists = Boolean(focusId) && tree.some((node) => node.id === focusId);
  const focusMissing = Boolean(focusRaw) && !showAll && !focusExists;

  const findNode = (nodes, id) => {
    for (const node of nodes) {
      if (node.id === id) return node;
      const found = findNode(node.children || [], id);
      if (found) return found;
    }
    return null;
  };

  useEffect(() => {
    setTrail(focusExists ? [focusId] : []);
    setShowAll(false);
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setActiveNode(null);
  }, [graph, focusId, focusExists]);

  // 跟随窗口尺寸重排，避免小窗口里整张图被缩小
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return undefined;
    const update = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 120 && rect.height > 120) {
        setSize((prev) => (Math.abs(prev.w - rect.width) < 2 && Math.abs(prev.h - rect.height) < 2
          ? prev
          : { w: Math.round(rect.width), h: Math.round(rect.height) }));
      }
    };
    update();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    observer?.observe(el);
    return () => observer?.disconnect();
  }, []);

  const centerNode = trail.length ? findNode(tree, trail[trail.length - 1]) : null;
  const children = focusMissing ? [] : (centerNode ? (centerNode.children || []) : tree);
  const crumbs = trail.map((id) => ({ id, label: findNode(tree, id)?.label || '' })).filter((item) => item.label);

  // 单层节点太多时折叠成「其他 N 个」，宁可少画几个也不要把图挤成一团
  const visibleChildren = useMemo(() => {
    if (children.length <= KG_MAX_CHILDREN) return children;
    const head = children.slice(0, KG_MAX_CHILDREN - 1);
    const rest = children.slice(KG_MAX_CHILDREN - 1);
    return [...head, {
      id: `${centerNode?.id || 'root'}:more`,
      label: `其他 ${rest.length} 个`,
      type: children[0]?.type || 'point',
      count: rest.reduce((sum, node) => sum + Number(node.count || 0), 0),
      children: [],
      isOverflow: true,
    }];
  }, [children, centerNode]);

  const nodeLabel = (node) => {
    const labels = { gaoshu: '高等数学', daishu: '线性代数', gaiilv: '概率论', yuedu: '阅读理解', fanyi: '翻译', wanxing: '完形填空', xiezuo: '英语写作', makesi: '马克思主义', maogai: '毛中特', shixi: '思想道德与法治', shiju: '形势与政策', general: '待分类' };
    return labels[node.label] || node.label || '未命名';
  };

  const nodeCount = (node) => `${Number(node?.count || 0).toLocaleString()} 题`;

  const layout = useMemo(() => {
    const cx = size.w / 2;
    const cy = size.h / 2;
    // 给胶囊留出横向/纵向余量，避免贴边
    const maxRx = Math.max(170, size.w / 2 - 118);
    const maxRy = Math.max(130, size.h / 2 - 46);
    const map = new Map();
    let remaining = [...visibleChildren];
    let ringIndex = 0;
    // 节点很少时从「右」起排，宽扁的窗口里横向铺开比上下堆叠好看
    const startAngle = visibleChildren.length <= 4 ? 0 : -Math.PI / 2;
    const limitRx = size.w / 2 - 96;
    const limitRy = size.h / 2 - 38;

    while (remaining.length && ringIndex < KG_RING_CAPS.length) {
      const ringNodes = remaining.slice(0, KG_RING_CAPS[ringIndex]);
      remaining = remaining.slice(KG_RING_CAPS[ringIndex]);
      const widest = Math.max(...ringNodes.map((node) => kgPillWidth(nodeLabel(node))));
      const stagger = ringIndex * 0.34;
      const angleOf = (index) => startAngle + stagger + (index * Math.PI * 2) / ringNodes.length;
      const baseRx = maxRx * KG_RING_FRACTIONS[ringIndex];
      const baseRy = maxRy * KG_RING_FRACTIONS[ringIndex];
      let rx = baseRx;
      let ry = baseRy;

      // 椭圆太扁时相邻胶囊会挨在一起，逐步放大到不挤为止（但不许超出画布）
      for (let step = 0; step < 8; step += 1) {
        let minDist = Infinity;
        ringNodes.forEach((_, index) => {
          const a = angleOf(index);
          const b = angleOf((index + 1) % ringNodes.length);
          const dx = (Math.cos(a) - Math.cos(b)) * rx;
          const dy = (Math.sin(a) - Math.sin(b)) * ry;
          minDist = Math.min(minDist, Math.hypot(dx, dy));
        });
        if (ringNodes.length < 2 || minDist >= widest + 12) break;
        rx = Math.min(limitRx, rx * 1.08);
        ry = Math.min(limitRy, ry * 1.08);
      }

      ringNodes.forEach((node, index) => {
        const angle = angleOf(index);
        map.set(node.id, { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry, angle, rx, ry });
      });
      ringIndex += 1;
    }

    return { map, cx, cy };
  }, [visibleChildren, size]);

  const centerRadius = centerNode ? (centerNode.type === 'subject' ? 62 : 56) : 66;

  /**
   * 拖拽平移：只有按在空白背景层上才开始，并且拖动超过 5px 才捕获指针。
   * 一旦在 pointerdown 就 setPointerCapture，pointerup 会被重定向到容器，
   * 浏览器算出的 click 目标就变成容器 —— 节点和「关闭」按钮全都点不动。
   */
  const handlePointerDown = (event) => {
    if (event.button) return;
    const onBlank = event.target?.dataset?.pan === '1';
    if (!onBlank) {
      movedRef.current = false;
      return;
    }
    dragRef.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y, captured: false };
    movedRef.current = false;
  };
  const handlePointerMove = (event) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.captured) {
      if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      drag.captured = true;
      movedRef.current = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    setOffset({ x: drag.ox + dx, y: drag.oy + dy });
  };
  const handlePointerUp = (event) => {
    if (dragRef.current?.captured) event.currentTarget.releasePointerCapture?.(event.pointerId);
    dragRef.current = null;
  };

  // 跳到该节点下的题目：交给上层去拉数据并进入练习
  const openQuestions = (node) => {
    if (!node || node.isOverflow || !node.category) return;
    if (typeof onOpenQuestions === 'function') onOpenQuestions(node);
  };

  const drillInto = (node) => {
    // 拖动画布时松手会补一个 click，别让它误触下钻
    if (!node || movedRef.current) return;
    // 底层节点没有更细的分类：第一次点选中，再点一次进题目
    if (!node.children?.length) {
      if (node.isOverflow) return;
      if (activeNode?.id === node.id) {
        openQuestions(node);
        return;
      }
      setActiveNode(node);
      return;
    }
    setActiveNode(node);
    setTrail((current) => [...current, node.id]);
    setOffset({ x: 0, y: 0 });
    setZoom(1);
  };

  const jumpTo = (depth) => {
    setTrail((current) => current.slice(0, depth));
    setOffset({ x: 0, y: 0 });
    setZoom(1);
    setActiveNode(null);
  };

  const centerLines = (() => {
    const label = centerNode ? nodeLabel(centerNode) : '知识图谱';
    if (label.length <= 5) return [label];
    const split = Math.ceil(label.length / 2);
    return [label.slice(0, split), label.slice(split, split + 6)];
  })();

  // 选中的底层节点：入口放到工具栏里，避免浮层压住画布上的节点
  const activeLeaf = activeNode && !activeNode.children?.length && !activeNode.isOverflow
    && activeNode.category
    ? activeNode
    : null;

  return (
    <div className="knowledge-graph-overlay">
      <div className="knowledge-graph-toolbar" onPointerDown={(event) => { event.stopPropagation(); movedRef.current = false; }}>
        <div className="knowledge-graph-heading">
          <div className="knowledge-graph-crumbs">
            <button type="button" className={`kg-crumb ${trail.length ? '' : 'is-current'}`} onClick={() => { setShowAll(true); jumpTo(0); }}>全部科目</button>
            {crumbs.map((crumb, index) => (
              <React.Fragment key={crumb.id}>
                <span className="kg-crumb-sep">/</span>
                <button
                  type="button"
                  className={`kg-crumb ${index === crumbs.length - 1 ? 'is-current' : ''}`}
                  onClick={() => jumpTo(index + 1)}
                >
                  {crumb.label}
                </button>
              </React.Fragment>
            ))}
          </div>
          <strong>{centerNode ? `${nodeLabel(centerNode)} · ${nodeCount(centerNode)}` : '知识图谱'}</strong>
          {activeLeaf ? (
            <span className="kg-leaf-inline">
              <em>{nodeLabel(activeLeaf)}</em>
              <i>{`${Number(activeLeaf.count || 0)} 道题`}</i>
              <button type="button" className="kg-leaf-inline-btn" onClick={() => openQuestions(activeLeaf)}>开始练习</button>
            </span>
          ) : (
            <span>{children.length ? `点击节点继续下钻 · 当前展开 ${children.length} 个节点` : '已到底层 · 再点一次节点进入对应题目'}</span>
          )}
        </div>
        <div className="knowledge-graph-actions">
          {trail.length > 0 && <button type="button" onClick={() => jumpTo(trail.length - 1)}>上一级</button>}
          <button type="button" onClick={() => setZoom((value) => Math.max(0.45, value - 0.12))}>−</button>
          <span>{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }); }}>重置</button>
          <button type="button" onClick={() => setZoom((value) => Math.min(2.2, value + 0.12))}>＋</button>
          <button type="button" className="knowledge-graph-close" onClick={onClose}>关闭</button>
        </div>
      </div>
      <svg
        ref={svgRef}
        className="knowledge-graph-canvas"
        viewBox={`0 0 ${size.w} ${size.h}`}
        role="img"
        aria-label="考研知识图谱"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={(event) => { setZoom((value) => Math.max(0.45, Math.min(2.2, value * (event.deltaY > 0 ? 0.92 : 1.08)))); }}
      >
        <defs>
          <radialGradient id="kg-center-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
        </defs>
        <g transform={`translate(${offset.x} ${offset.y}) scale(${zoom})`}>
          <rect className="kg-pan-layer" data-pan="1" x={-size.w} y={-size.h} width={size.w * 3} height={size.h * 3} />
          <circle cx={layout.cx} cy={layout.cy} r={centerRadius * 2.6} fill="url(#kg-center-glow)" pointerEvents="none" />
          <g key={centerNode?.id || 'root'} className="kg-level">
            {visibleChildren.map((node, index) => {
              const point = layout.map.get(node.id);
              if (!point) return null;
              const dx = point.x - layout.cx;
              const dy = point.y - layout.cy;
              const length = Math.hypot(dx, dy) || 1;
              const ux = dx / length;
              const uy = dy / length;
              const px = -uy;
              const py = ux;
              const startX = layout.cx + ux * (centerRadius + 4);
              const startY = layout.cy + uy * (centerRadius + 4);
              const endX = point.x - ux * 18;
              const endY = point.y - uy * 18;
              const c1x = layout.cx + ux * length * 0.36 + px * length * 0.12;
              const c1y = layout.cy + uy * length * 0.36 + py * length * 0.12;
              const c2x = layout.cx + ux * length * 0.74 - px * length * 0.06;
              const c2y = layout.cy + uy * length * 0.74 - py * length * 0.06;
              return (
                <path
                  key={`link-${node.id}`}
                  className={`kg-link kg-link-${node.type || 'point'}`}
                  d={`M ${startX} ${startY} C ${c1x} ${c1y} ${c2x} ${c2y} ${endX} ${endY}`}
                  style={{ animationDelay: `${index * 26}ms` }}
                />
              );
            })}
            {visibleChildren.map((node, index) => {
              const point = layout.map.get(node.id);
              if (!point) return null;
              const label = nodeLabel(node);
              const width = kgPillWidth(label);
              const hasChildren = Boolean(node.children?.length);
              const display = label.length > 10 ? `${label.slice(0, 9)}…` : label;
              return (
                <g
                  key={node.id}
                  className={`kg-node kg-node-${node.type || 'point'} ${hasChildren ? 'is-branch' : 'is-leaf'} ${activeNode?.id === node.id ? 'is-selected' : ''}`}
                  transform={`translate(${point.x} ${point.y})`}
                  onClick={(event) => { event.stopPropagation(); drillInto(node); }}
                  style={{ animationDelay: `${index * 26}ms` }}
                >
                  <rect x={-width / 2} y={-20} width={width} height={40} rx={20} />
                  <text textAnchor="middle" dy="4">{display}</text>
                  <text className="kg-node-count" textAnchor="middle" dy="31">{nodeCount(node)}</text>
                  {hasChildren && <text className="kg-node-more" x={width / 2 - 13} dy="4" textAnchor="middle">›</text>}
                  {!hasChildren && !node.isOverflow && <text className="kg-node-more kg-node-go" x={width / 2 - 13} dy="4" textAnchor="middle">→</text>}
                </g>
              );
            })}
            <g
              className={`kg-node kg-node-center ${trail.length ? 'can-back' : ''}`}
              transform={`translate(${layout.cx} ${layout.cy})`}
              onClick={(event) => { event.stopPropagation(); if (!movedRef.current && trail.length) jumpTo(trail.length - 1); }}
            >
              <circle r={centerRadius} />
              {centerLines.map((line, index) => (
                <text key={index} textAnchor="middle" dy={centerLines.length > 1 ? (index === 0 ? -6 : 10) : 4} className="kg-center-label">{line}</text>
              ))}
              {centerNode && <text className="kg-center-count" textAnchor="middle" dy={centerLines.length > 1 ? 26 : 20}>{nodeCount(centerNode)}</text>}
            </g>
          </g>
        </g>
      </svg>
      {children.some((node) => node.label === '未归类章节') && (
        <div className="kg-hint">
          这批题还没有章节分类，去「题库练习 → 重新分类」跑一遍，图谱就会按章节展开。
        </div>
      )}
      {focusMissing && (
        <div className="knowledge-graph-empty">
          「{focusLabel || '该科目'}」还没有可展示的图谱内容。
          <button type="button" className="kg-leaf-inline-btn" style={{ marginLeft: 8 }} onClick={() => { setShowAll(true); setTrail([]); }}>查看全部科目</button>
        </div>
      )}
      {!tree.length && <div className="knowledge-graph-empty">题库里还没有已归类到子类别 / 章节 / 知识点的题目。先到「题库练习 → 重新分类」，或让 AI 助教按知识图谱分类（需在确认卡片上确认后才会写库）。</div>}
    </div>
  );
}

function OriginalHomePage({ onGoAIGenerate, onOpenPractice, onOpenWrongBook, onOpenHistory, onOpenAnalytics, onOpenNotes, onStartRecommend, onStartCategory, onStartKnowledgePractice }) {
  const [stats, setStats] = useState({ totalQuestions: 0, totalDone: 0, accuracy: 0, wrongCount: 0, correctCount: 0, todayAdded: 0 });
  const [todayStats, setTodayStats] = useState({ total: 0, correct: 0, duration: 0 });
  const [categories, setCategories] = useState([]);
  const [dailyStats, setDailyStats] = useState([]);
  const [hoverDay, setHoverDay] = useState(null);
  const [knowledgeGraph, setKnowledgeGraph] = useState(null);
  const [graphOpen, setGraphOpen] = useState(false);
  const [graphFocusCategory, setGraphFocusCategory] = useState('');
  const [graphFocusLabel, setGraphFocusLabel] = useState('');
  const [subjectDistributions, setSubjectDistributions] = useState({});
  const [resettingProgress, setResettingProgress] = useState(false);
  const [progressRefreshKey, setProgressRefreshKey] = useState(0);
  const { confirm: showConfirm, alert: showAlert, toast } = useDialog();

  useEffect(() => {
    const loadData = async () => {
      if (!window.openexam?.db) return;
      try {
        const subjects = ['math', 'english', 'politics', 'major'];
        const [practiceStats, categoryStats, daily, today, ...distributionRows] = await Promise.all([
          window.openexam.db.getPracticeStats(),
          window.openexam.db.getCategoryStats(),
          window.openexam.db.getDailyStats(7),
          window.openexam.db.getTodayStats?.() || Promise.resolve({ total: 0 }),
          ...subjects.map((subject) => window.openexam.db.getSubCategoryStats?.(subject) || Promise.resolve([])),
        ]);
        setStats(practiceStats);
        setCategories(categoryStats);
        setDailyStats(daily);
        setTodayStats(today || { total: 0 });
        setSubjectDistributions(Object.fromEntries(subjects.map((subject, index) => [subject, Array.isArray(distributionRows[index]) ? distributionRows[index] : []])));
      } catch (err) {
        console.error('加载统计数据失败:', err);
      }
    };
    loadData();
  }, [progressRefreshKey]);

  const categoryNames = { math: '数学', english: '英语', politics: '政治', major: '专业课' };

  // 重置学习进度：只清练习记录与错题复习阶梯，题目/笔记/错题条目保留
  const handleResetStudyProgress = async (cat) => {
    const resetAll = !cat;
    const label = resetAll ? '全部学科' : (categoryNames[cat.category] || cat.label || cat.category);
    if (!window.openexam?.db?.resetStudyProgress) {
      await showAlert({ title: '暂不支持', message: '当前环境不支持重置学习进度。', tone: 'warning' });
      return;
    }
    const confirmed = await showConfirm({
      title: resetAll ? '重置全部学习进度' : `重置「${label}」学习进度`,
      message: `将清空${resetAll ? '全部学科' : `「${label}」`}的练习记录（含未完成练习）和错题复习进度：完成度、正确率、已练题数会重新计算，错题会回到待复习状态。\n\n题目、笔记、错题条目本身不会删除，此操作无法撤销。是否继续？`,
      confirmText: '确认重置',
      cancelText: '取消',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      setResettingProgress(true);
      const result = await window.openexam.db.resetStudyProgress(resetAll ? 'all' : cat.category);
      if (!result?.success) throw new Error(result?.error || '重置失败');
      setProgressRefreshKey((key) => key + 1);
      toast({
        title: '学习进度已重置',
        message: `${label}：清除 ${Number(result.practiceRecords) || 0} 条练习记录，重置 ${Number(result.wrongQuestions) || 0} 道错题的复习进度`,
        tone: 'success',
      });
    } catch (error) {
      await showAlert({ title: '重置失败', message: error.message || '未知错误', tone: 'danger' });
    } finally {
      setResettingProgress(false);
    }
  };

  const I = ({ d }) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">{d}</svg>;

  const categoryIcons = {
    math: <I d={<><path d="M4 19h16"/><path d="M6 16l4-8 4 5 3-4 2 3"/></>} />,
    english: <I d={<><path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h6M8 16h4"/></>} />,
    politics: <I d={<><circle cx="12" cy="12" r="9"/><path d="M8 12l2.5 2.5L16 9"/></>} />,
    major: <I d={<><path d="M4 5h16v14H4z"/><path d="M8 9h8M8 13h8M8 17h5"/></>} />,
    yanyu: <I d={<><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></>} />,
    shuliang: <I d={<><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></>} />,
    panduan: <I d={<><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></>} />,
    ziliao: <I d={<><path d="M18 20V10M12 20V4M6 20v-6"/></>} />,
    changshi: <I d={<><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/></>} />,
  };

  const chartHasData = dailyStats.some((d) => Number(d.total) > 0);
  // 空类目（既没有题目也没有笔记）不进入目列表，也不提供图谱入口
  const visibleCategories = (categories || []).filter((item) => (
    Number(item?.total || 0) > 0 || Number(item?.notes || 0) > 0
  ));
  const baseSubjectCards = [
    { key: 'math', label: '数学', color: '#4f76e8' },
    { key: 'english', label: '英语', color: '#0f8a68' },
    { key: 'politics', label: '政治', color: '#c47a2c' },
    { key: 'major', label: '专业课', color: '#7b62c9' },
  ].filter((card) => visibleCategories.some((item) => item.category === card.key));
  // 自建科目（如「自动控制原理」）各自一个饼图，不再被算进「专业课」
  const customSubjectCards = visibleCategories
    .filter((item) => item?.isCustom)
    .map((item, index) => ({
      key: item.category,
      label: item.label || '自建科目',
      color: ['#3f8fb0', '#c2685e', '#6f9c4a', '#b07cc6', '#d09a3c'][index % 5],
      isCustom: true,
    }));
  const subjectCards = [...baseSubjectCards, ...customSubjectCards];
  const subCategoryNames = { gaoshu: '高数', daishu: '线代', gaiilv: '概率', wanxing: '完形', yuedu: '阅读', fanyi: '翻译', xiezuo: '写作', makesi: '马原', maogai: '毛中特', shixi: '思修', shiju: '时政', major: '专业课综合', general: '待分类' };
  const openKnowledgeGraph = async (category = '', label = '') => {
    // 图谱完全来自本地题库的分类字段，不再要求先配置 AI 才能查看
    const result = await window.openexam?.db?.getKnowledgeGraph?.();
    setKnowledgeGraph(result || { tree: [] });
    setGraphFocusCategory(category);
    setGraphFocusLabel(label);
    setGraphOpen(true);
  };

  return (
    <>
      <section className="main-panel home-main">
        <header className="home-main-header">
          <div className="breadcrumb" style={{ margin: 0, fontSize: 11, color: "var(--muted)" }}>学习中心 &gt; 刷题</div>
          <div className="home-main-title-row">
            <h2>刷题</h2>
            <button onClick={() => onGoAIGenerate?.()} title="去 AI 出卷" className="home-inline-action">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
              AI 出卷
            </button>
          </div>
        </header>

        <div className="home-chart-block">
          <div className="home-chart-head">
            <div className="home-chart-title">
              <h3>刷题统计</h3>
              <span>近7天每日做题量</span>
            </div>
            <div className="home-chart-meta">
              {hoverDay ? (
                <span><strong>{hoverDay.total}</strong> 道 · {hoverDay.date?.slice(5)}</span>
              ) : (
                <span>今日 <strong>{Number(todayStats.total || 0).toLocaleString()}</strong> 道 · 累计 {stats.totalDone.toLocaleString()}</span>
              )}
            </div>
          </div>

          {(() => {
            const maxVal = Math.max(...dailyStats.map((d) => d.total), chartHasData ? 1 : 10);
            const yTicks = chartHasData
              ? [maxVal, Math.round(maxVal * 0.67), Math.round(maxVal * 0.33), 0]
              : [10, 7, 3, 0];
            const dayLabels = (dailyStats.length ? dailyStats : Array.from({ length: 7 }, (_, i) => {
              const date = new Date();
              date.setDate(date.getDate() - (6 - i));
              return { date: date.toISOString().slice(0, 10), total: 0 };
            })).map((d) => {
              const date = new Date(`${d.date}T00:00:00`);
              return Number.isNaN(date.getTime()) ? '—' : ['日', '一', '二', '三', '四', '五', '六'][date.getDay()];
            });
            return (
              <div className="home-chart-frame">
                <div className="home-chart-yticks">
                  {yTicks.map((v, i) => <span key={i}>{v > 0 ? `${v}题` : '0'}</span>)}
                </div>
                <div className="home-chart-canvas" onMouseLeave={() => setHoverDay(null)}>
                  <DynamicChart data={dailyStats} onHover={setHoverDay} />
                  <div className="home-chart-xticks">
                    {dayLabels.map((l, i) => <span key={i}>周{l}</span>)}
                  </div>
                </div>
              </div>
            );
          })()}
        </div>

        <div className="home-bottom-grid">
          <div className="home-subject-pies">
            {subjectCards.map((subject) => {
              const category = categories.find((item) => item.category === subject.key);
              const total = Number(category?.total || 0);
              const rows = subjectDistributions[subject.key] || [];
              const actualRows = rows.filter((row) => Number(row.count) > 0);
              const slices = actualRows.length ? actualRows : (total > 0 ? [{ subCategory: 'general', count: total }] : []);
              let cursor = 0;
              const stops = slices.map((row, index) => {
                const start = cursor;
                cursor += total > 0 ? (Number(row.count) / total) * 360 : 0;
                return `${[subject.color, '#8ea8ef', '#75bea8', '#d9a15e', '#aa94df'][index % 5]} ${start}deg ${cursor}deg`;
              });
              const gradient = stops.length ? `conic-gradient(${stops.join(', ')})` : 'conic-gradient(var(--accent-soft-bg) 0deg 360deg)';
              return (
                <div
                  key={subject.key}
                  className="home-stat-card home-subject-pie-card is-graph-entry"
                  role="button"
                  tabIndex={0}
                  title={`打开${subject.label}知识图谱`}
                  onClick={() => openKnowledgeGraph(subject.key, subject.label)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    openKnowledgeGraph(subject.key, subject.label);
                  }}
                >
                  <div className="home-stat-card-head"><h3>{subject.label}</h3><span className="home-stat-dot" style={{ background: subject.color }} /></div>
                  <div className="home-dist-body">
                    <button type="button" className="home-donut home-donut-button" title={`打开${subject.label}知识图谱`} onClick={(event) => { event.stopPropagation(); openKnowledgeGraph(subject.key, subject.label); }} style={{ background: gradient }}>
                      <div className="home-donut-inner"><strong>{total.toLocaleString()}</strong><span>题目</span></div>
                    </button>
                    <div className="home-dist-legend">
                      {slices.slice(0, 4).map((row, index) => <div key={`${subject.key}-${row.subCategory}`} className="home-dist-legend-item"><span className="home-dist-bar" style={{ background: [subject.color, '#8ea8ef', '#75bea8', '#d9a15e'][index % 4] }} /><div><span className="home-dist-name">{subCategoryNames[row.subCategory] || row.subCategory || '待分类'}</span><strong>{Number(row.count || 0)} <em>道</em></strong></div></div>)}
                      {!slices.length && <div className="home-pie-empty">暂无题目</div>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="home-stat-card">
            <div className="home-stat-card-head">
              <h3>正确率统计</h3>
              <span className="home-stat-dot" />
            </div>
            <div className="home-acc-body">
              <div className="home-acc-hero">
                <span className="home-acc-num">{stats.accuracy}</span>
                <span className="home-acc-unit">%</span>
                <span className="home-acc-label">综合正确率</span>
              </div>
              <div className="home-acc-bar">
                <div style={{ width: `${stats.accuracy}%` }} />
              </div>
              <div className="home-acc-split">
                <div>
                  <div className="home-acc-split-label"><i className="ok" />已掌握</div>
                  <strong>{stats.correctCount.toLocaleString()} <em>道</em></strong>
                </div>
                <div className="is-end">
                  <div className="home-acc-split-label"><i className="bad" />待加强</div>
                  <strong>{stats.wrongCount.toLocaleString()} <em>道</em></strong>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <aside className="side-panel home-side">
        <div className="home-quick-links">
          {[
            { label: '专项练习', onClick: onOpenPractice },
            { label: '错题本', onClick: onOpenWrongBook },
            { label: '练习历史', onClick: onOpenHistory },
            { label: '分析报告', onClick: onOpenAnalytics },
            { label: '笔记', onClick: onOpenNotes },
          ].map((item) => (
            <button key={item.label} type="button" onClick={() => item.onClick?.()}>{item.label}</button>
          ))}
        </div>

        <div className="home-side-progress">
          <div className="home-side-progress-head">
            <h4>学习进度</h4>
            <button
              type="button"
              className="home-progress-reset-all"
              onClick={() => handleResetStudyProgress(null)}
              disabled={resettingProgress || !visibleCategories.length}
            >全部重置</button>
          </div>
          <div className="home-progress-list">
            {visibleCategories.length === 0 ? (
              <div className="home-progress-empty">还没有可统计的学科</div>
            ) : visibleCategories.map((cat) => {
              const total = Number(cat.total || 0);
              const done = Math.max(0, Number(cat.done || 0));
              const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0;
              const label = categoryNames[cat.category] || cat.label || cat.category;
              return (
                <div className="home-progress-row" key={cat.category}>
                  <div className="home-progress-row-head">
                    <span className="home-progress-name">{label}</span>
                    <span className="home-progress-meta">{total > 0 ? `已练 ${done} / ${total} · ${pct}%` : '暂无题目'}</span>
                    <button
                      type="button"
                      className="home-progress-reset"
                      onClick={() => handleResetStudyProgress(cat)}
                      disabled={resettingProgress}
                    >重置</button>
                  </div>
                  <div className="home-progress-track"><div style={{ width: `${pct}%` }} /></div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="home-side-banks">
          <div className="home-side-banks-head">
            <h4>学习科目</h4>
            <button type="button" onClick={() => onOpenPractice?.()}>全部 {visibleCategories.length} &gt;</button>
          </div>
          <div className="home-side-banks-list">
            {visibleCategories.map((cat, i) => {
              const pct = typeof cat.accuracy === 'number' && cat.answered > 0
                ? cat.accuracy
                : (cat.total > 0 ? Math.round(((cat.done || 0) / cat.total) * 100) : 0);
              const isTop = i < 3;
              const rankColor = i === 0 ? "var(--warning)" : i === 1 ? "#98a3b6" : i === 2 ? "#bf8b5d" : "var(--muted)";
              return (
                <button key={cat.category} type="button" className="home-side-bank" onClick={() => onStartCategory?.(cat.category)}>
                  <span className="home-side-rank" style={{ color: isTop ? rankColor : "var(--muted)" }}>{i + 1}</span>
                  <span className="home-side-icon">{categoryIcons[cat.category] || <I d={<circle cx="12" cy="12" r="10"/>} />}</span>
                  <div className="home-side-bank-copy">
                    <div className="home-side-bank-top">
                      <span>{categoryNames[cat.category] || cat.label || cat.category}</span>
                      <span><b>{cat.done || 0}</b>/{cat.total.toLocaleString()}</span>
                    </div>
                    <div className="home-side-bank-bar">
                      <div className="home-side-bank-track">
                        <div style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
                      </div>
                      <em>{pct}%</em>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="home-side-metrics">
          <h4>数据纵览</h4>
          <div className="home-side-metrics-grid">
            {[
              { label: "今日新增", val: stats.todayAdded || 0, color: "var(--info)" },
              { label: "今日已练", val: Number(todayStats.total || 0), color: "var(--warning)" },
              { label: "正确题数", val: stats.correctCount, color: "var(--success)" },
              { label: "错题数", val: stats.wrongCount, color: "var(--danger)" },
            ].map((item) => (
              <div key={item.label} className="home-side-metric">
                <span style={{ color: item.color }}>{item.label}</span>
                <strong>{item.val}</strong>
              </div>
            ))}
          </div>
        </div>
      </aside>
      {graphOpen && <KnowledgeGraphOverlay
        graph={knowledgeGraph}
        focusCategory={graphFocusCategory}
        focusLabel={graphFocusLabel}
        onClose={() => setGraphOpen(false)}
        onOpenQuestions={(node) => {
          setGraphOpen(false);
          if (typeof onStartKnowledgePractice === 'function') onStartKnowledgePractice(node);
        }}
      />}
    </>
  );
}
