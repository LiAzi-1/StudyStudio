import React, { useState, useEffect } from 'react';
import RichQuestionContent from '../components/RichQuestionContent.jsx';
import SubjectiveGrader from '../components/SubjectiveGrader.jsx';
import { getState } from '../store/examStore.js';
import { useAchievementUnlock } from '../components/AchievementUnlockCeremony.jsx';
import { normalizeAchievements } from '../utils/achievementUtils.js';
import { diffNewlyUnlocked } from '../utils/achievementUnlock.js';

const categoryNames = {
  math: '数学',
  english: '英语',
  politics: '政治',
  major: '专业课'
};

const categoryOrder = ['math', 'english', 'politics', 'major'];

const toMultipleKeys = (value) => {
  if (Array.isArray(value)) return [...new Set(value.map(v => String(v || '').trim()).filter(Boolean))].sort();
  if (value && typeof value === 'object') return toMultipleKeys(value.userAnswer ?? value.answer ?? '');
  const raw = String(value || '').trim();
  if (!raw) return [];
  if (/^[A-Z]+$/i.test(raw) && raw.length > 1) return [...new Set(raw.toUpperCase().split('').filter(Boolean))].sort();
  return [...new Set(raw.split(/[,，\s|/]+/).map(v => v.trim()).filter(Boolean))].sort();
};

const normalizeAnswerByType = (value, type) => {
  if (type === 'multiple') return toMultipleKeys(value);
  if (value && typeof value === 'object') return String(value.userAnswer ?? value.answer ?? '').trim();
  return String(value || '').trim();
};

const isAnswered = (value, type) => (type === 'multiple' ? Array.isArray(value) && value.length > 0 : Boolean(String(value || '').trim()));
const isSubjectiveType = (type) => ['subjective', 'essay', 'short_answer', 'short-answer', 'writing', '论述', '简答'].includes(String(type || '').toLowerCase());

const isCorrectAnswer = (userAnswer, correctAnswer, type) => {
  if (isSubjectiveType(type)) return null;
  if (type === 'multiple') {
    const ua = toMultipleKeys(userAnswer);
    const ca = toMultipleKeys(correctAnswer);
    return ua.length === ca.length && ua.every((item, idx) => item === ca[idx]);
  }
  return String(userAnswer || '').trim() === String(correctAnswer || '').trim();
};

const formatAnswer = (answer, type) => {
  if (type === 'multiple') {
    const keys = toMultipleKeys(answer);
    return keys.length ? keys.join(',') : '';
  }
  return String(answer || '').trim();
};

const TrendChart = ({ data, color = 'var(--accent)' }) => {
  const points = (data && data.length > 0 ? data : [50]).map((v) => Number(v) || 0);
  const safePoints = points.length === 1 ? [points[0], points[0]] : points;
  const max = Math.max(...safePoints, 100);
  const min = Math.min(...safePoints, 0);
  const range = max - min || 1;

  const pathPoints = safePoints.map((val, i) => {
    const x = (i / (safePoints.length - 1)) * 100;
    const y = 100 - ((val - min) / range) * 80 - 10;
    return `${x},${y}`;
  }).join(' ');

  return (
    <svg className="trend-chart" viewBox="0 0 100 100" preserveAspectRatio="none">
      <defs>
        <linearGradient id="trendGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <polyline
        points={pathPoints}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <polygon points={`0,100 ${pathPoints} 100,100`} fill="url(#trendGradient)" />
    </svg>
  );
};

export default function ExamResult({ result, onBack, onRedoWrong, onPracticeWeak, onAskAI }) {
  const [showAnalysis, setShowAnalysis] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [historyStats, setHistoryStats] = useState(null);
  const [trendData, setTrendData] = useState([]);
  // 主观题自评：{ [questionId]: 'correct' | 'wrong' }，写在纸上的答案由用户自己对答案判定
  // 打开历史记录时从练习记录的 meta 里恢复，避免自评一半退出后又要重评
  const [verdicts, setVerdicts] = useState(() => result?.verdicts || {});
  // AI 批改面板默认收起，点「AI 批改」再展开
  const [showGrader, setShowGrader] = useState(false);
  const { enqueueUnlocks } = useAchievementUnlock();

  // 打开对答案：总是从第 1 题开始（之前停在上一题会让人以为「点不动」）
  const openReviewAt = (index) => {
    const total = questions.length || 1;
    setShowGrader(false);
    setCurrentIndex(Math.max(0, Math.min(index, total - 1)));
  };

  const questions = result?.questions || getState().currentQuestions || [];
  const questionTypeMap = new Map(questions.map((q) => [q.id, q.type]));
  const normalizeAnswers = (input) => Object.entries(input || {}).reduce((acc, [questionId, value]) => {
    const qType = questionTypeMap.get(questionId) || 'single';
    acc[questionId] = normalizeAnswerByType(value, qType);
    return acc;
  }, {});
  const [answers, setAnswers] = useState(() => normalizeAnswers(result?.answers));
  const currentQuestion = questions[currentIndex];

  // 每题的最终判定：手动自评 > 客观题自动判分 > 待自评（主观题）/ 未作答
  // 全在纸上作答的用户没有任何 in-app 答案，全靠手动自评，所以选择题 / 填空题也走这套
  const autoStateOf = (q) => {
    if (isSubjectiveType(q.type)) return null;
    if (!isAnswered(answers[q.id], q.type)) return null;
    return isCorrectAnswer(answers[q.id], q.answer, q.type) === true ? 'correct' : 'wrong';
  };
  const stateOf = (q) => verdicts[q.id] || autoStateOf(q) || (isSubjectiveType(q.type) ? 'pending' : 'unanswered');

  const categoryStats = {};
  questions.forEach(q => {
    const cat = q.category || 'other';
    if (!categoryStats[cat]) {
      categoryStats[cat] = { total: 0, correct: 0 };
    }
    // 待自评的先不计入分类正确率，否则会把分母拉低
    const st = stateOf(q);
    if (st === 'pending') return;
    categoryStats[cat].total++;
    if (st === 'correct') categoryStats[cat].correct++;
  });

  useEffect(() => {
    const loadHistory = async () => {
      if (!window.openexam?.db) return;
      try {
        const [stats, records] = await Promise.all([
          window.openexam.db.getPracticeStats(),
          window.openexam.db.getPracticeRecords(),
        ]);
        setHistoryStats(stats);
        const completed = (records || [])
          .filter((row) => String(row.status || '').toLowerCase() === 'completed')
          .slice(0, 12)
          .reverse();
        const series = completed.map((row) => Number(row.accuracy || 0));
        if (series.length) setTrendData(series);
        else setTrendData([Number(result?.accuracy || 0)]);
      } catch (e) {
        console.error('加载历史数据失败:', e);
        setTrendData([Number(result?.accuracy || 0)]);
      }
    };
    loadHistory();
  }, [result?.accuracy]);

  useEffect(() => {
    let cancelled = false;
    const checkUnlocks = async () => {
      if (!window.openexam?.db?.getGrowthData) return;
      try {
        const data = await window.openexam.db.getGrowthData();
        if (cancelled) return;
        const achievements = normalizeAchievements(data?.achievements, data || {});
        const newly = diffNewlyUnlocked(achievements);
        if (newly.length) enqueueUnlocks(newly);
      } catch (error) {
        console.error('检查成就解锁失败:', error);
      }
    };
    // Allow practice save / metrics to settle before reading growth data
    const timer = window.setTimeout(checkUnlocks, 280);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [result?.accuracy, result?.correctCount, result?.totalCount, enqueueUnlocks]);

  const formatDuration = (seconds) => {
    if (!seconds || isNaN(seconds)) return '0分0秒';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}分${s}秒`;
  };

  const getScoreLevel = (accuracy) => {
    if (accuracy >= 90) return { text: '优秀', color: 'var(--success)', bg: 'var(--success-soft)' };
    if (accuracy >= 80) return { text: '良好', color: 'var(--accent)', bg: 'var(--accent-soft-bg)' };
    if (accuracy >= 60) return { text: '及格', color: 'var(--warning)', bg: 'var(--warning-soft)' };
    return { text: '需加强', color: 'var(--danger)', bg: 'var(--danger-soft)' };
  };

  const subjectiveQuestions = questions.filter((q) => isSubjectiveType(q.type));
  const totalCount = result?.totalCount || questions.length;

  const tally = { correct: 0, wrong: 0, pending: 0, unanswered: 0 };
  questions.forEach((q) => { tally[stateOf(q)] += 1; });
  const correctCount = tally.correct;
  const wrongCount = tally.wrong;
  // 待自评 = 还没判对错的主观题（含写了「纸面作答」的客观题）
  const pendingReviewCount = tally.pending;
  const unansweredCount = tally.unanswered;
  // 未判定的先不计入分母，判完再算进正确率
  const gradedTotal = Math.max(totalCount - pendingReviewCount, 0);
  const accuracy = gradedTotal > 0 ? Math.round((correctCount / gradedTotal) * 100) : 0;

  // 手动判对错 / 重置后回写练习记录；同时推进完成状态：
  // 还有待自评题时保持 awaiting_review，全部评完才变 completed。
  useEffect(() => {
    const recordId = result?.recordId;
    if (!recordId || !window.openexam?.db?.updatePracticeRecordScore) return;
    const now = { correct: 0, wrong: 0, pending: 0 };
    questions.forEach((q) => {
      const st = stateOf(q);
      if (now[st] !== undefined) now[st] += 1;
    });
    const graded = Math.max(questions.length - now.pending, 0);
    const nextAccuracy = graded > 0 ? Math.round((now.correct / graded) * 100) : 0;
    const nextStatus = now.pending > 0 ? 'awaiting_review' : 'completed';
    window.openexam.db
      .updatePracticeRecordScore({
        id: recordId,
        correctCount: now.correct,
        accuracy: nextAccuracy,
        verdicts,
        answers,
        status: nextStatus,
      })
      .catch((error) => console.error('回写练习得分失败:', error));
  }, [verdicts, answers, result?.recordId]);
  const timeElapsed = result?.timeElapsed || result?.duration || 0;
  const avgTimePerQuestion = totalCount > 0 ? Math.round(timeElapsed / totalCount) : 0;

  const level = getScoreLevel(accuracy);
  const resultTitle = result?.paperTitle || result?.config?.title || (result?.config?.category ? categoryNames[result.config.category] || '专项练习' : '练习完成');
  const resultSubtitle = `${correctCount} 正确 · ${wrongCount} 错误${pendingReviewCount ? ` · ${pendingReviewCount} 待自评` : ''} · ${formatDuration(timeElapsed)}`;
  const historyAccuracy = historyStats?.accuracy || 0;
  const historyDelta = accuracy - historyAccuracy;
  const historyReady = Boolean(historyStats?.totalDone);

  const categoryRows = categoryOrder.map(cat => {
    const stat = categoryStats[cat] || { total: 0, correct: 0 };
    const pct = stat.total > 0 ? Math.round((stat.correct / stat.total) * 100) : 0;
    return {
      key: cat,
      name: categoryNames[cat],
      total: stat.total,
      correct: stat.correct,
      pct
    };
  });

  const weakCategories = categoryRows.filter(item => item.total > 0 && item.pct < 60);
  const chartTrend = trendData.length ? trendData : [accuracy];

  const suggestions = [];
  if (unansweredCount > 0) {
    suggestions.push({ type: 'warning', text: `本次仍有 ${unansweredCount} 题未作答，先补齐基础准确率。` });
  }
  weakCategories.slice(0, 2).forEach(item => {
    suggestions.push({ type: 'warning', text: `${item.name} 正确率仅 ${item.pct}%，建议单独刷题巩固。` });
  });
  suggestions.push({
    type: avgTimePerQuestion > 60 ? 'info' : 'success',
    text: `平均每题 ${avgTimePerQuestion} 秒，${avgTimePerQuestion > 60 ? '节奏偏慢，建议限时训练。' : '节奏稳定，可继续保持。'}`
  });
  if (suggestions.length < 3) {
    suggestions.push({ type: 'success', text: '当前表现较稳，继续按分类循环练习即可。' });
  }

  // 手动判对错：选择题 / 填空题 / 主观题都适用（全在纸上作答时全靠它）
  // 判错顺手写进错题本，改判成「答对」就把这道题的错题记录撤掉；再点一次同一个按钮回到自动判定
  const judgeQuestion = async (question, verdict) => {
    if (!question) return;
    const previous = verdicts[question.id] || null;
    const next = previous === verdict ? null : verdict;
    const before = previous || autoStateOf(question);
    const after = next || autoStateOf(question);
    setVerdicts((prev) => {
      const copy = { ...prev };
      if (next) copy[question.id] = next;
      else delete copy[question.id];
      return copy;
    });
    if (!window.openexam?.db) return;
    try {
      if (after === 'wrong' && before !== 'wrong') {
        await window.openexam.db.addWrongQuestion({
          questionId: question.id,
          paperId: question.paper_id || result?.config?.sourcePaperId || '',
          userAnswer: formatAnswer(answers[question.id], question.type) || '纸面作答（自评答错）',
          correctAnswer: formatAnswer(question.answer, question.type),
          // 附带题目快照：错题库不依赖题库表，删除试卷后错题仍完整可复习
          snapshot: {
            type: question.type,
            content: question.content,
            contentHtml: question.content_html,
            options: question.options,
            analysis: question.analysis,
            analysisHtml: question.analysis_html,
            category: question.category,
            subCategory: question.sub_category,
            answer: question.answer,
          },
        });
      } else if (before === 'wrong' && after !== 'wrong') {
        await window.openexam.db.removeWrongQuestion?.({ questionId: question.id });
      }
    } catch (error) {
      console.error('同步错题本失败:', error);
    }
  };

  // 重置单题：作答、自评判定一起清掉，题目保留；主观题会重新回到「待自评」
  const resetQuestion = (question) => {
    if (!question) return;
    setAnswers((prev) => {
      const next = { ...prev };
      delete next[question.id];
      return next;
    });
    setVerdicts((prev) => {
      const next = { ...prev };
      delete next[question.id];
      return next;
    });
  };

  if (showAnalysis && currentQuestion) {
    const userAnswer = answers[currentQuestion.id];
    const isSubjective = isSubjectiveType(currentQuestion.type);
    const isCorrect = isCorrectAnswer(userAnswer, currentQuestion.answer, currentQuestion.type);
    const verdict = verdicts[currentQuestion.id] || null;
    const autoState = autoStateOf(currentQuestion);
    const currentState = stateOf(currentQuestion);
    const userAnswerText = formatAnswer(userAnswer, currentQuestion.type);
    const correctAnswerText = formatAnswer(currentQuestion.answer, currentQuestion.type);
    const selectedKeys = currentQuestion.type === 'multiple' ? toMultipleKeys(userAnswer) : [userAnswer].filter(Boolean);
    const correctKeys = currentQuestion.type === 'multiple' ? toMultipleKeys(currentQuestion.answer) : [currentQuestion.answer].filter(Boolean);
    const typeLabel = isSubjective
      ? '主观题'
      : currentQuestion.type === 'multiple' ? '多选题' : currentQuestion.type === 'fill' ? '填空题' : '单选题';
    const statusText = currentState === 'correct'
      ? (isSubjective ? '✓ 自评答对' : '✓ 回答正确')
      : currentState === 'wrong'
        ? (isSubjective ? '✗ 自评答错' : '✗ 回答错误')
        : currentState === 'pending' ? '待自评' : '未作答';
    const statusTone = currentState === 'correct' ? 'ok' : currentState === 'wrong' ? 'no' : currentState === 'pending' ? 'pending' : 'skip';

    // 题号格子状态：正确 / 错误 / 未作答 / 待自评
    const numStateOf = (q) => {
      const st = stateOf(q);
      return st === 'correct' ? 'ok' : st === 'wrong' ? 'no' : st === 'pending' ? 'pending' : 'skip';
    };

    return (
      <div className="review-page">
        <div className="review-header">
          <button className="back-btn" onClick={() => setShowAnalysis(false)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
            返回成绩
          </button>
          <span className="review-header-title">对答案</span>
          <span className="review-header-count">第 {currentIndex + 1} / {questions.length} 题</span>
        </div>

        <div className="review-layout">
          <div className="review-main">
            {/* ① 题目 */}
            <div className="review-card">
              <div className="review-card-top">
                <span className="review-no">{currentIndex + 1}</span>
                <span className="review-type">{typeLabel}</span>
                <span className={`review-status ${statusTone}`}>{statusText}</span>
              </div>

              {currentQuestion.material_html ? (
                <div className="review-material">
                  <h4 className="tb-label tb-label-plain">【材料】</h4>
                  <RichQuestionContent value={currentQuestion.material_html} className="rich-question-material" />
                </div>
              ) : null}

              <RichQuestionContent value={currentQuestion.content_html || currentQuestion.content} className="question-content" />

              {!isSubjective && (currentQuestion.options || []).length > 0 && (
                <div className="question-options review">
                  {(currentQuestion.options || []).map(opt => (
                    <div
                      key={opt.key}
                      className={`option-item ${correctKeys.includes(opt.key) ? 'correct-answer' : ''} ${selectedKeys.includes(opt.key) && !correctKeys.includes(opt.key) ? 'wrong-answer' : ''}`}
                    >
                      <span className="option-key">{opt.key}</span>
                      <RichQuestionContent value={opt.content} className="option-content rich-question-option" />
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ② 参考答案 */}
            <div className="review-answer">
              <div className="review-answer-head">
                <span className="review-answer-label tb-label">{isSubjective ? '【参考答案】' : '【答案】'}</span>
                {!isSubjective && (
                  <span className="review-mine">
                    你的答案：
                    <b className={isAnswered(userAnswer, currentQuestion.type) ? (isCorrect ? 'ok' : 'no') : 'skip'}>
                      {userAnswerText || '未在应用内作答'}
                    </b>
                  </span>
                )}
              </div>
              <div className={`review-answer-body${correctAnswerText ? '' : ' empty'}`}>
                {correctAnswerText
                  ? <RichQuestionContent value={correctAnswerText} className="tb-inline" />
                  : '这道题暂无标准答案，可以拍照让 AI 批改。'}
              </div>
            </div>

            {/* ③ 对 / 错 / AI 批改：所有题型都能手动判 */}
            <div className="review-actions">
              <button
                type="button"
                className={`review-judge ok${verdict === 'correct' ? ' is-on' : ''}`}
                onClick={() => judgeQuestion(currentQuestion, 'correct')}
              >
                ✓ 我答对了
              </button>
              <button
                type="button"
                className={`review-judge no${verdict === 'wrong' ? ' is-on' : ''}`}
                onClick={() => judgeQuestion(currentQuestion, 'wrong')}
              >
                ✗ 我答错了
              </button>
              {verdict && (
                <button type="button" className="review-undo" onClick={() => judgeQuestion(currentQuestion, verdict)}>
                  撤销
                </button>
              )}
              {(verdict || isAnswered(userAnswer, currentQuestion.type)) && (
                <button type="button" className="review-undo" onClick={() => resetQuestion(currentQuestion)}>
                  重置本题
                </button>
              )}

              <span className={`review-auto ${verdict ? 'skip' : statusTone}`}>
                {verdict
                  ? '已手动判定'
                  : autoState
                    ? `自动判定 · ${autoState === 'correct' ? '正确' : '错误'}，可手动改`
                    : (isSubjective ? '写在纸上，按你的答案自己判' : '没在应用内作答，按纸上答案自己判')}
              </span>

              <button
                type="button"
                className="review-ai"
                onClick={() => {
                  if (isSubjective) setShowGrader(v => !v);
                  else onAskAI?.(currentQuestion, { prompt: '请讲解这道题：拆解考点、说明正确答案的依据，再给一个类似练习。' });
                }}
              >
                {isSubjective ? (showGrader ? '收起 AI 批改' : 'AI 批改') : '问 AI 讲解'}
              </button>
            </div>

            {isSubjective && showGrader && (
              <div className="review-grader">
                <SubjectiveGrader question={currentQuestion} onAskAI={() => onAskAI?.(currentQuestion)} />
              </div>
            )}

            {/* ④ 题号：点一下跳到那一题 */}
            <div className="review-numbers">
              <div className="review-numbers-head">
                <span>题号</span>
                <span className="review-numbers-tip">点一下跳到那一题</span>
              </div>
              <div className="review-numbers-grid">
                {questions.map((q, index) => (
                  <button
                    key={q.id || index}
                    type="button"
                    className={`review-num ${numStateOf(q)}${index === currentIndex ? ' is-current' : ''}`}
                    onClick={() => openReviewAt(index)}
                    title={`第 ${index + 1} 题`}
                  >
                    {index + 1}
                  </button>
                ))}
              </div>
              <div className="review-legend">
                <span><i className="ok" />正确</span>
                <span><i className="no" />错误</span>
                <span><i className="skip" />未作答</span>
                <span><i className="pending" />待自评</span>
              </div>
            </div>
          </div>

          <aside className="review-side">
            <div className="review-side-card">
              <h4>本次判定</h4>
              <div className="review-side-stats">
                <div><b className="ok">{correctCount}</b><span>正确</span></div>
                <div><b className="no">{wrongCount}</b><span>错误</span></div>
                <div><b className="pending">{pendingReviewCount}</b><span>待自评</span></div>
                <div><b className="skip">{unansweredCount}</b><span>未答</span></div>
              </div>
            </div>

            {(currentQuestion.analysis_html || currentQuestion.analysis) ? (
              <div className="review-side-card">
                <h4 className="tb-label tb-label-plain">【解析】</h4>
                <RichQuestionContent value={currentQuestion.analysis_html || currentQuestion.analysis} className="rich-question-analysis" />
              </div>
            ) : null}

            <div className="review-side-nav">
              <button type="button" className="nav-btn" onClick={() => openReviewAt(currentIndex - 1)} disabled={currentIndex === 0}>← 上一题</button>
              <button type="button" className="nav-btn" onClick={() => openReviewAt(currentIndex + 1)} disabled={currentIndex === questions.length - 1}>下一题 →</button>
            </div>
          </aside>
        </div>
      </div>
    );
  }

  return (
    <div className="result-page-new">
      <div className="result-shell">
        <div className="result-top-bar">
          <div className="result-score-section">
            <div className="score-ring-wrap">
              <svg className="score-ring-svg" viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="42" fill="none" stroke="var(--line)" strokeWidth="5"/>
                <circle
                  cx="50"
                  cy="50"
                  r="42"
                  fill="none"
                  stroke={level.color}
                  strokeWidth="5"
                  strokeDasharray={`${accuracy * 2.64} 264`}
                  strokeLinecap="round"
                  transform="rotate(-90 50 50)"
                  style={{ transition: 'stroke-dasharray 0.8s ease' }}
                />
              </svg>
              <div className="score-ring-center">
                <div className="score-ring-value">
                  <span className="score-big" style={{ color: level.color }}>{accuracy}</span>
                  <span className="score-percent">%</span>
                </div>
              </div>
            </div>
            <div className="score-info">
              <div className="score-info-row">
                <h2>{resultTitle}</h2>
                <span className="score-badge" style={{ background: level.bg, color: level.color }}>{level.text}</span>
              </div>
              <span className="score-subtext">{resultSubtitle}</span>
            </div>
          </div>

          <div className="result-quick-stats">
            <div className="quick-stat">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              <span className="qs-value">{correctCount}</span>
              <span className="qs-label">正确</span>
            </div>
            <div className="quick-stat">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
              <span className="qs-value">{wrongCount}</span>
              <span className="qs-label">错误</span>
            </div>
            <div className="quick-stat">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9"/>
                <path d="M12 7v5l3 2"/>
              </svg>
              <span className="qs-value">{formatDuration(timeElapsed)}</span>
              <span className="qs-label">用时</span>
            </div>
            <div className="quick-stat">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--warning)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
              </svg>
              <span className="qs-value">{avgTimePerQuestion}s</span>
              <span className="qs-label">平均</span>
            </div>
          </div>

          <div className="result-actions-bar">
            <button className="action-btn-solid" onClick={() => { openReviewAt(0); setShowAnalysis(true); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
              </svg>
              对答案
            </button>
            <button className="action-btn-outline" onClick={() => onRedoWrong?.({ ...result, verdicts })} disabled={!wrongCount}>
              重做错题
            </button>
            <button className="action-btn-outline" onClick={() => onPracticeWeak?.(weakCategories[0]?.key || result?.config?.category)}>
              刷薄弱
            </button>
            <button className="action-btn-outline" onClick={() => onAskAI?.(result)}>
              问 AI
            </button>
            <button className="action-btn-outline" onClick={onBack}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6"/>
              </svg>
              返回
            </button>
          </div>
        </div>

        <div className="result-body">
          {pendingReviewCount > 0 && (
            <div className="result-hint-bar">
              <span>还有 {pendingReviewCount} 道主观题待自评，全部评完这次练习才算完成；现在会保留为可继续状态。</span>
              <button
                type="button"
                onClick={() => {
                  const idx = questions.findIndex((q) => stateOf(q) === 'pending');
                  openReviewAt(Math.max(0, idx));
                  setShowAnalysis(true);
                }}
              >
                去自评
              </button>
            </div>
          )}
          {correctCount + wrongCount === 0 && totalCount > 0 && (
            <div className="result-hint-bar">
              <span>这次没有在应用里作答，分数还都是 0。点「对答案」逐题判对错，成绩会实时更新。</span>
              <button type="button" onClick={() => { openReviewAt(0); setShowAnalysis(true); }}>去对答案</button>
            </div>
          )}
          <div className="result-board">
            <div className="result-strip">
              <div className="strip-cell">
                <div className="strip-icon success">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                </div>
                <div className="strip-copy">
                  <span className="strip-value">{correctCount}</span>
                  <span className="strip-label">答对题数</span>
                </div>
                <span className="strip-meta success">{accuracy}%</span>
              </div>

              <div className="strip-cell">
                <div className="strip-icon danger">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18"/>
                    <line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </div>
                <div className="strip-copy">
                  <span className="strip-value">{wrongCount}</span>
                  <span className="strip-label">答错题数</span>
                </div>
                <span className="strip-meta danger">{totalCount > 0 ? Math.round((wrongCount / totalCount) * 100) : 0}%</span>
              </div>

              <div className="strip-cell">
                <div className="strip-icon accent">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="9"/>
                    <path d="M12 7v5l3 2"/>
                  </svg>
                </div>
                <div className="strip-copy">
                  <span className="strip-value">{formatDuration(timeElapsed)}</span>
                  <span className="strip-label">总用时</span>
                </div>
                <span className="strip-meta accent">{avgTimePerQuestion}s/题</span>
              </div>

              <div className="strip-cell">
                <div className="strip-icon warning">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                    <path d="M3 9h18"/>
                    <path d="M9 21V9"/>
                  </svg>
                </div>
                <div className="strip-copy">
                  <span className="strip-value">{totalCount}</span>
                  <span className="strip-label">总题数</span>
                </div>
                <span className="strip-meta warning">{unansweredCount} 未答</span>
              </div>
            </div>

            <div className="result-main-row">
              <section className="board-section section-trend">
                <div className="section-heading">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2">
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                  </svg>
                  <span>正确率趋势</span>
                  <span className="heading-badge" style={{ color: level.color }}>{level.text}</span>
                </div>
                <div className="trend-summary-line">
                  <span>{historyReady ? '最近练习正确率' : '开始积累真实练习趋势'}</span>
                  <strong style={{ color: level.color }}>本次 {accuracy}%</strong>
                </div>
                <div className="chart-area dense">
                  <TrendChart data={chartTrend} color="var(--accent)" />
                </div>
                <div className="chart-footer dense">
                  <span>{historyReady ? `历史均值 ${historyAccuracy}%` : '暂无历史均值'}</span>
                  <span>{resultSubtitle}</span>
                </div>
              </section>

              <section className="board-section section-category">
                <div className="section-heading">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2">
                    <line x1="18" y1="20" x2="18" y2="10"/>
                    <line x1="12" y1="20" x2="12" y2="4"/>
                    <line x1="6" y1="20" x2="6" y2="14"/>
                  </svg>
                  <span>分类正确率</span>
                </div>
                <div className="category-table-dense">
                  {categoryRows.map(item => (
                    <div key={item.key} className="category-row-dense">
                      <span className="cat-name-dense">{item.name}</span>
                      <div className="cat-progress-dense">
                        <div className="cat-bar-wrap-dense">
                          <div
                            className="cat-bar-dense"
                            style={{
                              width: `${item.pct}%`,
                              background: item.total === 0 ? 'var(--line)' : (item.pct >= 60 ? 'var(--success)' : 'var(--danger)')
                            }}
                          />
                        </div>
                        <span className="cat-stat-dense">{item.correct}/{item.total}</span>
                      </div>
                      <span className={`cat-pct-dense ${item.pct >= 60 ? 'good' : 'weak'} ${item.total === 0 ? 'empty' : ''}`}>
                        {item.pct}%
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            </div>

            <div className="result-detail-row">
              <section className="board-section section-answer">
                <div className="section-heading">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2">
                    <rect x="3" y="3" width="7" height="7" rx="1"/>
                    <rect x="14" y="3" width="7" height="7" rx="1"/>
                    <rect x="14" y="14" width="7" height="7" rx="1"/>
                    <rect x="3" y="14" width="7" height="7" rx="1"/>
                  </svg>
                  <span>答题分布</span>
                  <span className="heading-badge subtle">共 {totalCount} 题 · 点题号看答案</span>
                </div>
                <div className="dots-legend dense">
                  <span><i className="leg-dot correct"/>正确 {correctCount}</span>
                  <span><i className="leg-dot wrong"/>错误 {wrongCount}</span>
                  <span><i className="leg-dot skip"/>未答 {unansweredCount}</span>
                  {pendingReviewCount > 0 && <span><i className="leg-dot pending"/>待自评 {pendingReviewCount}</span>}
                </div>
                <div className="answer-dots-full dense">
                  {questions.map((question, index) => {
                    const st = stateOf(question);
                    const dotState = st === 'correct' ? 'correct' : st === 'wrong' ? 'wrong' : st === 'pending' ? 'pending' : 'skip';
                    return (
                      <button
                        type="button"
                        key={question.id}
                        className={`a-dot-full ${dotState}`}
                        title={st === 'correct' ? '第 ' + (index + 1) + ' 题 · 正确' : st === 'wrong' ? '第 ' + (index + 1) + ' 题 · 错误' : st === 'pending' ? '第 ' + (index + 1) + ' 题 · 待自评' : '第 ' + (index + 1) + ' 题 · 未作答'}
                        onClick={() => { openReviewAt(index); setShowAnalysis(true); }}
                      >
                        {index + 1}
                      </button>
                    );
                  })}
                </div>
              </section>

              <div className="result-side-panel">
                <section className="board-section section-history">
                  <div className="section-heading">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2">
                      <circle cx="12" cy="12" r="10"/>
                      <polyline points="12 6 12 12 16 14"/>
                    </svg>
                    <span>历史对比</span>
                  </div>
                  <div className="history-compact-grid">
                    <div className="history-cell">
                      <span className="hi-label">本次正确率</span>
                      <span className="hi-value" style={{ color: level.color }}>{accuracy}%</span>
                    </div>
                    <div className="history-cell">
                      <span className="hi-label">历史平均</span>
                      <span className="hi-value">{historyAccuracy}%</span>
                    </div>
                    <div className="history-cell">
                      <span className="hi-label">累计做题</span>
                      <span className="hi-value">{historyStats?.totalDone || 0}题</span>
                    </div>
                    <div className="history-cell">
                      <span className="hi-label">错题总数</span>
                      <span className="hi-value">{historyStats?.wrongCount || 0}题</span>
                    </div>
                  </div>
                  <div className={`history-inline-tip ${historyDelta > 0 ? 'up' : historyDelta < 0 ? 'down' : 'neutral'}`}>
                    {historyReady ? (historyDelta > 0 ? `高于历史平均 ${historyDelta}%` : historyDelta < 0 ? `低于历史平均 ${Math.abs(historyDelta)}%` : '与历史平均持平') : '完成更多练习后显示历史对比'}
                  </div>
                </section>

                <section className="board-section section-suggest">
                  <div className="section-heading">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2">
                      <circle cx="12" cy="12" r="10"/>
                      <path d="M12 16v-4"/>
                      <path d="M12 8h.01"/>
                    </svg>
                    <span>学习建议</span>
                  </div>
                  <div className="suggest-rows">
                    {suggestions.slice(0, 4).map((item, index) => (
                      <div key={`${item.text}-${index}`} className={`suggest-row ${item.type}`}>
                        <span className="suggest-dot"/>
                        <span>{item.text}</span>
                      </div>
                    ))}
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                      <button type="button" className="action-btn-outline" style={{ padding: '6px 10px', fontSize: 12 }} onClick={() => onPracticeWeak?.(weakCategories[0]?.key)}>一键刷薄弱</button>
                      <button type="button" className="action-btn-outline" style={{ padding: '6px 10px', fontSize: 12 }} onClick={() => onAskAI?.(result)}>让 AI 复盘</button>
                    </div>
                  </div>
                </section>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
