# NOTICE · 第三方与免责

本项目（`bili-whale-cc`）移植自 [Alterssss/dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale)（MIT）：
`tools/`、`lib/scheduler.js` 及测试来自原项目；`host/`、`templates/` 和 Claude Code 适配为本项目新增。整体以 **MIT** 许可发布（见 `LICENSE`）。

## 它依赖/参考了这些第三方

| 名称 | 用途 | 许可 / 说明 |
|---|---|---|
| **Bilibili API** | 全部功能都调 B 站公开接口 | 非官方；本项目**不包含** B 站任何代码或数据 |
| **bilibili-API-collect** | 写 `tools/` 里的接口调用时参考了该项目（社区维护的 B 站接口文档） | 遵循其原项目许可；只是查阅参考，本项目**不包含、不分发**它的文档，接口说明请以原仓库为准 |
| **ffmpeg** | 抽帧 / 看画面（`tools/lib/ffmpeg.mjs` 只是**定位并调用**它） | **LGPL v2.1+**（若用 GPL 构建则为 GPL）。本项目**不打包、不分发** ffmpeg（发布页也不附带任何构建）：请自行安装（https://ffmpeg.org），或用 `studio-setup` 装进 `.studio-venv` 的 imageio-ffmpeg 自带的那一份（见下面工作室那一行）|
| **Node.js** | 运行环境 | MIT |
| **edge-tts** · **Pillow** · **imageio-ffmpeg** · **bilibili-api-python** · **aiohttp** · **qrcode** · **pypdf** | 工作室：配音 / 字幕 / 自带 ffmpeg / 投稿与数据 / 网络请求 / 扫码登录的二维码 / 讲义 PDF 抽文字（`reference add`） | 各自原许可（edge-tts LGPL-3.0、Pillow HPND、imageio-ffmpeg BSD-2 + 所带 ffmpeg 的 LGPL/GPL、bilibili-api-python GPL-3.0、aiohttp Apache-2.0（内含的 llhttp 为 MIT）、qrcode BSD-3-Clause、pypdf BSD-3-Clause）；**不随本项目分发**，由 `studio-setup` 从 PyPI 安装，作为独立进程调用 |
| **微软 Edge 在线语音** | 配音 | 非官方接口，可能随时变动；仅供个人使用 |
| **VoxCPM2**（OpenBMB；代码 + 模型权重）· **PyTorch** · **torchaudio** · **soundfile** | 工作室：本地配音（可选，角色 `tts: "voxcpm"`；`studio/voxcpm_worker.py` 只 `import voxcpm` 调用它，不含它的代码） | VoxCPM2 代码和权重均为 Apache-2.0，PyTorch BSD-3-Clause（随 torch 的 CUDA 库按 NVIDIA 条款），torchaudio BSD-2-Clause，soundfile BSD-3-Clause（它带的 libsndfile 为 LGPL-2.1+）；**不随本项目分发**：由主人自己装在单独的虚拟环境里（不是 `.studio-venv`，`studio-setup` 不装），模型自行下载，作为独立进程调用 |
| **sherpa-onnx**（k2-fsa）· **numpy** · **SenseVoiceSmall**（int8：`sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17`）· **silero VAD**（`silero_vad.onnx`） | 「听」（可选）：视频的声音在本机转成文字，只用 CPU（`studio/listen_worker.py` 只 `import sherpa_onnx` 调用它，不含它的代码） | sherpa-onnx Apache-2.0、numpy BSD-3-Clause；**SenseVoiceSmall**：sherpa-onnx 的这一份是从 `iic/SenseVoiceSmall` 转成 ONNX 的（[sherpa-onnx 的说明](https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html)），原模型权重用 **FunASR Model Open Source License Agreement**（v1.1；[模型卡](https://huggingface.co/FunAudioLLM/SenseVoiceSmall) · [许可原文](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE)；[FunAudioLLM/SenseVoice](https://github.com/FunAudioLLM/SenseVoice) 仓库的 MIT 只管代码、不管权重）；**silero VAD**：上游 [snakers4/silero-vad](https://github.com/snakers4/silero-vad) 是 MIT（[LICENSE](https://github.com/snakers4/silero-vad/blob/master/LICENSE)），发布页上的这个 `silero_vad.onnx` 是 k2-fsa 自己导出的，sherpa-onnx 的说明页没写它单独的许可。这两个转换过的文件本身按什么条款，请自己在 [sherpa-onnx 的 asr-models 发布页](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models) 和上面的链接核对（SenseVoice 的压缩包里带一份 `LICENSE`，`listen-setup` 只解出模型和 `tokens.txt`、用完删掉压缩包，所以它不留在本机）；**不随本项目分发**：由 `listen-setup` 从 PyPI 把 sherpa-onnx / numpy 装进 `.listen-venv`，两个模型从 sherpa-onnx 的 GitHub 发布页（`https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/`）下载到数据目录的 `listen-models/`，作为独立进程调用 |
| **DuckDuckGo**（`html.duckduckgo.com` 网页版）· **Bing**（`www.bing.com/search`）· 读书回合打开的公开网页 | 读网页（可选，默认关）：读书回合用文字浏览器取搜索结果页和公开网页（`tools/lib/websearch.mjs`、`webfetch.mjs`） | 非官方：不是搜索 API，是直接取公开的网页；本项目**不包含**这些网站的内容（读书回合打开的网页正文只在那一轮里暂存在 `~/.bili-ai/web/session/`，回合结束宿主就删掉；之后只留指纹（8 字片段的短哈希）和访问记录（网址、标题、搜过的词），不留原文）。使用者须自行遵守这些网站的使用条款；本项目不读 `robots.txt`，撞到验证码 / 「异常流量」页只说这次搜不到，不去绕 |
| **Claude Code** | 她的大脑：宿主用 `claude -p` 唤醒她 | Anthropic 商业条款；需自行安装并登录，用量计入你的 Claude 账号 |

## 免责

- 本项目是**个人自用工具的公开版**：它用**你自己的账号**在 B 站做评论/回复/发动态等动作，**后果由使用者自负**。
- 不要用于批量刷量、水军、骚扰、绕过风控或任何违反 B 站用户协议的行为。
- 遵循平台规则，撞到风控（验证码 / 限流 / 判刷屏）就该停手，本项目内置了"撞到就停"的护栏。
- 本地配音的参考音必须是你有权使用的声音（推荐用 VoxCPM2 按文字描述设计出来的原创音色）；**不要用它克隆真人的声音**。成片都会自动标注「AI 生成」。
- 本项目与 B 站、DeepSeek、Anthropic、OpenBMB 官方均无隶属关系。
