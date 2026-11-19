import React, { useState, useEffect, useRef } from 'react';
import RichQuestionContent from '../components/RichQuestionContent.jsx';
import SubjectiveGrader from '../components/SubjectiveGrader.jsx';
import QuestionAnswerPanel from '../components/QuestionAnswerPanel.jsx';
import { useDialog } from '../components/DialogProvider.jsx';
import { getState } from '../store/examStore.js';
import { hasQuestionAnswer, isAnswerSupplemented } from '../utils/questionAnswer.js';

// ─── Constants ────────────────────────────────────────────────────────────────
const CAT_NAMES = {
  math: '数学',
  english: '英语',
  politics: '政治',
  major: '专业课',
};
const CAT_COLORS = {
  math: { color: 'var(--accent)', bg: 'var(--accent-soft-bg)', soft: 'var(--accent-soft-bg-strong)', border: 'var(--accent-border-soft)' },
  english: { color: 'var(--info)', bg: 'var(--info-soft)', soft: 'var(--info-soft)', border: 'var(--info-border)' },
  politics: { color: 'var(--success)', bg: 'var(--success-soft)', soft: 'var(--success-soft)', border: 'var(--success-border)' },
  major: { color: 'var(--warning)', bg: 'var(--warning-soft)', soft: 'var(--warning-soft)', border: 'var(--warning-border)' },
  default:  { color: 'var(--accent)', bg: 'var(--accent-soft-bg)', soft: 'var(--accent-soft-bg-strong)', border: 'var(--accent-border-soft)' },
};

// ─── Svg icons ────────────────────────────────────────────────────────────────
const Ico = ({ d, size = 14, sw = 1.8, col = 'currentColor', extra }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke={col} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
    {d}{extra}
  </svg>
);

const toMultipleKeys = (value) => {
  if (Array.isArray(value)) return [...new Set(value.map(v => String(v || '').trim()).filter(Boolean))].sort();
  if (value && typeof value === 'object') return toMultipleKeys(value.userAnswer ?? value.answer ?? '');
  const raw = String(value || '').trim();
  if (!raw) return [];
  if (/^[A-Z]+$/i.test(raw) && raw.length > 1) {
    return [...new Set(raw.toUpperCase().split('').filter(Boolean))].sort();
  }
  return [...new Set(raw.split(/[,，\s|/]+/).map(v => v.trim()).filter(Boolean))].sort();
};

const normalizeAnswerByType = (value, type) => {
  if (type === 'multiple') return toMultipleKeys(value);
  if (value && typeof value === 'object') return String(value.userAnswer ?? value.answer ?? '').trim();
  return String(value || '').trim();
};

// 导入题 / AI 出卷对主观题的命名不完全一致，统一归到「不打字、可传图批改」这一类
const SUBJECTIVE_TYPES = ['subjective', 'essay', 'short_answer', 'short-answer', 'writing', '论述', '简答'];
const isSubjectiveType = (type) => SUBJECTIVE_TYPES.includes(String(type || '').toLowerCase());
const isAnswered = (value, type) => (type === 'multiple' ? (Array.isArray(value) ? value.length > 0 : toMultipleKeys(value).length > 0) : Boolean(String(value || '').trim()));

const isCorrectAnswer = (userAnswer, correctAnswer, type) => {
  if (isSubjectiveType(type)) return null;
  // 没有标准答案（例如导入时只识别到题干）按「不自动判分」处理，
  // 不能因为答案为空就一律判错，否则这些题会污染错题本。
  if (!String(correctAnswer || '').trim()) return null;
  if (type === 'multiple') {
    const ua = toMultipleKeys(userAnswer);
    const ca = toMultipleKeys(correctAnswer);
    return ua.length === ca.length && ua.every((item, idx) => item === ca[idx]);
  }
  return String(userAnswer || '').trim() === String(correctAnswer || '').trim();
};

const formatAnswerForDisplay = (answer, type) => {
  if (type === 'multiple') {
    const keys = toMultipleKeys(answer);
    return keys.length ? keys.join(',') : '';
  }
  return String(answer || '').trim();
};

const normalizeSavedAnswers = (rawAnswers, allQuestions = []) => {
  const normalized = {};
  const questionTypeMap = new Map(allQuestions.map((q) => [q.id, q.type]));
  Object.entries(rawAnswers || {}).forEach(([questionId, value]) => {
    const qType = questionTypeMap.get(questionId) || 'single';
    const next = normalizeAnswerByType(value, qType);
    if (isAnswered(next, qType)) normalized[questionId] = next;
  });
  return normalized;
};

// ─── Main component ───────────────────────────────────────────────────────────
export default function ExamRoom({ paperId, questions: propQuestions, config, resumeRecord, onFinish, onExit, onAskAI, onSwitchToPractice }) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers]           = useState({});
  const [timeElapsed, setTimeElapsed]   = useState(0);
  const [timeLeft, setTimeLeft]         = useState(null);
  const [questions, setQuestions]       = useState([]);
  const [paper, setPaper]               = useState(null);
  const [showAnalysis, setShowAnalysis] = useState(false);
  const [layoutMode, setLayoutMode]     = useState('split');
  const [sessionId, setSessionId]       = useState(() => resumeRecord?.id || `record_${Date.now()}`);
  const [sessionStartTime, setSessionStartTime] = useState(() => resumeRecord?.start_time || resumeRecord?.startTime || new Date().toISOString());
  // 作答状态同时写一份 ref：选项点击后要立刻落库，等 React state 更新会拿到旧值
  const answersRef = useRef({});
  const { confirm: showConfirm, alert: showAlert } = useDialog();
  const bodyRef = useRef(null);
  const resumeAppliedRef = useRef(false);
  const autoSubmitRef = useRef(false);
  const persistentPaperId = config?.sourcePaperId || paperId || null;
  const isMemorizeMode  = config?.mode === 'memorize';
  const isMockMode = config?.mode === 'mock';
  // 看题模式：导入后默认进入，只读浏览，不计时、不交卷、不要求做完
  const isReviewMode = config?.mode === 'review';
  const isBrowseMode = isReviewMode || isMemorizeMode;
  const isWrongRedo = config?.mode === 'wrong-redo';
  // 只读看题不写练习记录，否则题库列表会平白多出一条「继续作答」
  const canPersist = !isReviewMode && (Boolean(persistentPaperId) || Boolean(config?.category) || isWrongRedo || Boolean(propQuestions?.length));
  const durationMinutes = Math.max(1, Number(config?.durationMinutes || paper?.duration || 120));

  useEffect(() => {
    setSessionId(resumeRecord?.id || `record_${Date.now()}`);
    setSessionStartTime(resumeRecord?.start_time || resumeRecord?.startTime || new Date().toISOString());
    resumeAppliedRef.current = false;
    autoSubmitRef.current = false;
    answersRef.current = {};
    setAnswers({});
    setTimeElapsed(0);
    setCurrentIndex(0);
    setShowAnalysis(isBrowseMode && !isMockMode);
    let loadedQuestions = [];
    if (propQuestions?.length > 0) {
      loadedQuestions = propQuestions;
      setQuestions(propQuestions);
      setPaper({ title: config?.title || `${CAT_NAMES[config?.category] || '专项'}练习`, type: 'practice', duration: durationMinutes });
    } else if (paperId) {
      const state = getState();
      loadedQuestions = state.currentQuestions || [];
      setQuestions(loadedQuestions);
      setPaper(state.currentPaper);
    }
    // 从题库「缺答案」入口进来时，直接定位到第一道没有答案的题
    if (config?.startAtMissing) {
      const firstMissing = loadedQuestions.findIndex((item) => !hasQuestionAnswer(item));
      if (firstMissing >= 0) setCurrentIndex(firstMissing);
    }
  }, [paperId, propQuestions, config, durationMinutes, isMemorizeMode, isMockMode, isReviewMode]);

  useEffect(() => {
    if (!isMockMode) {
      setTimeLeft(null);
      return;
    }
    const totalSeconds = durationMinutes * 60;
    const used = Math.max(0, Number(resumeRecord?.duration || 0));
    setTimeLeft(Math.max(0, totalSeconds - used));
  }, [isMockMode, durationMinutes, resumeRecord]);

  const currentQuestion = questions[currentIndex];

  // 补答案后把最新题目回写到当前列表，答题卡/答案区立即更新
  const handleQuestionUpdated = (updated) => {
    if (!updated?.id) return;
    setQuestions((prev) => prev.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)));
  };

  useEffect(() => {
    if (!currentQuestion) return;
    try {
      const payload = {
        questionId: currentQuestion.id,
        paperTitle: paper?.title || '',
        index: currentIndex + 1,
        total: questions.length,
        category: currentQuestion.category || config?.category || '',
        subCategory: currentQuestion.sub_category || currentQuestion.subCategory || config?.subCategory || '',
        content: currentQuestion.content || '',
        options: Array.isArray(currentQuestion.options) ? currentQuestion.options : [],
        answer: currentQuestion.answer || '',
        analysis: currentQuestion.analysis || '',
        userAnswer: formatAnswerForDisplay(answers[currentQuestion.id], currentQuestion.type),
        updatedAt: new Date().toISOString(),
      };
      localStorage.setItem('openexam_question_context', JSON.stringify(payload));
    } catch (error) {
      // ignore
    }
  }, [answers, config?.category, config?.subCategory, currentIndex, currentQuestion, paper?.title, questions.length]);

  useEffect(() => {
    const t = setInterval(() => {
      setTimeElapsed((s) => s + 1);
      if (!isMockMode) return;
      setTimeLeft((left) => {
        if (left === null) return left;
        if (left <= 1) return 0;
        return left - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [isMockMode]);

  useEffect(() => {
    if (resumeAppliedRef.current || !questions.length || !resumeRecord) return;
    const restoredAnswers = normalizeSavedAnswers(resumeRecord.answers, questions);
    const answeredIndexes = new Set(Object.keys(restoredAnswers));
    const firstPendingIndex = questions.findIndex(q => !answeredIndexes.has(q.id));
    answersRef.current = restoredAnswers;
    setAnswers(restoredAnswers);
    setTimeElapsed(Math.max(0, Number(resumeRecord.duration || 0)));
    if (firstPendingIndex >= 0) setCurrentIndex(firstPendingIndex);
    resumeAppliedRef.current = true;
  }, [questions, resumeRecord]);

  const formatTime = s => {
    const safe = Math.max(0, Number(s) || 0);
    const h = Math.floor(safe / 3600), m = Math.floor((safe % 3600) / 60), ss = safe % 60;
    return `${h > 0 ? h.toString().padStart(2,'0') + ':' : ''}${m.toString().padStart(2,'0')}:${ss.toString().padStart(2,'0')}`;
  };

  const buildPersistMeta = () => ({
    mode: config?.mode || 'practice',
    title: config?.title || paper?.title || '',
    questionIds: questions.map((q) => q.id),
    questions: isWrongRedo ? questions : undefined,
    durationMinutes: isMockMode ? durationMinutes : undefined,
  });

  const collectResultStats = (answerMap = answers) => {
    let correctCount = 0;
    let answeredCount = 0;
    let unansweredCount = 0;
    let subjectiveCount = 0;
    const wrongQuestions = [];
    const reviewOutcomes = [];
    questions.forEach((q) => {
      const userAnswer = answerMap[q.id];
      // 主观题在纸上作答，不算「未作答」，也不参与自动判分
      if (isSubjectiveType(q.type)) {
        subjectiveCount++;
        return;
      }
      if (!isAnswered(userAnswer, q.type)) {
        unansweredCount++;
        if (isWrongRedo) reviewOutcomes.push({ questionId: q.id, outcome: 'again' });
        return;
      }
      answeredCount++;
      const correct = isCorrectAnswer(userAnswer, q.answer, q.type);
      if (correct === null) return;
      if (correct) {
        correctCount++;
        if (isWrongRedo) reviewOutcomes.push({ questionId: q.id, outcome: 'remembered' });
      } else {
        wrongQuestions.push({
          questionId: q.id,
          paperId: q.paper_id || persistentPaperId,
          userAnswer: formatAnswerForDisplay(userAnswer, q.type),
          correctAnswer: formatAnswerForDisplay(q.answer, q.type),
          // 附带题目快照：错题库不依赖题库表，删除试卷后错题仍完整可复习
          snapshot: {
            type: q.type,
            content: q.content,
            contentHtml: q.content_html,
            options: q.options,
            analysis: q.analysis,
            analysisHtml: q.analysis_html,
            category: q.category,
            subCategory: q.sub_category,
            answer: q.answer,
          },
        });
        if (isWrongRedo) reviewOutcomes.push({ questionId: q.id, outcome: 'again' });
      }
    });
    return { correctCount, answeredCount, unansweredCount, subjectiveCount, wrongQuestions, reviewOutcomes };
  };

  const persistProgress = async (status, answerMap = answers, elapsed = timeElapsed) => {
    if (!window.openexam?.db?.savePracticeRecord || !canPersist) return;
    const { correctCount, subjectiveCount } = collectResultStats(answerMap);
    const totalCount = questions.length;
    // 主观题交给用户自评，先不计入正确率分母，和结果页口径保持一致
    const gradedCount = Math.max(totalCount - subjectiveCount, 0);
    const accuracy = gradedCount > 0 ? Math.round((correctCount / gradedCount) * 100) : 0;
    await window.openexam.db.savePracticeRecord({
      id: sessionId,
      paperId: persistentPaperId,
      category: config?.category || null,
      subCategory: config?.subCategory || null,
      startTime: sessionStartTime,
      endTime: (status === 'completed' || status === 'awaiting_review' || status === 'abandoned') ? new Date().toISOString() : null,
      duration: elapsed,
      status,
      answers: answerMap,
      correctCount,
      totalCount,
      accuracy,
      score: accuracy,
      meta: buildPersistMeta(),
    });
  };

  const handleSelect = async (key) => {
    if (!currentQuestion) return;
    const prev = answersRef.current || {};
    const next = { ...prev };
    if (currentQuestion.type === 'multiple') {
      const selected = toMultipleKeys(prev[currentQuestion.id]);
      const exists = selected.includes(key);
      const updated = exists ? selected.filter((item) => item !== key) : [...selected, key].sort();
      if (updated.length) next[currentQuestion.id] = updated;
      else delete next[currentQuestion.id];
    } else {
      next[currentQuestion.id] = key;
    }
    answersRef.current = next;
    setAnswers(next);
    if (!isMockMode && !isSubjectiveType(currentQuestion.type)) setShowAnalysis(true);
    if (canPersist) {
      try { await persistProgress('ongoing', next); } catch (err) { console.error('保存进度失败:', err); }
    }
  };

  const handleTextAnswer = (value) => {
    if (!currentQuestion) return;
    const next = { ...(answersRef.current || {}), [currentQuestion.id]: value };
    answersRef.current = next;
    setAnswers(next);
  };

  const persistTextAnswer = async () => {
    if (!currentQuestion || !canPersist) return;
    try { await persistProgress('ongoing', answersRef.current || {}); } catch (err) { console.error('保存文字答案失败:', err); }
  };

  // 重置本题：清掉这一题的作答，题目本身保留，可以重新做
  const resetQuestionAnswer = async () => {
    if (!currentQuestion) return;
    const next = { ...(answersRef.current || {}) };
    delete next[currentQuestion.id];
    answersRef.current = next;
    setAnswers(next);
    setShowAnalysis(false);
    if (canPersist) {
      try { await persistProgress('ongoing', next); } catch (err) { console.error('重置本题失败:', err); }
    }
  };

  // 重置整份：清掉本次所有作答与进度，题目顺序和内容不变
  const resetAllAnswers = async () => {
    if (!answeredCount) return;
    const confirmed = await showConfirm({
      title: '重置整份练习',
      message: '会清空本次所有作答和答题进度，题目本身保留，重置后可以从第一题重新做。',
      confirmText: '重置',
      cancelText: '取消',
      tone: 'warning',
    });
    if (!confirmed) return;
    answersRef.current = {};
    setAnswers({});
    setCurrentIndex(0);
    setShowAnalysis(false);
    if (canPersist) {
      try { await persistProgress('ongoing', {}); } catch (err) { console.error('重置整份练习失败:', err); }
    }
  };

  const goPrev = () => { if (currentIndex > 0) { setCurrentIndex(i => i - 1); setShowAnalysis(isBrowseMode && !isMockMode); bodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); } };
  const goNext = () => { if (currentIndex < questions.length - 1) { setCurrentIndex(i => i + 1); setShowAnalysis(isBrowseMode && !isMockMode); bodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); } };
  const goToQ  = i => { setCurrentIndex(i); setShowAnalysis(isBrowseMode && !isMockMode); bodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); };

  const doSubmit = async (forced = false) => {
    const latestAnswers = answersRef.current || answers;
    const { correctCount, unansweredCount, subjectiveCount, wrongQuestions, reviewOutcomes } = collectResultStats(latestAnswers);
    const gradedCount = Math.max(questions.length - subjectiveCount, 0);
    const accuracy = gradedCount > 0 ? Math.round((correctCount / gradedCount) * 100) : 0;
    // 只要还有主观题没自评，就只能算「待自评」，不能落成已完成
    const nextStatus = subjectiveCount > 0 ? 'awaiting_review' : 'completed';
    const result = {
      totalCount: questions.length,
      correctCount,
      wrongCount: wrongQuestions.length,
      // 主观题写在纸上，交卷后到结果页自评，这里先按「待自评」计
      pendingReviewCount: subjectiveCount,
      unanswered: unansweredCount,
      accuracy,
      status: nextStatus,
      timeElapsed,
      answers: latestAnswers,
      questions,
      config,
      paperTitle: paper?.title || config?.title || '',
      // 结果页手动判对错后要回写这条练习记录的分数
      recordId: canPersist ? sessionId : null,
    };
    try {
      await persistProgress(nextStatus, latestAnswers);
      if (isWrongRedo) {
        for (const item of reviewOutcomes) {
          await window.openexam.db.reviewWrongQuestion({ questionId: item.questionId, outcome: item.outcome });
        }
      } else {
        for (const wq of wrongQuestions) await window.openexam.db.addWrongQuestion(wq);
      }
    } catch (err) {
      console.error('保存失败:', err);
    }
    if (forced && showAlert) {
      await showAlert({ title: '时间到', message: '模考时间已到，系统已自动交卷。', tone: 'warning' });
    }
    onFinish(result);
  };

  const handleSubmit = async () => {
    const { unansweredCount, subjectiveCount } = collectResultStats();
    const detail = [
      unansweredCount > 0 ? `还有 ${unansweredCount} 题没在应用里作答` : '',
      subjectiveCount > 0 ? `${subjectiveCount} 道主观题写在纸上，结果页自行判对错` : '',
    ].filter(Boolean).join('，');
    const confirmed = await showConfirm({
      title: '结束本次练习',
      message: detail
        ? `${detail}。全在纸上作答也没关系，结果页可以逐题对答案、自己判对错。`
        : '结束后会生成本次练习的结果页，可以逐题对答案。',
      confirmText: '查看结果',
      cancelText: '继续做题',
      tone: 'info',
    });
    if (!confirmed) return;
    await doSubmit(false);
  };

  useEffect(() => {
    if (!isMockMode || timeLeft === null || timeLeft > 0 || autoSubmitRef.current || !questions.length) return;
    autoSubmitRef.current = true;
    doSubmit(true);
  }, [isMockMode, timeLeft, questions.length]);

  const handleExit = async () => {
    // 看题页随时可走，不需要二次确认，也不保存任何答题进度
    if (isReviewMode) { onExit(); return; }
    const confirmed = await showConfirm({
      title: '确认退出',
      message: canPersist ? '会自动保存当前进度，下次可继续作答。确定退出吗？' : '当前答题进度将丢失，确定退出吗？',
      confirmText: canPersist ? '保存并退出' : '确认退出',
      cancelText: '继续作答',
      tone: canPersist ? 'warning' : 'danger',
    });
    if (!confirmed) return;
    if (canPersist) {
      try { await persistProgress('paused'); } catch (err) { console.error('保存退出进度失败:', err); }
    }
    onExit();
  };

  const handleAskAI = async (intent = 'explain') => {
    if (canPersist) {
      try { await persistProgress('paused'); } catch (err) { console.error('暂存进度失败:', err); }
    }
    if (typeof onAskAI === 'function') {
      onAskAI(currentQuestion, {
        paperTitle: paper?.title || config?.title || '',
        index: currentIndex + 1,
        total: questions.length,
        userAnswer: formatAnswerForDisplay(answers[currentQuestion?.id], currentQuestion?.type),
        // 试卷所属科目：AI 助教据此给新会话打学科标记
        subjectId: paper?.subject_id || paper?.subjectId || config?.subjectId || '',
        prompt: intent === 'subjective_grade'
          ? '请批改我的主观题答案：先复述评分标准或参考答案，再逐点判断我的答案是否覆盖关键得分点，指出错误和遗漏，给出可执行的修改建议。不要只给分数。'
          : undefined,
      });
      return;
    }
    // 没接 AI 入口时不能静默失败：把题目与问题存下来，并明确告诉用户从哪里进入
    try {
      if (currentQuestion) {
        localStorage.setItem('openexam_question_context', JSON.stringify({
          questionId: currentQuestion.id || '',
          paperTitle: paper?.title || config?.title || '',
          index: currentIndex + 1,
          total: questions.length,
          category: currentQuestion.category || '',
          subCategory: currentQuestion.sub_category || currentQuestion.subCategory || '',
          content: currentQuestion.content || '',
          options: Array.isArray(currentQuestion.options) ? currentQuestion.options : [],
          answer: currentQuestion.answer || '',
          analysis: currentQuestion.analysis || '',
          userAnswer: formatAnswerForDisplay(answers[currentQuestion?.id], currentQuestion?.type),
          subjectId: paper?.subject_id || paper?.subjectId || config?.subjectId || '',
          updatedAt: new Date().toISOString(),
        }));
      }
      localStorage.setItem('openexam_ai_autofill', JSON.stringify({
        prompt: '请讲解这道题：拆解考点、说明为什么选这个答案、再给一个类似练习。',
        at: Date.now(),
      }));
    } catch (error) {}
    showAlert({
      title: '暂时无法直接打开 AI 助教',
      message: '当前页面没有接入 AI 助教入口。请从左侧导航打开「AI 助教」，刚才的题目和问题已经带过去了。',
      tone: 'warning',
    });
  };

  if (!currentQuestion || questions.length === 0) {
    return <div style={{ display: 'grid', placeItems: 'center', height: '100vh', color: 'var(--muted)', fontSize: 13 }}>加载中…</div>;
  }

  // 主观题写在纸上，App 里没有可填的内容，进度上按「已完成」算，避免永远差几题
  const isDoneInApp     = (q) => isSubjectiveType(q.type) || isAnswered(answers[q.id], q.type);
  const answeredCount   = questions.filter(isDoneInApp).length;
  const progressPercent = Math.round((answeredCount / questions.length) * 100);
  const catPalette      = CAT_COLORS[currentQuestion?.category] || CAT_COLORS.default;
  const timerUrgent = isMockMode && timeLeft !== null && timeLeft <= 300;

  // ── Group questions by category for sidebar ──
  const grouped = questions.reduce((acc, q, idx) => {
    const cat = q.category || 'other';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push({ ...q, _idx: idx });
    return acc;
  }, {});

  // ── Per-category stats ──
  const catStats = Object.entries(grouped).map(([cat, qs]) => ({
    cat,
    name: CAT_NAMES[cat] || cat,
    total: qs.length,
    done: qs.filter(q => isSubjectiveType(q.type) || isAnswered(answers[q.id], q.type)).length,
    palette: CAT_COLORS[cat] || CAT_COLORS.default,
  }));

  // ── Option rendering ──
  const renderOptions = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      {currentQuestion.options.map(opt => {
        const selectedKeys = currentQuestion.type === 'multiple' ? toMultipleKeys(answers[currentQuestion.id]) : [answers[currentQuestion.id]].filter(Boolean);
        const correctKeys = currentQuestion.type === 'multiple' ? toMultipleKeys(currentQuestion.answer) : [currentQuestion.answer].filter(Boolean);
        const isSelected = selectedKeys.includes(opt.key);
        const isCorrect  = correctKeys.includes(opt.key);
        const showResult = !isMockMode && (isBrowseMode || (isAnswered(answers[currentQuestion.id], currentQuestion.type) && showAnalysis));

        let border = '1px solid var(--line)', bg = 'var(--surface)', tagBg = 'var(--surface-soft)', tagCol = 'var(--muted)';
        if (showResult) {
          if (isCorrect)       { border = '1.5px solid var(--success)'; bg = 'var(--success-soft)'; tagBg = 'var(--success)'; tagCol = '#fff'; }
          else if (isSelected) { border = '1.5px solid var(--danger)'; bg = 'var(--danger-soft)'; tagBg = 'var(--danger)'; tagCol = '#fff'; }
        } else if (isSelected)   { border = '1.5px solid var(--accent)'; bg = 'var(--accent-soft-bg)'; tagBg = 'var(--accent)'; tagCol = '#fff'; }

        return (
          <button key={opt.key} onClick={() => handleSelect(opt.key)} style={{
            display: 'flex', alignItems: 'flex-start', gap: 12, padding: '11px 14px',
            borderRadius: 10, border, background: bg,
            textAlign: 'left', cursor: showResult ? 'default' : 'pointer', transition: 'all 0.18s',
            boxShadow: isSelected && !showResult ? '0 8px 18px rgba(15,23,42,0.08)' : 'none',
          }}
            onMouseOver={e => { if (!showResult && !isSelected) e.currentTarget.style.borderColor = 'var(--accent)'; }}
            onMouseOut={e => { if (!showResult && !isSelected) e.currentTarget.style.borderColor = 'var(--line)'; }}>
            <span style={{ width: 22, height: 22, borderRadius: 5, flexShrink: 0, display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700, background: tagBg, color: tagCol, transition: 'all 0.18s' }}>
              {opt.key}
            </span>
            <RichQuestionContent value={opt.content} className="rich-question-option" style={{ fontSize: 13, lineHeight: 1.65, color: 'var(--text)', paddingTop: 1, flex: 1 }} />
          </button>
        );
      })}
    </div>
  );

  const renderTextResponse = () => {
    // 主观题不要求输入文字：写在纸上作答，答案留到交卷后的结果页再对；想让 AI 批改再传手写照片
    if (isSubjectiveType(currentQuestion.type)) {
      return (
        <SubjectiveGrader
          question={currentQuestion}
          answerVisible={isBrowseMode}
          onAskAI={() => handleAskAI('explain')}
        />
      );
    }
    const value = String(answers[currentQuestion.id] || '');
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input
          value={value}
          onChange={(event) => handleTextAnswer(event.target.value)}
          onBlur={persistTextAnswer}
          placeholder="填写答案"
          style={{ width: '100%', boxSizing: 'border-box', padding: '12px 14px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--surface)', color: 'var(--text)', font: 'inherit', fontSize: 13 }}
        />
        {!isReviewMode && !isMockMode && (
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>答案和解析在交卷后的「对答案」里给，先自己做完。</span>
        )}
      </div>
    );
  };

  // ── Analysis card ──
  const renderAnalysis = () => {
    if (isMockMode) return null;
    const isSubjective = isSubjectiveType(currentQuestion.type);
    // 做题时不给答案：只有看题 / 背题模式直接展示，或客观题「答完之后」才展开；
    // 主观题在 App 里没有作答动作，答案统一留到交卷后的结果页对答案
    if (!isBrowseMode && !showAnalysis) return null;
    const isRight = isCorrectAnswer(answers[currentQuestion.id], currentQuestion.answer, currentQuestion.type);
    return (
      <div style={{ marginTop: 20, padding: '16px 18px', background: 'var(--accent-soft-bg)', borderRadius: 10, border: '1px solid var(--accent-border-soft)', animation: 'fadeIn 0.25s ease-out' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
          {!isSubjective && isAnswered(answers[currentQuestion.id], currentQuestion.type) ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, padding: '3px 9px', borderRadius: 5, color: isRight ? 'var(--success)' : 'var(--danger)', background: isRight ? 'var(--success-soft)' : 'var(--danger-soft)' }}>
              {isRight
                ? <><Ico d={<polyline points="20 6 9 17 4 12"/>} size={12} sw={2.5} col="var(--success)"/>回答正确</>
                : <><Ico d={<><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></>} size={12} sw={2.5} col="var(--danger)"/>回答错误</>
              }
            </span>
          ) : null}
          <div style={{ flex: 1, minWidth: 0 }}>
            <QuestionAnswerPanel
              question={currentQuestion}
              onUpdated={handleQuestionUpdated}
              editable
              compact
              label={isSubjective ? '【参考答案】' : '【答案】'}
            />
          </div>
        </div>
        {(currentQuestion.analysis_html || currentQuestion.analysis) && (
          <div style={{ fontSize: 12, lineHeight: 1.85, color: 'var(--muted)' }}>
            <div className="tb-label tb-label-plain" style={{ fontSize: 12, marginBottom: 6 }}>【解析】</div>
            <RichQuestionContent value={currentQuestion.analysis_html || currentQuestion.analysis} className="rich-question-analysis" />
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100%', background: 'var(--surface)', overflow: 'hidden' }}>

      {/* ═══ TOP BAR ═══ */}
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 20px 0 80px', height: 52, borderBottom: '1px solid var(--line)', background: 'var(--surface)', flexShrink: 0, zIndex: 10, WebkitAppRegion: 'drag' }}>
        {/* Exit */}
        <button onClick={isReviewMode ? onExit : handleExit} style={{ WebkitAppRegion: 'no-drag', display: 'flex', alignItems: 'center', gap: 5, background: 'transparent', border: '1px solid var(--line)', padding: '5px 13px', borderRadius: 16, fontSize: 12, fontWeight: 500, color: 'var(--text)', cursor: 'pointer', transition: 'all 0.2s' }}
          onMouseOver={e => e.currentTarget.style.background = 'var(--surface-soft)'}
          onMouseOut={e => e.currentTarget.style.background = 'transparent'}>
          <Ico d={<><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></>} size={13} sw={2} />
          {isReviewMode ? '返回题库' : '退出'}
        </button>

        {/* Title */}
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', letterSpacing: '0.5px' }}>
          {isReviewMode ? `看题 · ${paper?.title || config?.title || ''}` : paper?.title}
        </div>

        {/* Right controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, WebkitAppRegion: 'no-drag' }}>
          {/* Layout toggle */}
          <div style={{ display: 'flex', background: 'var(--surface-soft)', borderRadius: 7, padding: 3, gap: 2 }}>
            {[
              { key: 'centered', tip: '居中', icon: <><rect x="6" y="4" width="12" height="16" rx="2"/></> },
              { key: 'full',     tip: '展宽', icon: <><rect x="2" y="4" width="20" height="16" rx="2"/></> },
              { key: 'split',    tip: '分屏', icon: <><rect x="2" y="4" width="8" height="16" rx="2"/><rect x="14" y="4" width="8" height="16" rx="2"/></> },
            ].map(m => (
              <button key={m.key} title={m.tip} onClick={() => setLayoutMode(m.key)} style={{ width: 28, height: 28, borderRadius: 5, border: 'none', cursor: 'pointer', display: 'grid', placeItems: 'center', background: layoutMode === m.key ? 'var(--surface)' : 'transparent', color: layoutMode === m.key ? 'var(--accent)' : 'var(--muted)', boxShadow: layoutMode === m.key ? '0 1px 4px rgba(0,0,0,0.07)' : 'none', transition: 'all 0.2s' }}>
                <Ico d={m.icon} size={14} sw={1.5} />
              </button>
            ))}
          </div>

          <button onClick={() => handleAskAI('explain')} title="问 AI" style={{ padding: '5px 12px', borderRadius: 16, border: '1px solid var(--accent-border-soft)', background: 'var(--accent-soft-bg)', color: 'var(--accent)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
            问 AI
          </button>

          {/* Timer：看题模式不计时，避免制造「必须做完」的压力 */}
          {!isReviewMode && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 12px', background: timerUrgent ? 'var(--danger-soft)' : 'var(--accent-soft-bg)', borderRadius: 16, color: timerUrgent ? 'var(--danger)' : 'var(--accent)', fontSize: 13, fontWeight: 700, fontFamily: 'monospace' }}>
              <Ico d={<><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></>} size={13} sw={2} col={timerUrgent ? 'var(--danger)' : 'var(--accent)'} />
              {isMockMode ? formatTime(timeLeft ?? 0) : formatTime(timeElapsed)}
            </div>
          )}

          {/* 看题页不交卷；想做题时一键切到练习模式 */}
          {isReviewMode ? (
            <button
              onClick={() => onSwitchToPractice?.()}
              disabled={!onSwitchToPractice}
              title="切到做题模式，选择/填空题可作答"
              style={{ padding: '7px 20px', borderRadius: 16, background: 'var(--accent)', color: '#fff', border: 'none', fontSize: 13, fontWeight: 600, cursor: onSwitchToPractice ? 'pointer' : 'default', opacity: onSwitchToPractice ? 1 : 0.5 }}
            >
              开始作答
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={resetQuestionAnswer}
                disabled={!currentQuestion || !isAnswered(answers[currentQuestion.id], currentQuestion.type)}
                title="清空当前题的作答，题目保留"
                style={{ padding: '5px 11px', borderRadius: 16, border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--muted)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
              >
                重置本题
              </button>
              <button
                type="button"
                onClick={resetAllAnswers}
                disabled={answeredCount === 0}
                title="清空本次所有作答"
                style={{ padding: '5px 11px', borderRadius: 16, border: '1px solid var(--danger-border)', background: 'var(--danger-soft)', color: 'var(--danger)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
              >
                重置整份
              </button>
              <button onClick={handleSubmit} style={{ padding: '7px 20px', borderRadius: 16, background: 'var(--accent)', color: '#fff', border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', boxShadow: '0 10px 20px rgba(15,23,42,0.1)', transition: 'transform 0.1s' }}
                onPointerDown={e => e.currentTarget.style.transform = 'scale(0.96)'}
                onPointerUp={e => e.currentTarget.style.transform = ''}>
                完成练习
              </button>
            </>
          )}
        </div>
      </header>

      {/* ═══ BODY ═══ */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>

        {/* ── LEFT SIDEBAR ── */}
        <aside style={{ width: 230, background: 'var(--surface-soft)', borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column', flexShrink: 0, overflow: 'hidden' }}>

          {/* Progress header */}
          <div style={{ padding: '16px 16px 12px', borderBottom: '1px solid var(--line)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.5px' }}>{isReviewMode ? '浏览进度' : '答题进度'}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent)', fontFamily: 'monospace' }}>
                {isReviewMode ? currentIndex + 1 : answeredCount}<span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400 }}> / {questions.length}</span>
              </span>
            </div>
            {/* Progress bar */}
            <div style={{ width: '100%', height: 4, background: 'var(--accent-soft-bg)', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: `${isReviewMode ? Math.round(((currentIndex + 1) / Math.max(1, questions.length)) * 100) : progressPercent}%`, height: '100%', background: 'var(--accent)', borderRadius: 4, transition: 'width 0.4s ease' }} />
            </div>
            <div style={{ marginTop: 7, fontSize: 10, color: 'var(--muted)' }}>
              {isReviewMode ? '随看随停，不用做完，也不用交卷' : (
                <>{progressPercent}% 已完成 · 用时 <span style={{ color: 'var(--text)', fontWeight: 600, fontFamily: 'monospace' }}>{formatTime(timeElapsed)}</span></>
              )}
            </div>
          </div>

          {/* Per-category mini stats：看题模式不需要统计答题情况 */}
          {!isReviewMode && (
          <div style={{ padding: '10px 16px 8px', borderBottom: '1px solid var(--line)' }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.5px', marginBottom: 7 }}>分类统计</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {catStats.map(cs => (
                <div key={cs.cat} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ width: 6, height: 6, borderRadius: 2, background: cs.palette.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 10, color: 'var(--muted)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cs.name}</span>
                  <span style={{ fontSize: 10, fontFamily: 'monospace', color: cs.done === cs.total ? cs.palette.color : 'var(--text)', fontWeight: cs.done === cs.total ? 700 : 400 }}>
                    {cs.done}/{cs.total}
                  </span>
                </div>
              ))}
            </div>
          </div>
          )}

          {/* Answer card — grouped by category */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '10px 16px 16px' }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.5px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 5 }}>
              <Ico d={<><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></>} size={11} sw={1.8} />
              {isReviewMode ? '题目目录' : '答题卡'}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {Object.entries(grouped).map(([cat, qs]) => {
                const pal = CAT_COLORS[cat] || CAT_COLORS.default;
                const name = CAT_NAMES[cat] || cat;
                const doneCnt = qs.filter(q => isSubjectiveType(q.type) || isAnswered(answers[q.id], q.type)).length;
                return (
                  <div key={cat}>
                    {/* Category label */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 7 }}>
                      <span style={{ width: 3, height: 12, borderRadius: 2, background: pal.color, flexShrink: 0 }} />
                      <span style={{ fontSize: 10, fontWeight: 600, color: pal.color }}>{name}</span>
                      <span style={{ fontSize: 9, color: 'var(--muted)', marginLeft: 'auto', fontFamily: 'monospace' }}>{doneCnt}/{qs.length}</span>
                    </div>
                    {/* Grid of question buttons */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 5 }}>
                      {qs.map(q => {
                        const isAnsweredFlag = isAnswered(answers[q.id], q.type);
                        const isCurrent  = q._idx === currentIndex;
                        const missingAnswer = !hasQuestionAnswer(q);
                        const supplemented = isAnswerSupplemented(q) && !missingAnswer;
                        const stateLabel = missingAnswer ? ' · 缺答案' : supplemented ? ' · 答案已补充' : '';
                        return (
                          <button key={q.id} onClick={() => goToQ(q._idx)} title={`第 ${q._idx + 1} 题${stateLabel}`}
                            style={{
                              position: 'relative',
                              aspectRatio: '1/1', borderRadius: 6, fontSize: 11, fontWeight: 600,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              cursor: 'pointer', transition: 'all 0.15s',
                              ...(isCurrent ? {
                                border: `2px solid ${pal.color}`, background: pal.color, color: '#fff',
                                boxShadow: '0 8px 18px rgba(15,23,42,0.1)',
                              } : isAnsweredFlag ? {
                                border: `1px solid ${pal.border}`, background: pal.bg, color: pal.color,
                              } : isSubjectiveType(q.type) ? {
                                // 主观题写在纸上，不显示「未答」
                                border: `1px dashed ${pal.border}`, background: 'var(--surface)', color: pal.color,
                              } : {
                                border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--muted)',
                              }),
                            }}>
                            {q._idx + 1}
                            {missingAnswer ? (
                              <span style={{ position: 'absolute', top: 2, right: 2, width: 6, height: 6, borderRadius: 3, background: 'var(--warning, #d97706)' }} />
                            ) : supplemented ? (
                              <span style={{ position: 'absolute', top: 2, right: 2, width: 6, height: 6, borderRadius: 3, background: 'var(--success, #059669)' }} />
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Legend */}
          {(() => {
            const legend = isReviewMode
              ? []
              : [
                  { label: '未答', border: '1px solid var(--line)', bg: 'var(--surface)' },
                  { label: '已答', border: '1px solid var(--accent-border-soft)', bg: 'var(--accent-soft-bg)' },
                  { label: '当前', border: '2px solid var(--accent)', bg: 'var(--accent)' },
                ];
            if (!isReviewMode && questions.some(q => isSubjectiveType(q.type))) {
              legend.push({ label: '主观题（纸面）', border: '1px dashed var(--line)', bg: 'var(--surface)' });
            }
            if (questions.some(q => !hasQuestionAnswer(q))) {
              legend.push({ label: '缺答案', dot: 'var(--warning, #d97706)' });
            }
            if (questions.some(q => isAnswerSupplemented(q) && hasQuestionAnswer(q))) {
              legend.push({ label: '答案已补充', dot: 'var(--success, #059669)' });
            }
            if (!legend.length) return null;
            return (
              <div style={{ padding: '10px 16px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {legend.map(l => (
                  <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 9, height: 9, borderRadius: l.dot ? 5 : 2, border: l.border, background: l.dot || l.bg, flexShrink: 0 }} />
                    <span style={{ fontSize: 10, color: 'var(--muted)' }}>{l.label}</span>
                  </div>
                ))}
              </div>
            );
          })()}
        </aside>

        {/* ── RIGHT: MAIN AREA ── */}
        <div ref={bodyRef} style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', position: 'relative' }}>
          <div style={{
            maxWidth: layoutMode === 'centered' ? 760 : layoutMode === 'full' ? 'none' : 'none',
            margin: layoutMode === 'centered' ? '0 auto' : '0',
            padding: '28px 36px 100px',
            display: 'flex', flexDirection: 'column', gap: 0, flex: 1,
            width: '100%', boxSizing: 'border-box',
          }}>

            {/* ── QUESTION CARD ── */}
            <div style={{
              background: 'var(--surface-soft)', borderRadius: 14, border: '1px solid var(--line)',
              overflow: 'hidden', marginBottom: 16,
            }}>
              {/* Category ribbon */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 20px', borderBottom: '1px solid var(--line)',
                background: catPalette.bg,
              }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 3 }}>
                  <span style={{ fontSize: 22, fontWeight: 800, color: catPalette.color, fontFamily: 'monospace', lineHeight: 1 }}>{currentIndex + 1}</span>
                  <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 500, fontFamily: 'monospace' }}>/{questions.length}</span>
                </div>
                <div style={{ width: 1, height: 14, background: catPalette.border }} />
                <span style={{ fontSize: 11, fontWeight: 600, color: catPalette.color, padding: '2px 8px', borderRadius: 5, background: catPalette.soft }}>
                  {currentQuestion.category ? (CAT_NAMES[currentQuestion.category] || currentQuestion.category) : '综合'}
                </span>
                <span style={{ fontSize: 10, color: 'var(--muted)', padding: '2px 7px', borderRadius: 5, background: 'var(--neutral-soft-bg)' }}>
                  {isSubjectiveType(currentQuestion.type) ? '主观题' : ({ single: '单选题', multiple: '多选题', judge: '判断题', fill: '填空题' }[currentQuestion.type] || '题目')}
                </span>
                {!hasQuestionAnswer(currentQuestion) ? (
                  <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--warning, #b45309)', padding: '2px 8px', borderRadius: 999, background: 'var(--warning-soft, #fef3c7)' }}>
                    缺答案
                  </span>
                ) : null}
                {isAnswerSupplemented(currentQuestion) && hasQuestionAnswer(currentQuestion) ? (
                  <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--success, #047857)', padding: '2px 8px', borderRadius: 999, background: 'var(--success-soft, #d1fae5)' }}>
                    答案已补充
                  </span>
                ) : null}
                {/* Difficulty dots if available */}
                {currentQuestion.difficulty && (
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 3, alignItems: 'center' }}>
                    <span style={{ fontSize: 10, color: 'var(--muted)' }}>难度</span>
                    {[1,2,3,4,5].map(d => (
                      <span key={d} style={{ width: 5, height: 5, borderRadius: '50%', background: d <= (currentQuestion.difficulty || 3) ? catPalette.color : 'var(--neutral-soft-bg)' }} />
                    ))}
                  </div>
                )}
              </div>

              {/* Shared material (资料分析) */}
              {currentQuestion.material_html ? (
                <div className="exam-material-block" style={{ margin: '0 20px 12px', padding: '12px 14px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--surface-soft)' }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.6px', marginBottom: 8 }}>材料</div>
                  <RichQuestionContent value={currentQuestion.material_html} className="rich-question-material" />
                </div>
              ) : null}
              {currentQuestion.category === 'ziliao' && !currentQuestion.has_material && !currentQuestion.material_html ? (
                <div style={{ margin: '0 20px 12px', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--warning-border)', background: 'var(--warning-soft)', color: 'var(--warning)', fontSize: 12, lineHeight: 1.55 }}>
                  本题缺少资料图表/文字材料，作答依据不完整。建议改做「资料分析」专项中已标注可练习的题目，或等待题库材料补齐。
                </div>
              ) : null}

              {/* Question text */}
              <div style={{ padding: '20px 20px 22px' }}>
                <RichQuestionContent value={currentQuestion.content_html || currentQuestion.content} style={{ fontSize: 14, lineHeight: 1.85, color: 'var(--text)', fontWeight: 500, letterSpacing: '0.15px', userSelect: 'text' }} />
              </div>
            </div>

            {/* ── OPTIONS ── */}
            <div style={{ marginBottom: 4 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.8px', marginBottom: 9 }}>
                {isReviewMode
                  ? '题目与参考答案'
                  : isSubjectiveType(currentQuestion.type)
                    ? '主观题 · 写在纸上作答'
                    : <>作答区域 {currentQuestion.type === 'multiple' && <span style={{ color: catPalette.color }}>（可多选）</span>}</>}
              </div>
              {currentQuestion.type === 'fill' || isSubjectiveType(currentQuestion.type)
                ? renderTextResponse()
                : renderOptions()}
            </div>

            {/* ── ANALYSIS ── */}
            {renderAnalysis()}

          </div>

          {/* ── BOTTOM NAV (sticky) ── */}
          <div style={{
            position: 'sticky', bottom: 0, left: 0, right: 0, height: 76,
            background: 'linear-gradient(to top, var(--surface) 55%, transparent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
            pointerEvents: 'none',
          }}>
            <button disabled={currentIndex === 0} onClick={goPrev} style={{
              pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 6,
              padding: '9px 22px', borderRadius: 20, background: 'var(--surface)',
              border: '1px solid var(--line)', color: currentIndex === 0 ? 'var(--muted)' : 'var(--text)',
              fontSize: 13, fontWeight: 600, cursor: currentIndex === 0 ? 'not-allowed' : 'pointer',
              boxShadow: '0 3px 10px rgba(0,0,0,0.06)', opacity: currentIndex === 0 ? 0.45 : 1,
              transition: 'all 0.2s',
            }}>
              <Ico d={<><path d="M19 12H5M12 19l-7-7 7-7"/></>} size={14} sw={2} />
              上一题
            </button>

            {/* Question counter pills */}
            <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
              {questions.slice(Math.max(0, currentIndex - 2), Math.min(questions.length, currentIndex + 3)).map((q, i) => {
                const idx = Math.max(0, currentIndex - 2) + i;
                const isCur = idx === currentIndex;
                return (
                  <button key={idx} onClick={() => goToQ(idx)} style={{
                    pointerEvents: 'auto',
                    width: isCur ? 28 : 22, height: 22, borderRadius: 11,
                    border: isCur ? '2px solid var(--accent)' : '1px solid var(--line)',
                    background: isCur ? 'var(--accent)' : isAnswered(answers[q.id], q.type) ? 'var(--accent-soft-bg)' : 'var(--surface)',
                    color: isCur ? '#fff' : 'var(--muted)',
                    fontSize: 10, fontWeight: 700, cursor: 'pointer', transition: 'all 0.15s',
                  }}>
                    {idx + 1}
                  </button>
                );
              })}
            </div>

            <button disabled={currentIndex === questions.length - 1} onClick={goNext} style={{
              pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 6,
              padding: '9px 22px', borderRadius: 20, background: 'var(--surface)',
              border: '1px solid var(--line)', color: currentIndex === questions.length - 1 ? 'var(--muted)' : 'var(--text)',
              fontSize: 13, fontWeight: 600, cursor: currentIndex === questions.length - 1 ? 'not-allowed' : 'pointer',
              boxShadow: '0 3px 10px rgba(0,0,0,0.06)', opacity: currentIndex === questions.length - 1 ? 0.45 : 1,
              transition: 'all 0.2s',
            }}>
              下一题
              <Ico d={<><path d="M5 12h14M12 5l7 7-7 7"/></>} size={14} sw={2} />
            </button>
          </div>
        </div>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes fadeIn { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.12); border-radius: 4px; }
      ` }} />
    </div>
  );
}
