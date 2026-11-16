import React, { useEffect, useState } from "react";

const STEPS = [
  {
    id: "library",
    badge: "准备资料",
    title: "先把科目和资料建起来",
    description: "先新建科目，再进入该科目的「资料管理」，把教材拖进主教材区域即可上传。Markdown / TXT / PPTX 开箱可用；PDF 需要 Python + MinerU 解析环境，首次安装还要下载模型，可在「设置 → 运行环境」看清缺什么、按提示安装。",
    accent: "var(--accent)",
    points: [
      "解析完成的资料会进入资料库，出卷和 AI 助教都能直接读到。",
      "Obsidian 是可选依赖：不装也能正常记笔记、看知识图谱，只是打开文件时会改用系统默认程序。",
    ],
  },
  {
    id: "practice",
    badge: "题库与练习",
    title: "导入试卷，开始按科目练",
    description: "题库支持导入整份试卷，也可以按科目做专项练习，或者来一场整卷模考。",
    accent: "var(--info)",
    points: [
      "做错的题会自动进入错题本，方便回头重做。",
      "练习和模考都会写进学习记录，进度看得见。",
    ],
  },
  {
    id: "assistant",
    badge: "AI 助教",
    title: "一个入口，两种用法",
    description: "同一个输入框，既能讲题，也能在确认后录题、写笔记、做分类。第一次使用前需要先在「设置 → AI 模型」配置一个模型和 API Key。",
    accent: "var(--success)",
    points: [
      "会改动数据的动作都会先给出确认卡片，你点了才会执行。",
    ],
  },
  {
    id: "graph",
    badge: "知识图谱与成长",
    title: "看清每个章节的掌握情况",
    description: "资料和题目分类后，知识图谱会按章节、知识点展示你的掌握程度。",
    accent: "var(--warning)",
    points: [
      "薄弱点会随练习和错题更新，复盘时优先补这些地方。",
      "成长数据记录每天的练习量，坚持比突击更有效。",
    ],
  },
];

function renderVisual(step) {
  if (step.id === "library") {
    return (
      <div className="onboarding-visual-plain">
        <div className="onboarding-visual-kicker">Subjects & Files</div>
        <strong className="onboarding-visual-title">高等数学 · 资料库</strong>
        <ul className="onboarding-visual-lines">
          <li>高等数学讲义.pdf · 已解析</li>
          <li>线性代数课件.pptx · 解析中</li>
          <li>错题整理.md · 已就绪</li>
        </ul>
      </div>
    );
  }

  if (step.id === "practice") {
    return (
      <div className="onboarding-visual-plain">
        <div className="onboarding-visual-kicker">Practice</div>
        <strong className="onboarding-visual-title">考研英语 · 20 题</strong>
        <div className="onboarding-visual-meter"><span style={{ width: "78%" }} /></div>
        <ul className="onboarding-visual-lines">
          <li>整卷模考 · 120 分钟</li>
          <li>错题本 14 题待重做</li>
          <li>今日练习 3 次</li>
        </ul>
      </div>
    );
  }

  if (step.id === "assistant") {
    return (
      <div className="onboarding-visual-plain">
        <div className="onboarding-visual-kicker">AI 助教</div>
        <div className="onboarding-visual-dialog">
          <p className="is-user">帮我把这道题录进题库</p>
          <p className="is-ai">已整理成 1 道题，解析也写好了。</p>
          <p className="is-ai">点「确认写入」之后才会保存。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="onboarding-visual-plain">
      <div className="onboarding-visual-kicker">Knowledge Graph</div>
      <strong className="onboarding-visual-title">高等数学 · 掌握度</strong>
      <div className="onboarding-visual-meter"><span style={{ width: "64%" }} /></div>
      <ul className="onboarding-visual-lines">
        <li>极限与连续 82%</li>
        <li>多元函数微分 64%</li>
        <li>级数 41% · 建议优先</li>
      </ul>
    </div>
  );
}

export default function OnboardingTour({ open, closing = false, onFinish, onSkip, onNavigate }) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!open) return;
    setStep(0);
  }, [open]);

  const visible = open || closing;
  if (!visible) return null;

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  const handlePrimary = () => {
    if (isLast) {
      onFinish?.();
      return;
    }
    setStep((value) => Math.min(value + 1, STEPS.length - 1));
  };

  return (
    <div className={`onboarding-overlay ${closing ? "is-closing" : ""}`} role="dialog" aria-modal="true" aria-label="使用说明">
      <div className="onboarding-shell" style={{ "--onboarding-accent": current.accent }}>
        <section key={`visual-${current.id}`} className="onboarding-showcase">
          <div className="onboarding-showcase-bg" />
          <div className="onboarding-showcase-head">
            <span>{current.badge}</span>
            <strong>StudyStudio</strong>
          </div>
          <div className="onboarding-showcase-main">
            {renderVisual(current)}
          </div>
          <div className="onboarding-showcase-foot">
            <span>说明 {step + 1} / {STEPS.length}</span>
            <div className="onboarding-progress-track">
              <span style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} />
            </div>
          </div>
        </section>

        <section key={`panel-${current.id}`} className="onboarding-panel">
          <div className="onboarding-panel-top">
            <div className="onboarding-step-badge">Step {step + 1} / {STEPS.length}</div>
            <button className="onboarding-skip" onClick={() => onSkip?.()}>跳过</button>
          </div>

          <div className="onboarding-panel-body">
            <div className="onboarding-panel-copy">
              <div className="onboarding-badge">{current.badge}</div>
              <h2 className="onboarding-title">{current.title}</h2>
              <p className="onboarding-desc">{current.description}</p>
            </div>

            <ul className="onboarding-feature-list">
              {current.points.map((point) => (
                <li key={point} className="onboarding-feature-item">
                  <span className="onboarding-feature-mark" aria-hidden="true" />
                  <span>{point}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="onboarding-panel-bottom">
            <div className="onboarding-dots">
              {STEPS.map((item, index) => (
                <button
                  key={item.id}
                  className={`onboarding-dot ${index === step ? "active" : ""}`}
                  onClick={() => setStep(index)}
                  aria-label={`切换到第 ${index + 1} 页`}
                />
              ))}
            </div>
            <div className="onboarding-actions">
              <button
                className="onboarding-btn secondary"
                onClick={() => setStep((value) => Math.max(value - 1, 0))}
                disabled={step === 0}
              >
                上一步
              </button>
              <button className="onboarding-btn primary" onClick={handlePrimary}>
                {isLast ? "开始使用" : "下一步"}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
