# vrc-gathering

**VRC Friends Observer** — 自分に公開されているVRChatフレンドの状態とワールドを、PC内へ記録するChrome拡張。

[ダウンロード](https://github.com/Xenoah/vrc-gathering/releases/latest) · [詳しい導入・操作手順](README_ja.md) · [検証状況](VALIDATION.md)

## 機能

- フレンド一覧、接続状態、ステータスメッセージ、公開ワールド／インスタンスの取得。
- 観測時刻付きの変更履歴、検索、状態別フィルター。
- フレンドごとのワールド遷移フローチャート（インスタンス変更・非公開・オフラインを含む）。
- 最新の滞在フレンド数で集計するワールドランキング。
- GAS経由のGoogleスプレッドシート双方向同期（任意設定）。[導入手順](gas/README.md)
- 一覧・変更履歴のCSV出力、アカウントごとの全履歴JSON出力。
- 既定3分間隔、ローカル保存、保存期間の設定。同期有効時は指定のスプレッドシートにも保存。
- 取得間隔のランダム化、レート制御、429のRetry-Afterと指数バックオフ。
- Windowsログオン時のChrome起動用スクリプトを同梱。

## インストール

1. [Releases](https://github.com/Xenoah/vrc-gathering/releases) の `vrc-gathering-v0.2.0.zip` をダウンロードし、固定フォルダーへ展開します。
2. Chromeの `chrome://extensions` で「デベロッパーモード」を有効にします。
3. 「パッケージ化されていない拡張機能を読み込む」から、展開先の **`extension`** フォルダーを選びます。
4. 同じChromeプロファイルで [vrchat.com](https://vrchat.com/home) にログインします。
5. 拡張の「収集設定」にAPI識別用の連絡先を保存し、「収集を開始」を押します。

利用時のコンパイル・npmインストールは不要です。公式サイトのログイン状態をブラウザ経由で利用します。Windowsログオン後、対象のChromeプロファイルが動作している間に収集します。ウィンドウを閉じた後も使う場合は、Chromeのバックグラウンド実行を有効にしてください。

## 取得範囲と制約

取得するのは自分のアカウントから見える情報です。所在非公開はそのまま記録します。定期観測なので、取得間隔の間やPCスリープ中の移動は復元できません。記録はChromeプロファイル内に保存され、拡張・プロファイルの削除で失われるため、必要な履歴はエクスポートしてください。

v0.2.0は個人用の非公式ツールです。**Node.jsの37テストとChromiumでの画面・IndexedDB検証は合格しています。Windows／Chrome拡張としての実機動作、実際のVRChatログイン、および公開済みGASへの接続は未確認です。** 詳細は [VALIDATION.md](VALIDATION.md) に記載しています。

## 開発・配布

利用時の追加依存はありません。開発テストにはNode.js 20以降、ZIP作成にはPython 3を使います。

```sh
npm test
python scripts/package_release.py
```

配布物は `dist/` に作成します。GitHub Actionsはmain／PRでテストし、`v*` タグが付いたコードのバージョン一致を検証して、テストに合格したZIPとSHA-256をリリースへ公開します。

## Googleスプレッドシート連携

[gas/README.md](gas/README.md) に新規作成・GAS公開・同期設定の手順をまとめています。GASのURLと同期キーを拡張に保存すると、収集後・画面表示時・定期実行で変更分を送受信します。通信失敗時もローカル記録を使えます。

ランキングは選択中アカウントの新しい観測だけを集計し、所在非公開や古い観測を除外します。遷移図の矢印は観測順であり、正確な移動時刻を表しません。

開発用の実ブラウザチェックは `python3 tests/browser_smoke.py`（Python Playwrightと `/usr/bin/chromium` が必要）です。同期プロトコルを変更したら `python3 scripts/sync_gas_protocol.py` でGAS側の共通コードも更新してください。
