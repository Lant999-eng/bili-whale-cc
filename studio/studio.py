#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
bili-whale-cc 工作室（Python 侧）—— 她自己做"角色视频"的那一半

    python studio.py render  <作品目录> --config <cfg.json>   script.json → final.mp4 + cover.jpg + render.json
    python studio.py sprites <角色目录> --config <cfg.json> [--exprs neutral,happy,…] [--outfit 换装] [--force]   用参考图生成表情立绘（透明底；已有的不覆盖）
    python studio.py upload  <作品目录> --cred <credentials.json> [--ai-statement 文本]   投稿（只有主人批准时调用）
    python studio.py stats   --cred <credentials.json> --mid <mid> [--n 20]             她自己的视频数据

画面由这几样拼起来（全部 1920×1080 · 30fps）：
    场景背景   bg_prompt（AI 画场景，不画人）/ illustration_prompt（AI 拿角色参考图画"角色在场景里"）/ slide（讲解幻灯片）
               slide 再加 bg_prompt：字放在一张半透明纸卡上、叠在 AI 画的场景上（画不出来就是深色那一页）
    角色立绘   cast/<id>/sprites/<换装>/<表情>.png（一套换装都没有时才用老的平铺 sprites/<表情>.png）—— 说话的人亮、会轻轻上下浮动，听的人变暗
               换装：profile.json 的 outfit 是默认，剧本 "outfit": {"<角色 id>": "<换装>"} 按视频换；AI 插画 / 封面也拿这一套的立绘当参考图；
               sprites/<换装>/说话/<表情>.png 放同名的张嘴版：说话的人跟着这句配音的响度一张一合（没有说话版就一直闭着嘴）
    字幕       按句切，带说话人名牌
    便签       场景里她旁边的一张手写卡片（scenes[i].note），念到某句时出现 / 真的被划掉 / 收起（lines[k].note）
    镜头       背景缓慢平移（跨句连续）；开头 2 秒系列片头；背景音乐默认按标题用代码合成（bgm_synth.py，studio.bgmSynth；剧本 "bgm": false 不要），
               主人放进 bgm/ 的音乐只在她写曲名 / 写 true / 睡前故事时用（从不下载别人的音乐）

AI 画图走 OpenAI images 接口：有参考图 → /images/edits（gpt-image-2.5-sunburst 支持多张参考图，角色才能前后一致）；
没有参考图 → /images/generations。所有出图按（提示词 + 参考图）缓存，重渲染不重复花钱；每条视频有张数上限。
没配 key 时一律退回渐变底 / 参考图卡片，流程照样能跑通。

依赖在项目的 .studio-venv 里：edge-tts · pillow · imageio-ffmpeg · bilibili-api-python · aiohttp
（VoxCPM 本地配音另跑在主人自己装的虚拟环境里，见 voxcpm_worker.py；这里不 import torch）
"""
import argparse
import array
import asyncio
import base64
import colorsys
import contextlib
import hashlib
import json
import math
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

if os.name == "nt":
    import msvcrt
else:
    import fcntl

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
# Windows 上 shutil.which 默认先找当前目录：她渲染时当前目录是她的家，放一个 ffmpeg.cmd 就会被当成 ffmpeg 跑。只从 PATH 找
os.environ.setdefault("NoDefaultCurrentDirectoryInExePath", "1")

W, H = 1920, 1080
FPS = 30
PAN = 1.12                     # 背景放大倍数（留出平移余量）
DEFAULT_EXPRS = ["neutral", "happy", "thinking", "surprised", "sad", "smug"]
EXPR_WORDS = {
    "neutral": "calm, gentle neutral expression", "happy": "bright happy smile", "thinking": "thinking, finger on chin",
    "surprised": "surprised, wide eyes", "sad": "a little sad, downcast eyes", "smug": "confident smug grin",
    "shy": "shy, light blush", "angry": "pouting, mildly annoyed", "sleepy": "sleepy, yawning",
}


_DIE_EXTRA = {}   # 这一段里所有 die 都带上的附加字段：do_upload 读 / 查剧本时是 notStarted=True（剧本规矩变严了，排队的旧剧本在这里被拦，也是一个字节都没传）


def die(msg, code=1, **extra):
    # extra：给 node 的附加字段，比如 notStarted=True（上传前就挡下了，一个字节都没传 —— 主人那边不记成「结果不确定」）
    print(json.dumps({"ok": False, "error": msg, **_DIE_EXTRA, **extra}, ensure_ascii=False))
    sys.exit(code)


def parse_tid(v):
    """剧本里的分区号 → int；不认的一律 0。和 node 那边（tools/lib/studio.mjs 的 parseTid）同一个规矩：
    整数（JSON 里的 21.0 也算 21）或者只有 ASCII 数字的字符串；布尔、负数、"21.0"、"0x15"、"2_1"、全角 / 别的文字的数字都不认"""
    if isinstance(v, bool):
        return 0
    if isinstance(v, int):
        return v if v > 0 else 0
    if isinstance(v, float) and v.is_integer() and v > 0:
        return int(v)
    if isinstance(v, str) and re.fullmatch(r"[ \t\r\n]*[0-9]+[ \t\r\n]*", v):   # 前后只认 ASCII 空白（\s 在两边认的不一样）
        return int(v.strip(" \t\r\n"))
    return 0


def log(msg):
    print("[studio] " + msg, file=sys.stderr, flush=True)


# ─────────────── ffmpeg ───────────────

def ffmpeg_exe() -> str:
    exe = os.environ.get("FFMPEG") or shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        die("找不到 ffmpeg：跑 `node host/cli.mjs studio-setup`（会装自带 ffmpeg 的 imageio-ffmpeg）")


def run_ffmpeg(args):
    r = subprocess.run([ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y", *args],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise RuntimeError("ffmpeg 失败：" + (r.stderr or "")[-800:])


def media_seconds(path: Path) -> float:
    r = subprocess.run([ffmpeg_exe(), "-hide_banner", "-i", str(path)], capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    m = re.search(r"Duration:\s*(\d+):(\d+):([\d.]+)", r.stderr or "")
    if not m:
        raise RuntimeError(f"读不出时长：{path}")
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


# ─────────────── 字体 / 文字 ───────────────

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyhbd.ttc", r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\NotoSansSC-VF.ttf", r"C:\Windows\Fonts\simhei.ttf",
    "/System/Library/Fonts/PingFang.ttc", "/System/Library/Fonts/STHeiti Medium.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc", "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
]
_FONT = {}


def find_font(configured: str = "") -> str:
    for f in [configured, *FONT_CANDIDATES]:
        if f and Path(f).is_file():
            return f
    die("找不到中文字体：在配置 studio.font 里填一个 .ttf/.ttc 路径")


def font(size):
    from PIL import ImageFont
    key = (_FONT["path"], size)
    if key not in _FONT:
        _FONT[key] = ImageFont.truetype(_FONT["path"], size)
    return _FONT[key]


def wrap(text: str, fnt, max_w: int):
    """中英文混排按像素宽度折行（中文逐字、英文尽量不拆词）。
    文字里的换行符当硬换行：以前它被当成普通字符算进一行，Pillow 画的时候却真的换行 → 行数算少了，字叠在一起 / 画出画布"""
    out = []
    for para in re.split(r"\r\n|\r|\n", str(text)):
        out += _wrap_one(para, fnt, max_w)
    return out


def _wrap_one(text: str, fnt, max_w: int):
    lines, cur = [], ""
    for tok in re.findall(r"[A-Za-z0-9_\-.,!?'\"%]+\s*|\s+|.", text):
        if fnt.getlength(cur + tok) <= max_w:
            cur += tok
            continue
        if cur.strip():
            lines.append(cur.rstrip())
        cur = tok.lstrip()
        while fnt.getlength(cur) > max_w:
            cut = len(cur) - 1
            while cut > 1 and fnt.getlength(cur[:cut]) > max_w:
                cut -= 1
            lines.append(cur[:cut])
            cur = cur[cut:]
    if cur.strip():
        lines.append(cur.rstrip())
    return lines


def fit_text(text, max_w, max_lines, start, floor):
    size = start
    while True:
        f = font(size)
        lines = wrap(text, f, max_w)
        if len(lines) <= max_lines or size <= floor:
            return f, lines, size
        size -= 4


def hex_rgb(h, dflt=(255, 140, 90)):
    try:
        h = str(h).lstrip("#")
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    except Exception:
        return dflt


# ─────────────── 图像工具 ───────────────

def gradient(seed: str, size=(W, H)):
    from PIL import Image
    h = int(hashlib.md5(seed.encode("utf-8")).hexdigest()[:6], 16) / 0xFFFFFF
    c1 = [int(v * 255) for v in colorsys.hls_to_rgb(h, 0.22, 0.45)]
    c2 = [int(v * 255) for v in colorsys.hls_to_rgb((h + 0.12) % 1, 0.42, 0.55)]
    small = Image.new("RGB", (64, 36))
    px = small.load()
    for y in range(36):
        for x in range(64):
            t = (x / 63 + y / 35) / 2
            px[x, y] = tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))
    return small.resize(size, Image.BICUBIC)


def cover_fit(img, size=(W, H)):
    from PIL import Image
    w, h = size
    img = img.convert("RGB")
    scale = max(w / img.width, h / img.height)
    img = img.resize((max(w, round(img.width * scale)), max(h, round(img.height * scale))), Image.LANCZOS)
    left, top = (img.width - w) // 2, (img.height - h) // 2
    return img.crop((left, top, left + w, top + h))


def alpha_box(img):
    """人物的边框（不透明度 > 12 的像素）；全透明 = None"""
    return img.getchannel("A").point(lambda a: 255 if a > 12 else 0).getbbox()


def trim_alpha(img):
    if img.mode != "RGBA":
        return img
    box = alpha_box(img)
    return img.crop(box) if box else img


def whole_figure(img) -> bool:
    """立绘（裁边之前）是不是完整的一个人：人物下面还有一截透明的空白 = 全身立绘，脚是画全了的。
    半身 / 画到膝盖的立绘一直画到画布最下面（AI 生成的存之前就裁过边），那里是断口"""
    if img.mode != "RGBA":
        return False
    box = img.getchannel("A").point(lambda a: 255 if a > 12 else 0).getbbox()
    return bool(box) and img.height - box[3] >= max(4, img.height // 200)


FEET_MARGIN = 28   # 全身立绘脚下留的空（1080 高的画面里；说话的人还会上下浮动 9 像素）


def sprite_y(H, s, whole, bleed=30):
    """立绘贴着画面底部放的 y：半身立绘把下面的断口压到画面外 bleed 像素；全身立绘整个露出来，脚下留 FEET_MARGIN（以前鞋底会被裁掉）"""
    return H - s.height - FEET_MARGIN if whole else H - s.height + bleed


def dim(img, k=0.5):
    from PIL import ImageEnhance
    a = img.getchannel("A")
    out = ImageEnhance.Brightness(img.convert("RGB")).enhance(k).convert("RGBA")
    out.putalpha(a)
    return out


def scale_h(img, h):
    from PIL import Image
    return img.resize((max(1, round(img.width * h / img.height)), h), Image.LANCZOS)


# ─────────────── AI 画图（OpenAI images：generations / edits）───────────────

class ImageRefused(Exception):
    """出图接口明确拒绝（4xx：参数 / 鉴权 / 额度 / 限流）—— 没出图、不计费，预留的那一张可以还回去"""


def _os_lock(fd: int, on: bool):
    """锁 / 放锁文件的第一个字节（不阻塞：拿不到就抛 OSError）"""
    if os.name == "nt":
        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_NBLCK if on else msvcrt.LK_UNLCK, 1)
    else:
        fcntl.flock(fd, (fcntl.LOCK_EX | fcntl.LOCK_NB) if on else fcntl.LOCK_UN)


@contextlib.contextmanager
def _file_lock(target: Path, wait: float = 30.0):
    """操作系统级的文件锁（Windows msvcrt.locking，其它系统 fcntl.flock），锁的是 <target>.lock 这个文件。
    拿锁的进程崩了，系统自动放锁 —— 所以不用判断「锁过期了没有」，也从不删锁文件。以前是「独占创建锁文件 + 过期就删」：
    两个进程都判断旧锁过期，A 删掉旧锁拿到新锁之后，B 接着删掉的却是 A 的新锁，两边都进了读改写。
    现在没有「清理」这一步，放锁也只放自己这个句柄上的锁，删掉别人的锁这种事不会发生"""
    lock = target.with_name(target.name + ".lock")
    lock.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(lock, os.O_RDWR | os.O_CREAT)
    try:
        t0 = time.time()
        while True:
            try:
                _os_lock(fd, True)
                break
            except OSError:
                if time.time() - t0 > wait:
                    raise RuntimeError(f"{target.name} 正被另一个进程占着")
                time.sleep(0.05)
        try:
            yield
        finally:
            _os_lock(fd, False)
    finally:
        os.close(fd)


class Painter:
    """出图 + 缓存 + 每条视频的张数上限。
    给了 image.ledger（主人那边、她写不到的账本，node 按作品 id 给）→ 上限按**这条视频所有渲染加起来**算，重渲染不会重置；
    没给（主人画角色立绘）→ 只按这一次算。缓存命中不算张数"""

    def __init__(self, cfg: dict):
        img = cfg.get("image") or {}
        self.enabled = img.get("provider", "none") != "none" and bool(os.environ.get("BILI_WHALE_IMAGE_KEY", "").strip())
        self.key = os.environ.get("BILI_WHALE_IMAGE_KEY", "").strip()
        self.base = str(img.get("baseUrl") or "https://api.openai.com/v1").rstrip("/")
        self.model = img.get("model") or "gpt-image-2.5-sunburst"   # gpt-image-1 已于 2026-10-23 停用
        self.quality = img.get("quality") or "medium"
        self.style = str(cfg.get("style") or "").strip()
        v = img.get("maxPerVideo")
        self.limit = 12 if v is None or v == "" else max(0, int(v))   # 0 = 不出图（以前 0 会被当成「没设」变成 12）
        self.used = 0                                      # 这一次渲染新出了几张
        self.ledger = Path(img["ledger"]) if img.get("ledger") else None
        self.cache = Path(cfg.get("cache_dir") or ".")
        self.cache.mkdir(parents=True, exist_ok=True)

    # ── 每条视频的出图账本：{"used": 这条视频一共出过几张} ──
    def _ledger_used(self) -> int:
        if not self.ledger.exists():
            return 0
        j = json.loads(self.ledger.read_text(encoding="utf-8"))
        n = j.get("used") if isinstance(j, dict) else None
        if not isinstance(n, int) or isinstance(n, bool) or n < 0:
            raise RuntimeError("出图账本结构不对")
        return n

    def _ledger_write(self, n: int):
        tmp = self.ledger.with_name(f"{self.ledger.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps({"used": n, "limit": self.limit}), encoding="utf-8")
        # Windows：账本正被别的进程读着（杀毒、索引、另一个渲染）时替换会短暂失败 —— 在锁里重试一会儿，最后还不行就删掉临时文件、报错
        for i in range(40):
            try:
                os.replace(tmp, self.ledger)
                return
            except PermissionError:
                if i == 39:
                    tmp.unlink(missing_ok=True)
                    raise
                time.sleep(0.025)

    def total(self):
        """这条视频一共出过几张（没有账本 = 只算这一次）；账本读不了 → None"""
        if self.ledger is None:
            return self.used
        try:
            with _file_lock(self.ledger):                  # 和写账本互斥：不和别的渲染的替换撞上
                return self._ledger_used()
        except Exception:
            return None

    def _reserve(self) -> bool:
        """「看还剩几张 + 预留一张」在账本锁里一步做完（两个渲染同时跑也超不了）。账本读不了 / 结构不对 → 不出图"""
        if self.ledger is None:
            if self.used >= self.limit:
                log(f"这次的 AI 出图已到上限 {self.limit} 张，后面的用渐变 / 参考图代替")
                return False
            return True
        try:
            with _file_lock(self.ledger):
                n = self._ledger_used()
                if n >= self.limit:
                    log(f"这条视频的 AI 出图已到上限 {self.limit} 张（之前几次渲染加起来），后面的用渐变 / 参考图代替")
                    return False
                self._ledger_write(n + 1)
            return True
        except Exception as e:
            log(f"出图账本有问题（{str(e)[:120]}）→ 这次不出图，请主人看一下 {self.ledger}")
            return False

    def _release(self):
        """接口明确拒绝（没出图）：把预留的那一张还回去"""
        if self.ledger is None:
            return
        try:
            with _file_lock(self.ledger):
                self._ledger_write(max(0, self._ledger_used() - 1))
        except Exception as e:
            log(f"出图账本没改回来（{str(e)[:120]}）—— 多算了一张，不影响这次渲染")

    def _key(self, prompt, refs, size, background):
        h = hashlib.sha1()
        h.update(json.dumps([self.model, self.quality, prompt, size, background], ensure_ascii=False).encode("utf-8"))
        for r in refs:
            h.update(Path(r).read_bytes())
        return h.hexdigest()[:24]

    def paint(self, prompt: str, refs=(), size="1536x1024", background=None):
        """返回 PNG 路径；没 key / 超额 / 失败 → None（调用方自己退回）"""
        prompt = prompt.strip()
        if not prompt:
            return None
        if self.style:
            prompt = f"{prompt}\nArt style: {self.style}"
        refs = [str(r) for r in refs if Path(r).is_file()][:8]
        out = self.cache / f"{self._key(prompt, refs, size, background)}.png"
        if out.is_file():
            return out
        if not self.enabled:
            return None
        if not self._reserve():
            return None
        try:
            data = self._edits(prompt, refs, size, background) if refs else self._generate(prompt, size, background)
            out.write_bytes(data)
            self.used += 1
            return out
        except ImageRefused as e:                          # 接口明确拒绝：没出图，这张不算
            self._release()
            log(f"出图失败（{str(e)[:200]}）")
            return None
        except Exception as e:                             # 超时 / 断线 / 5xx / 生成了但下载失败：可能已经计费 → 账本里照样算一张
            log(f"出图失败（{str(e)[:200]}）")
            return None

    def _post(self, url, body: bytes, ctype: str):
        req = urllib.request.Request(url, data=body, method="POST",
                                     headers={"Authorization": "Bearer " + self.key, "Content-Type": ctype})
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                j = json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if 400 <= e.code < 500 and e.code != 408:
                raise ImageRefused(f"HTTP {e.code}：{str(e)[:160]}") from e
            raise                                          # 5xx / 网关超时：上游可能已经生成、计费了
        item = ((j.get("data") or j.get("images") or [None])[0]) or {}
        if item.get("b64_json"):
            return base64.b64decode(item["b64_json"])
        if item.get("url"):
            try:
                with urllib.request.urlopen(urllib.request.Request(item["url"], headers={"User-Agent": "Mozilla/5.0"}), timeout=120) as r:
                    return r.read()
            except Exception as e:                         # 图已经生成（已经计费），只是下载失败 —— 不能当成「接口拒绝」
                raise RuntimeError(f"图已经生成但下载失败（{str(e)[:160]}）") from e
        raise RuntimeError("接口没返回图片：" + json.dumps(j, ensure_ascii=False)[:300])

    def _generate(self, prompt, size, background):
        body = {"model": self.model, "prompt": prompt, "n": 1, "size": size, "quality": self.quality}
        if background:
            body["background"] = background
            body["output_format"] = "png"          # 透明底必须配 png / webp
        return self._post(self.base + "/images/generations", json.dumps(body).encode("utf-8"), "application/json")

    def _edits(self, prompt, refs, size, background):
        boundary = "----whale" + uuid.uuid4().hex
        parts = []

        def field(name, value):
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode("utf-8"))

        field("model", self.model)
        field("prompt", prompt)
        field("size", size)
        field("quality", self.quality)
        field("n", "1")
        if background:
            field("background", background)
            field("output_format", "png")
        for r in refs:
            p = Path(r)
            mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}.get(p.suffix.lower().lstrip("."), "image/png")
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="{p.name}"\r\nContent-Type: {mime}\r\n\r\n'.encode("utf-8")
                         + p.read_bytes() + b"\r\n")
        parts.append(f"--{boundary}--\r\n".encode("utf-8"))
        return self._post(self.base + "/images/edits", b"".join(parts), f"multipart/form-data; boundary={boundary}")


# ─────────────── 角色（cast）───────────────

EXPR_RE = re.compile(r"[^\W\d_][\w-]{0,31}")   # 表情名：happy / neutral / 开心 / sad-2 …（字母或汉字开头，不能有 . / \ : 之类）
TALK_DIR = "说话"   # sprites/<换装>/说话/<表情>.png：同名的张嘴版，说话的人一张一合用（Cast.talk_sprite）；它不是一套换装


def outfit_name_ok(v) -> bool:
    """换装名（sprites/ 下的目录名，比如 居家 / 外出）：和表情名同样的规矩，再排除保留的「说话」"""
    return isinstance(v, str) and bool(EXPR_RE.fullmatch(v)) and v != TALK_DIR


def _js_order(name: str):
    """排序键：和 JS 的 Array.sort() 一样按 UTF-16 编码排（Python 默认按码位，遇到扩展区汉字两边会排得不一样）"""
    return name.encode("utf-16-be")


def _is_link(p: Path) -> bool:
    """符号链接或目录联接（Node 的 Dirent.isFile / isDirectory 对它们都是 false，这边也不算）"""
    try:
        return p.is_symlink() or bool(getattr(p, "is_junction", lambda: False)())
    except OSError:
        return True


def _png_files(d: Path):
    """d 下能当表情用的立绘：名字是合法表情名的 .png、普通文件（不是链接）；按表情名排序（和 JS 一样）"""
    try:
        return sorted([f for f in d.glob("*.png") if EXPR_RE.fullmatch(f.stem) and f.is_file() and not _is_link(f)],
                      key=lambda f: _js_order(f.stem))
    except OSError:
        return []


def _inside(p: Path, root: Path) -> bool:
    """p 解析后（含符号链接 / ..）是否还在 root 里"""
    try:
        p.resolve(strict=True).relative_to(root.resolve(strict=True))
        return True
    except (OSError, ValueError, RuntimeError):
        return False


class Cast:
    def __init__(self, cast_dir: Path, cid: str, cfg: dict):
        self.id = cid
        self.dir = cast_dir / cid
        p = {}
        try:
            p = json.loads((self.dir / "profile.json").read_text(encoding="utf-8-sig"))   # 记事本 / PowerShell 存的会带 BOM
        except Exception:
            pass
        self.name = p.get("name") or cid
        self.voice = p.get("voice") or cfg.get("voice") or "zh-CN-XiaoxiaoNeural"
        self.rate = p.get("rate") or cfg.get("rate") or "+0%"
        self.pitch = p.get("pitch") or "+0Hz"
        self.tts = p.get("tts") or "edge"                    # edge（免费）| openai（可以用文字描述语气）| voxcpm（本地模型，主人选定的音色）
        self.instructions = p.get("instructions") or ""      # openai 语气描述，比如「轻声、略带忧郁」
        self.voxcpm = p.get("voxcpm") if isinstance(p.get("voxcpm"), dict) else {}   # {"ref": 角色目录里的 wav 文件名, "ref_text": 它念的字}
        self.color = hex_rgb(p.get("color") or "#ff8a5c")
        self.desc = p.get("desc") or ""
        self.refs = sorted([f for f in self.dir.glob("ref*") if f.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp")])
        self.outfit_default = p.get("outfit") if outfit_name_ok(p.get("outfit")) else None   # 主人定的默认换装（cast outfit）
        self.outfit = None    # 这次渲染穿哪套（render 开头 use_outfit 定）；None = 老的平铺 sprites/<表情>.png
        self._cache = {}
        self._whole = {}      # 同一个键：这张立绘是不是全身（见 is_whole）
        self._src = {}        # 同一个键：闭嘴那张实际读的哪个文件、原图大小、裁边的框（talk_sprite 照它找、照它裁）
        self._talk = {}       # 同一个键：张嘴版（没有 = None）

    def outfits(self):
        """有哪几套换装：sprites/ 下名字合法、不是「说话」、不是链接 / 目录联接、里面至少有一张能用的立绘的子目录。
        和 tools/lib/studio.mjs 的 spriteSets 同一套规矩、同一个顺序（她在 studio cast 里看到的就是这里会用的）"""
        root = self.dir / "sprites"
        if not root.is_dir():
            return []
        have = [d.name for d in root.iterdir()
                if outfit_name_ok(d.name) and d.is_dir() and not _is_link(d) and _inside(d, root) and _png_files(d)]
        return sorted(have, key=_js_order)

    def use_outfit(self, want=None, strict=True):
        """定这次渲染穿哪套：剧本指定的 → profile.json 的默认 → 排第一的那套；一套换装都没有才用老的平铺立绘
        （有换装文件夹时，平铺的是搬家剩下的，不用）。指定的那套没有就报错，不悄悄换成别的（她要的是外出那套，成片却是居家那套）。
        她的字符串只和列出来的目录名比，不拿去拼路径。strict=False：这条视频用不到这个角色，默认换装不在也不报错"""
        have = self.outfits()
        if want is not None:
            if want not in have:
                raise RuntimeError(f"角色 {self.id} 没有「{str(want)[:32]}」这套换装（有：{'、'.join(have) or '无'}；见 studio cast）")
            self.outfit = want
        elif self.outfit_default and self.outfit_default in have:
            self.outfit = self.outfit_default
        elif self.outfit_default and strict:
            raise RuntimeError(f"角色 {self.id} 的默认换装「{self.outfit_default}」不在 sprites/ 里（有：{'、'.join(have) or '无'}）—— "
                               f"主人：node host/cli.mjs cast outfit {self.id} <换装>（不要换装了就 --clear）")
        else:
            self.outfit = have[0] if have else None
        return self.outfit

    def paint_ref(self):
        """这次穿的那套换装的一张全身立绘：给 AI 插画 / AI 封面当第一张参考图（不然插画里还是参考图上的衣服）。没有换装 = None"""
        if not self.outfit:
            return None
        root = self.dir / "sprites"
        sp = root / self.outfit
        for c in [sp / "neutral.png", *_png_files(sp)]:
            if c.is_file() and not _is_link(c) and EXPR_RE.fullmatch(c.stem) and _inside(c, sp) and _inside(c, root):
                return c
        return None

    def sprite(self, expr: str):
        """表情立绘（RGBA，已裁边）：这套换装里的指定表情 → neutral → 任意一张 → 参考图做成圆角卡片（不跨换装找，免得一条视频里换衣服）。
        表情名来自她写的剧本：只收合法的表情名，拼出来的路径解析后还必须在这个角色的 sprites/ 里
        （以前直接拼路径：写一个绝对路径 / ..，就能把任意 PNG 读进成片和 build/，她再用 Read 看）"""
        expr = expr or "neutral"
        if not EXPR_RE.fullmatch(str(expr)):
            raise RuntimeError(f"表情名「{str(expr)[:30]}」不合法（字母或汉字开头，只能有字母、汉字、数字、- 和 _，比如 happy）")
        key = (self.outfit, expr)
        if key in self._cache:
            return self._cache[key]
        from PIL import Image, ImageDraw
        root = self.dir / "sprites"
        sp = root / self.outfit if self.outfit else root
        cands = [sp / f"{expr}.png", sp / "neutral.png", *_png_files(sp)] if sp.is_dir() else []
        img = None
        whole = False
        for c in cands:
            # 不读链接（列表里也不算它们）；文件名要是合法表情名；解析后还在这一套 / 这个角色的 sprites/ 里
            if c.is_file() and not _is_link(c) and EXPR_RE.fullmatch(c.stem) and _inside(c, sp) and _inside(c, root):
                raw = Image.open(c).convert("RGBA")
                whole = whole_figure(raw)
                box = alpha_box(raw)
                img = raw.crop(box) if box else raw          # = trim_alpha(raw)
                self._src[key] = (c, raw.size, box)
                break
        if img is None and self.refs:
            ref = Image.open(self.refs[0]).convert("RGBA")
            if ref.getchannel("A").getextrema()[0] < 250:      # 参考图本身就是透明底
                whole = whole_figure(ref)
                img = trim_alpha(ref)
            else:
                ref = scale_h(ref, 900)
                mask = Image.new("L", ref.size, 0)
                ImageDraw.Draw(mask).rounded_rectangle((0, 0, ref.width, ref.height), radius=48, fill=255)
                ref.putalpha(mask)
                img = ref
        self._cache[key] = img
        self._whole[key] = whole
        return img

    def is_whole(self, expr: str) -> bool:
        """这张立绘是不是完整的一个人（全身立绘：脚下面还有透明的空白）—— 摆位置时要整个露出来，见 sprite_y"""
        self.sprite(expr)
        return self._whole.get((self.outfit, expr or "neutral"), False)

    def talk_sprite(self, expr: str):
        """张嘴的说话版：sprite(expr) 实际读的那张（没有这个表情就是退回的 neutral）在这一套 说话/ 里的同名图。
        按闭嘴那张的框裁：大小、位置和闭嘴版一模一样，两张换着放人不会跳。规矩和 sprite 一样：名字合法、不是链接、
        解析后还在 说话/、这一套、这个角色的 sprites/ 里。没有换装（平铺立绘）/ 没有同名的说话版 / 原图大小和闭嘴那张不一样 → None
        （照老样子只放闭嘴的）"""
        self.sprite(expr)                      # 先查表情名、定下闭嘴那张
        key = (self.outfit, expr or "neutral")
        if key in self._talk:
            return self._talk[key]
        img, src = None, self._src.get(key)
        if self.outfit and src:
            from PIL import Image
            f, size, box = src
            root = self.dir / "sprites"
            sp = root / self.outfit
            td = sp / TALK_DIR
            t = td / f.name
            if (td.is_dir() and not _is_link(td) and t.is_file() and not _is_link(t) and EXPR_RE.fullmatch(t.stem)
                    and _inside(t, td) and _inside(t, sp) and _inside(t, root)):
                raw = Image.open(t).convert("RGBA")
                if raw.size == size:
                    img = raw.crop(box) if box else raw
                else:
                    log(f"{self.id} 的说话版 {self.outfit}/{TALK_DIR}/{t.name} 和闭嘴那张大小不一样"
                        f"（{raw.size[0]}×{raw.size[1]} / {size[0]}×{size[1]}）→ 这个表情不做嘴型")
        self._talk[key] = img
        return img

    def voxcpm_ref(self) -> Path:
        """VoxCPM 的参考音：只认 profile.json 里 voxcpm.ref 写的文件名，文件必须就在这个角色目录里（cast voice --use 复制进来的）。
        剧本里的任何字段都碰不到这里 —— 不然她能把磁盘上随便哪个文件当参考音读进模型"""
        name = self.voxcpm.get("ref")
        if not (isinstance(name, str) and VOICE_REF_RE.fullmatch(name)):
            raise RuntimeError(f"角色 {self.id} 的 VoxCPM 参考音文件名不合法（{str(name)[:40]}）：只能是角色目录里的一个 .wav")
        p = self.dir / name
        if not (p.is_file() and _inside(p, self.dir)):
            raise RuntimeError(f"角色 {self.id} 的 VoxCPM 参考音不在角色目录里：{name} —— "
                               f"主人：node host/cli.mjs cast voice {self.id} --provider voxcpm --use <参考音.wav> --ref-text \"…\"")
        return p.resolve()


def load_cast(cfg: dict):
    d = Path(cfg.get("cast_dir") or "")
    out = {}
    if d.is_dir():
        for sub in sorted(d.iterdir()):
            if sub.is_dir() and (sub / "profile.json").is_file():
                out[sub.name] = Cast(d, sub.name, cfg)
    return out


def cast_in_video(script, scenes, cast, host):
    """这条视频会画到哪些角色（立绘、AI 插画的参考图、封面）—— 和下面 render 里的算法一样：
    开口的人（省略 who = 主角）+ 场景的 cast + 封面的 cast；插画场景里没人出场、或者 AI 封面没写 cast，会拿所有角色的参考图；主角总算（封面可能贴他的立绘）"""
    used, everyone = set(), False
    for sc in scenes:
        here = set()
        for line in sc.get("lines") or []:
            w = line.get("who") or host
            if isinstance(w, str) and w in cast and str(line.get("text", "")).strip():
                here.add(w)
        here |= {c for c in (sc.get("cast") or []) if isinstance(c, str) and c in cast}
        if not here and sc.get("illustration_prompt") and not sc.get("slide"):
            everyone = True
        used |= here
    cover = script.get("cover") or {}
    if isinstance(cover, dict) and cover.get("prompt"):
        cc = {c for c in (cover.get("cast") or []) if isinstance(c, str) and c in cast}
        used |= cc
        everyone = everyone or not cc
    if host:
        used.add(host)
    return set(cast) if everyone else used


def paint_refs(chars):
    """AI 插画 / AI 封面的参考图：每个角色先放这次那套换装的全身立绘，再放 ref*.png（最多 8 张，Painter 里截）；
    有换装时提示词里说明「衣服照全身立绘画」—— 参考图 ref*.png 和外貌描述里写的是默认那身衣服"""
    refs, dressed = [], []
    for c in chars:
        r = c.paint_ref()
        if r:
            refs.append(r)
            dressed.append(c.name)
        refs += c.refs[:2]
    note = (f" Clothing: {', '.join(dressed)} must wear exactly the outfit shown in their full-body reference image "
            f"(it overrides any clothing mentioned in the descriptions).") if dressed else ""
    return refs, note


# ─────────────── 配音（Edge 在线语音，句级时间轴）───────────────

def srt_cues(srt: str):
    def secs(t):
        h, m, s = t.replace(",", ".").split(":")
        return int(h) * 3600 + int(m) * 60 + float(s)
    cues = []
    for block in re.split(r"\r?\n\r?\n", srt.strip()):
        lines = block.strip().splitlines()
        if len(lines) >= 3 and "-->" in lines[1]:
            a, b = [x.strip() for x in lines[1].split("-->")]
            cues.append((secs(a), secs(b), " ".join(lines[2:]).strip()))
    return cues


async def _tts(text, voice, rate, pitch, out_mp3: Path):
    import edge_tts
    com = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, boundary="SentenceBoundary")
    sub = edge_tts.SubMaker()
    with open(out_mp3, "wb") as f:
        async for chunk in com.stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
            elif chunk["type"] in ("WordBoundary", "SentenceBoundary"):
                sub.feed(chunk)
    return srt_cues(sub.get_srt())


def _voice_cache(key, out_mp3: Path, cache_dir):
    """配音缓存放哪：给了 cache_dir（<数据目录>/cache/tts，她写不到）就按内容指纹命名放那里；
    没给（主人试听）才放 out_mp3 旁边。以前缓存在她的 build/ 里，改了 .json 里的字幕文字，重渲染就会把改过的字幕烧进成片"""
    if not cache_dir:
        return out_mp3
    d = Path(cache_dir)
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{key}.mp3"


def _cache_hit(mp3: Path, key, text):
    meta = mp3.with_suffix(".json")
    if not (mp3.is_file() and meta.is_file()):
        return None
    try:
        m = json.loads(meta.read_text(encoding="utf-8"))
    except Exception:
        return None
    if m.get("key") != key or not m.get("cues"):
        return None
    flat = lambda t: re.sub(r"[\W_]+", "", str(t))
    if flat("".join(str(c[2]) for c in m["cues"])) != flat(text):   # 字幕必须就是这句台词，不是就当没缓存
        return None
    return m["cues"], m["dur"]


def tts(text, voice, rate, pitch, out_mp3: Path, cache_dir=None):
    """带缓存：同一句同一个声音不重复合成。返回 (cues, 时长, mp3 路径)"""
    key = hashlib.sha1(json.dumps([text, voice, rate, pitch], ensure_ascii=False).encode("utf-8")).hexdigest()
    out_mp3 = _voice_cache(key, out_mp3, cache_dir)
    meta = out_mp3.with_suffix(".json")
    hit = _cache_hit(out_mp3, key, text)
    if hit:
        return (*hit, out_mp3)
    for attempt in range(3):
        try:
            cues = asyncio.run(_tts(text, voice, rate, pitch, out_mp3))
            break
        except Exception as e:
            if attempt == 2:
                raise RuntimeError(f"配音失败（{voice}）：{e}")
    dur = media_seconds(out_mp3)
    meta.write_text(json.dumps({"key": key, "cues": cues, "dur": dur}, ensure_ascii=False), encoding="utf-8")
    return cues, dur, out_mp3


# ─────────────── 配音（OpenAI 语音：能用文字描述语气）───────────────
#  它不返回时间轴 → 按句子分开合成再拼起来，每句的实际时长就是字幕时间轴

def split_sentences(text: str):
    parts = [p.strip() for p in re.findall(r"[^。！？!?；;…\n]+[。！？!?；;…]*|[。！？!?；;…]+", text) if p.strip()]
    out, carry = [], ""
    for p in parts:
        if not re.search(r"[\w一-鿿]", p):          # 只有标点（「……」）：并进上一句，开头的就带给下一句
            if out:
                out[-1] += p
            else:
                carry += p
            continue
        p, carry = carry + p, ""
        while len(p) > 48 and "，" in p[12:48]:              # 太长：在逗号处断开，字幕不至于三行
            cut = p.index("，", 12) + 1 if p.find("，", 12) < 48 else 48
            out.append(p[:cut])
            p = p[cut:]
        if out and len(re.sub(r"\W", "", p)) < 4:            # 太短（「嗯。」）：跟上一句连着念
            out[-1] += p
        else:
            out.append(p)
    return out or [text]


def openai_speech(text, voice, instructions, cfg, out_mp3: Path, cache_dir=None):
    """返回 (cues, 时长, mp3 路径)；缓存规则同 tts()"""
    key = os.environ.get("BILI_WHALE_IMAGE_KEY", "").strip()      # 和画图共用同一个 OpenAI key
    t = cfg.get("tts") or {}
    model = t.get("model") or "gpt-4o-mini-tts"
    base = str(t.get("baseUrl") or (cfg.get("image") or {}).get("baseUrl") or "https://api.openai.com/v1").rstrip("/")
    ck = hashlib.sha1(json.dumps(["openai", model, text, voice, instructions], ensure_ascii=False).encode("utf-8")).hexdigest()
    out_mp3 = _voice_cache(ck, out_mp3, cache_dir)
    meta = out_mp3.with_suffix(".json")
    hit = _cache_hit(out_mp3, ck, text)
    if hit:
        return (*hit, out_mp3)
    if not key:
        raise RuntimeError("配音用的是 OpenAI 语音，但没存 OpenAI key（node host/cli.mjs image-key）")
    pieces, cues, t0 = [], [], 0.0
    for k, sentence in enumerate(split_sentences(text)):
        body = {"model": model, "voice": voice, "input": sentence, "response_format": "mp3"}
        if instructions:
            body["instructions"] = instructions
        part = out_mp3.with_name(f"{out_mp3.stem}_p{k:02d}.mp3")
        for attempt in range(3):
            try:
                req = urllib.request.Request(base + "/audio/speech", data=json.dumps(body).encode("utf-8"), method="POST",
                                             headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=120) as r:
                    part.write_bytes(r.read())
                break
            except Exception as e:
                if attempt == 2:
                    raise RuntimeError(f"OpenAI 配音失败（{voice}）：{e}")
        d = media_seconds(part)
        cues.append((t0, t0 + d, sentence))
        t0 += d
        pieces.append(part)
    lst = out_mp3.with_suffix(".txt")
    lst.write_text("".join(f"file '{p.as_posix()}'\n" for p in pieces), encoding="utf-8")
    run_ffmpeg(["-f", "concat", "-safe", "0", "-i", str(lst), "-c:a", "libmp3lame", "-b:a", "160k", str(out_mp3)])
    dur = media_seconds(out_mp3)
    meta.write_text(json.dumps({"key": ck, "cues": cues, "dur": dur}, ensure_ascii=False), encoding="utf-8")
    return cues, dur, out_mp3


# ─────────────── 配音（VoxCPM2 本地模型：主人选定的原创音色）───────────────
#  模型跑在主人自己装的另一个虚拟环境里（torch + CUDA），这里只起它的 worker（studio/voxcpm_worker.py），不 import torch。
#  参考音只认角色目录里 profile.json 指定的那个 wav —— 剧本里的 voice / instructions 一概不看。
#  一次渲染只起一个 worker（模型加载要二十秒左右），缓存里没有的台词一次交给它；每配完一条台词马上存进缓存：
#  渲染中途被打断（超时、她的命令被掐掉），再渲染一次会接着配，配好的不白配。

VOXCPM_CFG, VOXCPM_STEPS = 2.0, 10
VOXCPM_GAP_END, VOXCPM_GAP_COMMA = 0.5, 0.25      # 一条台词里句与句之间补的停顿：模型念完几乎不留空，直接拼起来会显得赶
VOICE_REF_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,60}\.wav")
VOXCPM_WORKER = Path(__file__).resolve().parent / "voxcpm_worker.py"
TTS_PROVIDERS = ("edge", "openai", "voxcpm")
# worker 只拿到这些环境变量：用不着 key（BILI_WHALE_IMAGE_KEY）也不该联网；.studio-venv 的 PYTHON* / VIRTUAL_ENV 也别带过去
_VOX_ENV_KEEP = {"SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "HOME", "LOCALAPPDATA", "APPDATA",
                 "PROGRAMDATA", "PROGRAMFILES", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "COMSPEC", "CUDA_VISIBLE_DEVICES", "LANG"}
def _vox_model_id(model: str):
    """模型目录的「身份」：顶层文件名 + 大小 + 修改时间 + config.json 内容 —— 主人换了权重（哪怕大小一样），缓存就不再命中"""
    d = Path(model)
    files = sorted((f.name, f.stat().st_size, f.stat().st_mtime_ns) for f in d.iterdir() if f.is_file())
    conf = d / "config.json"
    return hashlib.sha256(json.dumps([files, conf.read_text(encoding="utf-8", errors="replace") if conf.is_file() else ""],
                                     ensure_ascii=False).encode("utf-8")).hexdigest()


def _voxcpm_setup(c, cfg):
    """这个角色用 VoxCPM 配音要的东西：都来自主人的配置和角色资料。缺什么就说清楚缺什么，不悄悄换回别的声音。
    一次渲染只取一次（记在这个角色对象上）：参考音的字节读进内存、按这份字节算缓存键，交给 worker 的也是这份字节的副本 ——
    渲染途中主人换了参考音（cast voice --use），这次渲染从头到尾还是同一个声音，缓存键也和音频对得上"""
    v = cfg.get("voxcpm") or {}
    py, model = str(v.get("python") or "").strip(), str(v.get("model") or "").strip()
    memo = (py, model, cfg.get("tts_cache_dir"))
    got = getattr(c, "_vox_setup", None)
    if got and got[0] == memo:
        return got[1]
    if not py or not Path(py).is_file():
        raise RuntimeError(f"VoxCPM 配音：找不到它的 Python（{py or '没配'}）—— 主人：node host/cli.mjs config set studio.voxcpm.python <VoxCPM 虚拟环境里的 python.exe>")
    if os.name == "nt" and Path(py).name.lower() not in ("python.exe", "pythonw.exe"):
        raise RuntimeError(f"VoxCPM 配音：studio.voxcpm.python 要指向 python.exe（现在是 {Path(py).name}）")   # .cmd / .bat 之类会被当成脚本跑
    if not model or not Path(model).is_dir():
        raise RuntimeError(f"VoxCPM 配音：模型目录不在（{model or '没配'}）—— 主人：node host/cli.mjs config set studio.voxcpm.model <VoxCPM2 模型目录>")
    if not cfg.get("tts_cache_dir"):
        raise RuntimeError("VoxCPM 配音要有配音缓存目录（tts_cache_dir）")
    ref = c.voxcpm_ref()
    ref_text = c.voxcpm.get("ref_text")
    fix = f"主人：node host/cli.mjs cast voice {c.id} --provider voxcpm --use <参考音.wav> --ref-text \"…\""
    if not isinstance(ref_text, str) or not ref_text.strip():
        raise RuntimeError(f"角色 {c.id} 的 VoxCPM 参考音缺「它念的是什么」（voxcpm.ref_text）—— {fix}")
    if len(ref_text) > 500 or _CTRL_NL.search(ref_text):
        raise RuntimeError(f"角色 {c.id} 的 VoxCPM 参考文字（voxcpm.ref_text）太长或带控制字符（换行 / Tab 之类），要 500 字以内的一行 —— {fix}")
    data = ref.read_bytes()
    s = {"python": py, "model": model, "ref_bytes": data, "ref_sha": hashlib.sha256(data).hexdigest(), "ref_text": ref_text.strip(),
         "model_id": _vox_model_id(model)}
    c._vox_setup = (memo, s)
    return s


def voxcpm_key(text, s):
    """缓存键：模型 + 参考音的内容（不是路径）+ 参考文字 + 生成参数 + 台词。换了参考音 / 模型 / 参数，旧缓存一律不认"""
    return hashlib.sha1(json.dumps(["voxcpm", s["model_id"], text, s["ref_sha"], s["ref_text"], VOXCPM_CFG, VOXCPM_STEPS,
                                    VOXCPM_GAP_END, VOXCPM_GAP_COMMA], ensure_ascii=False).encode("utf-8")).hexdigest()


def _voxcpm_job(text, c, cfg):
    s = _voxcpm_setup(c, cfg)
    key = voxcpm_key(text, s)
    return {"key": key, "text": text, "sentences": split_sentences(text), "s": s, "mp3": Path(cfg["tts_cache_dir"]) / f"{key}.mp3"}


def _vox_env():
    env = {k: v for k, v in os.environ.items() if k.upper() in _VOX_ENV_KEEP or k.upper().startswith("FAKE_VOXCPM_")}   # 后者：测试里假 worker 的开关
    env.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "TQDM_DISABLE": "1"})   # 渲染时绝不联网下模型（PYTHON* 在 -I 下本来就不生效）
    return env


def _silence(tmp: Path, fmt, seconds):
    import wave
    ch, sw, sr = fmt
    f = tmp / f"silence-{ch}-{sw}-{sr}-{int(seconds * 1000)}.wav"
    if not f.is_file():
        with wave.open(str(f), "wb") as w:
            w.setnchannels(ch)
            w.setsampwidth(sw)
            w.setframerate(sr)
            w.writeframes(b"\x00" * (int(sr * seconds) * ch * sw))
    return f


def _voxcpm_store(job, pieces, cache: Path, tmp: Path):
    """一条台词的几句拼成一个 mp3（句间补停顿）+ 字幕时间轴 = 每句的实际时长。
    先写临时文件再换名：同时在跑的别的渲染不会读到写了一半的缓存"""
    import wave
    parts, cues, t0, fmt = [], [], 0.0, None
    for k, (sentence, wav_path) in enumerate(zip(job["sentences"], pieces)):
        with wave.open(str(wav_path), "rb") as w:
            f = (w.getnchannels(), w.getsampwidth(), w.getframerate())
            d = w.getnframes() / w.getframerate()
        if fmt and f != fmt:
            raise RuntimeError("VoxCPM 输出的音频格式前后不一致")
        fmt = f
        cues.append([round(t0, 3), round(t0 + d, 3), sentence])
        parts.append(wav_path)
        t0 += d
        if k < len(pieces) - 1:
            gap = VOXCPM_GAP_END if re.search(r"[。！？!?…；;]$", sentence) else VOXCPM_GAP_COMMA
            parts.append(_silence(tmp, fmt, gap))
            t0 += gap
    lst = tmp / f"{job['key']}.txt"
    lst.write_text("".join(f"file '{p.as_posix()}'\n" for p in parts), encoding="utf-8")
    cache.mkdir(parents=True, exist_ok=True)
    mp3, meta = job["mp3"], job["mp3"].with_suffix(".json")
    part, meta_part = cache / f"{job['key']}.{os.getpid()}.part.mp3", cache / f"{job['key']}.{os.getpid()}.part.json"
    try:
        run_ffmpeg(["-f", "concat", "-safe", "0", "-i", str(lst), "-c:a", "libmp3lame", "-b:a", "160k", str(part)])
        dur = media_seconds(part)
        meta_part.write_text(json.dumps({"key": job["key"], "cues": cues, "dur": dur}, ensure_ascii=False), encoding="utf-8")
        try:
            os.replace(part, mp3)
            os.replace(meta_part, meta)
        except PermissionError:
            # Windows：同一条台词别的渲染刚存好、正被它的 ffmpeg 读着，换不了名 —— 那份是好的就用那份
            if not _cache_hit(mp3, job["key"], job["text"]):
                raise
    finally:
        part.unlink(missing_ok=True)
        meta_part.unlink(missing_ok=True)
        for p in pieces:               # 这条台词已经进缓存了：分句的 wav 不留着占地方（长视频能有几百 MB）
            Path(p).unlink(missing_ok=True)


def _gpu_busy(v):
    """显卡现在能不能让给 VoxCPM：空闲显存不够、或者一直在满负荷（主人在玩游戏 / 剪视频）就不抢 —— 抢了两边都卡，
    显存挤爆了模型还会慢到动不了。查不了（没有 nvidia-smi）就不拦。返回原因或 None"""
    need, busy = float(v.get("minFreeMB", 6500)), float(v.get("maxBusyPct", 50))
    exe = shutil.which("nvidia-smi")
    if not exe or (need <= 0 and busy >= 100):
        return None
    free, util = None, []
    try:
        for i in range(3):          # 利用率一会儿高一会儿低：取三次里最低的
            r = subprocess.run([exe, "--query-gpu=memory.total,memory.used,utilization.gpu", "--format=csv,noheader,nounits"],
                               capture_output=True, text=True, timeout=10, creationflags=0x08000000 if os.name == "nt" else 0)
            total, used, u = [float(x) for x in r.stdout.strip().splitlines()[0].split(",")]
            free, util = total - used, util + [u]
            if i < 2:
                time.sleep(0.4)
    except Exception:
        return None
    if free < need:
        return f"空闲显存 {free / 1024:.1f}GB，VoxCPM 要 {need / 1024:.1f}GB 左右"
    if min(util) > busy:
        return f"显卡一直在满负荷（{int(min(util))}%）"
    return None


def _voxcpm_sweep(cache: Path, keep: Path):
    """被硬掐掉的渲染（超时 / 后台命令被停）来不及清理：拿着显卡锁的时候（没有别的 VoxCPM 在跑）顺手删掉 6 小时前留下的临时目录和半截缓存"""
    cutoff = time.time() - 6 * 3600
    for d in Path(tempfile.gettempdir()).glob("whale-voxcpm-*"):
        try:
            if d != keep and d.is_dir() and d.stat().st_mtime < cutoff:
                shutil.rmtree(d, ignore_errors=True)
        except OSError:
            pass
    for f in cache.glob("*.part.*"):
        try:
            if f.stat().st_mtime < cutoff:
                f.unlink()
        except OSError:
            pass


def _voxcpm_synthesize(jobs, cfg):
    """起一个 worker 把 jobs 全配完；每配完一条马上存进缓存。出错 / 超时都抛 RuntimeError，worker 一定被收掉"""
    if not jobs:
        return
    v = cfg.get("voxcpm") or {}
    idle = max(1.0, float(v.get("idleTimeout") or 300))         # 这么久一点进展都没有（一句也没配完）就当卡死了
    cache = Path(cfg["tts_cache_dir"])
    worker = os.environ.get("BILI_WHALE_VOXCPM_WORKER") or str(VOXCPM_WORKER)   # 测试换成假的 worker；她改不了环境变量
    tmp = Path(tempfile.mkdtemp(prefix="whale-voxcpm-"))
    try:
        try:
            lock_wait = v.get("lockWait")   # 0 = 不等（以前 `or 30` 把 0 当成没设）
            lock = _file_lock(cache / "voxcpm", wait=30.0 if lock_wait is None else float(lock_wait))
            lock.__enter__()
        except RuntimeError:
            raise RuntimeError("VoxCPM 正在给另一个渲染 / 试听配音（一张显卡一次只跑一个）—— 等它配完再来") from None
        try:
            jobs = [j for j in jobs if not _cache_hit(j["mp3"], j["key"], j["text"])]   # 等锁的时候，别的渲染可能已经把这几条配好了
            if not jobs:
                return
            _voxcpm_sweep(cache, tmp)
            why = _gpu_busy(v)
            if why:
                raise RuntimeError(f"显卡现在被别的程序占着（{why}）—— 主人可能正在用电脑玩游戏 / 做别的，晚点再渲染；配好的台词都在缓存里，不会白配")
            _voxcpm_run(jobs, worker, tmp, cache, idle)
        finally:
            lock.__exit__(None, None, None)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _voxcpm_run(jobs, worker, tmp: Path, cache: Path, idle: float):
    s0 = jobs[0]["s"]
    errlog = tmp / "worker.log"
    refs = {}                          # 参考音用开始时读进内存的那份字节（缓存键就是按它算的），每种写一份到私有临时目录
    for j in jobs:
        s = j["s"]
        if s["ref_sha"] not in refs:
            refs[s["ref_sha"]] = tmp / f"ref-{s['ref_sha'][:16]}.wav"
            refs[s["ref_sha"]].write_bytes(s["ref_bytes"])
    items = [{"id": str(i), "ref": str(refs[j["s"]["ref_sha"]]), "ref_text": j["s"]["ref_text"], "sentences": j["sentences"]}
             for i, j in enumerate(jobs)]
    job = {"model": s0["model"], "out_dir": str(tmp), "cfg_value": VOXCPM_CFG, "steps": VOXCPM_STEPS, "items": items}

    def tail():
        try:
            return errlog.read_text(encoding="utf-8", errors="replace")[-800:]
        except OSError:
            return ""

    with open(errlog, "w", encoding="utf-8", errors="replace") as ef:
        # -I：不把 worker 所在目录 / 当前目录加进 sys.path；cwd 是这次的私有临时目录（不是她能写的作品目录）
        p = subprocess.Popen([s0["python"], "-I", worker], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=ef, cwd=str(tmp),
                             env=_vox_env(), creationflags=0x08000000 if os.name == "nt" else 0)   # CREATE_NO_WINDOW
        try:
            lines = queue.Queue()

            def pump():
                for raw in p.stdout:
                    lines.put(raw)
                lines.put(None)
            threading.Thread(target=pump, daemon=True).start()
            try:
                p.stdin.write((json.dumps(job, ensure_ascii=False) + "\n").encode("utf-8"))
                p.stdin.flush()
            except OSError:
                pass        # worker 没读 job 就退出了（Python 起不来之类）：下面读到 EOF，按「没启动起来」报，带上它的输出
            done, ready, stored = False, False, 0
            while not done:
                try:
                    raw = lines.get(timeout=idle)
                except queue.Empty:
                    what = "配音卡住了" if ready else "加载模型卡住了"
                    raise RuntimeError(f"VoxCPM {what}：{int(idle)} 秒没有进展（已配好 {stored}/{len(jobs)} 条，再渲染会接着配）\n{tail()}") from None
                if raw is None:
                    break
                try:
                    ev = json.loads(raw.decode("utf-8", "replace"))
                except ValueError:
                    continue
                if not isinstance(ev, dict):
                    continue
                if ev.get("event") == "error":
                    raise RuntimeError(f"VoxCPM 配音失败：{str(ev.get('error'))[:800]}（已配好 {stored}/{len(jobs)} 条）")
                if ev.get("event") == "ready":
                    ready = True
                elif ev.get("event") == "done":
                    done = True
                elif ev.get("event") == "item":
                    i = str(ev.get("id"))
                    if not i.isdigit() or int(i) >= len(jobs):
                        raise RuntimeError(f"VoxCPM worker 回了不认识的台词编号：{i[:20]}")
                    j, names = jobs[int(i)], ev.get("pieces")
                    if not isinstance(names, list) or len(names) != len(j["sentences"]):
                        raise RuntimeError("VoxCPM worker 回的分句数和台词对不上")
                    pieces = []
                    for n in names:
                        f = tmp / str(n)
                        if not (re.fullmatch(r"\d+-\d+\.wav", str(n)) and f.is_file() and _inside(f, tmp)):
                            raise RuntimeError(f"VoxCPM worker 回的文件不对：{str(n)[:60]}")
                        pieces.append(f)
                    _voxcpm_store(j, pieces, cache, tmp)
                    stored += 1
                    log(f"VoxCPM 配好 {stored}/{len(jobs)} 条")
            if not ready:
                try:
                    p.wait(timeout=10)      # 等它把错误写完再读日志
                except subprocess.TimeoutExpired:
                    pass
                raise RuntimeError(f"VoxCPM 没启动起来 —— 是主人那边 VoxCPM 的 Python / 模型环境的问题，再渲染也没用（主人：node host/cli.mjs doctor，"
                                   f"再用 cast voice <id> --provider voxcpm --try current 试一下）\n{tail()}")
            if not done or stored < len(jobs):
                raise RuntimeError(f"VoxCPM 配音进程中途退出了（已配好 {stored}/{len(jobs)} 条，再渲染会接着配）\n{tail()}")
        finally:
            try:
                p.stdin.close()
            except OSError:
                pass
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait(timeout=10)


def voxcpm_prepare(pairs, cfg):
    """pairs：这次渲染里所有 [(台词, 角色)]（角色 tts=voxcpm）。缓存里还没有的，一个 worker 一次配完 —— 下面逐句配音时都命中缓存"""
    todo, seen = [], set()
    for text, c in pairs:
        j = _voxcpm_job(text, c, cfg)
        if j["key"] in seen or _cache_hit(j["mp3"], j["key"], text):
            continue
        seen.add(j["key"])
        todo.append(j)
    if todo:
        log(f"VoxCPM 本地配音：{len(todo)} 条台词要配（模型加载二十秒左右，之后比实际时长稍慢）")
        _voxcpm_synthesize(todo, cfg)


def voxcpm_speech(text, c, cfg):
    """返回 (cues, 时长, mp3 路径)；一般已经被 voxcpm_prepare 配好在缓存里了，没有就单独为这一条起一次 worker"""
    j = _voxcpm_job(text, c, cfg)
    hit = _cache_hit(j["mp3"], j["key"], text)
    if not hit:
        _voxcpm_synthesize([j], cfg)
        hit = _cache_hit(j["mp3"], j["key"], text)
    if not hit:
        raise RuntimeError(f"VoxCPM 配好的音频没进缓存：{text[:30]}")
    return (*hit, j["mp3"])


def speak(text, c, cfg, script, line, out_mp3: Path):
    """按角色设定选配音：voxcpm（本地模型）/ openai（带语气描述）/ edge（免费）。返回 (cues, 时长, mp3 路径)"""
    cache = cfg.get("tts_cache_dir") or None
    if c and c.tts not in TTS_PROVIDERS:
        raise RuntimeError(f"角色 {c.id} 的配音方式「{str(c.tts)[:20]}」不认识（只有 {' / '.join(TTS_PROVIDERS)}）")   # 以前写错了就悄悄用 Edge
    if c and c.tts == "voxcpm":
        return voxcpm_speech(text, c, cfg)          # 剧本里的 voice / instructions 不看：音色只认主人设的参考音
    if c and c.tts == "openai":
        return openai_speech(text, line.get("voice") or c.voice, line.get("instructions") or c.instructions, cfg, out_mp3, cache)
    voice = line.get("voice") or (c.voice if c else (script.get("voice") or cfg.get("voice") or "zh-CN-XiaoxiaoNeural"))
    rate = script.get("rate") or (c.rate if c else cfg.get("rate") or "+0%")
    return tts(text, voice, rate, c.pitch if c else "+0Hz", out_mp3, cache)


def voices(cfg, provider, names, text, instructions, out_dir: Path):
    """试听：同一句话用几个声音各念一遍。voxcpm：names 是角色 id，用这个角色现在设的参考音念（和渲染走同一条路、同一个缓存）"""
    out_dir.mkdir(parents=True, exist_ok=True)
    made = []
    if provider == "voxcpm":
        cast = load_cast(cfg)
        for cid in names:
            c = cast.get(cid)
            if not c or c.tts != "voxcpm":
                raise RuntimeError(f"角色 {cid[:32]} 没设成 VoxCPM 配音（cast voice {cid[:32]} --provider voxcpm --use <参考音.wav>）")
            mp3 = voxcpm_speech(text, c, cfg)[2]
            f = out_dir / f"voxcpm-{cid}.mp3"
            shutil.copyfile(mp3, f)
            made.append(str(f))
        print(json.dumps({"ok": True, "files": made}, ensure_ascii=False))
        return
    for v in names:
        f = out_dir / f"{provider}-{v}.mp3"
        if provider == "openai":
            openai_speech(text, v, instructions, cfg, f)
        else:
            tts(text, v, cfg.get("rate") or "+0%", "+0Hz", f)
        made.append(str(f))
    print(json.dumps({"ok": True, "files": made}, ensure_ascii=False))


# ─────────────── 嘴型（说话的人在闭嘴版和张嘴版之间换着放）───────────────
#  跟着这句配音的响度走：每 80 毫秒算一次 RMS，够响就张嘴、静下来才闭（两道门槛，免得在门槛附近一抖一抖）。
#  80 毫秒分不出连着念的字（字和字之间响度只降一点，真配音试过：一张嘴就是一秒多），所以张着超过 4 格（0.32 秒）
#  就在里面最静的那一格闭一下。每次张嘴至少 2 格、闭嘴至少 1 格（30fps 下两三帧），不会一帧一闪

MOUTH_WIN = 0.08            # 秒
MOUTH_SR = 8000
MOUTH_FLOOR = 300           # 16 位采样的 RMS（约 -41 dBFS）：再小就当没声音（底噪、尾音）
MOUTH_ON, MOUTH_OFF = 0.35, 0.20        # 相对这句的响度（各格 RMS 的第 95 百分位）：到 ON 张嘴，掉到 OFF 以下才闭
MOUTH_MIN_OPEN, MOUTH_MAX_OPEN = 2, 4   # 按格算：只响 1 格的不张（咔哒声），张着超过 4 格的在最静处切开
MOUTH_SLIVER = 0.05         # 张嘴段被切片边界切得只剩这么点（一帧半）就不要了，免得切片边上闪一下
MOUTH_EXPR_MAX = 6000       # 一个切片的 enable 表达式最长多少字（命令行太长就这一片不做嘴型）


def pcm_mono(path: Path, sr=MOUTH_SR):
    """音频解成单声道 16 位 PCM（array('h')）"""
    r = subprocess.run([ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-i", str(path), "-ac", "1", "-ar", str(sr),
                        "-f", "s16le", "-"], capture_output=True)
    if r.returncode != 0:
        raise RuntimeError("ffmpeg 解码失败：" + r.stderr.decode("utf-8", "replace")[-400:])
    a = array.array("h")
    a.frombytes(r.stdout[:len(r.stdout) // 2 * 2])
    if sys.byteorder == "big":
        a.byteswap()
    return a


def mouth_spans_pcm(samples, sr=MOUTH_SR):
    """张嘴的时间段 [(开始秒, 结束秒)]，按这句配音自己的时间轴"""
    n = max(1, round(sr * MOUTH_WIN))
    rms = []
    for i in range(0, len(samples), n):
        w = samples[i:i + n]
        rms.append(math.sqrt(sum(x * x for x in w) / len(w)))
    if not rms:
        return []
    ref = sorted(rms)[int(0.95 * (len(rms) - 1))]
    if ref < MOUTH_FLOOR:
        return []
    on, off = max(MOUTH_FLOOR, MOUTH_ON * ref), max(MOUTH_FLOOR, MOUTH_OFF * ref)
    runs, start = [], None
    for i, v in enumerate(rms):
        if start is None and v >= on:
            start = i
        elif start is not None and v < off:
            runs.append((start, i))
            start = None
    if start is not None:
        runs.append((start, len(rms)))
    out, todo = [], [r for r in runs if r[1] - r[0] >= MOUTH_MIN_OPEN]
    while todo:
        a, b = todo.pop(0)
        if b - a <= MOUTH_MAX_OPEN:
            out.append((a, b))
            continue
        mid = (a + b - 1) / 2                  # 响度按 1% 一档比；一样静（拖长的音）就切在中间
        c = min(range(a + MOUTH_MIN_OPEN, b - MOUTH_MIN_OPEN), key=lambda i: (round(rms[i] / ref, 2), abs(i - mid)))
        todo[:0] = [(a, c), (c + 1, b)]
    end = len(samples) / sr
    return [(round(a * MOUTH_WIN, 3), round(min(b * MOUTH_WIN, end), 3)) for a, b in out]


def mouth_spans(mp3: Path):
    """这句配音的张嘴段；读不出来就当没有（这句照老样子只放闭嘴的），不拦渲染"""
    try:
        return mouth_spans_pcm(pcm_mono(mp3))
    except Exception as e:
        log(f"嘴型：读不出 {Path(mp3).name} 的响度（{str(e)[:120]}）→ 这句不做嘴型")
        return []


def clip_mouth(spans, start, end):
    """切片 [start, end) 里的张嘴段，换成切片自己的时间（从 0 开始）"""
    out = []
    for a, b in spans:
        a, b = max(a, start) - start, min(b, end) - start
        if b - a >= MOUTH_SLIVER:
            out.append((a, b))
    return out


def mouth_enable(spans):
    """ffmpeg 时间线表达式：t 落在任一张嘴段里时不为 0"""
    return "+".join(f"between(t,{a:.3f},{b:.3f})" for a, b in spans)


# ─────────────── 画面元素 ───────────────

def caption_layer(text, speaker=None, color=(255, 140, 90), area=(140, W - 140)):
    """透明层：底部字幕 + 说话人名牌。
    字幕不带底条（主人 2026-10-25：「字幕那边的黑框去掉」）：白字 + 深色描边 + 一层柔和的影子，浅色画面上也看得清"""
    from PIL import Image, ImageDraw, ImageFilter
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    if not text and not speaker:
        return layer
    d = ImageDraw.Draw(layer)
    left, right = area
    if text:
        f, lines, size = fit_text(text, right - left - 100, 2, 56, 38)
        if len(lines) == 2:                                   # 两行时尽量均分，别剩一个字孤零零在第二行
            balanced = wrap(text, f, int(f.getlength(text) / 2 + size * 1.5))
            if len(balanced) == 2:
                lines = balanced
        if len(lines) > 2:   # 调用方已经按页切好，这里放不下说明切页出了错 —— 宁可报错，也不悄悄丢字
            raise RuntimeError(f"字幕一页放不下（{len(lines)} 行）：{text[:30]}…")
        lh = int(size * 1.38)
        box_h = lh * len(lines) + 50
        top = H - 56 - box_h
        spots = [((left + right - f.getlength(line)) / 2, top + 25 + i * lh, line) for i, line in enumerate(lines)]
        # 影子只在字幕这一条里画、再模糊（整张 1920×1080 模糊太慢：一条视频几十页字幕）
        pad = 40
        shadow = Image.new("RGBA", (W, box_h + 2 * pad), (0, 0, 0, 0))
        sd = ImageDraw.Draw(shadow)
        for x, y, line in spots:
            sd.text((x + 3, y - top + pad + 4), line, font=f, fill=(0, 0, 0, 160), stroke_width=6, stroke_fill=(0, 0, 0, 160))
        layer.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(6)), (0, top - pad))
        for x, y, line in spots:
            d.text((x, y), line, font=f, fill=(255, 255, 255, 255), stroke_width=4, stroke_fill=(22, 18, 36, 235))
        if speaker:
            nf = font(34)
            nw = nf.getlength(speaker)
            d.rounded_rectangle((left + 30, top - 30, left + 30 + nw + 48, top + 22), radius=20, fill=(*color, 245))
            d.text((left + 54, top - 24), speaker, font=nf, fill=(255, 255, 255, 255))
    return layer


CAPTION_PAGE_FONT = 48     # 按这个字号切字幕页：每页 ≤ 2 行，画的时候再在 56→38 之间挑能放下的字号
SLIDE_BOTTOM = H - 230     # 幻灯片内容的下边界：再往下是字幕条
SLIDE_SPRITE_X, SLIDE_SPRITE_H = W - 250, 470   # 幻灯片场景里她站的位置（立绘中心的 x）和立绘高度：比普通场景小，站在右下角


def caption_pages(text: str, max_w: int):
    """长字幕切成几页（每页 ≤ 2 行），不截断任何字。
    每页直接从原文里切（不是把折好的行再拼回去）：原文里词和词之间的空格原样保留"""
    text = re.sub(r"\s*[\r\n]+\s*", " ", str(text)).strip()   # 一句字幕里的换行当空格（字幕条自己会折行）
    lines = wrap(text, font(CAPTION_PAGE_FONT), max_w)
    if len(lines) <= 2:
        return [text]
    spans, pos = [], 0
    for ln in lines:                       # wrap 只会去掉行首行尾的空白，所以每一行都按顺序出现在原文里
        s = text.find(ln, pos)
        if s < 0:                          # 理论上不会发生；万一发生就退回旧办法，也不丢字
            return [" ".join(lines[i:i + 2]) for i in range(0, len(lines), 2)]
        spans.append((s, s + len(ln)))
        pos = s + len(ln)
    return [text[spans[i][0]:spans[min(i + 1, len(spans) - 1)][1]] for i in range(0, len(spans), 2)]


def slide_layout(slide: dict, badge: str, x=120, badge_y=86, top=170, right=W - 120, title_w=1280, bullet_w=1120, bottom=SLIDE_BOTTOM, one_line=False):
    """幻灯片排版（深色那一页和纸卡那一页共用，只是框不一样）：x / right 是内容的左右边，角标在 (x, badge_y)、角注贴右上；
    标题从 top 开始，标题和要点一起缩字号，直到 bottom 以上放得下。
    缩到最小还放不下 → 报错让她拆页（不再悄悄画出画布 / 丢掉第 7 条以后的要点）；角注放不下也报错（以前悄悄截成 40 字）。
    one_line（纸卡用）：标题在 64 号以上能放成一行，就宁可小一号也不折成两行（深色那一页不用：和以前逐字节一样）"""
    title = str(slide.get("title") or "")
    bullets = [str(b) for b in (slide.get("bullets") or []) if str(b).strip()]
    if len(bullets) > 8:
        raise RuntimeError(f"幻灯片「{title[:20]}」有 {len(bullets)} 条要点，最多 8 条 —— 拆成两页")
    # 纸卡比深色那一页窄：14 个字的标题在 84 号会剩一个字在第二行，要点还被挤到最小号 —— 能一行就一行
    one = one_line and len(wrap(title, font(64), title_w)) == 1
    layout = None
    for ts in range(84, 47, -4):                     # 标题和要点一起缩，直到整页放得下
        tl = wrap(title, font(ts), title_w)
        if len(tl) > 2 or (one and len(tl) == 2):
            continue
        for bs in range(46, 29, -2):
            bf = font(bs)
            wrapped = [wrap(b, bf, bullet_w) for b in bullets]
            y_end = top + len(tl) * int(ts * 1.25) + 70 + sum(len(bl) * int(bs * 1.35) + 22 for bl in wrapped)
            if y_end <= bottom:
                layout = (ts, tl, bs, wrapped, y_end)
                break
        if layout:
            break
    if not layout:
        raise RuntimeError(f"幻灯片「{title[:20]}」内容太多，一页放不下 —— 拆成两页或把要点写短")
    note = None
    if slide.get("note"):
        nf = font(30)
        note = re.sub(r"\s+", " ", str(slide["note"])).strip()
        free = right - (x + (font(30).getlength(badge) + 40 if badge else 0) + 40)   # 右上角到角标之间的空
        if len(note) > 40 or nf.getlength(note) > free:   # 以前悄悄截成 40 字 —— 现在和标题 / 要点一样，放不下就说
            raise RuntimeError(f"幻灯片「{title[:20]}」的 note 太长（最多 40 字、一行放得下）—— 写短一点")
    ts, tl, bs, wrapped, y_end = layout
    return {"badge": badge, "note": note, "ts": ts, "tl": tl, "bs": bs, "wrapped": wrapped, "y_end": y_end,
            "x": x, "badge_y": badge_y, "top": top, "right": right}


def slide_draw(d, L, accent, ink, body_ink, note_ink):
    """按排版画字：角标（左上）→ 标题 → 强调色短横 → 要点（圆点 + 字）→ 角注（右上）"""
    x = L["x"]
    if L["badge"]:
        bf = font(30)
        bw = bf.getlength(L["badge"])
        d.rounded_rectangle((x, L["badge_y"], x + bw + 40, L["badge_y"] + 50), radius=10, fill=accent)
        d.text((x + 20, L["badge_y"] + 6), L["badge"], font=bf, fill=(20, 20, 30))
    ts, bs = L["ts"], L["bs"]
    tf, bf = font(ts), font(bs)
    y = L["top"]
    for line in L["tl"]:
        d.text((x, y), line, font=tf, fill=ink)
        y += int(ts * 1.25)
    d.rectangle((x, y + 14, x + 180, y + 22), fill=accent)
    y += 70
    for bl in L["wrapped"]:
        d.ellipse((x + 4, y + bs * 0.35, x + 4 + 18, y + bs * 0.35 + 18), fill=accent)
        for line in bl:
            d.text((x + 48, y), line, font=bf, fill=body_ink)
            y += int(bs * 1.35)
        y += 22
    if L["note"] is not None:
        nf = font(30)
        d.text((L["right"] - nf.getlength(L["note"]), L["badge_y"] + 10), L["note"], font=nf, fill=note_ink)


def slide_image(slide: dict, badge: str, accent=(255, 140, 90)):
    """讲解型幻灯片：深色底 + 细网格 + 标题 + 要点（右下角留给角色）。
    放不下就缩字号；缩到最小还放不下 → 报错让她拆页（见 slide_layout）"""
    from PIL import Image, ImageDraw
    L = slide_layout(slide, badge)
    img = Image.new("RGB", (W, H), (14, 20, 38))
    d = ImageDraw.Draw(img)
    for x in range(0, W, 64):
        d.line((x, 0, x, H), fill=(20, 28, 52))
    for y in range(0, H, 64):
        d.line((0, y, W, y), fill=(20, 28, 52))
    slide_draw(d, L, accent, (255, 255, 255), (220, 228, 245), (130, 145, 180))
    return img


# 幻灯片配画（v0.11.16）：主人看了栏目第一期 —— 「视频的中间只有蓝色背景，太单调了」。
# 剧本：slide 场景再加 bg_prompt（只写景、不画人）→ 背景换成她画的那张（静止、稍微柔化），字放在左边一张半透明的米白纸卡上；
# 她的立绘照样站在右下角（SLIDE_SPRITE_X），纸卡不挡她、也不挡字幕条（SLIDE_BOTTOM 以下）。画不出来就退回深色那一页
CARD_LEFT, CARD_TOP, CARD_RIGHT = 80, 48, W - 560   # 纸卡的左、上、右边：右边和幻灯片字幕条的右边（W - 560）对齐，再往右是她站的地方
CARD_PAD = (56, 34, 56, 26)                         # 纸边到字：左、上、右、下（下边从最后一条要点的行距之后算起，行距里已经有空）
CARD_MIN_H = 300                                    # 纸卡最矮多高（字很少时也像一张卡片）；高度跟着内容走，不再总是占满整页
CARD_ALPHA = 230                                    # 纸的不透明度（约 90%）：底下的画隐约透一点
CARD_RADIUS = 22
CARD_BODY_INK = (64, 76, 110)                       # 要点：比标题（COVER_INK）浅一点的蓝
CARD_SHADOW = (30, 26, 40, 78)                      # 纸下面那层柔和的影子：颜色 + 最深处的不透明度
CARD_SOFT_BLUR, CARD_SOFT_CONTRAST = 2.4, 0.86      # 背景画稍微柔化：轻轻模糊一点、对比度降一点 —— 纸卡上的字更醒目，画还看得清是她画的


def card_layout(slide: dict, badge: str):
    """纸卡那一页的排版：和深色那一页同一套缩字号 / 报错规矩（slide_layout），框换成纸卡里面。
    有角标或角注时第一行留给它们，标题往下挪；纸卡的高度 = 内容的高度（最矮 CARD_MIN_H），下边不超过 SLIDE_BOTTOM。
    纸卡比深色那一页窄、矮：深色那一页放得下、纸卡放不下时，报错里说清楚是纸卡的事（不然「最多 40 字」的角注 27 个字就被拦，看不懂）"""
    pl, pt, pr, pb = CARD_PAD
    x, right = CARD_LEFT + pl, CARD_RIGHT - pr
    badge_y = CARD_TOP + pt
    top = badge_y + 50 + 34 if badge or slide.get("note") else badge_y
    try:
        L = slide_layout(slide, badge, x=x, badge_y=badge_y, top=top, right=right, title_w=right - x, bullet_w=right - x - 48,
                         bottom=SLIDE_BOTTOM - pb, one_line=True)
    except RuntimeError as e:
        slide_layout(slide, badge)                    # 深色那一页也放不下 → 就报深色那一页的原话（去掉 bg_prompt 也没用）
        raise RuntimeError(f"{e}（这页配了画：纸卡比深色那一页窄、矮，放得下的字更少；不想改字就去掉这页的 bg_prompt）") from None
    L["card"] = (CARD_LEFT, CARD_TOP, CARD_RIGHT, max(CARD_TOP + CARD_MIN_H, L["y_end"] + pb))
    return L


def slide_card_image(slide: dict, badge: str, painting, accent=(255, 140, 90), layout=None):
    """幻灯片配画：她画的那张铺满整页（静止、稍微柔化）+ 左边一张半透明米白纸卡（圆角、暖色细边、下面一层柔和的影子）+ 纸卡上的字。
    字的颜色跟着纸走：标题深蓝（COVER_INK）、要点浅一点、角注灰蓝；角标、短横、圆点还是她的颜色"""
    from PIL import Image, ImageDraw, ImageEnhance, ImageFilter
    L = layout or card_layout(slide, badge)
    bg = cover_fit(painting).filter(ImageFilter.GaussianBlur(CARD_SOFT_BLUR))
    img = ImageEnhance.Contrast(bg).enhance(CARD_SOFT_CONTRAST).convert("RGBA")
    x0, y0, x1, y1 = L["card"]
    pad = 64                                              # 影子只在纸卡周围这一块里画、再模糊（整张模糊慢）
    mask = Image.new("L", (x1 - x0 + 2 * pad, y1 - y0 + 2 * pad), 0)
    ImageDraw.Draw(mask).rounded_rectangle((pad, pad + 12, pad + x1 - x0, pad + y1 - y0 + 12), radius=CARD_RADIUS, fill=CARD_SHADOW[3])
    mask = mask.filter(ImageFilter.GaussianBlur(16))
    ImageDraw.Draw(mask).rounded_rectangle((pad, pad, pad + x1 - x0, pad + y1 - y0), radius=CARD_RADIUS, fill=0)   # 纸底下不压暗：纸是半透明的，透过来的还是原来的画
    shadow = Image.new("RGBA", mask.size, CARD_SHADOW[:3] + (0,))
    shadow.putalpha(mask)
    img.alpha_composite(shadow, (x0 - pad, y0 - pad))
    paper = Image.new("RGBA", (x1 - x0 + 1, y1 - y0 + 1), (*COVER_PAPER, 0))
    ImageDraw.Draw(paper).rounded_rectangle((0, 0, x1 - x0, y1 - y0), radius=CARD_RADIUS, fill=(*COVER_PAPER, CARD_ALPHA),
                                            outline=(*NOTE_EDGE, 255), width=2)
    img.alpha_composite(paper, (x0, y0))
    img = img.convert("RGB")
    slide_draw(ImageDraw.Draw(img), L, accent, COVER_INK, CARD_BODY_INK, NOTE_LABEL_INK)
    return img


def badge_text(script):
    s = str(script.get("series") or "").strip()
    n = script.get("episode")
    return f"{s} {n}".strip() if s and n not in (None, "") else s


def full_title(script):
    s, n = str(script.get("series") or "").strip(), script.get("episode")
    t = str(script["title"]).strip()
    return f"【{s}{n}】{t}" if s and n not in (None, "") and not t.startswith("【") else t


COVER_INK = (34, 44, 78)            # 封面标题：深蓝字
COVER_PAPER = (252, 246, 234)       # 米白描边
COVER_DARK_LUMA = 118               # 标题底下的画面平均亮度低于这个就换白字


def make_cover(base_img, title, badge, out: Path, accent=(255, 170, 60), max_lines=2):
    """封面：插画 + 大字标题（左下）+ 左上角系列角标。
    标题（主人 2026-10-25 选的「方案 D」）：深蓝字 + 米白描边，不加暗角，像手账里写的标题；
    标题底下的画面偏暗时换成白字 + 深蓝描边 + 柔和的影子 + 一点渐暗，保证看得清。
    放不下就报错（以前缩到最小字号就不管了，字画出画布上沿 / 角标冲出右边）"""
    from PIL import Image, ImageDraw, ImageFilter, ImageStat
    tf, tl, ts = fit_text(title, 1700, 2, 136, 72)        # 最小字号还是 72：和以前能放下的字数一样（审查：76 时 45 字左右的封面字会在渲染最后才报错）
    tl = [line for line in tl if line.strip()]
    if not tl:                                            # 封面字是空的 / 只有空白：只要插画，不画字（以前 max() 遇到空列表直接崩）
        cover_fit(base_img).convert("RGB").save(out, "JPEG", quality=92)
        return
    if len(tl) > max_lines:
        raise RuntimeError(f"封面字太长（{len(tl)} 行，最多 {max_lines} 行）：「{str(title)[:20]}…」—— 把 cover.text 写短一点")
    bf = None
    if badge:
        for bs in range(76, 47, -4):                       # 栏目名长就缩角标，缩到最小还放不下才报错
            if 56 + font(bs).getlength(badge) + 64 <= W - 56:
                bf = font(bs)
                break
        if bf is None:
            raise RuntimeError(f"栏目角标太长：「{badge[:20]}…」—— 栏目名写短一点")
    img = cover_fit(base_img).convert("RGBA")
    lh = int(ts * 1.18)
    y0 = H - 70 - lh * len(tl)
    tw = max(int(tf.getlength(line)) for line in tl)
    dark = ImageStat.Stat(img.crop((90, max(0, y0), min(W, 90 + tw + 1), H - 50)).convert("L")).mean[0] < COVER_DARK_LUMA
    if dark:                                              # 暗画面：一点渐暗 + 影子，白字
        shade = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        sd = ImageDraw.Draw(shade)
        for i in range(420):
            sd.line((0, H - i, W, H - i), fill=(0, 0, 0, int(110 * (1 - i / 420))))
        img = Image.alpha_composite(img, shade)
        sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        shd = ImageDraw.Draw(sh)
        for i, line in enumerate(tl):
            shd.text((94, y0 + i * lh + 6), line, font=tf, fill=(0, 0, 0, 120), stroke_width=6, stroke_fill=(0, 0, 0, 120))
        img = Image.alpha_composite(img, sh.filter(ImageFilter.GaussianBlur(8)))
    d = ImageDraw.Draw(img)
    if badge:
        bw = bf.getlength(badge)
        d.rounded_rectangle((56, 50, 56 + bw + 64, 50 + 112), radius=22, fill=(*accent, 255))
        d.text((88, 50 + (112 - bf.size * 1.25) / 2 + 4), badge, font=bf, fill=(40, 24, 10), stroke_width=1, stroke_fill=(40, 24, 10))
    fill, stroke_w, stroke = ((255, 252, 245), 4, (28, 34, 60)) if dark else (COVER_INK, 6, COVER_PAPER)
    for i, line in enumerate(tl):
        d.text((90, y0 + i * lh), line, font=tf, fill=fill, stroke_width=stroke_w, stroke_fill=stroke)
    img.convert("RGB").save(out, "JPEG", quality=92)


# ─────────────── 便签（她旁边的一张手写卡片，念到那句时真的划掉）───────────────
#  主人给第一条视频写的台本（2026-10-25）：「旁边出现上一版的开头」「划掉『先说一次』」—— 画面上要真的有一道划线，不是幻灯片上的字。
#  剧本：scenes[i].note = {"text": 卡片上的字, "strike": 要划掉的几个字（text 里第一次出现的那处）, "label": 卡片上面的小字}；
#        lines[k].note = "show" / "strike" / "hide"，在这句开头生效。每个场景开头都是收着的；划过的收起来再拿出来，还是划过的
#  样子：米白纸 + 暖色细边，歪一点，顶上贴一条半透明胶带，下面一层柔和的影子；划线是手画的红笔道（微微起伏、两头多出去一点）。
#  层次：背景 → 听的人 → 便签 → 说话的人 → 字幕

NOTE_TEXT_MAX, NOTE_LABEL_MAX = 40, 12
NOTE_ACTIONS = ("show", "strike", "hide")
NOTE_INNER_W, NOTE_MIN_W = 760, 320       # 卡片里字的宽度上限 / 下限（字很少时卡片也不至于太窄）
NOTE_PAD = (46, 34, 50, 40)               # 纸边到字：左、上、右、下
NOTE_LABEL_SIZE = 28
NOTE_LABEL_INK = (112, 128, 156)          # 小字：灰蓝
NOTE_EDGE = (222, 204, 172)               # 纸的细边：暖一点的米色
NOTE_TAPE = (164, 208, 206, 170)          # 胶带：半透明的浅青（不和红笔道混）
NOTE_RED = (196, 58, 58)                  # 划线：暗一点的红
NOTE_STROKE_W, NOTE_OVERSHOOT = 7, 6      # 划线粗细 / 两头各多出去几像素
NOTE_TILT = -2.5                          # 度（负 = 顺时针歪）
NOTE_MARGIN = 56                          # 纸四周留的空：放胶带和影子，歪过来也不裁边
NOTE_LEFT, NOTE_TOP = 140, 110            # 纸（没歪时）的左上角：没人 / 只有她（站右边）时贴左上
NOTE_FADE = 0.25                          # 出现：淡入几秒
NOTE_STRIKE_AT, NOTE_STRIKE_DUR = 0.1, 0.5   # 划：这句开始后几秒下笔、几秒画完


def note_layout(note: dict):
    """便签排版（没歪的纸上的坐标）：字号 64→40 挑能放进两行的最大号（40 个全角字两行要 36），两行时尽量均分；
    要划掉的几个字落在哪一行的哪一段 —— 折到两行就是两段，每段两头各多出 NOTE_OVERSHOOT，竖着穿过这几个字的中间"""
    text = str(note.get("text") or "").strip()
    label = str(note.get("label") or "").strip()
    f, lines, size = fit_text(text, NOTE_INNER_W, 2, 64, 36)
    if len(lines) == 2:                                   # 和字幕一样：别剩一两个字孤零零在第二行
        balanced = wrap(text, f, int(f.getlength(text) / 2 + size * 1.5))
        if len(balanced) == 2 and all(f.getlength(ln) <= NOTE_INNER_W for ln in balanced):
            lines = balanced
    if not lines or len(lines) > 2:
        raise RuntimeError(f"便签「{text[:20]}」放不下（最多两行）—— 写短一点")
    left, top, right, bottom = NOTE_PAD
    ascent, descent = f.getmetrics()
    lh = int(size * 1.34)
    label_h = int(NOTE_LABEL_SIZE * 1.7) if label else 0
    inner = max([f.getlength(ln) for ln in lines] + ([font(NOTE_LABEL_SIZE).getlength(label)] if label else []) + [NOTE_MIN_W])
    ys = [top + label_h + i * lh for i in range(len(lines))]
    spans, pos = [], 0
    for ln in lines:                                      # 每一行在原文里的位置（wrap 只去掉行首行尾的空白）
        s = text.find(ln, pos)
        if s < 0:
            raise RuntimeError(f"便签「{text[:20]}」排版出错")
        spans.append((s, s + len(ln)))
        pos = s + len(ln)
    segs = []
    strike = note.get("strike")
    if strike and strike in text:
        a = text.find(strike)
        b = a + len(strike)
        for ln, (s, e), y in zip(lines, spans, ys):
            lo, hi = max(a, s) - s, min(b, e) - s
            part = ln[lo:hi] if lo < hi else ""
            if not part.strip():
                continue
            lo += len(part) - len(part.lstrip())              # 两头的空格不划
            hi -= len(part) - len(part.rstrip())
            bb = f.getbbox(ln[lo:hi])
            segs.append((left + f.getlength(ln[:lo]) - NOTE_OVERSHOOT, left + f.getlength(ln[:hi]) + NOTE_OVERSHOOT,
                         y + (bb[1] + bb[3]) / 2))
    return {"text": text, "label": label, "font": f, "size": size, "lines": lines, "xy": [(left, y) for y in ys],
            "label_xy": (left, top), "segs": segs, "w": int(left + inner + right),
            "h": int(top + label_h + lh * (len(lines) - 1) + ascent + descent + bottom)}


def _note_strokes(L):
    """划线的折线（每段一条）：手画的样子，微微起伏、略斜。起伏按便签上的字定 —— 同一张便签每一帧都是同一条线，只是画到哪儿不一样"""
    h = hashlib.md5(L["text"].encode("utf-8")).digest()
    ph1, ph2, slope = h[0] / 40.0, h[1] / 40.0, (h[2] / 255 - 0.5) * 5
    paths = []
    for x0, x1, y in L["segs"]:
        n = max(2, int((x1 - x0) / 8))
        xs = [x0 + (x1 - x0) * j / n for j in range(n + 1)]
        paths.append([(x, y + slope * (j / n - 0.5) + 1.5 * math.sin(x * 0.045 + ph1) + 0.7 * math.sin(x * 0.12 + ph2))
                      for j, x in enumerate(xs)])
    return paths


def _cut_paths(paths, frac):
    """几段折线按总长度只画前 frac（0–1）：先画完第一段（上一行），再画下一段"""
    lens = [sum(math.dist(p[j], p[j + 1]) for j in range(len(p) - 1)) for p in paths]
    rest = max(0.0, min(1.0, frac)) * sum(lens)
    out = []
    for p, ln in zip(paths, lens):
        if rest <= 0:
            break
        if rest >= ln:
            out.append(p)
            rest -= ln
            continue
        q = [p[0]]
        for j in range(len(p) - 1):
            d = math.dist(p[j], p[j + 1])
            if rest >= d:
                q.append(p[j + 1])
                rest -= d
                continue
            t = rest / d if d else 0
            q.append((p[j][0] + (p[j + 1][0] - p[j][0]) * t, p[j][1] + (p[j + 1][1] - p[j][1]) * t))
            break
        out.append(q)
        break
    return out


def note_paper(note: dict, reveal=1.0, layout=None):
    """没歪的那张纸（RGBA，大小 = 排版的 w × h）：小字 + 正文 + 划线画到 reveal（0 = 没划，1 = 划完）"""
    from PIL import Image, ImageDraw
    L = layout or note_layout(note)
    w, h = L["w"], L["h"]
    img = Image.new("RGBA", (w, h), (*NOTE_EDGE, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, w - 1, h - 1), radius=8, fill=(*COVER_PAPER, 255), outline=(*NOTE_EDGE, 255), width=2)
    if L["label"]:
        d.text(L["label_xy"], L["label"], font=font(NOTE_LABEL_SIZE), fill=NOTE_LABEL_INK)
    for xy, ln in zip(L["xy"], L["lines"]):
        d.text(xy, ln, font=L["font"], fill=COVER_INK)
    drawn = _cut_paths(_note_strokes(L), reveal) if reveal > 0 else []
    if drawn:                                             # 两倍大画再缩回来：笔道边缘是平滑的
        mask = Image.new("L", (w * 2, h * 2), 0)
        md = ImageDraw.Draw(mask)
        r = NOTE_STROKE_W
        for q in drawn:
            pts = [(x * 2, y * 2) for x, y in q]
            if len(pts) >= 2:
                md.line(pts, fill=235, width=NOTE_STROKE_W * 2, joint="curve")
            for x, y in (pts[0], pts[-1]):                # 圆头
                md.ellipse((x - r, y - r, x + r, y + r), fill=235)
        img.paste(Image.new("RGBA", (w, h), (*NOTE_RED, 255)), (0, 0), mask.resize((w, h), Image.LANCZOS))
    return img


def note_card(note: dict, reveal=1.0, alpha=1.0, layout=None):
    """贴到画面上的便签（RGBA）：纸 + 胶带，歪 NOTE_TILT 度，下面一层柔和的影子；alpha 是淡入用的整体不透明度。
    纸（没歪时）的中心就是这张图的中心（摆位置见 note_xy）。同一张便签每一帧大小都一样，影子和胶带只算一次（存在排版里）"""
    from PIL import Image, ImageChops, ImageDraw, ImageFilter
    L = layout or note_layout(note)
    m = NOTE_MARGIN
    size = (L["w"] + 2 * m, L["h"] + 2 * m)
    paper = Image.new("RGBA", size, (*NOTE_EDGE, 0))
    paper.alpha_composite(note_paper(note, reveal, L), (m, m))
    paper = paper.rotate(NOTE_TILT, resample=Image.BICUBIC, expand=True, fillcolor=(*NOTE_EDGE, 0))
    if "_shadow" not in L:
        shadow = Image.new("RGBA", paper.size, (24, 18, 12, 0))
        shadow.putalpha(ImageChops.offset(paper.getchannel("A"), 6, 10).point(lambda v: int(v * 0.42)))
        L["_shadow"] = shadow.filter(ImageFilter.GaussianBlur(9))
        tw, th = 176, 44                                  # 胶带：两头剪成锯齿，自己再多歪一点，压在纸的上沿
        strip = Image.new("RGBA", (tw + 20, th + 20), (*NOTE_TAPE[:3], 0))
        zig = [(10 + (6 if k % 2 else 0), 10 + th * k / 6) for k in range(7)]
        ImageDraw.Draw(strip).polygon(zig + [(10 + tw - (6 if k % 2 else 0), 10 + th * k / 6) for k in range(6, -1, -1)], fill=NOTE_TAPE)
        strip = strip.rotate(4, resample=Image.BICUBIC, expand=True, fillcolor=(*NOTE_TAPE[:3], 0))
        tape = Image.new("RGBA", size, (*NOTE_TAPE[:3], 0))
        tape.alpha_composite(strip, (int(m + L["w"] / 2 - strip.width / 2), int(m + 2 - strip.height / 2)))
        L["_tape"] = tape.rotate(NOTE_TILT, resample=Image.BICUBIC, expand=True, fillcolor=(*NOTE_TAPE[:3], 0))
    out = L["_shadow"].copy()
    out.alpha_composite(paper)
    out.alpha_composite(L["_tape"])
    if alpha < 1:
        out.putalpha(out.getchannel("A").point(lambda v: int(round(v * max(0.0, alpha)))))
    return out


def note_xy(card, layout, n_present: int):
    """便签图贴在画面上的左上角：没有立绘 / 只有一个人（站右边）→ 左上，纸（没歪时）的左上角在 (NOTE_LEFT, NOTE_TOP)；
    两个人（一左一右）→ 上方正中。都在字幕条上面"""
    cx = W / 2 if n_present >= 2 else NOTE_LEFT + layout["w"] / 2
    cy = NOTE_TOP + layout["h"] / 2
    # 取偶数：动画那一页是 ffmpeg 在 yuv420 里叠的，x / y 会被往下取成偶数；静止页是 PIL 按原像素画的 —— 奇数时两种页之间整张便签跳 1 像素
    return 2 * round((cx - card.width / 2) / 2), 2 * round((cy - card.height / 2) / 2)


def note_frames(dur: float, appear: bool, strike: bool, fps=FPS):
    """动画那一页逐帧的（不透明度, 划线画到几成）：出现 = 开头 NOTE_FADE 秒淡入；划 = 开头 NOTE_STRIKE_AT 秒后下笔、
    NOTE_STRIKE_DUR 秒从左画到右。这一页太短（一句里的第一页只有半秒之类）就整体按比例压缩，保证在这一页的倒数第二帧之前画完。
    最后一个就是最终状态（之后一直停在它）"""
    end = NOTE_STRIKE_AT + NOTE_STRIKE_DUR if strike else (NOTE_FADE if appear else 0.0)
    k = min(1.0, max(0.0, dur - 2.0 / fps) / end) if end else 0.0
    if k <= 0:
        return [(1.0, 1.0 if strike else 0.0)]
    out = []
    for i in range(math.ceil(end * k * fps - 1e-9) + 1):
        t = i / fps
        a = min(1.0, t / (NOTE_FADE * k)) if appear else 1.0
        r = min(1.0, max(0.0, (t - NOTE_STRIKE_AT * k) / (NOTE_STRIKE_DUR * k))) if strike else 0.0
        out.append((round(a, 4), round(r, 4)))
    return out


def note_png_frames(note: dict, layout, frames, base_reveal: float, strike: bool, prefix: Path):
    """把动画那一页逐帧存成 <prefix>-000.png、-001.png …（ffmpeg 按图片序列读）；返回给 ffmpeg 的文件名模式。
    先删掉同名的旧帧（上次渲染这句的帧更多，多出来的会被一起读进去）"""
    for old in prefix.parent.glob(prefix.name + "-*.png"):
        old.unlink()
    made = {}
    for i, (a, r) in enumerate(frames):
        key = (a, r if strike else base_reveal)
        f = prefix.parent / f"{prefix.name}-{i:03d}.png"
        if key in made:
            shutil.copyfile(made[key], f)
        else:
            note_card(note, key[1], a, layout).save(f)
            made[key] = f
    return str(prefix.parent).replace("%", "%%") + os.sep + prefix.name.replace("%", "%%") + "-%03d.png"


# ─────────────── 剧本 ───────────────

FORMATS = ("diary", "dialogue", "explainer", "story")


def _need_str(v, where, optional=True):
    """会被念出来 / 画出来 / 上传的文字只收字符串：以前对象会被 str() 成「{'s': '…'}」照样念、照样上传，查重那边却只看到 [object Object]"""
    if v is None and optional:
        return
    if not isinstance(v, str):
        die(f"script.json 里 {where} 必须是字符串（现在是 {type(v).__name__}）")


_CTRL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]")
_CTRL_NL = re.compile(r"[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]")


def _no_ctrl(v, where, allow_newline=False):
    """会上传 / 给主人审的文字里不许有控制字符：终端转义序列能让主人审片时看到的和真正上传的不一样（藏字、改写前面的行）"""
    if isinstance(v, str) and (_CTRL if allow_newline else _CTRL_NL).search(v.replace("\r\n", "\n").replace("\t", " ")):
        die(f"script.json 里 {where} 有控制字符（看不见的字符 / 转义序列）—— 去掉")


def validate_script(s):
    """和 tools/lib/originality.mjs 的 scriptText 读同样的字段、同样的形状 —— 两边对「剧本里有哪些字」的理解不能有分歧"""
    if not isinstance(s, dict):
        die("script.json 顶层必须是一个对象")
    _need_str(s.get("title"), "title", optional=False)
    _need_str(s.get("desc"), "desc")
    _need_str(s.get("series"), "series")
    _no_ctrl(s.get("title"), "title")
    _no_ctrl(s.get("desc"), "desc", allow_newline=True)
    _no_ctrl(s.get("series"), "series")
    tags = s.get("tags")
    if tags is not None and not (isinstance(tags, list) and all(isinstance(t, str) for t in tags)):
        die('script.json 里 tags 必须是字符串数组，比如 ["日记", "AI"]（不是 "日记,AI"）')
    for i, t in enumerate(tags or []):
        _no_ctrl(t, f"tags[{i}]")
    cover = s.get("cover")
    if cover is not None:
        if not isinstance(cover, dict):
            die("script.json 里 cover 必须是对象")
        _need_str(cover.get("text"), "cover.text")
        _no_ctrl(cover.get("text"), "cover.text", allow_newline=True)
    # 换装（2026-10-24）：{"角色 id": "换装名"}。这里只查形状（交审 / 查重时也走这里，不能要求目录还在）；角色和换装在不在，render 开头查
    of = s.get("outfit")
    if of is not None:
        if not isinstance(of, dict):
            die('script.json 里 outfit 必须是对象：{"角色 id": "换装名"}，比如 {"<角色id>": "外出"}（见 studio cast）')
        for k, v in of.items():
            if not (isinstance(k, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,32}", k)):
                die(f"script.json 里 outfit 的键「{str(k)[:32]}」不是角色 id（见 studio cast）")
            if not outfit_name_ok(v):
                die(f"script.json 里 outfit.{k}「{str(v)[:30]}」不是合法的换装名（字母或汉字开头，只能有字母、汉字、数字、- 和 _；见 studio cast）")
    if "scenes" in s and not isinstance(s["scenes"], list):
        die("script.json 里 scenes 必须是数组")
    if "scenes" in s and s.get("segments"):
        die("script.json 里 scenes 和 segments 只能有一个（segments 是旧格式）")
    for i, x in enumerate(s.get("segments") or []):
        if not isinstance(x, dict):
            die(f"segments[{i}] 必须是对象")
        _need_str(x.get("text"), f"segments[{i}].text")
    for i, sc in enumerate(s.get("scenes") or []):
        if not isinstance(sc, dict):
            die(f"scenes[{i}] 必须是对象")
        sl = sc.get("slide")
        if sl is not None:
            if not isinstance(sl, dict):
                die(f"scenes[{i}].slide 必须是对象")
            _need_str(sl.get("title"), f"scenes[{i}].slide.title")
            _need_str(sl.get("note"), f"scenes[{i}].slide.note")
            b = sl.get("bullets")
            if b is not None and not (isinstance(b, list) and all(isinstance(x, str) for x in b)):
                die(f"scenes[{i}].slide.bullets 必须是字符串数组")
        _need_str(sc.get("bg_prompt"), f"scenes[{i}].bg_prompt")
        # 幻灯片配画（v0.11.16）：slide + bg_prompt。以前 slide 配 illustration_prompt 时插画被悄悄丢掉（幻灯片优先）
        if sl and sc.get("illustration_prompt"):
            die(f"scenes[{i}] 里 slide 不能配 illustration_prompt（插画会把你画进图里，和右边的立绘重了）"
                f"—— 幻灯片要配画就写 bg_prompt（只写景、不画人）")
        # 便签（2026-10-25，见 note_layout）：{"text": 1–40 字、一行, "strike": text 里原样有的几个字, "label": ≤ 12 字}
        nt = sc.get("note")
        if nt is not None:
            if not isinstance(nt, dict):
                die(f'scenes[{i}].note 必须是对象，比如 {{"text": "先说一次：我是 AI。", "strike": "先说一次"}}')
            if sl is not None:
                die(f"scenes[{i}] 里 note 和 slide 不能一起用（幻灯片上已经有字了）—— 便签放到没有幻灯片的场景里")
            for key, req in (("text", True), ("label", False)):
                _need_str(nt.get(key), f"scenes[{i}].note.{key}", optional=not req)
                if isinstance(nt.get(key), str) and _CTRL_NL.search(nt[key]):
                    die(f"script.json 里 scenes[{i}].note.{key} 有换行 / Tab / 控制字符 —— 便签上的字只写一行")
            n = len(nt["text"].strip())
            if not 1 <= n <= NOTE_TEXT_MAX:
                die(f"scenes[{i}].note.text 要 1–{NOTE_TEXT_MAX} 个字（现在 {n} 个）")
            if isinstance(nt.get("label"), str) and len(nt["label"]) > NOTE_LABEL_MAX:
                die(f"scenes[{i}].note.label 最多 {NOTE_LABEL_MAX} 个字（现在 {len(nt['label'])} 个）")
            st = nt.get("strike")
            _need_str(st, f"scenes[{i}].note.strike")
            if st is not None and (not st or st not in nt["text"].strip()):
                die(f"scenes[{i}].note.strike「{st[:20]}」要是 note.text 里原样有的几个字（划掉第一次出现的那处）")
        lines = sc.get("lines")
        if lines is not None and not isinstance(lines, list):
            die(f"scenes[{i}].lines 必须是数组")
        struck = visible = False
        for k, l in enumerate(lines or []):
            if not isinstance(l, dict):
                die(f"scenes[{i}].lines[{k}] 必须是对象")
            _need_str(l.get("text"), f"scenes[{i}].lines[{k}].text")
            ex = l.get("expr")
            if ex not in (None, "") and not (isinstance(ex, str) and EXPR_RE.fullmatch(ex)):
                die(f"scenes[{i}].lines[{k}].expr「{str(ex)[:30]}」不是合法的表情名（字母或汉字开头，只能有字母、汉字、数字、- 和 _；见 studio cast）")
            act = l.get("note")
            if act is not None:                       # 便签动作：在这句开头生效
                where = f"scenes[{i}].lines[{k}].note"
                if not (isinstance(act, str) and act in NOTE_ACTIONS):
                    die(f"{where}「{str(act)[:20]}」只能是 show / strike / hide")
                if nt is None:
                    die(f"{where} 要这个场景先有 scenes[{i}].note（便签上写什么）—— 便签只属于写它的那个场景，要回头看划过的那张，就别在中间换场景")
                if not str(l.get("text") or "").strip():
                    die(f"{where}：这句台词是空的（空句子会被跳过，动作就没了）—— 写到有台词的那句上")
                if act == "strike":
                    if nt.get("strike") is None:
                        die(f"{where} 是 strike，但 scenes[{i}].note 没写 strike（划掉哪几个字）")
                    if struck:
                        die(f"{where}：这张便签已经划过了，一个场景只划一次")
                    struck = True
                visible = visible or act in ("show", "strike")
        if nt is not None and not visible:            # 场景开头便签是收着的：没有 show / strike 就一直看不见，渲染也不会说
            die(f'scenes[{i}].note 写了，但这个场景没有哪句写 "note": "show" 或 "strike" —— 场景开头便签是收着的，不写就一直不出来')


def load_script(proj: Path, script_file: Path = None):
    raw = None
    try:
        raw = (script_file or proj / "script.json").read_bytes()
        s = json.loads(raw.decode("utf-8"))
    except Exception as e:
        die(f"script.json 读不了：{e}")
    validate_script(s)
    if not s["title"].strip():
        die("script.json 缺 title")
    scenes = s.get("scenes")
    if "scenes" not in s and s.get("segments"):   # 兼容旧格式：一段 = 一个场景、一句旁白（只在完全没有 scenes 时）
        scenes = [{"bg_prompt": x.get("image_prompt", ""), "lines": [{"text": x.get("text", "")}]} for x in s["segments"]]
    scenes = [sc for sc in (scenes or []) if any(str(l.get("text", "")).strip() for l in sc.get("lines") or [])]
    s["_sha256"] = hashlib.sha256(raw).hexdigest()   # 这次读到的剧本是哪一份（render 回报给 node 核对）
    if not scenes:
        die("script.json 没有可念的内容（scenes[].lines[].text 都是空的）")
    if s.get("format") and s["format"] not in FORMATS:
        die(f"format 只能是 {' / '.join(FORMATS)}")
    return s, scenes


# ─────────────── 自查图（v0.11.20：她渲染完只 Read 这一张）───────────────
#  测量（2026-10-25）：她那一个长会话里 Read 进去 118 张图（cover.jpg、bg*.png、cap*.png、nt*.png），约 14–19 万 token，
#  是会话不到一天就满、被自动压缩的主要原因。现在渲染最后拼一张 build/check.jpg（1280 宽，每页 ≤ 1.15 MP）：
#    封面（约首页推荐里那么大）+ 每个场景一格（从这个场景的切片里抽一帧；格子上写「场景 N · 第 K 句 · 分:秒」，
#    要了画没画出来的、有字体里没有的字（画出来是方框）的，框成琥珀色、右上角写原因；封面也一样）
#    + 下面最多四格放大（便签划完 / 出现的样子，收起后又拿出来的再放大一格；字最多的几页字幕）。
#  格子里幻灯片的字只有五六个像素高、看不清：方框字由 missing_glyphs 在渲染时查出来（不靠她看），缺了哪几个字写进回报。
#  场景多就分页（check-2.jpg、check-3.jpg，最多 3 页）；再多就均匀抽，第一个、最后一个、有便签的、框成琥珀色的一定留着。
#  每一格的大图另存 build/frame-sNN.jpg（1280×720，NN = 场景号）：哪一格看不清再单独看那一张。
#  build/check.json 记每个切片在成片里的时间、每一格画的是什么、在哪（以后单独抽帧用；测试也靠它找格子）。
#  做不成（抽帧失败、超时……）不拦渲染：调用方清掉做了一半的文件，check_pages = 0，check_error 说原因

SHEET_W, SHEET_GAP, SHEET_COLS = 1280, 4, 4
SHEET_MAX_PX = 1_150_000                  # 每页最多这么多像素（再大，看图时也会被缩小，白花）
SHEET_HEAD = 26                           # 页头那一行字
SHEET_FIRST, SHEET_MORE, SHEET_PAGES = 11, 16, 3   # 第 1 页 11 个场景（+ 封面 = 12 格）+ 放大格；后面每页 16 格；最多 3 页
SHEET_DETAILS, SHEET_DETAIL_H = 4, 126    # 第 1 页下面的放大格：最多 4 格，两格一行（格子里上面一条是标签）
SHEET_LABEL_H, SHEET_LABEL_SIZE = 20, 15  # 每一格上面那一条标签（在画面外面：不挡封面角标、便签、幻灯片的字）
SHEET_BG, SHEET_INK, SHEET_LABEL_BG = (22, 24, 32), (236, 238, 244), (10, 10, 16)
SHEET_WARN_INK = (255, 184, 40)           # 琥珀色：要了画、没画出来
SHEET_BUDGET, SHEET_GRAB_TIMEOUT = 120.0, 30   # 整个自查图最多花几秒 / 抽一帧最多等几秒
SHEET_MAX_BYTES = 400_000                 # 一页 JPEG 超过这么大就降一档质量再存
SHEET_QUALITY, FRAME_QUALITY = 82, 85
FRAME_W, FRAME_H = 1280, 720
INTRO_S = 2.2                             # 片头多长（和下面做片头的 -t 2.2 一样）：切片在成片里的时间 = 片头 + 前面切片的长度
SHEET_FILES = ("check*.jpg", "check.json", "frame-*.jpg", "check*.part", "frame-*.part")


_GLYPHS = {}                              # 字体路径 → {字: 有没有}（None 这个键存「没有的字」画出来的样子）
GLYPH_PROBE = "\U0010FFFD"                # 哪个字体都不会有的码位（第 16 平面的私用区最后一个）：画出来就是字体的「没有这个字」方框


def _glyph_look(f, ch):
    from PIL import Image, ImageDraw
    l, t, r, b = f.getbbox(ch)
    im = Image.new("L", (max(1, r - l), max(1, b - t)))
    ImageDraw.Draw(im).text((-l, -t), ch, font=f, fill=255)
    return (l, t, r, b, f.getlength(ch), im.tobytes())


def missing_glyphs(*texts) -> str:
    """这些字里当前字体（_FONT["path"]）没有的，按第一次出现的顺序、不重复。画字只用这一个字体（Pillow 不会找别的字体补），
    没有的字画出来是字体自带的方框 —— 和 GLYPH_PROBE 画出来一模一样的就算没有。空白、换行之类本来就画不出东西，不算。
    有一期数学讲解的复查里，纸卡上 x₁、ℝ、aᵢ、⊆、⇔、∀ 全是方框（雅黑没有这几个字），格子里只是一点糊，看不出来"""
    import unicodedata
    f = font(40)
    seen = _GLYPHS.setdefault(_FONT["path"], {})
    if None not in seen:
        seen[None] = _glyph_look(f, GLYPH_PROBE)
    out = []
    for ch in dict.fromkeys("".join(str(t) for t in texts if t)):
        if ch.isspace() or unicodedata.category(ch) == "Cc":
            continue
        if ch not in seen:
            try:
                seen[ch] = _glyph_look(f, ch) == seen[None]
            except Exception:               # 这个字连量都量不了（落单的代理码之类）：不在这里拦渲染，画字那一步自己会报
                seen[ch] = False
        if seen[ch]:
            out.append(ch)
    return "".join(out)


def glyph_names(chars: str) -> str:
    """给人看的缺字列表：看得见的字原样，看不见的（变体选择符、零宽字符之类）写成 U+XXXX"""
    import unicodedata
    return " ".join(ch if unicodedata.category(ch)[0] not in "MCZ" else f"U+{ord(ch):04X}" for ch in chars)


def _join_warn(*parts):
    return " · ".join(p for p in parts if p) or None


def _clear_sheet(build: Path):
    """删掉 build/ 里的自查图、大图、check.json 和没写完的临时文件（删不掉的不管：之后写的时候会失败，自查图就算没做成）"""
    for pat in SHEET_FILES:
        for f in build.glob(pat):
            with contextlib.suppress(OSError):
                f.unlink()


def _write_atomic(dest: Path, data: bytes):
    """先写进同目录下一个新建的临时文件（O_EXCL：那个名字已经有东西就失败 —— 不会顺着别人放的链接写到别处），写完整个换上去"""
    part = dest.with_name(f"{dest.name}.{uuid.uuid4().hex[:12]}.part")
    fd = os.open(part, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o644)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(part, dest)
    except BaseException:
        with contextlib.suppress(OSError):
            part.unlink()
        raise


def _jpeg(img, quality, limit=None):
    """JPEG 字节（4:4:4，字边不糊）；给了 limit 就在超过时降一档质量再试（最多降两档）"""
    import io
    for q in (quality, quality - 10, quality - 20):
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=q, subsampling=0, optimize=True)
        if limit is None or buf.tell() <= limit or q == quality - 20:
            return buf.getvalue()


def _grab_frame(clip: Path, t: float, timeout=SHEET_GRAB_TIMEOUT):
    """从切片里抽 t 秒那一帧（W×H RGB）。-f mov：只当 MP4 读 —— build/ 里一个冒名的文本播放列表（ffconcat）不会被当成播放列表、
    去读别处的文件；只许读本地文件。抽不到（超过结尾之类）就抛"""
    from PIL import Image
    try:
        r = subprocess.run([ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-f", "mov", "-protocol_whitelist", "file",
                            "-ss", f"{max(0.0, t):.3f}", "-i", str(clip), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                           capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"从 {clip.name} 抽一帧超过 {timeout} 秒") from None
    n = W * H * 3
    if r.returncode != 0 or len(r.stdout) < n:
        raise RuntimeError(f"抽不出 {clip.name} 的 {t:.2f} 秒：" + r.stderr.decode("utf-8", "replace").strip()[-120:])
    return Image.frombytes("RGB", (W, H), r.stdout[:n])


def _even(items, k):
    """从 items 里均匀挑 k 个（保持顺序；k ≥ 个数就全要）"""
    items = list(items)
    if k <= 0:
        return []
    if k >= len(items):
        return items
    return [items[int((j + 0.5) * len(items) / k)] for j in range(k)]


def check_layout(n: int, keep=()):
    """n 个场景放进自查图：返回每一页放哪几个场景（plan 里的下标，按顺序）。第 1 页 SHEET_FIRST 个（前面还有封面那一格），
    后面每页 SHEET_MORE 个，最多 SHEET_PAGES 页。放不下就均匀抽：第一个、最后一个、keep 里的（有便签的、画没画出来的）一定留着"""
    if n <= 0:
        return [[]]
    room = SHEET_FIRST + SHEET_MORE * (SHEET_PAGES - 1)
    if n <= room:
        chosen = list(range(n))
    else:
        must = sorted({0, n - 1, *(k for k in keep if isinstance(k, int) and 0 < k < n - 1)})
        if len(must) > room:                     # 一定要留的都放不下：它们之间也均匀抽（头尾照样留着）
            must = [0, *_even(must[1:-1], room - 2), n - 1]
        taken = set(must)
        chosen = sorted(taken | set(_even([i for i in range(n) if i not in taken], room - len(must))))
    return [chosen[:SHEET_FIRST]] + [chosen[i:i + SHEET_MORE] for i in range(SHEET_FIRST, len(chosen), SHEET_MORE)]


def sheet_geometry(n_tiles: int, n_details: int = 0):
    """一页的高和每一格的位置：返回 (高, 格子框列表, 放大格框列表)，框是 (x0, y0, x1, y1)。
    格子框只是画面那一块，标签条在它上面 SHEET_LABEL_H 像素；放大格的标签在格子里面。每页 ≤ SHEET_MAX_PX，超了就报错"""
    tw = (SHEET_W - SHEET_GAP * (SHEET_COLS + 1)) // SHEET_COLS
    th = round(tw * 9 / 16)
    left = (SHEET_W - tw * SHEET_COLS - SHEET_GAP * (SHEET_COLS - 1)) // 2
    y = SHEET_HEAD + SHEET_GAP
    row = SHEET_LABEL_H + th + SHEET_GAP
    tiles = []
    for i in range(n_tiles):
        r, c = divmod(i, SHEET_COLS)
        x0, y0 = left + c * (tw + SHEET_GAP), y + r * row + SHEET_LABEL_H
        tiles.append((x0, y0, x0 + tw, y0 + th))
    y += max(1, math.ceil(n_tiles / SHEET_COLS)) * row
    cells = []
    n_details = max(0, min(SHEET_DETAILS, n_details))
    cw = (SHEET_W - 2 * left - SHEET_GAP) // 2
    for i in range(n_details):
        r, c = divmod(i, 2)
        x0, y0 = left + c * (cw + SHEET_GAP), y + r * (SHEET_DETAIL_H + SHEET_GAP)
        cells.append((x0, y0, x0 + cw, y0 + SHEET_DETAIL_H))
    y += math.ceil(n_details / 2) * (SHEET_DETAIL_H + SHEET_GAP)
    if SHEET_W * y > SHEET_MAX_PX:
        raise RuntimeError(f"自查图一页太大（{SHEET_W}×{y}）")
    return y, tiles, cells


def _mmss(t: float) -> str:
    t = max(0, int(round(t)))
    return f"{t // 60}:{t % 60:02d}"


def _fit_line(text: str, f, max_w: float) -> str:
    text = re.sub(r"\s+", " ", str(text)).strip()
    if f.getlength(text) <= max_w:
        return text
    while text and f.getlength(text + "…") > max_w:
        text = text[:-1]
    return text + "…"


def _sheet_tag(d, x, y, parts, max_w):
    """一条小标签：深色底条，上面几段字 [(字, 颜色)]，一段接一段；放不下就把后面的截短加 …"""
    f = font(SHEET_LABEL_SIZE)
    d.rectangle((x, y, x + max_w - 1, y + SHEET_LABEL_H - 1), fill=SHEET_LABEL_BG)
    cx = x + 6
    for text, ink in parts:
        room = x + max_w - 6 - cx
        if room < f.getlength("……"):
            break
        text = _fit_line(text, f, room)
        d.text((cx, y), text, font=f, fill=ink)
        cx += f.getlength(text) + 10


def _sheet_warn(d, box, warn):
    """这一格有问题（要了画没画出来、有方框字）：整格框一圈琥珀色，右上角写原因（这一格的画面本来就不对，挡一点不要紧）"""
    x0, y0, x1, y1 = box
    d.rectangle((x0, y0, x1 - 1, y1 - 1), outline=SHEET_WARN_INK, width=3)
    f = font(SHEET_LABEL_SIZE)
    warn = _fit_line(warn, f, x1 - x0 - 24)
    ww = int(f.getlength(warn)) + 12
    d.rectangle((x1 - 3 - ww, y0 + 3, x1 - 4, y0 + 2 + SHEET_LABEL_H), fill=SHEET_LABEL_BG)
    d.text((x1 - 3 - ww + 6, y0 + 3), warn, font=f, fill=SHEET_WARN_INK)


def note_again(sh):
    """一个场景的切片里，便签收起之后又拿出来的那一页（有好几次就要最后一次；没有就 None）：
    自查图多放大这一格，她看「回头再拿出来时还是划着的」（以前看 nt*.png 那一串）"""
    hit, gone, seen = None, False, False
    for s in sh:
        if s["note"]:
            if gone:
                hit = s
            seen, gone = True, False
        elif seen:
            gone = True
    return hit


def make_check_sheet(build: Path, cover: Path, plan, shots, seconds, title, final_sha, cover_warn=None):
    """拼自查图（见上面这一节的说明）：写 build/check.jpg（+ check-2.jpg、check-3.jpg）、每一格的 build/frame-sNN.jpg、build/check.json，
    返回页数。抽帧都从这次渲染的切片 build/cNNNN.mp4 里抽（和成片同一份画面，不用解整条成片）。出错就抛：调用方接住、清掉、渲染照样成功。
    cover_warn：封面那一格的问题（要了封面画、没画出来 / 封面字有方框），和场景格子一样框成琥珀色"""
    from PIL import Image, ImageDraw
    t0 = time.monotonic()
    t_at = INTRO_S
    for s in shots:                                       # 每个切片在成片里从第几秒开始（片头 2.2 秒之后一个接一个）
        s["at"] = round(t_at, 3)
        t_at += s["dur"]
    by_scene = {}
    for s in shots:
        by_scene.setdefault(s["si"], []).append(s)
    keep = [si for si, p in enumerate(plan) if p.get("warn") or p["scene"].get("note")]
    pages = check_layout(len(plan), keep)
    shown_n = sum(len(pg) for pg in pages)

    def when(s, where):                                   # 抽哪一帧：动过的那一页抽最后（便签划完 / 出现之后的样子），别的抽中间
        return s["clip"], round(max(0.0, s["dur"] - 0.1) if where == "end" else s["dur"] / 2, 3)

    # 每个上图的场景抽哪一帧：有便签就抽它划完（没划就是出现）那一页的最后一帧；没有就抽第一句的中间
    tiles = {}
    for si in (i for pg in pages for i in pg):
        sh = by_scene.get(si) or []
        if sh:
            pick = next((s for s in sh if s["note"] == "struck"), None) or next((s for s in sh if s["note"]), None)
            tiles[si] = (pick, "end") if pick else (sh[0], "mid")
    # 放大格：便签（每个有便签的场景一格；收起后又拿出来的，有空再放大那一页 —— 便签最多 2 格）
    #   + 字最多的几页字幕（有名牌的先占一格，尽量不同场景）
    details = []
    for si in sorted(tiles):
        s, where = tiles[si]
        if s["note"] and s.get("note_box") and len(details) < 2:
            details.append(("note", s, where, s["note_box"]))
    for si in sorted(tiles):
        s = note_again(by_scene.get(si) or [])
        if s and s.get("note_box") and len(details) < 2 and all(d[1] is not s for d in details):
            details.append(("note-again", s, "end", s["note_box"]))
    details.sort(key=lambda d: d[1]["clip"])
    caps = sorted((s for s in shots if s.get("cap_box")), key=lambda s: (-s["chars"], s["clip"]))
    free = SHEET_DETAILS - len(details)
    chosen = [s for s in caps if s["names"]][:1][:free]
    for s in caps:
        if len(chosen) < free and s not in chosen and all(c["si"] != s["si"] for c in chosen):
            chosen.append(s)
    for s in caps:
        if len(chosen) < free and s not in chosen:
            chosen.append(s)
    details += [("caption", s, "mid", s["cap_box"]) for s in sorted(chosen, key=lambda s: s["clip"])]

    # 抽帧：同一帧只抽一次；抽完马上缩成格子 / 存大图 / 裁放大格，不把整张 1920×1080 留在内存里
    x0, y0, x1, y1 = sheet_geometry(1)[1][0]
    tw, th = x1 - x0, y1 - y0
    jobs = {}
    for si, (s, where) in tiles.items():
        jobs.setdefault(when(s, where), []).append(("tile", si))
    for k, (_, s, where, _) in enumerate(details):
        jobs.setdefault(when(s, where), []).append(("detail", k))
    thumbs, frames_meta, crops = {}, {}, {}
    for (clip_i, t) in sorted(jobs):
        if time.monotonic() - t0 > SHEET_BUDGET:
            raise RuntimeError(f"抽帧超过 {int(SHEET_BUDGET)} 秒，没做完")
        try:
            frame = _grab_frame(build / f"c{clip_i:04d}.mp4", t)
        except RuntimeError:
            if t <= 0:
                raise
            frame = _grab_frame(build / f"c{clip_i:04d}.mp4", 0.0)   # 时间算得比切片实际长了一点点（帧对齐）：退到开头那一帧
        for kind, k in jobs[(clip_i, t)]:
            if kind == "tile":
                s = tiles[k][0]
                thumbs[k] = (frame.resize((tw, th), Image.LANCZOS), s["at"] + t)
                name = f"frame-s{plan[k]['no']:02d}.jpg"
                _write_atomic(build / name, _jpeg(frame.resize((FRAME_W, FRAME_H), Image.LANCZOS), FRAME_QUALITY))
                frames_meta[k] = name
            else:
                x0, y0, x1, y1 = details[k][3]
                pad = 10
                crops[k] = frame.crop((max(0, x0 - pad), max(0, y0 - pad), min(W, x1 + pad), min(H, y1 + pad)))
        del frame

    # 拼页
    n_pages = len(pages)
    meta_tiles, meta_details = [], []
    for pi, pg in enumerate(pages):
        items = ([None] if pi == 0 else []) + [si for si in pg if si in thumbs]
        h, tboxes, cboxes = sheet_geometry(len(items), len(details) if pi == 0 else 0)
        img = Image.new("RGB", (SHEET_W, h), SHEET_BG)
        d = ImageDraw.Draw(img)
        more = f"（场景太多，抽了 {shown_n} 个）" if shown_n < len(plan) else ""
        head = f"自查图 {pi + 1}/{n_pages} · {seconds:g} 秒 · {len(plan)} 个场景{more} · {title}"
        d.text((8, 2), _fit_line(head, font(17), SHEET_W - 16), font=font(17), fill=SHEET_INK)
        for si, box in zip(items, tboxes):
            x0, y0, x1, y1 = box
            if si is None:                                # 封面：缩到和首页推荐里差不多大
                with Image.open(cover) as cv:
                    img.paste(cv.convert("RGB").resize((x1 - x0, y1 - y0), Image.LANCZOS), (x0, y0))
                _sheet_tag(d, x0, y0 - SHEET_LABEL_H, [("封面（首页推荐里差不多这么大）", SHEET_INK)], x1 - x0)
                if cover_warn:
                    _sheet_warn(d, box, cover_warn)
                meta_tiles.append({"page": pi + 1, "scene": 0, "box": list(box), "warn": cover_warn})
                continue
            thumb, at = thumbs[si]
            s = tiles[si][0]
            img.paste(thumb, (x0, y0))
            warn = plan[si].get("warn")
            _sheet_tag(d, x0, y0 - SHEET_LABEL_H, [(f"场景 {plan[si]['no']} · 第 {s['line']} 句 · {_mmss(at)}", SHEET_INK)], x1 - x0)
            if warn:
                _sheet_warn(d, box, warn)
            meta_tiles.append({"page": pi + 1, "scene": plan[si]["no"], "line": s["line"], "at": round(at, 3), "box": list(box),
                               "warn": warn, "frame": frames_meta[si]})
        if pi == 0:
            for k, ((kind, s, _, _), box) in enumerate(zip(details, cboxes)):
                x0, y0, x1, y1 = box
                d.rectangle(box, fill=(34, 36, 46))
                label = (f"便签放大 · 场景 {s['scene']}" + ("（划完）" if s["note"] == "struck" else "")) if kind == "note" \
                    else f"便签放大 · 场景 {s['scene']} 第 {s['line']} 句（收起后又拿出来）" if kind == "note-again" \
                    else f"字幕放大 · 场景 {s['scene']} 第 {s['line']} 句"
                _sheet_tag(d, x0, y0, [(label, SHEET_INK)], x1 - x0)
                crop = crops[k]
                aw, ah = x1 - x0 - 8, y1 - y0 - SHEET_LABEL_H - 6
                sc = min(aw / crop.width, ah / crop.height, 1.0)
                crop = crop.resize((max(1, round(crop.width * sc)), max(1, round(crop.height * sc))), Image.LANCZOS)
                img.paste(crop, (x0 + (x1 - x0 - crop.width) // 2, y0 + SHEET_LABEL_H + 3 + (ah - crop.height) // 2))
                meta_details.append({"page": 1, "kind": kind, "scene": s["scene"], "line": s["line"], "box": list(box)})
        _write_atomic(build / ("check.jpg" if pi == 0 else f"check-{pi + 1}.jpg"), _jpeg(img, SHEET_QUALITY, SHEET_MAX_BYTES))
    meta = {"v": 1, "final_sha": final_sha, "seconds": seconds, "pages": n_pages, "scenes": len(plan), "sampled": shown_n < len(plan),
            "clips": [{"file": s["clip"], "scene": s["scene"], "line": s["line"], "page": s["page"], "at": s["at"], "dur": s["dur"]} for s in shots],
            "tiles": meta_tiles, "details": meta_details}
    _write_atomic(build / "check.json", json.dumps(meta, ensure_ascii=False, indent=1).encode("utf-8"))
    return n_pages


# ─────────────── render ───────────────

SCENERY = "Scenery background only, no people, no characters, no text. 16:9."   # bg_prompt 的画（普通场景和幻灯片配画同一句：同一个 bg_prompt 共用缓存）


def _sha256_file(p: Path):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def render(proj: Path, cfg: dict, script_file: Path = None):
    """script_file：node 那边先把 script.json 复制一份到私有临时目录再交给这里 —— 渲染的几分钟里她改了作品目录里的剧本，
    也影响不到这次渲染；回报里带上读到的剧本指纹，node 核对"""
    from PIL import Image
    _FONT["path"] = find_font(cfg.get("font", ""))
    script, scenes = load_script(proj, script_file)
    fmt = script.get("format") or "diary"
    cast = load_cast(cfg)
    host = cfg.get("host") if cfg.get("host") in cast else (next(iter(cast)) if cast else None)
    # 换装：这次每个角色穿哪套 —— 在清掉旧的 build、加载配音模型之前定好，写错了马上报错。
    # 只给这条视频会画到的角色定（别的角色的默认换装坏了不拦这条视频，回报里也不列它们）
    want = script.get("outfit") or {}
    for k in want:
        if k not in cast:
            die(f"outfit 里的角色「{k}」不在角色表里（可用：{', '.join(cast) or '无'}）")
    used = cast_in_video(script, scenes, cast, host)
    for c in cast.values():
        try:
            c.use_outfit(want.get(c.id), strict=c.id in used or c.id in want)
        except RuntimeError as e:
            die(str(e))
    painter = Painter(cfg)
    build = proj / "build"
    build.mkdir(exist_ok=True)
    for old in [*build.glob("c*.mp4"), *build.glob("nt*.png")]:   # 便签逐帧图也清掉：她自查看 nt*.png，别看到上次渲染留下的
        old.unlink()
    _clear_sheet(build)                     # 上次的自查图 / 大图也清掉：这次做不成时，她不会看到上一次的
    badge = badge_text(script)
    title = full_title(script)

    def who_of(line):
        w = line.get("who") or host
        if w and w not in cast and w != "narrator":
            die(f"台词里的 who「{w}」不在角色表里（可用：{', '.join(cast) or '无'}）")
        return w if w in cast else None

    # 0) VoxCPM 本地配音：缓存里没有的台词先一次配好（模型只加载一次），下面逐句配音时直接命中缓存
    vox = []
    for sc in scenes:
        for line in sc.get("lines") or []:
            text = str(line.get("text", "")).strip()
            c = cast.get(who_of(line)) if text and who_of(line) else None
            if c and c.tts == "voxcpm":
                vox.append((text, c))
    voxcpm_prepare(vox, cfg)

    # 1) 配音（先全部合成，拿到每个场景的总时长 → 背景平移才能跨句连续）
    plan = []
    for si, sc in enumerate(scenes):
        lines = []
        for li, line in enumerate(sc.get("lines") or []):
            text = str(line.get("text", "")).strip()
            if not text:
                continue
            c = cast.get(who_of(line)) if who_of(line) else None
            cues, dur, mp3 = speak(text, c, cfg, script, line, build / f"s{si:02d}l{li:02d}.mp3")
            pause = float(line.get("pause", 0.35 if fmt != "story" else 0.6))
            lines.append({"cast": c, "text": text, "expr": line.get("expr") or "neutral", "mp3": mp3, "k": li,   # k：剧本里第几句（自查图上写的）
                          "cues": cues or [(0.0, dur, text)], "dur": dur, "pause": pause, "note": line.get("note")})
        plan.append({"scene": sc, "lines": lines, "total": sum(l["dur"] + l["pause"] for l in lines)})
    log(f"配音完成：{sum(len(p['lines']) for p in plan)} 句")

    # 2) 每个场景的背景
    all_refs = [r for c in cast.values() for r in c.refs[:2]]
    raw_scenes = script.get("scenes") if isinstance(script.get("scenes"), list) else []
    missing = []                            # 字体里没有的字：[{"scene": 场景号（0 = 封面）, "chars": "ℝ⊆"}]（回报里给 node 打出来）
    for si, p in enumerate(plan):
        sc = p["scene"]
        # 自查图上写的场景号 = 剧本 scenes 里的第几个（没台词的场景渲染时被跳过，不能用 si）；旧格式 segments 就是 si + 1
        p["no"] = next((i + 1 for i, x in enumerate(raw_scenes) if x is sc), si + 1)
        p["warn"] = None
        present = []
        for l in p["lines"]:
            if l["cast"] and l["cast"] not in present:
                present.append(l["cast"])
        for cid in sc.get("cast") or []:
            if cid in cast and cast[cid] not in present:
                present.append(cast[cid])
        p["present"] = present
        bg, kind = None, "gradient"
        if sc.get("slide"):
            accent = present[0].color if present else (255, 140, 90)
            png = None
            if str(sc.get("bg_prompt") or "").strip():       # 幻灯片配画：字放在纸卡上、叠在她画的画上
                try:
                    card = card_layout(sc["slide"], badge)    # 先排版：放不下在出图之前就报错，不白花一张
                except RuntimeError:
                    if painter.enabled:
                        raise
                    card = None                               # 没开出图：本来就画不出来，纸卡放不下不拦渲染（深色那一页也放不下的话，下面照样报错）
                    log(f"场景 {si + 1} 的幻灯片在纸卡上放不下，也没开 AI 出图 → 用深色幻灯片")
                if card:
                    png = painter.paint(f"{sc['bg_prompt']}\n{SCENERY}")
                    if not png:
                        log(f"场景 {si + 1} 的幻灯片配画没画出来（{'没开 AI 出图' if not painter.enabled else '见上一行'}）→ 用深色幻灯片")
            bg = slide_card_image(sc["slide"], badge, Image.open(png), accent, card) if png else slide_image(sc["slide"], badge, accent)
            kind = "slide"
            if str(sc.get("bg_prompt") or "").strip() and not png:
                p["warn"] = "配画没画出来→深色页"
        elif sc.get("illustration_prompt"):
            refs, dress = paint_refs(present or list(cast.values()))
            desc = "; ".join(f"{c.name}: {c.desc}" for c in (present or cast.values()) if c.desc)
            png = painter.paint(f"{sc['illustration_prompt']}\nThe characters must look exactly like the reference images. {desc}{dress}\nNo text, no watermark, 16:9 composition.", refs)
            if png:
                bg, kind = Image.open(png), "illustration"
        elif sc.get("bg_prompt"):
            png = painter.paint(f"{sc['bg_prompt']}\n{SCENERY}")
            if png:
                bg, kind = Image.open(png), "background"
        if bg is None:
            bg = gradient(script["title"] + str(si))
            if sc.get("illustration_prompt") or sc.get("bg_prompt"):   # 要了画、没画出来（没写画面的场景本来就是渐变底，不算）
                p["warn"] = "没画出来→渐变底"
        p["kind"] = kind
        p["sprites_on"] = sc.get("sprite", kind != "illustration" and not (fmt == "story" and kind != "slide"))
        # 这个场景画上去的字（字幕、名牌、便签、幻灯片的标题 / 要点 / 角注 / 角标）里字体没有的：画出来是方框，格子框成琥珀色
        sl = sc.get("slide") if isinstance(sc.get("slide"), dict) else None
        nt = sc.get("note") if isinstance(sc.get("note"), dict) else {}
        names = [l["cast"].name for l in p["lines"] if l["cast"]] if p["sprites_on"] and len(present) >= 2 else []
        miss = missing_glyphs(*(l["text"] for l in p["lines"]), *names, nt.get("label"), nt.get("text"),
                              *((sl.get("title"), *(sl.get("bullets") or []), sl.get("note"), badge) if sl else ()))
        if miss:
            p["warn"] = _join_warn(p["warn"], f"缺字×{len(miss)}")
            missing.append({"scene": p["no"], "chars": miss})
            log(f"场景 {p['no']} 有字体里没有的字（画出来是方框）：{glyph_names(miss)}")
        big = cover_fit(bg, (round(W * PAN), round(H * PAN))) if kind != "slide" else cover_fit(bg)
        bg_path = build / f"bg{si:02d}.png"
        big.save(bg_path)
        p["bg"] = bg_path
    log(f"画面准备完成（AI 出图 {painter.used} 张）")

    # 3) 逐句切片：背景平移 + 静态层（听者立绘 + 便签 + 字幕 + 名牌）+ 说话人立绘（浮动）
    clips = []
    shots = []                              # 每个切片是哪个场景、哪句、第几页字幕，字幕 / 便签画在哪 —— 拼自查图用
    for si, p in enumerate(plan):
        present = p["present"] if p["sprites_on"] else []
        slide = p["kind"] == "slide"
        sprite_h = SLIDE_SPRITE_H if slide else (900 if len(present) <= 1 else 860)
        slots = {}
        if len(present) == 1:
            slots[present[0].id] = W - 300 if not slide else SLIDE_SPRITE_X
        elif len(present) >= 2:
            for k, c in enumerate(present[:2]):
                slots[c.id] = 380 if k == 0 else W - 380
        offset, total = 0.0, max(0.1, p["total"])
        direction = 1 if si % 2 == 0 else -1
        area = (140, W - 140) if not present or slide else ((140, W - 520) if len(present) == 1 else (300, W - 300))   # 单角色站右边：字幕条让开她
        if slide:
            area = (140, W - 560)
        # 便签：场景开头收着；每句开头按这句的动作变（show / strike / hide）。静止的样子画进听者那层（fg），
        # 出现 / 划的那一页（这句的第一页）另给一串逐帧图（note_frames），叠在听者上面、说话的人下面
        nt = p["scene"].get("note")
        note_L = note_layout(nt) if nt else None
        note_static, note_pos = {}, None                  # 划没划 → 静止的那张；位置整个场景不变
        shown = struck = False
        for li, l in enumerate(p["lines"]):
            act = l["note"] if nt else None
            was_shown, was_struck = shown, struck
            if act == "show":
                shown = True
            elif act == "strike":
                shown = struck = True
            elif act == "hide":
                shown = False
            appear = shown and not was_shown                  # 从收着变成出现：淡入
            animate = appear or act == "strike"
            fg_saved = set()
            cues = l["cues"]
            spans = []
            for k, (a, b, txt) in enumerate(cues):
                start = 0.0 if k == 0 else a
                end = cues[k + 1][0] if k + 1 < len(cues) else l["dur"] + l["pause"]
                if end - start <= 0.05:
                    continue
                # 一句太长（> 2 行）→ 切成几页字幕，按字数分这句的时间（以前是超过 3 行直接截掉）
                pages = caption_pages(txt, area[1] - area[0] - 100)
                weight = [max(1, len(pg)) for pg in pages]
                t = start
                for pg, wgt in zip(pages, weight):
                    seg = (end - start) * wgt / sum(weight)
                    spans.append((t, t + seg, pg))
                    t += seg
            speaker = l["cast"]
            for ci, (start, end, txt) in enumerate(spans):
                from PIL import Image as _I
                layer = _I.new("RGBA", (W, H), (0, 0, 0, 0))
                for c in present[:2]:
                    if speaker and c.id == speaker.id:
                        continue
                    img = c.sprite("neutral")
                    if img is None:
                        continue
                    s = dim(scale_h(img, sprite_h - 40), 0.5)
                    layer.alpha_composite(s, (int(slots[c.id] - s.width / 2), sprite_y(H, s, c.is_whole("neutral"))))
                note_seq = None
                if nt and shown:
                    if struck not in note_static:
                        note_static[struck] = note_card(nt, 1.0 if struck else 0.0, 1.0, note_L)
                    if note_pos is None:
                        note_pos = note_xy(note_static[struck], note_L, len(present))
                    if animate and ci == 0:                   # 这一页动：听者层里不画它，换成逐帧图
                        note_seq = note_png_frames(nt, note_L, note_frames(end - start, appear, act == "strike"),
                                                   1.0 if was_struck else 0.0, act == "strike", build / f"nt{si:02d}{li:02d}")
                    else:
                        layer.alpha_composite(note_static[struck], note_pos)
                cap = caption_layer(txt, speaker.name if speaker and len(present) >= 2 else None,
                                    speaker.color if speaker else (255, 140, 90), area)
                fg = build / f"fg{si:02d}{li:02d}{'a' if note_seq else ''}.png"   # 听者立绘层（+ 静止的便签；一句话内不变）
                if fg not in fg_saved:
                    layer.save(fg)
                    fg_saved.add(fg)
                capf = build / f"cap{si:02d}{li:02d}{ci:02d}.png"  # 字幕层：永远在最上面，不被立绘挡住
                cap.save(capf)
                spk = talk = None
                if speaker and speaker.id in slots:
                    img = speaker.sprite(l["expr"])
                    if img is not None:
                        s = scale_h(img, sprite_h)
                        spk = build / f"sp{si:02d}{li:02d}.png"
                        if not spk.is_file() or ci == 0:
                            s.save(spk)
                        spk_x = int(slots[speaker.id] - s.width / 2)
                        spk_y = sprite_y(H, s, speaker.is_whole(l["expr"]))
                        # 嘴型：这个表情有同名的说话版才做（听的人一直是闭嘴的 neutral）；一句的张嘴段只算一次
                        opened = speaker.talk_sprite(l["expr"])
                        if opened is not None:
                            if "mouth" not in l:
                                l["mouth"] = mouth_spans(l["mp3"])
                            mouth = mouth_enable(clip_mouth(l["mouth"], start, end))
                            if len(mouth) > MOUTH_EXPR_MAX:
                                log(f"嘴型：场景 {si + 1} 第 {li + 1} 句这一段太长，不做嘴型")
                            elif mouth:
                                talk = build / f"sp{si:02d}{li:02d}-open.png"
                                if not l.get("open_saved"):
                                    scale_h(opened, sprite_h).save(talk)
                                    l["open_saved"] = True
                dur = end - start
                out = build / f"c{len(clips):04d}.mp4"
                t0 = offset + start
                if slide:
                    bgf = "[0:v]scale=1920:1080,setsar=1[bg]"
                else:
                    prog = f"(({t0:.3f}+t)/{total:.3f})"
                    span_x = f"(iw-1920)*{prog}" if direction > 0 else f"(iw-1920)*(1-{prog})"
                    bgf = f"[0:v]crop=1920:1080:x='{span_x}':y='(ih-1080)*0.5+(ih-1080)*0.35*sin(({t0:.3f}+t)/{total:.3f}*3.14159)',setsar=1[bg]"
                loop = lambda f: ["-loop", "1", "-framerate", str(FPS), "-t", f"{dur:.3f}", "-i", str(f)]
                inputs = [*loop(p["bg"]), *loop(fg), *loop(capf)]
                chain = [bgf, "[bg][1:v]overlay=0:0[v1]"]
                last = "v1"
                nidx = 3 + (1 if spk else 0) + (1 if talk else 0)   # 便签逐帧图排在立绘后面、配音前面
                if note_seq:       # 听者上面、说话的人下面；逐帧图放完就一直停在最后一帧（最终的样子）
                    chain.append(f"[v1][{nidx}:v]overlay=x={note_pos[0]}:y={note_pos[1]}:eof_action=repeat[vn]")
                    last = "vn"
                if spk:
                    inputs += loop(spk)
                    float_y = f"y='{spk_y}+9*sin(2*3.14159*({t0:.3f}+t)/1.7)'"
                    if talk:       # 闭嘴版和张嘴版同一个位置、同一条浮动轨迹，按张嘴段只放其中一张
                        inputs += loop(talk)
                        chain.append(f"[{last}][3:v]overlay=x={spk_x}:{float_y}:enable='not({mouth})'[v2c]")
                        chain.append(f"[v2c][4:v]overlay=x={spk_x}:{float_y}:enable='{mouth}'[v2]")
                    else:
                        chain.append(f"[{last}][3:v]overlay=x={spk_x}:{float_y}[v2]")
                    last = "v2"
                if note_seq:
                    inputs += ["-framerate", str(FPS), "-start_number", "0", "-i", note_seq]
                chain.append(f"[{last}][2:v]overlay=0:0,fps={FPS},format=yuv420p[vout]")
                aidx = nidx + (1 if note_seq else 0)
                run_ffmpeg([*inputs, "-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", str(l["mp3"]),
                            "-filter_complex", ";".join(chain) + f";[{aidx}:a]aresample=48000,aformat=channel_layouts=stereo,apad[aout]",
                            "-map", "[vout]", "-map", "[aout]", "-t", f"{dur:.3f}",
                            "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-c:a", "aac", "-b:a", "160k", str(out)])
                clips.append(out)
                note_box = None
                if nt and shown:                      # 便签在画面上的框（不含透明的边）：这一页最后一帧就是它最终的样子
                    card = note_static[struck]
                    bx = card.getbbox() or (0, 0, card.width, card.height)
                    note_box = (note_pos[0] + bx[0], note_pos[1] + bx[1], note_pos[0] + bx[2], note_pos[1] + bx[3])
                shots.append({"clip": len(clips) - 1, "si": si, "scene": p["no"], "line": l["k"] + 1, "page": ci + 1,
                              "dur": round(dur, 3), "chars": len(txt), "names": bool(speaker and len(present) >= 2),
                              "cap_box": cap.getbbox(), "note": ("struck" if struck else "shown") if nt and shown else None,
                              "note_box": note_box})
            offset += l["dur"] + l["pause"]
        log(f"场景 {si + 1}/{len(plan)} 完成")

    # 4) 封面（AI 插画 > 第一个插画场景 > 第一个场景背景）+ 2 秒片头
    cover_cfg = script.get("cover") or {}
    cover_base = cover_warn = None
    if cover_cfg.get("prompt"):
        who = [cast[c] for c in (cover_cfg.get("cast") or list(cast)) if c in cast]
        refs, dress = paint_refs(who)
        png = painter.paint(f"{cover_cfg['prompt']}\nEye-catching video thumbnail illustration. The characters must look exactly like the reference images.{dress} Leave the bottom third and top-left corner calm for title text. No text.",
                            refs)
        if png:
            cover_base = Image.open(png)
        else:                               # 要了封面画、没画出来：以前悄悄换成场景的画（没开出图时连一行日志都没有），自查图上也看不出来
            cover_warn = "封面画没画出来"                  # 格子里写短一点：别挡住封面左上角的栏目角标
            log(f"封面画没画出来（{'没开 AI 出图' if not painter.enabled else '见上一行'}）→ 用第一个场景的画面")
    cover_words = cover_cfg["text"] if str(cover_cfg.get("text") or "").strip() else script["title"]
    miss = missing_glyphs(cover_words, badge)
    if miss:
        cover_warn = _join_warn(cover_warn, f"缺字×{len(miss)}")
        missing.insert(0, {"scene": 0, "chars": miss})
        log(f"封面字有字体里没有的字（画出来是方框）：{glyph_names(miss)}")
    if cover_base is None:
        first = next((p for p in plan if p["kind"] == "illustration"), None) or plan[0]
        cover_base = Image.open(first["bg"])
        if first["kind"] != "illustration" and host and cast[host].sprite("happy") is not None:
            cb = cover_fit(cover_base).convert("RGBA")
            s = scale_h(cast[host].sprite("happy"), 820)
            cb.alpha_composite(s, (W - s.width - 80, sprite_y(H, s, cast[host].is_whole("happy"), bleed=40)))
            cover_base = cb
    cover = proj / "cover.jpg"
    if str(cover_cfg.get("text") or "").strip():          # 只有空白的封面字当没写：用标题
        make_cover(cover_base, cover_cfg["text"], badge, cover)
    else:                                   # 没写封面字就用标题：标题最长 70 字，放宽到 4 行
        make_cover(cover_base, script["title"], badge, cover, max_lines=4)
    intro = build / "intro.mp4"
    run_ffmpeg(["-loop", "1", "-framerate", str(FPS), "-t", "2.2", "-i", str(cover), "-f", "lavfi", "-t", "2.2",
                "-i", "anullsrc=r=48000:cl=stereo", "-vf", f"scale=1920:1080,fade=t=out:st=1.8:d=0.4,fps={FPS},format=yuv420p",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-c:a", "aac", "-b:a", "160k", "-shortest", str(intro)])

    # 5) 拼接 + 背景音乐
    joined = build / "clips.txt"
    joined.write_text("".join(f"file '{c.as_posix()}'\n" for c in [intro, *clips]), encoding="utf-8")
    voice_only = build / "voice.mp4"
    run_ffmpeg(["-f", "concat", "-safe", "0", "-i", str(joined), "-c", "copy", str(voice_only)])
    final = proj / "final.mp4"
    bgm, bgm_label = pick_bgm(script, cfg, fmt, media_seconds(voice_only))
    # 人声统一到正常响度（以前不管：第一条成片只有 -32.5 LUFS，比一般视频小一大截）；
    # 背景音乐也先统一到同一个响度，再按 bgmVolume 压低 —— 不管主人放进来的音乐原本多响，听起来都一样靠后
    norm = f"loudnorm=I={VOICE_LUFS}:TP=-1.5:LRA=11"
    vol = bgm_volume(cfg)
    if bgm and vol > 0:
        # 合成的和成片一样长（淡出正好在结尾收完），不用循环；主人放的音乐可能比视频短，循环接上
        loop = [] if str(bgm_label).startswith(SYNTH_LABEL) else ["-stream_loop", "-1"]
        run_ffmpeg(["-i", str(voice_only), *loop, "-i", str(bgm), "-filter_complex",
                    f"[0:a]{norm},aresample=48000,aformat=channel_layouts=stereo[v];"
                    f"[1:a]{norm},volume={vol},aresample=48000,aformat=channel_layouts=stereo[b];"
                    "[v][b]amix=inputs=2:duration=first:dropout_transition=3:normalize=0,alimiter=limit=0.95[a]",
                    "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(final)])
    else:
        if vol <= 0:
            bgm_label = None                                  # studio.bgmVolume 0 = 不要背景音乐
        run_ffmpeg(["-i", str(voice_only), "-af", f"{norm},aresample=48000", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                    "-movflags", "+faststart", str(final)])
    seconds = round(media_seconds(final), 1)
    final_sha = _sha256_file(final)
    # 6) 自查图（见 make_check_sheet）：做不成不拦渲染 —— check_pages = 0，check_error 说原因，node 那边让她退回老办法
    check_pages, check_error = 0, None
    t_sheet = time.monotonic()
    try:
        check_pages = make_check_sheet(build, cover, plan, shots, seconds, title, final_sha, cover_warn)
        log(f"自查图：{check_pages} 页（用了 {time.monotonic() - t_sheet:.1f} 秒）")
    except Exception as e:
        _clear_sheet(build)
        check_error = (re.sub(r"\s+", " ", str(e)).strip() or type(e).__name__)[:160]
        log(f"自查图没做成（渲染照样成功）：{check_error}")
    info = {"ok": True, "final": str(final), "cover": str(cover), "seconds": seconds, "title": title, "format": fmt,
            "scenes": len(plan), "lines": sum(len(p["lines"]) for p in plan), "ai_images": painter.used,
            "ai_images_total": painter.total(), "ai_images_limit": painter.limit,   # 这条视频所有渲染加起来出了几张 / 上限
            "cast": [c.id for c in cast.values()], "bgm": bgm_label,
            "outfits": {c.id: c.outfit for c in cast.values() if c.outfit and c.id in used},   # 这次穿的换装（主人审片时看得到）
            # 这次渲染用的剧本 + 刚写出来的成片 / 封面的指纹：node 拿它写回执，并核对作品目录里的文件就是这几份
            "hashes": {"script.json": script["_sha256"], "final.mp4": final_sha, "cover.jpg": _sha256_file(cover)},
            # 自查图有几页（build/check.jpg、check-2.jpg …；0 = 没做成，check_error 是原因）。不进 hashes：它不交审、不上传
            "check_pages": check_pages, "check_error": check_error,
            # 字体里没有的字（画面上是方框）：哪个场景（0 = 封面）、哪几个字。自查图做没做成都有 —— 格子里幻灯片的字太小，不能靠她看出来
            "missing_glyphs": missing}
    (proj / "render.json").write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(info, ensure_ascii=False))


def _load_sibling(name):
    """按文件路径加载和 studio.py 放在一起的模块（python -I 跑的时候脚本所在目录不在 sys.path 里，import 找不到）"""
    import importlib.util
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parent / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


VOICE_LUFS = -16          # 成片人声的响度（网上视频常见的 -16 ~ -14）
BGM_VOLUME = 0.16         # 背景音乐（先统一到同样响度）再压到人声的多少：0.16 ≈ 低 16 dB（主人 2026-10-25 试听过这个比例）
BGM_KEYS = {60: "C", 62: "D", 63: "降E", 65: "F", 67: "G", 69: "A"}
SYNTH_LABEL = "合成配乐"


def bgm_volume(cfg):
    """studio.bgmVolume → 0–1 的数；不是有限数 → 默认 BGM_VOLUME（以前 float("abc") 会让每次渲染都失败）。0 = 不要背景音乐"""
    try:
        v = float(cfg.get("bgmVolume"))
    except (TypeError, ValueError):
        return BGM_VOLUME
    return min(1.0, max(0.0, v)) if math.isfinite(v) else BGM_VOLUME


def pick_bgm(script, cfg, fmt, seconds=None):
    """背景音乐 → (文件, 给人看的名字)；不要音乐 → (None, None)。从不下载别人的音乐（免得版权出事）：
      · 剧本 "bgm": false / "none" → 不要
      · 主人放进 bgm/ 的音乐：剧本写了名字就用名字对得上的那首；写 true（或者 story 格式）就按标题挑一首
      · 别的情况（默认）：studio.bgmSynth 开着（默认开）就用代码现合成一段（bgm_synth.py，按标题定调、速度、和弦；
        合成的放在主人那边的缓存里，同一个标题同样长度不重算）"""
    want = script.get("bgm")
    if want is False or want == "none" or bgm_volume(cfg) <= 0:
        return None, None
    d = Path(cfg.get("bgm_dir") or "")
    files = sorted([f for f in d.glob("*") if f.suffix.lower() in (".mp3", ".m4a", ".wav", ".ogg", ".flac")]) if d.is_dir() else []
    if files and isinstance(want, str) and want:
        hit = [f for f in files if want.lower() in f.stem.lower()]
        if hit:
            return hit[0], hit[0].name
    if files and (fmt == "story" or want is True):
        pick = int(hashlib.md5(script["title"].encode("utf-8")).hexdigest()[:8], 16) % len(files)
        return files[pick], files[pick].name
    if cfg.get("bgmSynth", True) is False or not seconds or not cfg.get("cache_dir"):
        return None, None
    bgm_synth = _load_sibling("bgm_synth")
    cache = Path(cfg["cache_dir"]).parent / "bgm"
    cache.mkdir(parents=True, exist_ok=True)
    secs = round(float(seconds), 1)                       # 和成片一样长：淡出正好在结尾收完（以前多 1 秒，淡出没收完就被截断）
    key = hashlib.sha256(f"{bgm_synth.VERSION}|{script['title']}|{secs}".encode("utf-8")).hexdigest()[:24]
    out = cache / f"{key}.m4a"
    meta = cache / f"{key}.json"
    info = None
    if out.is_file() and meta.is_file():
        try:
            info = json.loads(meta.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            info = None                                   # 说明文件坏了：重新合成一次
    if not isinstance(info, dict):
        log(f"合成背景音乐（{secs:.0f} 秒）")
        tag = f"{os.getpid()}.{uuid.uuid4().hex[:8]}"     # 每次合成用自己的临时文件：两个渲染同时要同一首也不会撞
        part, mpart = cache / f"{key}.{tag}.part.m4a", cache / f"{key}.{tag}.part.json"
        try:
            info = bgm_synth.synth_bgm(secs, script["title"], part, ffmpeg_exe())
            mpart.write_text(json.dumps(info, ensure_ascii=False), encoding="utf-8")
            for src, dst in ((part, out), (mpart, meta)):
                try:
                    src.replace(dst)
                except OSError:
                    if not dst.is_file():                 # 别的渲染刚放好同一首、正被读着：用它那份
                        raise
        finally:
            part.unlink(missing_ok=True)
            mpart.unlink(missing_ok=True)
    return out, f"{SYNTH_LABEL}（{BGM_KEYS.get(info.get('key'), '?')} 调 · {info.get('bpm')} 拍/分）"


# ─────────────── 表情立绘 ───────────────

def sprites(cast_dir: Path, cfg: dict, exprs, outfit: str = "", force: bool = False):
    """用 AI 画表情立绘。outfit：画进 sprites/<换装>/，并且拿这套已有的一张立绘当第一张参考图（衣服才是这一套的）；
    不给就用 profile.json 的默认换装；一套换装都没有才是老的平铺 sprites/<表情>.png。已经有的表情不重画（--force 才覆盖）"""
    from PIL import Image
    c = Cast(cast_dir.parent, cast_dir.name, cfg)
    if not c.refs:
        die(f"{cast_dir} 里没有参考图（ref*.png / ref*.jpg）")
    bad = [e for e in exprs if not EXPR_RE.fullmatch(e)]
    if bad:
        die(f"表情名不合法：{'、'.join(x[:30] for x in bad)}（字母或汉字开头，只能有字母、汉字、数字、- 和 _）")
    have = c.outfits()
    outfit = outfit or c.outfit_default or ""
    if outfit and not outfit_name_ok(outfit):
        die(f"换装名「{outfit[:30]}」不合法（字母或汉字开头，只能有字母、汉字、数字、- 和 _，不能叫「{TALK_DIR}」）")
    if not outfit and have:
        die(f"这个角色有几套换装（{'、'.join(have)}）：用 --outfit 指定画进哪一套")
    if outfit and outfit not in have:
        die(f"「{outfit}」这套还没有任何立绘 —— 先放一张这套衣服的立绘（比如 neutral.png）进 sprites/{outfit}/，再用它生成别的表情"
            f"（AI 只会照参考图画衣服，凭空画不出一套新衣服）")
    if outfit:
        c.outfit = outfit
    dress = c.paint_ref()
    refs = ([dress] if dress else []) + c.refs
    painter = Painter({**cfg, "image": {**(cfg.get("image") or {}), "maxPerVideo": len(exprs)}})
    if not painter.enabled:
        die("没配 AI 画图（studio.image.provider + image-key），生成不了表情立绘")
    out_dir = c.dir / "sprites" / outfit if outfit else c.dir / "sprites"
    out_dir.mkdir(parents=True, exist_ok=True)
    made, kept = [], []
    for e in exprs:
        if (out_dir / f"{e}.png").exists() and not force:
            kept.append(e)   # 主人手放的 / 以前画好的不覆盖
            continue
        words = EXPR_WORDS.get(e, e)
        outfit_words = ("Same outfit as the FIRST reference image (the full-body one); hairstyle, colors and art style as the references."
                        if dress else "Same outfit, hairstyle, colors and art style as the reference.")
        png = painter.paint(
            f"The exact same character as in the reference images ({c.desc}). Half-body to knee-length standing pose, facing the viewer slightly, "
            f"expression: {words}. {outfit_words} Transparent background, no text, no frame, character only.",
            refs, size="1024x1536", background="transparent")
        if png:
            trim_alpha(Image.open(png).convert("RGBA")).save(out_dir / f"{e}.png")
            made.append(e)
    print(json.dumps({"ok": bool(made) or bool(kept), "cast": c.id, "outfit": outfit or None, "made": made, "kept": kept,
                      "missing": [e for e in exprs if e not in made and e not in kept]}, ensure_ascii=False))


# ─────────────── 原创查重（交审前必跑；命中就拦）───────────────
#  ① 文案 vs 她看过的每一条视频的字幕（shots/subs/*.txt）：有一整句（≥ 20 字）原样出现，或 8 字片段重合 ≥ 15% → 拦
#  ② 标题 vs B站 搜索结果：字面太像（字二元组 Jaccard ≥ 0.55）→ 拦
#  ③ 标题 vs 主人列的「别碰」UP 主（studio.avoidCreators）最近的视频：≥ 0.45 → 拦
#  联网那两项查不了不拦，但报告里写明「没查成」，主人审片时看得到

PUNCT = re.compile(r"[\s\W_]+", re.UNICODE)
SAME8_MAX, SAME5_MAX = 30, 80   # 和别人字幕共有的 8 字片段 ≥ 30 个就拦（不管她自己写了多长来稀释）；5 字片段见 originality.mjs


def norm(t: str) -> str:
    import unicodedata
    t = re.sub(r"^\s*【[^】]{0,16}】", "", unicodedata.normalize("NFKC", str(t or "")))
    t = "".join(ch for ch in t if unicodedata.category(ch)[0] not in "CM")   # 零宽字符、变体选择符之类（和 JS 那边一致）
    return PUNCT.sub("", t).lower()


def shingles(t: str, n: int):
    return {t[i:i + n] for i in range(max(0, len(t) - n + 1))}


def jaccard(a: str, b: str) -> float:
    A, B = shingles(norm(a), 2), shingles(norm(b), 2)
    return len(A & B) / len(A | B) if A and B else 0.0


def script_text(script, scenes):
    """和 tools/lib/originality.mjs 的 scriptText 读一样的字段、一样的顺序（含幻灯片 note、便签的字和小字）"""
    parts = [script.get("desc", ""), (script.get("cover") or {}).get("text", "")]
    for sc in scenes:
        sl = sc.get("slide") or {}
        nt = sc.get("note") if isinstance(sc.get("note"), dict) else {}
        parts += [sl.get("title", ""), *(sl.get("bullets") or []), sl.get("note", "")]
        parts += [nt.get("text", ""), nt.get("label", "")]      # 便签上的字也是画面上她的字
        parts += [l.get("text", "") for l in sc.get("lines") or []]
    return norm("".join(str(p or "") for p in parts))


def local_overlap(text: str, subs_dir: Path):
    hits = []
    if not subs_dir.is_dir() or len(text) < 20:
        return hits
    mine5, mine8, mine20 = shingles(text, 5), shingles(text, 8), shingles(text, 20)
    for f in sorted(subs_dir.glob("*.txt")):
        try:
            other = norm(re.sub(r"\[\d+:\d+(?::\d+)?(?:\.\d+)?\]", "", f.read_text(encoding="utf-8", errors="ignore")))
        except Exception:
            continue
        if len(other) < 20:
            continue
        common20 = mine20 & shingles(other, 20)
        same8 = len(mine8 & shingles(other, 8))
        same5 = len(mine5 & shingles(other, 5))
        ratio = same8 / max(1, len(mine8))
        # 规则和 tools/lib/originality.mjs 的 copiedTooMuch 一致
        if common20 or ratio >= 0.15 or same8 >= SAME8_MAX or same5 >= SAME5_MAX or (same5 >= SAME5_MAX / 2 and same5 / max(1, len(mine5)) >= 0.05):
            bv = re.search(r"BV[0-9A-Za-z]{10}", f.name)
            sample = ""
            if common20:   # 找出最长的那段原样重合，给她 / 主人看
                s0 = next(iter(common20))
                i = text.find(s0)
                j = i + 20
                while j < len(text) and text[i:j + 1] in other:
                    j += 1
                sample = text[i:j]
            hits.append({"kind": "copied-text", "source": bv.group(0) if bv else f.name, "overlap": round(ratio, 3),
                         "sample": sample[:60]})
    return hits


async def online_titles(title: str, cred_path: str, avoid):
    from bilibili_api import search, user
    cred = credential(cred_path) if cred_path and Path(cred_path).is_file() else None
    hits, errors = [], []
    q = norm(title)[:30] or title
    try:
        r = await search.search_by_type(q, search_type=search.SearchObjectType.VIDEO, page=1)
        for v in (r.get("result") or [])[:20]:
            t = re.sub(r"<[^>]+>", "", str(v.get("title") or ""))
            sim = jaccard(title, t)
            if sim >= 0.55:
                hits.append({"kind": "similar-title", "source": v.get("bvid"), "by": v.get("author"), "title": t, "similarity": round(sim, 2)})
    except Exception as e:
        errors.append(f"B站搜索没查成：{str(e)[:80]}")
    for mid in avoid:
        try:
            vids = await user.User(uid=int(mid), credential=cred).get_videos(ps=30)
            for v in ((vids.get("list") or {}).get("vlist") or []):
                sim = jaccard(title, v.get("title"))
                if sim >= 0.45:
                    hits.append({"kind": "avoid-creator", "source": v.get("bvid"), "by": v.get("author") or str(mid),
                                 "title": v.get("title"), "similarity": round(sim, 2)})
            await asyncio.sleep(0.6)
        except Exception as e:
            errors.append(f"查 UP 主 {mid} 没查成：{str(e)[:80]}")
    return hits, errors


def originality(proj: Path, cfg: dict, cred_path: str, offline: bool, online_only: bool = False):
    script, scenes = load_script(proj)
    title = str(script["title"])
    hits = [] if online_only else local_overlap(script_text(script, scenes), Path(cfg.get("subs_dir") or ""))
    errors = []
    if not offline:
        more, errors = asyncio.run(online_titles(title, cred_path, [m for m in (cfg.get("avoidCreators") or []) if str(m).strip()]))
        hits += more
    report = {"ok": True, "blocked": bool(hits), "hits": hits, "errors": errors, "offline": offline,
              "checked": {"title": title, "chars": len(script_text(script, scenes))}}
    if not online_only:
        (proj / "originality.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


# ─────────────── upload / stats ───────────────

def credential(path: str):
    from bilibili_api import Credential
    d = json.loads(Path(path).read_text(encoding="utf-8"))
    return Credential(sessdata=d.get("sessdata", ""), bili_jct=d.get("bili_jct", ""),
                      buvid3=d.get("buvid3", ""), dedeuserid=d.get("dedeuserid", ""))


TAG_MAX, TAG_LEN, DESC_MAX, TITLE_MAX = 10, 20, 2000, 80
AI_TAG = "AI生成"
AI_NOTE = "本视频由 AI 自主创作：选题、文案、配音（语音合成）与画面均由 AI 生成，人类审核后发布。"


def upload_meta(script):
    """投稿元数据。AI 标签和简介末尾的 AI 声明先占位，再裁用户内容 —— 怎么裁都不会把声明挤掉"""
    title = full_title(script)
    if len(title) > TITLE_MAX:
        raise RuntimeError(f"标题超过 {TITLE_MAX} 字：{title}")
    raw = script.get("tags") or []
    if isinstance(raw, str):                 # "日记,AI" 这种写成一个字符串的：按逗号拆（以前会被拆成一个字一个标签）
        raw = re.split(r"[,，、\s]+", raw)
    elif not isinstance(raw, list):
        raw = []
    seen, tags = set(), []
    for t in raw:
        t = re.sub(r"[,，]", "", str(t)).strip().lstrip("#")   # 标签里的逗号会被 B站 拆成好几个标签
        if not t or t == AI_TAG or t in seen or len(t) > TAG_LEN:
            continue
        seen.add(t)
        tags.append(t)
    tags = tags[:TAG_MAX - 1] + [AI_TAG]
    body = str(script.get("desc") or "").strip()
    room = DESC_MAX - len(AI_NOTE) - 2
    desc = ((body[:room].rstrip() + "\n\n") if body else "") + AI_NOTE
    return title, tags, desc


def _archive_items(raw):
    """创作中心一页稿件 → [(bvid, title, state, 投稿时间秒)]。
    每一条都必须看得懂（有 Archive、BV 号、标题）：看不懂的一条可能就是要找的那一条，跳过它 = 当成「没投出去」"""
    out = []
    for it in raw:
        a = (it.get("Archive") or it.get("archive")) if isinstance(it, dict) else None
        if not isinstance(a, dict) or not isinstance(a.get("bvid"), str) or not a.get("bvid") or not isinstance(a.get("title"), str):
            raise RuntimeError("稿件列表里有一条看不懂（缺 Archive / BV 号 / 标题），没法核对")
        when = a.get("ctime") or a.get("ptime") or a.get("pubtime") or None
        try:
            when = int(when) if when is not None else None
        except (TypeError, ValueError):
            when = None
        out.append((a["bvid"], a["title"], a.get("state"), when))
    return out


def _page_info(data, pn):
    """分页信息必须在、而且自洽 —— 不然没法确认「翻完了」"""
    page = data.get("page")
    if not isinstance(page, dict):
        raise RuntimeError("稿件列表没有分页信息，没法确认查完了")
    count, ps, got_pn = page.get("count"), page.get("ps"), page.get("pn")
    is_int = lambda v: isinstance(v, int) and not isinstance(v, bool)
    if not (is_int(count) and count >= 0 and is_int(ps) and ps > 0):
        raise RuntimeError(f"稿件列表的分页信息不对（count={count!r} ps={ps!r}），没法核对")
    if got_pn is not None and got_pn != pn:
        raise RuntimeError(f"要的是第 {pn} 页，B站 回的是第 {got_pn!r} 页，没法核对")
    return count, ps


EXISTING_SLACK = 10 * 60   # 投稿时间允许比「这次交审」早 10 分钟（两边时钟不一定对得上）


async def list_existing(titles, cred, since: float = None, max_pages: int = 20):
    """她自己的稿件里（含审核中、被退回的），标题在 titles 里、而且是 since 之后投的（看不出时间的也列上）。
    只列不判断：哪一条算哪一次投稿、能不能记账、能不能再投，由主人那边（host/core.mjs）根据投稿尝试的记录决定。
    一页一页往回翻，**确认翻到了 since 之前**（或者翻到底）才算查完；翻不完就报错 —— 主人那边据此不投
    （以前只看第一页：那次投稿被后来的稿件挤到第二页，就会被当成「没投出去」再投一遍）。
    返回 [{bvid, title, state, ctime}]（ctime 是秒；看不出时间 = None）。
    回包缺字段、类型不对、和分页信息对不上（比如 B站 说有 1 条、列表却是空的 / null / 没有）→ 报错，不当成「没有稿件」"""
    from bilibili_api import creative_center as cc
    want = {str(t).strip() for t in titles if str(t or "").strip()}
    floor = None if since is None else since - EXISTING_SLACK
    out = []
    seen = 0                                               # 已经看过的稿件条数（和 B站 说的总数对照）
    newest_first, prev = True, None                        # 到目前为止是不是一直按投稿时间从新到旧（提前停的前提）
    for pn in range(1, max_pages + 1):
        data = await cc.get_video_upload_manager_info(cred, pn=pn, ps=30, order=cc.UploadManagerOrder.SENDDATE,
                                                      status=cc.UploadManagerStatus.ALL)
        if not isinstance(data, dict):
            raise RuntimeError("稿件列表格式不对（不是对象），没法核对")
        count, got_ps = _page_info(data, pn)
        raw = data.get("arc_audits")
        if raw is None:                                    # 缺字段 / null：只有 B站 也说「后面没有了」才算翻完
            if count > seen:
                raise RuntimeError(f"B站 说一共 {count} 条，第 {pn} 页却没有稿件列表（{'缺字段' if 'arc_audits' not in data else 'null'}），没法核对")
            return out
        if not isinstance(raw, list):
            raise RuntimeError("稿件列表格式不对，没法核对")
        if not raw:
            if count > seen:
                raise RuntimeError(f"B站 说一共 {count} 条，看了 {seen} 条，第 {pn} 页却是空的 —— 没法确认查完了")
            return out                                     # 翻到底了（和总数对得上）
        if count <= seen or len(raw) > got_ps:
            raise RuntimeError(f"稿件列表前后对不上（一共 {count} 条、每页 {got_ps} 条，第 {pn} 页却有 {len(raw)} 条），没法核对")
        items = _archive_items(raw)
        for bvid, t, state, when in items:
            if t.strip() in want and not (floor is not None and when is not None and when < floor):
                out.append({"bvid": bvid, "title": t, "state": state, "ctime": when})
        seen += len(raw)
        if seen >= count:
            return out                                     # 和 B站 说的总数对上了：这就是最后一页
        if len(raw) < got_ps:
            raise RuntimeError(f"第 {pn} 页不满（{len(raw)}/{got_ps}），B站 却说后面还有 —— 前后对不上，没法核对")
        times = [w for *_, w in items]
        known = ([prev] if prev is not None else []) + [w for w in times if w is not None]
        if any(a < b for a, b in zip(known, known[1:])):
            newest_first = False                           # 顺序对不上（排序字段和我们读的时间不一样？）：不再提前停，翻到底
        if known:
            prev = known[-1]
        if newest_first and floor is not None and times and all(w is not None for w in times) and min(times) < floor:
            return out                                     # 已经翻到这次投稿尝试之前了（前面一直是从新到旧，后面不会再有更新的）
        await asyncio.sleep(0.5)
    raise RuntimeError("稿件太多，翻了很多页还没翻到那次投稿之前，核对不完整 —— 请主人去创作中心确认后用 videos resolve")


def upload_presets():
    """B站 投稿页的分区表和创作声明预设（bilibili_api 自带的 video_uploader_meta_pre.json）→ ({子分区 id: "大区·子分区"}, [声明原文])。
    读不了 → (None, None)：不拿它挡上传"""
    try:
        import bilibili_api
        with open(Path(bilibili_api.__file__).parent / "data" / "video_uploader_meta_pre.json", encoding="utf8") as f:
            pre = json.load(f)
        tids = {int(c["id"]): f'{p.get("name", "")}·{c.get("name", "")}' for p in pre.get("tid_list") or [] for c in p.get("children") or []}
        marks = [m for m in (pre.get("neutral_mark") or {}).get("marks") or [] if isinstance(m, str)]
        return tids or None, marks or None
    except Exception:
        return None, None


async def do_upload(proj: Path, cred_path: str, ai_statement: str):
    from bilibili_api.utils.picture import Picture
    from bilibili_api.video_uploader import VideoMeta, VideoUploader, VideoUploaderPage
    # 读剧本 / 按现在的规矩查剧本时挡下的（比如交审时还允许、升级后不允许的写法）：还没联网 → notStarted，主人那边不记成「结果不确定」
    _DIE_EXTRA["notStarted"] = True
    try:
        script, _ = load_script(proj)
    finally:
        _DIE_EXTRA.clear()
    final, cover = proj / "final.mp4", proj / "cover.jpg"
    if not final.is_file():
        die("还没渲染：final.mp4 不存在 —— 没有上传", notStarted=True)
    title, tags, desc = upload_meta(script)
    # 传之前先在本地对一遍（一个字节都还没传）：分区号要是投稿页上的子分区（填大区号 / 编的号，要传完整条视频才在最后一步被拒，
    # 或者进错区）；创作声明要是 B站 预设的原文之一
    tids, marks = upload_presets()
    tid = parse_tid(script.get("tid"))
    if tids is not None and tid not in tids:
        die(f"分区号 {script.get('tid')!r} 不是 B站 投稿页上的子分区（大区号不行）—— 没有上传。退回让她改 script.json 的 tid 重交", notStarted=True)
    if ai_statement and marks is not None and ai_statement not in marks:
        die(f"创作声明「{ai_statement}」不是 B站 预设的那几句之一 —— 没有上传。改 studio.aiStatement（用预设原文）再批准", notStarted=True)

    async def go(mark):
        meta = VideoMeta(tid=tid, title=title, desc=desc,
                         cover=Picture.from_file(str(cover)) if cover.is_file() else "", tags=tags,
                         original=True, no_reprint=True, neutral_mark=mark)
        up = VideoUploader(pages=[VideoUploaderPage(path=str(final), title=title, description="")],
                           meta=meta, credential=credential(cred_path))
        return await up.start()

    # B站 不收这条 AI 创作声明时，不再悄悄去掉声明重投（以前会，结果里也不说）：报错停下，让主人决定（2026-10-25 第一条视频前）
    try:
        res = await go(ai_statement or None)
    except Exception as e:
        if ai_statement and "neutral" in str(e).lower():
            raise RuntimeError(f"B站 没收这条 AI 创作声明（{ai_statement}）：{e} —— 没有去掉声明重投。"
                               "要换一句预设声明，或者确定不带声明投，就改 studio.aiStatement 再批准") from e
        raise
    bvid = (res or {}).get("bvid") if isinstance(res, dict) else None
    print(json.dumps({"ok": True, "bvid": bvid, "aid": (res or {}).get("aid") if isinstance(res, dict) else None,
                      "raw": res if isinstance(res, dict) else str(res)}, ensure_ascii=False))


async def do_stats(cred_path: str, mid: int, n: int):
    from bilibili_api import user, video
    u = user.User(uid=mid, credential=credential(cred_path))
    rel = await u.get_relation_info()
    vids = await u.get_videos(ps=min(max(1, n), 50))
    out = []
    for v in ((vids.get("list") or {}).get("vlist") or []):
        out.append({"bvid": v.get("bvid"), "title": v.get("title"), "created": v.get("created"),
                    "play": v.get("play"), "comment": v.get("comment"), "danmaku": v.get("video_review"),
                    "length": v.get("length")})
    for item in out[:n]:
        try:
            st = (await video.Video(bvid=item["bvid"], credential=credential(cred_path)).get_info()).get("stat") or {}
            item.update({"like": st.get("like"), "coin": st.get("coin"), "favorite": st.get("favorite"), "share": st.get("share")})
        except Exception as e:
            item["stat_error"] = str(e)[:80]
        await asyncio.sleep(0.6)
    print(json.dumps({"ok": True, "followers": rel.get("follower"), "following": rel.get("following"), "videos": out},
                     ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("render"); r.add_argument("project"); r.add_argument("--config", default=""); r.add_argument("--script", default="")
    sp = sub.add_parser("sprites"); sp.add_argument("cast"); sp.add_argument("--config", default=""); sp.add_argument("--exprs", default=",".join(DEFAULT_EXPRS)); sp.add_argument("--outfit", default=""); sp.add_argument("--force", action="store_true")
    vo = sub.add_parser("voices"); vo.add_argument("--config", default=""); vo.add_argument("--provider", default="openai"); vo.add_argument("--try", dest="names", required=True); vo.add_argument("--text", required=True); vo.add_argument("--instructions", default=""); vo.add_argument("--out", required=True)
    u = sub.add_parser("upload"); u.add_argument("project"); u.add_argument("--cred", required=True); u.add_argument("--ai-statement", default="")
    ex = sub.add_parser("existing"); ex.add_argument("--cred", required=True); ex.add_argument("--titles", required=True, help="JSON 数组"); ex.add_argument("--since", type=float, default=None)
    s = sub.add_parser("stats"); s.add_argument("--cred", required=True); s.add_argument("--mid", type=int, required=True); s.add_argument("--n", type=int, default=20)
    o = sub.add_parser("originality"); o.add_argument("project"); o.add_argument("--config", default=""); o.add_argument("--cred", default=""); o.add_argument("--offline", action="store_true"); o.add_argument("--online-only", action="store_true")
    a = ap.parse_args()
    cfg = {}
    if getattr(a, "config", ""):
        cfg = json.loads(Path(a.config).read_text(encoding="utf-8"))
    try:
        if a.cmd == "render":
            render(Path(a.project), cfg, Path(a.script) if a.script else None)
        elif a.cmd == "voices":
            voices(cfg, a.provider, [v.strip() for v in a.names.split(",") if v.strip()], a.text, a.instructions, Path(a.out))
        elif a.cmd == "sprites":
            _FONT["path"] = find_font(cfg.get("font", ""))
            sprites(Path(a.cast), cfg, [e.strip() for e in a.exprs.split(",") if e.strip()], a.outfit.strip(), a.force)
        elif a.cmd == "upload":
            asyncio.run(do_upload(Path(a.project), a.cred, a.ai_statement))
        elif a.cmd == "existing":
            hits = asyncio.run(list_existing(json.loads(a.titles), credential(a.cred), a.since))
            print(json.dumps({"ok": True, "hits": hits}, ensure_ascii=False))
        elif a.cmd == "stats":
            asyncio.run(do_stats(a.cred, a.mid, a.n))
        elif a.cmd == "originality":
            originality(Path(a.project), cfg, a.cred, a.offline, a.online_only)
    except SystemExit:
        raise
    except Exception as e:
        die(f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
