# -*- coding: utf-8 -*-
"""题库 -> Obsidian 镜像同步。

1. 从 OpenExam SQLite（或内置种子库）读取题目
2. 按 模块 / 题型 / 考点 三级知识点生成 90-题库 下的 Markdown 镜像
3. 生成插件用的 JSON 索引
4. 在笔记里幂等注入「相关题库」区块（Obsidian 内嵌 ![[...#题目速览]]）
"""
from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path

import oe_common as C
import oe_math as M


def _columns(conn) -> set[str]:
    return {row[1] for row in conn.execute("PRAGMA table_info(questions)")}


def load_questions(conn) -> list[dict]:
    cols = _columns(conn)
    skill_col = "skill_point" if "skill_point" in cols else None
    fields = [
        "id", "category", "sub_category", "content", "content_html",
        "options", "answer", "analysis", "difficulty", "tags", "type",
    ]
    if skill_col:
        fields.append(skill_col)
    sql = "SELECT " + ", ".join(fields) + " FROM questions"
    rows = []
    for row in conn.execute(sql):
        item = dict(zip(fields, row))
        item["content_text"] = C.plain_text(
            item.get("content_html") or item.get("content") or ""
        ) or C.plain_text(item.get("content") or "")
        item["options_parsed"] = C.parse_options(item.get("options"))
        item["tags_text"] = str(item.get("tags") or "")
        item["haystack"] = (item["content_text"] + " " + item["tags_text"]).lower()
        item["skill_point"] = (item.get(skill_col) or "").strip() if skill_col else ""
        rows.append(item)
    return rows


def _by_scope(questions: list[dict]) -> dict:
    by_cat = defaultdict(list)
    by_sub = defaultdict(list)
    by_skill = defaultdict(list)
    for q in questions:
        by_cat[q["category"]].append(q)
        by_sub[(q["category"], q["sub_category"])].append(q)
        if q["skill_point"]:
            by_skill[q["skill_point"]].append(q)
    return {"cat": by_cat, "sub": by_sub, "skill": by_skill}


def questions_for_node(node: dict, questions: list[dict], scopes: dict) -> tuple[list[dict], str]:
    """返回 (题目列表, 匹配方式说明)。"""
    if node["id"].startswith("custom:"):
        words = [k.lower() for k in node.get("keywords", []) if k]
        hit = [q for q in questions if any(w in q["haystack"] for w in words)]
        return hit, "自定义关键词匹配"

    level = node["level"]
    if level == 1:
        return scopes["cat"].get(node["category"], []), "按模块精确匹配"
    if level == 2:
        return scopes["sub"].get((node["category"], node["sub"]), []), "按题型精确匹配"

    # 三级考点
    exact = scopes["skill"].get(node["id"], [])
    if not exact:
        key = node["id"].split(".")[-1]
        exact = scopes["skill"].get(key, [])
    parent = scopes["sub"].get((node["category"], node["sub"]), [])
    words = [k.lower() for k in node.get("keywords", []) if k]
    approx = [q for q in parent if any(w in q["haystack"] for w in words)]
    if exact:
        seen = {q["id"] for q in exact}
        merged = exact + [q for q in approx if q["id"] not in seen]
        return merged, "考点打标精确匹配 + 关键词补充"
    return approx, "关键词近似匹配（未运行考点打标脚本）"


def question_payload(q: dict, cfg: dict) -> dict:
    limit = int(cfg["sync"]["contentLimit"])
    return {
        "id": q["id"],
        "content": C.truncate(q["content_text"], limit),
        "options": q["options_parsed"],
        "answer": str(q.get("answer") or "").strip(),
        "analysis": C.truncate(C.plain_text(q.get("analysis") or ""), limit),
        "difficulty": q.get("difficulty"),
        "category": q.get("category"),
        "subCategory": q.get("sub_category"),
        "tags": [t for t in q["tags_text"].split(",") if t.strip()][:6],
    }


def render_question(index: int, q: dict) -> str:
    lines = [f"### {index}. {q['content'] or '（题干为空）'}", ""]
    for opt in q["options"]:
        lines.append(f"- **{opt['key']}.** {opt['content']}")
    lines += [
        "",
        "<details>",
        "<summary>答案与解析</summary>",
        "",
        f"**答案：{q['answer'] or '—'}**",
        "",
        q["analysis"] or "_暂无解析_",
        "",
        "</details>",
        "",
    ]
    return "\n".join(lines)


def bank_file_for(node: dict, catalog: dict) -> Path:
    labels = []
    cursor = node
    while cursor:
        labels.append(C.safe_name(cursor["label"]))
        cursor = catalog.get(cursor["parent"]) if cursor.get("parent") else None
    labels.reverse()
    if node["id"].startswith("custom:"):
        return C.BANK_DIR / "自定义" / (labels[-1] + ".md")
    if len(labels) == 1:
        return C.BANK_DIR / (labels[0] + ".md")
    return C.BANK_DIR.joinpath(*labels[:-1]) / (labels[-1] + ".md")


def vault_rel(path: Path) -> str:
    return path.relative_to(C.VAULT).as_posix()


def link_of(path: Path) -> str:
    rel = vault_rel(path)
    return rel[:-3] if rel.endswith(".md") else rel


def render_bank_note(node: dict, catalog: dict, questions: list[dict],
                     mode: str, cfg: dict) -> str:
    sample = max(1, int(cfg["sync"]["samplePerPoint"]))
    parents = []
    cursor = node.get("parent")
    while cursor and cursor in catalog:
        parents.append(catalog[cursor]["label"])
        cursor = catalog[cursor].get("parent")
    breadcrumb = " / ".join(list(reversed(parents)) + [node["label"]]) if parents else node["label"]
    shown = questions[:sample]
    meta = {
        "openexam_id": node["id"],
        "openexam_level": node["level"],
        "openexam_total": len(questions),
        "openexam_match": mode,
        "generated": C.now_str(),
        "tags": ["题库镜像", "自动生成"],
    }
    body = [
        f"# {breadcrumb}",
        "",
        f"> [!info] 由 OpenExam 题库自动生成 · {C.now_str()}",
        f"> 知识点 ID：`{node['id']}` · 共 **{len(questions)}** 道题 · 下面展示前 **{len(shown)}** 道",
        f"> 匹配方式：{mode}。此文件由脚本覆盖，请勿手动编辑。",
        "",
        "## 题目速览",
        "",
    ]
    if not shown:
        body += ["_题库中暂未找到该知识点下的题目。_", ""]
    for index, q in enumerate(shown, 1):
        body.append(render_question(index, question_payload(q, cfg)))
    body += [
        "## 全部题目",
        "",
        f"共 {len(questions)} 道，完整练习请打开 OpenExam 应用 → 专项练习。",
        "",
        "> 在笔记里使用 `![[<本文件路径>#题目速览]]` 可以把上面的题目内嵌到笔记正文中。",
        "",
    ]
    return C.dump_frontmatter(meta) + "\n".join(body)


def render_note_bank_block(point_ids: list[str], catalog: dict,
                           extra_nodes: dict, counts: dict, links: dict) -> str:
    rows = []
    for pid in point_ids:
        node = catalog.get(pid) or extra_nodes.get(pid)
        if not node:
            continue
        target = links.get(pid, "")
        cell = f"[[{target}|打开]]" if target else "—"
        rows.append(f"| {node['label']} | {counts.get(pid, 0)} | {cell} |")
    lines = [
        "## 📚 相关题库",
        "",
        f"> 由 OpenExam 自动同步于 {C.now_str()}，此区块会被覆盖，请勿手动编辑。",
        "",
        "| 知识点 | 题量 | 完整题库 |",
        "| --- | ---: | --- |",
        *rows,
        "",
    ]
    for pid in point_ids[:3]:
        target = links.get(pid)
        if target:
            lines += [f"![[{target}#题目速览]]", ""]
    if len(point_ids) > 3:
        lines += [f"_另有 {len(point_ids) - 3} 个知识点，见上表链接。_", ""]
    return "\n".join(lines).strip()


def render_home_index(catalog: dict, counts: dict, links: dict,
                      source: Path, total: int) -> str:
    by_cat: dict[str, list] = defaultdict(list)
    for node in catalog.values():
        if node["level"] in (1, 2) and counts.get(node["id"], 0) > 0:
            by_cat[node["category"]].append(node)
    lines = [
        "## 🗂 题库知识点索引",
        "",
        f"> 数据源：`{source.name}` · 共 {total} 道题 · 更新于 {C.now_str()}",
        "",
    ]
    for cat, nodes in by_cat.items():
        label = next((n["label"] for n in nodes if n["level"] == 1), cat)
        lines += [f"### {label}", "", "| 题型 / 考点 | 题量 | 镜像 |", "| --- | ---: | --- |"]
        for node in sorted(nodes, key=lambda n: (n["level"], -counts.get(n["id"], 0))):
            if node["level"] == 1:
                continue
            lines.append(
                f"| {node['label']} | {counts.get(node['id'], 0)} | [[{links.get(node['id'], '')}]] |"
            )
        lines.append("")
    return "\n".join(lines).strip()


def sync(cfg: dict, dry_run: bool = False, refresh_tree: bool = False,
         read_db: Path | None = None) -> dict:
    C.ensure_dirs()
    if read_db is not None:
        source, total = Path(read_db), C.question_count(Path(read_db))
    else:
        source, total = C.resolve_read_db(cfg)
    C.log(f"题库数据源：{source}（{total} 道题）")

    tree = C.load_tree(refresh=refresh_tree)
    catalog = C.flatten_tree(tree)
    conn = C.connect_ro(source)
    try:
        questions = load_questions(conn)
    finally:
        conn.close()
    scopes = _by_scope(questions)
    C.log(f"读取题目 {len(questions)} 道，知识点节点 {len(catalog)} 个")

    notes = C.iter_notes()
    note_points: dict[Path, list[str]] = {}
    extra_nodes: dict[str, dict] = {}
    for path in notes:
        meta, _body = C.read_note(path)
        ids = C.resolve_point_ids(C.note_point_values(meta), catalog)
        for pid in ids:
            if pid.startswith("custom:") and pid not in extra_nodes:
                extra_nodes[pid] = C.custom_node(pid, catalog)
        note_points[path] = ids

    nodes = dict(catalog)
    nodes.update(extra_nodes)

    counts: dict[str, int] = {}
    links: dict[str, str] = {}
    catalog_rows = []
    written = 0

    for node_id, node in nodes.items():
        selected, mode = questions_for_node(node, questions, scopes)
        # 自定义节点、以及有题目的节点才生成镜像
        if not selected and not node_id.startswith("custom:"):
            counts[node_id] = 0
            continue
        counts[node_id] = len(selected)
        target = bank_file_for(node, nodes)
        links[node_id] = C.link_of(target)
        max_index = int(cfg["sync"]["maxQuestionsPerPoint"])
        index_payload = {
            "id": node_id,
            "label": node["label"],
            "level": node["level"],
            "parent": node.get("parent"),
            "total": len(selected),
            "match": mode,
            "file": links[node_id],
            "generated": C.now_str(),
            "questions": [question_payload(q, cfg) for q in selected[:max_index]],
        }
        if not dry_run:
            C.write_json(C.POINTS_DIR / (C.safe_name(node_id) + ".json"), index_payload)
            target.parent.mkdir(parents=True, exist_ok=True)
            # 题库正文里的公式可能来自早期 AI 识别，镜像进 vault 前统一成 LaTeX
            target.write_text(
                M.normalize_math(render_bank_note(node, nodes, selected, mode, cfg))[0],
                encoding="utf-8",
            )
        catalog_rows.append({
            "id": node_id, "label": node["label"], "level": node["level"],
            "parent": node.get("parent"), "category": node.get("category"),
            "total": len(selected), "file": links[node_id],
            "index": f"_bridge/index/points/{C.safe_name(node_id)}.json",
            "match": mode,
        })
        written += 1

    payload = {
        "generated": C.now_str(),
        "source": str(source),
        "totalQuestions": len(questions),
        "nodes": sorted(catalog_rows, key=lambda r: (r["level"], r["id"])),
    }
    if not dry_run:
        C.write_json(C.INDEX / "catalog.json", payload)

    injected = 0
    for path, ids in note_points.items():
        if dry_run:
            continue
        meta, body = C.read_note(path)
        body = C.strip_bank_block(body)
        if ids:
            block = render_note_bank_block(ids, catalog, extra_nodes, counts, links)
            body = C.replace_managed(body, C.BANK_START, C.BANK_END, block)
            injected += 1
        path.write_text(C.dump_frontmatter(meta) + body.lstrip("\n"), encoding="utf-8")

    if not dry_run:
        home = C.VAULT / "首页.md"
        text = home.read_text(encoding="utf-8") if home.exists() else "# OpenExam 笔记首页\n"
        text = C.replace_managed(
            text, C.HOME_START, C.HOME_END,
            render_home_index(catalog, counts, links, source, len(questions)),
        )
        home.write_text(text, encoding="utf-8")

    summary = {
        "source": str(source), "questions": len(questions),
        "bankFiles": written, "notesWithBank": injected,
        "catalogNodes": len(catalog_rows),
    }
    C.log(f"生成题库镜像 {written} 个，注入笔记 {injected} 篇，索引节点 {len(catalog_rows)} 个")
    return summary
