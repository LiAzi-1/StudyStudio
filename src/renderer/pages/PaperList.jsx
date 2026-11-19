import React, { useState, useEffect, useMemo, useRef } from 'react';
import { actions } from '../store/examStore.js';
import CustomSelect from '../components/CustomSelect.jsx';
import { buildPaperShareText, copyText } from '../utils/paperShare.js';
import { buildPaperSubjectIndex, buildSubjectStats } from '../utils/paperSubjects.js';
import { useDialog } from '../components/DialogProvider.jsx';
import LuoCat from '../components/LuoCat.jsx';

// 省份标签数据
const PAPER_PROVINCE_ALIASES = {
  '北京市': '北京',
  '天津市': '天津',
  '上海市': '上海',
  '重庆市': '重庆',
  '深圳市': '深圳',
  '内蒙古自治区': '内蒙古',
  '广西壮族自治区': '广西',
  '宁夏回族自治区': '宁夏',
  '新疆维吾尔自治区': '新疆',
  '西藏自治区': '西藏',
  '香港特别行政区': '香港',
  '澳门特别行政区': '澳门',
};

function normalizePaperProvince(value) {
  const province = String(value || '').trim();
  if (!province) return '';
  if (PAPER_PROVINCE_ALIASES[province]) return PAPER_PROVINCE_ALIASES[province];
  if (province.endsWith('省') || province.endsWith('市')) return province.slice(0, -1);
  return province;
}

const PAGE_SIZE = 12;

function getPaperBadge(paper) {
  switch (paper?.type) {
    case 'national':
      return { label: '国考', className: 'national' };
    case 'ai_exam':
      return { label: 'AI试卷', className: 'ai-exam' };
    case 'ai_practice':
      return { label: 'AI练习', className: 'ai-practice' };
    case 'imported':
      return { label: '导入', className: 'imported' };
    default:
      return { label: normalizePaperProvince(paper?.province) || '省考', className: 'provincial' };
  }
}

function getPaperActionLabel(paper, hasResumeRecord = false) {
  if (hasResumeRecord) return '继续作答';
  return paper?.type === 'ai_practice' ? '开始练习' : '开始答题';
}

function hasAnyAnswer(record) {
  if (!record?.answers || typeof record.answers !== 'object') return false;
  return Object.values(record.answers).some((value) => {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') {
      const raw = value.userAnswer ?? value.answer ?? '';
      return String(raw).trim().length > 0;
    }
    return String(value || '').trim().length > 0;
  });
}

export default function PaperList({ onOpenPaper, onReviewPaper, initialKeyword = '', focusToken = 0, onGoAIGenerate, embedded = false }) {
  const [papers, setPapers] = useState([]);
  const [subjectList, setSubjectList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedYear, setSelectedYear] = useState('all');
  const [selectedSubject, setSelectedSubject] = useState('all');
  const [keyword, setKeyword] = useState(initialKeyword);
  const [currentPage, setCurrentPage] = useState(1);
  const [busyAction, setBusyAction] = useState('');
  const [resumableMap, setResumableMap] = useState({});
  const { toast: showToast } = useDialog();
  const keywordInputRef = useRef(null);

  // 加载试卷
  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      const [paperData, recordData, subjectData] = await Promise.all([
        actions.loadPapers(),
        window.openexam?.db?.getPracticeRecords ? window.openexam.db.getPracticeRecords() : Promise.resolve([]),
        window.openexam?.subject?.list ? window.openexam.subject.list() : Promise.resolve([]),
      ]);
      setPapers(paperData);
      setSubjectList(Array.isArray(subjectData) ? subjectData : []);
      const nextResumable = {};
      (recordData || []).forEach((record) => {
        if (!record?.paper_id || nextResumable[record.paper_id]) return;
        const status = String(record.status || '').toLowerCase();
        if (!['ongoing', 'paused'].includes(status) || !hasAnyAnswer(record)) return;
        nextResumable[record.paper_id] = record;
      });
      setResumableMap(nextResumable);
      setLoading(false);
    };
    loadData();
  }, []);

  useEffect(() => {
    setKeyword(initialKeyword || '');
  }, [initialKeyword]);

  useEffect(() => {
    // 首屏还在 loading 时搜索框尚未挂载，等数据回来后再聚焦
    if (!focusToken || loading) return;
    keywordInputRef.current?.focus();
  }, [focusToken, loading]);

  const trackPapers = useMemo(() => papers, [papers]);
  // 获取可用筛选项
  const years = useMemo(() => [...new Set(trackPapers.map(p => p.year))].sort((a, b) => b - a), [trackPapers]);

  /**
   * 试卷 → 学科：优先 subject_id；旧数据只有学科大类时，只有该大类唯一对应
   * 一个科目才自动归属，否则单列「未归属」，不猜具体科目。
   */
  const paperSubject = useMemo(
    () => buildPaperSubjectIndex(trackPapers, subjectList),
    [trackPapers, subjectList],
  );

  const subjectStats = useMemo(
    () => buildSubjectStats(trackPapers, subjectList, paperSubject),
    [trackPapers, subjectList, paperSubject],
  );

  const normalizedKeyword = String(keyword || '').trim().toLowerCase();

  // 筛选试卷
  const filteredPapers = trackPapers.filter(p => {
    // 年份筛选
    if (selectedYear !== 'all' && p.year !== parseInt(selectedYear)) return false;
    // 学科筛选
    if (selectedSubject !== 'all') {
      const subject = paperSubject.get(p.id);
      if (selectedSubject === 'unassigned') {
        if (subject) return false;
      } else if (!subject || subject.id !== selectedSubject) {
        return false;
      }
    }
    // 关键词搜索
    if (normalizedKeyword) {
      const subject = paperSubject.get(p.id);
      const haystack = [
        p.title,
        p.province,
        normalizePaperProvince(p.province),
        subject?.name,
        String(p.year || ''),
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(normalizedKeyword)) return false;
    }
    return true;
  });

  // 分页
  const totalPages = Math.ceil(filteredPapers.length / PAGE_SIZE);
  const paginatedPapers = filteredPapers.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE
  );

  // 筛选变化时重置页码
  useEffect(() => {
    setCurrentPage(1);
  }, [selectedYear, selectedSubject, normalizedKeyword]);

  useEffect(() => {
    setSelectedYear('all');
    setSelectedSubject('all');
    setCurrentPage(1);
  }, []);

  const handleStart = async (paper, options = {}) => {
    onOpenPaper?.({
      ...paper,
      resumeRecord: resumableMap[paper.id] || null,
      mock: Boolean(options.mock),
    });
  };

  const handleExportPaper = async (paper) => {
    if (!paper?.id || !window.openexam?.db?.getQuestions || !window.openexam?.paper?.exportPdf) return;
    setBusyAction(`pdf:${paper.id}`);
    try {
      const questions = await window.openexam.db.getQuestions(paper.id);
      const result = await window.openexam.paper.exportPdf({ paper, questions });
      if (result?.canceled) return;
      if (result?.success) {
        showToast({ title: 'PDF 导出成功', message: result.filePath, tone: 'success' });
      }
    } catch (error) {
      showToast({ title: 'PDF 导出失败', message: error.message || '未知错误', tone: 'danger' });
    } finally {
      setBusyAction('');
    }
  };

  const handleSharePaper = async (paper) => {
    if (!paper?.id || !window.openexam?.db?.getQuestions) return;
    setBusyAction(`share:${paper.id}`);
    try {
      const questions = await window.openexam.db.getQuestions(paper.id);
      await copyText(buildPaperShareText({ paper, questions }));
      showToast({ title: '复制成功', message: `已复制分享文案：${paper.title}`, tone: 'success' });
    } catch (error) {
      showToast({ title: '复制失败', message: error.message || '分享文案复制失败', tone: 'danger' });
    } finally {
      setBusyAction('');
    }
  };

  if (loading) {
    return (
      <div className="paper-list-page" style={embedded ? { padding: 0, height: 'auto', overflowY: 'visible' } : undefined}>
        <div className="loading-state">加载中...</div>
      </div>
    );
  }

  return (
    <div className="paper-list-page" style={embedded ? { padding: 0, height: 'auto', overflowY: 'visible' } : undefined}>
      {/* 年份筛选和统计 */}
      <div className="filter-bar">
        <div className="filter-left">
          <span className="filter-label">年份</span>
          <div className="custom-select">
            <CustomSelect
              value={selectedYear}
              onChange={(nextValue) => setSelectedYear(nextValue)}
              options={[
                { value: 'all', label: '全部年份' },
                ...years.map((y) => ({ value: String(y), label: `${y}年` })),
              ]}
            />
          </div>
          <span className="filter-label">科目</span>
          <div className="custom-select">
            <CustomSelect
              value={selectedSubject}
              onChange={(nextValue) => setSelectedSubject(nextValue)}
              options={[
                { value: 'all', label: '全部学科' },
                ...subjectStats.list.map((subject) => ({ value: subject.id, label: subject.name })),
              ]}
            />
          </div>
          <input
            ref={keywordInputRef}
            type="text"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索标题/地区/年份"
            style={{
              width: 210,
              height: 34,
              borderRadius: 8,
              border: '1px solid var(--line)',
              background: 'var(--surface)',
              color: 'var(--text)',
              fontSize: 13,
              padding: '0 10px',
              outline: 'none',
            }}
          />
        </div>
        <div className="filter-right">
          <span className="result-count">共 {filteredPapers.length} 套试卷</span>
        </div>
      </div>

      {/* 跨学科总览：每科题量 / 缺答案数，点击即筛选 */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        {[subjectStats.total, ...subjectStats.list].map((item) => {
          const active = selectedSubject === item.id;
          const isUnassigned = item.id === 'unassigned';
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => { setSelectedSubject(item.id); setCurrentPage(1); }}
              style={{
                textAlign: 'left',
                minWidth: 128,
                padding: '8px 11px',
                borderRadius: 10,
                border: `1px solid ${active ? 'var(--accent)' : 'var(--line)'}`,
                background: active ? 'var(--accent-soft-bg)' : 'var(--surface)',
                color: 'var(--text)',
                cursor: 'pointer',
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                {item.name}
                {isUnassigned ? <span style={{ fontSize: 9.5, color: 'var(--muted)', fontWeight: 500 }}>未绑定科目</span> : null}
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 3 }}>
                {item.paperCount} 套 · {item.questionCount} 题
              </div>
              <div style={{ fontSize: 10.5, marginTop: 2, color: item.missingAnswers > 0 ? '#b45309' : 'var(--muted)' }}>
                缺答案 {item.missingAnswers} 题
              </div>
            </button>
          );
        })}
      </div>
      {subjectStats.list.some((item) => item.id === 'unassigned') ? (
        <div style={{ fontSize: 10.5, color: 'var(--muted)', marginBottom: 10 }}>
          「未归属」是历史数据没有绑定具体科目、也无法从学科大类唯一确定的试卷；不自动猜测，可在对应试卷里补充科目。
        </div>
      ) : null}

      {/* 试卷列表 */}
      <div className="paper-grid">
        {paginatedPapers.map(paper => {
          const badge = getPaperBadge(paper);
          const hasResumeRecord = Boolean(resumableMap[paper.id]);
          const missingAnswerCount = Number(paper.missing_answer_count) || 0;
          return (
          <div key={paper.id} className="paper-card">
            <div className="paper-card-header">
              <span className="paper-year">{paper.year}</span>
              <span className={`paper-type ${badge.className}`}>
                {badge.label}
              </span>
            </div>
            <h3 className="paper-title">{paper.title}</h3>
            <div className="paper-meta">
              <span>{paper.actual_question_count ?? paper.question_count ?? paper.questionCount} 题</span>
              <span>{paper.duration || 120} 分钟</span>
              <span className="paper-difficulty">
                {'★'.repeat(paper.difficulty || 3)}{'☆'.repeat(5 - (paper.difficulty || 3))}
              </span>
              {missingAnswerCount > 0 ? (
                <button
                  type="button"
                  onClick={() => onReviewPaper?.(paper, { startAtMissing: true })}
                  title="打开看题，并直接跳到第一道没有答案的题"
                  style={{
                    padding: '2px 8px',
                    borderRadius: 999,
                    border: '1px solid var(--warning-border, var(--accent-border-soft))',
                    background: 'var(--warning-soft, var(--accent-soft-bg))',
                    color: 'var(--warning, var(--accent))',
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: onReviewPaper ? 'pointer' : 'default',
                  }}
                >
                  {missingAnswerCount} 题缺答案 · 去补
                </button>
              ) : null}
            </div>
            <div className="paper-actions">
              {onReviewPaper && (
                <button
                  className={`paper-action-btn ${hasResumeRecord ? 'paper-action-btn--ghost' : 'paper-action-btn--accent'}`}
                  onClick={() => onReviewPaper(paper)}
                  title="只读看题：直接看题干、答案与解析，不计时也不用交卷"
                >
                  看题
                </button>
              )}
              <button
                className="paper-action-btn paper-action-btn--ghost"
                onClick={() => handleExportPaper(paper)}
                disabled={busyAction === `pdf:${paper.id}`}
              >
                {busyAction === `pdf:${paper.id}` ? '导出中...' : 'PDF'}
              </button>
              <button
                className="paper-start-btn paper-action-btn paper-action-btn--primary"
                onClick={() => handleStart(paper)}
              >
                {getPaperActionLabel(paper, hasResumeRecord)}
              </button>
              <button
                className="paper-action-btn paper-action-btn--ghost"
                onClick={() => handleStart(paper, { mock: true })}
                title="倒计时模考，交卷前不显示解析"
              >
                模考
              </button>
              <button
                className="paper-action-btn paper-action-btn--accent"
                onClick={() => handleSharePaper(paper)}
                disabled={busyAction === `share:${paper.id}`}
              >
                {busyAction === `share:${paper.id}` ? '复制中...' : '分享'}
              </button>
            </div>
          </div>
        );})}
      </div>

      {/* 空状态 */}
      {filteredPapers.length === 0 && (
        <div className="empty-state">
          <LuoCat size={46} className="luo-cat-empty" />
          {trackPapers.length === 0 ? (
            <>
              <p>暂无内置试卷</p>
              <button
                type="button"
                onClick={() => onGoAIGenerate?.()}
                style={{
                  marginTop: 8,
                  height: 32,
                  borderRadius: 8,
                  border: '1px solid var(--accent)',
                  background: 'var(--accent-soft-bg)',
                  color: 'var(--accent)',
                  padding: '0 12px',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                去 AI 出卷
              </button>
            </>
          ) : (
            <p>暂无符合条件的试卷</p>
          )}
        </div>
      )}

      {/* 分页组件 */}
      {totalPages > 1 && (
        <div className="pagination">
          <button
            className="page-btn prev"
            disabled={currentPage === 1}
            onClick={() => setCurrentPage(p => p - 1)}
          >
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
          </button>

          <div className="page-numbers">
            {generatePageNumbers(currentPage, totalPages).map((page, idx) => (
              page === '...' ? (
                <span key={`ellipsis-${idx}`} className="page-ellipsis">...</span>
              ) : (
                <button
                  key={page}
                  className={`page-num ${currentPage === page ? 'active' : ''}`}
                  onClick={() => setCurrentPage(page)}
                >
                  {page}
                </button>
              )
            ))}
          </div>

          <button
            className="page-btn next"
            disabled={currentPage === totalPages}
            onClick={() => setCurrentPage(p => p + 1)}
          >
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
          </button>
        </div>
      )}
    </div>
  );
}

// 生成页码数组
function generatePageNumbers(current, total) {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  const pages = [];
  if (current <= 4) {
    pages.push(1, 2, 3, 4, 5, '...', total);
  } else if (current >= total - 3) {
    pages.push(1, '...', total - 4, total - 3, total - 2, total - 1, total);
  } else {
    pages.push(1, '...', current - 1, current, current + 1, '...', total);
  }
  return pages;
}
