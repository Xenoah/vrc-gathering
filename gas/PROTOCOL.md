# 同期プロトコルと保存モデル v2

HTTPのプロトコル、レコードのスキーマ、スプレッドシートの形式を別々にバージョン管理します。将来の機能は名前空間付き拡張項目から追加でき、既存の観測項目・レコードIDを維持できます。正規化・競合解決は `extension/sync-format.js` と、その生成物 `Protocol.gs` で共通です。

## HTTP

GASの `/exec` へPOSTし、`Content-Type: text/plain;charset=UTF-8` のJSONを送信します。キーは本文の `token` のみです。Cookieは送信せず、GETでは記録を返しません。HTTP 200でも本文の `ok` を必ず確認します。

最初に機能とデータセットを確認します。

```json
{"protocol":2,"action":"hello","token":"YOUR_SYNC_TOKEN"}
```

```json
{"protocol":2,"ok":true,"datasetId":"UUID","protocols":[1,2],"recordSchemas":[1,2],"operations":["upsert"],"kinds":["friends","events","worlds","runs","accounts"],"maxBatch":100,"serverTime":1792800000000}
```

以後の要求には `protocol:2`、`token`、`datasetId` を必ず付けます。

| action | 追加する入力 | 正常応答の主要項目 |
| --- | --- | --- |
| `push` | `records`: 最大100件 | `accepted`: 受け付けた件数、`datasetId` |
| `pull` | `cursor`: 0以上の整数、`limit`: 1〜100 | `records`, `cursor`, `hasMore`, `datasetId` |

受信レコードには `revision`（サーバー更新番号）を付けます。カーソルはレコード件数・行番号ではありません。更新・追加で番号を増やし、削除や中断で欠番になっても再利用しません。最後のページはサーバーの現在番号まで進みます。送信はバッチ全体を検証してから書き込みます。GASの途中終了では一部だけ保存される可能性がありますが、同じバッチの再送で回復できます。

`datasetId` は `VRCSchema` に保存され、同一プロジェクトの再デプロイで維持します。別シートやコピーしたシートでは変わります。拡張は変更を検出すると送信済み情報とカーソルをリセットし、端末内の記録から再同期します。**1つのスプレッドシートは1つのGASプロジェクトから更新してください**。複数端末は同じウェブアプリURLを使います。

エラーは `{"protocol":2,"ok":false,"code":"…"}`。`AUTH` はキー不一致、`CONFIG` は設定・列構成不一致、`BUSY` はロック競合、`LIMIT` は容量・バッチ制限、`REQUEST` は要求不正、`SCHEMA` は未対応形式、`DATASET` はデータセット不一致、`MIGRATION` は旧表の移行失敗、`SERVER` はその他のサーバーエラーです。自動再試行は指数バックオフを適用します。拡張は自前の待機期限 `retryAt` とサーバー指定の期限 `serverRetryAt` を区別し、手動同期・接続テストは自前の待機のみ解除できます。接続テストで受け取ったRetry-Afterも同期側へ反映します。

接続診断は保存済み設定でprotocol 2のhelloだけを送ります。クライアント側で権限不足（PERMISSION）、HTML／ログイン応答（PUBLIC_ACCESS）、通信失敗（NETWORK）、非JSON（NON_JSON）も区別します。診断にはHTTPステータス、クエリを除いた最終URL、既知の応答コードのみを保存し、キー・応答本文を含めません。

## レコード

```json
{
  "kind":"worlds",
  "key":"worlds:usr_example0001:wrld_example0001",
  "schemaVersion":2,
  "operation":"upsert",
  "value":{
    "accountId":"usr_example0001",
    "id":"wrld_example0001",
    "observedAt":1792800000000,
    "name":"Sample World",
    "authorName":"Creator",
    "capacity":32,
    "retryAt":1792886400000,
    "extensions":{"example.annotation":{"label":"favorite"}}
  }
}
```

`key` は正規化した値から再計算し、一致しない要求は拒否します。アカウントは観測した所有者、ユーザーIDは観測対象です。同じフレンドでも所有者が違えば別レコードです。

| kind | keyの末尾（先頭は `kind:accountId:`） | 内容 |
| --- | --- | --- |
| friends | ユーザーID | 最新状態・表示名・場所・初回観測・状態の観測開始 |
| events | ユーザーID + `:` + 観測ミリ秒 | `first` / `changed` / `roster-removed`、前後状態・前回観測 |
| worlds | ワールドID | 名前・作者・定員・取得日時 |
| runs | 巡回開始ミリ秒 | 開始／終了時刻・取得／変更数・ページ継続位置 |
| accounts | アカウントID | 所有者の表示名・最終観測 |

観測日時が新しいレコードを優先し、同時刻は正規化JSONの辞書順で決定します。イベントの識別は既存v1と同じです。別端末が同じユーザーを同じミリ秒に異なる状態で記録した場合も、1件へ競合解決します。UUIDへの変更による履歴の二重化を避けるため、この識別規則は維持しています。

`value.extensions` は省略可能です。キーは `example.annotation` のようなドット区切りの名前空間で、JSON値は深さ4・全体8,000文字まで。未知の名前空間もローカル／GASで保持します。観測の優先規則で勝ったレコードの同名名前空間を採用し、そこに存在しない名前空間は以前の値を残します。旧クライアントや通常の収集処理が拡張項目を送らなくても消失しません。名前空間の削除が必要なら明示的な `null` を値にします。

現在の操作は **upsertのみ**。未対応の `schemaVersion` や操作を黙って切り捨てずに拒否します。将来の削除伝播・新しいレコード種別・項目の型変更は、スキーマ更新とhelloの機能通知を追加して導入します。端末内の削除をクラウド全体へ伝播する機能はありません。

## シート

| シート | 用途 | 共通列に追加する列 |
| --- | --- | --- |
| VRCFriends | フレンドの最新状態 | platform, state_first_observed_at_ms, is_friend |
| VRCEvents | 状態・移動の観測履歴 | event_kind, previous_observed_at_ms, previous_world_id, previous_instance_id |
| VRCWorlds | ワールド情報 | author_name, capacity |
| VRCRuns | 巡回の結果 | started_at_ms, completed_at_ms, observed_count, changed_count |
| VRCAccounts | 所有者の表示情報 | なし |
| VRCSchema | 形式・移行情報 | name / value の組 |

共通列は `record_id`, `revision`, `record_kind`, `account_id`, `observed_at_ms`, `display_name`, `presence`, `world_id`, `instance_id`, `world_name`, `payload_json`, `schema_version`, `operation`, `entity_id`, `received_at_ms`, `extensions_json`。日時はUnixミリ秒です。受信時刻と観測時刻を分離しています。

`payload_json` が復元元で、その他の業務列はシート上での閲覧・集計用です。数式になりうる文字列をエスケープします。手編集の同期は未対応です。`VRCSchema` の形式番号・データセットID・移行完了フラグ、行ID・更新番号・JSON列、`SEQ_<datasetId>` プロパティは編集しないでください。5種類の記録の合計上限は50,000件です。

画像、画像取得URL、Cookie、認証トークン、連絡先は同期データから分離します。画像は端末の別IndexedDBストアで管理し、GASの表を肥大化させません。

## v1との移行・互換

- `setup` または認証済み初回リクエストで旧 `VRCRecords` を種類別シートに移行します。レコードID・更新番号を維持し、途中停止後も再実行できます。更新番号の上限も引き継ぐため、旧端末の受信カーソルを維持できます。
- 旧 `VRCRecords` は変更せず残します。移行後は参照用バックアップで、日次整理の対象外です。移行・同期確認後は必要に応じて手動削除してください。移行完了フラグは維持します。
- 新GASはprotocol 1のpush/pullも受け付けます。スキーマ・操作が省略されたv1レコードはupsertとして処理します。
- 新拡張は旧GASが明示的にprotocol 1の `REQUEST` を返した場合のみ互換モードに切り替えます。認証・ネットワークエラーを互換モードで回避しません。旧GASでは新しい名前空間の保持などv2機能は利用できないため、両方のGASファイルを更新してください。
