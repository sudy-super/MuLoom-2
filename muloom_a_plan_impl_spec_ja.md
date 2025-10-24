
# MuLoom Rebuild (A案 / macOS & Apple Silicon) — 実装仕様書
最終更新: 2025-10-23

本書は、**同一端末上で UI とバックエンドを動かす**前提で、A案（Python + GStreamer + VideoToolbox + OpenGL/GLSL）をベースに、以下の追加機能を含む実装仕様をまとめたものです。

- NDI 入出力
- ISF shader 対応
- HAP / H.264 対応
- Beat Sync（テンポ/オンセット駆動）
- パニックカード（安全な即時フェールセーフ映像）
- 出力用のリアルタイム再生エンジンと UI エンジンを**別プロセス**に分離
- プリレンダ・ジェネ統合（オフライン書き出し／ジェネレータ）

---

## 1. システム全体像

```
+------------------------+        +---------------------------+
|  UI Engine (React/Tauri) | <WS>  |  Control API (FastAPI)     |
|  - 操作/パラメータ入力     | <----> |  - REST/WS                |
|  - WebRTCプレビュー表示     |       |  - Signaling(WebRTC)      |
+------------------------+        +---------------------------+
                                         |
                                         v
                               +---------------------------+
                               |  Render Engine (GStreamer)|
                               |  - vtdec/vtenc (HW)       |
                               |  - glshader/glvideomixer  |
                               |  - ndisrc/ndisink         |
                               |  - HAP/H.264               |
                               |  - WebRTC (webrtcbin)     |
                               |  - Syphon (任意)           |
                               +---------------------------+
                                         |
                                         +--> 出力: 画面/NDI/ファイル/WebRTC
```

- **制御系**は WebSocket（または Tauri IPC）。
- **映像プレビュー**は WebRTC（`webrtcbin` + `vtenc_h264`）。
- **GPU/メディアの重い処理**は GStreamer プラグイン側に委譲。Python はオーケストレーションに専念。

---

## 2. ディレクトリ構造

```
muloom-a/
├─ app/                         # Tauri（デスクトップラッパ）
│  ├─ src-tauri/
│  │   └─ tauri.conf.json
│  └─ ui/                       # React UI
│      ├─ src/
│      │   ├─ components/
│      │   │   ├─ MixerPanel.tsx
│      │   │   ├─ ShaderParams.tsx
│      │   │   ├─ TransportBar.tsx
│      │   │   ├─ PanicCardButton.tsx
│      │   │   └─ NDIManager.tsx
│      │   ├─ pages/
│      │   │   └─ App.tsx
│      │   ├─ hooks/
│      │   │   ├─ useWebSocket.ts
│      │   │   └─ useWebRTC.ts
│      │   └─ lib/webrtc/signaling.ts
│      └─ public/
│
├─ engine/                      # ランタイム（別プロセス）
│  ├─ __init__.py
│  ├─ main.py                   # プロセスエントリ（起動/監視）
│  ├─ pipeline.py               # GStreamer パイプライン生成・制御
│  ├─ graph/
│  │   ├─ mixers.py             # glvideomixer/compositor の組立
│  │   ├─ shaders.py            # glshader（GLSL）管理
│  │   ├─ isf_loader.py         # ISF 読込→GLSL/パス連結
│  │   ├─ sources.py            # ファイル/カメラ/NDI/HAP 等入力
│  │   ├─ outputs.py            # 画面/NDI/webrtc/filesink 等出力
│  │   ├─ codecs.py             # HAP/H.264/PCM 等のケイパビ
│  │   └─ panic.py              # パニックカード（input-selector/valve）
│  ├─ rtc/
│  │   ├─ webrtc.py             # webrtcbin の生成/SDP/ICE ハンドラ
│  │   └─ preview_branch.py     # gldownload→vtenc_h264→webrtcbin
│  ├─ audio/
│  │   ├─ beat_aubio.py         # aubio で BPM/オンセット推定
│  │   ├─ beat_essentia.py      # essentia 版（任意）
│  │   └─ taps.py               # 音声 taps（appsink / tee）
│  ├─ ndi/
│  │   ├─ ndi_in.py             # ndisrc / ndisrcdemux
│  │   └─ ndi_out.py            # ndisink / ndisinkcombiner
│  ├─ pregen/
│  │   ├─ prerender.py          # パラメトリック書き出し（HAP/H.264）
│  │   └─ generators.py         # ISF/GLSLジェネやLFOなど
│  ├─ api/
│  │   ├─ server.py             # FastAPI（REST/WS）
│  │   ├─ schemas.py            # pydantic モデル
│  │   └─ state.py              # セッション・ミックス状態
│  ├─ configs/
│  │   ├─ profiles.yaml         # 品質/レイテンシ/コーデック設定群
│  │   └─ mappings_isf.yaml     # ISF -> uniforms マッピング既定
│  └─ utils/
│      ├─ gst.py                # 汎用 Gst ヘルパ（pad-added, probe 等）
│      ├─ osx.py                # macOS 固有（CVPixelBuffer, Syphon 等）
│      └─ logging.py
│
├─ scripts/
│  ├─ dev_run.sh
│  ├─ gst_inspect_check.sh
│  └─ hap_transcode_examples.sh
│
├─ tests/
│  ├─ test_isf_loader.py
│  ├─ test_panic.py
│  ├─ test_codecs.py
│  └─ test_rtc.py
│
├─ docs/
│  └─ api-openapi.yaml          # REST/WS の仕様（OpenAPI）
│
├─ pyproject.toml               # エンジン側（Python）
└─ README.md
```

---

## 3. 役割と責務（各ファイル）

### engine/main.py
- Engine プロセスの立ち上げ・監視（例：`uvicorn` + スレッドで GStreamer の GL メインループを駆動）。
- UI エンジンからの起動リクエストを受けて `pipeline.py` を構築。

### engine/pipeline.py
- パイプライン生成の**オーケストレータ**。
- `graph/` 配下のファクトリを用いて、**入力→GPU段（glupload→glshader*N→glvideomixer）→出力**を組み立てる。
- `tee` でプレビュー枝を分岐、`rtc/preview_branch.py` に委譲。

### engine/graph/shaders.py
- `glshader` の生成・`fragment` 文字列の設定・`uniforms` の更新（GstStructure で一括）。
- UI からのパラメータ更新を受け、**最新値のみ**反映（高頻度更新はまとめる）。

### engine/graph/isf_loader.py
- ISF（.fs + JSONメタ）を読み込み、**単一/多段パス**を `glshader` チェーンへ展開。
- パラメータ（`INPUTS`/`UNIFORMS`）を UI 向けに**型/範囲/デフォルト**として公開。
- Multipass は FBO パス（`glshader` の多段）で実装し、`INPUT` の指定に応じて前段出力を束ねる。

### engine/ndi/*
- `ndi_in.py`：`ndisrc/ndisrcdemux` の生成、カラー/解像度ネゴ、音声の demux。
- `ndi_out.py`：`ndisink`（必要に応じて `ndisinkcombiner`）で送出。

### engine/rtc/*
- `webrtc.py`：`webrtcbin` の生成、SDP/ICE、DataChannel（任意）設定。
- `preview_branch.py`：`gldownload ! videoconvert ! vtenc_h264 ! rtph264pay ! webrtcbin` を構築。

### engine/audio/*
- `taps.py`：音声の `tee` / `appsink` を用意。
- `beat_aubio.py`/`beat_essentia.py`：BPM/オンセット検出 → WebSocket で UI/サーバへ通知。

### engine/graph/panic.py
- **パニックカード**を `input-selector` + `valve` で実現。任意の段で**黒/タイトル/ロゴ静止**へ即時切替。
- 重大エラー時には **自動フェールセーフ**に切替（watchdog）。

### engine/pregen/*
- `prerender.py`：任意のシーン構成 + パラメータ列を**ジョブ**として受理。
- GStreamer パイプラインを**ヘッドレス**に生成し、`vtenc_h264` または `avenc_hap` で**書き出し**。
- バッチ/キューはシンプルな SQLite/JSON キューでも可。

### engine/api/*
- `server.py`：REST/WS（FastAPI）。アセット列挙、デッキ操作、フェーダ、ISF パラメータ、NDI 入出力選択、パニック切替、プリレンダ指示など。
- `schemas.py`：pydantic モデル。
- `state.py`：ミックス状態（例：レイヤ構成、クロスフェーダ、シーンプリセット）。

---

## 4. 主要機能の仕様

### 4.1 NDI 入出力
- **入力**：`ndisrc ! ndisrcdemux` → colorspace 変換 → `glupload` → パイプラインへ。
- **出力**：ミックス後を `ndisink` へ。音声は `ndisinkcombiner` で合流可能。
- **依存**：NDI SDK が必要。`gst-plugin-ndi` をロードできるようパス設定。

**参考パイプライン**
```bash
# NDI 入力 → 画面
gst-launch-1.0 ndisrc source-name="(NDI Source Name)" ! ndisrcdemux name=dm   dm. ! queue ! videoconvert ! glupload ! glimagesink sync=false
```

### 4.2 ISF shader 対応
- ISF（Interactive Shader Format）の **パラメータ化された GLSL** を取り込み、
  - 単一パス：`glshader` 一発。
  - 多段パス：複数 `glshader` をチェーン、ISF の `INPUTS` 仕様に合わせて ping-pong。
- UI へは ISF のメタ（型/範囲/デフォ）を**そのままフォーム生成**に利用。

### 4.3 HAP / H.264 対応
- **HAP**：`avdec_hap` / `avenc_hap`（`gst-libav`）。エンコードには `libsnappy` が前提（環境構築時に有効化）。
- **H.264**：`vtdec` / `vtenc_h264`（Apple VideoToolbox）。`realtime=true`、`allow-frame-reordering=false` 等で低遅延。

**例：HAP 書き出し**
```bash
gst-launch-1.0 gltestsrc ! videoconvert !   avenc_hap ! qtmux ! filesink location=out_hap.mov
```

**例：H.264 書き出し（HWエンコード）**
```bash
gst-launch-1.0 gltestsrc ! videoconvert !   vtenc_h264 realtime=true allow-frame-reordering=false !   mp4mux ! filesink location=out_h264.mp4
```

### 4.4 Beat Sync
- `audio/taps.py` で `appsink` に流し、`beat_aubio.py` が**リアルタイム BPM/オンセット**を推定。
- 推定結果は **WS イベント**として UI へ送信（UI 側は拍変化でエフェクトやカットを駆動）。
- Essentia 版はオフライン/高精度向け（任意）。

### 4.5 パニックカード（フェールセーフ）
- `input-selector` をミックス直前に配置し、**通常出力**と**パニック出力（黒/ロゴ/バー）**を切替。
- 自動復帰を避ける場合は、オペレータの解除操作を必須に（誤復帰防止）。
- 重大例外やソース喪失時には `valve drop=true` で枝を遮断 → セレクタを**パニック側**に切替。

**参考**
```bash
# 通常系 tee と パニック（黒）を input-selector で切替
videomixer_out ! input-selector name=sel ! glimagesink
videotestsrc pattern=black is-live=true ! sel.
# 切替: gst_util_set_object_arg(G_OBJECT(sel), "active-pad", pad_of_black);
```

### 4.6 別プロセス分離（UI/Engine）
- UI（Tauri WebView 内）と Engine は**ローカル WS/HTTP**で通信。
- 低遅延・大量データは WebRTC（プレビュー）または Syphon（他アプリ共有）。
- 将来リモート操作に拡張する場合は、DataChannel へ制御移行可能。

### 4.7 プリレンダ・ジェネ統合
- `pregen/prerender.py`：任意のシーン構成 + パラメータ列を**ジョブ**として受理。
- GStreamer パイプラインを**ヘッドレス**に生成し、`vtenc_h264` または `avenc_hap` で**書き出し**。
- バッチ/キューはシンプルな SQLite/JSON キューでも可。

---

## 5. REST / WebSocket API（概要）

### REST（抜粋）
- `GET /assets`：ISF/GLSL/動画アセット列挙
- `POST /deck`：`{{ uri, layer, shader, isfParams }}`
- `POST /mix/crossfade`：`{{ value: 0.0..1.0 }}`
- `POST /ndi/in`：`{{ sourceName }}` / `DELETE /ndi/in`
- `POST /ndi/out`：`{{ publishName }}` / `DELETE /ndi/out`
- `POST /panic`：`{{ on: true|false, card: "black"|"bars"|"image:…" }}`
- `POST /prerender`：`{{ scene, codec:"hap|h264", params:[…] }}`

### WebSocket（抜粋）
- `{{ "type":"uniform", "shader":1, "values":{{ "time":1.23, "gain":0.8 }} }}`
- `{{ "type":"alpha", "pad":0, "value":0.75 }}`
- `{{ "type":"beat", "bpm":128, "phase":0.31, "onset":true }}`（Engine→UI）
- `{{ "type":"panic", "on":true }}`（相互）

---

## 6. 代表パイプライン（文字列レシピ）

### 6.1 2デッキ + GLSL + ミックス + ローカル表示 + WebRTC プレビュー
```
uridecodebin uri=file:///A.mov name=A  uridecodebin uri=file:///B.mov name=B
glvideomixer name=mix ! tee name=t
  t. ! queue ! glimagesink sync=false
  t. ! queue ! gldownload ! videoconvert ! vtenc_h264 realtime=true allow-frame-reordering=false ! rtph264pay ! webrtcbin
A. ! queue ! videoconvert ! glupload ! glshader fragment="<frag>" ! mix.
B. ! queue ! videoconvert ! glupload ! glshader fragment="<frag>" ! mix.
```

### 6.2 NDI 入力 + HAP 再生 + 出力は NDI
```
ndisrc source-name="StageCam-1" ! ndisrcdemux name=dm
dm. ! queue ! videoconvert ! glupload ! glshader fragment="<frag>" ! glvideomixer name=mix ! ndisink ndi-name="MuLoomOut"
uridecodebin uri=file:///clip_hap.mov ! avdec_hap ! videoconvert ! glupload ! mix.
```

### 6.3 パニックカード（黒）切替
```
... ! queue ! input-selector name=sel ! glimagesink
videotestsrc pattern=black is-live=true ! sel.
# 通常経路は別枝から sel. へリンク、UI から active-pad を切替
```

---

## 7. ビルド/実行
1. **GStreamer**: `brew install gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad gst-plugins-ugly gst-libav`
   - AppleMedia（VideoToolbox）/OpenGL/Libav/NDI プラグインを確認（`gst-inspect-1.0 vtenc_h264`, `avdec_hap`, `glshader`, `ndisrc`）。
2. **Python**: `uvicorn engine.api.server:app --reload`
3. **Tauri/React**: `cd app && npm run tauri dev`

---

## 8. 運用とパフォーマンス指針
- **HW コーデック優先**：`vtdec/vtenc_h264`（低遅延設定）。
- **GPU 内完結**：`glupload→glshader→glvideomixer`、`gldownload` はプレビュー枝のみ。
- **input-selector/valve** で安全に切替・遮断。
- **beat 検出**はアプリスレッドと分離（Queue で非同期）。

---

## 9. 参考資料（実装時に参照）
- NDI（GStreamer プラグイン）: https://gstreamer.freedesktop.org/documentation/ndi/index.html
- webrtcbin: https://gstreamer.freedesktop.org/documentation/webrtc/index.html
- glvideomixer: https://gstreamer.freedesktop.org/documentation/opengl/glvideomixer.html
- glshader: https://gstreamer.freedesktop.org/documentation/opengl/glshader.html
- AppleMedia (VideoToolbox, avfassetsrc, vtenc/vtdec): https://gstreamer.freedesktop.org/documentation/applemedia/index.html
- HAP (avdec_hap/avenc_hap): https://gstreamer.freedesktop.org/documentation/libav/avdec_hap.html
- ISF (Interactive Shader Format): https://isf.video/  / https://github.com/Vidvox/isf
- Beat detection: aubio https://aubio.org/manual/latest/ / essentia https://essentia.upf.edu/tutorial_rhythm_beatdetection.html
- Syphon (アプリ間テクスチャ共有): https://syphon.info/

---

## 付録A: 主要クラスの疑似インタフェース

```python
# engine/graph/isf_loader.py
class ISFProgram:
    path: str
    passes: list[str]  # glshader の fragment ソース列
    uniforms: dict     # name -> {{ "type": "...", "default": ..., "min": ..., "max": ... }}
    inputs: dict       # name -> {{ "type": "image"|"audio"|"float" ... }}

    @classmethod
    def load(cls, file_or_dir) -> "ISFProgram": ...

# engine/graph/panic.py
class PanicSwitch:
    def __init__(self, pipeline): ...
    def attach(self, video_pad) -> None: ...
    def trigger(self, card: str = "black"): ...  # select input-selector pad
```

```python
# engine/audio/beat_aubio.py
class BeatTracker:
    def __init__(self, sr=48000, hop=512): ...
    def connect(self, audio_src_pad): ...
    def on_sample(self, pcm) -> None: ...
    def result(self) -> dict:  # {{ "bpm": 128, "phase": 0.31, "onset": True }}
        ...
```

---

## 付録B: OpenAPI 抜粋（概念）
```yaml
paths:
  /ndi/in:
    post:
      summary: Attach NDI input
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                sourceName:
                  type: string
  /panic:
    post:
      summary: Toggle panic card
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                on: {{"type": "boolean"}}
                card: {{"type": "string", "enum": ["black", "bars", "logo"]}}
```
