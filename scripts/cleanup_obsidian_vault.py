# -*- coding: utf-8 -*-
"""清理 Obsidian 仓库里与当前科目无关的历史内容（行测题库镜像 / 示例笔记）。

默认只打印计划（dry-run）。加 --apply 才执行，且**不真正删除**：
把命中的文件整体移动到 obsidian/backups/vault-cleanup-<时间戳>/ 下，
保持相对路径，随时可以原样搬回来。

用法：
    python scripts/cleanup_obsidian_vault.py            # 只看清单
    python scripts/cleanup_obsidian_vault.py --apply    # 备份式清理
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VAULT = Path(os.environ.get("APPDATA", "")) / "studystudio" / "obsidian-vault"
BACKUPS = ROOT / "obsidian" / "backups"

# 整目录搬走：整套行测题库镜像 + 行测考点索引
PRUNE_DIRS = [
    "90-题库",
    "_bridge/index",
]

# 明确点名的示例 / 测试笔记与原件
PRUNE_FILES = [
    "10-笔记/示例笔记-工程问题.md",
    "00-收件箱/使用说明.md",
    "99-附件/原始笔记/10-笔记/应用笔记/带图片的笔记-imaget.c99dce6f.md",
    "99-附件/原始笔记/10-笔记/应用笔记/自动控制原理 · 知识清单-mw7ok2.4892c3b7.md",
    "99-附件/原始笔记/10-笔记/应用笔记/资料分析增长率易混公式整理-test-n.2d7d9fa5.md",
    "99-附件/原始笔记/10-笔记/应用笔记/资料分析增长率易混公式整理-test-n.9ec90bfe.md",
    "99-附件/原始笔记/10-笔记/示例笔记-工程问题.69ed1640.md",
    "99-附件/原始笔记/应用笔记/自动控制原理 · 知识清单-mw7ok2.md",
]

# 必须原样保留（脚本会自检，命中任何一个就整体拒绝执行）
MUST_KEEP = [
    "首页.md",
    ".obsidian/workspace.json",
    "_bridge/sync-state.json",
    "10-笔记/应用笔记/自动控制原理 · 知识清单-mw7ok2.md",
    "20-思维导图/知识地图.md",
    "20-思维导图/知识地图.canvas",
]

# 99-模板/规范笔记模板.md 是通用模板，保留；只把里面提到行测题库的段落重写
HOME_NOTE = """# StudyStudio 笔记首页

> 这里既是 Obsidian 仓库，也是 StudyStudio 的笔记出口。

## 快速开始

- 在应用「笔记」页写的东西会自动同步到 `10-笔记/应用笔记/`
- 在 Obsidian 里改过的应用笔记会自动回流到应用（按修改时间判定冲突）
- 知识地图在 `20-思维导图/`，点画布卡片可以直接跳到笔记

## 笔记格式

每篇应用笔记的 frontmatter 里带 `app_note_id`，这是双向同步的依据，不要删。
想按知识点分组，可以写 `knowledge_labels`：

```yaml
---
title: 二阶系统的阶跃响应
subject: 自动控制原理
tags: [时域分析]
knowledge_labels: [二阶系统, 阻尼比]
---
```

教材里裁出的插图会通过 `openexam-asset://` 协议在看题时显示。

"""


def rel(p: Path) -> str:
    return p.relative_to(VAULT).as_posix()


def collect() -> list[str]:
    hits: set[str] = set()
    for name in PRUNE_DIRS:
        target = VAULT / name
        if not target.is_dir():
            continue
        for path in target.rglob("*"):
            if path.is_file():
                hits.add(rel(path))
    for name in PRUNE_FILES:
        if (VAULT / name).is_file():
            hits.add(name)
    return sorted(hits)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="实际执行（备份式移动，不真删）")
    args = ap.parse_args()

    if not VAULT.is_dir():
        print(f"仓库不存在：{VAULT}")
        return 1

    missing = [name for name in MUST_KEEP if not (VAULT / name).is_file()]
    if missing:
        print("安全检查失败，以下应保留的文件不存在，已中止：")
        for name in missing:
            print("   ", name)
        return 2

    files = collect()
    total_bytes = sum((VAULT / f).stat().st_size for f in files)
    print(f"仓库：{VAULT}")
    print(f"命中 {len(files)} 个文件，共 {total_bytes / 1024:.1f} KB")
    print("\n按目录汇总：")
    grouped: dict[str, int] = {}
    for f in files:
        key = f.split("/")[0] + ("/" + f.split("/")[1] if f.count("/") > 1 else "")
        grouped[key] = grouped.get(key, 0) + 1
    for key, count in sorted(grouped.items(), key=lambda kv: -kv[1]):
        print(f"   {count:>4}  {key}")

    print("\n保留（自检通过）：")
    for name in MUST_KEEP:
        print("   ", name)

    if not args.apply:
        print("\n[dry-run] 未改动任何文件。确认后加 --apply 执行。")
        print("完整清单：scripts/obsidian_vault_cleanup_plan.json")
        (ROOT / "scripts" / "obsidian_vault_cleanup_plan.json").write_text(
            json.dumps({"vault": str(VAULT), "files": files, "keep": MUST_KEEP},
                       ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return 0

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = BACKUPS / f"vault-cleanup-{stamp}"
    backup.mkdir(parents=True, exist_ok=True)

    moved = 0
    for batch_start in range(0, len(files), 10):
        batch = files[batch_start:batch_start + 10]
        for name in batch:
            src = VAULT / name
            if not src.is_file():
                continue
            dst = backup / name
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dst))
            moved += 1
        # 每批校验：必须保留的文件仍在
        for name in MUST_KEEP:
            if not (VAULT / name).is_file():
                print(f"！！！第 {batch_start // 10 + 1} 批后发现保留文件丢失：{name}，立即停止")
                return 3

    # 首页重写：去掉行测题库相关的旧说明
    (VAULT / "首页.md").write_text(HOME_NOTE, encoding="utf-8")

    # 清空空目录（只清 PRUNE_DIRS 下面的）
    for name in PRUNE_DIRS:
        target = VAULT / name
        if target.is_dir():
            for path in sorted(target.rglob("*"), key=lambda p: len(p.parts), reverse=True):
                try:
                    if path.is_dir():
                        path.rmdir()
                except OSError:
                    pass
            try:
                target.rmdir()
            except OSError:
                pass

    print(f"\n完成：移动 {moved} 个文件到备份目录（未真正删除）")
    print(f"备份：{backup}")
    print("首页.md 已重写为当前科目的说明。")
    print("如需彻底清除，手动删除该备份目录即可；如需恢复，把里面的文件按相对路径搬回仓库。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
