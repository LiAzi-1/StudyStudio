# -*- coding: utf-8 -*-
"""AI 识图整理笔记。

使用 obsidian/config.json 里独立的视觉模型配置（不改动项目原有 AI 设置），
把收件箱里潦草的笔记 / 照片整理成结构规范的复习笔记，输出到 10-笔记/。

支持 OpenAI 兼容协议（GLM-4V、qwen-vl、豆包 Vision、GPT-4o…）与 Anthropic 协议。
仅使用 Python 标准库。
"""
from __future__ import annotations

import base64
import json
import mimetypes
import re
import urllib.error
import urllib.request
from pathlib import Path

import oe_common as C
import oe_math as M

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
TEXT_EXTS = {".md", ".txt", ".markdown"}

SYSTEM_PROMPT = """你是「备考笔记整理助手」。用户会把随手记的、潦草的、可能是照片的笔记交给你。
你的任务：识别内容，二次整理成一份美观、规范、适合复习的 Obsidian Markdown 笔记。

【整理要求】
1. 忠实还原原意，不编造知识点；看不清的字用〔?〕标注，不要猜。
2. 重写结构：概念定义 / 核心公式 / 解题套路 / 易错点 / 结论速记。用恰当的二级、三级标题。
3. 关键术语加粗；所有数学公式一律写成 LaTeX（严格按下方「数学公式格式」规范）；并列信息用表格；易错点用 > [!warning] 引用块。
4. 语言精炼，去掉口语碎句，但保留用户自己的记忆锚点（口诀、比喻）。
5. 若原文含例题，统一整理到「## 例题」下，每道题严格用下面的格式，供程序解析入库：

## 例题

### 例 1 · <考点名>
<题干，可多行，不含选项>

A. <选项A>
B. <选项B>
C. <选项C>
D. <选项D>

答案：B
解析：<简明解析>
知识点：<形如 shuliang.jisuan.gongcheng 的知识点 ID，或中文考点名>
难度：2

（没有选择题时，选项可省略，答案写文字答案；没有例题就整个省略「## 例题」章节。）

6. 从知识点树里挑 1~3 个最贴切的知识点 ID 作为 knowledge_points。
   常用：yanyu.xuanci / yanyu.yueduan / shuliang.jisuan.gongcheng / shuliang.jisuan.xingcheng /
   shuliang.jisuan.lirun / panduan.luoji.jiaqiang / ziliao.zonghe.zengzhanglv /
   changshi.falv.xianfa / changshi.keji.wuli 等。

【输出格式】只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字：
{
  "title": "简短笔记标题",
  "knowledge_points": ["shuliang.jisuan.gongcheng"],
  "tags": ["数量关系", "易错题"],
  "summary": "一句话概括这篇笔记",
  "body": "## 核心概念\\n...\\n\\n## 例题\\n\\n### 例 1 ...\\n..."
}
body 是完整 Markdown 正文（不要再写一级标题和 frontmatter）。

{math_style}
"""

# 规范文本只有一份，放在 oe_math.py 里，Python / Node 两侧共用（验证脚本逐字比对）
SYSTEM_PROMPT = SYSTEM_PROMPT.replace("{math_style}", M.MATH_STYLE)

USER_HINT = "请识别并整理这份笔记。若含手写内容请尽量准确转录，再按系统要求输出 JSON。"


def _vision(cfg: dict) -> dict:
    return cfg.get("vision", {})


def _http_post(url: str, headers: dict, payload: dict, timeout: int) -> dict:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read().decode("utf-8", "replace")
    return json.loads(raw)


def call_vision(cfg: dict, images: list[tuple[str, bytes]], extra_text: str = "") -> dict:
    v = _vision(cfg)
    api_key = str(v.get("apiKey") or "").strip()
    if not api_key:
        raise RuntimeError(
            "未配置视觉模型 apiKey。请编辑 obsidian/config.json 的 vision 段，"
            "填入支持图片的模型（如 glm-4v-flash / qwen-vl-max / gpt-4o）及密钥。"
        )
    base = str(v.get("baseUrl") or "").rstrip("/")
    model = str(v.get("model") or "").strip()
    if not base or not model:
        raise RuntimeError("vision.baseUrl / vision.model 不能为空")
    timeout = int(v.get("timeout") or 120)
    protocol = str(v.get("protocol") or "openai").lower()
    text = (extra_text or "").strip() or USER_HINT

    if protocol == "anthropic":
        parts = []
        for name, data in images:
            mime = mimetypes.guess_type(name)[0] or "image/png"
            parts.append({
                "type": "image",
                "source": {"type": "base64", "media_type": mime,
                           "data": base64.b64encode(data).decode("ascii")},
            })
        parts.append({"type": "text", "text": text})
        payload = {
            "model": model,
            "max_tokens": int(v.get("maxTokens") or 4096),
            "system": SYSTEM_PROMPT,
            "messages": [{"role": "user", "content": parts}],
        }
        result = _http_post(
            f"{base}/messages",
            {"Content-Type": "application/json", "x-api-key": api_key,
             "anthropic-version": "2023-06-01"},
            payload, timeout,
        )
        content = "".join(
            block.get("text", "") for block in result.get("content", [])
            if isinstance(block, dict) and block.get("type") == "text"
        )
    else:
        parts = [{"type": "text", "text": text}]
        for name, data in images:
            mime = mimetypes.guess_type(name)[0] or "image/png"
            parts.append({
                "type": "image_url",
                "image_url": {"url": f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"},
            })
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": parts},
            ],
            "temperature": float(v.get("temperature") or 0.3),
            "max_tokens": int(v.get("maxTokens") or 4096),
        }
        result = _http_post(
            f"{base}/chat/completions",
            {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
            payload, timeout,
        )
        try:
            content = result["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise RuntimeError(f"视觉模型返回结构异常：{str(result)[:300]}") from exc
        if isinstance(content, list):
            content = "".join(
                part.get("text", "") for part in content if isinstance(part, dict)
            )
    return parse_llm_json(str(content))


def parse_llm_json(text: str) -> dict:
    raw = text.strip()
    raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.I | re.M).strip()
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end <= start:
        raise RuntimeError(f"模型没有返回 JSON：{raw[:200]}")
    data = json.loads(raw[start:end + 1])
    if not isinstance(data, dict):
        raise RuntimeError("模型返回的 JSON 不是对象")
    body = str(data.get("body") or "").strip()
    if not body:
        raise RuntimeError("模型返回的 body 为空")
    # 模型没守规矩时的兜底：统一公式定界符 / Unicode 运算符，坏公式只告警不改写
    body, warnings = M.normalize_math(body)
    M.report(warnings, str(data.get("title") or "识图整理"))
    points = data.get("knowledge_points") or []
    if isinstance(points, str):
        points = [points]
    tags = data.get("tags") or []
    if isinstance(tags, str):
        tags = [tags]
    return {
        "title": str(data.get("title") or "未命名笔记").strip(),
        "knowledge_points": [str(p).strip() for p in points if str(p).strip()],
        "tags": [str(t).strip() for t in tags if str(t).strip()],
        "summary": str(data.get("summary") or "").strip(),
        "body": body,
    }


def _copy_originals(files: list[Path]) -> list[str]:
    links = []
    for src in files:
        try:
            relative = src.relative_to(C.INBOX)
        except ValueError:
            relative = Path(src.name)
        target = C.ASSETS / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            target.write_bytes(src.read_bytes())
        links.append(C.link_of(target))
    return links


def _file_key(path: Path) -> str:
    stat = path.stat()
    return f"{path.relative_to(C.VAULT).as_posix()}|{stat.st_size}|{int(stat.st_mtime)}"


def _groups() -> list[tuple[str, list[Path]]]:
    """根目录每张图一条笔记；子文件夹里的多张图合成一条笔记。"""
    groups: list[tuple[str, list[Path]]] = []
    if not C.INBOX.exists():
        return groups
    for path in sorted(C.INBOX.iterdir()):
        if path.is_dir() and not path.name.startswith("."):
            files = [p for p in sorted(path.rglob("*"))
                     if p.is_file() and (p.suffix.lower() in IMAGE_EXTS or p.suffix.lower() in TEXT_EXTS)]
            if files:
                groups.append((path.name, files))
        elif path.is_file() and path.suffix.lower() in IMAGE_EXTS:
            groups.append((path.stem, [path]))
    for path in sorted(C.INBOX.glob("*.md")) + sorted(C.INBOX.glob("*.txt")):
        if path.name.startswith("使用说明"):
            continue
        groups.append((path.stem + "（文字整理）", [path]))
    return groups


def _write_result(title: str, data: dict, originals: list[Path], cfg: dict,
                  dry_run: bool = False) -> Path | None:
    links = _copy_originals(originals) if not dry_run and originals else []
    meta = {
        "title": data["title"] or title,
        "date": C.today(),
        "knowledge_points": data["knowledge_points"],
        "tags": data["tags"],
        "summary": data["summary"],
        "原件": links,
        "整理方式": "OpenExam AI 识图整理",
        "generated": C.now_str(),
    }
    body = data["body"].strip() + "\n"
    target = C.NOTES / (C.slugify(data["title"] or title) + ".md")
    suffix = 2
    while target.exists() and not dry_run:
        target = C.NOTES / (C.slugify(data["title"] or title) + f"-{suffix}.md")
        suffix += 1
    if dry_run:
        C.log(f"  [dry-run] 将生成 {target.name}，知识点 {data['knowledge_points']}")
        return None
    C.write_note(target, meta, body)
    return target


def format_inbox(cfg: dict, dry_run: bool = False, force: bool = False,
                 strict: bool = False) -> dict:
    C.ensure_dirs()
    groups = _groups()
    if not groups:
        C.log("收件箱里没有待整理的图片或文字笔记")
        return {"processed": 0, "created": 0}

    state = C.load_state()
    formatted = state.setdefault("formatted", {})
    v = _vision(cfg)
    if not str(v.get("apiKey") or "").strip() and not dry_run:
        message = (
            "未配置视觉模型，跳过 AI 整理。请编辑 obsidian/config.json 的 vision 段：\n"
            f"  当前模型：{v.get('model')} / {v.get('baseUrl')}\n"
            "  apiKey 为空。填入支持图片的模型密钥后重跑 npm run obsidian:format。"
        )
        if strict:
            raise RuntimeError(message)
        C.warn(message)
        return {"processed": 0, "created": 0, "skipped": "no-api-key"}

    created = 0
    processed = 0
    for label, files in groups:
        keys = [_file_key(p) for p in files]
        state_key = C.sha("|".join(keys), 20)
        if not force and formatted.get(state_key):
            continue
        images = [(p.name, p.read_bytes()) for p in files if p.suffix.lower() in IMAGE_EXTS]
        texts = [p.read_text(encoding="utf-8", errors="replace")
                 for p in files if p.suffix.lower() in TEXT_EXTS]
        hint = USER_HINT
        if texts:
            hint += "\n\n以下是用户附带的文字笔记：\n" + "\n---\n".join(texts)
        C.log(f"整理「{label}」：{len(images)} 张图 / {len(texts)} 段文字")
        if dry_run:
            C.log(f"  [dry-run] 将调用模型 {v.get('model')}，跳过实际请求")
            processed += 1
            continue
        try:
            data = call_vision(cfg, images, hint)
        except (urllib.error.URLError, urllib.error.HTTPError, RuntimeError) as exc:
            C.warn(f"  「{label}」整理失败：{exc}")
            if strict:
                raise
            continue
        target = _write_result(label, data, files, cfg, dry_run=False)
        if target:
            C.log(f"  -> {target.relative_to(C.VAULT).as_posix()}")
            created += 1
        processed += 1
        formatted[state_key] = {"at": C.now_str(), "title": data["title"], "files": len(files)}

    if not dry_run:
        C.save_state(state)
    return {"processed": processed, "created": created}


def format_existing_note(cfg: dict, path: Path, dry_run: bool = False) -> dict:
    """插件命令：把一篇现有笔记重新排版（纯文本模式，不改动 frontmatter 知识点）。"""
    if not path.exists():
        raise RuntimeError(f"笔记不存在：{path}")
    meta, body = C.read_note(path)
    body = C.strip_bank_block(body)
    hint = (
        USER_HINT + "\n\n这是用户已有的一篇 Markdown 笔记，请重排为规范复习笔记，"
        "保留原有知识点和例题，不要丢弃内容：\n\n" + body[:12000]
    )
    C.log(f"重排笔记：{path.name}")
    if dry_run:
        return {"updated": 0}
    data = call_vision(cfg, [], hint)
    merged_points = meta.get("knowledge_points") or data["knowledge_points"]
    merged = dict(data)
    merged["knowledge_points"] = merged_points if isinstance(merged_points, list) else [merged_points]
    meta.update({
        "tags": data["tags"] or meta.get("tags") or [],
        "summary": data["summary"] or meta.get("summary", ""),
        "整理方式": "OpenExam AI 二次整理",
        "generated": C.now_str(),
    })
    C.write_note(path, meta, data["body"].strip() + "\n")
    return {"updated": 1, "path": str(path)}
