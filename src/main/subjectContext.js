'use strict';
/**
 * 科目上下文：Good Learning skill + 科目现状 + 资料分层 + 本轮检索原文。
 *
 * 原来这段逻辑只存在于 AI 老师的 chat 处理器里，AI 助教另走一套提示词。
 * 合并 AI 后把它抽出来，答疑与做事共用同一份上下文。
 */

const subjectManager = require('./subjectManager.js');
const goodLearning = require('../shared/goodLearningSkill.js');

function buildSubjectBlock(subjectId, { digestOnly = false, messages = [], withMaterials = true } = {}) {
  if (!subjectId) return { text: '', citations: [] };
  try {
    const subject = subjectManager.getSubject(subjectId);
    if (!subject) return { text: '', citations: [] };
    const opts = { digestOnly };
    let citations = [];
    if (withMaterials) {
      const materialContext = require('./materialContext.js');
      // 用最近一条用户消息做轻量检索，避免把整本教材塞进 system
      const list = Array.isArray(messages) ? messages : [];
      const last = [...list].reverse()
        .find((message) => (message?.role === 'user' || message?.type === 'user')
          && typeof (message?.content || message?.text) === 'string');
      const query = String(last?.content || last?.text || '').slice(0, 500);
      opts.materials = materialContext.describe(subjectId);
      const retrieved = materialContext.buildMaterialContext(subjectId, query);
      if (retrieved.text) {
        opts.materialContext = retrieved.text;
        citations = retrieved.citations || [];
      }
    }
    return { text: goodLearning.buildSubjectSkillBlock(subject, opts), citations };
  } catch (error) {
    console.warn('[SubjectContext] 科目上下文构建失败:', error?.message || error);
    return { text: '', citations: [] };
  }
}

module.exports = { buildSubjectBlock };
