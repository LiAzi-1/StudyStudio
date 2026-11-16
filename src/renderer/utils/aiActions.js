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
        ? [subject.name, note.kind === 'knowledge' ? '知识清单' : note.kind === 'plan' ? '学习计划' : note.kind === 'daily' ? '每日学习' : '总结']
        : ['AI 助教'],
      sourceType: 'subject',
      sourceId: subjectId || null,
      sourceLabel: 'AI 助教',
      subjectId,
      meta: { kind: note.kind, subject: subject?.name || '' },
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
  ctx.toast?.({ title: '知识清单已更新', message: details.join('，'), tone: result.truncated || result.failedChapters?.length ? 'warning' : 'success' });
  ctx.onNavigate?.('notes');
  return `知识清单已写入笔记库（${result.chars || 0} 字，${result.chapterCount || 0} 章 / ${result.batches || 0} 批）${result.truncated ? '。注意：有批次被输出上限截断，结果可能不完整' : ''}。`;
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

async function applyAIAction(action, ctx = {}) {
  if (!action?.type) throw new Error('缺少动作类型');
  switch (action.type) {
    case 'import_questions': return importQuestions(action, ctx);
    case 'add_wrong_questions': return wrongQuestions(action, ctx);
    case 'adjust_plan': return planOps(action, ctx);
    case 'write_notes': return writeNotes(action, ctx);
    case 'generate_inventory': return generateInventory(action, ctx);
    case 'import_textbook_questions': return textbookQuestions(action, ctx);
    case 'update_subject_profile': return subjectProfile(action, ctx);
    case 'add_subject': return addSubject(action, ctx);
    case 'classify_questions': return classifyQuestions(action, ctx);
    default: throw new Error(`暂不支持的动作：${action.type}`);
  }
}

const ACTION_LABELS = {
  import_questions: '写入题库',
  add_wrong_questions: '加入错题本',
  adjust_plan: '调整学习计划',
  write_notes: '写入笔记',
  generate_inventory: '生成知识清单',
  import_textbook_questions: '从资料导入题目',
  update_subject_profile: '存档学习基础',
  add_subject: '创建科目',
  classify_questions: '按知识图谱分类',
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

export { applyAIAction, describeAction, ACTION_LABELS };
