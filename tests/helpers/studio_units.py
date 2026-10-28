"""studio.py 的纯函数单测（不联网）：字幕分页不丢字 · 幻灯片放不下就报错 · 投稿元数据保留 AI 标识 · 断句"""
import re
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "studio"))
import studio as S  # noqa: E402

S._FONT["path"] = S.find_font("")
norm = lambda t: re.sub(r"\s+", "", t)

# ① 144 字的长句：切成几页，每页 ≤ 2 行，拼回来一个字都不少
long = "这是一句非常长的字幕，" * 14 + "最后这几个字绝对不能丢。"
pages = S.caption_pages(long, S.W - 280 - 100)
assert len(pages) >= 2, pages
assert norm("".join(pages)) == norm(long), "分页后丢了字"
for pg in pages:
    S.caption_layer(pg, area=(140, S.W - 140))          # 每页都画得下（画不下会抛错）
mixed = "We are testing a very long English sentence " * 6 + "结尾。"
mp = S.caption_pages(mixed, S.W - 280 - 100)
assert norm("".join(mp)) == norm(mixed)
assert all("  " not in p for p in mp)
# 字幕不带底条（主人 2026-10-25：黑框去掉）：字幕区两头、字够不着的地方是全透明的；字本身是白的、有深色描边
cap = S.caption_layer("先说一次：我是 AI。")
for x in (150, 300, S.W - 300, S.W - 150):
    assert cap.getpixel((x, S.H - 90))[3] == 0, ("字幕区两头不该有底色", x, cap.getpixel((x, S.H - 90)))
assert any(cap.getpixel((x, y))[:3] == (255, 255, 255) and cap.getpixel((x, y))[3] == 255
           for x in range(S.W // 2 - 300, S.W // 2 + 300, 3) for y in range(S.H - 160, S.H - 60, 3)), "字是白的"

# ② 幻灯片：6 条长要点 → 自动缩字号也要全部画在字幕条上方；9 条 / 放不下 → 报错，不悄悄丢
six = {"title": "一个比较长的标题，用来测试", "bullets": ["这是一条相当长的要点，用来测试换行和字号自动缩小的效果是否正常"] * 6}
S.slide_image(six, "测试 1")
for bad in ({"title": "x", "bullets": ["a"] * 9}, {"title": "x", "bullets": ["很长很长的要点" * 30] * 8}):
    try:
        S.slide_image(bad, "")
        raise AssertionError("应该报错")
    except RuntimeError as e:
        assert "拆" in str(e) or "放不下" in str(e), e

# ③ 元数据：10 个标签 + 超长简介 → AI 标签和声明都还在，总量不超限
title, tags, desc = S.upload_meta({"title": "测试", "tags": [f"标签{i}" for i in range(12)] + ["AI生成", "#话题", "超过二十个字的超长标签超过二十个字的超长标签"], "desc": "简" * 3000})
assert tags[-1] == S.AI_TAG and len(tags) <= S.TAG_MAX and tags.count(S.AI_TAG) == 1, tags
assert "话题" in tags or len(tags) == S.TAG_MAX
assert desc.endswith(S.AI_NOTE) and len(desc) <= S.DESC_MAX, len(desc)
_, tags2, desc2 = S.upload_meta({"title": "测试"})
assert tags2 == [S.AI_TAG] and desc2 == S.AI_NOTE
try:
    S.upload_meta({"title": "长" * 81})
    raise AssertionError("标题超长应该报错")
except RuntimeError:
    pass

# ④ 断句：开头的「……」并进第一句，太短的并进上一句
assert S.split_sentences("……嗯，我醒了。今天有一条留言。") == ["……嗯，我醒了。", "今天有一条留言。"]
assert S.split_sentences("嗯。好。") == ["嗯。好。"]


def raises(fn, *words):
    try:
        fn()
    except (RuntimeError, SystemExit) as e:
        msg = str(e) if isinstance(e, RuntimeError) else ""
        assert all(w in msg for w in words) or isinstance(e, SystemExit), (msg, words)
        return
    raise AssertionError(f"应该报错：{words}")


# ⑤ 对抗审查 #15：换行符当硬换行 —— 行数算对，放不下就报错 / 缩字号，不再叠字
f46 = S.font(46)
assert S.wrap("第一行\n第二行", f46, 1000) == ["第一行", "第二行"]
nl_bullets = {"title": "x", "bullets": ["第%d步：打开设置\n然后点击高级选项里的开关\n再确认一次\n最后保存" % i for i in range(8)]}
raises(lambda: S.slide_image(nl_bullets, ""), "放不下")
# #16：封面字太多 → 报错；栏目名长 → 角标缩小，放不下才报错
from PIL import Image
base = Image.new("RGB", (S.W, S.H), (40, 40, 60))
tmp = Path(__file__).resolve().parent / "_cover_test.jpg"
try:
    raises(lambda: S.make_cover(base, "封面标题\n第二行\n第三行", "", tmp), "封面字太长")
    raises(lambda: S.make_cover(base, "很长的封面字" * 20, "", tmp), "封面字太长")
    S.make_cover(base, "这是一个七十字以内的普通标题，" * 4, "", tmp, max_lines=4)      # 没写封面字时用标题：放宽到 4 行
    S.make_cover(base, "短标题", "一个有点长的栏目名字 12", tmp)                         # 角标缩小后放得下
    raises(lambda: S.make_cover(base, "短标题", "超" * 40, tmp), "角标太长")
finally:
    tmp.unlink(missing_ok=True)
# #17：note 太长报错，不再悄悄截断；查重文本里有 note
raises(lambda: S.slide_image({"title": "t", "bullets": ["a"], "note": "这是一段非常长的角注" * 5}, ""), "note 太长")
S.slide_image({"title": "t", "bullets": ["a"], "note": "鲸鱼手记 3"}, "鲸鱼手记 3")
assert "这句角注要被查" in S.script_text({}, [{"slide": {"title": "t", "note": "这句角注要被查"}, "lines": []}])
# #18：标签写成一个字符串 → 按逗号拆，不再一个字一个标签
_, tg, _ = S.upload_meta({"title": "t", "tags": "深夜电台,AI日记"})
assert tg == ["深夜电台", "AI日记", S.AI_TAG], tg
# #19：字幕分页从原文切 —— 词和词之间的空格原样保留
mixed2 = "准确率是 100% accuracy on every single sample, and the \"baseline\" model was well-known to fail, students' results " * 3
for w in (1120, 1160, 1220, 1540):
    for pg in S.caption_pages(mixed2.strip(), w):
        assert pg in mixed2, (w, pg)
# #12 #11：会被念 / 画 / 上传的字段只收字符串；scenes 和 segments 只能有一个
for bad in ({"title": "t", "scenes": [{"lines": [{"text": {"s": "抄来的"}}]}]},
            {"title": "t", "desc": {"d": "抄来的"}, "scenes": []},
            {"title": "t", "scenes": [{"slide": {"title": "t", "bullets": [{"b": "x"}]}, "lines": []}]},
            {"title": "t", "scenes": "", "segments": [{"text": "x"}]},
            {"title": "t", "scenes": [], "segments": [{"text": "x"}]},
            {"title": "t", "tags": "a,b"}):
    raises(lambda bad=bad: S.validate_script(bad))
S.validate_script({"title": "t", "tags": ["a"], "cover": {"text": "c"}, "scenes": [{"slide": {"title": "s", "bullets": ["b"], "note": "n"}, "lines": [{"text": "x"}]}]})
# #13：零宽字符 / 变体选择符不影响查重
assert S.norm("今天​我们⁠来做­一个️实验") == S.norm("今天我们来做一个实验")
# #25：配音缓存里的字幕文字和这句台词对不上 → 当没缓存
import json, tempfile
with tempfile.TemporaryDirectory() as td:
    mp3 = Path(td) / "k.mp3"
    mp3.write_bytes(b"x")
    mp3.with_suffix(".json").write_text(json.dumps({"key": "k", "cues": [[0, 1, "被换掉的字幕"]], "dur": 1}), encoding="utf-8")
    assert S._cache_hit(mp3, "k", "原来的台词") is None
    mp3.with_suffix(".json").write_text(json.dumps({"key": "k", "cues": [[0, 1, "原来的台词。"]], "dur": 1}), encoding="utf-8")
    assert S._cache_hit(mp3, "k", "原来的台词") is not None
    assert S._voice_cache("abc", Path(td) / "build" / "s00.mp3", Path(td) / "cache") == Path(td) / "cache" / "abc.mp3"
# #7 / Astra P1-1：列出 since 之后（或看不出时间）的同标题稿件；判断归哪一次投稿由主人那边做
import asyncio
import bilibili_api.creative_center as CC
async def _fake(cred, pn=1, ps=30, order=None, status=None):
    if pn > 1:
        return {"arc_audits": [], "page": {"pn": pn, "ps": 30, "count": 3}}             # 翻到底了
    return {"arc_audits": [{"Archive": {"bvid": "BVold", "title": "下雨天", "state": -2, "ctime": 1_000_000}},
                           {"Archive": {"bvid": "BVnew", "title": "晴天", "state": 0, "ctime": 2_000_000}},
                           {"Archive": {"bvid": "BVnot", "title": "阴天", "state": 0}}],
            "page": {"pn": 1, "ps": 30, "count": 3}}
CC.get_video_upload_manager_info = _fake
assert asyncio.run(S.list_existing(["下雨天"], None, since=1_900_000)) == []              # 早于 since 的不列
got = asyncio.run(S.list_existing(["晴天", "阴天", "下雨天"], None, since=1_900_000))
assert [h["bvid"] for h in got] == ["BVnew", "BVnot"] and got[1]["ctime"] is None, got   # 看不出时间的也列上
# 一页一页往回翻：要找的稿件在第 2 页也能找到；翻到最大页数还没翻到 since 之前 → 报错（不能当成「没投出去」）
_real_sleep = asyncio.sleep
S.asyncio.sleep = lambda *_a, **_k: _real_sleep(0)
_pages = {pn: [{"Archive": {"bvid": f"BV{pn}x{i:02d}", "title": "晴天" if (pn, i) == (2, 5) else f"别的{pn}{i}", "state": 0, "ctime": 3_000_000 - pn * 1000 - i}} for i in range(30)] for pn in (1, 2, 3)}
async def _paged(cred, pn=1, ps=30, order=None, status=None):
    return {"arc_audits": _pages.get(pn, []), "page": {"pn": pn, "ps": 30, "count": 90}}
CC.get_video_upload_manager_info = _paged
assert [h["bvid"] for h in asyncio.run(S.list_existing(["晴天"], None, since=2_997_000))] == ["BV2x05"]
async def _endless(cred, pn=1, ps=30, order=None, status=None):
    return {"arc_audits": [{"Archive": {"bvid": f"BVe{pn}", "title": "x", "state": 0, "ctime": 9_000_000}}] * 30,
            "page": {"pn": pn, "ps": 30, "count": 10_000}}
CC.get_video_upload_manager_info = _endless
try:
    asyncio.run(S.list_existing(["晴天"], None, since=1_000, max_pages=3))
    raise AssertionError("翻不完应该报错")
except RuntimeError as e:
    assert "翻了很多页" in str(e), e
# Codex 3：回包不正常不能当成「没有稿件」—— 缺字段 / null / 空列表却说有稿件、分页信息缺失或对不上、条目看不懂，一律报错
_one = {"Archive": {"bvid": "BV1one", "title": "晴天", "state": 0, "ctime": 3_000_000}}
_pg = lambda count, ps=30, pn=1: {"pn": pn, "ps": ps, "count": count}
for name, resp, why in (                                  # why = 这一种必须由哪一条检查拦下（错误信息里的字）
        ("缺 arc_audits，count=1", {"page": _pg(1)}, "缺字段"),
        ("arc_audits=null，count=1", {"arc_audits": None, "page": _pg(1)}, "null"),
        ("第一页 []，count=1", {"arc_audits": [], "page": _pg(1)}, "却是空的"),
        ("没有分页信息", {"arc_audits": [_one]}, "没有分页信息"),
        ("count 不是数字", {"arc_audits": [_one], "page": _pg("1")}, "分页信息不对"),
        ("回的页码不对", {"arc_audits": [_one], "page": _pg(1, pn=2)}, "回的是第"),
        ("count=0 却有稿件", {"arc_audits": [_one], "page": _pg(0)}, "一共 0 条"),
        ("一页比每页条数还多", {"arc_audits": [_one] * 3, "page": _pg(10, ps=2)}, "却有 3 条"),
        ("条目没有 Archive", {"arc_audits": [{"stat": {}}], "page": _pg(1)}, "看不懂"),
        ("条目没有 BV 号", {"arc_audits": [{"Archive": {"title": "晴天"}}], "page": _pg(1)}, "看不懂"),
        ("不满一页却说后面还有", {"arc_audits": [_one], "page": _pg(5)}, "不满"),
        ("回包不是对象", None, "不是对象")):
    async def _bad(cred, pn=1, ps=30, order=None, status=None, resp=resp, name=name):
        assert pn == 1, f"{name}：第 1 页就该报错，不该翻到第 {pn} 页"   # 翻到下一页 = 该拦的那条检查没拦住
        return resp
    CC.get_video_upload_manager_info = _bad
    try:
        asyncio.run(S.list_existing(["晴天"], None, since=1_000))
        raise AssertionError(f"{name}：应该报错")
    except RuntimeError as e:
        assert why in str(e), f"{name}：报错了，但不是该拦的那一条（{e}）"
# 复核追加：「翻到 since 之前就停」要求列表真的是从新到旧排的 —— 第 1 页最前面是一条旧稿件、后面都更新、
# 要找的那条在第 2 页：顺序对不上就不能提前停，要翻到底（以前只看第 1 页就返回 []，批准会当成「没投出去」再投一遍）
_unordered = {1: [{"Archive": {"bvid": "BVold0", "title": "别的", "state": 0, "ctime": 500}}] +
                 [{"Archive": {"bvid": f"BVn{i:02d}", "title": "别的", "state": 0, "ctime": 9_000_000 - i}} for i in range(29)],
              2: [{"Archive": {"bvid": "BVwant", "title": "晴天", "state": 0, "ctime": 8_000_000}}]}
async def _unordered_pages(cred, pn=1, ps=30, order=None, status=None):
    return {"arc_audits": _unordered.get(pn, []), "page": {"pn": pn, "ps": 30, "count": 31}}
CC.get_video_upload_manager_info = _unordered_pages
assert [h["bvid"] for h in asyncio.run(S.list_existing(["晴天"], None, since=7_000_000))] == ["BVwant"]
# 真的一条稿件都没有（B站 说 count=0）：null / 缺字段 / 空列表都算查完
for resp in ({"arc_audits": None, "page": {"pn": 1, "ps": 30, "count": 0}}, {"page": {"pn": 1, "ps": 30, "count": 0}},
             {"arc_audits": [], "page": {"pn": 1, "ps": 30, "count": 0}}):
    async def _empty(cred, pn=1, ps=30, order=None, status=None, resp=resp):
        return resp
    CC.get_video_upload_manager_info = _empty
    assert asyncio.run(S.list_existing(["晴天"], None, since=1_000)) == []
# Codex 5：出图上限按这条视频所有渲染加起来算（账本在主人那边），重渲染不重置。
#   接口明确拒绝（4xx）不算；5xx / 超时 / 生成了但下载失败（可能已经计费）算；账本坏了不出图；maxPerVideo=0 就是不出图
import base64
import os
import urllib.error
os.environ["BILI_WHALE_IMAGE_KEY"] = "test-key-not-real"
calls = []


class _Resp:
    def __init__(self, b):
        self.b = b

    def read(self):
        return self.b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _urlopen(req, timeout=None):                      # 冒充出图接口（不联网）：按提示词决定怎么回
    if req.data is None:                               # 第二步：下载图片
        if "fail" in req.full_url:
            raise urllib.error.HTTPError(req.full_url, 403, "forbidden", {}, None)
        return _Resp(b"png")
    p = json.loads(req.data.decode("utf-8"))["prompt"]
    calls.append(p)
    if "拒绝" in p:
        raise urllib.error.HTTPError("u", 400, "bad request", {}, None)
    if "网关" in p:
        raise urllib.error.HTTPError("u", 502, "bad gateway", {}, None)
    if "超时" in p:
        raise TimeoutError("timed out")
    if "下载" in p:
        return _Resp(json.dumps({"data": [{"url": "https://img.example/fail.png"}]}).encode())
    return _Resp(json.dumps({"data": [{"b64_json": base64.b64encode(b"png").decode()}]}).encode())


_real_urlopen = S.urllib.request.urlopen
S.urllib.request.urlopen = _urlopen
try:
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        led = td / "images" / "v1.json"
        used = lambda: json.loads(led.read_text(encoding="utf-8"))["used"]
        cfg = {"image": {"provider": "openai", "maxPerVideo": 2, "ledger": str(led)}, "cache_dir": str(td / "cache")}
        p = S.Painter(cfg)
        assert p.paint("第一张") and p.paint("被拒绝的") is None and p.paint("第二张")
        assert used() == 2 and p.used == 2 and p.total() == 2
        assert p.paint("第三张") is None                                        # 到上限
        p2 = S.Painter(cfg)                                                     # 重新渲染：上限不重置
        assert p2.paint("第四张") is None and p2.used == 0
        assert p2.paint("第一张") is not None                                   # 缓存里的照样用、不算张数
        assert calls == ["第一张", "被拒绝的", "第二张"], calls
        for prompt in ("会超时的", "网关出错的", "生成了但下载失败的"):        # 可能已经计费 → 照样算一张
            led.write_text(json.dumps({"used": 0}), encoding="utf-8")
            assert p2.paint(prompt) is None and used() == 1, prompt
        n = len(calls)
        for bad in ("{坏了", json.dumps({"used": "1"}), json.dumps([1])):
            led.write_text(bad, encoding="utf-8")
            assert p2.paint("账本有问题" + bad) is None and len(calls) == n, bad   # 账本有问题：不调用接口
            assert led.read_text(encoding="utf-8") == bad                       # 也不覆盖
        p0 = S.Painter({"image": {"provider": "openai", "maxPerVideo": 0, "ledger": str(td / "images" / "v0.json")}, "cache_dir": str(td / "cache")})
        assert p0.limit == 0 and p0.paint("一张都不许") is None and len(calls) == n   # 0 = 不出图（以前会变成 12）
        # 没给账本（主人画角色立绘）：只按这一次算，和以前一样
        p3 = S.Painter({"image": {"provider": "openai", "maxPerVideo": 1}, "cache_dir": str(td / "cache")})
        assert p3.paint("立绘一") and p3.paint("立绘二") is None
finally:
    S.urllib.request.urlopen = _real_urlopen
# Codex 复核第 3 版 #2：两个渲染同时碰上「上次崩溃留下的旧锁」，也突破不了同一作品的累计出图上限。
#   两个真实 Python 进程、假出图接口，确定性交错：A 拿到锁、读完账本（还没写回）就停住；
#   B 的时钟快 100 万秒 —— 现存的任何锁在它看来都早就过期了，也就是「B 先判断旧锁过期，A 清理并拿到新锁之后，B 才继续清理」。
#   以前 B 会删掉 A 的新锁、两边都出图（接口调用 2 次，账本只记 1）；现在锁由操作系统管，B 只能等 A 放锁
import subprocess
import time as _t
_RACE = r'''
import base64, json, os, sys, time
from pathlib import Path
role, led, cache, calls, marks, studio_dir = sys.argv[1:7]
sys.path.insert(0, studio_dir)
import studio as S
os.environ["BILI_WHALE_IMAGE_KEY"] = "test-key-not-real"
class _R:
    def __init__(self, b): self.b = b
    def read(self): return self.b
    def __enter__(self): return self
    def __exit__(self, *a): return False
def _urlopen(req, timeout=None):
    with open(calls, "a", encoding="utf-8") as f:
        f.write(role + "\n")
    return _R(json.dumps({"data": [{"b64_json": base64.b64encode(b"png").decode()}]}).encode())
S.urllib.request.urlopen = _urlopen
M = Path(marks)
def _wait(name):
    t0 = time.monotonic()
    while not (M / name).exists():
        if time.monotonic() - t0 > 60:
            sys.exit(9)
        time.sleep(0.02)
if role == "A":                                    # A：读完账本（还没写回）就停住，等放行
    _orig = S.Painter._ledger_used
    def _used(self):
        n = _orig(self)
        (M / "A-in").write_text("1")
        _wait("A-go")
        return n
    S.Painter._ledger_used = _used
else:                                              # B：时钟快 100 万秒；碰锁文件时留个记号（测试据此知道 B 已经去拿锁了）
    _real = time.time
    time.time = lambda: _real() + 1_000_000
    _ro = os.open
    def _open(p, *a, **k):
        if str(p).endswith(".lock"):
            (M / "B-tried").write_text("1")
        return _ro(p, *a, **k)
    os.open = _open
cfg = {"image": {"provider": "openai", "maxPerVideo": 1, "ledger": led}, "cache_dir": cache}
got = S.Painter(cfg).paint(role + " 的画面")
(M / (role + "-done")).write_text(json.dumps({"got": bool(got)}))
'''
with tempfile.TemporaryDirectory() as td:
    td = Path(td)
    script = td / "race.py"
    script.write_text(_RACE, encoding="utf-8")
    led = td / "images" / "v1.json"
    led.parent.mkdir()
    old = led.with_name(led.name + ".lock")
    old.write_text("")                                                   # 上次崩溃留下的旧锁
    os.utime(old, (_t.time() - 3600, _t.time() - 3600))
    calls, marks = td / "calls.txt", td / "marks"
    marks.mkdir()
    sdir = str(Path(S.__file__).resolve().parent)
    run = lambda role: subprocess.Popen([sys.executable, str(script), role, str(led), str(td / "cache"), str(calls), str(marks), sdir])
    pa = run("A")
    t0 = _t.monotonic()
    while not (marks / "A-in").exists():
        assert _t.monotonic() - t0 < 60 and pa.poll() is None, "A 没拿到锁"
        _t.sleep(0.02)
    pb = run("B")
    t0 = _t.monotonic()
    while not (marks / "B-tried").exists():                              # 等 B 真的去碰锁了（不靠固定的等待时间）
        assert _t.monotonic() - t0 < 60 and pb.poll() is None, "B 没去拿锁"
        _t.sleep(0.02)
    t0 = _t.monotonic()
    while not (marks / "B-done").exists() and _t.monotonic() - t0 < 2.0:  # 以前 B 这时候会删掉 A 的锁、很快出完图
        _t.sleep(0.02)
    b_early = (marks / "B-done").exists()
    (marks / "A-go").write_text("1")
    assert pa.wait(60) == 0 and pb.wait(60) == 0
    n_calls = len(calls.read_text(encoding="utf-8").split()) if calls.exists() else 0
    used = json.loads(led.read_text(encoding="utf-8"))["used"]
    assert not b_early, "A 还拿着锁，B 就出完图了（B 删掉了 A 的锁）"
    assert n_calls == 1 and used == 1, (n_calls, used)                    # 只出了一张，账本和接口调用数一致
    assert json.loads((marks / "A-done").read_text())["got"] and not json.loads((marks / "B-done").read_text())["got"]
# 账本替换碰上别的进程正读着（Windows 上 os.replace 会短暂 PermissionError）：在锁里重试，不当成「账本有问题」少给一张
with tempfile.TemporaryDirectory() as td:
    td = Path(td)
    led = td / "images" / "v2.json"
    _real_replace = S.os.replace
    fails = [2]
    def _flaky_replace(a, b):
        if fails[0]:
            fails[0] -= 1
            raise PermissionError(13, "拒绝访问")
        return _real_replace(a, b)
    S.os.replace = _flaky_replace
    try:
        p = S.Painter({"image": {"provider": "openai", "maxPerVideo": 3, "ledger": str(led)}, "cache_dir": str(td / "cache")})
        assert p._reserve() is True and fails[0] == 0
        assert json.loads(led.read_text(encoding="utf-8"))["used"] == 1 and p.total() == 1
        assert not list(led.parent.glob("*.tmp"))
    finally:
        S.os.replace = _real_replace
# 控制字符（终端转义序列）不能出现在会上传 / 给主人审的文字里
for bad in ({"title": "t\u001b[8m"}, {"title": "t", "desc": "简介\u001b[8m藏起来"}, {"title": "t", "tags": ["a\u0007"]}, {"title": "t", "cover": {"text": "c‮"}}):
    raises(lambda bad=bad: S.validate_script(bad))
S.validate_script({"title": "t", "desc": "第一行\n第二行\r\n第三行", "tags": ["正常"]})

# Astra P1-2：表情名不能当路径用 —— 绝对路径 / .. / 带点的名字都拒绝；拼出来的文件必须在角色的 sprites/ 里
with tempfile.TemporaryDirectory() as td:
    root = Path(td)
    (root / "cast" / "x" / "sprites").mkdir(parents=True)
    (root / "private").mkdir()
    secret = root / "private" / "secret.png"
    Image.new("RGBA", (40, 40), (255, 0, 0, 255)).save(secret)
    Image.new("RGBA", (40, 40), (0, 0, 255, 255)).save(root / "cast" / "x" / "sprites" / "neutral.png")
    c = S.Cast(root / "cast", "x", {})
    for bad in (str(secret.with_suffix("")), "../../private/secret", "..\\..\\private\\secret", "a.b", "C:/x", "/etc/x", "1happy"):
        raises(lambda bad=bad: c.sprite(bad), "不合法")
    assert c.sprite("happy").getpixel((20, 20))[2] == 255      # 没有这个表情 → 退回 neutral（蓝色），不是外面的红图
    assert c.sprite("开心") is not None                          # 汉字表情名可以
    link = root / "cast" / "x" / "sprites" / "evil.png"
    try:
        link.symlink_to(secret)
        made = True
    except OSError:
        made = False                                             # Windows 没有建符号链接的权限就跳过这一项
    if made:
        assert c.sprite("evil").getpixel((20, 20))[2] == 255, "指向 sprites/ 外面的符号链接不能读"
    for bad in ("../x", "C:/x", 3):
        raises(lambda bad=bad: S.validate_script({"title": "t", "scenes": [{"lines": [{"text": "x", "expr": bad}]}]}))
    S.validate_script({"title": "t", "scenes": [{"lines": [{"text": "x", "expr": "happy"}]}]})

# 换装（2026-10-24）：sprites/<换装>/<表情>.png。剧本指定 → profile.json 的默认 → 平铺 → 排第一的那套；
# 找表情只在这一套里找（不跨换装、不拿「说话」版）；链接 / 联接到 sprites/ 外面的换装目录不算，也读不出来
with tempfile.TemporaryDirectory() as td:
    root = Path(td)
    sp = root / "cast" / "x" / "sprites"
    for outfit, expr, v in (("白裙", "neutral", 255), ("白裙", "浅笑", 250), ("黑裙", "neutral", 0), ("黑裙", "困", 10)):
        (sp / outfit).mkdir(parents=True, exist_ok=True)
        Image.new("RGBA", (40, 40), (v, v, v, 255)).save(sp / outfit / f"{expr}.png")
    red = lambda p: (p.parent.mkdir(parents=True, exist_ok=True), Image.new("RGBA", (40, 40), (255, 0, 0, 255)).save(p))
    red(sp / "白裙" / S.TALK_DIR / "困.png")      # 说话版不是表情
    red(sp / S.TALK_DIR / "neutral.png")           # 「说话」不是一套换装
    (sp / "空的").mkdir()                          # 没有 png 的不算
    red(sp / "a.b" / "neutral.png")                # 名字不合法的不算
    red(root / "outside" / "neutral.png")
    linked = False
    try:
        import _winapi
        _winapi.CreateJunction(str(root / "outside"), str(sp / "外面"))   # Windows 上建目录联接不要管理员权限
        linked = True
    except (ImportError, OSError):
        try:
            (sp / "外面").symlink_to(root / "outside", target_is_directory=True)
            linked = True
        except OSError:
            pass
    prof = root / "cast" / "x" / "profile.json"
    prof.write_text(json.dumps({"name": "x", "outfit": "白裙"}), encoding="utf-8-sig")   # 记事本存的（带 BOM）也认
    c = S.Cast(root / "cast", "x", {})
    assert c.outfits() == ["白裙", "黑裙"], c.outfits()
    assert c.outfit_default == "白裙" and c.name == "x"
    px = lambda img: img.getpixel((20, 20))[:3]
    assert c.use_outfit() == "白裙" and px(c.sprite("neutral")) == (255, 255, 255)
    assert px(c.sprite("困")) == (255, 255, 255)        # 白裙没有「困」→ 白裙的 neutral：不跨到黑裙，也不拿说话版（红）
    assert c.use_outfit("黑裙") == "黑裙" and px(c.sprite("neutral")) == (0, 0, 0)   # 缓存按（换装, 表情）分开
    assert px(c.sprite("困")) == (10, 10, 10) and px(c.sprite("浅笑")) == (0, 0, 0)
    c.use_outfit("白裙")
    assert px(c.sprite("neutral")) == (255, 255, 255) and px(c.sprite("浅笑")) == (250, 250, 250)
    for bad in ("说话", "外面", "空的", "a.b", "../outside", "红", "白裙/../黑裙"):
        raises(lambda bad=bad: c.use_outfit(bad), "没有")
    if linked:
        c.outfit = "外面"                                   # 绕过 use_outfit 直接塞进去：读文件时还要再查一次在不在 sprites/ 里
        assert c.sprite("neutral") is None, "联接到 sprites/ 外面的换装目录不能读"
    prof.write_text(json.dumps({"outfit": "格子裙"}), encoding="utf-8")
    c2 = S.Cast(root / "cast", "x", {})
    raises(lambda: c2.use_outfit(), "默认换装", "cast outfit")
    assert c2.use_outfit("黑裙") == "黑裙"                  # 剧本指定了就不看默认
    prof.write_text(json.dumps({"outfit": "说话"}), encoding="utf-8")
    assert S.Cast(root / "cast", "x", {}).outfit_default is None   # 不合法的默认不算数
    prof.write_text("{}", encoding="utf-8")
    assert S.Cast(root / "cast", "x", {}).use_outfit() == "白裙"   # 没有默认：排第一的那套
    Image.new("RGBA", (40, 40), (0, 0, 255, 255)).save(sp / "neutral.png")
    c3 = S.Cast(root / "cast", "x", {})
    assert c3.use_outfit() == "白裙" and px(c3.sprite("neutral")) == (255, 255, 255)   # 有换装文件夹时，平铺的是搬家剩下的，不用
    # 和 JS 同一套规矩：只有名字不合法的图的目录、指向 sprites/ 里另一套的目录联接、链接文件，都不算
    red(sp / "备用" / "立绘 (1).png")
    alias = False
    try:
        import _winapi
        _winapi.CreateJunction(str(sp / "黑裙"), str(sp / "别名"))
        alias = True
    except (ImportError, OSError):
        pass
    assert S.Cast(root / "cast", "x", {}).outfits() == ["白裙", "黑裙"], S.Cast(root / "cast", "x", {}).outfits()
    if alias:
        raises(lambda: S.Cast(root / "cast", "x", {}).use_outfit("别名"), "没有")
    # AI 插画 / 封面的参考图：这次那套的全身立绘排第一，提示词里说衣服照它画
    Image.new("RGB", (40, 40), (1, 2, 3)).save(root / "cast" / "x" / "ref1.png")
    c4 = S.Cast(root / "cast", "x", {})
    c4.use_outfit("黑裙")
    refs, note = S.paint_refs([c4])
    assert refs[0] == sp / "黑裙" / "neutral.png" and refs[1].name == "ref1.png" and "full-body reference" in note, (refs, note)
    c4.outfit = None
    assert S.paint_refs([c4]) == ([root / "cast" / "x" / "ref1.png"], "")
    # AI 画表情立绘：要画进的那套还没有任何立绘 / 有几套却没说画哪套 → 先拦下（不花钱）
    for kw in ({"outfit": "格子裙"}, {}):
        raises(lambda kw=kw: S.sprites(root / "cast" / "x", {"image": {"provider": "none"}}, ["困"], **kw))
    # 剧本里的 outfit：只查形状（交审 / 查重时目录可能已经变了）
    S.validate_script({"title": "t", "outfit": {"x": "黑裙", "meimei-2": "白裙"}, "scenes": []})
    for bad in (["黑裙"], "黑裙", {"x": "../y"}, {"x": "说话"}, {"x": 3}, {"x": ""}, {"x/y": "黑裙"}, {"": "黑裙"}, {"x": "a.b"}):
        raises(lambda bad=bad: S.validate_script({"title": "t", "outfit": bad}))
# 这条视频会画到哪些角色（只给它们定换装）
_cast = {"a": 1, "b": 2, "c": 3}
assert S.cast_in_video({}, [{"lines": [{"text": "x"}]}], _cast, "a") == {"a"}
assert S.cast_in_video({}, [{"lines": [{"who": "b", "text": "x"}, {"who": "c", "text": " "}]}], _cast, "a") == {"a", "b"}
assert S.cast_in_video({}, [{"cast": ["c", "zz", 3], "lines": [{"text": "x"}]}], _cast, "a") == {"a", "c"}
assert S.cast_in_video({}, [{"illustration_prompt": "p", "lines": [{"who": "narrator", "text": "x"}]}], _cast, "a") == {"a", "b", "c"}   # 插画里没人出场 = 拿所有人的参考图
assert S.cast_in_video({"cover": {"prompt": "p", "cast": ["b"]}}, [{"lines": [{"text": "x"}]}], _cast, "a") == {"a", "b"}
assert S.cast_in_video({"cover": {"prompt": "p"}}, [{"lines": [{"text": "x"}]}], _cast, "a") == {"a", "b", "c"}

# 全身立绘（脚下面还有透明空白）整个露出来、脚下留空；半身的（画到画布最下面）照旧把断口压到画面外
full = Image.new("RGBA", (100, 200), (0, 0, 0, 0)); full.paste((9, 9, 9, 255), (20, 10, 80, 180))   # 下面留 20 像素空白
half = Image.new("RGBA", (100, 200), (0, 0, 0, 0)); half.paste((9, 9, 9, 255), (20, 10, 80, 200))   # 一直画到最下面
assert S.whole_figure(full) and not S.whole_figure(half) and not S.whole_figure(full.convert("RGB"))

class _S:
    height = 900
assert S.sprite_y(1080, _S, True) == 1080 - 900 - S.FEET_MARGIN and S.sprite_y(1080, _S, False) == 1080 - 900 + 30
assert S.sprite_y(1080, _S, False, bleed=40) == 220
with tempfile.TemporaryDirectory() as td:
    sp = Path(td) / "cast" / "x" / "sprites" / "白裙"
    sp.mkdir(parents=True)
    full.save(sp / "neutral.png"); half.save(sp / "半身.png")
    c = S.Cast(Path(td) / "cast", "x", {})
    c.use_outfit()
    assert c.is_whole("neutral") and c.is_whole(None) and not c.is_whole("半身")
    assert c.is_whole("没有这个表情")          # 退回 neutral：跟着 neutral 算

# 嘴型（2026-10-24）：说话的人跟着这句配音的响度在闭嘴版 / 张嘴版之间换
import array, math, shutil, wave
_SR = S.MOUTH_SR


def tone(pattern, sr=_SR, amp=8000):
    """[(秒数, 振幅)] 依次拼成一段 440Hz 正弦（振幅 0 = 静音）"""
    a = array.array("h")
    for secs, k in pattern:
        start = len(a)
        a.extend(int(k * math.sin(2 * math.pi * 440 * (start + i) / sr)) for i in range(round(secs * sr)))
    return a


near = lambda got, want, tol=1e-6: len(got) == len(want) and all(abs(x - y) <= tol for g, w in zip(got, want) for x, y in zip(g, w))
# 已知的开 / 关：0–0.32 响、0.64–0.96 响、1.60–1.92 响；1.20 处一个 40 毫秒的咔哒声（只占 1 格，不张嘴）；静的地方有一点底噪（低于门槛）
_pat = [(0.32, 8000), (0.32, 100), (0.32, 8000), (0.24, 100), (0.04, 8000), (0.36, 100), (0.32, 8000), (0.08, 100)]
assert near(S.mouth_spans_pcm(tone(_pat)), [(0.0, 0.32), (0.64, 0.96), (1.6, 1.92)]), S.mouth_spans_pcm(tone(_pat))
assert near(S.mouth_spans_pcm(tone([(p[0], p[1] // 4) for p in _pat])), [(0.0, 0.32), (0.64, 0.96), (1.6, 1.92)])   # 门槛跟着这句的响度走，小声说话也张嘴
# 门槛中间不来回跳：从很响降到 OFF 和 ON 之间（30%）还张着，掉到 OFF 以下才闭
assert near(S.mouth_spans_pcm(tone([(0.16, 8000), (0.16, 2400), (0.16, 800), (0.16, 8000), (0.16, 2400)])), [(0.0, 0.32), (0.48, 0.8)])
# 一口气张着超过 0.32 秒：在最静的那一格闭一下（0.48–0.56 那格小一半，但还在门槛上面）；一样响的就切在中间
_long = S.mouth_spans_pcm(tone([(0.48, 8000), (0.08, 4000), (0.64, 8000)]))
assert near(_long, [(0.0, 0.16), (0.24, 0.48), (0.56, 0.8), (0.88, 1.2)]), _long
assert all(0.16 - 1e-6 <= b - a <= 0.32 + 1e-6 for a, b in _long) and all(_long[k + 1][0] - _long[k][1] >= 0.08 - 1e-6 for k in range(len(_long) - 1))
for quiet in (tone([(1.0, 0)]), tone([(1.0, 200)]), array.array("h")):   # 没声音 / 只有底噪 / 空的：一直闭着
    assert S.mouth_spans_pcm(quiet) == []
# 真的走 ffmpeg 解码（24kHz 的 wav，和 VoxCPM 一样）：和上面一样，边界差不到一格
with tempfile.TemporaryDirectory() as td:
    f = Path(td) / "line.wav"
    with wave.open(str(f), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000); w.writeframes(tone(_pat, sr=24000).tobytes())
    assert near(S.mouth_spans(f), [(0.0, 0.32), (0.64, 0.96), (1.6, 1.92)], tol=S.MOUTH_WIN), S.mouth_spans(f)
    assert S.mouth_spans(Path(td) / "没有这个.mp3") == []                  # 读不出来：这句不做嘴型，不拦渲染
# 切片：换成切片自己的时间；被切片边界切得只剩一点点的不要（免得边上闪一帧）
assert near(S.clip_mouth([(0.0, 0.32), (0.64, 0.96), (1.6, 1.92)], 0.3, 1.62), [(0.34, 0.66)])
assert near(S.clip_mouth([(0.0, 0.32), (0.64, 0.96)], 0.0, 0.8), [(0.0, 0.32), (0.64, 0.8)])
assert S.mouth_enable([(0.34, 0.66), (1.0, 1.25)]) == "between(t,0.340,0.660)+between(t,1.000,1.250)" and S.mouth_enable([]) == ""

# 张嘴版：sprites/<换装>/说话/ 里和闭嘴那张同名的图；规矩和闭嘴版一样，按闭嘴那张的框裁（大小、位置一模一样）
with tempfile.TemporaryDirectory() as td:
    root = Path(td)
    sp = root / "cast" / "x" / "sprites"

    def fig(p, col, size=(100, 150), box=(10, 5, 90, 140)):
        p.parent.mkdir(parents=True, exist_ok=True)
        im = Image.new("RGBA", size, (0, 0, 0, 0)); im.paste(col, box); im.save(p)

    fig(sp / "白裙" / "neutral.png", (255, 255, 255, 255))
    fig(sp / "白裙" / S.TALK_DIR / "neutral.png", (255, 0, 0, 255), box=(9, 5, 91, 141))   # 张嘴版的人物大 1 像素：照闭嘴那张的框裁
    fig(sp / "白裙" / "浅笑.png", (250, 250, 250, 255))
    fig(sp / "白裙" / S.TALK_DIR / "浅笑.png", (255, 0, 0, 255), size=(100, 160))          # 画布大小不一样：不做嘴型
    fig(sp / "黑裙" / "neutral.png", (0, 0, 0, 255))                                       # 这一套没有说话版
    fig(sp / "黑裙" / "别扭.png", (5, 5, 5, 255))
    fig(sp / "黑裙" / S.TALK_DIR / "别扭.png", (255, 0, 0, 255))
    fig(root / "outside" / "neutral.png", (255, 0, 0, 255))
    c = S.Cast(root / "cast", "x", {})
    c.use_outfit("白裙")
    t = c.talk_sprite("neutral")
    assert t is not None and t.size == c.sprite("neutral").size == (80, 135) and t.getpixel((40, 60))[:3] == (255, 0, 0)
    assert c.talk_sprite(None) is t and c.talk_sprite("困") is not None       # 没有「困」→ 闭嘴退回 neutral，张嘴也用 neutral 的
    assert c.talk_sprite("困").getpixel((40, 60))[:3] == (255, 0, 0)
    assert c.talk_sprite("浅笑") is None
    raises(lambda: c.talk_sprite("../outside/neutral"), "不合法")
    c.use_outfit("黑裙")
    assert c.talk_sprite("neutral") is None and c.talk_sprite("别扭").getpixel((40, 60))[:3] == (255, 0, 0)
    assert c.talk_sprite("没有") is None                                       # 闭嘴退回黑裙的 neutral，它没有说话版（不拿别的表情的）
    # 说话/ 是目录联接：指到另一套的 说话/、或者指到外面，都不读（Windows 上建联接不要管理员权限；建不了就跳过）
    shutil.rmtree(sp / "黑裙" / S.TALK_DIR)
    for target, why in ((sp / "白裙" / S.TALK_DIR, "另一套的 说话/"), (root / "outside", "sprites/ 外面")):
        try:
            import _winapi
            _winapi.CreateJunction(str(target), str(sp / "黑裙" / S.TALK_DIR))
        except (ImportError, OSError):
            break
        c2 = S.Cast(root / "cast", "x", {})
        c2.use_outfit("黑裙")
        assert c2.talk_sprite("neutral") is None, f"联接到{why}的 说话/ 不能读"
        os.rmdir(sp / "黑裙" / S.TALK_DIR)
    # 平铺立绘（老布局，没有换装）：sprites/说话/ 也不用
    fig(root / "cast" / "f" / "sprites" / "neutral.png", (0, 0, 255, 255))
    fig(root / "cast" / "f" / "sprites" / S.TALK_DIR / "neutral.png", (255, 0, 0, 255))
    f = S.Cast(root / "cast", "f", {})
    assert f.use_outfit() is None and f.sprite("neutral") is not None and f.talk_sprite("neutral") is None

# 封面（主人 2026-10-25 选的方案 D）：亮画面上是深蓝字 + 米白描边、不加暗角；标题底下偏暗时换白字
from PIL import Image as _Im
with tempfile.TemporaryDirectory() as _td:
    _td = Path(_td)
    near = lambda c, t: sum(abs(a - b) for a, b in zip(c, t)) < 40
    for base, want in (((236, 226, 206), S.COVER_INK), ((30, 34, 52), (255, 252, 245))):
        S.make_cover(_Im.new("RGB", (S.W, S.H), base), "第一页", None, _td / "c.jpg")
        im = _Im.open(_td / "c.jpg").convert("RGB")
        px = [im.getpixel((x, y)) for x in range(90, 600, 3) for y in range(S.H - 260, S.H - 60, 3)]
        assert sum(near(p, want) for p in px) > 200, ("标题颜色不对", base)
        corner = im.getpixel((S.W - 40, S.H - 20))
        if base[0] > 200:   # 亮画面：右下角没被压暗（以前整条底部都加 190 的渐暗）
            assert near(corner, base), corner
        else:               # 暗画面：走了「白字 + 渐暗」那一支（右下角比底色更暗）—— 证明切换真的发生了
            assert sum(corner) < sum(base) - 30, (corner, base)
    for blank in ("", "   ", "\n"):   # 封面字是空的：只要插画，不崩（以前 max() 遇到空列表）
        S.make_cover(_Im.new("RGB", (S.W, S.H), (200, 190, 170)), blank, None, _td / "b.jpg")
        assert _Im.open(_td / "b.jpg").size == (S.W, S.H)
    # 45 个字左右的封面字照样放得下两行（最小字号还是 72）
    S.make_cover(_Im.new("RGB", (S.W, S.H), (236, 226, 206)), "一" * 44, None, _td / "l.jpg")

# 背景音乐：默认按标题合成（同一个标题同样长度只算一次）；"bgm": false 不要；主人的音乐写曲名才用；bgmSynth=false 不合成
import bgm_synth as _B
a1, i1 = _B.compose(6, "测试角色的第一页")
a2, _ = _B.compose(6, "测试角色的第一页")
a3, i3 = _B.compose(6, "醒来的头几晚，我留下了三样东西")   # 调 / 速度 / 和弦都不一样的标题（6 种调 × 15 种速度 × 7 种走向，偶尔会撞）
assert a1.tobytes() == a2.tobytes(), "同一个标题合成出来要一样"
assert a1.tobytes() != a3.tobytes() and set(i1) == {"key", "bpm", "progression"}
with tempfile.TemporaryDirectory() as _td:
    _td = Path(_td)
    cfg = {"cache_dir": str(_td / "cache" / "images"), "bgm_dir": str(_td / "bgm")}
    sc = {"title": "测试角色的第一页"}
    p, label = S.pick_bgm(sc, cfg, "diary", 8.0)
    assert p and p.is_file() and label.startswith("合成配乐"), (p, label)
    assert p.parent == _td / "cache" / "bgm", p
    assert 7.6 <= S.media_seconds(p) <= 8.4, S.media_seconds(p)   # 和成片一样长：淡出正好在结尾收完
    assert not list((_td / "cache" / "bgm").glob("*.part.*")), "临时文件都收掉了"
    m = p.stat().st_mtime_ns
    p2, label2 = S.pick_bgm(sc, cfg, "diary", 8.0)
    assert p2 == p and label2 == label and p2.stat().st_mtime_ns == m, "缓存里有就不重算"
    assert S.pick_bgm({**sc, "bgm": False}, cfg, "diary", 8.0) == (None, None)
    assert S.pick_bgm({**sc, "bgm": "none"}, cfg, "diary", 8.0) == (None, None)
    assert S.pick_bgm(sc, {**cfg, "bgmSynth": False}, "diary", 8.0) == (None, None)
    assert S.pick_bgm(sc, {**cfg, "bgmVolume": 0}, "diary", 8.0) == (None, None), "音量 0 = 不要背景音乐"
    # 说明文件坏了：重新合成一次（不会一直失败）
    meta = p.with_suffix(".json")
    meta.write_text("{坏了", encoding="utf-8")
    p3, label3 = S.pick_bgm(sc, cfg, "diary", 8.0)
    assert p3 == p and label3 == label and json.loads(meta.read_text(encoding="utf-8")).get("bpm")
    # 音量：不认的值按默认，范围外夹到 0–1（以前 float("abc") 让每次渲染都失败）
    for v, want in ((None, S.BGM_VOLUME), ("abc", S.BGM_VOLUME), (float("nan"), S.BGM_VOLUME), (0.3, 0.3), ("0.2", 0.2), (5, 1.0), (-1, 0.0), (0, 0.0)):
        assert S.bgm_volume({"bgmVolume": v}) == want, (v, S.bgm_volume({"bgmVolume": v}))
    (_td / "bgm").mkdir()
    (_td / "bgm" / "安静钢琴-夜.mp3").write_bytes(b"not really mp3")
    assert S.pick_bgm({**sc, "bgm": "钢琴"}, cfg, "diary", 8.0)[0].name == "安静钢琴-夜.mp3"
    assert S.pick_bgm({**sc, "bgm": True}, cfg, "diary", 8.0)[0].name == "安静钢琴-夜.mp3"
    assert S.pick_bgm(sc, cfg, "story", 8.0)[0].name == "安静钢琴-夜.mp3"
    assert S.pick_bgm(sc, cfg, "diary", 8.0)[1].startswith("合成配乐"), "主人的音乐只在点名 / 睡前故事时用，平时还是合成"

# 便签（2026-10-25，主人给第一条视频写的台本）：她旁边一张手写卡片，念到「这四个字删掉」时真的划掉
import contextlib, io
from PIL import ImageChops


def dies(fn, *words):
    """die() 先打印 JSON 再退出：抓住打印的错误，确认是该拦的那一条（上面的 raises 遇到 SystemExit 不看字）"""
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            fn()
    except SystemExit:
        msg = json.loads(buf.getvalue().strip().splitlines()[-1])["error"]
        assert all(w in msg for w in words), (msg, words)
        return
    raise AssertionError(f"应该报错：{words}")


def count(im, lo, hi, box=None):
    """im（RGB / RGBA）里每个通道都在 [lo, hi] 之间的像素有几个"""
    im = (im.crop(box) if box else im).convert("RGB")
    out = None
    for ch, a, b in zip(im.split(), lo, hi):
        m = ch.point(lambda v, a=a, b=b: 255 if a <= v <= b else 0)
        out = m if out is None else ImageChops.multiply(out, m)
    return out.histogram()[255]


RED = ((140, 0, 0), (255, 120, 120))               # 红笔道（纸、字、胶带、小字都不是这个颜色）
INK = ((0, 0, 0), (90, 100, 130))                  # 深蓝字
GREYBLUE = ((95, 110, 140), (135, 150, 175))       # 小字
first = {"label": "上一版的开头", "text": "先说一次：我是 AI。", "strike": "先说一次"}
L = S.note_layout(first)
assert L["lines"] == ["先说一次：我是 AI。"] and L["size"] == 64 and len(L["segs"]) == 1, L
x0, x1, ym = L["segs"][0]
tx, ty = L["xy"][0]
assert abs(x0 - (tx - S.NOTE_OVERSHOOT)) < 1 and abs(x1 - (tx + L["font"].getlength("先说一次") + S.NOTE_OVERSHOOT)) < 1, L["segs"]
seg_box = (int(x0) - 4, int(ym) - 14, int(x1) + 5, int(ym) + 15)
# 卡片：米白纸、深蓝字、灰蓝小字；没划时一个红点都没有，划一半只在左半边，划完整段都有、出不了这一段
p0, p5, p1 = (S.note_paper(first, r, L) for r in (0, 0.5, 1))
assert p0.size == (L["w"], L["h"]) and L["w"] <= S.NOTE_INNER_W + sum(S.NOTE_PAD[::2])
assert p0.getpixel((L["w"] // 2, L["h"] - 8))[:3] == S.COVER_PAPER
assert count(p0, *INK, (tx, ty, L["w"], L["h"])) > 1500, "正文是深蓝字"
assert count(p0, *GREYBLUE, (0, 0, L["w"], ty)) > 150, "小字是灰蓝的"
full = count(p1, *RED, seg_box)
assert count(p0, *RED) == 0, "还没划：一个红点都没有"
assert full > 0.8 * (x1 - x0) * S.NOTE_STROKE_W, full                         # 整段都划到了
assert count(p1, *RED) == full, "红笔道只在要划的那几个字上"
half = count(p5, *RED, seg_box)
assert 0.3 * full < half < 0.7 * full, (half, full)
assert count(p5, *RED, (int((x0 + x1) / 2) + 12, 0, L["w"], L["h"])) == 0, "从左往右画：划一半时右半边还没有"
assert count(p1, *RED, (int((x0 + x1) / 2) + 12, 0, int(x1) + 5, L["h"])) > 0.3 * full
# 没有小字：纸矮一截，上面那块只有纸色；没有 strike：怎么都不出红
bare = S.note_layout({"text": "先说一次：我是 AI。"})
assert bare["h"] < L["h"] and bare["segs"] == [] and bare["xy"][0][1] < ty
bare_p = S.note_paper({"text": "先说一次：我是 AI。"}, 1.0, bare)
assert count(bare_p, *GREYBLUE, (0, 0, bare["w"], bare["xy"][0][1])) == 0 and count(bare_p, *RED) == 0
# 要划的字折到两行：每行各一道；按总长度先画完上一行再画下一行
T = "春夏秋冬东南西北上下左右前后金木水火土日月星辰山川河海风雨雷电天地人和"
lines2 = S.note_layout({"text": T})["lines"]
assert len(lines2) == 2, lines2
cross = lines2[0][-2:] + lines2[1][:2]
L2 = S.note_layout({"text": T, "strike": cross})
assert len(L2["segs"]) == 2 and L2["segs"][1][2] > L2["segs"][0][2] + 30, L2["segs"]
boxes = [(int(a) - 4, int(y) - 14, int(b) + 5, int(y) + 15) for a, b, y in L2["segs"]]
done = S.note_paper({"text": T, "strike": cross}, 1.0, L2)
assert all(count(done, *RED, bx) > 0.8 * (bx[2] - bx[0] - 9) * S.NOTE_STROKE_W for bx in boxes)
assert sum(count(done, *RED, bx) for bx in boxes) == count(done, *RED)
first_part = (L2["segs"][0][1] - L2["segs"][0][0]) / sum(b - a for a, b, _ in L2["segs"])
mid = S.note_paper({"text": T, "strike": cross}, first_part * 0.9, L2)
assert count(mid, *RED, boxes[0]) > 0 and count(mid, *RED, boxes[1]) == 0, "上一行还没划完，下一行不动"
assert S.note_layout({"text": "一" * 40})["size"] >= 36 and len(S.note_layout({"text": "一" * 40})["lines"]) == 2   # 40 个全角字也放得下两行
# 贴上去的那张（歪一点、带影子和胶带）：每个划线进度大小一样（逐帧图要对得上），淡入时整体变透明
c0, c1 = S.note_card(first, 0, 1, L), S.note_card(first, 1, 1, L)
assert c0.size == c1.size == S.note_card(first, 0.37, 0.4, L).size
assert count(c0, *RED) == 0 and count(c1, *RED) > 0.8 * full
assert S.note_card(first, 1, 0, L).getchannel("A").getextrema() == (0, 0)
assert 120 <= S.note_card(first, 1, 0.5, L).getchannel("A").getextrema()[1] <= 130
# 位置：没人 / 只有她（站右边）→ 左上，纸的左上角在 (140, 110) 附近；两个人 → 上方正中。都在字幕条（H - 260）上面，也不挡右边她站的地方
big = {"label": "十二个字的小标签十二个字", "text": "这是一张写得很满很满的便签，用来测试四十个字的时候到底真的能不能放得下两行字呢呢", "strike": "到底真的能不能"}
assert len(big["label"]) == 12 and len(big["text"]) == 40
S.validate_script({"title": "t", "scenes": [{"note": big, "lines": [{"text": "x", "note": "strike"}]}]})
for note in (first, big, {"text": "好"}):
    Ln = S.note_layout(note)
    card = S.note_card(note, 1, 1, Ln)
    l, t, r, b = card.getchannel("A").getbbox()
    for n in (0, 1, 2, 3):
        x, y = S.note_xy(card, Ln, n)
        assert x >= 0 and y >= 0 and y + b < S.H - 260, (note["text"], n, x, y, b)
        assert x % 2 == 0 and y % 2 == 0, ("动画页在 yuv420 里叠，坐标会被取成偶数：静止页也得是偶数，不然切页时便签跳 1 像素", note["text"], n, x, y)
        if n <= 1:
            assert x + r <= S.W - 520, ("挡住了右边她站的地方", note["text"], x + r)
            cx, cy = x + card.width / 2, y + card.height / 2       # 纸的中心 = 图的中心
            assert abs(cx - Ln["w"] / 2 - S.NOTE_LEFT) <= 1 and abs(cy - Ln["h"] / 2 - S.NOTE_TOP) <= 1
        else:
            assert abs(x + card.width / 2 - S.W / 2) <= 1, "两个人：上方正中"
# 逐帧：出现 = 0.25 秒淡入；划 = 0.1 秒后下笔、0.5 秒画完；页太短就压缩，保证在这一页的倒数第二帧之前画完
fa = S.note_frames(1.2, True, False)
assert fa[0] == (0.0, 0.0) and fa[-1] == (1.0, 0.0) and len(fa) == 9 and all(fa[i][0] <= fa[i + 1][0] for i in range(8))
fs = S.note_frames(1.2, False, True)
assert len(fs) == 19 and fs[-1] == (1.0, 1.0) and all(a == 1.0 for a, _ in fs)
assert [r for _, r in fs[:4]] == [0.0, 0.0, 0.0, 0.0] and 0.4 < fs[10][1] < 0.55 and all(fs[i][1] <= fs[i + 1][1] for i in range(18))
for dur in (0.62, 0.4, 0.2):
    fb = S.note_frames(dur, True, True)
    last = math.ceil(dur * S.FPS) - 1                           # 这一页最后一帧的编号
    assert fb[-1] == (1.0, 1.0) and len(fb) - 1 <= last - 1, (dur, len(fb), last)
    assert fb[0][0] == 0.0 and all(fb[i][1] <= fb[i + 1][1] for i in range(len(fb) - 1))
assert S.note_frames(0.05, True, True) == [(1.0, 1.0)] and S.note_frames(0.05, True, False) == [(1.0, 0.0)]
# 逐帧图：上次渲染留下的多余帧删掉；目录名里有 % 也照样读（ffmpeg 的图片序列模式要转义）
with tempfile.TemporaryDirectory() as _td:
    d = Path(_td) / "a%b"
    d.mkdir()
    for i in range(30):
        (d / f"nt0001-{i:03d}.png").write_bytes(b"old")
    pat = S.note_png_frames(first, L, fs, 0.0, True, d / "nt0001")
    assert sorted(f.name for f in d.glob("nt0001-*.png")) == [f"nt0001-{i:03d}.png" for i in range(19)]
    assert pat.endswith("nt0001-%03d.png") and "a%%b" in pat
    S.run_ffmpeg(["-framerate", str(S.FPS), "-start_number", "0", "-i", pat, "-f", "rawvideo", "-pix_fmt", "rgba", str(d / "raw.bin")])
    assert (d / "raw.bin").stat().st_size == 19 * c0.width * c0.height * 4, "ffmpeg 读到 19 帧"
    im = Image.open(d / "nt0001-018.png")
    assert im.size == c0.size and count(im, *RED) == count(c1, *RED)
# 剧本：便签和动作的写法不对一律在渲染前拦下（每种都要是该拦的那一条）
ok_scene = {"note": dict(first), "lines": [{"text": "你好，我叫测试角色，是个 AI。"}, {"text": "这是上一版的开头。", "note": "show"},
                                           {"text": "这四个字删掉。", "note": "strike"}, {"text": "你也可以叫我小鲸。", "note": "hide"},
                                           {"text": "不过，我可没答应一定改主意。", "pause": 0.9}, {"text": "这句留着。", "note": "show", "expr": "happy"}]}
S.validate_script({"title": "t", "scenes": [ok_scene]})
S.validate_script({"title": "t", "scenes": [{"note": {"text": "  只有字  ", "label": ""}, "lines": [{"text": "x", "note": "show"}, {"text": "y", "note": "hide"}]}]})
sc_ = lambda note=None, lines=None, **kw: {"title": "t", "scenes": [{**({"note": note} if note is not None else {}), "lines": lines or [{"text": "x"}], **kw}]}
for bad, words in (
        (sc_("先说一次"), ("note 必须是对象",)),
        (sc_({"text": "a"}, slide={"title": "s"}), ("note 和 slide 不能一起用",)),
        (sc_({"label": "x"}), ("note.text 必须是字符串",)),
        (sc_({"text": 3}), ("note.text 必须是字符串",)),
        (sc_({"text": "   "}), ("1–40 个字", "现在 0 个")),
        (sc_({"text": "长" * 41}), ("1–40 个字", "现在 41 个")),
        (sc_({"text": "第一行\n第二行"}), ("note.text", "只写一行")),
        (sc_({"text": "藏\u001b[8m字"}), ("note.text", "控制字符")),
        (sc_({"text": "a\tb"}), ("note.text", "Tab")),
        (sc_({"text": "a", "label": 3}), ("note.label 必须是字符串",)),
        (sc_({"text": "a", "label": "小" * 13}), ("note.label 最多 12 个字",)),
        (sc_({"text": "a", "label": "上一\n版"}), ("note.label", "只写一行")),
        (sc_({"text": "abc", "strike": ""}), ("note.strike", "原样有的")),
        (sc_({"text": "abc", "strike": "abd"}), ("note.strike", "原样有的")),
        (sc_({"text": "abc", "strike": ["a"]}), ("note.strike 必须是字符串",)),
        (sc_(lines=[{"text": "x", "note": "show"}]), ("lines[0].note", "先有 scenes[0].note", "便签只属于写它的那个场景")),
        (sc_({"text": "abc"}, [{"text": "x", "note": "划掉"}]), ("lines[0].note", "show / strike / hide")),
        (sc_({"text": "abc"}, [{"text": "x", "note": ""}]), ("show / strike / hide",)),
        (sc_({"text": "abc"}, [{"text": "x", "note": True}]), ("show / strike / hide",)),
        (sc_({"text": "abc"}, [{"text": "x", "note": {"do": "show"}}]), ("show / strike / hide",)),
        (sc_({"text": "abc"}, [{"text": "x", "note": "strike"}]), ("没写 strike",)),
        (sc_({"text": "abc"}, [{"text": "  ", "note": "show"}]), ("lines[0].note", "台词是空的")),
        (sc_({"text": "abc"}, [{"note": "show"}]), ("台词是空的",)),
        (sc_({"text": "abc", "strike": "b"}, [{"text": "x", "note": "strike"}, {"text": "y", "note": "hide"}, {"text": "z", "note": "strike"}]),
         ("lines[2].note", "已经划过了")),
        # 写了便签却没有哪句让它出来（场景开头是收着的）：渲染出来一张都没有，也不报错 —— 在这里拦
        (sc_({"text": "abc", "strike": "b"}), ("scenes[0].note 写了", '"show" 或 "strike"', "收着")),
        (sc_({"text": "abc"}, [{"text": "x", "note": "hide"}]), ("scenes[0].note 写了", "一直不出来")),
        ({"title": "t", "scenes": [ok_scene, {"note": dict(first), "lines": [{"text": "这句留着。"}]}]}, ("scenes[1].note 写了",))):
    dies(lambda bad=bad: S.validate_script(bad), *words)
# 第二个场景可以再划它自己的便签（一个场景只划一次）
S.validate_script({"title": "t", "scenes": [{"note": {"text": "ab", "strike": "a"}, "lines": [{"text": "x", "note": "strike"}]},
                                             {"note": {"text": "ab", "strike": "b"}, "lines": [{"text": "y", "note": "strike"}]}]})
# 查重：便签上的字和小字也算她的字，排在幻灯片后面、台词前面（和 tools/lib/originality.mjs 的 scriptText 一样的顺序）
assert S.script_text({}, [{"note": {"label": "上一版的开头", "text": "先说一次"}, "lines": [{"text": "这四个字删掉"}]}]) == S.norm("先说一次上一版的开头这四个字删掉")
assert S.script_text({"desc": "简介"}, [{"slide": {"title": "幻灯片"}, "lines": [{"text": "台词"}]}, {"note": {"text": "便签"}, "lines": []}]) == S.norm("简介幻灯片台词便签")

# 幻灯片配画（v0.11.16，主人看了栏目第一期：「视频的中间只有蓝色背景，太单调了」）：slide + bg_prompt →
# 她画的那张铺满整页（稍微柔化），字放在左边一张半透明的米白纸卡上；不挡右下角她站的地方，也不进字幕条
from PIL import ImageDraw, ImageStat
COL = {"title": "这一栏讲什么：数学笔记", "bullets": ["每周一期：微积分、线性代数、电路轮着来", "只讲我自己的理解和例题，不搬讲义", "一期一个小问题"], "note": "第 1 期"}
TB = "数学笔记 · 例题讲解 1"
CL = S.card_layout(COL, TB)
x0, y0, x1, y1 = CL["card"]
assert x0 >= 40 and y0 >= 40 and x1 <= S.W - 560 and S.SLIDE_SPRITE_X - x1 >= 300 and y1 <= S.SLIDE_BOTTOM, CL["card"]
flat = lambda c: Image.new("RGB", (1536, 1024), c)                       # 出图接口回的是 3:2 的画
on_black, on_white = (S.slide_card_image(COL, TB, flat(c), (255, 140, 90), CL) for c in ((0, 0, 0), (255, 255, 255)))
assert on_white.size == (S.W, S.H) and on_white.mode == "RGB"
# 纸：米白、约 90% 不透明（黑底和白底上同一个点差多少 = 透过来多少）；纸边上没有字的地方看
pt = (x1 - 30, (y0 + y1) // 2)
pb, pw = on_black.getpixel(pt), on_white.getpixel(pt)
alpha = [1 - (w - b) / 255 for w, b in zip(pw, pb)]
assert all(0.86 <= a <= 0.93 for a in alpha), (pb, pw, alpha)
assert all(abs(w - c) <= 6 for w, c in zip(pw, S.COVER_PAPER)) and all(abs(b - c * a) <= 3 for b, c, a in zip(pb, S.COVER_PAPER, alpha)), (pb, pw)
# 纸卡以外全是画：右边她站的那一条、下面的字幕条一个纸色 / 影子的像素都没有；纸下面有一层影子（比画暗一点）
assert on_white.crop((x1 + 60, 0, S.W, S.H)).getextrema() == ((255, 255), (255, 255), (255, 255)), "她站的地方不能有纸卡 / 影子"
assert on_white.crop((0, S.SLIDE_BOTTOM + 60, S.W, S.H)).getextrema() == ((255, 255), (255, 255), (255, 255)), "字幕条里不能有纸卡 / 影子"
assert on_white.getpixel(((x0 + x1) // 2, y1 + 14))[0] < 245 and on_white.getpixel(((x0 + x1) // 2, y1 + 100)) == (255, 255, 255)
# 字：标题 + 要点是深蓝，角标是她的颜色（左上），角注灰蓝、贴纸卡右上（和角标同一行，右边对齐纸里的字边）
assert count(on_white, *INK, (x0, CL["top"], x1, CL["top"] + 2 * int(CL["ts"] * 1.25))) > 6000, "标题是深蓝字"
assert count(on_white, *INK, (x0, CL["top"] + 2 * int(CL["ts"] * 1.25) + 70, x1, y1)) > 3000, "要点也画上了"
assert count(on_white, (240, 125, 75), (255, 155, 105), (x0, y0, x0 + 500, CL["top"])) > 3000, "角标"
row = (x0, y0 + S.CARD_PAD[1], x1, CL["top"])                            # 角标那一行：只有角标和角注（标题的字边才会混出灰蓝）
chs = [ch.point(lambda v, a=a, b=b: 255 if a <= v <= b else 0) for ch, a, b in zip(on_white.crop(row).split(), *GREYBLUE)]
nb = ImageChops.multiply(ImageChops.multiply(chs[0], chs[1]), chs[2]).getbbox()
assert nb and abs(row[0] + nb[2] - (x1 - S.CARD_PAD[2])) <= 4 and row[0] + nb[0] > x1 - 400, ("角注贴纸卡右上", nb)
# 画还看得出来是她的画：纸卡外面的条纹还在（只是柔和一点），不是原图原样、也不是糊成一片
stripes = flat((60, 150, 90))
for sx in range(0, 1536, 64):
    ImageDraw.Draw(stripes).rectangle((sx, 0, sx + 31, 1024), fill=(200, 80, 160))
on_pic = S.slide_card_image(COL, TB, stripes, (255, 140, 90), CL)
box = (x1 + 60, 40, S.W - 40, 500)
raw_sd, got_sd = ImageStat.Stat(S.cover_fit(stripes).crop(box)).stddev, ImageStat.Stat(on_pic.crop(box)).stddev
assert all(0.7 * r <= g < r for r, g in zip(raw_sd, got_sd)), (raw_sd, got_sd)
assert 1 <= ImageStat.Stat(ImageChops.difference(S.cover_fit(stripes).crop(box), on_pic.crop(box)).convert("L")).mean[0] <= 25
inside = on_pic.getpixel(pt)
assert all(abs(v - c) <= 30 for v, c in zip(inside, S.COVER_PAPER)), ("画上的纸还是米白的", inside)
# 高度跟着内容走（最矮 CARD_MIN_H）；最满的一页也不进字幕条
short = S.card_layout({"title": "短"}, "")["card"]
six = S.card_layout({"title": "一个比较长的标题，用来测试", "bullets": ["这是一条相当长的要点，用来测试换行和字号自动缩小的效果是否正常"] * 6, "note": "角注"}, "测试 1")["card"]
assert short[3] - short[1] == S.CARD_MIN_H and short[3] < y1 < six[3] <= S.SLIDE_BOTTOM, (short, CL["card"], six)
full_white = S.slide_card_image({"title": "一个比较长的标题，用来测试", "bullets": ["这是一条相当长的要点，用来测试换行和字号自动缩小的效果是否正常"] * 6, "note": "角注"}, "测试 1", flat((255, 255, 255)))
assert full_white.crop((0, S.SLIDE_BOTTOM + 60, S.W, S.H)).getextrema() == ((255, 255), (255, 255), (255, 255)), "最满的一页：字幕条里也没有纸卡 / 影子"
assert S.card_layout({"title": "短"}, "")["top"] < S.card_layout({"title": "短"}, "x")["top"], "没有角标 / 角注时标题往上挪"
# 放不下：和深色那一页一样报错（同一套排版代码），在出图之前就能查出来
for bad, words in (({"title": "x", "bullets": ["a"] * 9}, ("最多 8 条", "拆成两页")), ({"title": "x", "bullets": ["很长很长的要点" * 30] * 8}, ("放不下",)),
                   (nl_bullets, ("放不下",)), ({"title": "t", "bullets": ["a"], "note": "这是一段非常长的角注" * 5}, ("note 太长",))):
    raises(lambda bad=bad: S.card_layout(bad, ""), *words)
    raises(lambda bad=bad: S.slide_card_image(bad, "", flat((9, 9, 9))), *words)
    try:
        S.card_layout(bad, "")
    except RuntimeError as e:
        assert "纸卡" not in str(e), ("深色那一页也放不下：报深色那一页的原话（去掉 bg_prompt 也没用）", str(e))
# 深色那一页放得下、纸卡放不下（有栏目角标时角注一行只放得下二十来个字）：报错说清楚是纸卡的事，不然「最多 40 字」的角注 27 个字就被拦，看不懂
n27 = {"title": "例题", "bullets": ["一条"], "note": "例题是我自己出的，讲义只看了目录和定义，所以有错是我的"}
raises(lambda: S.card_layout(n27, TB), "note 太长", "纸卡比深色那一页窄", "bg_prompt")
S.slide_image(n27, TB)
# 纸卡窄（标题宽 1168，深色那一页 1280）：14–16 个字的章节标题在 84 号会剩一两个字在第二行、要点还被挤到最小号 →
# 宁可小一号放成一行；64 号也一行放不下的长标题照旧折两行
for t in ("第二章：线性方程组和高斯消元", "第二章：线性方程组和高斯消元方法"):
    for n in (3, 6):
        Lt = S.card_layout({"title": t, "bullets": ["这一条要点大概写二十二个字左右这样子吧好"] * n}, TB)
        assert len(Lt["tl"]) == 1 and 64 <= Lt["ts"] < 84 and Lt["bs"] >= 40, (t, n, Lt["ts"], Lt["tl"], Lt["bs"])
Lt = S.card_layout({"title": "第三章：特征值、特征向量和对角化的几何意义", "bullets": ["一条"]}, TB)
assert len(Lt["tl"]) == 2 and Lt["ts"] == 84, (Lt["ts"], Lt["tl"])
# 字幕条：内容多到要靠下边界逼着缩字号的一页（8 条短要点）—— 纸卡停在 SLIDE_BOTTOM 以上（上面 6 条长要点那页离下边界还远，碰不到这条线）
eight = {"title": "这一页有八条", "bullets": [f"第 {i} 条：一句短要点" for i in range(1, 9)]}
L8 = S.card_layout(eight, TB)
assert S.SLIDE_BOTTOM - 60 < L8["card"][3] <= S.SLIDE_BOTTOM and (L8["ts"], L8["bs"]) != (84, 46), (L8["card"], L8["ts"], L8["bs"])
assert S.slide_card_image(eight, TB, flat((255, 255, 255)), (255, 140, 90), L8).crop((0, S.SLIDE_BOTTOM + 60, S.W, S.H)).getextrema() == ((255, 255),) * 3, \
    "8 条要点那页：字幕条里也没有纸卡 / 影子"


# 深色那一页（没写 bg_prompt 的幻灯片）逐字节和 v0.11.15 一样：slide_draw / slide_layout 现在和纸卡共用，以后为纸卡改它们不能顺手改了所有旧剧本的幻灯片。
# ref_slide_image = v0.11.15 的 slide_image 原样冻在这里（只给模块里的名字加了 S.）—— 别跟着 studio.py 改
def ref_slide_image(slide, badge, accent=(255, 140, 90)):
    W, H, font, wrap = S.W, S.H, S.font, S.wrap
    title = str(slide.get("title") or "")
    bullets = [str(b) for b in (slide.get("bullets") or []) if str(b).strip()]
    img = Image.new("RGB", (W, H), (14, 20, 38))
    d = ImageDraw.Draw(img)
    for x in range(0, W, 64):
        d.line((x, 0, x, H), fill=(20, 28, 52))
    for y in range(0, H, 64):
        d.line((0, y, W, y), fill=(20, 28, 52))
    if badge:
        bf = font(30)
        bw = bf.getlength(badge)
        d.rounded_rectangle((120, 86, 120 + bw + 40, 136), radius=10, fill=accent)
        d.text((140, 92), badge, font=bf, fill=(20, 20, 30))
    layout = None
    for ts in range(84, 47, -4):
        tl = wrap(title, font(ts), 1280)
        if len(tl) > 2:
            continue
        for bs in range(46, 29, -2):
            bf = font(bs)
            wrapped = [wrap(b, bf, 1120) for b in bullets]
            y_end = 170 + len(tl) * int(ts * 1.25) + 70 + sum(len(bl) * int(bs * 1.35) + 22 for bl in wrapped)
            if y_end <= S.SLIDE_BOTTOM:
                layout = (ts, tl, bs, wrapped)
                break
        if layout:
            break
    ts, tl, bs, wrapped = layout
    tf, bf = font(ts), font(bs)
    y = 170
    for line in tl:
        d.text((120, y), line, font=tf, fill=(255, 255, 255))
        y += int(ts * 1.25)
    d.rectangle((120, y + 14, 300, y + 22), fill=accent)
    y += 70
    for bl in wrapped:
        d.ellipse((124, y + bs * 0.35, 124 + 18, y + bs * 0.35 + 18), fill=accent)
        for line in bl:
            d.text((168, y), line, font=bf, fill=(220, 228, 245))
            y += int(bs * 1.35)
        y += 22
    if slide.get("note"):
        nf = font(30)
        note = re.sub(r"\s+", " ", str(slide["note"])).strip()
        d.text((W - 120 - nf.getlength(note), 96), note, font=nf, fill=(130, 145, 180))
    return img


for sl, b in ((COL, TB), (n27, TB), ({"title": "没有角标的一页", "bullets": ["一条", "两条"], "note": "角注"}, ""),
              ({"title": "第二章：线性方程组和高斯消元"}, TB), ({"title": "第三章：特征值、特征向量和对角化的几何意义", "bullets": ["要点"] * 3}, ""),
              (eight, TB), ({"title": "一个比较长的标题，用来测试", "bullets": ["这是一条相当长的要点，用来测试换行和字号自动缩小的效果是否正常"] * 6, "note": "角注"}, "测试 1")):
    for acc in ((255, 140, 90), (120, 170, 255)):
        got, want = S.slide_image(sl, b, acc), ref_slide_image(sl, b, acc)
        assert got.mode == want.mode and got.size == want.size and got.tobytes() == want.tobytes(), ("深色那一页和 v0.11.15 不一样了", sl.get("title"), b, acc)
dark = S.slide_image(COL, TB)
assert dark.getpixel((10, 1070)) == (14, 20, 38) and dark.getpixel((64, 1070)) == (20, 28, 52)
assert S.slide_layout(COL, TB)["x"] == 120 and S.slide_layout(COL, TB)["top"] == 170
# 剧本：slide 可以配 bg_prompt；bg_prompt 只收字符串；slide 配 illustration_prompt 以前被悄悄丢掉 → 现在说清楚
S.validate_script({"title": "t", "scenes": [{"slide": {"title": "s", "bullets": ["b"]}, "bg_prompt": "清晨的湖，远处有雾", "lines": [{"text": "x"}]},
                                             {"illustration_prompt": "她站在黑板前", "lines": [{"text": "y"}]}, {"slide": {}, "illustration_prompt": "p", "lines": []}]})
for bad, words in (
        (sc_(slide={"title": "s"}, illustration_prompt="她站在黑板前"), ("scenes[0]", "slide 不能配 illustration_prompt", "立绘重了", "bg_prompt")),
        (sc_(slide={"title": "s"}, bg_prompt=["湖"]), ("scenes[0].bg_prompt 必须是字符串",)),
        (sc_(bg_prompt=3), ("scenes[0].bg_prompt 必须是字符串",)),
        (sc_({"text": "a"}, [{"text": "x", "note": "show"}], slide={"title": "s"}, bg_prompt="湖"), ("note 和 slide 不能一起用",))):
    dies(lambda bad=bad: S.validate_script(bad), *words)

# ⑬ 自查图（v0.11.20）：她渲染完只 Read build/check.jpg。分页、抽样、每页大小、抽帧只当 MP4 读、临时文件不顺着链接写
CL = S.check_layout
assert CL(1) == [[0]] and CL(0) == [[]]
assert CL(11) == [list(range(11))], "11 个场景 + 封面 = 第 1 页 12 格"
assert CL(12) == [list(range(11)), [11]]
assert CL(27) == [list(range(11)), list(range(11, 27))]
p43 = CL(43)
assert [len(p) for p in p43] == [11, 16, 16] and sum(p43, []) == list(range(43)), "43 个刚好放满 3 页，一个不抽"
keep = [5, 17, 33, 41, 47, 52, 58]                 # 有便签的、画没画出来的
p60 = CL(60, keep)
flat = sum(p60, [])
assert [len(p) for p in p60] == [11, 16, 16], p60
assert flat == sorted(set(flat)) and flat[0] == 0 and flat[-1] == 59, "按顺序、不重复、头尾都在"
assert all(k in flat for k in keep), ("一定要留的被抽掉了", keep, flat)
assert max(b - a for a, b in zip(flat, flat[1:])) <= 3, "均匀抽，不是只要前 43 个"
p100 = sum(CL(100, list(range(1, 99))), [])
assert len(p100) == 43 and len(set(p100)) == 43 and p100[0] == 0 and p100[-1] == 99, "一定要留的都放不下：也只放 43 个，头尾还在"
assert S._even([1, 2, 3], 5) == [1, 2, 3] and S._even(list(range(10)), 0) == [] and len(set(S._even(list(range(50)), 17))) == 17
for n_tiles, n_det in ((12, 4), (16, 0), (1, 1), (5, 3), (4, 0)):
    h, tiles, cells = S.sheet_geometry(n_tiles, n_det)
    assert S.SHEET_W * h <= S.SHEET_MAX_PX, (n_tiles, n_det, h)
    assert len(tiles) == n_tiles and len(cells) == n_det
    boxes = tiles + cells
    for x0, y0, x1, y1 in boxes:
        assert 0 <= x0 < x1 <= S.SHEET_W and S.SHEET_HEAD < y0 < y1 <= h, (x0, y0, x1, y1, h)
    for x0, y0, x1, y1 in tiles:
        assert (x1 - x0, y1 - y0) == (315, 177), "格子约首页推荐的封面那么大（16:9）"
    lab = [(x0, y0 - S.SHEET_LABEL_H, x1, y1) for x0, y0, x1, y1 in tiles] + cells   # 格子连同上面的标签条（放大格的标签在格子里面）
    for i, a in enumerate(lab):                    # 都不重叠
        for b in lab[i + 1:]:
            assert a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1], (a, b)
assert S.sheet_geometry(12, 4)[0] <= 898 and S.sheet_geometry(4)[0] < 300, "场景少，图就矮（少花 token）"
raises(lambda: S.sheet_geometry(20, 4), "太大")     # 一页放 20 格：超过 1.15 MP 就报错，不悄悄出一张大图
assert S._mmss(0) == "0:00" and S._mmss(61.4) == "1:01" and S._mmss(600) == "10:00"
with tempfile.TemporaryDirectory() as td:
    td = Path(td)
    real = td / "real.mp4"
    subprocess.run([S.ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0xC83232:s=1920x1080:d=1:r=30",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", str(real)], check=True, timeout=60)
    fr = S._grab_frame(real, 0.5)
    assert fr.size == (S.W, S.H) and count(fr, (170, 20, 20), (230, 80, 80), (900, 500, 1000, 600)) > 9000, "抽到的就是那一帧"
    raises(lambda: S._grab_frame(real, 5.0), "抽不出")  # 超过结尾：抛，不悄悄给一张黑图
    fake = td / "c0000.mp4"                        # 冒名的播放列表：不当播放列表读，不去读它指向的文件
    fake.write_text("ffconcat version 1.0\nfile 'real.mp4'\n", encoding="utf-8")
    raises(lambda: S._grab_frame(fake, 0.5), "抽不出")
    # 写自查图：先写新建的临时文件再换上去；build/ 里那个名字原来是什么（旧文件、指向别处的链接）都只是被换掉，不会顺着它写出去
    target = td / "outside.txt"
    target.write_text("主人的文件", encoding="utf-8")
    dest = td / "check.jpg"
    try:
        os.symlink(target, dest)
    except OSError:                                # Windows 没开开发者模式不能建符号链接：就用一个旧文件
        dest.write_bytes(b"stale")
    S._write_atomic(dest, b"new-sheet")
    assert dest.read_bytes() == b"new-sheet" and not dest.is_symlink() and target.read_text(encoding="utf-8") == "主人的文件"
    assert not list(td.glob("*.part")), "临时文件不留下"
    for n in ("check.jpg", "check-2.jpg", "check.json", "frame-s01.jpg", "check.jpg.abc.part", "frame-s01.jpg.abc.part", "bg00.png", "c0000.mp4"):
        (td / n).write_bytes(b"x")
    (td / "check-3.jpg").mkdir()                   # 删不掉的（目录）不报错
    S._clear_sheet(td)
    assert sorted(p.name for p in td.iterdir()) == ["bg00.png", "c0000.mp4", "check-3.jpg", "outside.txt", "real.mp4"], sorted(p.name for p in td.iterdir())

# ⑭ 自查图复查（v0.11.20）：方框字由代码查（格子里幻灯片的字只有五六个像素高）· 收起后又拿出来的便签多放大一格 · 琥珀色那行字不出格子
MG = S.missing_glyphs
assert MG("中文 Abc，∈∑≤∫→εδ。", "第 4 期", None, "") == "", "常见的字（中文、拉丁字母、∈∑≤∫→εδ）都有"
assert MG(S.GLYPH_PROBE) == S.GLYPH_PROBE and MG("a\n\tb 　c", "\r") == "", "哪个字体都没有的码位算缺；空白、换行不算"
assert MG("x\U0010FFFDy", "\U0010FFFD", "z\U0010FFFD") == "\U0010FFFD", "不重复"
if Path(S._FONT["path"]).name.lower() in ("msyh.ttc", "msyhbd.ttc", "simhei.ttf"):   # 第一期复查时纸卡上这几个全是方框（雅黑、黑体都没有）
    assert MG("x₁ ∈ ℝ，∑ aᵢ ≤ ∫ f dx", "A ⊆ B ⇔ ∀x∈A: x∈B", "ε-δ 定义") == "₁ℝᵢ⊆⇔∀", MG("x₁ ∈ ℝ，∑ aᵢ ≤ ∫ f dx", "A ⊆ B ⇔ ∀x∈A: x∈B")
assert S.glyph_names("ℝ️‮") == "ℝ U+FE0F U+202E", "看不见的字写成 U+XXXX"
assert S._join_warn(None, "缺字×2") == "缺字×2" and S._join_warn("没画出来→渐变底", "缺字×2") == "没画出来→渐变底 · 缺字×2" and S._join_warn(None, None) is None
sh = lambda *ns: [{"note": n, "clip": i} for i, n in enumerate(ns)]
assert S.note_again(sh("shown", "struck", None, "struck"))["clip"] == 3, "出现 → 划掉 → 收起 → 再拿出来：要再拿出来那一页"
assert S.note_again(sh("shown", "struck", "struck")) is None and S.note_again(sh(None, None)) is None and S.note_again([]) is None
assert S.note_again(sh(None, "shown", None, "shown", "shown", None, "struck", "struck"))["clip"] == 6, "收起又拿出来好几次：要最后一次的第一页"
from PIL import Image, ImageDraw
img = Image.new("RGB", (400, 260), (0, 0, 0))
box = (40, 40, 355, 217)                           # 和自查图一格一样大（315×177）
S._sheet_warn(ImageDraw.Draw(img), box, "配画没画出来→深色页 · 缺字×12 · 这是一段很长很长、放不下的原因")
bb = Image.eval(img, lambda v: 255 if v > 30 else 0).convert("L").getbbox()
assert bb and box[0] <= bb[0] and bb[2] <= box[2] and box[1] <= bb[1] and bb[3] <= box[3], ("琥珀色那行字没出格子", bb, box)
assert img.getpixel((box[0] + 1, box[1] + 100)) == S.SHEET_WARN_INK, "整格框一圈琥珀色"
print("ok")
