"""假的 VoxCPM worker（测试用，只用标准库：.studio-venv 里没有 torch / numpy）。协议同 studio/voxcpm_worker.py：
stdin 第一行是 job，stdout 回 ready / item / done；每句写一段正弦波 wav（时长随字数：max(0.6, 字数 × 0.12) 秒）。
    FAKE_VOXCPM_LOG=<文件>        每次启动、每句都记一行 JSON（测试看起了几次、念了什么、用的哪个参考音、环境里有没有 key）
    FAKE_VOXCPM_CRASH_AFTER=n     配完 n 条台词就退出（不回 done）
    FAKE_VOXCPM_HANG=1            启动后什么都不回，一直等
    FAKE_VOXCPM_ERROR=1           回一条 error
    FAKE_VOXCPM_ESCAPE=1          回一个 out_dir 外面的文件名
    FAKE_VOXCPM_EXIT_EARLY=1      没读 job 就退出（像 venv 坏了）
故意往 stdout 打几行不是 JSON 的东西（像模型加载的日志），studio.py 要能跳过"""
import hashlib
import json
import math
import os
import struct
import sys
import time
import wave
from pathlib import Path

LOG = os.environ.get("FAKE_VOXCPM_LOG")


def log(o):
    if LOG:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(o, ensure_ascii=False) + "\n")


def sine(path, seconds, sr=24000):
    n = int(sr * seconds)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / sr))) for i in range(n)))


def say(o):
    sys.stdout.buffer.write((json.dumps(o, ensure_ascii=False) + "\n").encode("utf-8"))
    sys.stdout.flush()


if os.environ.get("FAKE_VOXCPM_EXIT_EARLY") == "1":    # 像 venv 坏了的 Python：没读 job 就退出
    sys.stderr.write("No Python at 'C:\\Python312-removed\\python.exe'\n")
    sys.exit(101)
# 被 python -I 起：PYTHONUTF8 不生效，按字节读写、自己用 UTF-8（和真 worker 一样）
job = json.loads(sys.stdin.buffer.readline().decode("utf-8"))
log({"event": "start", "argv": sys.argv, "isolated": sys.flags.isolated, "cwd": os.getcwd(), "model": job["model"],
     "has_key": "BILI_WHALE_IMAGE_KEY" in os.environ, "offline": os.environ.get("HF_HUB_OFFLINE"), "items": len(job["items"])})
print("Loading model … (noise on stdout)", flush=True)
if not Path(job["model"]).is_dir():
    say({"event": "error", "error": f"VoxCPM 模型目录不在：{job['model']}"})
    sys.exit(1)
if os.environ.get("FAKE_VOXCPM_HANG") == "1":
    time.sleep(3600)
if os.environ.get("FAKE_VOXCPM_ERROR") == "1":
    say({"event": "error", "error": "CUDA out of memory (fake)"})
    sys.exit(1)
say({"event": "ready"})
crash = int(os.environ.get("FAKE_VOXCPM_CRASH_AFTER") or -1)
out = Path(job["out_dir"])
for n, item in enumerate(job["items"]):
    if n == crash:
        sys.exit(2)
    pieces = []
    for k, s in enumerate(item["sentences"]):
        name = f"{item['id']}-{k}.wav"
        sine(out / name, max(0.6, len(s) * 0.12))
        ref_sha = hashlib.sha256(Path(item["ref"]).read_bytes()).hexdigest()
        log({"event": "say", "text": s, "ref": item["ref"], "ref_text": item["ref_text"], "ref_sha": ref_sha})
        pieces.append(name)
    if os.environ.get("FAKE_VOXCPM_ESCAPE") == "1":
        pieces[0] = "../escape.wav"
    print("progress 100% (noise)", flush=True)
    say({"event": "item", "id": item["id"], "pieces": pieces})
say({"event": "done"})
