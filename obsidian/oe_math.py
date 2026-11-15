# -*- coding: utf-8 -*-
"""Obsidian 数学公式（LaTeX / MathJax）书写规范与正文规范化。

Obsidian 原生用 MathJax 渲染 LaTeX：$...$ 行内、$$...$$ 块级，无需装插件。
本模块做两件事：

1. ``MATH_STYLE`` —— 给所有会写笔记的模型看的统一规范（Python 侧单一来源，
   Node 侧的等价文本在 ``src/shared/mathStyle.js``，由
   ``scripts/verify-latex-format.js`` 保证两份一致）。
2. ``normalize_math`` —— 模型偶尔不守规矩时的兜底：统一旧定界符、把公式里的
   Unicode 运算符/上下标换成 LaTeX 命令、块级公式独立成行，并报告可疑公式。

设计原则：**只做无损的等价改写，绝不猜语义**。像 $\\frac{24}{7 \\approx 3.4}$
这种把说明吞进分母的错误，程序无法判断作者本意，只告警不改写。

仅使用 Python 标准库。
"""
from __future__ import annotations

import re

# ---------------------------------------------------------------- 规范文本
# 注意：这是 raw string，\frac / \begin 等反斜杠要原样交给模型。
# 文本里刻意不使用反引号或 ${，方便 JS 侧用 String.raw 保持逐字一致。
MATH_STYLE = r"""【数学公式格式 · Obsidian / MathJax，必须遵守】
1. 所有数学内容（变量、方程、分式、根式、上下标、希腊字母、运算符）一律写成 LaTeX：
   - 行内公式用单美元符号包裹：$W = v \times t$；
   - 重要公式独立成块，用双美元符号单独占行，前后各留一个空行：
     $$
     G(s) = \frac{Y(s)}{R(s)}
     $$
2. 只用 Obsidian 内置 MathJax 支持的标准命令：\frac{a}{b}、\times、\div、\cdot、\sqrt{x}、x^{2}、x_{i}、\sum、\int、\lim、\alpha~\omega 等希腊字母、\approx、\leq、\geq、\neq、\pm、\infty、\text{...}、\begin{aligned}...\end{aligned}。
   不要写 \usepackage、\newcommand、\ce 等需要宏包或插件的命令；不要用 \(...\)、\[...\] 或代码块包公式。
3. 中文说明放在公式外面；必须进公式时用 \text{中文}。
   正确：$W = v \times t$（工作量 = 效率 × 时间）
   错误：$工作量 = 效率 \times 时间$
4. 定界符里只放数学，不要把单位、中文或说明文字吞进去：
   正确：需要 $\frac{24}{7} \approx 3.4$ 小时；错误：$\frac{24}{7 \approx 3.4}$、$24/7 ≈ 3.4 小时$。
   $...$ 内不要用 ≈ × ÷ ² 等 Unicode 符号，一律换成 LaTeX 命令。
5. 题目、选项、解析里的公式同样按上述规则写；「## 例题」章节的「答案：」「解析：」「知识点：」「难度：」等字段保持可解析的纯文本格式，只有其中的数学部分用 $...$。
6. 不改动原文里已有的正确 LaTeX；不要给公式加编号、代码块或 HTML 标签。"""

# ---------------------------------------------------------------- 常量

# 公式环境内可以无损替换的 Unicode 字符 → LaTeX 命令
UNICODE_OPS: dict[str, str] = {
    "×": r"\times ", "÷": r"\div ", "·": r"\cdot ", "⋅": r"\cdot ",
    "≈": r"\approx ", "≠": r"\neq ", "≤": r"\leq ", "≥": r"\geq ",
    "±": r"\pm ", "∓": r"\mp ", "∞": r"\infty ", "∝": r"\propto ",
    "→": r"\to ", "←": r"\leftarrow ", "⇒": r"\Rightarrow ",
    "∈": r"\in ", "∉": r"\notin ", "⊂": r"\subset ",
    "−": "-", "–": "-", "‐": "-",
    "π": r"\pi ", "α": r"\alpha ", "β": r"\beta ", "γ": r"\gamma ",
    "δ": r"\delta ", "ε": r"\epsilon ", "ζ": r"\zeta ", "η": r"\eta ",
    "θ": r"\theta ", "λ": r"\lambda ", "μ": r"\mu ", "ν": r"\nu ",
    "ξ": r"\xi ", "ρ": r"\rho ", "σ": r"\sigma ", "τ": r"\tau ",
    "φ": r"\phi ", "χ": r"\chi ", "ψ": r"\psi ", "ω": r"\omega ",
    "Δ": r"\Delta ", "Σ": r"\Sigma ", "Ω": r"\Omega ", "Γ": r"\Gamma ",
    "Π": r"\Pi ", "Θ": r"\Theta ", "Φ": r"\Phi ",
}

_SUPERSCRIPTS = "⁰¹²³⁴⁵⁶⁷⁸⁹"
_SUBSCRIPTS = "₀₁₂₃₄₅₆₇₈₉"

# 自动替换不干净、需要提示作者的符号
_AMBIGUOUS = {"√": r"\sqrt{}", "∑": r"\sum", "∫": r"\int", "∂": r"\partial"}

_CODE_FENCE = re.compile(r"```[\s\S]*?```")
_INLINE_CODE = re.compile(r"`[^`\n]*`")
_OLD_INLINE = re.compile(r"\\\((.*?)\\\)", flags=re.S)
_OLD_BLOCK = re.compile(r"\\\[(.*?)\\\]", flags=re.S)
_BLOCK_MATH = re.compile(r"\$\$(.+?)\$\$", flags=re.S)
_MATH_TOKEN = re.compile(r"\$\$(.+?)\$\$|\$(?!\$)(.+?)(?<!\\)\$(?!\$)", flags=re.S)
_CJK = re.compile(r"[\u4e00-\u9fff]")
_SUSPECT_FRAC = re.compile(
    r"\\frac\s*\{[^{}]*?(?:\\approx|[\u4e00-\u9fff=<>])[^{}]*?\}\s*\{[^{}]*?\}"
    r"|\\frac\s*\{[^{}]*?\}\s*\{[^{}]*?(?:\\approx|[\u4e00-\u9fff=<>])[^{}]*?\}"
)
_BAD_MACRO = re.compile(r"\\(?:usepackage|newcommand|renewcommand|ce)\b")


def _protect_code(text: str) -> tuple[str, list[str]]:
    """代码块里的 $ 和 × 不是公式，先挖出来，处理完再原样回填。"""
    holes: list[str] = []

    def stash(match: re.Match) -> str:
        holes.append(match.group(0))
        return f"\x00CODE{len(holes) - 1}\x00"

    out = _CODE_FENCE.sub(stash, text)
    out = _INLINE_CODE.sub(stash, out)
    return out, holes


def _restore_code(text: str, holes: list[str]) -> str:
    for index, original in enumerate(holes):
        text = text.replace(f"\x00CODE{index}\x00", original)
    return text


def _convert_ops(inner: str) -> str:
    """把公式体内的 Unicode 运算符、希腊字母、上下标换成 LaTeX 命令。"""
    out = []
    for char in inner:
        if char in UNICODE_OPS:
            out.append(UNICODE_OPS[char])
        elif char in _SUPERSCRIPTS:
            out.append("^{" + str(_SUPERSCRIPTS.index(char)) + "}")
        elif char in _SUBSCRIPTS:
            out.append("_{" + str(_SUBSCRIPTS.index(char)) + "}")
        else:
            out.append(char)
    # \times 这类命令后必须留一个空格分隔，但在括号 / 上下标 / 结尾前多余，收掉
    joined = re.sub(r"(\\[a-zA-Z]+) +(?=[}\]$)_^])", r"\1", "".join(out))
    return re.sub(r" {2,}", " ", joined)


def _normalize_blocks(text: str) -> str:
    """$$...$$ 一律独立成段，避免和正文挤在一行导致 MathJax 不渲染。"""

    def block(match: re.Match) -> str:
        inner = match.group(1).strip()
        return "\n\n$$\n" + inner + "\n$$\n\n"

    return _BLOCK_MATH.sub(block, text)


def _check(text: str) -> list[str]:
    warnings: list[str] = []

    def add(message: str) -> None:
        if message not in warnings:
            warnings.append(message)

    for match in _MATH_TOKEN.finditer(text):
        inner = match.group(1) or match.group(2) or ""
        # \text{中文} 是允许写法，不报警
        if _CJK.search(re.sub(r"\\text\{[^{}]*\}", "", inner)):
            add("公式里含中文：中文说明请移到 $...$ 外，或写成 \\text{...}")
        for symbol, command in _AMBIGUOUS.items():
            if symbol in inner:
                add(f"公式里还有 Unicode 符号「{symbol}」，请改写成 {command} 形式")
        if _SUSPECT_FRAC.search(inner):
            add("疑似把说明文字吞进了 \\frac{}{}：$...$ 里只放数学，单位与中文放外面")
    if _BAD_MACRO.search(text):
        add("出现了 MathJax 不支持的宏包命令（\\usepackage / \\newcommand / \\ce）")
    # 去掉块级公式后，剩余的 $ 必须成对
    rest = _BLOCK_MATH.sub("", text)
    if len(re.findall(r"(?<!\\)\$", rest)) % 2:
        add("行内公式的 $ 没有成对闭合，Obsidian 里会显示成源码")
    return warnings


def normalize_math(text: str) -> tuple[str, list[str]]:
    """规范一篇 Markdown 正文里的数学公式，返回 (正文, 告警列表)。

    保守策略：只改写确定等价的写法；语义可疑的留给模型/作者，只告警。
    幂等：对结果重复调用不会再改动正文。
    """
    original = str(text or "")
    if not original:
        return original, []
    working, holes = _protect_code(original)
    has_old_block = bool(_OLD_BLOCK.search(working))
    has_old_inline = bool(_OLD_INLINE.search(working))
    working = _OLD_BLOCK.sub(lambda m: "$$" + m.group(1) + "$$", working)
    working = _OLD_INLINE.sub(lambda m: "$" + m.group(1) + "$", working)
    working = _normalize_blocks(working)
    # 全文没有公式时原样返回：不能因为统一换行把不含数学的正文也改一遍
    if not (has_old_block or has_old_inline or _MATH_TOKEN.search(working)):
        return original, _check(working)

    def convert(match: re.Match) -> str:
        inner = match.group(1) if match.group(1) is not None else match.group(2)
        converted = _convert_ops(inner)
        if match.group(1) is not None:
            return "$$\n" + converted.strip() + "\n$$"
        return "$" + converted + "$"

    working = _MATH_TOKEN.sub(convert, working)
    warnings = _check(working)
    working = _restore_code(working, holes)
    working = re.sub(r"\n{3,}", "\n\n", working)
    return working, warnings


def report(warnings: list[str], label: str = "") -> None:
    """把告警打到桥接日志；由调用方决定是否 import oe_common，避免循环依赖。"""
    if not warnings:
        return
    import oe_common as C  # 局部导入：oe_common 不依赖本模块
    prefix = f"[{label}] " if label else ""
    for item in warnings[:6]:
        C.warn(f"  {prefix}公式格式提醒：{item}")
