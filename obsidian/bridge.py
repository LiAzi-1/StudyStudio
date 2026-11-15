# -*- coding: utf-8 -*-
"""OpenExam <-> Obsidian 桥接 CLI。

    python obsidian/bridge.py init            初始化仓库 / 注册到 Obsidian
    python obsidian/bridge.py status         查看数据源与配置
    python obsidian/bridge.py sync           生成题库镜像并嵌入笔记
    python obsidian/bridge.py format         AI 识图整理收件箱笔记
    python obsidian/bridge.py tutor          AI 助教：理解 / 规范化 / 精细分类笔记
    python obsidian/bridge.py mindmap        生成可点击跳转的思维导图
    python obsidian/bridge.py import         把笔记里的例题写进题库
    python obsidian/bridge.py unimport       撤销：删除本桥接写入的试卷与题目
    python obsidian/bridge.py all            拉取应用笔记 -> 助教整理 -> 识图 -> 同步 -> 入库 -> 思维导图
    python obsidian/bridge.py process        处理插件发来的请求（一次性）
    python obsidian/bridge.py watch          常驻：自动处理请求 + 笔记/应用笔记变动自动整理
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import oe_bank
import oe_common as C
import oe_format
import oe_import
import oe_mindmap
import oe_tutor

HOME_STUB = """# OpenExam 笔记首页

> 这里既是 Obsidian 仓库，也是 OpenExam 题库的复习入口。

## 快速开始

- 随手写的笔记 / 照片 → 丢进 [[00-收件箱/使用说明|00-收件箱]]
- 运行 `npm run obsidian:all`（或让 `obsidian:watch` 常驻）→ 自动整理、同步题库、入库例题
- 整理后的复习笔记在 `10-笔记/`，按知识点生成的题库镜像在 `90-题库/`
- 打开右侧「OpenExam 题库」侧边栏，可查看当前笔记知识点下的题目
- [[20-思维导图/知识地图|知识地图]]：AI 助教按知识点归类，点知识点跳到笔记正文

## 笔记格式

每篇笔记的 frontmatter 里写 `knowledge_points`，题库就会自动挂到笔记底部：

```yaml
---
knowledge_points: [shuliang.jisuan.gongcheng, shuliang.jisuan.lirun]
tags: [数量关系]
---
```

支持三级 ID（`模块.题型.考点`）、二级 ID（`模块.题型`）、中文考点名，甚至随手写的词。
也可以用插件命令 `Ctrl+P → 设置本笔记知识点` 来选。

## 数学公式（LaTeX）

Obsidian 内置 MathJax，**不需要装插件**：行内公式用 `$...$`，重要公式用 `$$...$$` 单独占行（前后各留一个空行）。

$$
G(s) = \\frac{Y(s)}{R(s)}
$$

中文说明与单位留在公式外面，公式里只放数学：写成「需要 $\\frac{24}{7} \\approx 3.4$ 小时」，
不要写 `24/7 ≈ 3.4`，更不要把说明吞进 `\\frac{24}{7 \\approx 3.4}`。
AI 助教 / 识图整理 / 教材知识清单都按这套格式写入，规范详见 [[99-模板/规范笔记模板|规范笔记模板]]。

## 例题入库

在笔记里写 `## 例题`，按模板填选项 / 答案 / 解析，运行 `npm run obsidian:import` 即写入应用题库。
题干、选项、解析里的公式同样用 `$...$`；「答案：」「知识点：」「难度：」等字段名保持纯文本。

<!-- openexam:index:start -->
<!-- openexam:index:end -->
"""

INBOX_GUIDE = """---
title: 收件箱使用说明
tags: [说明]
---

# 00-收件箱 · 使用说明

把**随手记的、潦草的、拍成照片的**笔记直接丢进这个文件夹即可，不用管格式。

## 支持什么

- 图片：`png / jpg / jpeg / webp / gif / bmp`
- 文字：`md / txt`
- 多张照片属于同一篇笔记时，放进**同一个子文件夹**，会被合并整理成一篇笔记

## 会发生什么

1. `npm run obsidian:format` 调用 `config.json` 里配置的视觉模型识图 / 读文字
2. 输出规范笔记到 `10-笔记/`，原件复制到 `99-附件/`（原件不会被删除或移动）
3. `npm run obsidian:sync` 按 frontmatter 的知识点把题库内嵌到笔记底部
4. `npm run obsidian:import` 把 `## 例题` 里的题目写进 OpenExam 题库

整理后的笔记里，数学公式统一用 Obsidian 内置 MathJax 的 LaTeX：行内 `$...$`、块级 `$$...$$`。
手写稿里的 `24/7 ≈ 3.4`、`x²`、`√m/k` 会被 AI 转成 `$\\frac{24}{7} \\approx 3.4$`、`$x^{2}$`、`$\\sqrt{m/k}$`。

已处理过的文件记录在 `obsidian/state.json`，重复运行不会反复生成。想强制重跑加 `--force`。
"""

TEMPLATE = """---
title: 
date: 2026-11-06
knowledge_points: [shuliang.jisuan.gongcheng]
tags: [数量关系]
summary: 
---

## 核心概念

> 用一句话说清这个知识点是什么。

> [!tip] 公式写法
> Obsidian 内置 MathJax，不需要插件。行内用 `$...$`（如 $W = v \\times t$），重要公式用 `$$...$$` 单独占行；
> 中文、单位、说明放公式外，公式里只放数学，不要用 `≈ × ÷ ²` 等 Unicode 符号。详见 [[首页#数学公式（LaTeX）]]。

## 公式 / 结论

$$
W = v \\times t
$$

其中 $W$ 为工作量，$v$ 为效率，$t$ 为时间。

| 情形 | 做法 |
| --- | --- |
| 给出各自完成时间 | 设总量为时间的最小公倍数 |
| 中途有人离开 | 分段计算已完成工作量 |

## 解题套路

1. **设总量**：取各完工时间的最小公倍数，避免分数。
2. **求效率**：$v = \\frac{W}{t}$。
3. **列方程**：按合作时间段把效率相加。

## 易错点

> [!warning] 别踩坑
> 「效率」和「时间」成反比，题目问时间时记得取倒数。

## 结论速记

- 合作时间 $t = \\frac{W}{\\sum v_i}$，单位写在公式外。

## 例题

### 例 1 · 工程问题
一个水池，甲管单独注满需 6 小时，乙管单独注满需 8 小时。两管同时开，多少小时注满？

A. 3 小时
B. 3.4 小时
C. 3.5 小时
D. 4 小时

答案：B
解析：设总量 $W = 24$，甲效率 $4$、乙效率 $3$，合开效率 $7$，故 $t = \\frac{24}{7} \\approx 3.4$ 小时。
知识点：shuliang.jisuan.gongcheng
难度：2
"""

EXAMPLE_NOTE = """---
title: 工程问题 · 效率与总量
date: 2026-11-06
knowledge_points: [shuliang.jisuan.gongcheng]
tags: [数量关系, 示例]
summary: 用「设总量为最小公倍数」把分数运算变成整数运算
原件: []
整理方式: 示例笔记
---

## 核心概念

工程问题的核心关系是 **工作量 = 效率 × 时间**，写成 LaTeX 就是 $W = v \\times t$。
当题目只给「各人单独完成所需时间」时，把总工作量设成这些时间的最小公倍数，可以让所有效率都变成整数。

$$
t = \\frac{W}{\\sum v_i}
$$

## 解题套路

1. 设总量为各完工时间的最小公倍数 $W$；
2. 分别求效率 $v_i = \\frac{W}{t_i}$；
3. 按合作 / 分段列式，最后用总量除以效率和。

> [!warning] 易错点
> 效率的倒数才是时间；「甲乙合作 3 天后甲离开」要分段算已完成量。

## 例题

### 例 1 · 双管注水
一个水池有甲、乙两个进水管，单独开甲管 6 小时可注满，单独开乙管 8 小时可注满。两管同时开，多少小时可注满？

A. 3 小时
B. 3.4 小时
C. 3.5 小时
D. 4 小时

答案：B
解析：设总量 $W = 24$，甲效率 $4$、乙效率 $3$，合开效率 $7$，故 $t = \\frac{24}{7} \\approx 3.4$ 小时。
知识点：shuliang.jisuan.gongcheng
难度：2

### 例 2 · 中途离开
一项工程甲单独做 10 天完成，乙单独做 15 天完成。两人合作 3 天后甲离开，剩下的由乙单独完成，还需要多少天？

A. 7.5 天
B. 8 天
C. 8.5 天
D. 9 天

答案：A
解析：设总量 $W = 30$，甲效率 $3$、乙效率 $2$。合作 $3$ 天完成 $15$，剩余 $15$，乙需 $t = \\frac{15}{2} = 7.5$ 天。
知识点：shuliang.jisuan.gongcheng
难度：3
"""


def register_vault() -> str:
    """把仓库登记进 Obsidian 的 vault 列表，首次启动即可直接打开。"""
    obs_dir = C._appdata() / "obsidian"
    obs_dir.mkdir(parents=True, exist_ok=True)
    target = obs_dir / "obsidian.json"
    data = {"vaults": {}}
    if target.exists():
        try:
            data = json.loads(target.read_text(encoding="utf-8")) or {"vaults": {}}
            (obs_dir / "obsidian.json.bak").write_text(
                target.read_text(encoding="utf-8"), encoding="utf-8"
            )
        except Exception as exc:
            C.warn(f"已有 obsidian.json 读取失败，将重建：{exc}")
        data.setdefault("vaults", {})
    vault_path = os.path.normpath(str(C.VAULT.resolve()))
    existing = next(
        (key for key, item in data["vaults"].items()
         if os.path.normcase(str(item.get("path", ""))) == os.path.normcase(vault_path)),
        None,
    )
    has_open = any(item.get("open") for item in data["vaults"].values())
    key = existing or C.sha(vault_path, 16)
    data["vaults"][key] = {
        "path": vault_path,
        "ts": int(time.time() * 1000),
        "open": (not has_open) or bool(existing and data["vaults"].get(key, {}).get("open")),
    }
    target.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return str(target)


def cmd_init(args, cfg: dict) -> None:
    C.ensure_dirs()
    if not C.CONFIG_PATH.exists():
        C.CONFIG_PATH.write_text(
            json.dumps(C.DEFAULT_CONFIG, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        C.log(f"已生成配置：{C.CONFIG_PATH}")
    files = {
        C.VAULT / "首页.md": HOME_STUB,
        C.INBOX / "使用说明.md": INBOX_GUIDE,
        C.TEMPLATES / "规范笔记模板.md": TEMPLATE,
        C.NOTES / "示例笔记-工程问题.md": EXAMPLE_NOTE,
    }
    for path, content in files.items():
        if not path.exists():
            path.write_text(content, encoding="utf-8")
            C.log(f"已创建 {path.relative_to(C.VAULT).as_posix()}")
    C.load_tree(refresh=True)
    where = register_vault()
    C.log(f"已把仓库登记到 Obsidian：{where}")
    C.log("初始化完成。装好 Obsidian 后直接打开本仓库即可。")


def cmd_latex(args, cfg: dict) -> None:
    """把仓库里已有笔记的公式统一成 Obsidian / MathJax 写法。

    保守迁移：只改写等价的定界符与 Unicode 运算符，不猜语义；
    90-题库（自动生成）和 99-附件/原始笔记（用户原件）一律跳过。
    幂等，重复运行不会反复改动。
    """
    import oe_math as M

    C.ensure_dirs()
    targets: set[Path] = set()
    for folder in (C.INBOX, C.NOTES, C.TEMPLATES, C.VAULT / "20-思维导图"):
        if folder.exists():
            targets.update(p for p in folder.rglob("*.md") if not p.name.startswith("."))
    home = C.VAULT / "首页.md"
    if home.exists():
        targets.add(home)
    # 可选：把内置模板 / 使用说明刷成带公式规范的最新版
    shipped = {
        C.TEMPLATES / "规范笔记模板.md": TEMPLATE,
        C.INBOX / "使用说明.md": INBOX_GUIDE,
    }
    for path, content in shipped.items():
        if path.exists() and path.read_text(encoding="utf-8") != content:
            if not args.dry_run:
                path.write_text(content, encoding="utf-8")
            verb = "将更新" if args.dry_run else "已更新"
            C.log(f"{verb}内置模板：{path.relative_to(C.VAULT).as_posix()}")

    changed = 0
    warned: list[str] = []
    for path in sorted(targets):
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError as exc:
            C.warn(f"读取失败，跳过 {path.name}：{exc}")
            continue
        # frontmatter 整段原样保留，只规范正文
        head, body = "", raw
        if raw.startswith("---"):
            marker = re.search(r"^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?", raw, re.M)
            if marker:
                head, body = raw[:marker.end()], raw[marker.end():]
        new_body, warnings = M.normalize_math(body)
        if warnings:
            M.report(warnings, path.name)
            warned.append(path.relative_to(C.VAULT).as_posix())
        if new_body != body:
            if not args.dry_run:
                path.write_text(head + new_body, encoding="utf-8")
            changed += 1
    C.log(f"公式格式迁移完成：检查 {len(targets)} 篇，改写 {changed} 篇，"
          f"需人工确认 {len(warned)} 篇{ '（dry-run，未落盘）' if args.dry_run else '' }")
    if warned:
        C.warn("以下笔记仍有可疑公式（多为中文/单位被吞进 $...$），建议在 Obsidian 里手工核对：")
        for name in warned[:20]:
            C.warn(f"  - {name}")


def cmd_status(_args, cfg: dict) -> None:
    C.ensure_dirs()
    C.log(f"项目根目录：{C.ROOT}")
    C.log(f"Obsidian 仓库：{C.VAULT}")
    print("\n题库数据源候选：")
    for path in C.db_candidates(cfg):
        count = C.question_count(path)
        mark = "  (不存在)" if count < 0 else ""
        print(f"  {count:>7} 题  {path}{mark}")
    try:
        chosen = C.resolve_read_db(cfg)[0]
    except RuntimeError:
        chosen = None
    print(f"\n当前同步将使用：{chosen or '无可用数据源'}（自动选题目最多的库）")
    print(f"例题入库将写入：{C.app_db_path(cfg)}")
    v = cfg.get("vision", {})
    key = str(v.get("apiKey") or "")
    print(f"视觉模型：{v.get('protocol')} / {v.get('model')} / {v.get('baseUrl')}")
    print(f"  apiKey：{'已配置 (' + key[:4] + '***)' if key else '未配置 —— AI 识图整理需要先填'}")
    tutor = oe_tutor.resolve_tutor(cfg)
    if tutor:
        print(f"AI 助教（文本）：{tutor['model']} / 来源：{tutor['source']}")
    else:
        print("AI 助教（文本）：未配置模型 —— 自动改用本地关键词分类")
    try:
        conn = C.connect_ro(C.app_db_path(cfg))
        note_count = conn.execute("SELECT COUNT(*) FROM notes").fetchone()[0]
        conn.close()
        print(f"应用内笔记：{note_count} 篇（写进应用后由 watch/all 自动拉取）")
    except Exception:
        pass
    mind = C.INDEX / "mindmap.json"
    if mind.exists():
        data = json.loads(mind.read_text(encoding="utf-8"))
        print(f"知识地图：{data.get('totalLinks', 0)} 条知识点关联，生成于 {data.get('generated')}")
    catalog = C.INDEX / "catalog.json"
    if catalog.exists():
        data = json.loads(catalog.read_text(encoding="utf-8"))
        print(f"题库索引：{len(data.get('nodes', []))} 个节点，生成于 {data.get('generated')}")


def _read_db_arg(args) -> Path | None:
    if getattr(args, "from_seed", False):
        return C.seed_db_path()
    if getattr(args, "read_db", None):
        return Path(args.read_db).expanduser()
    return None


def cmd_sync(args, cfg: dict) -> None:
    result = oe_bank.sync(cfg, dry_run=args.dry_run,
                          refresh_tree=args.refresh_tree,
                          read_db=_read_db_arg(args))
    C.log(json.dumps(result, ensure_ascii=False))


def cmd_format(args, cfg: dict) -> None:
    result = oe_format.format_inbox(cfg, dry_run=args.dry_run,
                                    force=args.force, strict=args.strict)
    C.log(json.dumps(result, ensure_ascii=False))


def _note_paths(args) -> list[Path] | None:
    if not getattr(args, "note", None):
        return None
    raw = Path(args.note)
    candidates = [raw] if raw.is_absolute() else [C.ROOT / raw, C.VAULT / raw]
    for candidate in candidates:
        if candidate.exists():
            return [candidate]
    raise RuntimeError(f"找不到笔记：{args.note}")


def cmd_import(args, cfg: dict) -> None:
    result = oe_import.run_import(cfg, dry_run=args.dry_run,
                                  note_paths=_note_paths(args),
                                  write_db=not args.no_db)
    C.log(json.dumps(result, ensure_ascii=False))


def cmd_unimport(args, cfg: dict) -> None:
    result = oe_import.remove_from_db(cfg, dry_run=args.dry_run)
    C.log(json.dumps(result, ensure_ascii=False))


def cmd_tutor(args, cfg: dict) -> None:
    pulled = oe_tutor.pull_app_notes(cfg, dry_run=args.dry_run, force=args.force)
    if pulled["pulled"]:
        C.log(f"拉取应用笔记 {pulled['pulled']} 篇（共 {pulled['total']} 篇）")
    result = oe_tutor.tutor_all(cfg, dry_run=args.dry_run, force=args.force,
                                note_paths=_note_paths(args))
    C.log(json.dumps({k: v for k, v in result.items() if k != "details"},
                     ensure_ascii=False))


def cmd_mindmap(args, cfg: dict) -> None:
    result = oe_mindmap.build(cfg, dry_run=args.dry_run)
    C.log(json.dumps(result, ensure_ascii=False))


def run_pipeline(args, cfg: dict, include_format: bool = True,
                 include_import: bool = True) -> dict:
    """一次完整流水线。watch / 应用内按钮 / all 共用，保证行为一致。"""
    out = {}
    out["pull"] = oe_tutor.pull_app_notes(cfg, dry_run=args.dry_run, force=args.force)
    if include_format and not args.dry_run:
        out["format"] = oe_format.format_inbox(cfg, force=args.force, strict=False)
    # 放在识图整理之后，让新生成的笔记当轮就能被 AI 助教分类
    out["tutor"] = oe_tutor.tutor_all(cfg, dry_run=args.dry_run, force=args.force)
    out["sync"] = oe_bank.sync(cfg, dry_run=args.dry_run,
                               refresh_tree=args.refresh_tree,
                               read_db=_read_db_arg(args))
    if include_import:
        out["import"] = oe_import.run_import(
            cfg, dry_run=args.dry_run, note_paths=_note_paths(args),
            write_db=not args.no_db)
    out["mindmap"] = oe_mindmap.build(cfg, dry_run=args.dry_run)
    return out


def cmd_all(args, cfg: dict) -> None:
    run_pipeline(args, cfg)
    C.log("全部完成")


def process_requests(cfg: dict, args) -> int:
    C.REQUESTS_DONE.mkdir(parents=True, exist_ok=True)
    requests = sorted(C.REQUESTS.glob("*.json"))
    handled = 0
    for request_file in requests:
        try:
            payload = json.loads(request_file.read_text(encoding="utf-8"))
        except Exception as exc:
            C.warn(f"请求文件损坏 {request_file.name}：{exc}")
            request_file.rename(C.REQUESTS_DONE / request_file.name)
            continue
        kind = str(payload.get("type") or "")
        note_rel = str(payload.get("note") or "")
        result: dict = {"type": kind, "ok": True}
        try:
            if kind == "sync":
                oe_bank.sync(cfg, read_db=_read_db_arg(args))
                result["detail"] = "题库已同步"
            elif kind == "format-inbox":
                result.update(oe_format.format_inbox(cfg, force=bool(payload.get("force"))))
                oe_bank.sync(cfg, read_db=_read_db_arg(args))
            elif kind == "format-note":
                path = (C.VAULT / note_rel).resolve()
                if not str(path).startswith(str(C.VAULT.resolve())):
                    raise RuntimeError("笔记路径越界")
                result.update(oe_format.format_existing_note(cfg, path))
                oe_bank.sync(cfg, read_db=_read_db_arg(args))
            elif kind == "tutor-note":
                path = (C.VAULT / note_rel).resolve()
                if not str(path).startswith(str(C.VAULT.resolve())):
                    raise RuntimeError("笔记路径越界")
                catalog = C.flatten_tree(C.load_tree())
                result.update(oe_tutor.tutor_note(
                    cfg, path, catalog, force=bool(payload.get("force"))))
                oe_bank.sync(cfg, read_db=_read_db_arg(args))
                oe_mindmap.build(cfg)
            elif kind == "mindmap":
                result.update(oe_mindmap.build(cfg))
            elif kind == "import-examples":
                paths = [(C.VAULT / note_rel)] if note_rel else None
                result.update(oe_import.run_import(cfg, note_paths=paths, write_db=not args.no_db))
            elif kind == "refresh":
                result.update(run_pipeline(args, cfg))
            else:
                raise RuntimeError(f"未知请求类型：{kind}")
            C.log(f"处理插件请求 {request_file.name} -> {kind} 成功")
        except Exception as exc:
            result = {"type": kind, "ok": False, "error": str(exc)}
            C.warn(f"处理插件请求 {request_file.name} 失败：{exc}")
        C.write_json(C.BRIDGE / "outbox" / (request_file.stem + ".result.json"), result)
        request_file.rename(C.REQUESTS_DONE / request_file.name)
        handled += 1
    return handled


def cmd_process(args, cfg: dict) -> None:
    count = process_requests(cfg, args)
    C.log(f"处理了 {count} 个插件请求")


def _notes_mtime() -> float:
    latest = 0.0
    for path in C.iter_notes():
        latest = max(latest, path.stat().st_mtime)
    return latest


def _app_db_stamp(cfg: dict) -> float:
    db = C.app_db_path(cfg)
    try:
        return db.stat().st_mtime
    except OSError:
        return 0.0


def cmd_watch(args, cfg: dict) -> None:
    C.log(f"桥接服务已启动（每 {args.interval}s 检查一次，Ctrl+C 退出）")
    last_run = 0.0
    last_note_change = _notes_mtime()
    last_app_stamp = _app_db_stamp(cfg)
    try:
        while True:
            handled = process_requests(cfg, args)
            if handled:
                # 请求处理里已经做过同步 / 导图，避免紧接着又跑一遍流水线
                last_run = time.time()
                last_note_change = _notes_mtime()

            app_stamp = _app_db_stamp(cfg)
            current = _notes_mtime()
            app_changed = app_stamp > last_app_stamp
            note_changed = current > last_note_change
            stale = time.time() - last_run > 300
            if (app_changed or note_changed or stale) and time.time() - last_run > 20:
                if app_changed:
                    C.log("检测到应用内笔记变动，自动拉取并交给 AI 助教…")
                elif note_changed:
                    C.log("检测到笔记变动，自动整理并同步…")
                try:
                    run_pipeline(args, cfg, include_format=False, include_import=False)
                except Exception as exc:
                    C.warn(f"自动整理失败：{exc}")
                last_run = time.time()
                # 所有写操作结束后再取时间戳，避免自己写自己触发
                last_note_change = _notes_mtime()
                last_app_stamp = _app_db_stamp(cfg)
            time.sleep(args.interval)
    except KeyboardInterrupt:
        C.log("桥接服务已停止")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="OpenExam <-> Obsidian 桥接")
    parser.add_argument("--dry-run", action="store_true", help="只预览，不写文件/数据库")
    parser.add_argument("--read-db", default=None, help="只读题库源，覆盖自动探测")
    parser.add_argument("--from-seed", action="store_true", help="强制用内置种子库作为题库源")
    parser.add_argument("--refresh-tree", action="store_true", help="重新从 skillPoints.js 生成知识点树")
    parser.add_argument("--note", default=None, help="只处理指定笔记（相对仓库或绝对路径）")
    parser.add_argument("--no-db", action="store_true", help="只生成导入包，不直接写应用数据库")
    parser.add_argument("--force", action="store_true", help="忽略已处理记录，强制重新 AI 整理")
    parser.add_argument("--strict", action="store_true", help="AI 调用失败时直接报错退出")
    parser.add_argument("--interval", type=int, default=3, help="watch 轮询间隔（秒）")
    parser.add_argument("command", nargs="?", default="status",
                        choices=["init", "status", "sync", "format", "tutor",
                                 "mindmap", "import", "unimport", "all",
                                 "latex", "process", "watch"])
    return parser


def main() -> int:
    args = build_parser().parse_args()
    cfg = C.load_config()
    if getattr(args, "read_db", None):
        cfg["database"]["path"] = args.read_db
    commands = {
        "init": cmd_init, "status": cmd_status, "sync": cmd_sync,
        "format": cmd_format, "tutor": cmd_tutor, "mindmap": cmd_mindmap,
        "import": cmd_import, "unimport": cmd_unimport,
        "all": cmd_all, "latex": cmd_latex, "process": cmd_process,
        "watch": cmd_watch,
    }
    try:
        commands[args.command](args, cfg)
        return 0
    except Exception as exc:
        C.warn(f"执行失败：{exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
