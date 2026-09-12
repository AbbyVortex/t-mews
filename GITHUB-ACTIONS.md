# GitHub Actions メイン運用

Cloudflareに接続せず、既存のRSSアダプター・分類器・監視処理・Pushover送信を共有するメインの実行環境です。Node.js組み込みSQLiteでD1インターフェイスを置き換え、実行間の状態を `monitor-state` ブランチの `state.json` に保存します。Cloudflare/D1版は切替用として保持します。

現在のRSSは `https://fxtwitter.com/thsottiaux/feed.xml?with_replies=true&count=100`。初回切替時に新しく取得できた返信等は追加baselineとし、過去の通知を一斉に送りません。状態の `fxtwitter-with-replies-v1` に切替基準時刻を記録し、後から届く基準時刻以前の投稿も抑止します。通常の過去投稿・通知台帳はそのままです。[通知方針と日本時間表示](docs/notification-policy.md)、[返信・引用の取得限界](docs/rss-context.md)を参照してください。

## 起動順序

1. publicリポジトリに公開。標準 `ubuntu-24.04` ランナーのみを使用。
2. Settings → Secrets and variables → Actions → New repository secret で `PUSHOVER_USER_KEY` と `PUSHOVER_APP_TOKEN` を登録。
3. Actions → T-MEWS monitor → Run workflow → operation `test`。本物の通知は1件だけ。再実行しても同じテストは再送しません。
4. 同じ画面で `check` を実行してGitHubからのRSS取得を確認。
5. `monitor` を手動実行。初回のRSS全項目をbaselineとして記録し、過去投稿は通知しません。オンライン通知が1件届きます。
6. testの成功を確認してからworkflowのscheduleを `2-57/5 * * * *` として有効化し、repository variable `T_MEWS_ENABLED=true` を設定。

状態ファイルやブランチが消えた場合、通常監視は新規baselineを勝手に作り直さず停止します。テスト操作だけが最初の状態を作成できます。状態を失った際に不用意にtestを再実行しないでください。

## 停止・継続運用

Actions → T-MEWS monitor → メニュー → Disable workflow で停止。repository variable `T_MEWS_ENABLED=false` でも定期監視ジョブを停止できます。実行中のジョブには反映されないため、必要ならその実行もCancelします。

Actions版は終了期限なしで継続します。初期実験のstateテーブルに残る `actionsEndAt` は履歴として保持し、監視の停止条件には使いません。baseline・投稿・通知台帳の初期化や手動移行は不要です。Cloudflare版の `EXPERIMENT_END_AT` は変更していません。

## 無活動による自動停止の予防

GitHubは公開リポジトリで60日間活動がないとscheduleを自動停止します。[公式の停止仕様](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)に対応するため、同じ `T-MEWS monitor` workflowに週1回のkeepaliveを組み込んでいます。

- RSS監視: `2-57/5 * * * *`。毎時02・07・12…57分。
- keepalive: `23 4 * * 1`。毎週月曜04:23 UTC（日本時間13:23）。GitHub側の遅延はあり得ます。
- keepaliveは専用jobで、自分のworkflowが `active` であることをGETで確認したうえで [Enable workflow API](https://docs.github.com/en/rest/actions/workflows#enable-a-workflow) をPUTします。リポジトリへcommitや `state.json` の書き込みを行いません。
- 認証には実行ごとに自動発行される [GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token) を使います。追加Secrets、PATの発行・期限更新、手作業の定期メンテナンスは不要です。専用jobだけに `actions: write` とcheckout用の `contents: read` を与え、Pushover Secretsは渡しません。
- `T_MEWS_ENABLED=false` または空ならkeepaliveを実行しません。workflowが非activeならAPIで復活させません。同じworkflow内にあるため、Disable workflowで監視とkeepaliveをまとめて停止できます。実行中のjobも止めたい場合はCancelしてください。GETとPUTの間に手動停止が入るごく短い競合はAPIの条件付き更新がないため完全には排除できません。
- 各API要求には15秒のtimeout、jobには2分の上限があります。keepaliveが失敗したらGitHub上で失敗として確認でき、次の週に再試行します。5分RSS監視は独立した条件で動くため、keepaliveの成否には依存しません。keepaliveからPushover通知は送りません。
- APIの確認が必要な場合だけ、Run workflowのoperation `keepalive` を選べます。RSS取得・Pushover・状態保存は実行しません。通常運用でこの手動操作は不要です。

有効なworkflowへ事前にenableを呼ぶ方法は [gh-workflow-keepaliveの実装](https://github.com/liskin/gh-workflow-keepalive)でも採用されています。GitHubの公式文書は有効化APIを説明していますが、無活動時計の更新動作を契約的に保証してはいません。本実装は無活動停止の予防であり、既に停止したworkflowやGitHubサービス全体の障害からの自動復旧機構ではありません。導入時のAPI成功確認と、60日を超える実運用実績は区別してください。

## 重複防止と障害

workflow concurrencyで同時実行を直列化。状態更新はGitHub Contents APIのSHAによる条件付き更新で、競合時に上書きしません。

Pushoverへ送る直前に、送信IDを `sending` としてGitHubへ確定保存します。保存に失敗した場合は送信しません。送信結果不明でも自動再送しないため、ネットワーク中断時には通知が欠ける可能性があります。これは重複防止を優先する既存Cloudflare版と同じ方針です。次の実行では `sending` / `unknown` を調査対象として残します。

一時的なRSS障害は無通知。観測上15分以上連続して全ソースが失敗したらofflineを1件、取得復旧時にrecoveredを1件送信します。Actionsの遅延で観測間隔が空くため、障害の継続時間は完全には証明できません。

## 分類ミスによる直近1件の見逃し復旧

通常監視は既に保存した投稿を再分類・再送しません。分類ルールを修正し、その投稿の通知が今も有用だとレビューした場合に限り、Actions → T-MEWS monitor → Run workflow で operation `recover` と `recovery_post_id` に `x:投稿の数字ID` を指定できます。これは公開投稿IDで、秘密情報ではありません。通常運用でこの操作は不要です。

復旧できるのは、初回baselineより後かつ24時間以内に公開された、@thsottiaux の未送信・非baseline投稿1件だけです。旧分類が `IRRELEVANT` / `CANDIDATE`、通知状態が `not_relevant` で、修正後の共通分類器が通知対象と判定する必要があります。repost、日時不明、将来日時、別アカウントのURLは拒否します。

同じ投稿について送信台帳が一度でも作られていれば再送しません。`sent` は送信済みとして終了し、`sending` / `unknown` / `failed` は調査が必要な失敗として終了します。送信前のGitHub永続化、SHAによる競合防止、workflowの直列実行は通常監視と共通です。GitHub保存とPushover送信には別々のタイムアウトを使います。

通知には遅れて送った理由と通知処理時刻を加え、元の投稿時刻と検知遅延を保持します。他の投稿・baseline・過去の通知台帳は変更しません。全件の再通知や自動バックフィルを行う機能ではありません。

## 無料条件と公開範囲

- [GitHub公式料金](https://docs.github.com/en/billing/concepts/product-billing/github-actions): publicリポジトリの標準GitHub-hostedランナーは無料。privateリポジトリでは実行を拒否します。
- 課金対象の大型ランナー、Artifacts、Actions Cache、外部有料APIは使用しません。
- [scheduleの仕様](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule): 最小5分、遅延や混雑時の実行欠落があり得ます。00分を避けても5分以内を保証しません。
- 公開するのはコードとTiboの公開投稿、分類、検知時刻、通知状態。PushoverやGitHubのトークン、メールアドレス、CloudflareアカウントIDは保存しません。
- 実行ログには件数と成否だけを出力。Secretsは送信ステップだけに渡し、pull requestのテストには渡しません。
- 状態の現行本文は約14日で削除しますが、**Gitブランチの過去コミットには履歴が残ります**。公開Tiboデータに限ります。厳密な14日後消去が必要な用途には使いません。

## Cloudflareへ戻すとき

このActions workflowを無効化してから、Cloudflareの `wrangler.local.jsonc` を使って再開します。同時稼働は禁止です。Cloudflareにまだbaselineがない場合は、その時点のRSSをbaselineにして開始するため過去通知は出ません。既に両方で運用歴がある場合は、切替前に通知台帳を移行して重複を防いでください。Actionsのstate.jsonは元のD1スキーマと同じテーブル形式です。
