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
