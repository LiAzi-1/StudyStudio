import React from 'react';
import AIConversation from '../components/AIConversation.jsx';

/**
 * AI 助教（合并后的唯一入口）
 *
 * 不再区分「答疑讲解」和「帮我做事」两个标签：同一份会话、同一个输入框，
 * 既能讲题，也能在用户确认后执行录题 / 记错题 / 写笔记 / 调计划。
 */
export default function AIHub({ onNavigate, assistantSubjectId, onOpenSettings, onOpenAnalysis }) {
  return (
    <section className="ai-hub" style={{ height: '100%', minHeight: 0 }}>
      <div className="ai-hub-body" style={{ height: '100%', minHeight: 0 }}>
        <AIConversation
          onNavigate={onNavigate}
          incomingSubjectId={assistantSubjectId || ''}
          onOpenSettings={onOpenSettings}
          onOpenAnalysis={onOpenAnalysis}
        />
      </div>
    </section>
  );
}
