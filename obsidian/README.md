# Obsidian × OpenExam 联动套件

把 Obsidian 当成复习笔记前端，把 OpenExam 的 SQLite 题库当后端。四件事一次打通：

1. **下载并登记 Obsidian**：安装包已放到 `~/Downloads/Obsidian-1.15.0.exe`，仓库已写进 `%APPDATA%/obsidian/obsidian.json`。
2. **看笔记时能看知识点下的题库**：脚本按知识点生成题库镜像，并自动把「相关题库」内嵌进笔记正文；插件还提供右侧栏实时查看。
3. **AI 识图整理潦草笔记**：独立的视觉模型配置，把照片 / 随手记二次整理成规范 Markdown。
4. **笔记里的例题进题库**：解析 `## 例题`，带备份、幂等地写入项目 SQLite。

---

## 一、装好并打开

1. 双击 `~/Downloads/Obsidian-1.15.0.exe` 安装（Windows 通用版，v1.15.0，来自 obsidian.md 官方下载页）。
2. 启动 Obsidian，仓库 **OpenExam 笔记** 已在列表里；如果没有，点「Open folder as vault」，选：

   ```
   C:\Users\Li_13\Desktop\临时\OpenExam-source\obsidian\vault
   ```

3. 首次打开会提示是否信任插件，选择信任并启用 **OpenExam 题库联动**。
   （`.obsidian/community-plugins.json` 已预置启用；插件是纯 JS，不需要 npm install / 编译。）

> 不想用插件也能用：笔记底部的「相关题库」是 Obsidian 原生 `![[...]]` 内嵌，核心功能不依赖插件。

---

## 二、配置视觉模型（AI 识图整理）

编辑 `obsidian/config.json` 的 `vision` 段。**这是独立配置，不会改动 OpenExam 应用里的 AI 设置**
（应用当前配的是 `deepseek-chat`，该模型不支持识图）。

```json
"vision": {
  "protocol": "openai",
  "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
  "apiKey": "你的 Key",
  "model": "glm-4v-flash",
  "timeout": 120
}
```

| 服务商 | protocol | baseUrl | 可用视觉模型 |
| --- | --- | --- | --- |
| 智谱 GLM（默认） | `openai` | `https://open.bigmodel.cn/api/paas/v4` | `glm-4v-flash`、`glm-4.5v` |
| 通义千问 | `openai` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-vl-max`、`qwen-vl-plus` |
| 豆包 | `openai` | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-1-5-vision-pro-32k` |
| OpenAI | `openai` | `https://api.openai.com/v1` | `gpt-4o`、`gpt-4.1` |
| Claude | `anthropic` | `https://api.anthropic.com/v1` | `claude-sonnet-4-20250514` |

没填 `apiKey` 时，`format` 会跳过并给出提示，**不会中断同步和入库**。

> 也可以不配模型：把笔记图片放进收件箱后，直接在 WorkBuddy 里说「整理笔记」，由我来识图整理。

---

## 三、日常怎么用

| 场景 | 操作 |
| --- | --- |
| 随手记 / 拍了笔记 | 图片或 `.md/.txt` 丢进 `vault/00-收件箱/`。多张照片属于同一篇时放进同一个子文件夹 |
| 一键全跑 | `npm run obsidian:all` |
| 存量笔记公式转 LaTeX | `npm run obsidian:latex`（保守、幂等；先加 `--dry-run` 预览） |
| 常驻自动 | `npm run obsidian:watch`（处理插件请求 + 笔记变动时自动同步） |
| 看知识点题库 | 打开笔记，看底部「相关题库」内嵌区块；或右侧「OpenExam 题库」侧边栏 |
| 给笔记标知识点 | `Ctrl+P` →「设置本笔记知识点」，或手写 frontmatter |
| 例题进题库 | 在笔记里按模板写 `## 例题`，然后 `npm run obsidian:import` |
| 撤销入库 | `npm run obsidian:unimport` |
| 整理应用内笔记 | 应用「笔记」页 → 打开笔记 → 点「AI 助教整理」 |
| 给笔记配图 | 编辑器里粘贴截图 / 拖入图片 / 点「插入图片」 |
| 生成 / 打开思维导图 | 笔记页右上「同步到 Obsidian」/「知识地图」 |

所有命令在项目根目录执行，等价于 `python obsidian/bridge.py <命令>`。

---

## 四、AI 助教与知识地图

应用「笔记」页写完东西，点 **AI 助教整理**，AI 会做三件事：

1. **读懂**：判断这篇笔记属于哪个模块、哪个题型、哪个考点；
2. **规范化**：补 `##` 小标题、把口语改成书面表达，纯文本公式统一转成 `$...$` / `$$...$$` 的 LaTeX，数字、单位、口诀与题目条件原样保留；
3. **精细分类**：模块、题型、笔记类型、难度、掌握度、关键概念、标签、考点（最多 3 个）。

整理结果分两处落地：正文回写笔记，分类存进 `notes.meta`（SQLite 的 `notes` 表新增列），
笔记卡片上直接显示「模块 / 题型 / 笔记类型 / 考点」标签。

AI 不可用时（没配 Key、超时、返回异常）不会假装成功：正文不动，只按关键词做本地分类，
并标注「本地分类」，你可以稍后重试。

### 生成思维导图

点笔记页右上 **同步到 Obsidian**（等价于 `npm run obsidian:all`）：

```
应用 notes 表 ──pull──▶ vault/10-笔记/应用笔记/*.md   带上 frontmatter 分类
                              │
                              ├─▶ 20-思维导图/知识地图.canvas   Obsidian 白板，可双击跳转
                              ├─▶ 20-思维导图/知识地图.md       Mermaid 脑图 + 可点索引
                              └─▶ _bridge/index/mindmap.json   结构化分类数据
```

**点知识点怎么跳到正文**：`.canvas` 里的笔记卡片是 `file` 节点，带
`"subpath": "#小节标题"`，双击直接落到笔记里真正讲该考点的小节，而不是只打开整篇笔记。
Markdown 版里每条 `[[笔记#小节|跳到「小节」]]` 同理，单击即跳。

### 图片

笔记编辑器支持三种方式配图：**粘贴截图**（Ctrl+V）、**把图片拖进编辑器**、点「插入图片」选文件。
图片存在 `%APPDATA%/studystudio/note-assets/<noteId>/`，正文里写成：

```markdown
![错题截图](openexam-asset://note-assets/<noteId>/<文件名>)
```

删除笔记时图片目录一起清掉；缩略图上的 × 只移除引用并删掉该文件。

同步到 Obsidian 时，图片会被复制到 `99-附件/笔记图片/<noteId>/`，正文链接自动改写成本地相对路径：

```markdown
![错题截图](../../99-附件/笔记图片/<noteId>/<文件名>)
```

这样不依赖 wikilink 设置也能正常显示。AI 助教整理正文时如果漏掉图片行，
程序会把缺失的补回到「## 附图」小节，不会把图弄丢。

### 不会重复花模型额度

在应用里整理过的笔记，`notes.meta` 会带着分类结果一起被拉进 vault，桥接层直接复用，
不再调一次模型（frontmatter 里显示 `ai_model: 应用内 AI 助教（deepseek-chat）`）。
只有直接在 vault 里手写、没经过应用的笔记，才由 Python 侧调用模型整理。

| 命令 | 作用 |
| --- | --- |
| `npm run obsidian:tutor` | 拉取应用笔记 + AI 整理 vault 笔记 |
| `npm run obsidian:mindmap` | 只重建知识地图 |
| `npm run obsidian:all` | 全流程：拉取 → 识图 → 整理 → 同步题库 → 入库 → 导图 |
| `npm run obsidian:tutor -- --force` | 忽略「已整理」标记，全部重跑 |

---

## 五、笔记格式

frontmatter 里的 `knowledge_points` 决定挂哪个题库，写法很宽容：

```yaml
---
title: 工程问题 · 效率与总量
knowledge_points: [shuliang.jisuan.gongcheng, 增长率]
tags: [数量关系]
---
```

支持三级 ID `模块.题型.考点`、二级 ID `模块.题型`、中文考点名，甚至随手写的词
（认不出来的会走自定义关键词匹配）。完整知识点树来自 `src/shared/skillPoints.js`。

### 数学公式：Obsidian 原生 LaTeX（MathJax）

**Obsidian 自带 MathJax，不需要装插件**。所有数学内容统一写成 LaTeX：
行内用 `$...$`，重要公式用 `$$...$$` 单独占行、前后各留一个空行。

```markdown
二阶系统 $G(s)=\frac{\omega_n^{2}}{s^{2}+2\zeta\omega_n s+\omega_n^{2}}$，其中 $\zeta$ 为阻尼比。

$$
t_p = \frac{\pi}{\omega_n\sqrt{1-\zeta^{2}}}
$$
```

规则（规范文本的唯一来源是 `obsidian/oe_math.py` 的 `MATH_STYLE`，
Node 侧的等价文本在 `src/shared/mathStyle.js`，`npm run verify:latex` 会逐字比对两份）：

| 要做 | 不要做 |
| --- | --- |
| 中文、单位、说明放公式外：「需要 $\frac{24}{7} \approx 3.4$ 小时」 | `24/7 ≈ 3.4`、`$\frac{24}{7 \approx 3.4}$`、`$24/7 ≈ 3.4 小时$` |
| 用 LaTeX 命令：`\times`、`\div`、`\approx`、`x^{2}`、`\sqrt{x}`、`\omega` | 公式里写 `× ÷ ≈ ² √ ω` 等 Unicode 伪公式 |
| 必须进公式的中文写 `\text{中文}` | `$工作量 = 效率 \times 时间$` |
| 块级公式单独占行 | `$$...$$` 和正文挤在同一行（MathJax 不渲染） |
| 只用内置 MathJax 命令 | `\usepackage`、`\newcommand`、`\ce`、`\(...\)`、`\[...\]`、代码块包公式 |

**所有写入路径都遵守这套格式**：应用内 AI 助教整理、对话助教写笔记、教材知识清单、
AI 识图整理、Python 桥接 AI 助教、题库 OCR 与答案解析。提示词注入统一规范，
正文落库 / 落盘前再由 `normalizeMath()` / `normalize_math()` 兜底：
统一旧定界符、把公式内的 Unicode 运算符换成 LaTeX、块级公式独立成段；
把说明吞进 `\frac{}{}` 这类语义错误只告警不猜改，留给人工核对。

存量笔记用 `npm run obsidian:latex` 保守迁移（幂等，跳过 `90-题库/` 与原件），
加 `--dry-run` 可先预览。加 `--note` 之类的单篇处理仍走 `obsidian:tutor`。

### 例题格式（决定能否入库）

```markdown
## 例题

### 例 1 · 工程问题
一个水池，甲管 6 小时注满，乙管 8 小时注满，两管同开需多久？

A. 3 小时
B. 3.4 小时
C. 3.5 小时
D. 4 小时

答案：B
解析：设总量 $W = 24$，甲效率 $4$、乙效率 $3$，合开效率 $7$，故 $t = \frac{24}{7} \approx 3.4$ 小时。
知识点：shuliang.jisuan.gongcheng
难度：2
```

选项支持 `A.` / `A、` / `A)` / `A：`；没有选项时按主观题处理；
`知识点` 可省略（会继承笔记的 frontmatter）。题干、选项、解析里的公式同样用 `$...$`；
`答案：`/`知识点：`/`难度：` 等字段名保持纯文本，填空 / 主观题的**公式答案**可以写成 `$\frac{24}{7}$`，
导入时不会被选项字母过滤器削掉。模板见 `vault/99-模板/规范笔记模板.md`。

---

## 六、数据是怎么流动的

```
OpenExam SQLite ──sync──▶ vault/90-题库/**.md         （Obsidian 内嵌阅读）
        │        ──sync──▶ vault/_bridge/index/*.json  （插件侧边栏读取）
        │
        ▲                                    插件命令 ──▶ _bridge/requests/*.json
        │                                                    │
        └──import── 笔记「## 例题」◀── AI 整理 ◀── 00-收件箱图片  │
                                                             ▼
                                              bridge.py watch 处理并回写结果
```

- **题库源**：默认只读应用当前数据库 `%APPDATA%/studystudio/openexam.db`。
  内置种子库已移除；需要兼容旧库时，在 `obsidian/config.json` 打开
  `database.scanLegacyAppdata`（扫描 `openexam` / `StudyStudio` / `OpenExam` 旧库）。
  也可 `--read-db <路径>` 指定；`npm run obsidian:status` 可查看。
- **写入目标**：始终是应用当前数据库。每次写入前自动 `sqlite3.backup()` 到 `obsidian/backups/`。
- **幂等**：每篇笔记对应一个 `paper_obsidian_<hash>` 试卷，重跑先删旧题再插入，不会重复。
- **防误删**：写入的试卷 `subject = obsidian`、`type = imported`。项目里启动清理只会按
  `paper_oe_` 等内置 ID 精确删除官方题库，并显式跳过 `imported` / `ai_exam` / `ai_practice`，
  不会再按标题关键词模糊删除；
  这里既避开了这两个 subject，也会把笔记标题里的这些词替换成「备考」，避免笔记名恰好命中而被误删。
- **可撤销**：`npm run obsidian:unimport` 只删本桥接写入的试卷和题目（应用 UI 目前删不掉 imported 卷）。

---

## 七、目录说明

| 路径 | 说明 |
| --- | --- |
| `config.json` | 视觉模型、题库源、抽样数量等配置 |
| `state.json` | 已整理文件 / 已导入记录，避免重复处理 |
| `bridge.py` | CLI 入口 |
| `oe_common.py` | 数据库定位、知识点树、frontmatter 工具 |
| `oe_bank.py` | 题库镜像同步 |
| `oe_format.py` | AI 识图整理 |
| `oe_import.py` | 例题解析与入库 |
| `vault/.obsidian/plugins/openexam-bridge/` | 插件（纯 JS，免编译） |
| `vault/90-题库/` | 自动生成的题库镜像（可随时重建） |
| `vault/_bridge/index/` | 插件用的 JSON 索引 |
| `vault/_bridge/requests/` | 插件提交的请求；处理完移到 `done/` |
| `outbox/paper.json` | 标准格式导入包，可拿到别处用 |
| `backups/` | 每次写库前的自动备份 |

生成物都在 `obsidian/.gitignore` 里排除，不会污染 git。

---

## 八、排错

- **侧边栏提示「题库索引还没生成」**：跑一次 `npm run obsidian:sync`。
- **插件命令点了没反应**：`npm run obsidian:watch` 需要常驻运行，它负责消费 `_bridge/requests/`。
- **识图失败 / 返回不是 JSON**：确认模型支持视觉、Base URL 结尾不要多写 `/`、`apiKey` 有效；
  用 `python obsidian/bridge.py format --strict` 看完整报错。
- **题库是空的**：`npm run obsidian:status` 看数据源。应用已不再内置官方题库，
  空库是正常状态，题库只来自你自己导入的内容（含本桥接写入的 Obsidian 例题）。
  旧版本遗留在 `openexam` / `StudyStudio` / `OpenExam` 目录里的系统题库默认**不会**再被读取，
  需要时手动打开 `database.scanLegacyAppdata` 或 `--read-db <路径>` 指定，不要直接覆盖现有库。
- **写了笔记但侧边栏没更新**：`watch` 处理完插件请求后会自动重跑一次 `sync`；手动跑
  `npm run obsidian:sync` 也可以立刻刷新。
- **三级考点题量不准**：题库还没跑 `npm run tag:skill-points` 打标，三级考点走的是关键词近似匹配，
  镜像文件里会标明匹配方式。打标后同步会自动改用精确匹配。

---

## 九、当前状态（2026-11-07 验收）

| 环节 | 状态 |
| --- | --- |
| Obsidian 安装包 | 已下载 `~/Downloads/Obsidian-1.15.0.exe`（324 MB），**需要你双击安装** |
| 仓库注册 / 插件 | 已写入 `%APPDATA%/obsidian/obsidian.json`，插件已预置启用；首次打开需点「信任」 |
| 题库镜像 / 索引 | 当前应用库 107 题 → 3 个知识点镜像；示例笔记已内嵌「相关题库」 |
| AI 识图整理 | 代码就绪，**`config.json` 的 `vision.apiKey` 还是空的**，填了才会执行 |
| 笔记 AI 助教（应用内） | 已接进「笔记」页；真实调用 `deepseek-chat` 验证通过（2.6 s 返回分类 + 规范化正文） |
| 笔记 AI 助教（vault） | 复用应用 AI 设置；应用里整理过的笔记不再重复调模型 |
| 思维导图 | `知识地图.canvas` / `知识地图.md` 已生成；file 节点 `subpath` 指向真实小节，双击即跳 |
| 例题入库 | 已真实写入应用库 2 道例题；幂等、可撤销、重导入均验证通过 |
| 插件命令闭环 | `sync` 请求 → `process` 消费 → 自动重同步 → `outbox/*.result.json` 返回 ok，已验证 |
| 全部 Python 文件 | `py_compile` 通过；前端 `vite build` 通过 |

日常只需要两条命令：`npm run obsidian:all`（一键整理 + 同步 + 入库 + 导图），
以及 `npm run obsidian:watch`（常驻，让插件按钮和应用内新笔记自动生效）。
