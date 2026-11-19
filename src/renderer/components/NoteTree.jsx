import React, { useEffect, useMemo, useState } from 'react';

/**
 * 笔记区树状视图：学科 → 知识清单 / 学科笔记 / 答疑笔记 → 章节（清单模块）→ 笔记。
 * 知识清单是叶子：点一下直接打开该学科由 AI 生成的清单，不再向下分叉。
 */

const CATEGORIES = [
  { key: 'inventory', label: '知识清单', hint: 'AI 生成的整本清单' },
  { key: 'subject', label: '学科笔记', hint: '整理 / 手写笔记' },
  { key: 'qa', label: '答疑笔记', hint: 'AI 答疑沉淀' },
];

function dateLabel(value) {
  const text = String(value || '');
  return text ? text.slice(0, 10) : '';
}

function totalOf(subject) {
  const counts = subject?.counts || {};
  return (counts.inventory || 0) + (counts.subject || 0) + (counts.qa || 0);
}

export function NoteSubjectGrid({ subjects = [], loading = false, onPick }) {
  if (loading && !subjects.length) {
    return <div className="note-tree-empty">正在加载学科…</div>;
  }
  if (!subjects.length) {
    return (
      <div className="note-tree-empty">
        还没有可归类的笔记。先在科目里添加教材，或直接在下方新建一篇笔记。
      </div>
    );
  }
  return (
    <div className="note-subjects">
      {subjects.map((subject) => (
        <button
          key={subject.id || 'unbound'}
          type="button"
          className="note-subject-card"
          onClick={() => onPick(subject)}
        >
          <strong>{subject.name}</strong>
          <span className="note-subject-counts">
            <em>清单 {subject.counts.inventory}</em>
            <em>学科 {subject.counts.subject}</em>
            <em>答疑 {subject.counts.qa}</em>
          </span>
          <span className="note-subject-total">{totalOf(subject)} 篇笔记</span>
        </button>
      ))}
    </div>
  );
}

export function NoteTreeView({ subject, onBack, onOpenNote }) {
  const [category, setCategory] = useState('subject');
  const [moduleNo, setModuleNo] = useState(null);

  const bucket = category === 'inventory' ? null : subject[category];
  const modules = bucket?.modules || [];
  const unclassified = bucket?.unclassified || [];

  // 默认展开第一个有笔记的模块；切换到空模块列表时落到「未归类」
  const defaultModuleNo = useMemo(() => {
    const withNotes = modules.find((module) => module.notes.length);
    if (withNotes) return withNotes.no;
    if (unclassified.length) return 0;
    return modules[0]?.no ?? null;
  }, [modules, unclassified.length]);

  useEffect(() => {
    setModuleNo(defaultModuleNo);
  }, [category, subject.id, defaultModuleNo]);

  const currentModule = modules.find((module) => module.no === moduleNo) || null;
  const notes = moduleNo === 0 ? unclassified : (currentModule?.notes || []);

  const openCategory = (key) => {
    if (key === 'inventory') {
      if (subject.inventory) onOpenNote(subject.inventory.id);
      return;
    }
    setCategory(key);
  };

  return (
    <section className="note-tree-wrap">
      <header className="note-tree-head">
        <button type="button" className="notes-ghost" onClick={onBack}>← 全部学科</button>
        <h2>{subject.name}</h2>
        <span className="note-tree-total">{totalOf(subject)} 篇</span>
      </header>

      <div className="note-tree">
        <div className="note-tree-col">
          <div className="note-tree-node is-root" title="学科">
            <strong>{subject.name}</strong>
            <em>{totalOf(subject)}</em>
          </div>
        </div>

        <div className="note-tree-col">
          {CATEGORIES.map((item) => {
            const count = subject.counts[item.key] || 0;
            const active = category === item.key;
            return (
              <button
                key={item.key}
                type="button"
                className={`note-tree-node${active ? ' is-active' : ''}${count ? '' : ' is-empty'}`}
                disabled={!count}
                title={item.hint}
                onClick={() => openCategory(item.key)}
              >
                <strong>{item.label}</strong>
                <em>{count}</em>
              </button>
            );
          })}
        </div>

        {category !== 'inventory' && (
          <div className="note-tree-col note-tree-modules">
            {modules.map((module) => (
              <button
                key={module.no}
                type="button"
                className={`note-tree-node${moduleNo === module.no ? ' is-active' : ''}`}
                onClick={() => setModuleNo(module.no)}
              >
                <strong>{module.no}. {module.title}</strong>
                <em>{module.notes.length}</em>
              </button>
            ))}
            {unclassified.length > 0 && (
              <button
                type="button"
                className={`note-tree-node is-muted${moduleNo === 0 ? ' is-active' : ''}`}
                onClick={() => setModuleNo(0)}
              >
                <strong>未归类</strong>
                <em>{unclassified.length}</em>
              </button>
            )}
            {!modules.length && !unclassified.length && (
              <div className="note-tree-empty">该学科还没有{category === 'qa' ? '答疑' : '学科'}笔记</div>
            )}
          </div>
        )}

        {category !== 'inventory' && (
          <div className="note-tree-col note-tree-notes">
            {notes.length ? notes.map((note) => (
              <button
                key={note.id}
                type="button"
                className={`note-tree-note${note.pinned ? ' is-pinned' : ''}`}
                onClick={() => onOpenNote(note.id)}
                title={note.title}
              >
                <strong>{note.title}</strong>
                <span>
                  {dateLabel(note.updatedAt)}
                  {note.chars ? ` · ${note.chars} 字` : ''}
                  {note.pinned ? ' · 置顶' : ''}
                </span>
              </button>
            )) : (
              <div className="note-tree-empty">这一章节还没有笔记</div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
