# T-MEWS

Tibo Mushroom Early Warning System。@thsottiaux の公開RSSを確認し、利用枠・リセット関連だけをPushoverへ通知するサービスです。

**メイン運用はGitHub Actionsです。** publicリポジトリの標準ランナーで5分間隔の監視を継続し、週1回のAPI keepaliveで無活動による自動停止を予防します。追加の認証情報やダミーコミットは不要です。[設定・停止方法](GITHUB-ACTIONS.md)を参照してください。毎分実行のCloudflare/D1版も保持し、分類器・RSSアダプター・Pushover送信・監視ロジックを共有します。

## 構成

Cron → RSS/Atomアダプター → D1重複照合 → 決定的な分類 → Pushover。

- TypeScript。RSSはfast-xml-parser、HTMLエンティティはheで処理。
- X API、OpenAI/LLM API、codexradar.com API、ブラウザ常駐、Xアカウントは不使用。
- Workers FreeとD1のみ。Cronは稼働時 `* * * * *`。
- `wrangler.jsonc` は初期状態でCron無効・監視停止。検証後に有効化します。
- `/` は状態ページ、`/status.json` は状態、`/export.json` は検知日基準の過去7日分。

## ソース調査（2026-09-08）

参考: [調査資料](https://github.com/summerchaserwwz/codex-reset-radar/blob/main/docs/superdev/01-research.md)、[構成資料](https://github.com/summerchaserwwz/codex-reset-radar/blob/main/docs/superdev/03-architecture.md)。参考元のソースコードはコピーしていません。

| ソース | 実測 |
|---|---|
| FxTwitter `/thsottiaux/feed.xml` | HTTP 200、RSS解析成功、89件 |
| nitter.net | HTTP 410、空応答 |
| xcancel.com / rss.xcancel.com | HTTP 200だがホワイトリスト申請案内。投稿として扱わない |
| openrss.org/x.com/thsottiaux | HTML。RSSとして不採用 |
| nitter.poast.org | 接続失敗 |
| nitter.tiekoetter.com | HTTP 429、インスタンス利用不可 |
| nitter.space | HTTP 403 |
| rsshub.app/twitter/user/thsottiaux | HTTP 404 |
| rsshub.app/x/user/thsottiaux | HTTP 403、公開デモを本番利用しないよう明記 |

`SOURCES_JSON` は順序付き `{name,url}` 配列です。正常な無料RSSを確認したら末尾へ追加できます。最大5ソース。現在はFxTwitterだけを登録しています。停止中の候補へ無駄な毎分通信を行いません。主系失敗時だけ次のソースを試します。

## 通知と分類

`src/classifier.ts` に正規表現と条件分岐を集約しています。本人のReset言及は広く通知し、確定度と通知要否を分けます。明示予告・実施・Banked配布は「💣リセット予告」、一般言及・弱い匂わせ・条件・否定・技術的Resetや確認できる関連反応は「🍄注意報」。延期・取消・時刻訂正は状態を明示します。既存の利用枠変更通知も維持します。`CANDIDATE` でも通知する場合があるため、内部分類名だけで通知要否を決めません。

予定・期限は根拠のある原文の時区から日本時間へ換算し、不明点は「未確定」と表示します。本人本文と引用・返信先を分離し、親だけに予告がある反応を確定予告にはしません。現在の返信付きFxTwitter RSSは引用IDと短い本文を取得できますが、返信先IDはありません。詳細は [現在の通知方針・時刻換算・実投稿の件数比較](docs/notification-policy.md) と [返信取得の限界](docs/rss-context.md) を参照してください。

初回baselineの全89投稿と稼働後の実投稿を固定した回帰テストで検証しています。[過去の修正記録](docs/classifier-regression.md)を参照してください。分類器の更新で、保存済みの過去投稿を再分類・再通知することはありません。返信付きRSSへ切り替える最初の取得で新たに見える過去返信も、追加baselineとして抑止します。

最初の正常取得は全件を基準データとして同一トランザクションで保存し、オンライン通知だけを送ります。その後に初めて発見した古い投稿でも、公開日時が基準設定以前なら通知しません。別ソースから履歴が流れ込む場合も過去通知を抑えます。

X status ID → 正規URL → 正規化本文と公開日時のSHA-256で重複照合します。D1の一意制約と通知IDの原子的な確保で多重実行でも同じ投稿の再通知を防ぎます。

**配送の限界:** Pushoverの標準APIには冪等キーがありません。送信前に通知IDを確保し、結果が不明でも再送しない方式です。通信中断や送信直前のWorker停止では通知が欠ける可能性があります。`unknown` / `sending` / `failed` を状態ページに表示し、調査できるようにします。送信成功・D1更新の間に停止した場合も再送しません。Pushover受付成功は端末での閲覧保証ではありません。

全ソース失敗開始から15分でofflineを一度だけ通知し、復旧時にrecoveredを一度送ります。短期障害と正常なフォールバックは通知しません。

## D1と無料枠

投稿、送信状態、意味のある障害変化を記録します。取得成功日時・継続障害日時は最大5分ごとの保存で、毎分の単なるポーリング記録は作りません。画面の最終取得時刻は最大約5分遅れます。障害回数は失敗ポーリング数ではなく障害エピソード数です。

本文と観測ログは14日、削除は正常取得時に1日1回。通知IDは本文・秘密を含まない重複防止台帳として保持します。実験終了後に不要ならDBごと削除できます。遅延統計は基準データを除き、公開時刻不明・明らかな未来時刻を除外します。新規観測数は保存期間中、アラート総数は通知台帳全体です。

毎分Cronは1日1,440回。D1への通常の書き込みは5分間隔の短い健康情報と新規投稿が中心です。[Workers Free](https://developers.cloudflare.com/workers/platform/pricing/) は1日100,000リクエスト・CPU 10ms/実行、[D1 Free](https://developers.cloudflare.com/d1/platform/pricing/) は日次500万行読取・10万行書込・合計5GB。上限超過で自動的に有料へ切り替える設定はしません。無料上限はアカウントの他のWorkerとも共有です。

RSSがHTTP 200を返していても、内部キャッシュ遅延や返信の欠落は完全には判定できません。1分Cronは配信から1分以内の検知保証ではありません。3〜5日後にX上の既知の投稿とエクスポートを突き合わせて評価してください。

## Windowsでの開発・保守

Node.jsとpnpmがある環境で `pnpm install --frozen-lockfile`、`pnpm check`、`pnpm test`、`pnpm probe`。`pnpm dev` の `/__scheduled` はWranglerローカル専用です。本番には監視を実行する公開HTTPエンドポイントを設けません。

`pnpm simulate` は実RSSを一度取得し、外部通信をモックしたローカルworkerdでscheduledハンドラーを2回実行します。保存したRSSを使う場合は `pnpm simulate path/to/feed.xml`。確認結果は `work/simulation.json`、状態ページのローカルHTMLは `work/status-preview.html` に出力します。

Cloudflareの個別アカウント情報はGit管理外の `wrangler.local.jsonc` に保存します。新しい環境では `wrangler.jsonc` をコピーし、ローカルファイルにだけaccount_idとdatabase_idを設定してください。`pnpm deploy` はこのローカル設定を使います。公開リポジトリには個別の配置記録を含めません。

Pushoverの `PUSHOVER_USER_KEY` と `PUSHOVER_APP_TOKEN` はWorker secretsだけに保存します。`.dev.vars`、ソース、D1、ログへ書きません。専用PowerShell入力スクリプトは非表示で入力を受け、Wranglerの標準入力へ渡します。チャットへ貼り付けないでください。

## 即時停止

GitHub Actions版は Actions → T-MEWS monitor → メニュー → **Disable workflow** で監視とkeepaliveを同時に停止します。実行中のjobには必要に応じてCancelも行ってください。以下はCloudflare版へ切り替えた場合の操作です。

Cloudflare → Workers & Pages → t-mews → Settings → Variables and Secrets で `MONITOR_ENABLED` を `false` にし、保存・反映します。Cron自体を停止する場合は Settings → Triggers → Cron Triggers から毎分の式を削除します。ローカルの `wrangler.jsonc` も同じ状態にして、再デプロイで復活しないようにしてください。

実験開始時には `EXPERIMENT_END_AT` を5日後のUTC日時へ設定します。その時刻以降はRSS取得・通知を停止します。Cron設定の自動削除は行わないため、実験後にCronも削除してください。再開時は期限と `MONITOR_ENABLED` の両方を更新します。
