"""studio.py 上传前的本地检查 + 「B站 不收 AI 声明时不悄悄去掉」（不联网：VideoUploader 和凭据都换成假的）"""
import asyncio
import contextlib
import io
import json
import sys
import tempfile
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "studio"))
import studio as S  # noqa: E402
import bilibili_api.video_uploader as VU  # noqa: E402

PRESET = "作者声明：该视频使用人工智能合成技术"

# ① 分区表和声明预设：读的是 bilibili_api 自带的那份
tids, marks = S.upload_presets()
assert tids and tids.get(21, "").endswith("日常") and tids.get(201, "").endswith("科学科普"), tids
assert 160 not in tids and 188 not in tids and 36 not in tids, "大区号不算投稿用的子分区"
assert marks and PRESET in marks, marks

proj = Path(tempfile.mkdtemp(prefix="whale-upload-units-"))
(proj / "final.mp4").write_bytes(b"not really a video")
from PIL import Image  # noqa: E402
Image.new("RGB", (32, 18), (90, 110, 140)).save(proj / "cover.jpg")   # VideoMeta 一定要读封面（渲染总会出一张）

calls, FAIL = [], {"msg": None}


class FakeUploader:
    def __init__(self, pages, meta, credential):
        self.meta = meta

    async def start(self):
        calls.append(self.meta.neutral_mark)
        if FAIL["msg"]:
            raise Exception(FAIL["msg"])
        return {"bvid": "BV1fake411111", "aid": 1}


VU.VideoUploader = FakeUploader          # do_upload 每次调用时才 from … import，换掉模块上的名字就够了
S.credential = lambda p: None            # 不读凭据文件


def run(tid, statement, scenes=None):
    """→ (退出码 / None, 打印的 JSON / None, 抛出的异常 / None)"""
    (proj / "script.json").write_text(json.dumps({"title": "测试上传", "tags": ["日常"], "desc": "简介", "tid": tid,
                                                  "scenes": scenes or [{"slide": {"title": "测试", "bullets": ["一条"]}, "lines": [{"text": "你好"}]}]},
                                                 ensure_ascii=False), encoding="utf-8")
    calls.clear()
    out, code, err = io.StringIO(), None, None
    with contextlib.redirect_stdout(out):
        try:
            asyncio.run(S.do_upload(proj, "cred.json", statement))
        except SystemExit as e:
            code = e.code
        except Exception as e:  # noqa: BLE001
            err = e
    text = out.getvalue().strip()
    return code, (json.loads(text.splitlines()[-1]) if text else None), err


# ② 大区号 / 编的号 / 不是数字：一个字节都不传，说清楚
for bad in (160, 188, 999999, "abc", 0):
    code, j, err = run(bad, PRESET)
    assert code == 1 and err is None and j and j["ok"] is False, (bad, code, j, err)
    assert "不是 B站 投稿页上的子分区" in j["error"] and "没有上传" in j["error"], j
    assert calls == [], f"tid={bad!r} 不该开始上传：{calls}"

# ③ 声明不是预设原文：不传
code, j, err = run(21, "作者声明：随便写的一句")
assert code == 1 and j and "不是 B站 预设的那几句之一" in j["error"] and calls == [], (code, j, calls)

# ④ 正常：带着声明传一次
code, j, err = run(21, PRESET)
assert code is None and err is None and j == {"ok": True, "bvid": "BV1fake411111", "aid": 1, "raw": {"bvid": "BV1fake411111", "aid": 1}}, (code, j, err)
assert calls == [PRESET], calls

# ⑤ B站 不收这条声明：报错停下，绝不去掉声明再传一次（以前会悄悄重投）
FAIL["msg"] = "提交失败：neutral_mark 参数不合法"
code, j, err = run(201, PRESET)
assert isinstance(err, RuntimeError) and "没有去掉声明重投" in str(err) and PRESET in str(err), (code, j, err)
assert calls == [PRESET], f"只能试一次、而且带着声明：{calls}"

# ⑥ 别的上传错误照原样抛出（Node 那边记成一次结果不确定的尝试）
FAIL["msg"] = "网络断了"
code, j, err = run(21, PRESET)
assert err is not None and str(err) == "网络断了" and calls == [PRESET], (err, calls)

# ⑦ 主人把声明设成空：不带声明传（这是主人明确的选择）
FAIL["msg"] = None
code, j, err = run(21, "")
assert code is None and j and j["ok"] is True and calls == [None], (code, j, calls)

# ⑧ 分区号的读法和 node 那边（parseTid）一样：只认正整数和纯 ASCII 数字字符串
for v, want in ((21, 21), (21.0, 21), ("21", 21), (" 201 ", 201), ("\t21\n", 21), ("21.0", 0), ("0x15", 0), ("2_1", 0), ("２１", 0), ("٢١", 0),
                ("﻿21", 0), ("21　", 0), (" 21", 0), ("\x1c21", 0), (True, 0), (-21, 0), ([21], 0), (None, 0), ("", 0)):
    assert S.parse_tid(v) == want, (v, S.parse_tid(v), want)
code, j, err = run("21.0", PRESET)
assert code == 1 and j and j.get("notStarted") is True and calls == [], (code, j, calls)

# ⑨ 上传前挡下的都带 notStarted（主人那边据此不记成「结果不确定」）；真传了以后的失败不带
code, j, err = run(160, PRESET)
assert j.get("notStarted") is True, j
code, j, err = run(21, "作者声明：随便写的一句")
assert j.get("notStarted") is True, j
# 交审时还允许、升级后才不允许的剧本（v0.11.16：slide 不能配 illustration_prompt、bg_prompt 只收字符串）：排队的旧作品批准时在读剧本这一步被拦 ——
# 也是一个字节都没传，要带 notStarted（不然主人那边记成「结果不确定」、还说「B站 可能收到了」）
for sc in ({"slide": {"title": "测试"}, "illustration_prompt": "她站在黑板前", "lines": [{"text": "你好"}]}, {"bg_prompt": 123, "lines": [{"text": "你好"}]}):
    code, j, err = run(21, PRESET, [sc])
    assert code == 1 and err is None and j and j["ok"] is False and j.get("notStarted") is True and calls == [], (sc, code, j, calls)
assert S._DIE_EXTRA == {}, "读完剧本就收回"
out = io.StringIO()
with contextlib.redirect_stdout(out):
    try:
        S.validate_script({"title": 3})
    except SystemExit:
        pass
assert "notStarted" not in json.loads(out.getvalue().strip().splitlines()[-1]), "上传以外的 die 不带 notStarted"

# ⑩ lockWait = 0 就是不等（以前 `or 30` 把 0 当成没设，照样等 30 秒）；不设才是 30 秒
seen = []


def fake_lock(path, wait):
    seen.append(wait)
    raise RuntimeError("busy")


S._file_lock = fake_lock
cache = Path(tempfile.mkdtemp(prefix="whale-lock-units-"))
for v, want in (({"lockWait": 0}, 0.0), ({}, 30.0), ({"lockWait": 12}, 12.0)):
    try:
        S._voxcpm_synthesize([{"mp3": str(cache / "x.mp3"), "key": "k", "text": "你好"}], {"voxcpm": v, "tts_cache_dir": str(cache)})
        raise AssertionError("应该报「显卡被占着」")
    except RuntimeError as e:
        assert "另一个渲染" in str(e), e
    assert seen[-1] == want, (v, seen)

print("studio upload units ok")
