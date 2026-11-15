import React from "react";

/**
 * 罗小黑风格的小黑猫点缀：头像/空态/加载时用，保持单色剪影，不抢正文。
 */
export default function LuoCat({ size = 22, className = "", muted = false }) {
  return (
    <svg
      className={`luo-cat${className ? ` ${className}` : ""}`}
      width={size}
      height={size * 0.9}
      viewBox="0 0 40 36"
      fill="none"
      aria-hidden="true"
      style={muted ? { opacity: 0.55 } : undefined}
    >
      <path d="M6.4 15.6 3.8 3.4l11 4.1-8.4 8.1Z" fill="var(--luo-ink)" />
      <path d="M33.6 15.6 36.2 3.4l-11 4.1 8.4 8.1Z" fill="var(--luo-ink)" />
      <ellipse cx="20" cy="21.4" rx="15.2" ry="13.2" fill="var(--luo-ink)" />
      <ellipse cx="14.2" cy="19.6" rx="3.5" ry="4.4" fill="var(--surface)" />
      <ellipse cx="25.8" cy="19.6" rx="3.5" ry="4.4" fill="var(--surface)" />
      <ellipse cx="14.8" cy="20.1" rx="1.5" ry="2.3" fill="var(--luo-ink)" />
      <ellipse cx="25.2" cy="20.1" rx="1.5" ry="2.3" fill="var(--luo-ink)" />
      <path d="M17.8 26.4h4.4" stroke="var(--surface)" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
