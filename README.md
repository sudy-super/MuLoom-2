# MuLoom Progress Log

## 2025-10-26

- Added GL-centred preview branch (`glupload ! glcolorconvert ! glimagesink`) and WebRTC distribution path (`gldownload ! vtenc_h264 ! rtph264pay ! webrtcsink`) to the runtime adapter, keeping both branches under the shared pipeline clock.
- Implemented instant rate change handling that prefers `INSTANT_RATE_CHANGE` seeks and falls back to segmented seeks when required, preserving uninterrupted playback.
- Enforced `expected_rev` across transport APIs and the controller UI; the frontend now auto-populates the current revision before dispatching commands.
- Resolved a runtime regression by replacing `Gst.Element.link_many` calls with an internal helper for broader gi bindings compatibility.
- Added a macOS-only `muloom_gpu` Tauriプラグイン that初期化する Metal バックエンドの `wgpu` レンダラをバックグラウンドスレッドで起動し、センターディスプレイ描画を GPU 直叩きに切り替え。
- Stabilised WebRTCプレビューの自動再生ロジック（既存ストリーム再割り当て時の `play()` 中断を回避）でブラウザの AbortError を防止。
- WebRTC 出力枝を `queue → glupload → glcolorconvert → capsfilter(memory:GLMemory) → gldownload → videoconvert → capsfilter(NV12) → H.264 encoder → h264parse(alignment=au) → rtph264pay(pt=96) → webrtcsink(video/x-h264)` に再構築し、VideoToolbox→x264→openh264→VAAPI の優先度で低遅延プロパティを固定、macOSの GLMemory/CPU リンク失敗を回避できるようにした。
- GL パスが確保できなかった場合でも Metal 環境で確実に GPU を使った後に CPU フォールバックへ切り替えられるよう、GL 分岐と CPU 分岐を個別関数化し、GLMemory caps の明示と tee pad リリース処理を追加。
- トランスポート更新時の SEEK が許容状態のみで発行されるようパイプライン状態を確認し、INSTANT_RATE_CHANGE → セグメント SEEK の順で再適用。
- Tightened WebRTC latency by constraining per-branch queue depth, defaulting sink latency to `0`, and capping VideoToolbox keyframe interval/bitrate for smoother synchronisation with the centre display.
- Tests: `pytest` (14 tests) & `cargo check` (app/src-tauri) on 2025-10-26.
