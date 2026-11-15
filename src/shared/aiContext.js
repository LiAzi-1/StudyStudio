/**
 * AI 助教（合并后）的上下文拼装。
 *
 * 答疑与“帮我做事”共用同一份题目上下文描述，渲染层和主进程都从这里取，
 * 避免两套文案漂移。
 */

function buildQuestionContextPrompt(context) {
  if (!context) return '';
  const options = Array.isArray(context.options)
    ? context.options.map((opt) => `${opt.key}. ${opt.content}`).join('\n')
    : '';

  return [
    '[当前题目上下文]',
    `试卷: ${context.paperTitle || '未知试卷'}`,
    `题号: 第${context.index || '?'}题 / 共${context.total || '?'}题`,
    `分类: ${context.category || '未分类'} ${context.subCategory || ''}`.trim(),
    `题干: ${context.content || ''}`,
    options ? `选项:\n${options}` : '选项: 无',
    `我的答案: ${context.userAnswer || '未作答'}`,
    `参考答案: ${context.answer || '未知'}`,
    context.analysis ? `解析: ${context.analysis}` : '解析: 暂无',
  ].join('\n');
}

module.exports = { buildQuestionContextPrompt };
