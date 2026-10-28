#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
VoxCPM2 本地配音 worker —— 跑在主人自己装的 VoxCPM 虚拟环境里（torch + CUDA），不是 .studio-venv。
studio.py 每次渲染只起一个：模型只加载一次（要二十秒左右），这次要配的台词全交给它。

协议（都是一行一个 JSON）：
    stdin  第一行：{"model": 模型目录, "out_dir": 写 wav 的私有临时目录, "cfg_value": 2.0, "steps": 10,
                    "items": [{"id": "0", "ref": 参考音.wav, "ref_text": 参考音念的字, "sentences": ["…", "…"]}]}
           之后不再读 stdin（Windows 上一个线程堵在 stdin 的 ReadFile 上，另一个线程加载 numpy 的 DLL 会跟着卡死 —— 2026-10-24 真模型实测踩到）。
           studio.py 那边死了：下一次往 stdout 写协议行时管道已断，这里立刻退出（每念完一句写一次），不会长时间占着显卡
    stdout {"event": "ready"} → 每句一条 {"event": "sentence", …}、每条台词配完一条 {"event": "item", "id": "0", "pieces": ["0-0.wav", …]} → {"event": "done"}
           出错：{"event": "error", "error": "…"}，退出码非 0
别的库往 stdout 打的东西（进度条、警告）都被转到 stderr，stdout 上只有协议行。

做法（2026-10-24 主人选定）：参考音整段当开头续写（prompt_wav + prompt_text），同时当音色参考；
不加括号里的语气描述 —— 续写模式下括号会被当成正文念出来。每句的随机种子由句子本身决定，同一句每次念得一样。
torch / voxcpm 只在 load_model 里 import：协议部分不装 torch 也能测（tests/helpers/voxcpm_units.py）。
"""
import hashlib
import json
import os
import sys
from pathlib import Path


def load_model(model_dir):
    from voxcpm import VoxCPM
    # optimize=False：Windows 上没有 torch.compile / Triton
    return VoxCPM.from_pretrained(str(model_dir), load_denoiser=False, optimize=False)


def seed_of(sentence: str) -> int:
    return int(hashlib.sha1(sentence.encode("utf-8")).hexdigest()[:8], 16)


def synth(model, sentence, ref, ref_text, cfg_value, steps):
    """→ (float 采样列表或数组, 采样率)"""
    import numpy as np
    import torch
    torch.manual_seed(seed_of(sentence))
    wav = model.generate(text=sentence, prompt_wav_path=str(ref), prompt_text=ref_text, reference_wav_path=str(ref),
                         cfg_value=cfg_value, inference_timesteps=steps)
    return np.asarray(wav, dtype=np.float32), model.tts_model.sample_rate


def write_wav(path: Path, samples, sr: int):
    import soundfile as sf
    sf.write(str(path), samples, sr, subtype="PCM_16")


def run(job, model, emit, synth_fn=synth, write_fn=write_wav):
    """按顺序配每条台词；每条配完马上 emit，studio.py 那边立刻存进缓存（中途断了，配好的不白配）"""
    out = Path(job["out_dir"])
    cfg_value, steps = float(job.get("cfg_value", 2.0)), int(job.get("steps", 10))
    for item in job["items"]:
        iid = str(item["id"])
        if not iid.isdigit():
            raise ValueError(f"item id 只能是数字：{iid[:20]}")
        pieces = []
        for k, sentence in enumerate(item["sentences"]):
            samples, sr = synth_fn(model, sentence, item["ref"], item["ref_text"], cfg_value, steps)
            name = f"{iid}-{k}.wav"
            write_fn(out / name, samples, sr)
            pieces.append(name)
            emit({"event": "sentence", "id": iid, "k": k})   # 每句一报：那边按句算「多久没进展」，一条很长的台词不会被当成卡死
        emit({"event": "item", "id": iid, "pieces": pieces})


def main():
    # studio.py 用 python -I 起这里：PYTHONUTF8 / PYTHONIOENCODING 都不生效，编码自己定（不然 Windows 上按系统编码读中文 = 乱码）
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    # 协议行只走原来的 stdout；之后任何人 print / 进度条都去 stderr
    proto = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr

    def emit(o):
        try:
            proto.write(json.dumps(o, ensure_ascii=False) + "\n")
            proto.flush()
        except OSError:
            os._exit(3)     # 管道断了 = studio.py 已经不在了（被掐掉 / 超时）：别再占着显卡

    try:
        job = json.loads(sys.stdin.buffer.readline().decode("utf-8"))
        model_dir = Path(job["model"])
        if not model_dir.is_dir():
            raise FileNotFoundError(f"VoxCPM 模型目录不在：{model_dir}")
        print(f"[voxcpm] 加载模型：{model_dir}", file=sys.stderr, flush=True)
        model = load_model(model_dir)
        print("[voxcpm] 模型加载好了", file=sys.stderr, flush=True)
        emit({"event": "ready"})
        run(job, model, emit)
        emit({"event": "done"})
    except BaseException as e:  # noqa: BLE001 —— 什么错都要用协议行报回去，不然那边只看到进程没了
        emit({"event": "error", "error": f"{type(e).__name__}: {e}"[:2000]})
        proto.flush()
        os._exit(1)
    proto.flush()
    os._exit(0)


if __name__ == "__main__":
    main()
