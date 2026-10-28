"""VoxCPM 本地配音的单测（不联网、不要显卡）：参考音只认角色目录 · 缓存键 · 一次渲染一个 worker · 中途断了接着配 · 出错说清楚。
worker 用 tests/helpers/fake_voxcpm_worker.py（标准库写的假模型），真 worker 的协议部分用假的 torch / numpy 测"""
import contextlib
import json
import os
import sys
import tempfile
import time
import types
import wave
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "studio"))
import studio as S  # noqa: E402
import voxcpm_worker as W  # noqa: E402

FAKE = HERE / "fake_voxcpm_worker.py"


def raises(fn, *words):
    try:
        fn()
    except RuntimeError as e:
        assert all(w in str(e) for w in words), (str(e), words)
        return str(e)
    raise AssertionError(f"应该报错：{words}")


def wav(p: Path, seconds=0.5, level=1):
    with wave.open(str(p), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(int(level).to_bytes(2, "little", signed=True) * int(16000 * seconds))


def events(log: Path):
    return [json.loads(x) for x in log.read_text(encoding="utf-8").splitlines()] if log.is_file() else []


with tempfile.TemporaryDirectory() as td:
    T = Path(td)
    for cid, ref_text in (("x", "嗯……这个我看到了。"), ("y", "我是另一个角色。")):
        (T / "cast" / cid).mkdir(parents=True)
        wav(T / "cast" / cid / "voice.wav", level=1 if cid == "x" else 2)
        (T / "cast" / cid / "profile.json").write_text(json.dumps({"name": cid, "tts": "voxcpm", "voice": "zh-CN-XiaoyiNeural",
                                                                    "voxcpm": {"ref": "voice.wav", "ref_text": ref_text}}, ensure_ascii=False), encoding="utf-8")
    (T / "model").mkdir()
    (T / "model" / "config.json").write_text('{"v": 1}', encoding="utf-8")
    log = T / "worker.log"
    cfg = {"cast_dir": str(T / "cast"), "tts_cache_dir": str(T / "tts"), "voxcpm": {"python": sys.executable, "model": str(T / "model"),
                                                                                          "minFreeMB": 0, "maxBusyPct": 100}}   # 不看真显卡（测试机上可能正开着游戏）
    os.environ.update({"BILI_WHALE_VOXCPM_WORKER": str(FAKE), "FAKE_VOXCPM_LOG": str(log), "BILI_WHALE_IMAGE_KEY": "sk-should-not-reach-worker"})
    cast = S.load_cast(cfg)
    x, y = cast["x"], cast["y"]

    # ① 角色资料：voxcpm 字段；不是对象就当没有
    assert x.tts == "voxcpm" and x.voxcpm["ref"] == "voice.wav"
    assert S.Cast(T / "cast", "x", {}).voxcpm["ref_text"] == "嗯……这个我看到了。"

    # ② 参考音只认角色目录里的一个 .wav：路径、别的扩展名、不是字符串都不行；文件不在要说怎么补
    for bad in ("../y/voice.wav", "..\\y\\voice.wav", "C:/x.wav", "/etc/x.wav", "sub/voice.wav", "voice.mp3", ".wav", 3, None):
        c = S.Cast(T / "cast", "x", {})
        c.voxcpm = {"ref": bad, "ref_text": "a"}
        raises(c.voxcpm_ref, "参考音")
    c = S.Cast(T / "cast", "x", {})
    c.voxcpm = {"ref": "missing.wav", "ref_text": "a"}
    raises(c.voxcpm_ref, "不在角色目录里", "cast voice x --provider voxcpm --use")
    outside = T / "outside.wav"
    wav(outside)
    link = T / "cast" / "x" / "link.wav"
    try:
        link.symlink_to(outside)
    except (OSError, NotImplementedError):
        link = None   # Windows 没开发者模式建不了符号链接：跳过这一项
    if link:
        c.voxcpm = {"ref": "link.wav", "ref_text": "a"}
        raises(c.voxcpm_ref, "不在角色目录里")
    assert x.voxcpm_ref() == (T / "cast" / "x" / "voice.wav").resolve()

    # ③ 配置缺什么说什么（不悄悄换回 Edge）
    raises(lambda: S._voxcpm_setup(x, {**cfg, "voxcpm": {"python": str(T / "nope.exe"), "model": str(T / "model")}}), "VoxCPM", "Python", "config set studio.voxcpm.python")
    raises(lambda: S._voxcpm_setup(x, {**cfg, "voxcpm": {"python": sys.executable, "model": str(T / "nomodel")}}), "模型目录不在")
    raises(lambda: S._voxcpm_setup(x, {**cfg, "voxcpm": {}}), "没配")
    raises(lambda: S._voxcpm_setup(x, {k: v for k, v in cfg.items() if k != "tts_cache_dir"}), "tts_cache_dir")
    for bad_text in ("", "   ", None, 5, "字" * 501, "有\x1b[2J控制字符", "嗯\t好。"):
        c = S.Cast(T / "cast", "x", {})
        c.voxcpm = {"ref": "voice.wav", "ref_text": bad_text}
        raises(lambda c=c: S._voxcpm_setup(c, cfg), "ref_text")
    c = S.Cast(T / "cast", "x", {})
    c.voxcpm = {"ref": "voice.wav", "ref_text": "嗯\t好。"}
    raises(lambda: S._voxcpm_setup(c, cfg), "控制字符")         # 不是「缺」，说清楚是带了 Tab
    if os.name == "nt":                                          # .cmd / .bat 会被当成脚本跑：python 必须是 python.exe
        bat = T / "python.cmd"
        bat.write_text("@echo off", encoding="utf-8")
        raises(lambda: S._voxcpm_setup(S.Cast(T / "cast", "x", {}), {**cfg, "voxcpm": {**cfg["voxcpm"], "python": str(bat)}}), "python.exe")

    # ④ 缓存键：同样的输入同一个键；参考音内容 / 参考文字 / 台词 / 模型变了都换键；参考音换个文件名、内容一样 → 同一个键
    s = S._voxcpm_setup(x, cfg)
    k = S.voxcpm_key("你好。", s)
    assert k == S.voxcpm_key("你好。", S._voxcpm_setup(x, cfg))
    assert k != S.voxcpm_key("你好！", s)
    assert k != S.voxcpm_key("你好。", {**s, "ref_text": "别的"})
    assert k != S.voxcpm_key("你好。", S._voxcpm_setup(y, cfg)), "参考音内容不同，键必须不同"
    (T / "cast" / "x" / "same.wav").write_bytes((T / "cast" / "x" / "voice.wav").read_bytes())
    c = S.Cast(T / "cast", "x", {})
    c.voxcpm = {"ref": "same.wav", "ref_text": "嗯……这个我看到了。"}
    assert S.voxcpm_key("你好。", S._voxcpm_setup(c, cfg)) == k, "参考音按内容算，不按路径"
    m2 = T / "model2"
    m2.mkdir()
    (m2 / "config.json").write_text('{"v": 2}', encoding="utf-8")
    assert S.voxcpm_key("你好。", S._voxcpm_setup(x, {**cfg, "voxcpm": {"python": sys.executable, "model": str(m2)}})) != k
    assert S.voxcpm_key("你好。", s) != S.hashlib.sha1(json.dumps(["你好。", "zh-CN-XiaoyiNeural", "+0%", "+0Hz"], ensure_ascii=False).encode()).hexdigest()
    mid = S._vox_model_id(str(T / "model"))
    (T / "model" / "w.bin").write_bytes(b"a" * 10)
    mid2 = S._vox_model_id(str(T / "model"))
    (T / "model" / "w.bin").write_bytes(b"b" * 10)              # 一样大、内容不同（重新训练过的权重）
    os.utime(T / "model" / "w.bin", ns=(time.time_ns(), time.time_ns() + 10**9))
    assert len({mid, mid2, S._vox_model_id(str(T / "model"))}) == 3, "换了权重（哪怕一样大）缓存就不认"
    (T / "model" / "w.bin").unlink()
    sha = lambda p: S.hashlib.sha256(Path(p).read_bytes()).hexdigest()   # noqa: E731
    sha_x, sha_y = sha(T / "cast" / "x" / "voice.wav"), sha(T / "cast" / "y" / "voice.wav")

    # ⑤ 一次渲染一个 worker：两个角色、重复台词、只配缓存里没有的；字幕时间轴 = 每句实际时长 + 句间停顿
    line = "……嗯，我醒了。今天收件箱里有一条留言，我想了很久。也许，就先这样吧。"
    S.voxcpm_prepare([(line, x), ("第二条。", y), (line, x)], cfg)
    ev = events(log)
    starts = [e for e in ev if e["event"] == "start"]
    assert len(starts) == 1, starts
    assert starts[0]["isolated"] == 1 and starts[0]["has_key"] is False and starts[0]["offline"] == "1", starts[0]
    assert all(line not in a for a in starts[0]["argv"]), "台词不能出现在命令行参数里"
    says = [e for e in ev if e["event"] == "say"]
    assert [e["text"] for e in says] == S.split_sentences(line) + ["第二条。"], says
    assert {e["ref_sha"] for e in says[:3]} == {sha_x} and says[3]["ref_sha"] == sha_y and says[3]["ref_text"] == "我是另一个角色。"
    assert all("whale-voxcpm-" in e["ref"] for e in says), "worker 拿到的是这次渲染私有临时目录里的参考音副本"
    cues, dur, mp3 = S.voxcpm_speech(line, x, cfg)
    assert len(events(log)) == len(ev), "已经配好的不能再起 worker"
    assert Path(mp3).parent == T / "tts"
    d = [max(0.6, len(t) * 0.12) for t in S.split_sentences(line)]   # 假 worker 的时长公式
    assert abs(cues[1][0] - (d[0] + S.VOXCPM_GAP_END)) < 0.01, cues
    assert abs(cues[2][0] - (d[0] + d[1] + 2 * S.VOXCPM_GAP_END)) < 0.01, cues
    assert abs(dur - cues[2][1]) < 0.2, (dur, cues)
    assert [c[2] for c in cues] == S.split_sentences(line), "字幕就是原句（不能带别的字）"
    comma = "这是一句特别长的话，" * 6 + "最后收尾。"   # > 48 字：在逗号处断开，逗号处的停顿短一点
    cc = S.voxcpm_speech(comma, x, cfg)[0]
    assert abs(cc[1][0] - cc[0][1] - S.VOXCPM_GAP_COMMA) < 0.01, cc
    assert not list((T / "tts").glob("*.part.*")), "临时文件要清掉"

    # ⑥ speak：剧本里的 voice / instructions 对 VoxCPM 角色不起作用；不认识的 tts 报错，不悄悄用 Edge
    n0 = len(events(log))
    S.speak("剧本想换声音。", x, cfg, {}, {"voice": str(outside), "instructions": "换成别人"}, T / "build" / "s.mp3")
    say = [e for e in events(log)[n0:] if e["event"] == "say"]
    assert say and say[0]["ref_sha"] == sha_x, say
    weird = S.Cast(T / "cast", "x", {})
    weird.tts = "voxcmp"
    raises(lambda: S.speak("x", weird, cfg, {}, {}, T / "b.mp3"), "不认识")

    # ⑥b 渲染途中主人换了参考音（同一个文件被覆盖）：这次渲染从头到尾还是开始时那个声音，缓存键也还是那个声音的
    swap = S.load_cast(cfg)["x"]
    S._voxcpm_setup(swap, cfg)                                   # 渲染开始时取了一次
    orig = (T / "cast" / "x" / "voice.wav").read_bytes()
    (T / "cast" / "x" / "voice.wav").write_bytes((T / "cast" / "y" / "voice.wav").read_bytes())
    n0 = len(events(log))
    cues_sw, _, mp3_sw = S.voxcpm_speech("换声音那一刻的这条。", swap, cfg)
    say = [e for e in events(log)[n0:] if e["event"] == "say"]
    assert say and say[0]["ref_sha"] == sha_x, "还是开始时那份参考音"
    assert mp3_sw.stem == S.voxcpm_key("换声音那一刻的这条。", {**S._voxcpm_setup(swap, cfg), "ref_sha": sha_x})
    (T / "cast" / "x" / "voice.wav").write_bytes(orig)

    # ⑥c 拿到显卡锁之后再查一次缓存：等锁的时候别的渲染已经配好的，不再起 worker
    j = S._voxcpm_job("换声音那一刻的这条。", swap, cfg)
    n0 = len(events(log))
    S._voxcpm_synthesize([j], cfg)
    assert len(events(log)) == n0

    # ⑥d 被硬掐掉的渲染留下的临时目录 / 半截缓存：下次拿着显卡锁时清掉（6 小时前的），新的不动
    old_dir = Path(tempfile.gettempdir()) / "whale-voxcpm-unit-old"
    new_dir = Path(tempfile.gettempdir()) / "whale-voxcpm-unit-new"
    for d_ in (old_dir, new_dir):
        d_.mkdir(exist_ok=True)
        (d_ / "0-0.wav").write_bytes(b"x")
    old_part = T / "tts" / "dead.123.part.mp3"
    old_part.write_bytes(b"x")
    past = time.time() - 7 * 3600
    for p_ in (old_dir, old_part):
        os.utime(p_, (past, past))
    S.voxcpm_prepare([("清理之后的这条。", x)], cfg)
    assert not old_dir.exists() and not old_part.exists() and new_dir.exists()
    S.shutil.rmtree(new_dir, ignore_errors=True)

    # ⑥e Python 起不来（venv 坏了，没读 job 就退出）：说清楚是主人那边的环境问题、带上它的输出，不是一句 BrokenPipeError
    os.environ["FAKE_VOXCPM_EXIT_EARLY"] = "1"
    many = [(f"第{i}条很长很长的台词，" * 30 + "完。", x) for i in range(40)]   # job 很大：写 stdin 时管道已经断了
    msg = raises(lambda: S.voxcpm_prepare(many, cfg), "没启动起来", "No Python")
    assert "再渲染会接着配" not in msg
    raises(lambda: S.voxcpm_prepare([("小的这条。", x)], cfg), "没启动起来")
    del os.environ["FAKE_VOXCPM_EXIT_EARLY"]

    # ⑦ 中途崩了：配好的那条已经在缓存里；再来一次只配剩下的
    os.environ["FAKE_VOXCPM_CRASH_AFTER"] = "1"
    raises(lambda: S.voxcpm_prepare([("崩之前这条。", x), ("崩之后这条。", x)], cfg), "中途退出", "1/2")
    del os.environ["FAKE_VOXCPM_CRASH_AFTER"]
    n0 = len(events(log))
    S.voxcpm_prepare([("崩之前这条。", x), ("崩之后这条。", x)], cfg)
    assert [e["text"] for e in events(log)[n0:] if e["event"] == "say"] == ["崩之后这条。"]

    # ⑧ 卡住：idleTimeout 秒没进展就收掉 worker、报错（不会一直挂着占显卡）
    os.environ["FAKE_VOXCPM_HANG"] = "1"
    t0 = time.time()
    raises(lambda: S.voxcpm_prepare([("卡住的这条。", x)], {**cfg, "voxcpm": {**cfg["voxcpm"], "idleTimeout": 2}}), "卡住")
    assert time.time() - t0 < 30, time.time() - t0
    del os.environ["FAKE_VOXCPM_HANG"]

    # ⑨ worker 报错 / 回的文件在临时目录外面 / 模型目录不在：都报错
    os.environ["FAKE_VOXCPM_ERROR"] = "1"
    raises(lambda: S.voxcpm_prepare([("报错的这条。", x)], cfg), "VoxCPM 配音失败", "out of memory")
    del os.environ["FAKE_VOXCPM_ERROR"]
    os.environ["FAKE_VOXCPM_ESCAPE"] = "1"
    raises(lambda: S.voxcpm_prepare([("越界的这条。", x)], cfg), "文件不对")
    del os.environ["FAKE_VOXCPM_ESCAPE"]
    assert not (T / "tts" / f"{S._voxcpm_job('越界的这条。', x, cfg)['key']}.json").exists()

    # ⑩ 显卡锁：另一个渲染正在配音 → 等不到就说清楚
    with S._file_lock(T / "tts" / "voxcpm"):
        raises(lambda: S.voxcpm_prepare([("等锁的这条。", x)], {**cfg, "voxcpm": {**cfg["voxcpm"], "lockWait": 0.3}}), "另一个渲染")

    # ⑪ 真 worker 的协议部分（不装 torch：塞假的 torch / numpy）：续写模式、不加括号、种子由句子决定
    calls, seeds = [], []

    class FakeModel:
        tts_model = types.SimpleNamespace(sample_rate=48000)

        def generate(self, **kw):
            calls.append(kw)
            return [0.0] * 4800

    saved = {m: sys.modules.get(m) for m in ("torch", "numpy")}
    sys.modules["torch"] = types.SimpleNamespace(manual_seed=seeds.append)
    sys.modules["numpy"] = types.SimpleNamespace(asarray=lambda w, dtype=None: w, float32=None)
    try:
        wrote, emitted = [], []
        job = {"out_dir": str(T), "cfg_value": 2.0, "steps": 10,
               "items": [{"id": "0", "ref": "R.wav", "ref_text": "参考文字。", "sentences": ["第一句。", "第二句。"]}]}
        W.run(job, FakeModel(), emitted.append, write_fn=lambda p, smp, sr: wrote.append((p.name, len(smp), sr)))
    finally:
        for m, v in saved.items():
            if v is None:
                sys.modules.pop(m, None)
            else:
                sys.modules[m] = v
    assert emitted == [{"event": "sentence", "id": "0", "k": 0}, {"event": "sentence", "id": "0", "k": 1},
                       {"event": "item", "id": "0", "pieces": ["0-0.wav", "0-1.wav"]}], emitted
    assert wrote == [("0-0.wav", 4800, 48000), ("0-1.wav", 4800, 48000)], wrote
    assert calls[0] == {"text": "第一句。", "prompt_wav_path": "R.wav", "prompt_text": "参考文字。", "reference_wav_path": "R.wav",
                        "cfg_value": 2.0, "inference_timesteps": 10}, calls[0]
    assert "(" not in calls[0]["text"], "续写模式下括号会被念出来"
    assert seeds == [W.seed_of("第一句。"), W.seed_of("第二句。")] and W.seed_of("第一句。") == W.seed_of("第一句。")
    try:
        W.run({**job, "items": [{**job["items"][0], "id": "../x"}]}, FakeModel(), emitted.append, synth_fn=lambda *a: ([0.0], 1), write_fn=lambda *a: None)
        raise AssertionError("id 不是数字应该报错")
    except ValueError:
        pass

    # ⑫ 试听：voices --provider voxcpm 用角色现在的参考音，复制一份到试听目录
    with contextlib.redirect_stdout(open(os.devnull, "w", encoding="utf-8")):
        S.voices(cfg, "voxcpm", ["x"], "试听的一句话。", "", T / "samples")
    assert (T / "samples" / "voxcpm-x.mp3").is_file()
    cast_edge = T / "cast" / "e"
    cast_edge.mkdir()
    (cast_edge / "profile.json").write_text('{"name": "e"}', encoding="utf-8")
    raises(lambda: S.voices(cfg, "voxcpm", ["e"], "x", "", T / "samples"), "没设成 VoxCPM")

    # ⑬ 显卡被占着（主人在玩游戏）：不抢，说清楚；查不了显卡（没有 nvidia-smi）就不拦
    reads, real_which, real_run, real_sleep = [], S.shutil.which, S.subprocess.run, S.time.sleep
    try:
        S.shutil.which = lambda name: "nvidia-smi" if name == "nvidia-smi" else real_which(name)
        S.time.sleep = lambda s: None
        S.subprocess.run = lambda *a, **k: types.SimpleNamespace(stdout=reads.pop(0) + "\n", returncode=0)
        reads[:] = ["12282, 6857, 99"] * 3
        assert "空闲显存" in S._gpu_busy({})
        reads[:] = ["12282, 1500, 99", "12282, 1500, 97", "12282, 1500, 95"]
        assert "满负荷" in S._gpu_busy({})
        reads[:] = ["12282, 1500, 90", "12282, 1500, 3", "12282, 1500, 80"]
        assert S._gpu_busy({}) is None, "三次里有一次闲着 = 不是一直满负荷"
        reads[:] = ["12282, 6857, 99"] * 3
        assert S._gpu_busy({"minFreeMB": 0, "maxBusyPct": 100}) is None
        reads[:] = ["12282, 6857, 99"] * 3
        n0 = len(events(log))
        raises(lambda: S.voxcpm_prepare([("游戏开着的这条。", x)], {**cfg, "voxcpm": {"python": sys.executable, "model": str(T / "model")}}), "显卡现在被别的程序占着")
        assert len(events(log)) == n0, "显卡被占着就不起 worker"
        S.shutil.which = lambda name: None
        assert S._gpu_busy({}) is None
    finally:
        S.shutil.which, S.subprocess.run, S.time.sleep = real_which, real_run, real_sleep

print("ok")
