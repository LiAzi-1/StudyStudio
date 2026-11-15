import React from 'react';
import { CitationChip } from './CitationSources.jsx';
import { MathText, MathBlock, splitDisplayMath } from './MathText.jsx';

/** 轻量 Markdown 渲染：标题 / 引用 / 列表 / 粗斜体 / 行内代码 / 引用角标 / 公式 */
export default function AIMessageContent({ content, citations = [], onOpenCitation }) {
  const renderInline = (text) => {
    const chunks = String(text || '').split(/(\[\[C\d+\]\]|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g);
    return chunks.map((chunk, index) => {
      if (!chunk) return null;
      const citationMatch = chunk.match(/^\[\[C(\d+)\]\]$/);
      if (citationMatch) {
        const citation = (citations || []).find((item) => item.id === `C${citationMatch[1]}`);
        return citation ? <CitationChip key={index} citation={citation} onClick={onOpenCitation} /> : null;
      }
      if (chunk.startsWith('`') && chunk.endsWith('`')) {
        return <code key={index} style={{ background: 'var(--accent-soft-bg)', color: 'var(--accent)', borderRadius: 4, padding: '1px 5px', fontSize: 11 }}>{chunk.slice(1, -1)}</code>;
      }
      if (chunk.startsWith('**') && chunk.endsWith('**')) {
        return <strong key={index} style={{ fontWeight: 700, color: 'var(--text)' }}><MathText text={chunk.slice(2, -2)} /></strong>;
      }
      if (chunk.startsWith('*') && chunk.endsWith('*')) {
        return <em key={index} style={{ fontStyle: 'italic', color: 'var(--text)' }}><MathText text={chunk.slice(1, -1)} /></em>;
      }
      return <MathText key={index} text={chunk} />;
    });
  };

  const renderLines = (text) => String(text || '').split('\n').map((line, index) => {
    if (!line) return <div key={index} style={{ height: 6 }} />;
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      return (
        <div key={index} style={{ fontSize: Math.max(12, 16 - level), fontWeight: level <= 2 ? 700 : 600, color: 'var(--text)', marginBottom: 4 }}>
          {renderInline(headingMatch[2])}
        </div>
      );
    }
    if (line.startsWith('> ')) {
      return <div key={index} style={{ borderLeft: '3px solid var(--accent)', paddingLeft: 8, color: 'var(--muted)', fontSize: 11, marginBottom: 2, fontStyle: 'italic' }}>{renderInline(line.slice(2))}</div>;
    }
    if (line.startsWith('- ') || line.startsWith('• ')) {
      return (
        <div key={index} style={{ display: 'flex', gap: 7, marginBottom: 2 }}>
          <span style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2, fontSize: 10 }}>▸</span>
          <span>{renderInline(line.slice(2))}</span>
        </div>
      );
    }
    if (/^\d+\. /.test(line)) {
      const num = line.match(/^(\d+)\. /)[1];
      return (
        <div key={index} style={{ display: 'flex', gap: 7, marginBottom: 2 }}>
          <span style={{ color: 'var(--accent)', flexShrink: 0, minWidth: 16, fontSize: 11, fontWeight: 600 }}>{num}.</span>
          <span>{renderInline(line.replace(/^\d+\. /, ''))}</span>
        </div>
      );
    }
    return <div key={index} style={{ marginBottom: 2 }}>{renderInline(line)}</div>;
  });

  // 代码围栏与表格要脱离逐行渲染，先切成块；普通文本仍走 renderLines
  const splitBlocks = (text) => {
    const lines = String(text || '').split('\n');
    const blocks = [];
    let buffer = [];
    const flush = () => {
      if (buffer.length) {
        blocks.push({ type: 'text', lines: buffer });
        buffer = [];
      }
    };

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const fence = line.match(/^```\s*([\w+#-]*)\s*$/);
      if (fence) {
        flush();
        const code = [];
        index += 1;
        while (index < lines.length && !/^```\s*$/.test(lines[index])) {
          code.push(lines[index]);
          index += 1;
        }
        blocks.push({ type: 'code', lang: fence[1], content: code.join('\n') });
        continue;
      }

      const next = lines[index + 1] || '';
      const isTableHead = line.includes('|') && /^\s*\|?[\s:|-]+\|[\s:|-]*\s*$/.test(next) && next.includes('-');
      if (isTableHead) {
        flush();
        const rows = [];
        while (index < lines.length && lines[index].includes('|')) {
          rows.push(lines[index]);
          index += 1;
        }
        index -= 1;
        blocks.push({ type: 'table', rows });
        continue;
      }

      buffer.push(line);
    }
    flush();
    return blocks;
  };

  const parseRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());

  const renderBlock = (block, key) => {
    if (block.type === 'code') {
      return (
        <pre key={key}>
          <code>{block.content}</code>
        </pre>
      );
    }
    if (block.type === 'table') {
      const rows = block.rows.filter((row) => !/^\s*\|?[\s:|-]+\|[\s:|-]*\s*$/.test(row));
      if (!rows.length) return null;
      const header = parseRow(rows[0]);
      const body = rows.slice(1).map(parseRow);
      return (
        <div key={key} style={{ margin: '8px 0', overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 11.5, lineHeight: 1.6, minWidth: '100%' }}>
            <thead>
              <tr>
                {header.map((cell, index) => (
                  <th key={index} style={{ border: '1px solid var(--line)', background: 'var(--surface-soft)', padding: '6px 9px', textAlign: 'left', fontWeight: 700, whiteSpace: 'nowrap' }}>
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {header.map((_, cellIndex) => (
                    <td key={cellIndex} style={{ border: '1px solid var(--line)', padding: '6px 9px', verticalAlign: 'top' }}>
                      {renderInline(row[cellIndex] || '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    return <React.Fragment key={key}>{renderLines(block.lines.join('\n'))}</React.Fragment>;
  };

  return (
    <div>
      {splitDisplayMath(content).map((part, index) => (
        part.type === 'math'
          ? <MathBlock key={`math-${index}`} text={part.value} />
          : (
            <React.Fragment key={`text-${index}`}>
              {splitBlocks(part.value).map((block, blockIndex) => renderBlock(block, blockIndex))}
            </React.Fragment>
          )
      ))}
    </div>
  );
}
