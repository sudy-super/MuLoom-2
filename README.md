# MuLoom バックエンド作業ログ

## 計画
- [x] パイプライン制御を「状態ストア」として再構築し、GStreamer 依存を分離する。
- [x] 共有状態スナップショット経由で UI が必要とする情報を引き続き公開する。
- [x] 専用のメディア実行アダプタ（GStreamer など）を新設し、状態ストアの差分適用を実装する。
- [ ] 状態ストアとアダプタ間のプロトコルを自動テストで検証する。

## 進捗（2025-10-25）
- `engine/pipeline.Pipeline` を全面的に書き換え、メディア実行は外部アダプタへ委譲しつつデッキや出力の宣言的な状態のみを管理するようにした。
- `EngineState.snapshot()` による API レスポンス構造を維持しながら、デッキやミキサー情報を依存レスで生成できるよう整理した。
- `pytest` をプロジェクト直下で実行できるように `tests/conftest.py` を追加し、最小限のユニットテストを通ることを確認した。
- `engine/runtime/gst_adapter.GStreamerPipelineAdapter` を導入し、Pipeline の差分を GStreamer が利用可能な環境で実パイプラインへ反映させる土台を用意した（非対応環境では安全に無効化）。

## 仕様メモ
- `Pipeline.describe()` は宣言的なグラフ（ソース・出力・シェーダ・ミックス）とデッキごとの状態を返す。GStreamer の有無に関わらず一定のレスポンスが得られる。
- `Pipeline.start()` / `stop()` は単にフラグを切り替える。実際のメディア開始処理は専用アダプタが担当する想定。
- `Pipeline.set_deck_source()` は URI の正規化とリビジョン番号の更新のみを行い、結果は `describe()` の `decks` に即座に反映される。
- シェーダ設定は `ShaderChain` に `ShaderPass` を差し込みつつ、もとの文字列リストも保持するシンプルな構造にした。
- GStreamer アダプタは `playbin` + `fakesink` による簡易再生パイプラインで差分を適用し、将来的な高度化のためのホットスワップ基盤を提供する。

## 次のステップ
- NDI / WebRTC / 録画出力など追加シンクに対応した GStreamer ブランチを段階的に実装する。
- GStreamer を有効化した CI もしくはローカルスモークテストの自動化を検討する。

## 検証
- `pytest`
- GStreamer 環境が整っている場合は `python scripts/demo_gst_adapter.py --uri file:///path/to/video.mp4` を実行し、プログラム出力（自動で `autovideosink` に表示）とプレビュー出力が動作することを目視確認する。

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

起動すると、アセット列挙やデッキ制御、NDI 入出力などのエンドポイントがプレースホルダーとして
利用可能になります。現時点では宣言的な状態ストアが動作し、GStreamer が導入されている環境では
実行アダプタが自動的にシンプルな再生パイプラインを構築します。

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

## GStreamer 実行アダプタの手動検証

ローカルに GStreamer が導入されている場合、以下のスクリプトでエンジン単体の再生確認ができます。

```bash
python scripts/demo_gst_adapter.py --uri file:///absolute/path/to/video.mp4
```

- 複数の `--uri` を並べるとデッキ a/b/c/d に順番に割り当てられます。
- サンプルパターンで試す場合は `--generator smpte` などを指定してください。
- プログラム出力は `autovideosink` に表示され、プレビュー枝は `fakesink` に流れます（ログのみ）。
