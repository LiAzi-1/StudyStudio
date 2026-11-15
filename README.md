# StudyStudio

StudyStudio 是一个本地优先的考研学习桌面应用。它把科目与教材、复习资料、题库练习、AI 答疑、笔记和成长记录放在同一份本地数据里；学习数据默认只保存在本机，AI 功能需要自备模型 API。

> 应用不内置官方题库或教材。题目、资料和笔记都来自你自己的导入与整理。

## 主要能力

### 科目与教材解析
- 预置数学、英语、政治、专业课四类科目，也可以自建科目，把资料、题目、会话和笔记都归到科目下。
- 主教材以 PDF 导入，交给本地 MinerU 分批 OCR，解析出章节、知识点、插图与公式；补充资料支持 PDF、PPTX、Markdown/TXT，PPTX 直接抽取幻灯片文字。
- 解析进度会实时显示；机器上已有的 MinerU 环境可以被识别并复用，不必重复下载模型。

### 资料管理
- 资料库统一管理教材、讲义、试卷和题目附件，支持预览、替换和清理。
- 题目图片、教材插图等资源单独落盘，不会把大图塞进数据库。

### 题库与练习
- 支持批量导入与手工录入题目，按科目、章节、知识点归类。
- 可以按知识点做专项练习、每日一练，或按范围组卷（通用组卷 / 综合组卷）。
- 提供答题、判分、考试结果、练习历史和错题本；错题可以重做，主观题可以交给 AI 批改。

### AI 助教与外部对话导入
- 单会话的 AI 助教，可绑定科目，支持图片提问、流式回答，以及「收进题库 / 记进错题 / 调整计划 / 整理笔记」等动作卡片。
- 外部对话可以导入后继续追问：粘贴文本、上传文件或截图、粘贴 DeepSeek / 豆包分享链接、手机扫码传图。
- 分享链接导入依赖对方页面结构或未公开接口，对方改版后可能失效，不属于官方支持；导入前会在预览里标注。
- 导入内容先进入预览，确认后才写入会话。

### 知识图谱
- 资料和题目完成分类后，按「科目 → 模块 → 章节 → 知识点」展示知识图谱，并标出各节点的题量与掌握程度。
- 点击节点可以直接进入对应范围的练习。

### 笔记与 Obsidian 同步
- 内置 Markdown / LaTeX 笔记，支持图片附件，并按科目整理。
- 笔记可以同步到你指定的 Obsidian 仓库，支持应用与仓库之间的双向同步；不安装 Obsidian 也能正常记笔记、看知识图谱，只是「在 Obsidian 中打开」会退回系统默认程序。
- 同步主链路由 Node 实现，不要求安装 Python；Python 只用于可选的收件箱识图整理。

### 成长统计
- 学习日历与热力图、练习与错题历史、正确率趋势。
- 等级、成就与阶段性统计，用来回看最近的投入和薄弱点。

## 运行与构建

### 环境要求
- Node.js 18+（建议 20 LTS）与 npm
- Windows 10/11 或 macOS
- Python 与 MinerU 只在「解析 PDF 教材」时需要，运行应用和构建安装包都不依赖它们

### 开发

```bash
npm install
npm run rebuild:electron   # 首次安装或 Electron 版本变化后，重编 better-sqlite3 等原生依赖
npm run dev                # 启动 Vite + Electron
```

### 构建

```bash
npm run build              # 只构建渲染层
npm start                  # 用已构建的 dist 启动 Electron
npm run dist:win           # Windows NSIS 安装包
npm run dist:mac           # macOS dmg + zip
```

产物在 `release/`。`dist:win` 会同时生成 `latest.yml` 和 `app-update.yml`，自动更新依赖它们，不要只拷贝 exe。

## 依赖说明

### 开箱可用
- 安装包自带 Electron、SQLite 数据库和前端资源；题目、资料、笔记、练习记录都保存在本地。
- 笔记、题库、知识图谱、成长统计不需要额外服务。
- Obsidian 是可选依赖，不装也能用。

### 教材解析：Python + MinerU
- 需要 64 位 Python 3.10 – 3.12，以及 MinerU 和本地模型。
- 应用不内置 Python：官方精简版缺少 ensurepip/venv，内置运行时会显著增大安装包，并与 MinerU 的依赖版本强绑定。
- 缺少依赖时，主教材解析会在开始前被拦下并说明缺什么；进入「设置 → 运行环境」可以：
  - 重新检测 Python / MinerU / 模型；
  - 指定已有的 Python；
  - 复制 `winget install -e --id Python.Python.3.12`；
  - 一键安装解析环境（自动创建虚拟环境、安装 MinerU、下载模型）；
  - 复用旧机器上的 MinerU 环境。
- 环境默认放在用户数据目录的 `mineru/` 下，可用 `OPENEXAM_MINERU_ROOT` 指向别处。
- 没有 Python / MinerU 时，应用仍可正常使用题库、笔记、AI 助教和 Obsidian 同步，只是不能解析 PDF 教材。

### AI 服务
- AI 助教需要自备 API Key，在「设置 → AI 模型」里配置。
- 内置 DeepSeek、豆包、Kimi、通义千问、智谱 GLM、MiniMax、Claude，以及 OpenAI 兼容接口。
- 图片提问需要选择支持视觉的模型；纯文本模型只能处理文字。

### Obsidian（可选）
- 只需要本机安装 Obsidian 客户端；同步本身不依赖 Python。
- 在笔记页选择或创建仓库目录后即可同步，默认仓库在用户数据目录的 `obsidian-vault/`。
- 未安装 Obsidian 时，笔记仍保存在本地，知识图谱和题库不受影响。

## 数据与备份

所有用户数据默认在 Electron 用户目录：

- Windows：`%APPDATA%\StudyStudio`
- macOS：`~/Library/Application Support/StudyStudio`

| 路径 | 内容 |
| --- | --- |
| `openexam.db` | 主数据库：题目、会话、笔记、练习记录、设置 |
| `backups/` | 数据管理里生成的本地备份 |
| `question-assets/` | 题目图片、教材插图等 |
| `ai-assets/` | AI 会话里的图片 |
| `note-assets/` | 笔记图片附件 |
| `obsidian-vault/` | 默认 Obsidian 仓库 |
| `mineru/` | Python 虚拟环境、MinerU 与模型 |
| `share-import/` | 分享链接导入的临时文件，提交或过期后清理 |

「设置 → 数据管理」可以备份、恢复和清理资源。备份包含数据库与必要附件；恢复会覆盖当前数据，操作前会二次确认。

## 更新与反馈

- 发布页：https://github.com/LiAzi-1/StudyStudio/releases
- 应用内「设置 → 关于 → 在线更新」可以手动检查。Windows 支持自动下载并在重启后安装；macOS 目前检测到新版本后会打开 Release 页，由你手动下载。
- 问题与建议：https://github.com/LiAzi-1/StudyStudio/issues 。反馈时请附上系统版本、应用版本和复现步骤；日志里不要带 API Key。

## 技术栈

Electron 30、React 18、Vite 5、better-sqlite3；教材解析使用可选的本地 MinerU；笔记同步由 Node 实现。

## License

GPL-3.0，见 [LICENSE](LICENSE)。
