# -*- coding: utf-8 -*-
"""笔记例题 -> OpenExam 题库。

解析笔记里的「## 例题」区块，生成标准导入包 outbox/paper.json，
并可选地直接写入应用数据库（写入前自动备份、按笔记幂等去重）。
"""
from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path

import oe_common as C
import oe_math as M

EXAMPLE_HEADING = re.compile(r"^#{2,3}\s*(?:例题|例子|题目|习题|Examples?|Exercises?)\s*$", re.I | re.M)
BLOCK_SPLIT = re.compile(r"^(?:#{3,4}\s+|\*\*例\s*\d*.*?\*\*\s*$)", re.M)
OPTION_LINE = re.compile(r"^\s*([A-H])[\.、\)．:：]\s*(.+?)\s*$")
FIELD_LINE = re.compile(r"^\s*(答案|参考答案|解析|分析|知识点|考点|难度|题型|来源)\s*[:：]\s*(.*)$")
CONTENT_STOP = re.compile(r"^#{1,3}\s+", re.M)


def _example_section(body: str) -> str:
    match = EXAMPLE_HEADING.search(body)
    if not match:
        return ""
    start = match.end()
    following = re.search(r"^##\s+", body[start:], re.M)
    end = start + following.start() if following else len(body)
    return body[start:end].strip()


def _split_blocks(section: str) -> list[str]:
    matches = list(BLOCK_SPLIT.finditer(section))
    if not matches:
        return [section] if section.strip() else []
    blocks = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(section)
        chunk = section[match.start():end].strip()
        # 去掉分隔标题本身
        chunk = re.sub(r"^#{3,4}\s+[^\n]*\n", "", chunk, count=1).strip()
        if chunk:
            blocks.append(chunk)
    return blocks


def parse_example(block: str) -> dict | None:
    lines = block.splitlines()
    options: list[dict] = []
    fields: dict[str, str] = {}
    content_lines: list[str] = []
    phase = "content"
    current_field = None

    for raw in lines:
        line = raw.rstrip()
        if not line.strip():
            if phase == "analysis":
                fields["analysis"] = fields.get("analysis", "") + "\n"
            continue

        field = FIELD_LINE.match(line)
        if field:
            key = field.group(1)
            current_field = key
            fields[key] = field.group(2).strip()
            phase = "field"
            continue

        option = OPTION_LINE.match(line)
        if option and phase in ("content", "options"):
            phase = "options"
            options.append({"key": option.group(1).upper(), "content": option.group(2)})
            continue

        if phase == "field":
            # 解析等字段的续行
            fields[current_field] = (fields.get(current_field, "") + "\n" + line.strip()).strip()
        elif phase == "content":
            if line.startswith(("<!--", ">")) and line.startswith("<!-- openexam"):
                continue
            content_lines.append(line.strip())

    content = "\n".join(content_lines).strip()
    content = re.sub(r"^\*\*例\s*\d+.*?\*\*\s*", "", content).strip()
    if not content or len(content) < 6:
        return None

    answer_raw = (fields.get("答案") or fields.get("参考答案") or "").strip()
    # 客观题答案仍是纯字母 / 对错；但笔记现在允许用 LaTeX 写填空、主观题答案，
    # 若继续按字母过滤，$\frac{24}{7}$ 会被削成 "AC" 这种错误答案。
    if re.search(r"\$|\\\(|\\\[|\\frac|\\sqrt|\^|_", answer_raw):
        answer = M.normalize_math(answer_raw)[0].strip()
    else:
        answer = re.sub(r"[^A-H对错√×正确错误]", "", answer_raw.upper())
        answer = answer.replace("正确", "对").replace("错误", "错")
    analysis = (fields.get("解析") or fields.get("分析") or "").strip()
    points = (fields.get("知识点") or fields.get("考点") or "").strip()
    difficulty_raw = re.sub(r"[^0-9]", "", fields.get("难度") or "")
    difficulty = int(difficulty_raw) if difficulty_raw else 2
    difficulty = max(1, min(5, difficulty))

    if options:
        qtype = "multiple" if len(set(answer)) > 1 and re.fullmatch(r"[A-H]+", answer or "") else "single"
    elif re.fullmatch(r"[A-H]+", answer or ""):
        qtype = "single"
    elif answer in ("对", "错", "√", "×"):
        qtype = "judge"
    else:
        qtype = "subjective"

    # 笔记里的公式统一成 LaTeX 后再入库，保证题库镜像回 Obsidian 时能直接渲染
    content = M.normalize_math(content)[0]
    options = [{"key": o["key"], "content": M.normalize_math(o["content"])[0]} for o in options]
    analysis = M.normalize_math(analysis)[0]

    return {
        "content": content,
        "options": options,
        "answer": answer,
        "analysis": analysis,
        "type": qtype,
        "pointsRaw": points,
        "difficulty": difficulty,
    }


def extract_examples(body: str) -> list[dict]:
    section = _example_section(body)
    if not section:
        return []
    section = re.sub(r"<!-- openexam:bank:.*?-->", "", section, flags=re.S)
    examples = []
    for block in _split_blocks(section):
        parsed = parse_example(block)
        if parsed and parsed["answer"]:
            examples.append(parsed)
    return examples


def _category_for(example: dict, note_points: list[str], catalog: dict, cfg: dict) -> tuple[str, str, str]:
    ids = C.resolve_point_ids(example["pointsRaw"], catalog) if example["pointsRaw"] else []
    ids = ids or note_points
    for pid in ids:
        node = catalog.get(pid)
        if node and node.get("category"):
            sub = node.get("sub") or cfg["import"]["defaultSubCategory"]
            return node["category"], sub, node["label"]
    return (
        cfg["import"]["defaultCategory"],
        cfg["import"]["defaultSubCategory"],
        example["pointsRaw"] or "未分类",
    )


def build_questions(path: Path, meta: dict, body: str,
                    catalog: dict, cfg: dict) -> list[dict]:
    note_points = C.resolve_point_ids(C.note_point_values(meta), catalog)
    note_label = str(meta.get("title") or path.stem)
    result = []
    for index, example in enumerate(extract_examples(body), 1):
        category, sub_category, point_label = _category_for(example, note_points, catalog, cfg)
        result.append({
            "type": example["type"],
            "category": category,
            "subCategory": sub_category,
            "content": example["content"],
            "options": example["options"],
            "answer": example["answer"],
            "analysis": example["analysis"],
            "difficulty": example["difficulty"],
            "tags": ["obsidian", note_label, point_label],
            "orderNum": index,
            "sourceNote": path.relative_to(C.VAULT).as_posix(),
        })
    return result


# v0.2.2 起启动清理只按内置题库 ID 精确删除，并显式跳过 type='imported'，
# 笔记标题不再需要规避「公务员 / 行测 / 国考」等词，保留用户原始标题。
def _safe_paper_title(raw: str) -> str:
    title = "Obsidian 笔记例题 · " + str(raw or "").strip()
    return title[:120] or "Obsidian 笔记例题"


def _paper_meta(path: Path, meta: dict, count: int) -> dict:
    return {
        "title": _safe_paper_title(str(meta.get("title") or path.stem)),
        "year": int(C.today()[:4]),
        # type='imported' 会被启动清理显式排除，不会随内置题库一起被删
        "type": "imported",
        "subject": "obsidian",
        "duration": max(20, count * 2),
        "difficulty": 3,
    }


def export_paper_json(groups: list[dict], cfg: dict) -> Path:
    questions = []
    order = 0
    for group in groups:
        for q in group["questions"]:
            order += 1
            questions.append({
                "id": f"q_obs_{C.sha(q['content'] + q['answer'], 14)}",
                "orderNum": order,
                "content": q["content"],
                "options": [{"key": o["key"], "text": o["content"]} for o in q["options"]],
                "answer": q["answer"],
                "category": q["category"],
                "subCategory": q["subCategory"],
                "analysis": q["analysis"],
                "difficulty": q["difficulty"],
            })
    payload = {
        "schemaVersion": 1,
        "paper": {
            "id": "paper_obsidian_notes",
            "title": f"Obsidian 笔记例题合集 · {C.today()}",
            "examKind": "gongwuyuan",
            "examLevel": "national",
            "subject": "obsidian",
            "year": int(C.today()[:4]),
            "source": "imported",
        },
        "questions": questions,
    }
    target = C.OUTBOX / "paper.json"
    C.write_json(target, payload)
    return target


def write_to_db(groups: list[dict], cfg: dict, dry_run: bool = False) -> dict:
    db_path = C.app_db_path(cfg)
    if not db_path.exists():
        raise RuntimeError(f"应用数据库不存在：{db_path}（请先启动一次 OpenExam）")
    if dry_run:
        return {"written": 0, "backup": None, "db": str(db_path)}

    backup = C.backup_db(db_path)
    C.log(f"已备份应用数据库：{backup}")
    conn = C.connect_rw(db_path)
    written = 0
    try:
        q_cols = {row[1] for row in conn.execute("PRAGMA table_info(questions)")}
        base_fields = [
            "id", "paper_id", "order_num", "type", "category", "sub_category",
            "content", "content_html", "options", "answer", "analysis",
            "difficulty", "tags", "created_at", "answer_source", "answer_status",
        ]
        sql_constants = {
            "created_at": "datetime('now')",
            "answer_source": "'obsidian_note'",
            "answer_status": "'unverified'",
        }
        fields = [f for f in base_fields if f in q_cols]
        bind_fields = [f for f in fields if f not in sql_constants]
        placeholders = [sql_constants.get(f, "?") for f in fields]
        insert_q = (
            f"INSERT OR REPLACE INTO questions ({', '.join(fields)}) "
            f"VALUES ({', '.join(placeholders)})"
        )

        insert_paper = """
            INSERT INTO papers (id,title,year,type,subject,province,question_count,duration,difficulty,created_at)
            VALUES (?,?,?,?,?,NULL,?,?,?,datetime('now'))
            ON CONFLICT(id) DO UPDATE SET
              title=excluded.title, question_count=excluded.question_count,
              duration=excluded.duration, created_at=datetime('now')
        """

        conn.execute("BEGIN")
        for group in groups:
            path: Path = group["path"]
            meta: dict = group["meta"]
            questions = group["questions"]
            if not questions:
                continue
            note_rel = path.relative_to(C.VAULT).as_posix()
            paper_id = "paper_obsidian_" + C.sha(note_rel)
            pm = _paper_meta(path, meta, len(questions))
            conn.execute(insert_paper, (
                paper_id, pm["title"], pm["year"], pm["type"], pm["subject"],
                len(questions), pm["duration"], pm["difficulty"],
            ))
            conn.execute("DELETE FROM questions WHERE paper_id = ?", (paper_id,))
            for q in questions:
                qid = "q_obsidian_" + C.sha(note_rel + q["content"] + q["answer"], 16)
                values = {
                    "id": qid,
                    "paper_id": paper_id,
                    "order_num": q["orderNum"],
                    "type": q["type"],
                    "category": q["category"],
                    "sub_category": q["subCategory"],
                    "content": q["content"],
                    "content_html": None,
                    "options": json.dumps(q["options"], ensure_ascii=False),
                    "answer": q["answer"],
                    "analysis": q["analysis"],
                    "difficulty": q["difficulty"],
                    "tags": ",".join(t for t in q["tags"] if t),
                }
                conn.execute(insert_q, [values[f] for f in bind_fields])
                written += 1
            conn.execute("UPDATE papers SET question_count = ? WHERE id = ?", (len(questions), paper_id))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return {"written": written, "backup": str(backup) if backup else None, "db": str(db_path)}


def remove_from_db(cfg: dict, dry_run: bool = False) -> dict:
    """撤销：删掉由本桥接写入的试卷与题目（应用 UI 目前不提供删除 imported 卷）。"""
    db_path = C.app_db_path(cfg)
    if not db_path.exists():
        raise RuntimeError(f"应用数据库不存在：{db_path}")
    conn = C.connect_ro(db_path)
    paper_ids = [row[0] for row in conn.execute(
        "SELECT id FROM papers WHERE id LIKE 'paper_obsidian_%'"
    )]
    question_count = 0
    if paper_ids:
        marks = ",".join("?" for _ in paper_ids)
        question_count = conn.execute(
            f"SELECT COUNT(*) FROM questions WHERE paper_id IN ({marks})", paper_ids
        ).fetchone()[0]
    conn.close()
    if dry_run:
        return {"papers": len(paper_ids), "questions": question_count}
    if not paper_ids:
        return {"papers": 0, "questions": 0}

    backup = C.backup_db(db_path)
    conn = C.connect_rw(db_path)
    try:
        marks = ",".join("?" for _ in paper_ids)
        conn.execute("BEGIN")
        conn.execute(f"DELETE FROM wrong_questions WHERE paper_id IN ({marks})", paper_ids)
        conn.execute(f"DELETE FROM questions WHERE paper_id IN ({marks})", paper_ids)
        conn.execute(f"DELETE FROM papers WHERE id IN ({marks})", paper_ids)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    state = C.load_state()
    state["imported"] = {}
    C.save_state(state)
    return {"papers": len(paper_ids), "questions": question_count,
            "backup": str(backup) if backup else None}


def run_import(cfg: dict, dry_run: bool = False, note_paths: list[Path] | None = None,
               write_db: bool = True) -> dict:
    C.ensure_dirs()
    catalog = C.flatten_tree(C.load_tree())
    notes = note_paths or C.iter_notes()
    groups = []
    for path in notes:
        meta, body = C.read_note(path)
        questions = build_questions(path, meta, body, catalog, cfg)
        if questions:
            groups.append({"path": path, "meta": meta, "questions": questions})
            C.log(f"  {path.name}：解析到 {len(questions)} 道例题")

    total = sum(len(g["questions"]) for g in groups)
    export = export_paper_json(groups, cfg) if not dry_run else None
    result = {"notes": len(groups), "questions": total, "paperJson": str(export) if export else None}
    if not groups:
        C.log("没有在笔记里找到可导入的例题")
        return result

    if write_db:
        result["db"] = write_to_db(groups, cfg, dry_run=dry_run)
        if dry_run:
            C.log(f"[dry-run] 将把 {total} 道例题写入 {result['db']['db']}（含自动备份）")
        else:
            C.log(f"写入题库 {result['db']['written']} 道（目标 {result['db']['db']}）")
    else:
        C.log(f"已生成导入包：{export}，可在 OpenExam「导入试卷」里手动导入")

    if not dry_run:
        state = C.load_state()
        for group in groups:
            rel = group["path"].relative_to(C.VAULT).as_posix()
            state.setdefault("imported", {})[rel] = {
                "count": len(group["questions"]), "at": C.now_str(),
            }
        C.save_state(state)
    return result
