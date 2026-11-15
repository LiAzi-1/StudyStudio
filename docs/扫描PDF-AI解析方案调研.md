# AI 快速读懂扫描版 PDF：GitHub 开源方案调研

> 调研日期：2026-11-12
> 数据来源：GitHub REST API（`api.github.com/repos/*` 的 star / license / pushed_at）+ 各项目 README
> 背景：OpenExam 当前做法是把每页渲染成 JPEG，逐页调用多模态 API 转写。一本 420 页扫描教材
> 需要 420 次 API 调用，按 DeepSeek Flash 闲时价估算约 ¥3–6，而账户余额只剩 ¥2.90；
> 且「题目引用图 X-Y」需要靠模型猜 bbox 裁图，准确率不稳。本调研为换成本地/混合方案做选型。

---

## 一、结论先行

**推荐主方案：MinerU（首选）或 PaddleOCR-VL（次选）做本地批量转写，把 420 页一次性跑完，
API 只留作可选的语义整理。** 这样能同时解决三个问题：

1. **成本**：本地推理不烧 token，420 页不再受 ¥2.90 余额限制；
2. **速度**：官方自测都在页/秒量级，比「逐页走网络 API + 3 路并发」快一个数量级；
3. **图文匹配**：这些工具输出**版面 bbox**（图、表、公式各自的坐标块），
   比我上一轮「让识图模型在 0-1000 坐标里猜一个框」准得多，可以直接按 bbox 裁出单张插图。

**如果对中文 + 公式 + 表格的准确率要求最高** → MinerU（上海 AI Lab，83.5k star，2026-11-11 仍在更新，
明确支持扫描件、行内公式、跨页表格合并，自带 HTTP server）。
**如果要求 License 干净、可商用、中文生态成熟** → PaddleOCR / PaddleOCR-VL（92.6k star，Apache-2.0，109 种语言）。
**如果只是想先低成本验证效果** → RapidOCR（ONNX，CPU 可跑，8.5k star）或 Umi-OCR（桌面 GUI，免代码）。

---

## 二、候选项目全景（star 数为 2026-11-12 实查）

| 项目 | Star | License | 最近提交 | 定位 |
|---|---:|---|---|---|
| [microsoft/markitdown](https://github.com/microsoft/markitdown) | 195.0k | MIT | 2026-11-07 | 通用文件→Markdown，**不做扫描件 OCR** |
| [PaddlePaddle/PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) | 92.6k | Apache-2.0 | 2026-09-16 | 中文 OCR 生态，含 PaddleOCR-VL |
| [opendatalab/MinerU](https://github.com/opendatalab/MinerU) | 83.5k | 自定义（NOASSERTION） | 2026-11-11 | 复杂 PDF→LLM-ready Markdown/JSON |
| [docling-project/docling](https://github.com/docling-project/docling) | 70.5k | MIT | 2026-11-11 | IBM，本地文档 ETL，MIT |
| [hiroi-sora/Umi-OCR](https://github.com/hiroi-sora/Umi-OCR) | 48.6k | MIT | 2025-11-20 | 离线桌面 OCR 软件（中文） |
| [VikParuchuri/marker](https://github.com/VikParuchuri/marker) | 40.9k | Apache-2.0（权重 Open Rail-M） | 2026-11-11 | PDF→Markdown + JSON，主打快 |
| [jbarlow83/OCRmyPDF](https://github.com/jbarlow83/OCRmyPDF) | 35.3k | MPL-2.0 | 2026-11-09 | 给扫描 PDF 加文字层（Tesseract） |
| [deepseek-ai/DeepSeek-OCR](https://github.com/deepseek-ai/DeepSeek-OCR) | 24.1k | MIT | 2026-01-27 | 上下文光学压缩 |
| [deepseek-ai/DeepSeek-OCR-2](https://github.com/deepseek-ai/DeepSeek-OCR-2) | 3.5k | — | 2026-02-03 | Visual Causal Flow，二代 |
| [datalab-to/surya](https://github.com/datalab-to/surya) | 21.6k | Apache-2.0 | 2026-11-08 | OCR + 版面 + 阅读顺序，90+ 语言 |
| [allenai/olmocr](https://github.com/allenai/olmocr) | 19.8k | Apache-2.0 | 2026-03-25 | 扫描 PDF 线性化，7B VLM |
| [unstructured-io/unstructured](https://github.com/unstructured-io/unstructured) | 15.7k | Apache-2.0 | 2026-11-06 | 文档 ETL，RAG 前置 |
| [datalab-to/chandra](https://github.com/datalab-to/chandra) | 12.7k | Apache-2.0 | 2026-10-22 | 复杂表格 / 表单 / 手写 |
| [getomni-ai/zerox](https://github.com/getomni-ai/zerox) | 12.3k | MIT | 2025-05-20 | 把 PDF 页丢给视觉模型（和当前做法同类） |
| [facebookresearch/nougat](https://github.com/facebookresearch/nougat) | 10.1k | MIT | 2025-02-21 | 学术 PDF 公式转 LaTeX（已停更） |
| [rednote-hilab/dots.ocr](https://github.com/rednote-hilab/dots.ocr) | 9.2k | MIT | 2026-03-24 | 单 VLM 做多语言版面解析 |
| [RapidAI/RapidOCR](https://github.com/RapidAI/RapidOCR) | 8.5k | Apache-2.0 | 2026-11-12 | ONNX 多端 OCR，CPU 可跑 |
| [Ucas-HaoranWei/GOT-OCR2.0](https://github.com/Ucas-HaoranWei/GOT-OCR2.0) | 8.2k | 无 License 文件 | 2025-02-10 | 端到端通用 OCR（已停更） |
| [Yuliang-Liu/MonkeyOCR](https://github.com/Yuliang-Liu/MonkeyOCR) | 6.7k | Apache-2.0 | 2026-07-20 | 轻量 LMM 文档解析 |
| [breezedeus/Pix2Text](https://github.com/breezedeus/Pix2Text) | 3.3k | MIT | 2026-08-23 | 小模型，版面 / 表格 / **数学公式 LaTeX** |
| [opendatalab/DocLayout-YOLO](https://github.com/opendatalab/DocLayout-YOLO) | 2.3k | AGPL-3.0 | 2026-10-21 | 只做版面检测（可当组件） |

> 注：`QuivrHQ/MegaParse`(7.4k)、`HKUDS/RAG-Anything`(24.5k) 属于「解析完之后的 RAG 框架」，
> 不是扫描件识别本身，本次不列入主选。

---

## 三、四条技术路线

### A. 流水线式（检测版面 → 分别 OCR / 公式 / 表格 → 拼 Markdown）
代表：**MinerU、PaddleOCR、Docling、Pix2Text、Surya**

- 优点：可控、能拿到**每个图/表/公式的 bbox**，天然适合图文匹配；CPU 也能跑（慢）。
- 缺点：组件多、依赖重，部署体积大（对 Electron 打包不友好，宜做成独立 sidecar 或让用户自备 Python）。
- **MinerU** 细节：扫描件走 OCR / VLM 后端（vLLM、LMDeploy、llama.cpp），
  CPU 可跑，NVIDIA 建议 8GB+ 显存，内存分 2/8/16GB 档；行内公式、跨页表格合并；
  ONNX 加速约 2–3× CPU；自带 `/v1/file_parse` HTTP server 与 Docker。
  ⚠️ License 是自定义的（有商业使用 / 署名附加条件），商用前要读 LICENSE.md。
- **marker** 细节：扫描页交 surya VLM，支持 `--force_ocr` / `--disable_ocr`，
  可选 `--use_llm` 提升表格与公式；自带 FastAPI `marker_server`。
  ⚠️ 代码 Apache-2.0，但**模型权重是 Open Rail-M**，营收 >$5M 需商业授权。

### B. 端到端 VLM（一页图 → 直接吐 Markdown）
代表：**DeepSeek-OCR / OCR-2、olmOCR、dots.ocr、MonkeyOCR、Chandra、GOT-OCR2.0**

- 优点：链路短，阅读顺序 / 多栏 / 手写 / 去页眉页脚处理得更自然。
- 缺点：几乎都要 GPU，输出坐标不如流水线准（但 DeepSeek-OCR 有 grounding）。
- **DeepSeek-OCR**：核心是「上下文光学压缩」——把长文档压成少量 vision token 再交给 LLM，
  A100-40G 上 PDF 并发约 **2500 tokens/s**；分辨率档 64 / 100 / 256 / 400 vision tokens，
  中文可用（README 自带中文示例）；`<|grounding|>Convert the document to markdown` 直接出 Markdown，
  **`Locate <|ref|>xxx<|/ref|> in the image` 能返回目标位置** —— 这条对「按图号定位插图」特别有用。
  MIT，vLLM 原生支持。⚠️ 该仓库 2026-01 后没再更新，重心转到独立的 DeepSeek-OCR-2 仓库。
- **olmOCR**（Allen AI）：专门做扫描/图像 PDF → 干净 Markdown，7B VLM，
  需 ≥12GB 显存，Docker + vLLM，提供 OpenAI 兼容 `--server`；
  官方给的成本是 **< $200 / 百万页**；Apache-2.0。⚠️ 数据过滤偏英文 PDF，中文教材要自测。
- **dots.ocr**（小红书）：单 VLM 同时做多语言布局 + 识别，MIT，9.2k star，中文场景值得关注。

### C. 纯 OCR / 文字层（不做语义理解）
代表：**OCRmyPDF、RapidOCR、Umi-OCR、Tesseract**

- 适合「先把扫描件变成可搜索 PDF / 纯文本」，再交给 LLM 理解。
- **RapidOCR**：ONNX Runtime / OpenVINO / MNN，CPU 可跑、依赖轻，最容易塞进 Electron 应用。
- **OCRmyPDF**：只加文字层，不改变版式，公式和图会丢，不适合教材。
- 这条路对 **LaTeX 公式 + 方框图** 无能为力，只能兜底。

### D. 视觉模型 API 编排（当前 OpenExam 的做法）
代表：**zerox**，以及本项目 `ai:transcribePage`

- 优点：零部署，改 prompt 就能加能力（我上一轮加的 bbox 输出就是这条路）。
- 缺点：每页一次 API、受余额和速率限制、bbox 靠模型猜、无法离线。
- 结论：**保留作为「无本地环境时的降级路径」，但不应是主路径。**

---

## 四、速度参考（注意口径）

marker 官方 README 给出的 B200 并发基准（页/秒，**厂商自测，非第三方，仅供参考**）：

| 工具 | 页/秒 |
|---|---:|
| marker（no OCR） | 23.7 |
| marker（fast） | 7.4 |
| marker（balanced） | 2.9 |
| docling | 2.1 |
| MinerU | 0.54 |

DeepSeek-OCR 给的是 **A100-40G 上约 2500 tokens/s** 的吞吐，不是页/秒，不能直接横比。
olmOCR 给的是成本 **< $200 / 百万页**。

**换算到本项目**：420 页即使按最慢的 MinerU 0.54 pg/s，也只要约 13 分钟（单卡）；
而当前逐页 API 方案实测 20 页约 1.5 分钟，420 页约 30 分钟且要花 ¥3–6。
本地方案在时间和钱上都是数量级改善。

---

## 五、针对 OpenExam 的落地建议

### 阶段 1：换掉逐页 API（收益最大，改动最小）
1. 新增一个「本地解析器」抽象，`transcribePage` 增加 `engine: 'api' | 'local'`：
   - `local` 调用 MinerU 的 `/v1/file_parse`（HTTP），一次提交整本 PDF，拿到 Markdown + `layout.json`；
   - `api` 保留现有逐页流程作为降级。
2. 用户没装本地解析器时，UI 明确提示「当前使用 API 模式，420 页约需 ¥3–6」，并给出安装指引。
3. **余额耗尽自动停**的逻辑我上一轮已经加好（`insufficientBalance` 检测 + 断点续传），保留。

### 阶段 2：把图文匹配从「猜 bbox」换成「用真 bbox」
- MinerU / PaddleOCR 的 layout 输出里每个 image 块都有像素级 bbox，
  直接按它裁图，替换我上一轮 `TRANSCRIBE_WITH_FIGURES_PROMPT` 里让模型猜的 0-1000 坐标；
- 图号 → 插图索引的匹配逻辑（`textbookFigures.js` 的 `normalizeFigureNo` / `extractFigureRefs`）可以原样复用；
- DeepSeek-OCR 的 `<|ref|>` grounding 可作为「按图号反查位置」的第二数据源。

### 阶段 3：公式与表格
- 中文教材里 $$...$$ 公式多，MinerU / Pix2Text / Nougat 都直接输出 LaTeX，
  比让通用 VLM 手写 LaTeX 稳；
- 落库时沿用现有 `content_html` / `material_html` + KaTeX 渲染链路，不用改渲染层。

### 阶段 4：打包与分发
- 这些项目都是 Python + 模型权重（几 GB），**不建议塞进 Electron 安装包**；
- 推荐做成可选 sidecar：设置页里让用户填「本地解析服务地址」，或提供一份
  `docker compose up mineru` 的说明；
- 如果一定要零依赖，用 RapidOCR（ONNX，约几十 MB）做兜底，但公式会退化。

---

## 六、风险与注意事项

| 风险 | 说明 |
|---|---|
| **License** | MinerU 自定义协议、marker 权重 Open Rail-M、GOT-OCR2.0 无 License 文件 —— 商用前逐个确认。PaddleOCR / Docling / DeepSeek-OCR / olmOCR / dots.ocr 是干净的 MIT / Apache-2.0。 |
| **显存** | 端到端 VLM 普遍要 12–40GB 显存；无独显只能用 MinerU CPU 档、RapidOCR 或继续走 API。 |
| **中文公式** | olmOCR 偏英文语料，Nougat 是英文学术 PDF；中文教材优先 MinerU / PaddleOCR-VL / dots.ocr。 |
| **停更项目** | Nougat（2025-02）、GOT-OCR2.0（2025-02）、zerox（2025-05）、Umi-OCR（2025-11）已长时间无提交，别作为长期依赖。 |
| **速度数据** | 上表是各项目自测，硬件是 B200 / A100；消费级显卡要打折，务必用自己的 PDF 抽 20 页实测。 |
| **本项目现状** | 我上一轮已写入「页图落盘 + 模型 bbox 裁图 + 图号索引 + material_html 挂图」的代码（未构建发布）。换本地方案时保留 `textbookFigures.js` 的索引与 URL 部分，只替换 bbox 来源即可，不必推倒重来。 |

---

## 七、一句话建议

**先花半天用 MinerU 的 Docker / HTTP server 跑一遍这本 420 页教材，对比它输出的 Markdown + 版面 bbox
与现有 API 转写结果；如果中文公式和方框图都达标，就把 `transcribePage` 的 local 分支接上，
API 只留作降级。** 这一步能一次性解决余额、耗时、插图定位三个卡点。
