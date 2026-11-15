# -*- coding: utf-8 -*-
"""OpenExam AI 助教：读懂笔记 -> 规范化 -> 精细分类 -> 生成可跳转锚点。

文本模型优先复用 OpenExam 应用里已经配置好的 AI（app_settings.ai_settings，
当前是 deepseek-chat），也可以在 obsidian/config.json 的 tutor 段单独指定；
两者都没有可用密钥时，自动退化成本地关键词分类，保证整条链路照样能跑。

仅使用 Python 标准库。
"""
from __future__ import annotations

import json
import re
import shutil
import sqlite3
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import unquote

import oe_common as C
import oe_math as M

NOTE_TYPES = ("概念笔记", "错题复盘", "公式速记", "例题整理", "方法总结",
              "概念辨析", "真题精析", "框架梳理", "随手记录", "通用")
MASTERY = ("刚接触", "理解中", "熟练", "待巩固", "已掌握")

SYSTEM_PROMPT = """你是「OpenExam AI 助教」，负责读懂学生随手写的备考笔记，把它整理成规范、好复习的 Markdown，并做精细分类。

【严格要求】
1. 忠实原意，绝不编造知识点、公式、答案；看不清/没写明的用〔?〕标注。
2. 规范化正文：按「核心概念 / 关键公式 / 解题套路 / 易错点 / 结论速记」中选合适的二级标题重组；
   关键术语加粗，所有数学公式一律写成 LaTeX（严格按下方「数学公式格式」规范），
   并列信息用表格，易错点用 > [!warning] 引用块。
   去掉口语碎句，但保留用户自己的口诀、比喻、记忆锚点。
3. **不要输出「## 例题」章节**（程序会把原文例题原样接回去，避免被改写）。也不要写一级标题和 frontmatter。
   原文里的图片引用（`![[...]]` 或 `![...](...)`）必须原样保留，不要删除、不要改写链接。
4. 分类必须落到下面给出的知识点候选上，最多 3 个；每个再写一句「这篇笔记里该考点讲了什么」。
5. subject / topic 必须与所选知识点的上级一致；不在候选里就填「未分类」。

【输出格式】只输出一个 JSON 对象，不要 markdown 代码块，不要解释文字：
{
  "title": "简短笔记标题",
  "summary": "一句话概括",
  "subject": "数量关系",
  "topic": "数学运算",
  "note_type": "方法总结",
  "difficulty": 3,
  "mastery": "理解中",
  "key_concepts": ["效率", "总量"],
  "tags": ["数量关系", "易错题"],
  "knowledge_points": [
    {"id": "shuliang.jisuan.gongcheng", "note": "用总量设为最小公倍数统一效率，处理中途离开的工程问题"}
  ],
  "body": "## 核心概念\\n..."
}
note_type 取值：概念笔记 / 错题复盘 / 公式速记 / 例题整理 / 方法总结 / 概念辨析 / 真题精析 / 框架梳理 / 随手记录。
difficulty 为 1~5 的整数；mastery 取值：刚接触 / 理解中 / 熟练 / 待巩固 / 已掌握。

{math_style}

【知识点候选（标签 → ID）】
{candidates}
"""

# 规范文本只有一份，放在 oe_math.py 里，Python / Node 两侧共用（验证脚本逐字比对）
SYSTEM_PROMPT = SYSTEM_PROMPT.replace("{math_style}", M.MATH_STYLE)


def read_app_ai_settings(cfg: dict) -> dict:
    """从应用数据库里读取已经配好的文本模型，避免用户再填一次 Key。"""
    db = C.app_db_path(cfg)
    if not db.exists():
        return {}
    try:
        conn = C.connect_ro(db)
        row = conn.execute(
            "SELECT value FROM app_settings WHERE key = 'ai_settings'"
        ).fetchone()
        conn.close()
        if not row:
            return {}
        data = json.loads(row[0])
        return data if isinstance(data, dict) else {}
    except (sqlite3.Error, ValueError, TypeError):
        return {}


def resolve_tutor(cfg: dict) -> dict | None:
    """返回可直接对话的模型配置；没有可用密钥返回 None。"""
    t = cfg.get("tutor") or {}
    if str(t.get("apiKey") or "").strip():
        return {
            "protocol": str(t.get("protocol") or "openai").lower(),
            "baseUrl": str(t.get("baseUrl") or "").rstrip("/"),
            "apiKey": str(t.get("apiKey") or "").strip(),
            "model": str(t.get("model") or "").strip(),
            "maxTokens": int(t.get("maxTokens") or 4096),
            "timeout": int(t.get("timeout") or 90),
            "temperature": float(t.get("temperature") or 0.2),
            "source": "config.json / tutor",
        }
    app = read_app_ai_settings(cfg)
    key = str(app.get("apiKey") or "").strip()
    base = str(app.get("apiBase") or "").strip().rstrip("/")
    model = str(app.get("customModel") or app.get("model") or "").strip()
    if key and base and model:
        return {
            "protocol": "openai",
            "baseUrl": base,
            "apiKey": key,
            "model": model,
            "maxTokens": 4096,
            "timeout": 90,
            "temperature": 0.2,
            "source": "OpenExam 应用 AI 设置",
        }
    v = cfg.get("vision") or {}
    if str(v.get("apiKey") or "").strip() and str(v.get("baseUrl") or "").strip():
        return {
            "protocol": str(v.get("protocol") or "openai").lower(),
            "baseUrl": str(v.get("baseUrl") or "").rstrip("/"),
            "apiKey": str(v.get("apiKey") or "").strip(),
            "model": str(v.get("model") or "").strip(),
            "maxTokens": int(v.get("maxTokens") or 4096),
            "timeout": int(v.get("timeout") or 120),
            "temperature": float(v.get("temperature") or 0.3),
            "source": "config.json / vision（视觉模型兼做文本）",
        }
    return None


def _http_post(url: str, headers: dict, payload: dict, timeout: int) -> dict:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read().decode("utf-8", "replace")
    if raw.lstrip().startswith("<"):
        raise RuntimeError("模型网关返回了网页 HTML，请检查 baseUrl 是否缺少 /v1 等 API 路径")
    try:
        return json.loads(raw)
    except ValueError as exc:
        raise RuntimeError(f"模型网关返回的不是 JSON：{raw[:120]}") from exc


def call_text(cfg: dict, system: str, user: str) -> str:
    conf = resolve_tutor(cfg)
    if not conf:
        raise RuntimeError("没有可用的文本模型")
    if not conf["baseUrl"] or not conf["model"]:
        raise RuntimeError(f"模型配置不完整（{conf['source']}）：baseUrl / model 不能为空")
    if conf["protocol"] == "anthropic":
        result = _http_post(
            f"{conf['baseUrl']}/messages",
            {"Content-Type": "application/json", "x-api-key": conf["apiKey"],
             "anthropic-version": "2023-06-01"},
            {"model": conf["model"], "max_tokens": conf["maxTokens"],
             "system": system, "messages": [{"role": "user", "content": user}]},
            conf["timeout"],
        )
        content = "".join(
            block.get("text", "") for block in result.get("content", [])
            if isinstance(block, dict) and block.get("type") == "text"
        )
    else:
        result = _http_post(
            f"{conf['baseUrl']}/chat/completions",
            {"Content-Type": "application/json",
             "Authorization": f"Bearer {conf['apiKey']}"},
            {"model": conf["model"],
             "messages": [{"role": "system", "content": system},
                          {"role": "user", "content": user}],
             "temperature": conf["temperature"],
             "max_tokens": conf["maxTokens"]},
            conf["timeout"],
        )
        if isinstance(result, dict) and result.get("error"):
            raise RuntimeError(f"模型网关报错：{str(result['error'])[:200]}")
        try:
            content = result["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise RuntimeError(f"模型返回结构异常：{str(result)[:200]}") from exc
    if isinstance(content, list):
        content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
    text = str(content or "").strip()
    if not text:
        raise RuntimeError("模型返回了空文本")
    return text


def candidate_lines(catalog: dict[str, dict]) -> str:
    lines = []
    for node in catalog.values():
        if node["level"] != 3:
            continue
        parent = catalog.get(node.get("parent") or "", {})
        grand = catalog.get(parent.get("parent") or "", {})
        lines.append(f"- {node['label']}（{grand.get('label', '')}/{parent.get('label', '')}） = {node['id']}")
    return "\n".join(lines) or "- （暂无知识点树）"


def parse_tutor_json(text: str) -> dict:
    raw = text.strip()
    raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.I | re.M).strip()
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end <= start:
        raise RuntimeError(f"模型没有返回 JSON：{raw[:160]}")
    data = json.loads(raw[start:end + 1])
    if not isinstance(data, dict) or not str(data.get("body") or "").strip():
        raise RuntimeError("模型返回的 JSON 缺少 body")
    # 模型没守规矩时的兜底：统一公式定界符 / Unicode 运算符，坏公式只告警不改写
    data["body"], warnings = M.normalize_math(str(data["body"]))
    M.report(warnings, str(data.get("title") or "AI 助教"))
    return data


# ------------------------------------------------------------------ 本地兜底

def local_analyze(text: str, catalog: dict[str, dict]) -> dict:
    """没有模型时也能给出基本分类与规范化，保证思维导图照常生成。"""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    title = re.sub(r"^#{1,6}\s*", "", lines[0])[:40] if lines else "未命名笔记"
    body_text = "\n".join(lines)
    scored: list[tuple[int, dict]] = []
    for node in catalog.values():
        if node["level"] != 3:
            continue
        words = set(node.get("keywords") or []) | {node["label"]}
        score = sum(body_text.count(w) for w in words if w)
        if score:
            scored.append((score, node))
    scored.sort(key=lambda pair: (-pair[0], pair[1]["id"]))
    hits = [node for _, node in scored[:3]]
    if not hits:
        t = "错题复盘" if re.search(r"错|误|踩坑", body_text) else \
            "公式速记" if re.search(r"公式|＝|=|定理", body_text) else \
            "例题整理" if re.search(r"例题|答案[:：]|解析[:：]", body_text) else \
            "方法总结" if re.search(r"套路|步骤|方法|先.*再", body_text) else "概念笔记"
    else:
        t = "例题整理" if re.search(r"答案[:：]|## 例题", body_text) else "方法总结"
    points = []
    for node in hits:
        parent = catalog.get(node.get("parent") or "", {})
        words = [w for w in (node.get("keywords") or []) if w and w in body_text]
        points.append({
            "id": node["id"],
            "note": "；".join(words[:3]) if words else f"笔记涉及「{node['label']}」",
        })
    subject = catalog.get(hits[0].get("parent") or "", {}) if hits else {}
    grand = catalog.get(subject.get("parent") or "", {}) if subject else {}
    clean = "\n".join(lines[1:]) if len(lines) > 1 else body_text
    if not re.search(r"^#{2,4}\s", clean, flags=re.M):
        clean = "## 要点\n\n" + clean
    return {
        "title": title,
        "summary": C.truncate(body_text.replace("\n", " "), 70),
        "subject": grand.get("label", "未分类"),
        "topic": subject.get("label", "未分类"),
        "note_type": t if t in NOTE_TYPES else "通用",
        "difficulty": 3,
        "mastery": "理解中",
        "key_concepts": [n["label"] for n in hits],
        "tags": [x for x in (grand.get("label"), subject.get("label")) if x and x != "未分类"],
        "knowledge_points": points,
        "body": clean.strip(),
        "_fallback": True,
    }


# ------------------------------------------------------------------ 结构化结果

def normalize_result(data: dict, text: str, catalog: dict[str, dict]) -> dict:
    """校验 / 补全模型输出，把知识点统一成目录里的 ID。"""
    lookup = C.label_index(catalog)
    raw_points = data.get("knowledge_points") or []
    if isinstance(raw_points, dict):
        raw_points = [raw_points]
    points: list[dict] = []
    for item in raw_points[:6]:
        if isinstance(item, dict):
            pid = str(item.get("id") or item.get("label") or "").strip()
            note = str(item.get("note") or item.get("说明") or "").strip()
        else:
            pid, note = str(item).strip(), ""
        if not pid:
            continue
        resolved = lookup.get(pid) or C.resolve_point_ids([pid], catalog)[0]
        if resolved not in [p["id"] for p in points]:
            points.append({"id": resolved, "note": note or "本笔记涉及该考点"})
    if not points:
        local = local_analyze(text, catalog)
        points = local["knowledge_points"]
        data.setdefault("body", local["body"])

    first = catalog.get(points[0]["id"]) or C.custom_node(points[0]["id"], catalog)
    parent = catalog.get(first.get("parent") or "", {})
    grand = catalog.get(parent.get("parent") or "", {})

    def one_of(key: str, allowed, default):
        value = str(data.get(key) or "").strip()
        return value if value in allowed else default

    key_concepts = data.get("key_concepts") or []
    if isinstance(key_concepts, str):
        key_concepts = re.split(r"[,，;；\s]+", key_concepts)
    tags = data.get("tags") or []
    if isinstance(tags, str):
        tags = re.split(r"[,，;；\s]+", tags)
    try:
        difficulty = max(1, min(5, int(data.get("difficulty") or 3)))
    except (TypeError, ValueError):
        difficulty = 3

    return {
        "title": str(data.get("title") or "未命名笔记").strip()[:60],
        "summary": C.truncate(str(data.get("summary") or ""), 110),
        "subject": str(data.get("subject") or grand.get("label") or "未分类").strip(),
        "topic": str(data.get("topic") or parent.get("label") or "未分类").strip(),
        "note_type": one_of("note_type", NOTE_TYPES, "通用"),
        "difficulty": difficulty,
        "mastery": one_of("mastery", MASTERY, "理解中"),
        "key_concepts": [str(x).strip() for x in key_concepts if str(x).strip()][:8],
        "tags": [str(x).strip() for x in tags if str(x).strip()][:10],
        "knowledge_points": points[:3],
        "body": str(data.get("body") or "").strip(),
        "_fallback": bool(data.get("_fallback")),
    }


def analyze(text: str, cfg: dict, catalog: dict[str, dict]) -> dict:
    conf = resolve_tutor(cfg)
    if conf is None:
        C.warn("没有可用文本模型，AI 助教改用本地关键词分类（功能不受影响，质量略低）")
        return normalize_result(local_analyze(text, catalog), text, catalog)
    system = SYSTEM_PROMPT.replace("{candidates}", candidate_lines(catalog))
    user = "请读懂并整理下面这篇笔记：\n\n" + text[:14000]
    try:
        raw = call_text(cfg, system, user)
        data = parse_tutor_json(raw)
    except (urllib.error.URLError, urllib.error.HTTPError, RuntimeError, ValueError) as exc:
        C.warn(f"AI 助教调用失败（{conf['source']}）：{exc}；改用本地关键词分类")
        return normalize_result(local_analyze(text, catalog), text, catalog)
    return normalize_result(data, text, catalog)


# ------------------------------------------------------------------ 笔记改写

EXAMPLE_RE = re.compile(r"^##\s+例题[^\n]*\n", flags=re.M)


def split_examples(body: str) -> tuple[str, str]:
    """把「## 例题」原样摘出来，避免 AI 改写题目后例题入库失效。"""
    match = EXAMPLE_RE.search(body)
    if not match:
        return body.rstrip(), ""
    rest = body[match.end():]
    following = re.search(r"^##\s+", rest, flags=re.M)
    if following:
        block = rest[:following.start()].strip()
        return (body[:match.start()] + "\n" + rest[following.start():]).rstrip(), block
    return body[:match.start()].rstrip(), rest.strip()


def headings(body: str) -> list[str]:
    result = []
    for line in body.splitlines():
        m = re.match(r"^#{2,4}\s+(.+?)\s*#*\s*$", line)
        if m:
            text = m.group(1).strip().rstrip("#").strip()
            if text and text not in result:
                result.append(text)
    return result


def pick_anchor(body: str, label: str, keywords: list[str]) -> str:
    """为某个知识点挑一个真正讲它的正文标题，思维导图会跳到这里。

    标题文本和标题下的正文都参与打分，避免「核心公式」这类看不出考点的标题
    让所有知识点都只能退回默认锚点。
    """
    clean = C.strip_managed(body, C.BANK_START, C.BANK_END)
    clean = C.strip_kp_block(clean)
    sections: list[tuple[str, str]] = []
    current, buffer = None, []
    for line in clean.splitlines():
        m = re.match(r"^#{2,4}\s+(.+?)\s*#*\s*$", line)
        if m:
            if current:
                sections.append((current, "\n".join(buffer)))
            current, buffer = m.group(1).strip(), []
        elif current:
            buffer.append(line)
    if current:
        sections.append((current, "\n".join(buffer)))

    words = [w for w in ([label] + list(keywords or [])) if w]
    best, best_score = "", 0
    for heading, content in sections:
        if "相关题库" in heading or "知识点定位" in heading:
            continue
        head_hit = sum(3 if w in heading else 0 for w in words)
        body_hit = min(6, sum(content.count(w) for w in words))
        score = head_hit * 2 + body_hit
        if score > best_score:
            best, best_score = heading, score
    return best or "知识点定位"


def render_kp_block(result: dict, catalog: dict[str, dict], body: str,
                    links: dict[str, str]) -> tuple[str, dict[str, str]]:
    lines = [
        "## 知识点定位",
        "",
        "> 由 AI 助教生成。思维导图上的知识点会跳到本笔记里对应的正文小节。",
        "",
    ]
    anchors: dict[str, str] = {}
    for point in result["knowledge_points"]:
        pid = point["id"]
        node = catalog.get(pid) or C.custom_node(pid, catalog)
        anchor = pick_anchor(body, node["label"], node.get("keywords") or [])
        anchors[pid] = anchor
        bank = links.get(pid)
        jump = f"[[#{anchor}|跳到「{anchor}」]]" if anchor != "知识点定位" else "见下方正文"
        extra = f" · [[{bank}|该考点题库]]" if bank else ""
        lines.append(f"**{node['label']}** · {point['note']}")
        lines.append(f"  - {jump}{extra}  ·  `{pid}`")
        lines.append("")
    return "\n".join(lines).rstrip(), anchors


def backup_original(path: Path, text: str) -> Path | None:
    try:
        rel = path.relative_to(C.VAULT)
    except ValueError:
        rel = Path(path.name)
    target = C.ORIGINALS / rel.with_name(rel.stem + "." + C.sha(text, 8) + ".md")
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        target.write_text(text, encoding="utf-8")
    return target


def write_normalized(path: Path, meta: dict, result: dict,
                     catalog: dict[str, dict], dry_run: bool,
                     model_source: str) -> dict:
    old_meta, old_body = C.read_note(path)
    merged = dict(old_meta)
    merged.update(meta)
    clean_body = C.strip_bank_block(C.strip_kp_block(old_body))
    clean_body = C.strip_map_block(clean_body)
    body_no_examples, examples = split_examples(clean_body)

    ai_body, _ = split_examples(result["body"])
    if not ai_body.strip():
        ai_body = body_no_examples
    # 兜底：本地分类 / 应用内旧笔记没经过模型时，正文也要统一成 LaTeX 公式格式
    ai_body, math_warnings = M.normalize_math(ai_body)
    M.report(math_warnings, path.name)
    ai_body = keep_images(ai_body, body_no_examples)
    if examples:
        examples, example_warnings = M.normalize_math(examples)
        M.report(example_warnings, path.name + " / 例题")
    parts = [ai_body.strip()]
    if examples:
        parts.append("## 例题\n\n" + examples.strip())

    links = {}
    catalog_file = C.INDEX / "catalog.json"
    if catalog_file.exists():
        try:
            payload = json.loads(catalog_file.read_text(encoding="utf-8"))
            links = {n["id"]: n.get("file", "") for n in payload.get("nodes", [])}
        except (ValueError, OSError):
            pass
    kp_block, anchors = render_kp_block(result, catalog, "\n\n".join(parts), links)

    point_ids = [p["id"] for p in result["knowledge_points"]]
    labels = [(catalog.get(pid) or C.custom_node(pid, catalog))["label"] for pid in point_ids]
    old_tags = merged.get("tags") or []
    if isinstance(old_tags, str):
        old_tags = [old_tags]
    all_tags = list(dict.fromkeys([str(t) for t in old_tags] +
                                  result["tags"] + [result["subject"], result["topic"]]))
    merged.update({
        "title": result["title"] or merged.get("title") or path.stem,
        "summary": result["summary"] or merged.get("summary", ""),
        "knowledge_points": point_ids,
        "knowledge_labels": labels,
        "subject": result["subject"],
        "topic": result["topic"],
        "note_type": result["note_type"],
        "difficulty": result["difficulty"],
        "mastery": result["mastery"],
        "key_concepts": result["key_concepts"],
        "tags": [t for t in all_tags if t and t != "未分类"][:12],
        "ai_tutor": True,
        "ai_model": model_source,
        "ai_fallback": result["_fallback"],
        "ai_at": C.now_str(),
    })
    final_body = "\n\n".join(parts).rstrip() + "\n\n" + \
        f"{C.KP_START}\n{kp_block}\n{C.KP_END}\n"
    if dry_run:
        return {"updated": 0, "anchors": anchors, "points": point_ids}
    backup_original(path, path.read_text(encoding="utf-8"))
    C.write_note(path, merged, final_body)
    return {"updated": 1, "anchors": anchors, "points": point_ids,
            "path": C.vault_rel(path), "fallback": result["_fallback"]}


def tutor_note(cfg: dict, path: Path, catalog: dict[str, dict],
               dry_run: bool = False, force: bool = False) -> dict:
    path = path.resolve()
    if not path.exists() or path.suffix.lower() != ".md":
        raise RuntimeError(f"笔记不存在：{path}")
    meta, body = C.read_note(path)
    if meta.get("ai_tutor") and not force:
        return {"skipped": "already-ai", "path": C.vault_rel(path)}
    text = C.strip_bank_block(C.strip_kp_block(C.strip_map_block(body)))
    if len(text.strip()) < 8:
        return {"skipped": "empty", "path": C.vault_rel(path)}
    C.log(f"AI 助教整理：{path.name}")
    # dry-run 不产生真实请求，避免预览时白白消耗模型额度
    result = (normalize_result(local_analyze(text, catalog), text, catalog)
              if dry_run else analyze(text, cfg, catalog))
    conf = resolve_tutor(cfg)
    return write_normalized(path, meta, result, catalog, dry_run,
                            conf["source"] if conf else "本地关键词分类")


# ------------------------------------------------------------------ 应用笔记

APP_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(openexam-asset://note-assets/([^)\s]+)\)")
IMAGE_MARK_RE = re.compile(r"(!\[\[[^\]]+\]\]|!\[[^\]]*\]\([^)]+\))")


def keep_images(new_body: str, old_body: str) -> str:
    """AI 重写正文时容易丢掉图片行，缺失的补回「## 附图」。"""
    marks = IMAGE_MARK_RE.findall(old_body or "")
    if not marks:
        return new_body
    missing = [mark for mark in dict.fromkeys(marks) if mark not in (new_body or "")]
    if not missing:
        return new_body
    return new_body.rstrip() + "\n\n## 附图\n\n" + "\n\n".join(missing) + "\n"


def port_note_images(body: str, cfg: dict) -> tuple[str, int]:
    """把应用里的笔记图片复制进 vault，并把链接改写成 vault 内的相对路径。

    应用正文里是 `![说明](openexam-asset://note-assets/<noteId>/<file>)`，
    这种链接 Obsidian 打不开，必须先落到 `99-附件/笔记图片/<noteId>/` 再改成本地相对路径。
    """
    if not APP_IMAGE_RE.search(body or ""):
        return body, 0

    assets_root = (C.app_db_path(cfg).parent / "note-assets").resolve()
    copied = 0

    def replace(match: re.Match) -> str:
        nonlocal copied
        alt, rel = match.group(1), unquote(match.group(2))
        source = (assets_root / rel).resolve()
        if not str(source).startswith(str(assets_root)) or not source.is_file():
            C.warn(f"  笔记图片缺失：{rel}")
            return match.group(0)
        target = C.ASSETS / "笔记图片" / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists() or target.stat().st_size != source.stat().st_size:
            shutil.copy2(source, target)
        copied += 1
        # 应用笔记在 10-笔记/应用笔记/ 下，往上两级就是 vault 根目录
        return f"![{alt}](../../99-附件/笔记图片/{rel})"

    return APP_IMAGE_RE.sub(replace, body), copied


def _parse_tags(raw) -> list[str]:
    """应用把标签存成 JSON 数组字符串（["a","b"]），直接按逗号切会带出引号。"""
    text = str(raw or "").strip()
    if not text:
        return []
    if text.startswith("["):
        try:
            data = json.loads(text)
        except ValueError:
            data = None
        if isinstance(data, list):
            return [str(t).strip() for t in data if str(t).strip()]
    return [t.strip() for t in re.split(r"[,，;；\s]+", text) if t.strip()]


def _parse_app_meta(raw) -> dict:
    """应用内 AI 助教写进 notes.meta 的 JSON；老库没有这一列时返回空。"""
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _result_from_app_meta(app_meta: dict, title: str, content: str,
                          tags: list[str], catalog: dict[str, dict]) -> dict:
    """把应用内的分类结果翻成 write_normalized 认识的结构，避免同一篇笔记再花一次模型额度。"""
    points = []
    for item in app_meta.get("knowledgePoints") or []:
        if isinstance(item, dict) and item.get("id"):
            points.append({"id": item["id"], "note": item.get("note") or ""})
    data = {
        "title": app_meta.get("title") or title,
        "summary": app_meta.get("summary") or "",
        "subject": app_meta.get("subject") or "",
        "topic": app_meta.get("topic") or "",
        "note_type": app_meta.get("noteType") or "",
        "difficulty": app_meta.get("difficulty") or 3,
        "mastery": app_meta.get("mastery") or "",
        "key_concepts": app_meta.get("keyConcepts") or [],
        "tags": tags,
        "knowledge_points": points,
        "body": content,
        "_fallback": bool(app_meta.get("fallback")),
    }
    return normalize_result(data, content, catalog)


def pull_app_notes(cfg: dict, dry_run: bool = False, force: bool = False) -> dict:
    """把 OpenExam 应用「笔记」页里写的笔记拉进 vault，作为思维导图的数据源。

    应用内如果已经用 AI 助教整理过，notes.meta 里会带分类结果，
    这里直接复用，不再调用一次模型。
    """
    db = C.app_db_path(cfg)
    if not db.exists():
        return {"pulled": 0, "total": 0}
    conn = C.connect_ro(db)
    try:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(notes)").fetchall()}
        has_meta = "meta" in columns
        fields = "id,title,content,tags,source_type,source_label,updated_at"
        if has_meta:
            fields += ",meta"
        rows = conn.execute(f"SELECT {fields} FROM notes ORDER BY updated_at DESC").fetchall()
    finally:
        conn.close()

    state = C.load_state()
    pulled_state = state.setdefault("app_notes", {})
    pulled = 0
    classified = 0
    C.APP_NOTES.mkdir(parents=True, exist_ok=True)
    catalog = C.flatten_tree(C.load_tree())

    for row in rows:
        note_id, title, content, tags, source_type, source_label, updated_at = row[:7]
        raw_meta = row[7] if has_meta and len(row) > 7 else None
        app_meta = _parse_app_meta(raw_meta)
        blob = "\n".join(str(x or "") for x in (title, content, tags, updated_at, raw_meta))
        digest = C.sha(blob, 20)
        name = C.safe_name(str(title or "未命名笔记"))[:48] or "未命名笔记"
        target = C.APP_NOTES / f"{name}-{note_id[:6]}.md"
        if not force and pulled_state.get(note_id, {}).get("hash") == digest and target.exists():
            continue
        tag_list = _parse_tags(tags)
        meta = {
            "title": str(title or "未命名笔记"),
            "date": str(updated_at or C.today())[:10],
            "tags": tag_list,
            "source": "openexam-app",
            "app_note_id": str(note_id),
            "app_updated_at": str(updated_at or ""),
        }
        raw_body = str(content or "").strip() + "\n"
        if dry_run:
            C.log(f"  [dry-run] 将拉取应用笔记：{name}")
            pulled += 1
            continue
        body, image_count = port_note_images(raw_body, cfg)
        # 应用侧旧数据里可能还是纯文本公式，进 vault 前统一成 LaTeX
        body, math_warnings = M.normalize_math(body)
        M.report(math_warnings, target.name)
        C.write_note(target, meta, body)
        # 原件留存一份，AI 规范化后可随时对照
        raw = C.ORIGINALS / "应用笔记" / target.name
        raw.parent.mkdir(parents=True, exist_ok=True)
        raw.write_text(raw_body, encoding="utf-8")
        pulled_state[note_id] = {"hash": digest, "file": C.vault_rel(target),
                                 "at": C.now_str()}
        pulled += 1

        if app_meta:
            result = _result_from_app_meta(app_meta, str(title or ""), body, tag_list, catalog)
            source = "应用内 AI 助教"
            if app_meta.get("model"):
                source += f"（{app_meta['model']}）"
            write_normalized(target, meta, result, catalog, False, source)
            classified += 1

    if not dry_run:
        C.save_state(state)
    return {"pulled": pulled, "classified": classified, "total": len(rows)}


# ------------------------------------------------------------------ 入口

def tutor_all(cfg: dict, dry_run: bool = False, force: bool = False,
              note_paths: list[Path] | None = None) -> dict:
    C.ensure_dirs()
    tree = C.load_tree()
    catalog = C.flatten_tree(tree)
    if note_paths:
        targets = note_paths
    else:
        targets = [p for p in sorted(C.NOTES.rglob("*.md"))
                   if not p.name.startswith(".")]
    results = []
    for path in targets:
        try:
            item = tutor_note(cfg, path, catalog, dry_run=dry_run, force=force)
            item["path"] = C.vault_rel(path)
            results.append(item)
        except RuntimeError as exc:
            C.warn(f"  跳过 {path.name}：{exc}")
    updated = sum(1 for r in results if r.get("updated"))
    return {"notes": len(targets), "updated": updated,
            "fallback": sum(1 for r in results if r.get("fallback")),
            "details": results}
