/**
 * 试卷按学科归组（纯函数，题库列表与测试共用）。
 *
 * 归属规则，按优先级：
 *   1. paper.subject_id 命中已存在的科目 → 该科目；
 *   2. paper.subject 与科目名称相同 → 该科目；
 *   3. paper.subject 等于某个学科大类（categoryKey），且该大类只对应一个科目 → 该科目；
 *   4. 其余一律「未归属」，不猜具体科目。
 */

export function resolvePaperSubject(paper, subjectList) {
  const list = Array.isArray(subjectList) ? subjectList : [];
  const subjectId = String(paper?.subject_id || '').trim();
  if (subjectId) return list.find((item) => item.id === subjectId) || null;
  const raw = String(paper?.subject || '').trim();
  if (!raw) return null;
  const byName = list.find((item) => item.name === raw);
  if (byName) return byName;
  const byCategory = list.filter((item) => item.categoryKey && item.categoryKey === raw);
  return byCategory.length === 1 ? byCategory[0] : null;
}

export function buildPaperSubjectIndex(papers, subjectList) {
  const map = new Map();
  (Array.isArray(papers) ? papers : []).forEach((paper) => {
    map.set(paper.id, resolvePaperSubject(paper, subjectList));
  });
  return map;
}

export function buildSubjectStats(papers, subjectList, subjectIndex) {
  const list = Array.isArray(papers) ? papers : [];
  const buckets = new Map();
  (Array.isArray(subjectList) ? subjectList : []).forEach((subject) => {
    buckets.set(subject.id, {
      id: subject.id,
      name: subject.name,
      paperCount: 0,
      questionCount: 0,
      missingAnswers: 0,
    });
  });
  const unassigned = { id: 'unassigned', name: '未归属', paperCount: 0, questionCount: 0, missingAnswers: 0 };

  list.forEach((paper) => {
    const subject = subjectIndex?.get(paper.id) || null;
    const bucket = subject && buckets.has(subject.id) ? buckets.get(subject.id) : unassigned;
    bucket.paperCount += 1;
    bucket.questionCount += Number(paper.actual_question_count ?? paper.question_count ?? 0);
    bucket.missingAnswers += Number(paper.missing_answer_count || 0);
  });

  const rows = [...buckets.values()].filter((item) => item.paperCount > 0);
  if (unassigned.paperCount > 0) rows.push(unassigned);
  const total = {
    id: 'all',
    name: '跨学科总览',
    paperCount: list.length,
    questionCount: rows.reduce((sum, item) => sum + item.questionCount, 0),
    missingAnswers: rows.reduce((sum, item) => sum + item.missingAnswers, 0),
  };
  return { list: rows, total };
}
