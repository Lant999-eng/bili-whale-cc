"""测试用：跑真的 `studio.py existing`，只把创作中心稿件列表的回包换成环境变量 EXISTING_PAGE（JSON，每一页都回它；不联网）"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "studio"))
import studio as S  # noqa: E402
import bilibili_api.creative_center as CC  # noqa: E402

_resp = json.loads(os.environ["EXISTING_PAGE"])


async def _fake(cred, pn=1, ps=30, order=None, status=None):
    return _resp


CC.get_video_upload_manager_info = _fake
sys.argv = ["studio.py", *sys.argv[1:]]
S.main()
