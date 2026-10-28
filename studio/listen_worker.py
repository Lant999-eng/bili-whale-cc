#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
「听」的 worker（2026-10-26 主人要她听得见视频的声音）—— 跑在主人自己装的 .listen-venv 里（node host/cli.mjs listen-setup），
不是 .studio-venv。只用 CPU（sherpa-onnx + onnxruntime），不占显卡，不跟 VoxCPM 配音抢。

做法照 sherpa-onnx 官方示例（python-api-examples/generate-subtitles.py、offline-sense-voice-ctc-decode-files.py）：
    silero VAD 切出说话的段 → 每段交给 SenseVoiceSmall（int8）→ 文字 + 语种 + 情绪 + 声音事件（背景音乐、笑声、掌声…）

用法（tools/commands/listen.mjs 调它）：
    python listen_worker.py --pcm <16kHz 单声道 s16le 裸数据> --models <模型目录> [--threads 4] [--max-segments 400]
模型目录里要有（listen-setup 放好的固定名字）：
    sense-voice/model.int8.onnx · sense-voice/tokens.txt · silero_vad.onnx
stdout 只有一行 JSON：
    {"ok": true, "seconds": 总秒数, "speech": 说话的秒数, "segments": [{"start": 秒, "end": 秒, "text": "…", "lang": "zh", "emotion": "HAPPY", "event": "Laughter"}], "truncated": 0,
     "relabeled": 按中文重听了几句, "recheck_failed": 该重听却没重听成的几句}
    重听过的段多两个字段：first_lang（一开始听成的语种）、first_text（一开始听成的字）
    出错：{"ok": false, "error": "…"}，退出码 1
别的库往 stdout 打的东西都被转到 stderr，stdout 上只有这一行。
sherpa_onnx / numpy 只在 transcribe 里 import：参数和输出格式不装它们也能测（tests/listen.test.mjs 用 py_compile 查语法）。
"""
import argparse
import json
import os
import sys

SAMPLE_RATE = 16000
MAX_CHUNK = 15 * SAMPLE_RATE   # 一次交给模型的最长一段（样本数）
RECHECK_LANGS = ('ja', 'ko')   # 大多是中文的视频里，被认成这两种的段按中文再听一遍


def tag(s):
    """SenseVoice 的标记「<|HAPPY|>」→「HAPPY」；没有就是空串"""
    s = str(s or '').strip()
    if s.startswith('<|') and s.endswith('|>'):
        s = s[2:-2]
    return s


def model_paths(models):
    return {
        'model': os.path.join(models, 'sense-voice', 'model.int8.onnx'),
        'tokens': os.path.join(models, 'sense-voice', 'tokens.txt'),
        'vad': os.path.join(models, 'silero_vad.onnx'),
    }


def transcribe(pcm_path, models, threads, max_segments):
    import numpy as np
    import sherpa_onnx

    p = model_paths(models)
    missing = [k for k, v in p.items() if not os.path.isfile(v)]
    if missing:
        raise RuntimeError('模型文件不全：' + '、'.join(missing) + '（主人重跑 node host/cli.mjs listen-setup）')

    def make(language):
        return sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=p['model'], tokens=p['tokens'], num_threads=threads, use_itn=True, language=language, debug=False)

    recognizer = make('auto')

    def decode(rec, chunk):
        stream = rec.create_stream()
        stream.accept_waveform(SAMPLE_RATE, chunk)
        rec.decode_stream(stream)
        r = stream.result
        return (str(getattr(r, 'text', '') or '').strip(), tag(getattr(r, 'lang', '')),
                tag(getattr(r, 'emotion', '')), tag(getattr(r, 'event', '')))

    config = sherpa_onnx.VadModelConfig()
    config.silero_vad.model = p['vad']
    config.silero_vad.threshold = 0.3
    config.silero_vad.min_silence_duration = 0.25
    config.silero_vad.min_speech_duration = 0.25
    config.silero_vad.max_speech_duration = 8
    config.sample_rate = SAMPLE_RATE
    window = config.silero_vad.window_size

    raw = np.fromfile(pcm_path, dtype=np.int16)
    samples = raw.astype(np.float32) / 32768
    total = len(samples) / SAMPLE_RATE
    # max_speech_duration 只是让 VAD 在长段之后变严，不保证一定切开（Codex 复查 2026-10-26）：
    #   缓冲区开到整段那么长（她最多听 20 分钟），不会因为一直有人说话把缓冲区撑满；
    #   切出来的段再按 MAX_CHUNK 硬切一遍，模型每次最多吃 15 秒
    vad = sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=max(100, int(total) + 10))

    segments, speech, truncated = [], 0.0, 0
    # 被认成日语 / 韩语的那几段先记下位置（第几段、从第几个样本起、多长）：整条大多是中文的话，从 samples 里切出来按中文再听一遍。
    #   只记位置不留声音：VAD 给的段是 Python 的 float 列表（每个样本约 40 字节），日语视频听 20 分钟要白占几百 MB（Claude 审查员 2026-10-27）
    doubtful = []

    def drain():
        nonlocal speech, truncated
        while not vad.empty():
            front = vad.front
            seg, base = front.samples, front.start
            for off in range(0, len(seg), MAX_CHUNK):
                chunk = seg[off:off + MAX_CHUNK]
                if len(segments) >= max_segments:
                    truncated += 1
                    continue
                start = (base + off) / SAMPLE_RATE
                dur = len(chunk) / SAMPLE_RATE
                text, lang, emotion, event = decode(recognizer, chunk)
                speech += dur
                if text and text not in ('.', 'The.'):
                    if lang in RECHECK_LANGS:
                        doubtful.append((len(segments), base + off, len(chunk)))
                    segments.append({'start': round(start, 2), 'end': round(start + dur, 2), 'text': text,
                                     'lang': lang, 'emotion': emotion, 'event': event})
            vad.pop()

    i = 0
    while i + window <= len(samples):
        vad.accept_waveform(samples[i:i + window])
        i += window
        drain()
    # 最后不满一个窗口的那一截补上静音再送进去（官方示例里这一截会被丢掉：句尾那零点几秒就没了）
    if i < len(samples):
        tail = samples[i:]
        vad.accept_waveform(np.concatenate([tail, np.zeros(window - len(tail), dtype=np.float32)]))
        drain()
    vad.flush()
    drain()
    # 自动判断语言时，短句、语气词、带口音的中文偶尔会被认成日语 / 韩语，转出来就成了「は？」这种（2026-10-27 她第一次真用就碰上了）。
    #   这一条大多是中文（认成中文的段数过半）→ 那几段固定按中文再听一遍；真是日语 / 韩语的视频大多不是中文，不动。
    #   重听过的段记着一开始听成的语种和字（first_lang / first_text）：中文视频里万一真有一句日语，重听出来的中文是错的，她得看得出是哪句。
    #   固定中文的那一份模型要用到才加载，加载前先放掉自动判断的那一份（两份一起占内存）。
    #   重听这一步出了错（比如内存不够加载不了）不能把已经听好的整条丢掉：没重听的几句照原样交出去，标上几句（Codex 复查 2026-10-27）
    relabeled, recheck_failed = 0, 0
    if doubtful and sum(1 for s in segments if s['lang'] == 'zh') * 2 > len(segments):
        recognizer = None
        tried = 0
        try:
            zh = make('zh')
            for idx, s0, n in doubtful:
                text, _lang, emotion, event = decode(zh, samples[s0:s0 + n])
                tried += 1
                if text and text not in ('.', 'The.'):
                    seg = segments[idx]
                    seg.update({'first_lang': seg['lang'], 'first_text': seg['text'],
                                'text': text, 'lang': 'zh', 'emotion': emotion, 'event': event})
                    relabeled += 1
        except Exception as e:  # noqa: BLE001
            recheck_failed = len(doubtful) - tried
            print('按中文重听出错：' + repr(e)[:300], file=sys.stderr)   # stderr 平时丢掉；直接跑 worker 并设 LISTEN_DEBUG=1 时看得到（经 listen 命令跑时 stderr 不收）
    return {'ok': True, 'seconds': round(total, 2), 'speech': round(speech, 2), 'segments': segments, 'truncated': truncated,
            'relabeled': relabeled, 'recheck_failed': recheck_failed}


def main():
    ap = argparse.ArgumentParser(description='把一段 16kHz 单声道 PCM 转成带时间的文字（SenseVoice）')
    ap.add_argument('--pcm', required=True)
    ap.add_argument('--models', required=True)
    ap.add_argument('--threads', type=int, default=4)
    ap.add_argument('--max-segments', type=int, default=400)
    args = ap.parse_args()
    # Windows 上输出到文件 / 管道时默认是本机编码（cp1252 / gbk）：协议行一律 UTF-8，不然中文一写就报错
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except Exception:  # noqa: BLE001
            pass
    out = sys.stdout
    sys.stdout = sys.stderr   # 库打的东西不进协议
    # 库（含 onnxruntime 的 C++ 部分）往 stderr 打的日志全丢掉：调用方把 stderr 收进文件，不能让它无限长（LISTEN_DEBUG=1 时留着）
    if not os.environ.get('LISTEN_DEBUG'):
        try:
            os.dup2(os.open(os.devnull, os.O_WRONLY), 2)
        except Exception:  # noqa: BLE001
            pass
    try:
        res = transcribe(args.pcm, args.models, max(1, min(args.threads, 16)), max(1, min(args.max_segments, 2000)))
    except Exception as e:   # noqa: BLE001 —— 任何错都只回一行 JSON
        out.write(json.dumps({'ok': False, 'error': str(e)[:300]}, ensure_ascii=False) + '\n')
        out.flush()
        return 1
    out.write(json.dumps(res, ensure_ascii=False) + '\n')
    out.flush()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
