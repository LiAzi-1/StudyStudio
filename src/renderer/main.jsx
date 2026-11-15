import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { DialogProvider } from "./components/DialogProvider.jsx";
import { AchievementUnlockProvider } from "./components/AchievementUnlockCeremony.jsx";
// 公式排版基础样式必须在本项目样式之前加载，后面 .rich-question-content 的覆盖规则才生效
import "katex/dist/katex.min.css";
import "./styles.css";
import { applyFontScale, getFontScale } from "../shared/displaySettings.js";
import { installPolyfills } from "./utils/polyfills.js";

// 必须早于任何 pdf.js 调用（Electron 30 缺少 Promise.try，否则 PDF 解析会卡死）
installPolyfills();

// 兜底：确保启动（或热更新）时文字大小与持久化值一致
applyFontScale(getFontScale());

const root = createRoot(document.getElementById("root"));
root.render(
  <DialogProvider>
    <AchievementUnlockProvider>
      <App />
    </AchievementUnlockProvider>
  </DialogProvider>
);
