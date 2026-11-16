/**
 * 题目答案的公共判断：文字答案与图片答案都算「有答案」。
 * 图片引用由主进程写在 questions.answer_images（openexam-asset://question-assets/...）。
 */
export const getAnswerImages = (question) => {
  const list = question?.answerImages ?? question?.answer_images;
  if (Array.isArray(list)) return list.map((item) => String(item || '').trim()).filter(Boolean);
  if (typeof list === 'string' && list.trim()) {
    try {
      const parsed = JSON.parse(list);
      return Array.isArray(parsed) ? parsed.map((item) => String(item || '').trim()).filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  return [];
};

export const hasQuestionAnswer = (question) => (
  Boolean(String(question?.answer || '').trim()) || getAnswerImages(question).length > 0
);

/** 用户补过（文字或图片）的题，与导入时自带的答案区分开 */
export const isAnswerSupplemented = (question) => {
  const source = String(question?.answer_source || question?.answerSource || '');
  const status = String(question?.answer_status || question?.answerStatus || '');
  return source.startsWith('user_') || status === 'user_supplemented';
};
