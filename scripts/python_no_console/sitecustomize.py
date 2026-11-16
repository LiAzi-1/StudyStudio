# -*- coding: utf-8 -*-
"""让应用拉起的 Python 进程树在 Windows 上不弹控制台窗口。

通过 PYTHONPATH 注入本目录，Python 启动时会自动导入 sitecustomize。
MinerU 内部还会用 subprocess.Popen 拉起 api_server / OCR 子进程，
这里统一给 Popen 加上 CREATE_NO_WINDOW 与隐藏的 STARTUPINFO，
避免只修了我们自己的提取器、却被 MinerU 内部的子进程弹出黑框。
"""

import os
import subprocess

if os.name == "nt":
    _original_popen = subprocess.Popen

    if not getattr(_original_popen, "_openexam_hidden_window", False):
        # 必须是 Popen 的子类：asyncio.windows_utils 等标准库会写
        # `class Popen(subprocess.Popen)`，替换成函数会导致继承时报
        # TypeError: function() argument 'code' must be code, not str
        class _HiddenWindowPopen(_original_popen):
            _openexam_hidden_window = True

            def __init__(self, *args, **kwargs):
                flags = kwargs.get("creationflags", 0)
                kwargs["creationflags"] = flags | getattr(subprocess, "CREATE_NO_WINDOW", 0)
                if kwargs.get("startupinfo") is None:
                    startupinfo = subprocess.STARTUPINFO()
                    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                    startupinfo.wShowWindow = subprocess.SW_HIDE
                    kwargs["startupinfo"] = startupinfo
                super().__init__(*args, **kwargs)

        subprocess.Popen = _HiddenWindowPopen
