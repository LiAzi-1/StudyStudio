# -*- coding: utf-8 -*-
"""OpenExam <-> Obsidian 桥接公共层。

仅使用 Python 标准库：项目的 better-sqlite3 是为 Electron 编译的，
系统 Node 无法加载，所以数据库统一走 Python sqlite3。
"""
from __future__ import annotations

import gzip
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent.parent
OBS = Path(__file__).resolve().parent
VAULT = OBS / "vault"
BRIDGE = VAULT / "_bridge"
INDEX = BRIDGE / "index"
POINTS_DIR = INDEX / "points"
REQUESTS = BRIDGE / "requests"
REQUESTS_DONE = REQUESTS / "done"
BANK_DIR = VAULT / "90-题库"
INBOX = VAULT / "00-收件箱"
NOTES = VAULT / "10-笔记"
APP_NOTES = NOTES / "应用笔记"
MAP_DIR = VAULT / "20-思维导图"
ASSETS = VAULT / "99-附件"
ORIGINALS = ASSETS / "原始笔记"
TEMPLATES = VAULT / "99-模板"
OUTBOX = OBS / "outbox"
BACKUPS = OBS / "backups"
CACHE = OBS / ".cache"
CONFIG_PATH = OBS / "config.json"
STATE_PATH = OBS / "state.json"
SEED_GZ = ROOT / "data" / "openexam.seed.db.gz"

BANK_START = "<!-- openexam:bank:start -->"
BANK_END = "<!-- openexam:bank:end -->"
HOME_START = "<!-- openexam:index:start -->"
HOME_END = "<!-- openexam:index:end -->"
KP_START = "<!-- openexam:kp:start -->"
KP_END = "<!-- openexam:kp:end -->"
MAP_START = "<!-- openexam:map:start -->"
MAP_END = "<!-- openexam:map:end -->"

DEFAULT_CONFIG = {
    "database": {
        # 留空 = 自动探测；写入始终落到应用当前数据库
        "path": "",
        # 内置官方题库已移除：默认不再回退到种子库，也不扫描旧 AppData 里的系统题库
        "fallbackToSeed": False,
        "scanLegacyAppdata": False,
        "appDataName": "studystudio",
    },
    "vision": {
        "protocol": "openai",  # openai | anthropic
        "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
        "apiKey": "",
        "model": "glm-4v-flash",
        "temperature": 0.3,
        "maxTokens": 4096,
        "timeout": 120,
    },
    "sync": {
        "samplePerPoint": 12,       # 镜像 Markdown 里展示的题目数
        "maxQuestionsPerPoint": 120,  # 插件索引里保留的题目数
        "contentLimit": 700,
    },
    "import": {
        "defaultCategory": "major",
        "defaultSubCategory": "obsidian",
    },
    "tutor": {
        # 留空 = 自动复用 OpenExam 应用里已配置的文本模型（app_settings.ai_settings）
        "apiKey": "",
        "baseUrl": "",
        "model": "",
        "protocol": "openai",
        "maxTokens": 4096,
        "timeout": 90,
    },
    "mindmap": {
        "canvasPath": "20-思维导图/知识地图.canvas",
        "notePath": "20-思维导图/知识地图.md",
    },
    # 应用内按钮调用桥接时使用的 Python；留空 = 自动探测 python / py -3
    "pythonPath": "",
}

# 三级考点关键词补充。skill_point 字段缺失时用于近似匹配。
POINT_ALIASES = {
    "shuliang.jisuan.xingcheng": ["行程", "相遇", "追及", "速度", "路程"],
    "shuliang.jisuan.gongcheng": ["工程", "效率", "工作量", "注满", "水池", "单独完成"],
    "shuliang.jisuan.lirun": ["利润", "售价", "成本", "打折", "涨价", "折扣"],
    "shuliang.jisuan.nongdu": ["浓度", "溶液", "盐水"],
    "shuliang.jisuan.pailie": ["排列", "组合", "任选"],
    "shuliang.jisuan.gailv": ["概率", "随机"],
    "shuliang.jisuan.jihe": ["几何", "三角形", "圆形", "面积", "体积"],
    "shuliang.jisuan.rongchi": ["容斥", "至少满足", "两者都"],
    "shuliang.jisuan.zuizhi": ["至少", "最多", "最少", "最值"],
    "shuliang.tuili.dengcha": ["等差数列", "公差"],
    "shuliang.tuili.dengbi": ["等比数列", "公比"],
    "ziliao.zonghe.zengzhanglv": ["增长率", "增速", "同比增长", "同比增长率"],
    "ziliao.zonghe.zengzhangliang": ["增长量", "增加了多少"],
    "ziliao.zonghe.jiqiliang": ["基期", "上年同期"],
    "ziliao.zonghe.bizhong": ["比重", "占比", "所占"],
    "ziliao.zonghe.pingjun": ["平均", "人均", "均值"],
    "yanyu.xuanci.chengyu": ["成语", "依次填入"],
    "yanyu.xuanci.shici": ["实词", "填入划横线"],
    "yanyu.yueduan.zhongxin": ["主旨", "意在说明", "主要说明", "中心"],
    "yanyu.yueduan.xijie": ["以下说法正确", "符合文意", "细节"],
    "panduan.luoji.jiaqiang": ["最能支持", "加强"],
    "panduan.luoji.xuoruo": ["最能削弱", "质疑", "削弱"],
    "panduan.dingyi.dan": ["根据上述定义", "属于上述定义"],
    "panduan.leibi.yuyi": ["之于", "相当于"],
    "changshi.falv.xianfa": ["宪法"],
    "changshi.falv.minfa": ["民法典", "民法"],
    "changshi.falv.xingfa": ["刑法", "犯罪"],
    "changshi.jingji.hongguan": ["宏观调控", "财政政策", "货币政策", "通货膨胀"],
    "changshi.keji.wuli": ["物理", "光速", "量子", "力学"],
    "changshi.renwen.lishi": ["历史", "朝代", "盛世"],
}

STRIP_SUFFIXES = [
    "问题", "辨析", "填空", "判断", "理解", "推理", "分析", "计算", "关系",
    "原理", "选择", "阅读", "表达", "类", "与", "热点", "常识", "结论",
]


def log(*args: object) -> None:
    print("[OpenExam]", *args, flush=True)


def warn(*args: object) -> None:
    print("[OpenExam][WARN]", *args, flush=True)


def now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def sha(text: str, length: int = 12) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:length]


def safe_name(text: str) -> str:
    """把知识点 id / 中文标签转成可用文件名。"""
    cleaned = re.sub(r'[\\/:*?"<>|#\[\]^]', "_", str(text)).strip()
    return cleaned[:80] or "unnamed"


def slugify(text: str) -> str:
    cleaned = re.sub(r"[^\w\u4e00-\u9fff\- ]+", "", str(text), flags=re.UNICODE)
    cleaned = re.sub(r"\s+", "-", cleaned.strip())
    return cleaned[:60] or "note"


# --------------------------------------------------------------------- config

def load_config() -> dict:
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    if CONFIG_PATH.exists():
        try:
            user_cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            for key, value in user_cfg.items():
                if isinstance(value, dict) and isinstance(cfg.get(key), dict):
                    cfg[key].update(value)
                else:
                    cfg[key] = value
        except Exception as exc:
            warn(f"config.json 读取失败，使用默认配置：{exc}")
    return cfg


def load_state() -> dict:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"formatted": {}, "imported": {}}


def save_state(state: dict) -> None:
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


# ------------------------------------------------------------------ database

def _appdata() -> Path:
    return Path(os.environ.get("APPDATA") or (Path.home() / "AppData" / "Roaming"))


def app_db_path(cfg: dict) -> Path:
    explicit = str(cfg.get("database", {}).get("path") or "").strip()
    if explicit:
        return Path(explicit).expanduser()
    return _appdata() / cfg.get("database", {}).get("appDataName", "studystudio") / "openexam.db"


def seed_db_path() -> Path:
    """把内置种子库解压到缓存，返回可直接只读打开的 .db。"""
    target = CACHE / "openexam.seed.db"
    if not SEED_GZ.exists():
        return target
    if target.exists() and target.stat().st_mtime >= SEED_GZ.stat().st_mtime:
        return target
    CACHE.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".tmp")
    with gzip.open(SEED_GZ, "rb") as src, open(tmp, "wb") as dst:
        shutil.copyfileobj(src, dst)
    os.replace(tmp, target)
    return target


def db_candidates(cfg: dict) -> list[Path]:
    appdata = _appdata()
    result: list[Path] = []
    explicit = str(cfg.get("database", {}).get("path") or "").strip()
    if explicit:
        result.append(Path(explicit).expanduser())
    result.append(app_db_path(cfg))
    # 旧版会从多个历史 AppData 目录里挑「题目最多」的库，结果总是选回内置官方题库。
    # 现在默认只看应用当前数据库；需要兼容旧库时可在 config.json 打开 scanLegacyAppdata。
    if cfg.get("database", {}).get("scanLegacyAppdata", False):
        for name in ("openexam", "StudyStudio", "OpenExam"):
            candidate = appdata / name / "openexam.db"
            if candidate not in result:
                result.append(candidate)
    if cfg.get("database", {}).get("fallbackToSeed", False) and SEED_GZ.exists():
        result.append(seed_db_path())
    seen = set()
    unique = []
    for path in result:
        key = str(path).lower()
        if key in seen:
            continue
        seen.add(key)
        unique.append(path)
    return unique


def question_count(path: Path) -> int:
    if not path.exists():
        return -1
    try:
        conn = sqlite3.connect(str(Path(path).resolve().as_uri()) + "?mode=ro", uri=True)
        count = conn.execute("SELECT COUNT(*) FROM questions").fetchone()[0]
        conn.close()
        return int(count)
    except Exception:
        return -1


def resolve_read_db(cfg: dict) -> tuple[Path, int]:
    """挑题目最多的库作为镜像数据源，返回 (路径, 题目数)。"""
    scored = [(p, question_count(p)) for p in db_candidates(cfg)]
    usable = [(p, c) for p, c in scored if c > 0]
    if not usable:
        raise RuntimeError("没有找到含题目的数据库，请检查 config.json 的 database.path")
    path, count = max(usable, key=lambda item: item[1])
    return path, count


def connect_ro(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(str(Path(path).resolve().as_uri()) + "?mode=ro", uri=True)


def connect_rw(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=8000")
    return conn


def backup_db(path: Path) -> Path | None:
    if not path.exists():
        return None
    BACKUPS.mkdir(parents=True, exist_ok=True)
    target = BACKUPS / f"openexam-{datetime.now().strftime('%Y%m%d-%H%M%S')}.db"
    src = sqlite3.connect(str(Path(path).resolve().as_uri()) + "?mode=ro", uri=True)
    dst = sqlite3.connect(str(target))
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    return target


# ------------------------------------------------------------- knowledge tree

def load_tree(refresh: bool = False) -> dict:
    """调用系统 node 读取项目里的 skillPoints.js，缓存成 JSON。"""
    target = INDEX / "tree.json"
    if target.exists() and not refresh:
        try:
            return json.loads(target.read_text(encoding="utf-8"))
        except Exception:
            pass
    script = (
        "const p=require(" + json.dumps(str(ROOT / "src" / "shared" / "skillPoints.js")) + ");"
        "process.stdout.write(JSON.stringify(p.SKILL_POINT_TREE));"
    )
    INDEX.mkdir(parents=True, exist_ok=True)
    try:
        out = subprocess.run(
            ["node", "-e", script], cwd=str(ROOT), capture_output=True, timeout=30
        )
        if out.returncode != 0:
            raise RuntimeError((out.stderr or b"").decode("utf-8", "replace")[:300])
        tree = json.loads(out.stdout.decode("utf-8"))
    except Exception as exc:
        warn(f"无法从 skillPoints.js 生成知识点树（{exc}），使用缓存或空树")
        if target.exists():
            return json.loads(target.read_text(encoding="utf-8"))
        tree = {}
    target.write_text(json.dumps(tree, ensure_ascii=False, indent=2), encoding="utf-8")
    return tree


def keywords_for(point_id: str, label: str) -> list[str]:
    if point_id in POINT_ALIASES:
        return POINT_ALIASES[point_id]
    word = label
    for suffix in STRIP_SUFFIXES:
        if word.endswith(suffix) and len(word) > len(suffix) + 1:
            word = word[: -len(suffix)]
            break
    return [word] if len(word) >= 2 else [label]


def flatten_tree(tree: dict) -> dict[str, dict]:
    """产生 id -> node 的目录。level 1=模块 2=题型 3=考点。"""
    catalog: dict[str, dict] = {}
    for cat, mod in tree.items():
        catalog[cat] = {
            "id": cat, "label": mod.get("label", cat), "level": 1,
            "parent": None, "category": cat, "sub": None, "point": None,
            "keywords": [],
        }
        for sub_key, sub in (mod.get("subs") or {}).items():
            sub_id = f"{cat}.{sub_key}"
            catalog[sub_id] = {
                "id": sub_id, "label": sub.get("label", sub_key), "level": 2,
                "parent": cat, "category": cat, "sub": sub_key, "point": None,
                "keywords": [],
            }
            for point_key, point_label in (sub.get("points") or []):
                point_id = f"{sub_id}.{point_key}"
                catalog[point_id] = {
                    "id": point_id, "label": point_label, "level": 3,
                    "parent": sub_id, "category": cat, "sub": sub_key,
                    "point": point_id, "keywords": keywords_for(point_id, point_label),
                }
    return catalog


def label_index(catalog: dict[str, dict]) -> dict[str, str]:
    result = {}
    for node in catalog.values():
        result.setdefault(node["label"], node["id"])
        result.setdefault(node["id"], node["id"])
    return result


def resolve_point_ids(values, catalog: dict[str, dict]) -> list[str]:
    """把 frontmatter 里的各种写法统一成目录里的 id；认不出来的返回 custom: 节点。"""
    if not values:
        return []
    if isinstance(values, str):
        values = re.split(r"[,，;；\s]+", values)
    lookup = label_index(catalog)
    resolved: list[str] = []
    for raw in values:
        text = str(raw).strip().lstrip("#")
        if not text:
            continue
        text = text.replace("知识点/", "").replace("考点/", "")
        hit = lookup.get(text)
        if not hit:
            # 允许「知识点/工程问题」「数学运算·工程问题」等松散写法
            tail = re.split(r"[／/·>」】\]]", text)[-1].strip()
            hit = lookup.get(tail)
        if not hit:
            for label, node_id in lookup.items():
                if len(label) >= 2 and label in text:
                    hit = node_id
                    break
        if not hit:
            hit = "custom:" + safe_name(text)
        if hit not in resolved:
            resolved.append(hit)
    return resolved


def custom_node(point_id: str, catalog: dict[str, dict]) -> dict:
    label = point_id.split(":", 1)[-1]
    parent = None
    for node in catalog.values():
        if node["label"] in label or label in node["label"]:
            parent = node["id"]
            break
    return {
        "id": point_id, "label": label, "level": 3, "parent": parent,
        "category": None, "sub": None, "point": None,
        "keywords": [label], "approx": True,
    }


# --------------------------------------------------------------- frontmatter

def parse_frontmatter(text: str) -> tuple[dict, str]:
    if not text.startswith("---"):
        return {}, text
    match = re.match(r"^---\s*\r?\n(.*?)\r?\n---\s*\r?\n?", text, flags=re.S)
    if not match:
        return {}, text
    meta: dict = {}
    current_list_key = None
    for line in match.group(1).splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        item = re.match(r"^\s+-\s+(.*)$", line)
        if item and current_list_key:
            meta.setdefault(current_list_key, []).append(_scalar(item.group(1)))
            continue
        kv = re.match(r"^([\w\u4e00-\u9fff_-]+)\s*:\s*(.*)$", line)
        if not kv:
            continue
        key, value = kv.group(1), kv.group(2).strip()
        current_list_key = None
        if value == "":
            meta[key] = []
            current_list_key = key
        elif value.startswith("[") and value.endswith("]"):
            inner = value[1:-1].strip()
            meta[key] = [_scalar(v) for v in inner.split(",") if v.strip()] if inner else []
        else:
            meta[key] = _scalar(value)
    return meta, text[match.end():]


def _scalar(value: str):
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    if value.lower() in ("true", "false"):
        return value.lower() == "true"
    return value


def dump_frontmatter(meta: dict) -> str:
    lines = ["---"]
    for key, value in meta.items():
        if isinstance(value, (list, tuple)):
            items = [str(v).replace("]", "").replace("[", "") for v in value]
            lines.append(f"{key}: [{', '.join(items)}]")
        elif value is None:
            continue
        else:
            text = str(value)
            if any(ch in text for ch in ":#\n[]{}\"'") or text.strip() != text:
                text = '"' + text.replace('"', "'") + '"'
            lines.append(f"{key}: {text}")
    lines.append("---")
    return "\n".join(lines) + "\n\n"


def read_note(path: Path) -> tuple[dict, str]:
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    return parse_frontmatter(text)


def write_note(path: Path, meta: dict, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(dump_frontmatter(meta) + body.lstrip("\n"), encoding="utf-8")


def vault_rel(path: Path) -> str:
    return Path(path).relative_to(VAULT).as_posix()


def link_of(path: Path) -> str:
    """vault 内路径 -> Obsidian 内链（去掉 .md 后缀）。"""
    rel = vault_rel(path)
    return rel[:-3] if rel.endswith(".md") else rel


def note_point_values(meta: dict) -> list:
    for key in ("knowledge_points", "knowledgePoints", "知识点", "考点", "kp"):
        if key in meta and meta[key]:
            return meta[key] if isinstance(meta[key], list) else [meta[key]]
    tags = meta.get("tags") or []
    if isinstance(tags, str):
        tags = [tags]
    return [t for t in tags if str(t).startswith(("知识点/", "考点/"))]


def iter_notes() -> list[Path]:
    result = []
    for folder in (INBOX, NOTES):
        if folder.exists():
            result.extend(sorted(p for p in folder.rglob("*.md") if not p.name.startswith(".")))
    return result


def strip_bank_block(body: str) -> str:
    pattern = re.compile(
        re.escape(BANK_START) + r".*?" + re.escape(BANK_END) + r"\s*",
        flags=re.S,
    )
    return pattern.sub("", body).rstrip() + "\n"


def strip_managed(body: str, start: str, end: str) -> str:
    pattern = re.compile(re.escape(start) + r".*?" + re.escape(end) + r"\s*", flags=re.S)
    return pattern.sub("", body).rstrip() + "\n"


def strip_kp_block(body: str) -> str:
    return strip_managed(body, KP_START, KP_END)


def strip_map_block(body: str) -> str:
    return strip_managed(body, MAP_START, MAP_END)


def replace_managed(text: str, start: str, end: str, block: str) -> str:
    pattern = re.compile(re.escape(start) + r".*?" + re.escape(end), flags=re.S)
    replacement = f"{start}\n{block.strip()}\n{end}"
    if pattern.search(text):
        return pattern.sub(lambda _m: replacement, text, count=1)
    return text.rstrip() + "\n\n" + replacement + "\n"


# --------------------------------------------------------------- text helpers

def plain_text(html_or_text: str) -> str:
    if not html_or_text:
        return ""
    text = str(html_or_text)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"</p>|</div>|</li>", "\n", text, flags=re.I)
    text = re.sub(r"<img[^>]*>", "[含图片，请在 OpenExam 中查看]", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    for a, b in (("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"),
                 ("&amp;", "&"), ("&quot;", '"'), ("&#39;", "'")):
        text = text.replace(a, b)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def parse_options(raw) -> list[dict]:
    if not raw:
        return []
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            return []
    if not isinstance(raw, list):
        return []
    result = []
    for index, item in enumerate(raw):
        if isinstance(item, dict):
            key = str(item.get("key") or chr(65 + index)).upper()
            content = str(item.get("content") or item.get("text") or "")
            if content:
                result.append({"key": key, "content": content})
    return result


def truncate(text: str, limit: int) -> str:
    text = str(text or "").strip()
    return text if len(text) <= limit else text[:limit] + " …"


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def ensure_dirs() -> None:
    for folder in (VAULT, BRIDGE, INDEX, POINTS_DIR, REQUESTS, REQUESTS_DONE,
                   INBOX, NOTES, APP_NOTES, MAP_DIR, BANK_DIR, ASSETS, ORIGINALS,
                   TEMPLATES, OUTBOX, BACKUPS, CACHE):
        folder.mkdir(parents=True, exist_ok=True)
