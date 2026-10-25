# 同期プロトコルと保存モデル v2

HTTPのプロトコル、レコードのスキーマ、スプレッドシートの形式を別々にバージョン管理します。将来の機能は名前空間付き拡張項目から追加でき、既存の観測項目・レコードIDを維持できます。正規化・競合解決は `extension/sync-format.js` と、その生成物 `Protocol.gs` で共通です。

## HTTP

GASの `/exec` へPOSTし、`Content-Type: text/plain;charset=UTF-8` のJSONを送信します。キーは本文の `token` のみです。Cookieは送信せず、GETでは記録を返しません。HTTP 200でも本文の `ok` を必ず確認します。

最初に機能とデータセットを確認します。

```json
{"protocol":2,"action":"hello","token":"YOUR_SYNC_TOKEN"}
```

```json
{"protocol":2,"ok":true,"datasetId":"UUID","protocols":[1,2],"recordSchemas":[1,2],"operations":["upsert"],"kinds":["friends","events","worlds","runs","accounts","visits","encounters","profiles","xFollowers","segments","crowd","coverage","followerHistory","annotations","views","reports","userNotes","userNoteHistory"],"features":["changeIntervals","monthlyArchives","rangePull"],"maxBatch":100,"retentionDays":0,"serverTime":1792800000000}
```

以後の要求には `protocol:2`、`token`、`datasetId` を必ず付けます。

| action | 追加する入力 | 正常応答の主要項目 |
| --- | --- | --- |
| `push` | `records`: 最大100件 | `accepted`: 受け付けた件数、`datasetId` |
| `pull` | `cursor`: 0以上の整数、`limit`: 1〜100、`kinds`: helloで確認した記録種別（省略時は従来の5種） | `records`, `cursor`, `hasMore`, `datasetId` |

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
| visits | startedAt | 自分の訪問・状態区間。startedAt / lastSeenAt / endedAt / presence / location |
| xFollowers | Xのハンドル（小文字） | URL・フォロワー数・確認日時・概数の区別・取得元 |
| userNotes | userId | 公式ユーザーノートの最新値と確認日時 |
| userNoteHistory | userId + `:` + changedAt | 公式ノートの本文変化を確認した時点の記録 |
| profiles | ユーザーID | Xプロフィールの確認日時・公開URL（最大5件） |
| encounters | userId + `:` + startedAt | 同席観測区間。visitStartedAt / lastSeenAt / endedAt / relation / location / otherInstanceId |

観測日時が新しいレコードを優先し、同時刻は正規化JSONの辞書順で決定します。イベントの識別は既存v1と同じです。別端末が同じユーザーを同じミリ秒に異なる状態で記録した場合も、1件へ競合解決します。UUIDへの変更による履歴の二重化を避けるため、この識別規則は維持しています。

`value.extensions` は省略可能です。キーは `example.annotation` のようなドット区切りの名前空間で、JSON値は深さ4・全体8,000文字まで。未知の名前空間もローカル／GASで保持します。観測の優先規則で勝ったレコードの同名名前空間を採用し、そこに存在しない名前空間は以前の値を残します。旧クライアントや通常の収集処理が拡張項目を送らなくても消失しません。名前空間の削除が必要なら明示的な `null` を値にします。

現在の操作は **upsertのみ**。未対応の `schemaVersion` や操作を黙って切り捨てずに拒否します。新しいレコード種別はhelloのkindsで通知し、pullのkindsで対応種別を指定します。旧拡張が種別を省略した場合とprotocol 1には従来の5種だけを返します。既存フィールドの型や操作を変える場合にはスキーマの更新が必要です。端末内の削除をクラウド全体へ伝播する機能はありません。

## シート

| シート | 用途 | 共通列に追加する列 |
| --- | --- | --- |
| VRCFriends | フレンドの最新状態 | platform, state_first_observed_at_ms, is_friend |
| VRCEvents | 状態・移動の観測履歴 | event_kind, previous_observed_at_ms, previous_world_id, previous_instance_id |
| VRCWorlds | ワールド情報 | author_name, capacity |
| VRCRuns | 巡回の結果 | started_at_ms, completed_at_ms, observed_count, changed_count |
| VRCAccounts | 所有者の表示情報 | なし |
| VRCVisits | 自分の訪問・状態区間 | started_at_ms, last_seen_at_ms, ended_at_ms |
| VRCEncounters | ユーザーとの重なり | started_at_ms, last_seen_at_ms, ended_at_ms, visit_started_at_ms, relation, other_instance_id |
| VRCProfiles | Xプロフィール確認結果 | x_urls_json |
| VRCXFollowers | Xフォロワー数の最新確認値 | x_url, followers_count, approximate, source |
| VRCSchema | 形式・移行情報 | name / value の組 |

共通列は `record_id`, `revision`, `record_kind`, `account_id`, `observed_at_ms`, `display_name`, `presence`, `world_id`, `instance_id`, `world_name`, `payload_json`, `schema_version`, `operation`, `entity_id`, `received_at_ms`, `extensions_json`。日時はUnixミリ秒です。受信時刻と観測時刻を分離しています。

`payload_json` が復元元で、その他の業務列はシート上での閲覧・集計用です。数式になりうる文字列をエスケープします。手編集の同期は未対応です。`VRCSchema` の形式番号・データセットID・移行完了フラグ、行ID・更新番号・JSON列、`SEQ_<datasetId>` プロパティは編集しないでください。16種類の記録を保存します。主ファイルと各月別ファイルそれぞれ50,000件で区切ります。

Cookie・認証トークン・連絡先・収集設定は同期データから分離します。画像と画像URLは端末内のキャッシュにのみ保存し、同期しません。

## v1との移行・互換

- `setup` または認証済み初回リクエストで旧 `VRCRecords` を種類別シートに移行します。レコードID・更新番号を維持し、途中停止後も再実行できます。更新番号の上限も引き継ぐため、旧端末の受信カーソルを維持できます。
- 旧 `VRCRecords` は変更せず残します。移行後は参照用バックアップで、日次整理の対象外です。移行・同期確認後は必要に応じて手動削除してください。移行完了フラグは維持します。
- 新GASはprotocol 1のpush/pullも受け付けます。スキーマ・操作が省略されたv1レコードはupsertとして処理します。
- 新拡張は旧GASが明示的にprotocol 1の `REQUEST` を返した場合のみ互換モードに切り替えます。認証・ネットワークエラーを互換モードで回避しません。旧GASでは新しい名前空間の保持などv2機能は利用できないため、両方のGASファイルを更新してください。


## 訪問・同席区間（v0.5.0）

`startedAt <= lastSeenAt <= observedAt` を満たします。終了が観測された区間は `endedAt` を持ち、`lastSeenAt <= endedAt <= observedAt` です。終了の確認時刻まで同席時間を延長せず、継続時間には最後に一致した `lastSeenAt` を使います。`observedAt` は終了を含む最終更新の観測時刻で、競合解決と保存期間整理に使います。

`encounters.relation` は `instance` または `world`。`instance` は双方の空でないインスタンスIDの一致が必須です。所在非公開から同席レコードを作りません。レコードの追加はschemaVersion 2の新しい種類として通知し、旧GASへ未対応の種類を送信しません。クライアントが読む種類が増減したらカーソルを0から再確認し、旧カーソルより前にある新しい種類の行を取り逃がさないようにします。

## Xプロフィールと全期間の保存（v0.8.0）

HTTP protocolとrecord schemaは2のまま、hello.kindsにprofilesを追加します。新しいkindの取得を開始するときはカーソルを0に戻します。旧クライアントへ未対応のkindを返しません。

`profiles:<accountId>:<userId>` は確認日時と、明示的に公開された正規化済み `https://x.com/<handle>` を最大5個保存します。URLがなくなった場合も空配列の更新を送信します。画像本体と画像URLはローカルキャッシュ専用で、同期対象に含みません。

送信済み受領情報はレコード内容のSHA-256を保存します。送受信は1要求100件、1回の処理は送信・受信それぞれ最大10バッチ／約120秒で区切り、残りがあれば再開します。

hello.retentionDaysは0（期限なし）または1〜365。pushは期間外の記録も保存し、日次pruneだけが指定された観測履歴の整理を行います。profilesは最新の確認結果として日次の期間削除から除外します。ローカルの保存期間はクラウドの期限と独立しています。


## Xフォロワー数（v0.9.0）

`xFollowers:<accountId>:<handle>` のvalueは `accountId`, `observedAt`, `url`, `followers`, `approximate`, `source`。URLは正規化済みの `https://x.com/<handle>`、followersは0以上の安全な整数、approximateはboolean、sourceは現在 `x-profile` のみです。日時が新しい確認結果を優先し、日次の履歴整理からは除外します。

リンクと数値は別レコードなので、数値の再確認がVRChat公開プロフィールの確認日時を延長することはありません。同じXリンクを持つ複数ユーザーは、所有アカウント内の同じ確認値を参照します。旧クライアントには対応する種類だけ返します。記録形式とHTTPプロトコルは2のままです。


## v0.10.0の確認区間と圧縮

プロトコル・レコードスキーマはv2を維持し、hello.kindsとfeaturesで追加機能を確認します。画像と画像URLは全種類で許可しません。

| kind | 主な内容 | キー末尾（accountIdの後） |
| --- | --- | --- |
| segments | userId、state | collectorId:userId:startedAt |
| crowd | worldId、count、instances、complete | collectorId:worldId:startedAt |
| coverage | outcome、reason、observedUsers、rosterSize、online/web/offline/private/visible | collectorId:collection:startedAt |
| followerHistory | url、followers、approximate、source | collectorId:handle:startedAt |
| annotations | title、start/end、worldId、note、tags、deleted | id |
| views | title、filters、schedule、deleted | id |
| reports | title、viewId、since/until、filters、summary | id |

最初の4種類はstartedAt、lastSeenAt、endedAt、pollSeconds、checks、sampleCount、endReasonを共有します。collectorIdは端末で生成し、設定バックアップには含めません。checksは前の確認からの正のミリ秒差をbase36で表し、ピリオドで連結します。startedAt自体が最初の確認です。空文字なら1回。最終復元時刻はlastSeenAtと一致し、最大1,024時刻・6,000文字です。sampleCountは検証時に再計算します。

値が変わらない観測は同じIDへupsertし、lastSeenAt・observedAt・checksを更新します。状態変化、空白、停止で旧区間を閉じ、必要なら新しいIDで開始します。endedAtは区間を閉じた時刻、滞在の根拠はlastSeenAtまでです。endReasonはchanged/gap/stopped/continued。UTCの月境界・長さ上限はcontinuedとして分割し、失われた確認はありません。

runsは既存のキー形式を保ち、extensionsのvrc.collector.idで発行端末を識別します。同じ巡回結果が続くとvrc.run-seriesにchecksとcountを保存します。checksは各巡回の開始／終了を交互に復元でき、最初の開始はstartedAt、最後の終了はcompletedAtです。v0.10.0の表示・分析・JSON出力はこれを元の巡回へ展開します。旧拡張はこの圧縮を展開できないため、巡回回数を正しく比較するには閲覧端末もv0.10.0以降に更新してください。

worlds.traitsにはtags、platforms（standalonewindows/android/ios。画面ではWindows/Android/iOS）、releaseStatus、visits、favoritesを保持します。新しいスナップショットにtraitsがない場合は既存値を引き継ぎます。画像・パッケージのアセットURLは含みません。

## 月別ファイルと期間取得

VRCArchivesはmonth、spreadsheet_id、rows、max_revision、max_observed_atを持ちます。同月でも50,000行ごとに別ファイルへ分割します。イベント、巡回、訪問、同席、確認区間、フォロワー履歴、レポートが対象です。未終了区間、最新状態、プロフィール、イベントメモ、保存条件は主ファイルに残します。行のIDとrevisionは移動で変更しません。

コピー・flush・索引保存の後で元の行を削除します。再実行はIDとrevisionで重複を確認し、索引保存前の中断も修復します。アーカイブ済みレコードのpush更新も同じ行に適用し、保守的な索引上限を先に保存してから更新します。通常pullは主ファイルと必要なアーカイブの更新番号・時刻列を読み、1ページ分のpayloadだけを読み込みます。pullのsinceは任意の下限で、端末の通常保存期間に使用します。

featuresにrangePullがある場合、別カーソルで次の要求を送れます。

```json
{"protocol":2,"action":"range","datasetId":"UUID","token":"YOUR_SYNC_TOKEN","accountId":"usr_example0001","since":1790000000000,"until":1791000000000,"cursor":0,"limit":100,"kinds":["segments","crowd","coverage","followerHistory","events","runs","visits","encounters","worlds","annotations","views","reports","userNotes","userNoteHistory"]}
```

区間はobservedAtがsince以降、startedAt（なければobservedAt）がuntilより前を候補にします。画面で確認区間を選択期間へ切り詰めます。最新プロフィール・保存条件・メモは時刻制限とは独立です。応答はrecords/cursor/hasMore/datasetId。フィルター前の更新番号でページを進めるため、recordsが空でもhasMoreなら継続してください。条件を変えたらcursor=0に戻します。通常同期のカーソルとは共有しません。

端末はrange応答をarchiveCacheへ保存し、通常の送信対象には加えません。24時間後の整理対象です。GASのRETENTION_DAYSが0以外の場合は日次削除と受信下限が適用され、月別整理が保存期間を延長することはありません。


## 公式ユーザーノート（v0.13.0）

HTTP・レコードスキーマ2、IndexedDBバージョン4を維持し、hello.kindsにuserNotesとuserNoteHistoryを追加します。両方ともresearchストアへ保存します。

valueは `accountId`, `userId`, `observedAt`, `changedAt`, `note`, `noteId`, `createdAt`, `displayName`, `source` です。sourceは `vrchat-user-note` 固定、userIdは対象ユーザー、accountIdはノートを書いたログイン所有者。noteは公式本文をそのまま保持する0〜8,000 UTF-16文字です。空文字は確認済みの未設定を意味し、欠落・nullは受け付けません。noteIdは `unt_...` または未取得の空文字、createdAtは公式作成日時または未取得のnull。個別プロフィールでは本文しか確認できないため、変更時に古いノートID・公式作成日時を推定で引き継ぎません。

observedAtは確認時刻、changedAtは現在の本文を初めて記録した確認時刻です。本文が同じならuserNotesの同じ行のobservedAtのみ更新し、履歴は追加しません。表示名やノートIDの補完も本文変更とは数えません。本文変更時にはuserNotesを更新し、`userNoteHistory:<accountId>:<userId>:<changedAt>` を追加します。公式の編集時刻を表すものではありません。複数端末の同時観測には既存の日時優先・同時刻のcanonical JSON比較を使います。

userNotesはARCHIVE_KINDSに含め、保存期間・pullのsinceから除外します。userNoteHistoryはHISTORY_KINDSに含め、通常の保持期間・月別アーカイブを適用します。最新値が空になったことも日時優先でマージし、古い値の再送で戻しません。APIの取得失敗・ノート一覧にないことだけでは空欄のレコードを生成しません。

公式APIの読み取りはGET /userNotes?n=100&offset=... とGET /users/{userId}。一覧のuserIdが所有者と一致すること、個別応答のidが対象者と一致すること、取得前後のauth/userが同じ所有者であることを確認します。ノートを編集するPOSTは実装しません。APIの生レスポンス・Cookie・画像URLは保存しません。
