"""照常跑 studio.py（参数和 studio.py 一样，比如 render <作品目录> --config <cfg.json>），另外把每次调用 ffmpeg 的参数记一行 JSON 到
FFMPEG_ARGS_LOG —— 测试看嘴型用的滤镜，以及没有说话版时 ffmpeg 参数和以前一字不差。
STUDIO_PY 可以指向另一份 studio.py（比如改之前的备份），两份对同一个作品各渲染一次，比较记下来的参数"""
import importlib.util
import json
import os
import sys
from pathlib import Path

src = Path(os.environ.get("STUDIO_PY") or Path(__file__).resolve().parents[2] / "studio" / "studio.py")
spec = importlib.util.spec_from_file_location("studio", src)
S = importlib.util.module_from_spec(spec)
sys.modules["studio"] = S
spec.loader.exec_module(S)
LOG = os.environ.get("FFMPEG_ARGS_LOG")
_real = S.run_ffmpeg


def run_ffmpeg(args):
    if LOG:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(args, ensure_ascii=False) + "\n")
    _real(args)


S.run_ffmpeg = run_ffmpeg
sys.argv = [str(src), *sys.argv[1:]]
S.main()
