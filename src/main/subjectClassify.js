/**
 * 按科目范围重新分类题目（复用既有分类链路）
 *
 * 只做三件事：分批调用 aiService.classifyQuestions → 过滤掉无法判断的题
 * → database.applyQuestionClassifications 回写 sub_category / chapter / tags。
 *
 * 题干、选项、答案解析一律不动；无法归入真实章节的题保持原样，
 * 由调用方在结果里统计「跳过多少题」。
 */

const aiService = require('./ai/index.js');
const { OTHER_CHAPTER, parseKnowledgeSummaryTaxonomy } = require('../shared/knowledgeTaxonomy');

const BATCH_SIZE = 12;
const CONCURRENCY = 2;

async function classifySubjectQuestions({
  database,
  settings,
  subject,
  questions,
  taxonomy,
  signal,
  requestId,
  onProgress,
}) {
  const list = Array.isArray(questions) ? questions : [];
  const total = list.length;
  if (!total) {
    return { total: 0, classified: 0, changed: 0, skipped: 0, failed: 0, cancelled: false };
  }

  const batches = [];
  for (let offset = 0; offset < total; offset += BATCH_SIZE) {
    batches.push(list.slice(offset, offset + BATCH_SIZE));
  }

  const updates = [];
  let failed = 0;
  let done = 0;
  const emit = (payload) => {
    try {
      onProgress?.(payload);
    } catch (error) {
      console.warn('[Classify] 进度回调失败:', error?.message || error);
    }
  };

  emit({ stage: 'start', done: 0, total, batches: batches.length });

  const runBatch = async (batch) => {
    if (signal?.aborted) return;
    try {
      const result = await aiService.classifyQuestions(settings, batch, { signal, taxonomy });
      if (result?.error) throw new Error(result.error);
      (result?.results || []).forEach((row) => {
        const source = batch[row.index];
        if (!source) return;
        // 章节对不上教材目录（或模型明确判断不了）的题不回写，保持原样
        if (!row.chapter || row.chapter === OTHER_CHAPTER) return;
        updates.push({ id: source.id, ...row });
      });
    } catch (error) {
      if (signal?.aborted) return;
      failed += 1;
      console.warn(`[Classify][${requestId || 'no-request'}] batch failed`, { error: error?.message || String(error) });
    } finally {
      done += batch.length;
      emit({ stage: 'progress', done: Math.min(done, total), total });
    }
  };

  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, batches.length) }, async () => {
    while (cursor < batches.length && !signal?.aborted) {
      const index = cursor;
      cursor += 1;
      await runBatch(batches[index]);
    }
  });
  await Promise.all(workers);

  const applied = database.applyQuestionClassifications(
    updates,
    taxonomy ? { taxonomy, requireChapter: true } : { requireChapter: true }
  );

  const classified = Math.max(0, updates.length - (applied.skipped || 0));
  const result = {
    total,
    classified,
    changed: Number(applied.changed) || 0,
    skipped: Math.max(0, total - classified),
    failed,
    cancelled: Boolean(signal?.aborted),
  };
  emit({ stage: 'done', done: Math.min(done, total), total, ...result });
  return result;
}

/**
 * 「题库重新分类」入口：按试卷所属科目分组。
 * - 自建科目：用教材知识清单约束子类别和章节，对不上目录的题跳过不写；
 * - 预置四科：沿用原有共享大纲，不改变旧行为。
 */
async function reclassifyQuestions({
  database,
  settings,
  questions,
  resolveSubject,
  signal,
  requestId,
  onProgress,
}) {
  const list = Array.isArray(questions) ? questions : [];
  const total = list.length;
  if (!total) {
    return { total: 0, classified: 0, changed: 0, skipped: 0, failed: 0, cancelled: false, error: '' };
  }

  const groups = new Map();
  list.forEach((question) => {
    const subject = resolveSubject?.(question) || null;
    const key = String(subject?.id || '');
    if (!groups.has(key)) groups.set(key, { subject, questions: [] });
    groups.get(key).questions.push(question);
  });

  const emit = (payload) => {
    try {
      onProgress?.(payload);
    } catch (error) {
      console.warn('[Reclassify] 进度回调失败:', error?.message || error);
    }
  };

  let classified = 0;
  let changed = 0;
  let skipped = 0;
  let failed = 0;
  let done = 0;
  const missingInventory = [];

  emit({ stage: 'start', done: 0, total, batches: Math.ceil(total / BATCH_SIZE) });

  for (const group of groups.values()) {
    const categoryKey = String(group.subject?.categoryKey || '').trim();
    const isCustomSubject = Boolean(group.subject) && !categoryKey;
    const taxonomy = isCustomSubject
      ? parseKnowledgeSummaryTaxonomy(group.subject.knowledgeSummary)
      : null;

    if (isCustomSubject && !taxonomy) {
      skipped += group.questions.length;
      done += group.questions.length;
      missingInventory.push(group.subject?.name || '未命名科目');
      emit({ stage: 'progress', done, total });
      continue;
    }

    const batches = [];
    for (let offset = 0; offset < group.questions.length; offset += BATCH_SIZE) {
      batches.push(group.questions.slice(offset, offset + BATCH_SIZE));
    }
    const updates = [];

    const runBatch = async (batch) => {
      if (signal?.aborted) return;
      try {
        const result = await aiService.classifyQuestions(settings, batch, { signal, taxonomy });
        if (result?.error) throw new Error(result.error);
        (result?.results || []).forEach((row) => {
          const source = batch[row.index];
          if (!source) return;
          if (taxonomy && (!row.chapter || row.chapter === OTHER_CHAPTER)) return;
          updates.push({ id: source.id, ...row });
        });
      } catch (error) {
        if (signal?.aborted) return;
        failed += 1;
        console.warn(`[Reclassify][${requestId || 'no-request'}] batch failed`, { error: error?.message || String(error) });
      } finally {
        done += batch.length;
        emit({ stage: 'progress', done: Math.min(done, total), total });
      }
    };

    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, batches.length) }, async () => {
      while (cursor < batches.length && !signal?.aborted) {
        const index = cursor;
        cursor += 1;
        await runBatch(batches[index]);
      }
    });
    await Promise.all(workers);

    const applied = database.applyQuestionClassifications(
      updates,
      taxonomy ? { taxonomy, requireChapter: true } : {}
    );
    const groupClassified = Math.max(0, updates.length - (applied.skipped || 0));
    classified += groupClassified;
    changed += Number(applied.changed) || 0;
    skipped += Math.max(0, group.questions.length - groupClassified);
  }

  const result = {
    total,
    classified,
    changed,
    skipped,
    failed,
    cancelled: Boolean(signal?.aborted),
    error: missingInventory.length
      ? `${Array.from(new Set(missingInventory)).join('、')} 还没有可用的知识清单（教材未解析完成），这些科目未写入分类`
      : '',
  };
  emit({ stage: 'done', done: Math.min(done, total), total, ...result });
  return result;
}

module.exports = { classifySubjectQuestions, reclassifyQuestions };
