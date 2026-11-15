import React, { useMemo } from "react";
import katex from "katex";
import { renderMathText } from "./RichQuestionContent.jsx";

/**
 * 聊天 / 笔记预览里的公式渲染
 *
 * 统一复用 RichQuestionContent 里的 KaTeX 管线（同一套定界符与 $ 判别规则），
 * 这里只负责把纯文本包成 span，不引第二套渲染器。
 */

const DISPLAY_MATH_RE = /\$\$[\s\S]+?\$\$|\\\[[\s\S]*?\\\]/g;

/** 把消息按块级公式切开，返回 text / math 片段，块级公式交给 KaTeX 独占一行 */
export function splitDisplayMath(value) {
  const text = String(value || "");
  if (!/\$\$|\\\[/.test(text)) return [{ type: "text", value: text }];
  const parts = [];
  let cursor = 0;
  DISPLAY_MATH_RE.lastIndex = 0;
  let match;
  while ((match = DISPLAY_MATH_RE.exec(text)) !== null) {
    if (match.index > cursor) parts.push({ type: "text", value: text.slice(cursor, match.index) });
    parts.push({ type: "math", value: match[0] });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push({ type: "text", value: text.slice(cursor) });
  return parts.length ? parts : [{ type: "text", value: text }];
}

export function MathText({ text, className = "" }) {
  const html = useMemo(() => renderMathText(text), [text]);
  if (!html) return null;
  return (
    <span
      className={`math-text${className ? ` ${className}` : ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function MathBlock({ text }) {
  // 这里拿到的是完整的块级公式（含 $$ / \[..\] 定界符）。
  // 不能走 renderMathText：它会把换行转成 <br/>，定界符和正文被拆进不同文本节点，
  // 多行公式就匹配不上、原样输出成 \[ ... \]。块级公式直接交给 KaTeX。
  const html = useMemo(() => {
    const raw = String(text || "").trim();
    let inner = raw;
    if (raw.startsWith("$$") && raw.endsWith("$$")) inner = raw.slice(2, -2);
    else if (raw.startsWith("\\[") && raw.endsWith("\\]")) inner = raw.slice(2, -2);
    try {
      return katex.renderToString(inner.trim(), {
        displayMode: true,
        output: "htmlAndMathml",
        throwOnError: true,
        strict: "ignore",
        trust: false,
      });
    } catch (_) {
      // 解析失败就退回原文渲染，不显示红字报错
      return renderMathText(raw);
    }
  }, [text]);
  if (!html) return null;
  return <div className="math-block" dangerouslySetInnerHTML={{ __html: html }} />;
}
