
# MuLoom-2 実装指示書（詳細版 / コーディングエージェント向け）
**目的**: 既存機能を保ちつつ、以下を**最小差分**で導入する。  
- デッキ群・センターディスプレイ・ブラウザビューアの**映像同期**（同一クロック／同一タイムライン）  
- コントロールパネル操作の**絶対性**（即時・順序逆転なし・原子的）  
- **操作しても再生が途切れない**（パイプライン再構築は原則しない）  
- **フォールバックを避けて狙った経路のみ**  
- **Metal（mac）での高速化**＋**可変FPS**  
- **WebGPU** によるブラウザ側**可変FPS**

> 注: レポジトリのディレクトリ構成は想定名です（`engine/`, `apps/center`, `apps/viewer`, `control-panel/` 等）。実体に合わせて調整。

---

## 0. 全体アーキテクチャ
```
(sources...) -> compositor -> [tee name=t]
  t. -> queue -> glimagesink                                # 段階1: センター描画（GL）
  t. -> queue -> gldownload -> vtenc_h264 -> rtph264pay -> webrtcsink  # WebRTC 配信（HWエンコ）
```
- **単一 `GstPipeline` + 共有 `GstClock`** で**同一「走行時間（running-time）」**に同期。  
- **制御（play/pause/seek/rate）**は **`gst_element_seek`/`gst_event_new_seek`**（`FLUSH|SEGMENT|ACCURATE`、レートのみは `INSTANT_RATE_CHANGE` 検討）。  
- **センター描画**は段階1で `glimagesink`、段階2で **wgpu(Metal backend)** ＋ **CVDisplayLink** に移行。  
- **ビューア**は WebRTC で `<video>` 受信し、**WebGPU `importExternalTexture()`**＆**`requestVideoFrameCallback()`** で**フレーム到着駆動（可変FPS）**。

---

## 1. Engine（GStreamer）

### 1.1 パイプライン骨子（Rust/gstreamer-rs擬似コード）
```rust
use gstreamer as gst;
use gst::prelude::*;

fn build_pipeline() -> anyhow::Result<gst::Pipeline> {
    gst::init()?;
    let pipeline = gst::Pipeline::new();

    // 例: ソース群 -> compositor
    let src1 = gst::ElementFactory::make("videotestsrc").property("is-live", true).build()?;
    let conv = gst::ElementFactory::make("videoconvert").build()?;
    let comp = gst::ElementFactory::make("compositor").build()?;

    // tee で分岐
    let tee = gst::ElementFactory::make("tee").name("t").build()?;

    // 枝A: センター表示（段階1はGL、後にMetalへ差替）
    let q_center = gst::ElementFactory::make("queue").build()?;
    let glsink   = gst::ElementFactory::make("glimagesink").build()?;

    // 枝B: WebRTC 配信（HWエンコ: VideoToolbox）
    let q_webrtc = gst::ElementFactory::make("queue").build()?;
    let gldl     = gst::ElementFactory::make("gldownload").build()?; // GL->CPU
    let vtenc    = gst::ElementFactory::make("vtenc_h264").build()?;  // HWエンコ
    let pay      = gst::ElementFactory::make("rtph264pay").build()?;
    let wrtc     = gst::ElementFactory::make("webrtcsink")
                     .property_from_str("signaller::uri", "ws://127.0.0.1:8443") // 例
                     .build()?;

    pipeline.add_many(&[&src1, &conv, &comp, &tee,
                        &q_center, &glsink, &q_webrtc, &gldl, &vtenc, &pay, &wrtc])?;
    gst::Element::link_many(&[&src1, &conv, &comp, &tee])?;

    // 枝A
    gst::Element::link_many(&[&q_center, &glsink])?;
    tee.link(&q_center)?;

    // 枝B
    gst::Element::link_many(&[&q_webrtc, &gldl, &vtenc, &pay, &wrtc])?;
    tee.link(&q_webrtc)?;

    Ok(pipeline)
}
```

**ポイント**
- `tee` の**各枝に `queue`** を置いてスレッド分離。  
- GL パスからエンコードに回す枝は `gldownload` で CPU 側へ下ろしてから `vtenc_h264`。  
- **単一パイプライン**で**共通クロック**により**同期**（`running-time = absolute - base_time` の一致）。

### 1.2 操作API（「操作は絶対」+ ノンストップ）
**TransportSnapshot**
```ts
// control-panel と engine で共有するスナップショット
type TransportSnapshot = {
  rev: number;        // 原子的に単調増加
  playing: boolean;
  rate: number;       // 例: 0.5 / 1.0 / 2.0
  pos_us: number;     // last-set の基準位置（μs）
  t0_us: number;      // 単調時計基準（setした瞬間の mono time）
};
// 現在位置の復元: pos_now = pos_us + (mono_now - t0_us) * rate
```

**エンジンの seek/rate 実装（Rust/gstreamer-rs）**
```rust
fn seek_segment(pipeline: &gst::Pipeline, rate: f64, ts_ns: u64) -> anyhow::Result<()> {
    use gst::prelude::*;
    let seek_event = gst::event::Seek::new(
        rate,
        gst::SeekFlags::FLUSH | gst::SeekFlags::SEGMENT | gst::SeekFlags::ACCURATE,
        gst::SeekType::Set, gst::ClockTime::from_nseconds(ts_ns),
        gst::SeekType::None, gst::ClockTime::NONE,
    );
    let res = pipeline.send_event(seek_event);
    anyhow::ensure!(res, "seek failed");
    Ok(())
}

fn set_rate_instant(pipeline: &gst::Pipeline, rate: f64) -> anyhow::Result<()> {
    // 方向を変えず位置も維持する場合のみ（対応要素がある場合に即時反映）
    let ok = pipeline.seek_simple(gst::SeekFlags::INSTANT_RATE_CHANGE, rate);
    if !ok {
        // 後方互換: FLUSH|SEGMENT で通常のレート変更
        let cur = pipeline.query_position::<gst::ClockTime>().unwrap_or(gst::ClockTime::NONE);
        if let Some(t) = cur {
            seek_segment(pipeline, rate, t.nseconds())?;
        }
    }
    Ok(())
}
```

**REST/WS API（簡略）**
```http
POST /transport/seek { "target_us": 123456789, "expected_rev": 42 }
POST /transport/rate { "rate": 2.0, "expected_rev": 43 }
POST /transport/playpause { "playing": true, "expected_rev": 44 }
```
- サーバ側は `expected_rev` 一致時のみ適用し、**新 `rev` と `TransportSnapshot`** を WS ブロードキャスト。  
- UI は**楽観反映**→**確定スナップショットで補正**。

### 1.3 `gst-launch-1.0` による再現例（動作確認）
```bash
# センター表示 + WebRTC 配信（ローカル Signaller 例）
gst-launch-1.0 videotestsrc is-live=true ! videoconvert ! compositor ! tee name=t \
  t. ! queue ! glimagesink sync=true \
  t. ! queue ! gldownload ! vtenc_h264 ! rtph264pay pt=96 ! \
      webrtcsink signaller::uri=ws://127.0.0.1:8443
```

---

## 2. Center（Metal / wgpu）

### 2.1 段階1（最小差分）
- 既存の GL パス（`glimagesink`）を継続。

### 2.2 段階2（Metal 直描画 / 可変FPS）
- **Tauri プラグイン**を新設（例: `plugins/muloom_gpu`）。
- `wgpu` を **Metal バックエンド**で初期化し、`CAMetalLayer` に描画。  
- **CVDisplayLink**（macOS可変リフレッシュ対応）で描画ループを駆動。

**Cargo.toml（抜粋）**
```toml
[dependencies]
wgpu = "0.20"
winit = "0.29"
objc2 = { version = "0.5", features = ["foundation", "metal", "quartz-core"] }
tauri = { version = "2", features = ["macros"] }
anyhow = "1"
```

**Rust（プラグイン骨子）**
```rust
// plugins/muloom_gpu/src/lib.rs
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Runtime, AppHandle};
use anyhow::Result;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("muloom_gpu")
    .setup(|app_handle| {
      // wgpu 初期化は別スレッドで
      std::thread::spawn({
        let app = app_handle.clone();
        move || {
          if let Err(e) = run_wgpu(app) {
            eprintln!("wgpu init failed: {e:?}");
          }
        }
      });
      Ok(())
    })
    .build()
}

fn run_wgpu<R: Runtime>(_app: AppHandle<R>) -> Result<()> {
  // wgpu::Instance (Backend = Metal)
  let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
    backends: wgpu::Backends::METAL,
    ..Default::default()
  });
  // 実アプリでは window から CAMetalLayer を取得し Surface を作成
  // let surface = unsafe { instance.create_surface(&window) }?;
  // adapter/device/queue 取得
  // CVDisplayLink でフレーム毎に redraw 要求（FFI で callback -> draw()）
  Ok(())
}
```

**CVDisplayLink（Swift ブリッジ例 / FFI 連携イメージ）**
```swift
// plugins/muloom_gpu/macos/Sources/DisplayLink.swift
import Foundation
import CoreVideo

final class DisplayLink {
  private var link: CVDisplayLink?
  init(_ callback: @escaping () -> Void) {
    CVDisplayLinkCreateWithActiveCGDisplays(&link)
    CVDisplayLinkSetOutputHandler(link!) { _,_,_,_,_ in
      callback()
      return kCVReturnSuccess
    }
  }
  func start() { CVDisplayLinkStart(link!) }
  func stop()  { CVDisplayLinkStop(link!) }
}
```
> Rust 側に `extern "C"` でコールバックを橋渡しし、**可変リフレッシュ**に追従。

**IOSurface → Metal テクスチャ共有（Swift 概要）**
```swift
import Metal
import CoreVideo

let cache: CVMetalTextureCache
CVMetalTextureCacheCreate(nil, nil, device, nil, &cache)
var mtex: CVMetalTexture?
CVMetalTextureCacheCreateTextureFromImage(nil, cache, pixelBuffer, nil,
                                          .bgra8Unorm, width, height, 0, &mtex)
let texture = CVMetalTextureGetTexture(mtex!)
// これを wgpu/Metal パスにバインドして描画
```

---

## 3. Viewer（WebGPU / 可変FPS）

### 3.1 受信
- WebRTC で `<video id="v" autoplay playsinline muted>` を生成し、`srcObject` に `MediaStream` を接続。

### 3.2 WebGPU レンダリング
**TypeScript（rvfc + importExternalTexture）**
```ts
const video = document.getElementById("v") as HTMLVideoElement;

// WebGPU init
const adapter = await navigator.gpu!.requestAdapter();
const device  = await adapter!.requestDevice();
const canvas  = document.querySelector("canvas")! as HTMLCanvasElement;
const ctx     = canvas.getContext("webgpu") as GPUCanvasContext;
ctx.configure({ device, format: navigator.gpu.getPreferredCanvasFormat() });

// Pipeline: sampler で GPUExternalTexture をサンプル
const module = device.createShaderModule({
  code: /* wgsl */`
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var ext_tex: texture_external;
@fragment fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  return textureSampleBaseClampToEdge(ext_tex, samp, pos.xy); // 0..canvas
}`});
const pipeline = device.createRenderPipeline({
  layout: "auto",
  fragment: { module, entryPoint: "fs", targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }] },
  vertex: { module, entryPoint: "vs_fullscreen" } // 省略: フルスクリーン頂点
});

const sampler = device.createSampler();
const bind = (ext: GPUExternalTexture) => device.createBindGroup({
  layout: pipeline.getBindGroupLayout(0),
  entries: [
    { binding: 0, resource: sampler },
    { binding: 1, resource: ext }
  ]
});

function draw(ext: GPUExternalTexture) {
  const ctx = (canvas.getContext("webgpu") as GPUCanvasContext);
  const tex = ctx.getCurrentTexture();
  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({ colorAttachments: [{
    view: tex.createView(), clearValue: {r:0,g:0,b:0,a:1}, loadOp: "clear", storeOp: "store"
  }]});
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bind(ext));
  pass.draw(3); // fullscreen tri
  pass.end();
  device.queue.submit([enc.finish()]);
}

// 可変FPS: 供給フレーム到着で描画
function loop() {
  video.requestVideoFrameCallback((_now, _meta) => {
    const ext = device.importExternalTexture({ source: video });
    draw(ext);
    loop();
  });
}
loop();
```

> `requestVideoFrameCallback()` により**固定 rAF ではなく供給フレーム**に同期。`GPUDevice.importExternalTexture()` で `<video>` を**0コピー相当**でサンプリング。

---

## 4. コントロールパネル（「操作は絶対」プロトコル）

### 4.1 仕様
- **全操作**に `expected_rev` を必須化。サーバ側で一致時のみ適用。  
- 適用後、**新 `rev` と `TransportSnapshot`** を**即時**に WS ブロードキャスト。  
- UI は**楽観反映**し、受信スナップショットで補正。

### 4.2 例（TypeScript クライアント）
```ts
async function sendCommand<T>(path: string, body: T & { expected_rev: number }) {
  const r = await fetch(path, { method: "POST", body: JSON.stringify(body) });
  if (!r.ok) throw new Error(await r.text()); // 409: RevisionMismatch
}
```

---

## 5. テスト & KPI

### 5.1 同期精度
- **目標**: センター vs ビューアのフレーム時刻差 p50 < 5ms / p95 < 12ms。  
- **方法**: 送信側の RTP timestamp と RTCP SR の **NTP↔RTP マッピング**で「壁時計時刻↔RTP」の対応を取り、受信側で描画時刻と比較してヒストグラム化。

### 5.2 連続操作耐性
- `play/pause`、`seek`、`rate(1.0→2.0→0.5→1.0)` を**連打**しても映像中断なし（`PAUSED`運用＋`SEGMENT`）。

### 5.3 GST_DEBUG 例
```bash
GST_DEBUG="webrtc*:4,rtp*:4,rtsp*:3" ./muloom-engine
```

---

## 6. 作業ステップ

### Step A — エンジン統一 & 分岐
1. 単一 `GstPipeline` へ整理。  
2. `compositor ! tee` 後に `queue` を置き、**センター**と**WebRTC**へ分岐。  
3. **WebRTC枝**: `gldownload ! vtenc_h264 ! rtph264pay ! webrtcsink`。  
4. `play/pause/seek/set_rate` を **`gst_element_seek`** 系へ統一。

### Step B — 原子的操作
1. すべての操作APIに `expected_rev` を追加。  
2. サーバは一致時のみ適用→**新rev & スナップショット**配信。  
3. UI は**即時反映**→**確定値で補正**。

### Step C — Center の Metal 化
1. Tauri プラグイン（Rust）新設、`wgpu` を Metal backend で初期化。  
2. **CVDisplayLink** で描画ループ（可変FPS）。  
3. （任意）`IOSurface` 受け渡しでゼロコピー相当。

### Step D — Viewer の WebGPU 化
1. WebRTC 受信 `<video>` を生成。  
2. `video.requestVideoFrameCallback()` でフレーム到着毎に描画。  
3. `device.importExternalTexture({ source: video })` で**取り込み**、`texture_external` をサンプル。

### Step E — チューニング
1. `multiqueue` 水位、`sync-by-running-time` の挙動を確認し調整。  
2. `webrtcsink` の Signaller 設定、RTCP 間隔・FEC/RTX を要件に合わせる。  
3. KPI を自動判定する簡易スクリプトを追加。

---

## 7. 参考リンク（実装時に参照）
- **GStreamer**
  - webrtcsink（WebRTC配信SINK）  
    - https://gstreamer.freedesktop.org/documentation/rswebrtc/webrtcsink.html  
    - https://gstreamer.freedesktop.org/documentation/rswebrtc/index.html
  - WebRTC（webrtcbin 概要）  
    - https://gstreamer.freedesktop.org/documentation/webrtc/index.html
  - Apple VideoToolbox（vtenc_h264 / vtdec）  
    - https://gstreamer.freedesktop.org/documentation/applemedia/vtenc_h264.html  
    - https://gstreamer.freedesktop.org/documentation/applemedia/index.html
  - GL 経路  
    - https://gstreamer.freedesktop.org/documentation/opengl/glimagesink.html  
    - https://gstreamer.freedesktop.org/documentation/opengl/gldownload.html
  - tee / multiqueue / 同期 / SEEK  
    - https://gstreamer.freedesktop.org/documentation/coreelements/tee.html  
    - https://gstreamer.freedesktop.org/documentation/coreelements/multiqueue.html  
    - https://gstreamer.freedesktop.org/documentation/additional/design/synchronisation.html  
    - https://gstreamer.freedesktop.org/documentation/additional/design/seeking.html  
    - SeekFlags（INSTANT_RATE_CHANGE）: https://valadoc.org/gstreamer-1.0/Gst.SeekFlags.html
- **RTP/RTCP（同期基盤）**
  - RFC3550（Sender Report での NTP↔RTP 対応）  
    - https://datatracker.ietf.org/doc/html/rfc3550
- **Metal / CVDisplayLink / IOSurface**
  - CVDisplayLink（Metal Display Link）  
    - https://developer.apple.com/documentation/Metal/achieving-smooth-frame-rates-with-a-metal-display-link
  - CVMetalTextureCache / MTLTexture（IOSurface 共有）  
    - https://developer.apple.com/documentation/corevideo/cvmetaltexturecachecreatetexturefromimage%28_%3A_%3A_%3A_%3A_%3A_%3A_%3A_%3A_%3A%29  
    - https://developer.apple.com/documentation/metal/mtltexture
- **WebGPU / 可変FPS**
  - WebGPU 概要 / ExternalTexture / rvfc  
    - https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API  
    - https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/importExternalTexture  
    - https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback
