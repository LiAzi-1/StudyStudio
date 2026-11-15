# -*- coding: utf-8 -*-
"""按 AI 助教的分类结果生成 Obsidian 思维导图（可点击跳转到笔记正文）。

输出三份：
  20-思维导图/知识地图.canvas   Obsidian 原生白板；叶子是 file 节点，
                                subpath 指向笔记里真正讲该考点的标题
  20-思维导图/知识地图.md        Mermaid 脑图 + 全部可点击的 wiki 链接索引
  _bridge/index/mindmap.json    插件 / 应用内读取的结构化分类数据

仅使用 Python 标准库。
"""
from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path

import oe_common as C
import oe_tutor as T

X_STEP = 400
GAP_Y = 26
SIZE = {
    0: (250, 96),   # 根
    1: (230, 70),   # 模块
    2: (230, 70),   # 题型
    3: (270, 120),  # 考点（含直达笔记链接）
    4: (360, 130),  # 笔记
}
COLORS = {0: "6", 1: "5", 2: "4", 3: "3"}
MASTERY_COLOR = {"待巩固": "1", "理解中": "3", "已掌握": "4"}


class Node:
    def __init__(self, key: str, label: str, depth: int, payload: dict | None = None):
        self.key = key
        self.label = label
        self.depth = depth
        self.payload = payload or {}
        self.children: list[Node] = []
        self.x = 0
        self.y = 0
        self.w, self.h = SIZE[depth]

    def add(self, key: str, label: str, payload: dict | None = None) -> "Node":
        for child in self.children:
            if child.key == key:
                return child
        node = Node(key, label, min(self.depth + 1, 4), payload)
        self.children.append(node)
        return node


def _safe_label(text: str) -> str:
    return re.sub(r'[\[\](){}"#<>`|]', " ", str(text or "")).replace("\n", " ").strip() or "未命名"


def _wikilink(note: str, anchor: str, text: str) -> str:
    target = note + (("#" + anchor) if anchor else "")
    return f"[[{target}|{_safe_label(text)}]]"


def collect(cfg: dict) -> tuple[Node, dict[str, dict], dict]:
    """扫描 vault 里的笔记，按知识点树聚成一棵 4 层树。"""
    catalog = C.flatten_tree(C.load_tree())
    extra: dict[str, dict] = {}
    root = Node("root", "OpenExam 知识地图", 0)
    stats: dict = defaultdict(lambda: defaultdict(int))
    leaves: list[dict] = []

    for path in sorted(C.NOTES.rglob("*.md")):
        if path.name.startswith("."):
            continue
        meta, body = C.read_note(path)
        title = str(meta.get("title") or path.stem)
        note_rel = C.link_of(path)
        raw = C.note_point_values(meta)
        point_ids = C.resolve_point_ids(raw, catalog) if raw else []
        if not point_ids:
            # 没写 frontmatter 时，用正文关键词兜底，避免笔记从地图里消失
            guess = T.local_analyze(C.strip_kp_block(body), catalog)
            point_ids = [p["id"] for p in guess["knowledge_points"][:2]]
        if not point_ids:
            point_ids = ["custom:未分类"]
        for pid in point_ids[:3]:
            node = catalog.get(pid)
            if node is None:
                node = extra.setdefault(pid, C.custom_node(pid, catalog))
            parent = catalog.get(node.get("parent") or "", {})
            grand = catalog.get(parent.get("parent") or "", {})
            l1 = grand.get("label") or "自定义知识点"
            l2 = parent.get("label") or "未归类"
            anchor = T.pick_anchor(body, node["label"], node.get("keywords") or [])
            leaf_payload = {
                "note": note_rel,
                "file": C.vault_rel(path),
                "title": title,
                "point": pid,
                "pointLabel": node["label"],
                "anchor": anchor,
                "subject": str(meta.get("subject") or l1),
                "topic": str(meta.get("topic") or l2),
                "noteType": str(meta.get("note_type") or "通用"),
                "mastery": str(meta.get("mastery") or "理解中"),
                "difficulty": meta.get("difficulty") or 3,
                "summary": str(meta.get("summary") or ""),
                "appNoteId": str(meta.get("app_note_id") or ""),
            }
            l1n = root.add("l1:" + l1, l1, {"count": 0})
            l2n = l1n.add("l2:" + l1 + "/" + l2, l2, {"count": 0})
            l3n = l2n.add("l3:" + pid, node["label"], {"point": pid, "count": 0})
            leaf_key = "n:" + note_rel + "#" + pid
            if not any(c.key == leaf_key for c in l3n.children):
                l3n.add(leaf_key, title, leaf_payload)
            leaves.append(leaf_payload)
            stats["科目"][l1] += 1
            stats["类型"][leaf_payload["noteType"]] += 1
            stats["掌握度"][leaf_payload["mastery"]] += 1
    return root, (catalog | extra), {"stats": {k: dict(v) for k, v in stats.items()},
                                      "leaves": leaves}


def layout(root: Node) -> None:
    """左→右整齐树布局：叶子顺序堆叠，父节点居中对齐子节点。"""
    cursor = [0]

    def place(node: Node) -> float:
        node.x = node.depth * X_STEP
        if not node.children:
            node.y = cursor[0]
            cursor[0] += node.h + GAP_Y
            return node.y + node.h / 2
        centers = [place(child) for child in node.children]
        center = (centers[0] + centers[-1]) / 2
        node.y = center - node.h / 2
        return center

    place(root)


def canvas_payload(root: Node, cfg: dict) -> dict:
    nodes, edges = [], []
    counter = [0]

    def emit(node: Node) -> str:
        counter[0] += 1
        nid = f"oe{counter[0]:04d}"
        payload = node.payload
        if node.depth == 4 and payload.get("file"):
            item = {
                "id": nid, "type": "file", "file": payload["file"],
                "x": int(node.x), "y": int(node.y),
                "width": node.w, "height": node.h,
                "color": MASTERY_COLOR.get(payload.get("mastery"), "3"),
            }
            if payload.get("anchor"):
                item["subpath"] = "#" + payload["anchor"]
            nodes.append(item)
        else:
            count = len(node.children)
            label = _safe_label(node.label)
            caption = f"**{label}**"
            if node.depth == 0:
                caption += f"\n\n{len(_all_leaves(root))} 条知识点关联 · {C.today()}"
            elif count:
                caption += f"\n{count} 个下级"
            if node.depth == 3:
                caption += f"\n`{payload.get('point', node.key)}`"
                # 知识点节点里也放一条直达链接，Ctrl/⌘+点击即可跳进笔记正文
                first = node.children[0].payload if node.children else {}
                if first.get("note"):
                    anchor = first.get("anchor") or "知识点定位"
                    caption += (f"\n[[{first['note']}#{anchor}|"
                                f"进入「{_safe_label(first.get('title', '笔记'))}」]]")
            nodes.append({
                "id": nid, "type": "text", "text": caption,
                "x": int(node.x), "y": int(node.y),
                "width": node.w, "height": node.h,
                "color": COLORS.get(node.depth),
            })
        for child in node.children:
            cid = emit(child)
            edges.append({
                "id": f"edge-{nid}-{cid}", "fromNode": nid, "fromSide": "right",
                "toNode": cid, "toSide": "left", "toEnd": "arrow",
            })
        return nid

    emit(root)
    return {"nodes": nodes, "edges": edges}


def _all_leaves(root: Node) -> list[Node]:
    result = []
    for child in root.children:
        result.extend(_all_leaves(child))
    return result if root.children else [root]


def mermaid_tree(root: Node) -> str:
    lines = ["mindmap", "  root((OpenExam 知识地图))"]
    serial = [0]

    def walk(node: Node, indent: int) -> None:
        for child in node.children:
            serial[0] += 1
            nid = f"n{serial[0]}"
            label = _safe_label(child.label)
            if child.depth == 1:
                shape = nid + "{{" + label + "}}"
            elif child.depth == 2:
                shape = nid + "(" + label + ")"
            elif child.depth == 3:
                shape = nid + "[" + label + "]"
            else:
                shape = nid + '["' + label + '"]'
            lines.append(" " * indent + shape)
            walk(child, indent + 2)

    walk(root, 4)
    return "\n".join(lines)


def render_markdown(root: Node, meta: dict, cfg: dict) -> str:
    canvas_rel = str(cfg.get("mindmap", {}).get("canvasPath") or
                     "20-思维导图/知识地图.canvas")
    canvas_link = canvas_rel[:-3] if canvas_rel.endswith(".md") else canvas_rel
    lines = [
        "# OpenExam 知识地图",
        "",
        f"> 由 AI 助教按知识点自动归类，更新于 {C.now_str()}。",
        f"> **画布版**：[[{canvas_link}|打开可点击的思维导图]] —— 双击卡片直接跳到笔记正文对应小节。",
        "> 下方「可点击索引」里的每条链接都是单击即跳。",
        "",
        "```mermaid",
        mermaid_tree(root),
        "```",
        "",
        "## 知识点入口（点知识点名直达笔记正文）",
        "",
    ]

    def point_entries(node: Node, trail: list[str]) -> None:
        if node.depth == 3:
            named = " / ".join(trail + [node.label])
            children = node.children
            first = children[0].payload if children else {}
            anchor = first.get("anchor") or "知识点定位"
            jump = (_wikilink(first.get("note", ""), anchor, f"跳到「{anchor}」")
                    if first.get("note") else "暂无关联笔记")
            lines.append(f"- **{named}**（{len(children)} 篇）→ {jump}")
        for child in node.children:
            if child.depth < 4:
                point_entries(child, trail + ([node.label] if node.depth > 0 else []))

    point_entries(root, [])
    lines += ["", "## 可点击索引", ""]


    def walk(node: Node, trail: list[str]) -> None:
        if node.depth == 3:
            lines.append(f"### {' / '.join(trail + [node.label])}")
            lines.append("")
            for child in node.children:
                p = child.payload
                anchor = p.get("anchor") or "知识点定位"
                link = _wikilink(p.get("note", ""), anchor,
                                 f"📄 {p.get('title', '')} → {anchor}")
                lines.append(
                    f"- {link} · {p.get('noteType', '通用')} · "
                    f"难度 {p.get('difficulty', 3)} · **{p.get('mastery', '理解中')}**"
                    + (f" — {C.truncate(p.get('summary', ''), 60)}" if p.get("summary") else "")
                )
            lines.append("")
        for child in node.children:
            if child.depth < 4:
                walk(child, trail + ([node.label] if node.depth > 0 else []))

    walk(root, [])
    lines += ["", "## 分类统计", ""]
    for axis, values in (meta.get("stats") or {}).items():
        rows = "、".join(f"{k} {v}" for k, v in sorted(values.items(), key=lambda kv: -kv[1]))
        lines.append(f"- **{axis}**：{rows or '暂无'}")
    lines += [
        "",
        "---",
        "",
        "> 重新生成：`npm run obsidian:mindmap`；想让 AI 重新分类：`npm run obsidian:tutor -- --force`。",
        "",
    ]
    return "\n".join(lines)


def index_payload(root: Node, meta: dict) -> dict:
    def walk(node: Node) -> dict:
        return {
            "key": node.key, "label": node.label, "depth": node.depth,
            "payload": node.payload,
            "children": [walk(c) for c in node.children],
        }
    return {
        "generated": C.now_str(),
        "totalLinks": len(meta.get("leaves", [])),
        "stats": meta.get("stats", {}),
        "leaves": meta.get("leaves", []),
        "tree": walk(root),
    }


def inject_note_links(cfg: dict) -> int:
    """每篇笔记底部放一条回知识地图的链接（幂等托管区块）。"""
    count = 0
    for path in sorted(C.NOTES.rglob("*.md")):
        if path.name.startswith("."):
            continue
        meta, body = C.read_note(path)
        if not meta.get("knowledge_points"):
            continue
        block = ("> 🗺 本篇已收录进 [[20-思维导图/知识地图|知识地图]]"
                 "，也可打开 [[20-思维导图/知识地图.canvas|画布版思维导图]]。")
        updated = C.replace_managed(body, C.MAP_START, C.MAP_END, block)
        if updated != body:
            path.write_text(C.dump_frontmatter(meta) + updated.lstrip("\n"), encoding="utf-8")
            count += 1
    return count


def inject_home_link() -> None:
    home = C.VAULT / "首页.md"
    text = home.read_text(encoding="utf-8") if home.exists() else "# OpenExam 笔记首页\n"
    block = ("## 🗺 知识地图\n\n"
             "- [[20-思维导图/知识地图|按知识点浏览全部笔记（可点击跳转）]]\n"
             "- [[20-思维导图/知识地图.canvas|画布版思维导图]]\n")
    text = C.replace_managed(text, C.MAP_START, C.MAP_END, block)
    home.write_text(text, encoding="utf-8")


def build(cfg: dict, dry_run: bool = False) -> dict:
    C.ensure_dirs()
    root, _catalog, meta = collect(cfg)
    layout(root)
    canvas_rel = str(cfg.get("mindmap", {}).get("canvasPath") or "20-思维导图/知识地图.canvas")
    note_rel = str(cfg.get("mindmap", {}).get("notePath") or "20-思维导图/知识地图.md")
    canvas_path, note_path = C.VAULT / canvas_rel, C.VAULT / note_rel
    payload = canvas_payload(root, cfg)
    markdown = render_markdown(root, meta, cfg)
    index = index_payload(root, meta)
    total_links = len(meta.get("leaves", []))
    C.log(f"知识地图：{total_links} 条知识点关联，{len(payload['nodes'])} 个节点")
    if dry_run:
        return {"nodes": len(payload["nodes"]), "links": len(meta["leaves"])}
    canvas_path.parent.mkdir(parents=True, exist_ok=True)
    canvas_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    note_path.parent.mkdir(parents=True, exist_ok=True)
    note_path.write_text(markdown, encoding="utf-8")
    C.write_json(C.INDEX / "mindmap.json", index)
    linked = inject_note_links(cfg)
    inject_home_link()
    return {
        "canvas": C.vault_rel(canvas_path), "note": C.vault_rel(note_path),
        "nodes": len(payload["nodes"]), "edges": len(payload["edges"]),
        "links": len(meta["leaves"]), "noteLinksInjected": linked,
    }
