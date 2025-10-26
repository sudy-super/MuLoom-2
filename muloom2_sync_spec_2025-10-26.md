# MuLoom-2 同期アーキテクチャ指示書（コーディングエージェント向け）
作成日: 2025-10-26

本指示書は、**「フォールバック無しで決定論的に同期」**を目的とした大改造方針と、エンジン／UI／GStreamer 実装の詳細仕様を示す。対象の既存リポジトリ: `sudy-super/MuLoom-2`。

---

## 0. 目的と達成条件

### 目的
- デッキ、センターディスプレイ、ビューアー（プレビュー）の**常時フレーム同期**と**位置同期**を実現する。
- **停止→再生で頭出しに戻る**現象を根絶する。
- **再生速度↑→↓で同期崩壊**の発生を根絶する。
- 例外時も**再生成による状態ロスト**を避け、**単一のタイムライン**を唯一の真実として扱う。

### 達成条件（可観測 KPI）
- Deck と Center と Viewer の**相対フレーム時刻差**: p50 < 5ms, p95 < 12ms。
- **停止→再生**後の論理位置誤差: < 2ms。
- **rate: 1.0→2.0→0.5→1.0**の往復後、論理位置と各出力位置の誤差: p95 < 10ms。
- すべての制御は**原子的コマンド**で適用され、順序逆転は発生しない（rev により検知）。

---

## 1. 全体アーキテクチャ

```
+----------------------------+
| Global Timeline Service    |  <-- 単調増加クロックに基づく position/rate/playing の唯一ソース
|  - revisioned transport    |      (公式式: position_now = pos_at_rev + (now_mono - t0_at_rev) * rate)
+-------------+--------------+
              |
              v   (diff apply; atomic)
+-------------+--------------+
| Media Execution Adapter    |  <-- GStreamer 実行層。単一 GstClock へ拘束。
|  - Shared GstClock         |  - tee / multiqueue / (optional) ipcpipeline
|  - webrtcbin/webrtcsink    |  - 全出力へ同時 SEEK(rate,SEGMENT,FLUSH,ACCURATE)
+------+------+------+-------+
       |             |
       |             +--------------------> Center Display (sink)
       +----------------------------------> Deck (sink)
       +----------------------------------> Viewer (WebRTC → <video> 再生)
```

### 方針の要点
- **単一真実の時刻源**: Timeline が唯一の position/rate/playing を公開。UI/出力はこれのみ参照。
- **共有クロック**: 全出力は同一 `GstClock` に拘束。1 パイプラインにまとめられるなら `tee` で分岐。
- **速度変更は Seek イベント**: `gst_event_new_seek(rate, ...)` による **SEGMENT 切替**で原子的に変更。
- **停止=PAUSED**: READY/NULL に落とさず PAUSED を標準化。再開時は**直前位置へ FLUSH シーク**後 PLAYING。
- **Viewer は WebRTC**: GStreamer → `webrtcbin`/`webrtcsink` で配信し、ブラウザは RTP/RTCP の時刻で同期再生。

---

## 2. 既存構成の前提（確認）
- リポジトリの README/ログでは、**状態ストア**と**GStreamer アダプタ**の分離方針が明記されている（engine と app の二層）。
- 本指示書はこの方針を**同期制御に特化**して完成させる。

---

## 3. コンポーネント仕様

### 3.1 Global Timeline Service
- 単調増加クロック（例: `time.monotonic_ns()`）に基づく。
- 公開状態（transport）:
  ```json
  {
    "rev": 1234,
    "playing": true,
    "rate": 1.0,
    "pos_us": 123456789,   // rev 適用時の position
    "t0_us":  987654321    // rev 適用時の wall(=monotonic) 時刻
  }
  ```
- クライアントは **共通式**で現在位置を算出:  
  `position_now_us = pos_us + (monotonic_now_us - t0_us) * rate`  
  ※ playing=false の場合、`position_now_us = pos_us`（クロック停止）。

#### コマンド（原子的・rev 付き）
- `play(rev)` / `pause(rev)`
- `seek(rev, position_us)`
- `set_rate(rev, rate)`
- すべて **単一トランザクション**で State を更新 → Adapter へ差分配信 → 新 rev を返す。

### 3.2 Media Execution Adapter（GStreamer）
- **共有クロック**をパイプラインに設定し、自動選択を抑止。
- **単一パイプライン推奨**: `tee` + `queue`/`multiqueue` で分岐して Deck/Center/Viewer を駆動。
- **複数プロセスが必要**な場合は `ipcpipeline` を採用（master/slave でクロックを伝搬）。
- **速度変更/シーク**は **全出力へ同時に** `GST_EVENT_SEEK` を送出（`FLUSH|ACCURATE|SEGMENT`）。
- **停止/再開**は `PAUSED` ↔ `PLAYING` で行い、再開直前に直近位置へ **FLUSH シーク**してから `PLAYING`。

### 3.3 Viewer（Tauri/ブラウザ）
- 映像は **WebRTC** で受信（`webrtcbin`/`webrtcsink` → `RTCPeerConnection`）。
- `<video>` の `playbackRate` は**使用禁止**。A/V 同期は WebRTC の RTP/RTCP 時刻に委任。
- DataChannel で **snapshot**（transport と進行 tick）を配信し、UI のシークバーを Timeline 式で描画。
- Linux の WebKitGTK では `enable-webrtc` が必要な場合がある（ビルド/ランタイム設定に注意）。

---

## 4. GStreamer 実装詳細（Python/gi)

### 4.1 共有クロックの設定
```python
import gi, time
gi.require_version("Gst", "1.0")
from gi.repository import Gst, GLib
Gst.init(None)

pipeline = Gst.Pipeline.new("muloom")

# 共有クロック（SystemClock でも良い。必要に応じて自前クロックを実装）
clock = Gst.SystemClock.obtain()
pipeline.use_clock(clock)
pipeline.set_start_time(Gst.CLOCK_TIME_NONE)  # running-time でなく clock-time を使う

# 例: filesrc → decodebin → videoconvert → tee → (branch1 autovideosink) (branch2 webrtcsink ...)
```

### 4.2 tee 分岐
- `tee` の各分岐に **queue（または multiqueue）**を必ず入れる（片系の詰まりで全体が止まらないように）。
- 例（概念）:
```
... ! tee name=t
t. ! queue ! compositor(or mixer) ! autovideosink  # Center
t. ! queue ! deck_sink                              # Deck
t. ! queue ! webrtcsink                             # Viewer
```

### 4.3 速度変更 / シーク（原子的）
```python
def send_seek(pipeline: Gst.Pipeline, rate: float, start_ns: int):
    flags = Gst.SeekFlags.FLUSH | Gst.SeekFlags.ACCURATE | Gst.SeekFlags.SEGMENT
    ev = Gst.Event.new_seek(rate, Gst.Format.TIME, flags,
                            Gst.SeekType.SET, start_ns,
                            Gst.SeekType.NONE, Gst.CLOCK_TIME_NONE)
    pipeline.send_event(ev)
```

### 4.4 停止/再開
```python
# 停止は PAUSED（READY/NULL へ落とさない）
pipeline.set_state(Gst.State.PAUSED)

# 再開時は直近の position に FLUSH シーク後、PLAYING
send_seek(pipeline, rate=current_rate, start_ns=last_position_ns)
pipeline.set_state(Gst.State.PLAYING)
```

### 4.5 プロセス分割（任意）
- `ipcpipelinesink` / `ipcpipelinesrc` を用いて **master ↔ slave** を接続。slave 側パイプラインは master のクロックに **従属**する。

---

## 5. UI（Tauri/React）仕様（抜粋）

- **禁止**: `<video>.playbackRate`、ローカル `<video src="...">` 再生による独立クロック。
- **必須**:
  - WebRTC で `MediaStream` を受信し `<video>.srcObject = stream`。
  - DataChannel で `transport` の rev/tick を購読し、シークバーは **Timeline 式**で描画。
  - リサイズ/フルスクリーンは `<video>` の CSS のみで処理（タイムラインには影響させない）。
- **Linux**: WebKitGTK の WebRTC 有効化（ビルドフラグ or ランタイム設定）を CI で検証。

---

## 6. エンドポイント / データモデル

### 6.1 REST（例）
- `GET /engine/snapshot` →
  ```json
  {
    "transport": { "rev": 42, "playing": true, "rate": 1.0, "pos_us": 123, "t0_us": 456 },
    "decks": [ ... ],
    "outputs": [ ... ]
  }
  ```
- `POST /engine/command`
  ```json
  { "rev": 42, "op": "set_rate", "rate": 2.0 }
  ```

### 6.2 DataChannel（UI へ push）
- `snapshot`（起動/再接続時）
- `tick`（30〜60Hz。`transport.rev` と `now_mono_us` を含める）

---

## 7. 例外時の挙動（フォールバック禁止）

- **ルールA**: パイプライン再生成を**しない**（原則）。復旧は **FLUSH シーク + 状態再適用**。
- **ルールB**: 速度変更は **Seek イベントのみ**。sink/HTML 側に個別設定しない。
- **ルールC**: 停止は **PAUSED** のみで表現。

---

## 8. 具体的タスク一覧（優先順）

1. **Timeline/Transport 実装**（rev 付き・単調クロック）
2. **Adapter: 共有クロック + tee 構成**（単一パイプラインで Deck/Center/Viewer を駆動）
3. **Seek(rate) の一斉送出** API（FLUSH|ACCURATE|SEGMENT）
4. **停止=PAUSED 標準化**（再開時 FLUSH シークの挿入）
5. **Viewer の WebRTC 化**（`webrtcsink` + DataChannel）
6. **ドリフト監視**（`gst_query_position` と Timeline の差分を監視し、閾値超過でマイクロシーク）
7. **E2E テレメトリ**（各出力の表示時刻 vs Timeline の差を統計収集）
8. **自動テスト**（下記参照）
9. **CI（Linux/macOS/Windows）**: GStreamer & WebRTC の有効化検証

---

## 9. テスト計画

### 9.1 単体（Timeline）
- play→pause→resume で `Δpos < 2ms`
- rate: 1.0→2.0→0.5→1.0 で理論位置誤差 p95 < 10ms

### 9.2 結合（GStreamer フェイクシンク）
- `videotestsrc` + `fakesink` で `gst_query_position()` と Timeline の誤差 p95 < 8ms
- `tee` の 2 分岐（Deck/Center）の相対差 p95 < 5ms

### 9.3 E2E（Viewer 含む）
- WebRTC 受信側で `RTCRtpReceiver.getSynchronizationSources()` と `getStats()` を利用し、
  `Timeline vs RTP playout` の差をサンプルリングして CSV 出力（回帰可）。

---

## 10. 実装スニペット集

### 10.1 Python: 共通式
```python
def now_pos_us(transport, mono_now_us):
    if not transport["playing"]:
        return transport["pos_us"]
    return transport["pos_us"] + int((mono_now_us - transport["t0_us"]) * transport["rate"])
```

### 10.2 Python: 速度変更 API
```python
def set_rate_and_seek(pipeline: Gst.Pipeline, rate: float, pos_us: int):
    send_seek(pipeline, rate=rate, start_ns=pos_us * 1000)
```

### 10.3 UI: Timeline 表示（擬似コード）
```ts
const monoNowUs = performance.now() * 1000;
const posNowUs = playing ? posUs + (monoNowUs - t0Us) * rate : posUs;
seekbar.value = posNowUs / durationUs;
```

---

## 11. ビルド/ランタイム要件メモ

- GStreamer 1.20+（`webrtcbin`, `webrtcsink`, `ipcpipeline`, `nice` 等を含むセット）
- Linux（WebKitGTK）の場合、**WebRTC 有効化**と `gst-plugins-bad` を CI で確認
- Windows は WebView2（Chromium）で WebRTC が標準対応
- macOS は WKWebView（Safari 相当）で WebRTC が標準対応

---

## 12. 参考資料（一次情報中心）

- GStreamer **Clock/Segment 同期の基礎**: https://gstreamer.freedesktop.org/documentation/application-development/advanced/clocks.html
- GStreamer **Playback speed (Seek Event)**: https://gstreamer.freedesktop.org/documentation/tutorials/basic/playback-speed.html
- GStreamer **States** 概要: https://gstreamer.freedesktop.org/documentation/additional/design/states.html
- GStreamer **Paused の意味/プレステート**: https://gstreamer.freedesktop.org/documentation/plugin-development/basics/states.html
- GStreamer **GstPipeline（Clock 配布）**: https://gstreamer.freedesktop.org/documentation/gstreamer/gstpipeline.html
- GStreamer **tee**: https://gstreamer.freedesktop.org/documentation/coreelements/tee.html
- GStreamer **handy elements**（tee の活用）: https://gstreamer.freedesktop.org/documentation/tutorials/basic/handy-elements.html
- GStreamer **ipcpipeline**: https://gstreamer.freedesktop.org/documentation/ipcpipeline/index.html
- GStreamer **ipcpipelinesrc**（master/slave 同期）: https://gstreamer.freedesktop.org/documentation/ipcpipeline/ipcpipelinesrc.html
- GStreamer **webrtcbin**: https://gstreamer.freedesktop.org/documentation/webrtc/index.html
- （簡易）**webrtcsink**: https://gstreamer.freedesktop.org/documentation/rswebrtc/index.html
- WebRTC **RTCRtpReceiver.getSynchronizationSources()**: https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/getSynchronizationSources
- Tauri **WebView ランタイム**（WebView2 / WebKitGTK / WKWebView）: https://tauri.app/v1/references/webview-versions

---

## 13. 変更の影響範囲 & ロールアウト

- **互換性**: REST の `snapshot` 形は維持。プレイヤー操作は `POST /engine/command` に集約。
- **段階導入**:
  1) 共有クロック + 単一パイプライン（Deck/Center の同期を先に固定）
  2) Viewer を WebRTC へ切替（段階的 feature flag）
  3) 速度変更の Seek 化とテレメトリ導入
- **ロールバック**: 旧プレビュー経路への切替フラグを残す（短期間）。ただし**本番では禁止設定**。

---

## 14. 既知リスクと対策
- **一部 demuxer/sink の精度差**: マイクロシーク（±1〜2フレームの FLUSH なし SEGMENT update）で吸収。
- **WebKitGTK の WebRTC 依存**: CI で `webkit2gtk` のバージョン/ビルドオプションを固定し、手元と揃える。
- **高負荷時のドリフト**: `queue` 深さと `is-live` の調整、`rtpjitterbuffer` の設定で緩和。

---

## 15. まとめ（指示）
- **単一 Timeline**・**共有 GstClock**・**Seek による可変速/位置制御**・**Viewer=WebRTC** の 4 本柱で同期を**決定論化**せよ。
- 停止は **PAUSED**、再開時は **直近位置へ FLUSH シーク**後に **PLAYING**。
- HTML 側の `playbackRate` や個別同期処理は**禁止**。

以上。
