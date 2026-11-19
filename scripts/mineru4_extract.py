#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
MinerU 4.x -> 2.x 兼容 content_list.json 提取器。

背景：
  项目 src/main/textbookMineru.js 的 collectOutput() 期望 MinerU 2.x 的产物：
    outDir/content_list.json  （数组，元素含 page_idx/type/text/table_body/img_path/bbox/img_caption）
  但本机装的是 MinerU 4.2.1（"文档中心"架构），没有 -p/-o/-b/-d，也不产出 content_list.json，
  解析结果存进 doclib：MINERU_HOME/doclib/parsed/<sha[:2]>/<sha>/flash/<a-b>_<ts>.json
  该 JSON 是 docvortex.middle 2.0：{schema, schema_version, metadata, pages:[{page_idx, blocks:[...]}], extensions}

本脚本做三件事：
  1) 触发/等待 MinerU 4.x 解析（调用 `mineru parse <pdf> --tier flash --pages all --wait N`）
  2) 从 doclib 读取该 PDF（按 sha256 定位）最新的 flash 解析 JSON
  3) 转成 2.x 兼容 content_list.json，写到 --out-dir（供 collectOutput 直接消费）

用法：
  python mineru4_extract.py <pdf> --out-dir <dir> [--tier flash] [--pages all] [--wait 5400]
  python mineru4_extract.py --from-json <flash.json> --out-dir <dir>   # 只转换，不解析（测试用）

输出（stdout，供 Node 侧解析进度）：
  PROGRESS:<percent>:<detail>
  RESULT:<json>   （含 pages / blocks / content_list 路径）
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------

def log(msg: str) -> None:
    print(f"[mineru4] {msg}", flush=True)


def hidden_process_kwargs() -> dict:
    """Windows：让 mineru.exe 不弹控制台窗口（父进程本身无控制台）。"""
    if os.name != "nt":
        return {}
    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startupinfo.wShowWindow = subprocess.SW_HIDE
    return {
        "creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0),
        "startupinfo": startupinfo,
    }


def progress(percent: int, detail: str) -> None:
    percent = max(0, min(100, int(percent)))
    print(f"PROGRESS:{percent}:{detail}", flush=True)


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def find_mineru_exe() -> str:
    """定位 mineru 可执行文件：环境变量 → 当前解释器同目录 → 旧 D 盘环境 → PATH。"""
    cands = []
    if os.environ.get("OPENEXAM_MINERU"):
        cands.append(os.environ["OPENEXAM_MINERU"])
    exe_dir = Path(sys.executable).parent
    cands.append(str(exe_dir / ("mineru.exe" if os.name == "nt" else "mineru")))
    if os.name == "nt":
        cands.append(str(Path("D:/mineru-venv/Scripts/mineru.exe")))
    cands.append("mineru")
    for c in cands:
        if c == "mineru":
            return c
        if Path(c).is_file():
            return c
    return "mineru"


def mineru_home() -> Path:
    home = os.environ.get("MINERU_HOME")
    if home:
        return Path(home)
    return Path.home() / ".mineru"


# ---------------------------------------------------------------------------
# 1) 触发/等待解析
# ---------------------------------------------------------------------------

def run_parse(pdf: Path, tier: str, pages: str, wait: int, log_path: Path, *, emit_progress: bool = True) -> int:
    """调用 mineru parse 触发并等待一批解析。stdout/stderr 落日志，避免整本 markdown 灌爆管道。
    返回退出码（不在此处因非零而抛错——是否完成由调用方按页覆盖率判定）。
    """
    exe = find_mineru_exe()
    # --limit 拉大：避免 CLI 按 30000 字符截断输出、给出续读提示并可能返回非零退出码
    cmd = [exe, "parse", str(pdf), "--tier", tier, "--pages", pages,
           "--wait", str(wait), "--limit", "200000000"]
    env = dict(os.environ)
    env.setdefault("MINERU_MODEL_SOURCE", "modelscope")
    # 模型缓存与临时目录由 Node 侧通过环境变量注入（应用数据目录或复用的旧环境），不再写死盘符
    if not env.get("MODELSCOPE_CACHE") and env.get("MINERU_HOME"):
        env["MODELSCOPE_CACHE"] = str(Path(env["MINERU_HOME"]) / "modelscope")
    if not env.get("HF_HOME") and env.get("MINERU_HOME"):
        env["HF_HOME"] = str(Path(env["MINERU_HOME"]) / "hf")
    tmp_dir = env.get("TMPDIR") or env.get("TEMP") or env.get("TMP") or str(Path(env.get("MINERU_HOME", ".")) / "tmp")
    Path(tmp_dir).mkdir(parents=True, exist_ok=True)
    env["TMPDIR"] = tmp_dir
    env["TMP"] = tmp_dir
    env["TEMP"] = tmp_dir

    log(f"触发解析: {' '.join(cmd)}")
    if emit_progress:
        progress(8, "启动 MinerU 解析")
    with open(log_path, "ab") as logf:
        proc = subprocess.Popen(cmd, stdout=logf, stderr=subprocess.STDOUT, env=env, **hidden_process_kwargs())
        start = time.time()
        while proc.poll() is None:
            time.sleep(3)
            if emit_progress:
                elapsed = int(time.time() - start)
                progress(min(60, 10 + elapsed // 6), f"解析中（{elapsed}s）")
        code = proc.returncode
    if code != 0:
        log(f"mineru parse 退出码 {code}（将按实际解析覆盖率判定是否完成）")
    return code


def probe_page_count(pdf: Path) -> int:
    """探测 PDF 总页数：优先 pypdf（轻量、零解析），回退到 doclib 的 flash metadata。"""
    try:
        from pypdf import PdfReader
        return int(len(PdfReader(str(pdf)).pages))
    except Exception as exc:  # noqa: BLE001
        log(f"pypdf 探测页数失败：{exc}")
    try:
        sha = sha256_of(pdf)
        pages, count = load_flash_pages(sha, "all", "flash")
        if count:
            return int(count)
        return len(pages)
    except Exception as exc:  # noqa: BLE001
        log(f"doclib 探测页数失败：{exc}")
    return 0


# ---------------------------------------------------------------------------
# 2) 读取 flash 解析 JSON
# ---------------------------------------------------------------------------

def parse_page_set(pages: str) -> set[int] | None:
    """把 'all' / '1-5,8' 解析成 1 基页码集合；'all' 返回 None（表示不过滤）。"""
    s = str(pages or "").strip().lower()
    if s in ("", "all"):
        return None
    result: set[int] = set()
    for part in s.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            try:
                a, b = part.split("-", 1)
                a, b = int(a), int(b)
                if a > b:
                    a, b = b, a
                result.update(range(a, b + 1))
            except ValueError:
                continue
        elif part.isdigit():
            result.add(int(part))
    return result or None


def load_flash_pages(sha: str, pages: str, tier: str = "flash") -> tuple[list[dict], int | None]:
    """合并 doclib 下该 PDF 指定档位的全部分段 JSON，按 page_idx 去重（新文件覆盖旧文件）。

    4.x 会把一次解析按批次拆成多个 <a-b>_<ts>.json（如 1-10 / 11-12 / 13-420），
    单取一个文件会漏页，必须合并。
    返回 (merged_pages, page_count)。
    """
    base = mineru_home() / "doclib" / "parsed" / sha[:2] / sha / tier
    if not base.is_dir():
        raise FileNotFoundError(f"未找到 flash 解析目录：{base}")
    files = sorted(base.glob("*.json"), key=lambda p: p.stat().st_mtime)  # 旧的在前，新的覆盖
    if not files:
        raise FileNotFoundError(f"flash 目录下没有 JSON：{base}")

    by_idx: dict[int, dict] = {}
    page_count: int | None = None
    for p in files:
        try:
            with open(p, "r", encoding="utf-8") as f:
                d = json.load(f)
        except Exception as exc:  # noqa: BLE001
            log(f"跳过无法读取的 {p.name}: {exc}")
            continue
        md = (d.get("metadata") or {}).get("document") or {}
        if page_count is None and isinstance(md.get("page_count"), int):
            page_count = md["page_count"]
        for pg in d.get("pages") or []:
            idx = pg.get("page_idx")
            if isinstance(idx, int):
                by_idx[idx] = pg

    if not by_idx:
        raise FileNotFoundError(f"flash 目录下没有任何可读页：{base}")

    want = parse_page_set(pages)
    merged = [by_idx[i] for i in sorted(by_idx) if (want is None or (i + 1) in want)]
    return merged, page_count


# ---------------------------------------------------------------------------
# 3) 转换：docvortex.middle -> 2.x content_list
# ---------------------------------------------------------------------------

# 4.x 的块类型 -> 处理策略
SKIP_TYPES = {"header", "footer", "index", "page_number", "aside_text"}
TITLE_TYPES = {"doc_title", "paragraph_title", "title"}
TEXT_TYPES = {"text", "abstract", "list", "ref_text"}


def _extract_text(node) -> str:
    """递归提取 4.x content 里的纯文本（content 可能是 str / list / 嵌套 dict）。"""
    if isinstance(node, str):
        return node
    if isinstance(node, list):
        return "".join(_extract_text(x) for x in node)
    if isinstance(node, dict):
        return _extract_text(node.get("content"))
    return ""


def block_text(block: dict) -> str:
    """从 4.x block.content（[{type, content}]）里拼出纯文本。"""
    text = _extract_text(block.get("content"))
    # 去掉多余空白行，保留段内换行
    lines = [ln.strip() for ln in text.split("\n")]
    return "\n".join(ln for ln in lines if ln).strip()


def block_table_body(block: dict) -> str:
    """表格块：取 table_body 的 content（多行文本，可直接当 markdown）。"""
    content = block.get("content")
    if isinstance(content, list):
        for item in content:
            if isinstance(item, dict) and item.get("type") in ("table_body", "table"):
                t = _extract_text(item.get("content"))
                if t.strip():
                    return t.strip()
    # 兜底
    return block_text(block)


def norm_bbox(bbox) -> list | None:
    if isinstance(bbox, list) and len(bbox) == 4:
        try:
            return [round(float(v), 4) for v in bbox]
        except (TypeError, ValueError):
            return None
    return None


# ---------------------------------------------------------------------------
# 插图裁切：MinerU 4.x 的 doclib JSON 只有 0~1 归一化 bbox，没有图片字节。
# 这里用 pypdfium2 按 bbox 渲染并裁出 JPEG，产物与 MinerU 2.x 的 images/ 对齐。
# 选型理由：basic 档 JSON 已带 bbox、venv 已装 pypdfium2，无需重跑 OCR、
# 不新增依赖，也不需要改档位或引 pdf.js 在渲染层裁图。
# ---------------------------------------------------------------------------

_PDF_DOCS: dict = {}
_PAGE_CACHE: dict = {"key": None, "image": None}


def _render_page(pdf_path: Path, page_idx: int, scale: float = 2.0):
    """渲染一页为 PIL Image（同一个页面的多个图块复用同一张位图）。"""
    key = (str(pdf_path), int(page_idx), scale)
    if _PAGE_CACHE.get("key") == key:
        return _PAGE_CACHE.get("image")
    import pypdfium2 as pdfium  # 延迟导入：--from-json / 无图模式不需要

    doc = _PDF_DOCS.get(str(pdf_path))
    if doc is None:
        doc = pdfium.PdfDocument(str(pdf_path))
        _PDF_DOCS[str(pdf_path)] = doc
    page = doc[int(page_idx)]
    image = page.render(scale=scale).to_pil().convert("RGB")
    try:
        page.close()
    except Exception:  # noqa: BLE001
        pass
    _PAGE_CACHE["key"] = key
    _PAGE_CACHE["image"] = image
    return image


def crop_figure(pdf_path, out_dir, page_idx: int, block_index, bbox, scale: float = 2.0) -> str | None:
    """按 0~1 归一化 bbox 裁出插图，写到 <out_dir>/images/，返回相对路径（/ 分隔）。"""
    if not pdf_path or not out_dir or not bbox:
        return None
    try:
        x1, y1, x2, y2 = (float(v) for v in bbox)
        # 兼容 0~1000 坐标（下游注释曾按 0-1000 约定）
        if max(x1, y1, x2, y2) > 1.5:
            x1, y1, x2, y2 = x1 / 1000, y1 / 1000, x2 / 1000, y2 / 1000
        left, right = sorted((max(0.0, min(1.0, x1)), max(0.0, min(1.0, x2))))
        top, bottom = sorted((max(0.0, min(1.0, y1)), max(0.0, min(1.0, y2))))
        # 面积过小（页眉横线、字符碎片）不裁，避免制造噪声图
        if right - left < 0.02 or bottom - top < 0.02:
            return None

        image = _render_page(Path(pdf_path), page_idx, scale)
        width, height = image.size
        box = (
            int(left * width),
            int(top * height),
            min(width, int(round(right * width))),
            min(height, int(round(bottom * height))),
        )
        if box[2] - box[0] < 8 or box[3] - box[1] < 8:
            return None
        crop = image.crop(box)
        rel = f"images/page_{int(page_idx)}_image_{block_index}.jpg"
        target = Path(out_dir) / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        crop.save(target, "JPEG", quality=88)
        return rel
    except Exception as exc:  # noqa: BLE001
        log(f"裁图失败 page={page_idx} index={block_index}: {exc}")
        return None


def convert(doc: dict, pdf_path=None, out_dir=None) -> list[dict]:
    """把 docvortex.middle 文档转成 2.x content_list 数组。

    pdf_path + out_dir 都给定时，image 块会按 bbox 裁出真实图片并写成
    type=image 块（供下游 parseContentList 落盘）；否则维持旧行为，只留图注文字。
    """
    pages = doc.get("pages")
    if not isinstance(pages, list):
        raise ValueError("解析 JSON 缺少 pages 字段")

    out: list[dict] = []
    for page in pages:
        try:
            page_idx = int(page.get("page_idx", 0))
        except (TypeError, ValueError):
            page_idx = 0
        blocks = page.get("blocks") or []
        page_out: list[dict] = []
        image_seq = 0
        for block in blocks:
            if not isinstance(block, dict):
                continue
            btype = str(block.get("type") or "")
            if btype in SKIP_TYPES:
                continue

            if btype == "table":
                body = block_table_body(block)
                if body:
                    page_out.append({
                        "type": "table",
                        "page_idx": page_idx,
                        "bbox": norm_bbox(block.get("bbox")),
                        "table_body": body,
                        "table_caption": [],
                        "table_footnote": [],
                    })
                continue

            if btype == "image":
                # 印章/水印不是教材插图，别让下游当成「图 X-Y」
                if str(block.get("sub_type") or "") == "seal":
                    continue
                # flash 档不含图片字节；basic 档有 bbox，可按页渲染裁出真实插图
                texts: list[str] = []
                for item in (block.get("content") or []):
                    if not isinstance(item, dict):
                        continue
                    kind = str(item.get("type") or "")
                    content = _extract_text(item.get("content")).strip()
                    if not content:
                        continue
                    # 图注（image_caption）就是图的标题，直接保留；
                    # 脚注（image_footnote）过滤二维码/广告等噪声，只留「图 1」「表 2」这类
                    if kind == "image_caption":
                        texts.append(content)
                    elif kind == "image_footnote" and re.match(r"^(图|表)\s*[\d一二三四五六七八九十]", content):
                        texts.append(content)
                text = "\n".join(dict.fromkeys(texts)).strip()
                bbox = norm_bbox(block.get("bbox"))
                image_seq += 1
                img_rel = crop_figure(
                    pdf_path, out_dir, page_idx,
                    block.get("index") if block.get("index") is not None else image_seq,
                    bbox,
                )
                if img_rel:
                    page_out.append({
                        "type": "image",
                        "page_idx": page_idx,
                        "img_path": img_rel,
                        "img_caption": texts,
                        "bbox": [round(v * 1000) for v in bbox] if bbox else None,
                    })
                # 图注仍作为正文保留：教材全文与图号定位都依赖它
                if text:
                    page_out.append({"type": "text", "page_idx": page_idx, "text": text, "bbox": bbox})
                continue

            text = block_text(block)
            if not text:
                continue

            if btype in TITLE_TYPES:
                page_out.append({"type": "title", "page_idx": page_idx, "text": text, "bbox": norm_bbox(block.get("bbox"))})
            elif btype == "equation":
                page_out.append({"type": "equation", "page_idx": page_idx, "text": text, "bbox": norm_bbox(block.get("bbox"))})
            else:
                # text / 未知类型 一律当正文
                page_out.append({"type": "text", "page_idx": page_idx, "text": text, "bbox": norm_bbox(block.get("bbox"))})

        # 整页没有产出任何文字时，退回保留目录/旁注等被跳过块的文字，
        # 避免「页有内容但整页消失」，导致下游按页码统计时出现未转化页
        if not page_out:
            for block in blocks:
                if not isinstance(block, dict):
                    continue
                if str(block.get("type") or "") not in ("index", "aside_text"):
                    continue
                text = block_text(block)
                if text:
                    page_out.append({"type": "text", "page_idx": page_idx, "text": text, "bbox": norm_bbox(block.get("bbox"))})
        out.extend(page_out)
    return out



# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def cleanup_tmp(before_ts: float) -> None:
    """清掉本批之前遗留的渲染临时目录，避免逐批累积占满磁盘。只动 MinerU 自己的临时前缀。"""
    import shutil
    tmp = Path(os.environ.get("TMPDIR") or os.environ.get("TEMP") or ".")
    if not tmp.is_dir():
        return
    for pattern in ("docvortex-render-*", "mineru_job_*", "mineru_*"):
        for p in tmp.glob(pattern):
            try:
                if p.is_dir() and p.stat().st_mtime < before_ts:
                    shutil.rmtree(p, ignore_errors=True)
            except Exception:  # noqa: BLE001
                pass


def emit_batch(a: int, b: int, blocks: int, filename: str) -> None:
    print(f"BATCH:{a}:{b}:{blocks}:{filename}", flush=True)


def write_part(out_dir: Path, a: int, b: int, content_list: list[dict]) -> str:
    name = f"content_list_{a:04d}-{b:04d}.json"
    with open(out_dir / name, "w", encoding="utf-8") as f:
        json.dump(content_list, f, ensure_ascii=False, indent=2)
    return name


def main() -> int:
    ap = argparse.ArgumentParser(description="MinerU 4.x -> 2.x content_list.json 提取器（支持分批）")
    ap.add_argument("pdf", nargs="?", help="PDF 路径")
    ap.add_argument("--out-dir", required=True, help="输出目录（写 content_list*.json）")
    ap.add_argument("--tier", default="flash", help="解析档位：flash/basic/standard/advanced")
    ap.add_argument("--pages", default="all", help="单次模式的页范围，默认 all")
    ap.add_argument("--wait", type=int, default=5400, help="每批最长等待秒数")
    ap.add_argument("--from-json", help="跳过解析，直接转换指定的解析 JSON（测试用）")
    # 分批：借鉴 RAGFlow 的解析任务状态机——小批提交、逐批落盘、可断点续传
    ap.add_argument("--batch-size", type=int, default=0, help="每批页数，0=整本一次；扫描版建议 10")
    ap.add_argument("--start-page", type=int, default=1, help="起始页（断点续传）")
    ap.add_argument("--end-page", type=int, default=0, help="结束页，0=PDF 最后一页")
    ap.add_argument("--probe-only", action="store_true", help="只输出 PROBE:<总页数> 后退出")
    args = ap.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        if args.from_json:
            flash_json = Path(args.from_json)
            if not flash_json.is_file():
                raise FileNotFoundError(f"--from-json 文件不存在：{flash_json}")
            log(f"直接转换：{flash_json}")
            with open(flash_json, "r", encoding="utf-8") as f:
                doc = json.load(f)
            merged_pages = doc.get("pages") or []
            content_list = convert({"pages": merged_pages})
            name = write_part(out_dir, 1, max(1, len(merged_pages)), content_list)
            emit_batch(1, max(1, len(merged_pages)), len(content_list), name)
            progress(100, "完成（直接转换）")
            result = {"ok": True, "batches": 1, "blocks": len(content_list), "parts": [name]}
            print("RESULT:" + json.dumps(result, ensure_ascii=False), flush=True)
            return 0

        if not args.pdf:
            raise SystemExit("缺少 pdf 参数（或用 --from-json）")
        pdf = Path(args.pdf)
        if not pdf.is_file():
            raise FileNotFoundError(f"PDF 不存在：{pdf}")

        total = probe_page_count(pdf)
        print(f"PROBE:{total}", flush=True)
        log(f"PDF 总页数 {total}")
        if args.probe_only:
            return 0
        if not total:
            raise RuntimeError("无法探测 PDF 页数（pypdf 与 doclib 都失败）")

        sha = sha256_of(pdf)
        log(f"PDF sha256={sha}")
        end = args.end_page if args.end_page > 0 else total
        end = min(end, total)
        start = max(1, args.start_page)
        if start > end:
            progress(100, "没有待解析的页（已全部完成）")
            print("RESULT:" + json.dumps({"ok": True, "batches": 0, "blocks": 0, "parts": [], "skipped": True}), flush=True)
            return 0

        log_path = out_dir / "_mineru_parse.log"
        try:
            log_path.write_text("", encoding="utf-8")
        except Exception:
            pass

        # ---- 整本一次（兼容旧调用 / 数字版 PDF） ----
        if args.batch_size <= 0:
            progress(3, "计算文件指纹")
            code = run_parse(pdf, args.tier, args.pages, args.wait, log_path)
            merged_pages, expected_pages = load_flash_pages(sha, args.pages, args.tier)
            want = parse_page_set(args.pages)
            expected_for_req = len(want) if want is not None else expected_pages
            covered = len(merged_pages)
            if expected_for_req and covered < expected_for_req:
                tail = ""
                try:
                    tail = log_path.read_text(encoding="utf-8", errors="ignore")[-600:]
                except Exception:
                    pass
                raise RuntimeError(
                    f"解析未完成：已得 {covered}/{expected_for_req} 页（mineru 退出码 {code}）。日志尾部：\n{tail}"
                )
            content_list = convert({"pages": merged_pages}, pdf_path=pdf, out_dir=out_dir)
            if not content_list:
                raise ValueError("转换后 content_list 为空")
            name = write_part(out_dir, start, end, content_list)
            emit_batch(start, end, len(content_list), name)
            # 同时写一份整本文件名，兼容 collectOutput 的旧约定
            with open(out_dir / "content_list.json", "w", encoding="utf-8") as f:
                json.dump(content_list, f, ensure_ascii=False, indent=2)
            progress(100, "完成")
            print("RESULT:" + json.dumps({"ok": True, "batches": 1, "blocks": len(content_list), "parts": [name]}), flush=True)
            return 0

        # ---- 分批：每批独立提交、逐批产出、逐批释放渲染临时文件 ----
        size = max(1, args.batch_size)
        total_batches = (end - start + size) // size  # ceil((end-start+1)/size)
        parts: list[str] = []
        total_blocks = 0
        for batch_no, a in enumerate(range(start, end + 1, size), start=1):
            b = min(a + size - 1, end)
            page_range = f"{a}-{b}"
            before = time.time()
            log(f"批次 {batch_no}/{total_batches}：{page_range}")
            progress(5 + round((batch_no - 1) / max(1, total_batches) * 90), f"解析 {a}-{b} 页（{batch_no}/{total_batches} 批）")

            code = run_parse(pdf, args.tier, page_range, args.wait, log_path, emit_progress=False)
            merged_pages, _ = load_flash_pages(sha, page_range, args.tier)
            want = parse_page_set(page_range)
            expected_for_req = len(want) if want is not None else (b - a + 1)
            covered = len(merged_pages)
            if expected_for_req and covered < expected_for_req:
                tail = ""
                try:
                    tail = log_path.read_text(encoding="utf-8", errors="ignore")[-600:]
                except Exception:
                    pass
                raise RuntimeError(f"批次 {page_range} 解析未完成：已得 {covered}/{expected_for_req} 页（退出码 {code}）。日志尾部：\n{tail}")

            content_list = convert({"pages": merged_pages}, pdf_path=pdf, out_dir=out_dir)
            if not content_list:
                log(f"批次 {page_range} 无文本块（可能是空白页），写出空批次")
            name = write_part(out_dir, a, b, content_list)
            parts.append(name)
            total_blocks += len(content_list)
            emit_batch(a, b, len(content_list), name)
            progress(5 + round(batch_no / max(1, total_batches) * 90), f"已解析至第 {b}/{end} 页（{batch_no}/{total_batches} 批）")
            cleanup_tmp(before)

        progress(100, "全部批次完成")
        result = {
            "ok": True,
            "batches": len(parts),
            "blocks": total_blocks,
            "pages": end - start + 1,
            "parts": parts,
            "source": f"doclib:{sha[:8]}",
        }
        print("RESULT:" + json.dumps(result, ensure_ascii=False), flush=True)
        log(f"完成：{len(parts)} 批 / {total_blocks} 块")
        return 0
    except Exception as exc:  # noqa: BLE001
        err = {"ok": False, "error": str(exc)}
        print("RESULT:" + json.dumps(err, ensure_ascii=False), flush=True)
        log(f"失败：{exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
