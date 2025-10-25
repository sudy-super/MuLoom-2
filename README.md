# MuLoom バックエンド作業ログ

## 計画
- [x] パイプラインの開始／停止フローを強化し、雑な操作でもクラッシュせずフォールバックするようにする。
- [x] 共有状態スナップショットに `last_error` を含め、パイプラインの状態を可視化する。
- [ ] プレースホルダー処理を拡張し、他のソース／出力種別にも対応させる。
- [ ] プレースホルダーとステータス報告を検証する自動テストを追加する。

## 進捗（2025-10-25）
- `engine/pipeline.Pipeline` を改修し、GStreamer が未導入の場合や未サポートのソース・無効な URI が指定された場合でも `videotestsrc` へのフォールバックと `last_error` 記録で安全に処理できるようにした。
- `EngineState.snapshot()` に `pipeline` 情報を追加し、UI 側でバックエンドの健全性を確認できるようにした。
- `python -m compileall engine/pipeline.py` でモジュールがコンパイル可能であることを確認した。

## 仕様メモ
- `Pipeline.describe()` がグラフ情報に加えて `last_error` を返すようになり、診断が容易になった。
- `Pipeline.start()` はパイプラインを構築できない理由を記録しつつ安全にリトライ可能な状態を保つ。
- ファイルソースはエラー発生時に自動でプレースホルダーへ切り替わり、ミキサーのアルファを 0 のまま保持して表示崩れを防ぐ。
- プレースホルダーの映像枝は `videotestsrc → videoconvert → glupload → queue` で構成し、利用できない要素はログを残してスキップする。
- `EngineState.snapshot()` がパイプライン状態を API/UI へ公開する。

## 次のステップ
- 必要に応じて API 経由でミキサー／出力の追加メトリクスを公開する。
- `last_error` とプレースホルダー配線を検証するユニットテストを整備する。

## 検証
- `python -m compileall engine/pipeline.py`

---

# uv を用いた Python 環境構築手順

MuLoom のバックエンド開発では Python 3.11 以上を想定しています。`uv` を利用すると仮想環境の作成と依存関係のインストールをワンコマンドで行えます。

1. **uv のインストール**
   ```bash
   curl -LsSf https://astral.sh/uv/install.sh | sh
   ```
   Homebrew 経由の場合は `brew install uv` でも構いません。

2. **仮想環境の作成と依存解決**
   ```bash
   uv sync
   ```
   - `.venv/` が生成され、`pyproject.toml` に記載された依存関係がインストールされます。
   - 開発ツールも入れたい場合は `uv sync --dev` を利用してください。

3. **仮想環境の有効化**
   ```bash
   source .venv/bin/activate
   ```
   終了する際は `deactivate` を実行します。

4. **GStreamer/PyGObject の導入**
   - GStreamer は Homebrew などで別途インストールが必要です（例: `brew install gstreamer gst-plugins-base ...`）。
   - Python 側から利用するために `pycairo` と `PyGObject` を pip/uv で入れる前に `gobject-introspection` などのネイティブライブラリが揃っていることを確認してください。
   - Homebrew で導入したライブラリを見つけられるよう、仮想環境を有効化した後に `source scripts/env.d/gstreamer_env.sh` を実行すると環境変数が設定されます。

5. **動作確認**
   ```bash
   uv run python - <<'PY'
   import gi
   gi.require_version("Gst", "1.0")
   from gi.repository import Gst
   Gst.init(None)
   print("GStreamer version:", Gst.version_string())
   PY
   ```

`uv run ...` で仮想環境内の Python コマンドを直接実行できるため、テストやスクリプトの実行にも活用できます。

---

# MuLoom エンジン（A案スキャフォールド）

このリポジトリは `muloom_a_plan_impl_spec_ja.md` の構成に合わせて、

- `app/` … Tauri ラッパー用の `src-tauri/` と、React/Vite ベースの UI を格納する `ui/`
- `engine/` … FastAPI + GStreamer を想定した Python ランタイム
- `scripts/`, `tests/`, `docs/` … 運用スクリプト・テスト・API ドキュメントの雛形

といったディレクトリで構成されています。

UI 側のソースは `app/ui/src/` に移動しており、`app/src-tauri/tauri.conf.json` には将来的に
Tauri ビルドへ拡張するための雛形を用意しています。

## 制御 API の起動方法

```bash
python -m engine.main --host 0.0.0.0 --port 8080
```

起動すると、アセット列挙やデッキ制御、パニックカード、NDI 入出力などのエンドポイントがプレースホルダーとして
利用可能になります。現時点ではインメモリ状態のみを操作しますが、後続タスクで GStreamer の実配線や
WebSocket 連携を追加していく想定です。

## フロントエンドと同時に開発する場合

```bash
npm run dev
```

リポジトリ直下の `package.json` で UI (`app/ui`) と Python エンジンをまとめて起動しています。
ブラウザから `http://localhost:5173` にアクセスすると、バックエンドは
`http://localhost:8080` / `ws://localhost:8080/realtime` を利用します。

UI 単体で作業する場合は `npm run dev --prefix app/ui` を使用してください。Tauri での実行は
Rust toolchain と `@tauri-apps/cli` を導入した上で `app/src-tauri/tauri.conf.json` を調整し、
`npm run tauri:dev`（開発） / `npm run tauri:build`（ビルド）でデスクトップアプリを起動できます。
Tauri 開発モードでは `scripts/dev_run.sh` が呼ばれ、FastAPI エンジンと Vite が同時に起動するため
`glsl/` や `mp4/` 配下のアセットもブラウザ版と同様に利用できます。
