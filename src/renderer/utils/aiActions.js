/**
 * AI 动作执行：把模型给出的 <action> 落到真实数据。
 *
 * 原来这段逻辑写在 AssistantPanel 组件里，合并成单会话后抽出来，
 * 新界面只负责渲染卡片和更新状态。所有写库调用仍走既有 IPC，不新增数据通路。
 *
 * ctx: { subjectId, subjects, toast, onNavigate, loadSubjects, settings, isConfigured }
 */

async function importQuestions(action, ctx) {
  const subject = (ctx.subjects || []).find((item) => item.id === (action.subjectId || ctx.subjectId));
  if (action.appendToPaperId) {
    const appended = await window.openexam.db.appendImportedQuestions(action.appendToPaperId, action.questions);
    const total = appended?.questionCount || 0;
    ctx.toast?.({ title: '已追加到题库', message: `本次追加 ${appended?.appended || 0} 道，该试卷现有 ${total} 道题`, tone: 'success' });
    ctx.onNavigate?.('papers');
    return `已追加到《${action.title}》，本次 ${appended?.appended || 0} 道，该试卷现有 ${total} 道题。`;
  }
  const result = await window.openexam.db.importPaper(
    {
      title: action.title,
      subject: action.subject || 'xingce',
      category: action.questions?.[0]?.category || 'xingce',
      subjectId: subject?.id || null,
      type: 'imported',
    },
    action.questions,
  );
  const count = result?.questionCount || action.questions.length;
  ctx.toast?.({ title: '已写入题库', message: `《${result?.title || action.title}》共 ${count} 道题`, tone: 'success' });
  ctx.onNavigate?.('papers');
  return `已写入题库《${result?.title || action.title}》，共 ${count} 道题${subject ? `（科目：${subject.name}）` : ''}。`;
}

async function addSubject(action, ctx) {
  const subject = await window.openexam.subject.save({ name: action.name, examDate: action.examDate || null });
  await ctx.loadSubjects?.();
  ctx.toast?.({ title: '科目已创建', message: `「${subject.name}」已创建并绑定到当前对话`, tone: 'success' });
  return `已创建科目「${subject.name}」并绑定到当前对话。接下来可以到「我的科目」上传教材，或直接把题目发给我。`;
}

async function writeNotes(action, ctx) {
  const subjectId = action.subjectId || ctx.subjectId || null;
  const subject = (ctx.subjects || []).find((item) => item.id === subjectId);
  const saved = [];
  for (const note of action.notes) {
    const row = await window.openexam.note.save({
      title: note.title,
      content: note.content,
      tags: subject
        ? [subject.name, note.kind === 'plan' ? '学习计划' : note.kind === 'daily' ? '每日学习' : note.kind === 'summary' ? '总结' : '学科笔记']
        : ['AI 助教'],
      sourceType: 'subject',
      sourceId: subjectId || null,
      sourceLabel: 'AI 助教',
      subjectId,
      meta: { kind: note.kind, category: 'subject', subject: subject?.name || '' },
    });
    saved.push(row?.id || '');
  }
  ctx.toast?.({ title: '笔记已写入', message: `共 ${saved.length} 篇${subject ? `（科目：${subject.name}）` : ''}`, tone: 'success' });
  ctx.onNavigate?.('notes');
  return `已写入笔记库 ${saved.length} 篇${subject ? `（科目：${subject.name}，同步后可在 Obsidian 仓库里看到）` : ''}。`;
}

async function generateInventory(action, ctx) {
  const subjectId = action.subjectId || ctx.subjectId;
  if (!subjectId) throw new Error('当前对话没有绑定科目，无法生成知识清单');
  const scopeText = action.startChapter
    ? `从「${action.startChapter}」开始`
    : (action.fromPage || action.toPage ? `第 ${action.fromPage || 1}–${action.toPage || '末'} 页` : '整科');
  ctx.toast?.({ title: '正在按章生成知识清单', message: `${scopeText}，逐章分批调用模型，可能需要几分钟`, tone: 'info' });
  const result = await window.openexam.subject.generateInventory({
    subjectId,
    settings: ctx.settings,
    source: action.source || (action.materialId ? 'material' : 'auto'),
    materialId: action.materialId || '',
    startChapter: action.startChapter || '',
    learnedChapters: Array.isArray(action.learnedChapters) ? action.learnedChapters : [],
    fromPage: Number(action.fromPage) || 0,
    toPage: Number(action.toPage) || 0,
    modules: Array.isArray(action.modules) ? action.modules : [],
    keepExisting: action.keepExisting !== false,
    forceRerun: action.forceRerun === true,
    concurrency: Number(action.concurrency) || 0,
  });
  if (!result?.success) throw new Error(result?.error || '知识清单生成失败');
  const details = [
    `共 ${result.chars || 0} 字`,
    `${result.chapterCount || 0} 章 / ${result.batches || 0} 批`,
    `并发 ${result.concurrency || 1}`,
  ];
  if (result.resumedChapters?.length) details.push(`续跑跳过 ${result.resumedChapters.length} 章`);
  if (result.truncated) details.push('有批次被输出上限截断');
  if (result.failedChapters?.length) details.push(`${result.failedChapters.length} 章失败`);
  // 计划时的旧笔记已被删除：本次是新建，必须让用户知道
  if (result.notice) details.push(result.notice);
  ctx.toast?.({ title: '知识清单已更新', message: details.join('，'), tone: result.truncated || result.failedChapters?.length ? 'warning' : 'success' });
  ctx.onNavigate?.('notes');

  // 实际执行范围与计划不一致时（续跑、失败、批次变化）如实说明
  const planned = ctx.plan?.details?.inventory || null;
  const differences = [];
  const actualRequestBatches = Math.max(0, Number(result.batches || 0) - Number(result.skippedBatches || 0));
  if (planned) {
    if (result.resumedChapters?.length) {
      differences.push(`续跑命中缓存，跳过 ${result.resumedChapters.length} 章：${result.resumedChapters.map((item) => item.title || item).join('、')}`);
    }
    if (result.failedChapters?.length) {
      differences.push(`${result.failedChapters.length} 章生成失败、保留旧版：${result.failedChapters.map((item) => item.chapter).join('、')}`);
    }
    if (Number.isFinite(Number(planned.requestBatches)) && actualRequestBatches !== Number(planned.requestBatches)) {
      differences.push(`计划请求 ${planned.requestBatches} 批，实际请求 ${actualRequestBatches} 批`);
    }
    // 计划卡按「更新旧笔记」展示，实际却新建了：属于必须如实说明的差异
    if (result.previousNoteMissing) {
      differences.push(result.notice || '原清单已被删除，已按缓存内容新建');
    }
    const plannedChapters = Array.isArray(planned.selectedChapters) ? planned.selectedChapters.length : null;
    if (plannedChapters !== null && Number(result.chapterCount) !== plannedChapters) {
      differences.push(`计划处理 ${plannedChapters} 章，实际处理 ${result.chapterCount || 0} 章`);
    }
  }

  const summary = [
    `知识清单已写入笔记库（${result.chars || 0} 字，${result.chapterCount || 0} 章 / ${result.batches || 0} 批）${result.truncated ? '。注意：有批次被输出上限截断，结果可能不完整' : ''}。`,
    differences.length ? `与计划的差异：${differences.join('；')}。` : '',
  ].filter(Boolean).join('\n');

  return {
    summary,
    extraMeta: {
      actionDiff: {
        type: 'inventory',
        planned,
        actual: {
          chapters: result.chapterCount || 0,
          batches: result.batches || 0,
          requestBatches: actualRequestBatches,
          resumedChapters: result.resumedChapters || [],
          failedChapters: result.failedChapters || [],
          preservedChapters: result.preservedChapters || [],
        },
        differences,
      },
      noteId: result.noteId || '',
    },
  };
}

/** 修改已有笔记：读原文、局部改写、写前快照、返回差异 */
async function editNote(action, ctx) {
  const subjectId = action.subjectId || ctx.subjectId || '';
  const result = await window.openexam.note.applyEdit({
    noteId: action.noteId || '',
    titleQuery: action.titleQuery || '',
    subjectId,
    operation: action.operation || 'replace_section',
    section: action.section || '',
    find: action.find || '',
    content: action.content || '',
    wholeNote: action.wholeNote === true,
  });
  if (!result?.success) {
    throw new Error(result?.message || result?.error || '笔记修改失败');
  }
  ctx.onNavigate?.('notes');

  const hunk = result.diff?.hunks?.[0];
  const rangeText = hunk
    ? (result.diff.removedLines && result.diff.addedLines
      ? `第 ${hunk.beforeStart}–${hunk.beforeEnd} 行 → 第 ${hunk.afterStart}–${hunk.afterEnd} 行（替换 ${result.diff.removedLines} 行 / 新增 ${result.diff.addedLines} 行）`
      : result.diff.addedLines
        ? `第 ${hunk.afterStart}–${hunk.afterEnd} 行新增 ${result.diff.addedLines} 行`
        : `第 ${hunk.beforeStart}–${hunk.beforeEnd} 行移除 ${result.diff.removedLines} 行`)
    : '正文有更新';
  const sectionText = result.section ? `「${result.section.title}」` : '';
  const summary = [
    `已修改笔记《${result.note?.title || '未命名笔记'}》${result.wholeNote ? '（整篇重写）' : sectionText ? `的${sectionText}` : ''}：${rangeText}。`,
    result.diff?.changedSections?.length ? `涉及小节：${result.diff.changedSections.join('、')}。` : '',
    result.snapshotPath ? `旧版快照：${result.snapshotPath}` : '',
  ].filter(Boolean).join('\n');

  return {
    summary,
    extraMeta: {
      actionDiff: {
        type: 'note',
        noteId: result.note?.id || '',
        noteTitle: result.note?.title || '',
        operation: result.operation,
        operationLabel: result.operationLabel,
        section: result.section || null,
        wholeNote: Boolean(result.wholeNote),
        snapshotPath: result.snapshotPath || '',
        beforeChars: result.beforeChars,
        afterChars: result.afterChars,
        diff: result.diff,
      },
      noteId: result.note?.id || '',
    },
  };
}

async function textbookQuestions(action, ctx) {
  const subjectId = action.subjectId || ctx.subjectId;
  if (!subjectId) throw new Error('当前对话没有绑定科目，无法从资料导入题目');
  ctx.toast?.({ title: '正在从资料提取题目', message: '有主教材时用教材，否则逐份扫描补充资料；可能需要几分钟', tone: 'info' });
  const result = await window.openexam.subject.generateQuestions({
    subjectId,
    settings: ctx.settings,
    pages: action.pages || undefined,
    title: action.title || undefined,
    paperId: action.paperId || undefined,
    source: action.source || 'auto',
    materialIds: Array.isArray(action.materialIds) ? action.materialIds : undefined,
  });
  if (!result?.success) throw new Error(result?.error || result?.note || '题目提取失败');
  const count = Number(result.questions) || 0;
  if (count) ctx.onNavigate?.('papers');
  const messages = [];
  messages.push(count ? `已从资料导入 ${count} 道题到题库。` : `没有新增题目：${result.note || '未识别到新题'}。`);
  if (count && result.pendingClassification) {
    messages.push(result.classificationNote || '未上传主教材：题目已入库，暂未按知识图谱分类。');
  }
  const missing = Array.isArray(result.missingPages) ? result.missingPages : [];
  if (missing.length) {
    messages.push(`注意：${missing.slice(0, 6).join('、')}${missing.length > 6 ? ' 等页' : ''}未转出文字，相关题目可能缺失。`);
  }
  return messages.join('');
}

async function classifyQuestions(action, ctx) {
  const subjectId = action.subjectId || ctx.subjectId;
  if (!subjectId) throw new Error('当前对话没有绑定科目，无法按知识图谱分类');
  if (!ctx.isConfigured) throw new Error('还没配置 AI 模型，请先到「设置 → AI 模型」配置');
  ctx.toast?.({ title: '正在按知识图谱分类', message: '会依据教材知识清单逐题归类，可能需要几分钟', tone: 'info' });
  const result = await window.openexam.ai.classifySubject(
    ctx.settings,
    { subjectId, onlyMissing: Boolean(action.onlyMissing), confirmed: true },
    `classify_subject_${Date.now()}`,
  );
  if (result?.error) throw new Error(result.error);
  const distribution = (result?.chapterDistribution || []).slice(0, 8)
    .map((item) => `${item.chapter} ${item.count} 题`).join('、');
  if (!result?.total) return `没有需要分类的题目${distribution ? `。现有章节分布：${distribution}` : ''}。`;
  return [
    `已完成知识图谱分类：处理 ${result.total} 题，写入 ${result.changed || 0} 题，跳过 ${result.skipped || 0} 题。`,
    distribution ? `章节分布：${distribution}` : '',
  ].filter(Boolean).join('\n');
}

async function subjectProfile(action, ctx) {
  const subjectId = action.subjectId || ctx.subjectId;
  if (!subjectId) throw new Error('当前对话没有绑定科目，无法存档学习基础');
  const current = await window.openexam.subject.get(subjectId);
  const merged = { ...(current?.profile || {}), ...(action.profile || {}) };
  await window.openexam.subject.save({ id: subjectId, profile: merged });
  await ctx.loadSubjects?.();
  return `已存档你的学习基础（${merged.level || '未填'}，每天 ${merged.dailyHours || '?'} 小时 × 每周 ${merged.weeklyDays || '?'} 天）。`;
}

async function wrongQuestions(action, ctx) {
  const saved = [];
  const failed = [];
  for (const question of action.questions) {
    try {
      const row = await window.openexam.db.saveCustomWrongQuestion({
        type: question.type,
        content: question.content,
        options: question.options,
        answer: question.answer,
        analysis: question.analysis,
        userAnswer: question.userAnswer,
        reason: question.reason,
        sourceType: 'manual',
        sourceLabel: 'AI 助教录入',
      });
      saved.push(row?.id || '');
    } catch (error) {
      failed.push(error?.message || String(error));
    }
  }
  if (!saved.length) throw new Error(failed[0] || '错题写入失败');
  ctx.onNavigate?.('wrong-book');
  return failed.length
    ? `已加入错题本 ${saved.length} 道，另有 ${failed.length} 道没写进去（${failed[0]}）。`
    : `已加入错题本，共 ${saved.length} 道。`;
}

async function planOps(action, ctx) {
  const detail = [];
  const failed = [];
  for (const op of action.ops) {
    try {
      if (op.op === 'add') {
        await window.openexam.todo.addInstance({
          title: op.title,
          kind: op.kind,
          target: op.target || { unit: 'count', value: 1 },
          date: op.date || undefined,
        });
        detail.push(`新增「${op.title}」`);
      } else if (op.op === 'update') {
        await window.openexam.todo.updateInstance({
          id: op.id,
          title: op.title || undefined,
          target: op.target || undefined,
          progress: Number.isFinite(op.progress) ? op.progress : undefined,
          status: op.status || undefined,
        });
        detail.push(`修改「${op.title || op.id}」`);
      } else if (op.op === 'delete') {
        await window.openexam.todo.deleteInstance(op.id);
        detail.push('删除一条待办');
      }
    } catch (error) {
      failed.push(`${op.title || op.id}：${error?.message || String(error)}`);
    }
  }
  if (!detail.length) throw new Error(failed[0] || '计划调整失败');
  ctx.onNavigate?.('today');
  return failed.length
    ? `计划已更新：${detail.join('；')}。有 ${failed.length} 项没改成（${failed[0]}）。`
    : `计划已更新：${detail.join('；')}。`;
}

const NOTE_OPERATION_LABELS = {
  replace_section: '只改这一节',
  append_after_section: '在这一节后追加',
  replace_text: '替换指定原文',
  append_to_note: '追加到笔记末尾',
  replace_whole: '整篇重写',
};

function findSubject(ctx, subjectId) {
  return (ctx.subjects || []).find((item) => item.id === subjectId) || null;
}

function formatTime(value) {
  const text = String(value || '').replace('T', ' ');
  return text.slice(0, 16) || '未知';
}

function countQuestionsByType(questions = []) {
  const counter = new Map();
  for (const question of questions) {
    const type = String(question?.type || 'single');
    counter.set(type, (counter.get(type) || 0) + 1);
  }
  const names = { single: '单选', multiple: '多选', judge: '判断', fill: '填空', subjective: '主观' };
  return [...counter.entries()].map(([type, count]) => `${names[type] || type} ${count}`).join('、');
}

function summarizeChapters(chapters = []) {
  if (!chapters.length) return '';
  if (chapters.length <= 4) {
    return chapters.map((chapter) => `第${chapter.no}章 ${chapter.title}${chapter.fromPage ? `（第 ${chapter.fromPage}–${chapter.toPage} 页）` : ''}`).join('、');
  }
  const first = chapters[0];
  const last = chapters[chapters.length - 1];
  const sample = chapters.slice(0, 3).map((chapter) => chapter.title).join('、');
  return `第 ${first.no}–${last.no} 章（共 ${chapters.length} 章：${sample} 等）${first.fromPage ? `，约第 ${first.fromPage}–${last.toPage || '末'} 页` : ''}`;
}

function describeDiffRange(diff) {
  const hunk = diff?.hunks?.[0];
  if (!hunk) return '';
  if (diff.removedLines && diff.addedLines) {
    return `第 ${hunk.beforeStart}–${hunk.beforeEnd} 行 → 第 ${hunk.afterStart}–${hunk.afterEnd} 行（替换 ${diff.removedLines} 行 / 新增 ${diff.addedLines} 行）`;
  }
  if (diff.addedLines) return `第 ${hunk.afterStart}–${hunk.afterEnd} 行新增 ${diff.addedLines} 行`;
  return `第 ${hunk.beforeStart}–${hunk.beforeEnd} 行移除 ${diff.removedLines} 行`;
}

/**
 * 只读计划：把「点执行后会发生什么」提前说清楚。
 * 不写库、不调用模型；edit_note / generate_inventory 走主进程的同一份解析逻辑，
 * 保证计划与执行口径一致。
 */
async function buildActionPlan(action, ctx = {}) {
  const plan = {
    type: action?.type || '',
    label: ACTION_LABELS[action?.type] || '执行动作',
    target: '',
    scope: [],
    write: [],
    cost: [],
    warnings: [],
    needsChoice: false,
    choiceField: '',
    candidates: [],
    availableSections: [],
    error: '',
    details: {},
  };
  if (!action?.type) {
    plan.error = '缺少动作类型';
    return plan;
  }

  try {
    if (action.type === 'import_questions') {
      const subjectId = action.subjectId || ctx.subjectId;
      const subject = findSubject(ctx, subjectId);
      const count = action.questions?.length || 0;
      plan.target = `科目：${subject?.name || action.subject || '未指定'}｜试卷《${action.title || '未命名试卷'}》`;
      plan.scope = [
        action.appendToPaperId ? `向已有试卷追加 ${count} 道题` : `新建试卷并写入 ${count} 道题`,
        count ? `题型：${countQuestionsByType(action.questions)}` : '',
      ].filter(Boolean);
      plan.write = [action.appendToPaperId ? `题库：追加到试卷 ${action.appendToPaperId}（不新建）` : `题库：新建《${action.title || '未命名试卷'}》`];
      plan.cost = ['本地写入，不调用模型'];
    } else if (action.type === 'add_wrong_questions') {
      const count = action.questions?.length || 0;
      plan.target = `错题本｜${count} 道错题`;
      plan.scope = [`新增 ${count} 道错题`, count ? `题型：${countQuestionsByType(action.questions)}` : ''].filter(Boolean);
      plan.write = ['错题本：新增错题记录'];
      plan.cost = ['本地写入，不调用模型'];
    } else if (action.type === 'adjust_plan') {
      const ops = action.ops || [];
      plan.target = '今日待办 / 学习计划';
      plan.scope = ops.map((op) => {
        if (op.op === 'add') return `新增「${op.title}」（目标 ${op.target?.value || 1}）`;
        if (op.op === 'update') return `修改「${op.title || op.id}」${op.target?.value ? `，目标改为 ${op.target.value}` : ''}`;
        return `删除「${op.title || op.id}」`;
      });
      plan.write = ['今日待办：按上述条目增删改'];
      plan.cost = ['本地写入，不调用模型'];
    } else if (action.type === 'write_notes') {
      const subjectId = action.subjectId || ctx.subjectId;
      const subject = findSubject(ctx, subjectId);
      const notes = action.notes || [];
      plan.target = `科目：${subject?.name || '未绑定科目'}｜笔记库`;
      plan.scope = [`新建 ${notes.length} 篇笔记${notes.length ? `：${notes.map((note) => note.title).filter(Boolean).slice(0, 6).join('、')}` : ''}`];
      plan.write = ['笔记库：新建笔记（不会覆盖已有笔记）', '保存后同步到 Obsidian'];
      plan.cost = ['本地写入，不调用模型'];
      plan.warnings = ['只新建、不覆盖；要改已有笔记请用「修改笔记」'];
    } else if (action.type === 'edit_note') {
      const subjectId = action.subjectId || ctx.subjectId || '';
      if (!window.openexam?.note?.planEdit) throw new Error('当前版本不支持笔记修改');
      const result = await window.openexam.note.planEdit({
        noteId: action.noteId || '',
        titleQuery: action.titleQuery || '',
        subjectId,
        operation: action.operation || 'replace_section',
        section: action.section || '',
        find: action.find || '',
        content: action.content || '',
        wholeNote: action.wholeNote === true,
      });
      if (!result || result.success === false) {
        throw new Error(result?.message || result?.error || '读取笔记修改计划失败');
      }
      plan.details.note = result;
      if (result.ok) {
        const note = result.note;
        plan.target = `笔记《${note.title}》｜科目：${note.subjectName || '未绑定'}｜更新：${formatTime(note.updatedAt)}｜${note.chars} 字`;
        plan.scope = [
          `操作：${result.operationLabel || NOTE_OPERATION_LABELS[result.operation] || result.operation}${result.section ? ` · 「${result.section.title}」（第 ${result.section.startLine}–${result.section.endLine} 行）` : ''}`,
          describeDiffRange(result.diff),
          result.diff?.changedSections?.length ? `涉及小节：${result.diff.changedSections.join('、')}` : '',
          '未涉及的段落保持原样',
        ].filter(Boolean);
        plan.write = [`写入笔记《${note.title}》（${note.id}）`, '写入前保留旧版快照'];
        plan.cost = ['本地写入，不调用模型'];
        if (result.wholeNote) plan.warnings.push('这是整篇重写，原有正文会被整体替换');
      } else {
        plan.error = result.message || '需要先确认要改哪一篇 / 哪一节';
        plan.needsChoice = Boolean(result.needsChoice && (result.candidates || []).length);
        plan.choiceField = result.choiceField || '';
        plan.candidates = result.candidates || [];
        plan.availableSections = result.availableSections || [];
        if (result.note) {
          plan.target = `笔记《${result.note.title}》｜科目：${result.note.subjectName || '未绑定'}｜${result.note.chars} 字`;
        }
        if (plan.needsChoice) {
          plan.scope.push(plan.choiceField === 'section' ? '需要你先选择具体小节，选完会重新生成计划' : '需要你先选择具体一篇笔记，选完会重新生成计划');
        }
        if (plan.availableSections.length) {
          plan.scope.push(`笔记里可用的节：${plan.availableSections.slice(0, 8).map((section) => section.title).join('、')}`);
        }
      }
    } else if (action.type === 'generate_inventory') {
      const subjectId = action.subjectId || ctx.subjectId;
      if (!subjectId) throw new Error('当前对话没有绑定科目');
      if (!window.openexam?.subject?.planInventory) throw new Error('当前版本不支持知识清单计划');
      const result = await window.openexam.subject.planInventory({
        subjectId,
        settings: ctx.settings,
        source: action.source || (action.materialId ? 'material' : 'auto'),
        materialId: action.materialId || '',
        startChapter: action.startChapter || '',
        learnedChapters: Array.isArray(action.learnedChapters) ? action.learnedChapters : [],
        fromPage: Number(action.fromPage) || 0,
        toPage: Number(action.toPage) || 0,
        modules: Array.isArray(action.modules) ? action.modules : [],
        keepExisting: action.keepExisting !== false,
        forceRerun: action.forceRerun === true,
        concurrency: Number(action.concurrency) || 0,
      });
      if (!result?.success) throw new Error(result?.error || '生成知识清单计划失败');
      plan.details.inventory = result;
      const totalChars = (result.chapterPlan || []).reduce((sum, item) => sum + (item.chars || 0), 0);
      plan.target = `科目：${result.subject?.name || '当前科目'}｜资料来源：${result.source?.type === 'primary' ? '主教材' : '补充资料'}《${result.source?.name || '未知'}》`;
      plan.scope = [
        `本次重写 ${result.selectedChapters?.length || 0} 章：${summarizeChapters(result.selectedChapters || [])}`,
        result.preservedChapters?.length ? `保留 ${result.preservedChapters.length} 章原文：${result.preservedChapters.map((chapter) => `第${chapter.no}章`).join('、')}` : '',
        action.learnedChapters?.length ? `已学章节按「已学·待测」标注：${action.learnedChapters.join('、')}` : '',
        result.forceRerun ? '已选择强制重跑：不使用章节缓存' : (result.resumedChapters?.length ? `续跑复用 ${result.resumedChapters.length} 章：${result.resumedChapters.map((item) => item.title).join('、')}（不重新请求）` : '没有可复用的章节缓存'),
      ].filter(Boolean);
      plan.write = [
        `覆盖/更新笔记《${result.writeNoteTitle}》${result.existingNote ? '（已有，将更新）' : '（新建）'}`,
        `写入前保留旧版快照：${result.snapshotHint || '教材/清单快照/'}`,
        '同时更新该科目的知识清单摘要，供题库分类使用',
      ];
      plan.cost = [
        `共 ${result.totalBatches} 批：本次请求 ${result.requestBatches} 批${result.skippedBatches ? `，续跑复用 ${result.skippedBatches} 批` : ''}`,
        `并发 ${result.concurrency} 路`,
        `条目估计：约 ${result.estimatedEntries} 条（按原文 ${totalChars} 字估算，实际以模型输出为准）`,
      ];
      if (result.structureWarnings?.length) plan.warnings.push(...result.structureWarnings);
      const autoChapters = (result.selectedChapters || []).filter((chapter) => chapter.auto);
      if (autoChapters.length) plan.warnings.push(`${autoChapters.length} 章的页码是自动推断的，建议先在「科目 → 章节结构」校正`);
    } else if (action.type === 'import_textbook_questions') {
      const subjectId = action.subjectId || ctx.subjectId;
      const subject = findSubject(ctx, subjectId);
      const from = action.pages?.from;
      const to = action.pages?.to;
      plan.target = `科目：${subject?.name || '未指定'}｜资料来源：${action.materialIds?.length ? `指定补充资料（${action.materialIds.length} 份）` : '主教材优先，没有则补充资料'}`;
      plan.scope = [
        from || to ? `页码范围：第 ${from || 1}–${to || '末'} 页` : '未指定页码：按整份资料识别',
        action.paperId ? `追加到已有试卷 ${action.paperId}` : `新建试卷《${action.title || '资料例题习题'}》`,
        '识别不出的页面会如实跳过，不会编题',
      ];
      plan.write = [action.paperId ? '题库：向已有试卷追加题目' : '题库：新建试卷并写入题目'];
      plan.cost = [
        from && to ? `预计扫描 ${Math.max(1, to - from + 1)} 页，逐页/分段识别` : '按资料长度分段识别',
        '没有断点续跑缓存，失败需要重新发起',
      ];
    } else if (action.type === 'classify_questions') {
      const subjectId = action.subjectId || ctx.subjectId;
      const subject = findSubject(ctx, subjectId);
      plan.target = `科目：${subject?.name || '当前科目'}｜题库分类`;
      plan.scope = [action.onlyMissing ? '只补缺失的章节/知识点分类' : '重新分类该科目全部题目'];
      plan.write = ['题目的 chapter / knowledge 分类字段（不删除题目）'];
      plan.cost = ['逐题/分批调用模型，题数取决于该科目题库'];
    } else if (action.type === 'update_subject_profile') {
      const subjectId = action.subjectId || ctx.subjectId;
      const subject = findSubject(ctx, subjectId);
      plan.target = `科目：${subject?.name || '当前科目'}｜学习基础`;
      plan.scope = Object.entries(action.profile || {})
        .filter(([, value]) => value !== '' && value !== null && value !== undefined)
        .map(([key, value]) => `${key}：${value}`);
      plan.write = ['科目资料：学习基础 / 可用时间'];
      plan.cost = ['本地写入，不调用模型'];
    } else if (action.type === 'run_analysis_plugin') {
      plan.target = `学科分析插件：${action.pluginId}`;
      plan.scope = ['打开分析工作台', '模型只做结构化识别与讲解，数值由插件代码计算'];
      plan.write = [];
      plan.cost = ['识别会调用一次当前 AI 配置；计算在本地完成'];
    } else if (action.type === 'add_subject') {
      plan.target = `新科目《${action.name}》`;
      plan.scope = ['创建科目', action.examDate ? `考试日期：${action.examDate}` : '未设置考试日期', '创建后绑定到当前对话'];
      plan.write = ['科目列表：新增一项'];
      plan.cost = ['本地写入，不调用模型'];
    } else {
      plan.error = `暂不支持的动作：${action.type}`;
    }
  } catch (error) {
    plan.error = error?.message || String(error);
  }
  return plan;
}

async function applyAIAction(action, ctx = {}) {
  if (!action?.type) throw new Error('缺少动作类型');
  switch (action.type) {
    case 'import_questions': return importQuestions(action, ctx);
    case 'add_wrong_questions': return wrongQuestions(action, ctx);
    case 'adjust_plan': return planOps(action, ctx);
    case 'write_notes': return writeNotes(action, ctx);
    case 'edit_note': return editNote(action, ctx);
    case 'generate_inventory': return generateInventory(action, ctx);
    case 'import_textbook_questions': return textbookQuestions(action, ctx);
    case 'update_subject_profile': return subjectProfile(action, ctx);
    case 'add_subject': return addSubject(action, ctx);
    case 'classify_questions': return classifyQuestions(action, ctx);
    case 'run_analysis_plugin': return '已打开学科分析插件，请在分析工作台里核对结构与结果。';
    default: throw new Error(`暂不支持的动作：${action.type}`);
  }
}

const ACTION_LABELS = {
  import_questions: '写入题库',
  add_wrong_questions: '加入错题本',
  adjust_plan: '调整学习计划',
  write_notes: '写入笔记',
  edit_note: '修改笔记',
  generate_inventory: '生成知识清单',
  import_textbook_questions: '从资料导入题目',
  update_subject_profile: '存档学习基础',
  add_subject: '创建科目',
  classify_questions: '按知识图谱分类',
  run_analysis_plugin: '打开学科分析插件',
};

function describeAction(action) {
  if (!action) return { label: '', detail: '' };
  const label = ACTION_LABELS[action.type] || '执行动作';
  let detail = '';
  if (action.type === 'import_questions') {
    detail = `《${action.title || '未命名试卷'}》${action.questions?.length || 0} 道题`;
  } else if (action.type === 'add_wrong_questions') {
    detail = `${action.questions?.length || 0} 道错题`;
  } else if (action.type === 'adjust_plan') {
    detail = `${action.ops?.length || 0} 项计划调整`;
  } else if (action.type === 'write_notes') {
    detail = (action.notes || []).map((note) => note.title).filter(Boolean).join('、');
  } else if (action.type === 'edit_note') {
    detail = [
      action.titleQuery || '指定笔记',
      NOTE_OPERATION_LABELS[action.operation] || '局部修改',
      action.section || '',
    ].filter(Boolean).join(' · ');
  } else if (action.type === 'add_subject') {
    detail = action.name || '';
  } else if (action.type === 'import_textbook_questions') {
    detail = action.title || (action.pages ? `第 ${action.pages} 页` : '资料例题习题');
  } else if (action.type === 'generate_inventory' || action.type === 'classify_questions') {
    detail = '需要几分钟';
  } else if (action.type === 'update_subject_profile') {
    detail = '学习基础 / 可用时间';
  }
  return { label, detail };
}

export { applyAIAction, describeAction, buildActionPlan, ACTION_LABELS };
