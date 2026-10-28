"""背景音乐：用代码自己合成一段安静的配乐（不下载、不用别人的音乐，没有版权问题）。

只用 Python 标准库 + ffmpeg（工作室环境里本来就有）：
  · 按标题定下调性、速度、和弦走向（同一个标题每次合成出来都一样，不同标题不一样）
  · 三层：柔和的长音垫底（pad）、钢琴分解和弦、稀疏的五声音阶旋律；低音每小节一个
  · 音色是几个泛音叠起来、按指数衰减（像钢琴）/ 慢起慢收（像弦乐垫底）
  · ffmpeg 再加一点回声（像混响）、高低切、淡入淡出、响度统一

命令行（试听用）：python bgm_synth.py --seconds 60 --seed "标题" --out 文件.m4a
"""
import argparse
import hashlib
import math
import random
import subprocess
import sys
import tempfile
import wave
from array import array
from operator import add
from pathlib import Path

VERSION = 1                    # 合成算法改了就加一：缓存（按 版本 + 标题 + 长度）跟着换
SR = 22050                     # 合成时的采样率（够用，省一半计算）；ffmpeg 最后转成 44100 立体声
KEYS = [60, 62, 63, 65, 67, 69]          # C D Eb F G A（MIDI 音高，作主音）
# 和弦：级数 → 相对主音的半音（都是七和弦 / 加九，听起来软一点）
CHORDS = {1: [0, 4, 7, 11], 2: [2, 5, 9, 12], 3: [4, 7, 11, 14], 4: [5, 9, 12, 16], 5: [7, 11, 14, 17], 6: [9, 12, 16, 19]}
PROGRESSIONS = [[1, 6, 4, 5], [6, 4, 1, 5], [1, 5, 6, 4], [4, 5, 3, 6], [1, 3, 6, 4], [2, 5, 1, 6], [4, 1, 5, 6]]
ARPS = [[0, 1, 2, 3, 2, 1, 0, 2], [0, 2, 1, 3, 0, 2, 1, 2], [0, 1, 2, 1, 3, 2, 1, 2], [0, 2, 3, 2, 1, 2, 3, 1]]
PENTA = [0, 2, 4, 7, 9]        # 大调五声音阶


def midi_hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


class Synth:
    def __init__(self, seconds):
        self.n = int(seconds * SR) + SR
        self.buf = array("f", bytes(4 * self.n))
        self.cache = {}

    def _piano(self, m, vel):
        key = ("p", m, round(vel, 2))
        if key not in self.cache:
            f, dur = midi_hz(m), 2.2 if m >= 60 else 3.0
            n = int(dur * SR)
            parts = [(1, 1.0, 1.0), (2, 0.42, 1.6), (3, 0.2, 2.3), (4, 0.1, 3.0), (5, 0.05, 3.8)]   # (倍频, 响度, 衰减倍数)
            base_decay = 1.9 if m >= 60 else 1.2
            w = array("f", bytes(4 * n))
            for k, amp, dk in parts:
                fk = f * k * (1 + 0.0004 * k * k)          # 一点点不和谐，像真弦
                if fk > SR / 2.2:
                    break
                step = 2 * math.pi * fk / SR
                dec = base_decay * dk / SR
                for i in range(n):
                    w[i] += amp * math.sin(step * i) * math.exp(-dec * i)
            att = int(0.006 * SR)
            for i in range(att):
                w[i] *= i / att
            for i in range(n - int(0.05 * SR), n):          # 收尾别咔哒
                w[i] *= (n - i) / (0.05 * SR)
            self.cache[key] = array("f", (x * vel * 0.22 for x in w))
        return self.cache[key]

    def _pad(self, m, dur):
        key = ("pad", m, round(dur, 2))
        if key not in self.cache:
            f = midi_hz(m)
            n = int((dur + 1.6) * SR)
            atk, rel = int(1.2 * SR), int(1.6 * SR)
            w = array("f", bytes(4 * n))
            for det, amp in ((1.0, 0.5), (1.003, 0.3), (0.997, 0.3), (2.0, 0.08)):
                step = 2 * math.pi * f * det / SR
                for i in range(n):
                    w[i] += amp * math.sin(step * i)
            trem = 2 * math.pi * 0.18 / SR
            for i in range(n):
                env = min(1.0, i / atk) * (1.0 if i < n - rel else (n - i) / rel)
                w[i] *= env * (0.85 + 0.15 * math.sin(trem * i)) * 0.06
            self.cache[key] = w
        return self.cache[key]

    def add(self, t, w):
        a = int(t * SR)
        if a >= self.n:
            return
        b = min(self.n, a + len(w))
        self.buf[a:b] = array("f", map(add, self.buf[a:b], w[: b - a]))


def compose(seconds, seed):
    rng = random.Random(int(hashlib.sha256(str(seed).encode("utf-8")).hexdigest()[:16], 16))
    root = rng.choice(KEYS)
    bpm = rng.randint(62, 76)
    beat = 60 / bpm
    bar = 4 * beat
    prog = rng.choice(PROGRESSIONS)
    arp = rng.choice(ARPS)
    s = Synth(seconds)
    bars = max(2, math.ceil(seconds / bar))
    for b in range(bars):
        t0 = b * bar
        last = b == bars - 1
        deg = 1 if last else prog[b % len(prog)]
        chord = [root + x for x in CHORDS[deg]]
        for m in chord[:3]:                                   # 垫底的长音（低一个八度）
            s.add(t0, s._pad(m - 12, bar))
        s.add(t0, s._piano(chord[0] - 24, 0.55))              # 低音
        if b == 0:
            continue                                          # 第一小节只有垫底和低音：慢慢进来
        if last:
            for i, m in enumerate(chord):                     # 最后一小节：慢慢扫一个和弦，留着余音
                s.add(t0 + i * beat * 0.5, s._piano(m, 0.4))
            continue
        for i, idx in enumerate(arp):                         # 钢琴分解和弦（八分音符）
            vel = round(rng.uniform(0.32, 0.5), 2)
            jitter = rng.uniform(-0.012, 0.012)
            s.add(t0 + i * beat / 2 + max(0.0, jitter), s._piano(chord[idx % len(chord)], vel))
        if b >= 2:                                            # 旋律：稀疏的五声音阶，高一个八度
            for half in range(2):
                if rng.random() < 0.45:
                    m = root + 12 + rng.choice(PENTA) + (12 if rng.random() < 0.25 else 0)
                    s.add(t0 + half * 2 * beat + rng.choice([0, beat]), s._piano(m, round(rng.uniform(0.35, 0.5), 2)))
    return s.buf, {"key": root, "bpm": bpm, "progression": prog}


def write_wav(buf, path):
    peak = max(1e-6, max(abs(x) for x in buf))
    g = 0.9 / peak
    pcm = array("h", (int(x * g * 32767) for x in buf))
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def synth_bgm(seconds, seed, out, ffmpeg):
    """合成一段 seconds 秒的配乐写到 out（.m4a / .wav / .mp3，按后缀）。→ 用了什么调、速度、和弦"""
    seconds = max(5.0, float(seconds))
    buf, info = compose(seconds + 2, seed)
    with tempfile.TemporaryDirectory(prefix="whale-bgm-") as td:
        raw = Path(td) / "raw.wav"
        write_wav(buf, raw)
        fade_out = max(0.0, seconds - 3.5)
        af = ("aecho=0.8:0.72:47|109|211:0.24|0.17|0.11,highpass=f=70,lowpass=f=6000,"
              f"afade=t=in:d=2.5,afade=t=out:st={fade_out:.2f}:d=3.5,loudnorm=I=-20:TP=-2:LRA=11,aresample=44100")
        r = subprocess.run([ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", str(raw), "-t", f"{seconds:.2f}",
                            "-af", af, "-ac", "2", str(out)], capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode != 0:
            raise RuntimeError("合成背景音乐时 ffmpeg 失败：" + (r.stderr or "")[-400:])
    return info


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=60)
    ap.add_argument("--seed", default="bgm")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import studio as S
    info = synth_bgm(a.seconds, a.seed, Path(a.out), S.ffmpeg_exe())
    print(info)


if __name__ == "__main__":
    main()
