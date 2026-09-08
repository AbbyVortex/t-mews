# GitHub Actions 暫定運用

Cloudflareに接続せず、既存のRSSアダプター・分類器・監視処理・Pushover送信を共有する一時ランナーです。Node.js組み込みSQLiteでD1インターフェイスを置き換え、実行間の状態を `monitor-state` ブランチの `state.json` に保存します。

## 起動順序

1. publicリポジトリに公開。標準 `ubuntu-24.04` ランナーのみを使用。
2. Settings → Secrets and variables → Actions → New repository secret で `PUSHOVER_USER_KEY` と `PUSHOVER_APP_TOKEN` を登録。
3. Actions → T-MEWS monitor → Run workflow → operation `test`。本物の通知は1件だけ。再実行しても同じテストは再送しません。
4. 同じ画面で `check` を実行してGitHubからのRSS取得を確認。
5. `monitor` を手動実行。初回のRSS全項目をbaselineとして記録し、過去投稿は通知しません。オンライン通知が1件届きます。
6. testの成功を確認してからworkflowのscheduleを `2-57/5 * * * *` として有効化し、repository variable `T_MEWS_ENABLED=true` を設定。

状態ファイルやブランチが消えた場合、通常監視は新規baselineを勝手に作り直さず停止します。テスト操作だけが最初の状態を作成できます。状態を失った際に不用意にtestを再実行しないでください。

## 停止・期限

Actions → T-MEWS monitor → メニュー → Disable workflow で停止。repository variable `T_MEWS_ENABLED=false` でも定期監視ジョブを停止できます。実行中のジョブには反映されないため、必要ならその実行もCancelします。

初回監視から5日でRSS取得とPushover送信を自動停止します。期限はstateテーブル内の `actionsEndAt`（UTC Unix秒）。終了後はworkflowも無効化してください。期限後もスケジュールイベント自体は発生し、ジョブは状態を確認して終了します。

## 重複防止と障害

workflow concurrencyで同時実行を直列化。状態更新はGitHub Contents APIのSHAによる条件付き更新で、競合時に上書きしません。

Pushoverへ送る直前に、送信IDを `sending` としてGitHubへ確定保存します。保存に失敗した場合は送信しません。送信結果不明でも自動再送しないため、ネットワーク中断時には通知が欠ける可能性があります。これは重複防止を優先する既存Cloudflare版と同じ方針です。次の実行では `sending` / `unknown` を調査対象として残します。

一時的なRSS障害は無通知。観測上15分以上連続して全ソースが失敗したらofflineを1件、取得復旧時にrecoveredを1件送信します。Actionsの遅延で観測間隔が空くため、障害の継続時間は完全には証明できません。

## 無料条件と公開範囲

- [GitHub公式料金](https://docs.github.com/en/billing/concepts/product-billing/github-actions): publicリポジトリの標準GitHub-hostedランナーは無料。privateリポジトリでは実行を拒否します。
- 課金対象の大型ランナー、Artifacts、Actions Cache、外部有料APIは使用しません。
- [scheduleの仕様](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule): 最小5分、遅延や混雑時の実行欠落があり得ます。00分を避けても5分以内を保証しません。
- 公開するのはコードとTiboの公開投稿、分類、検知時刻、通知状態。PushoverやGitHubのトークン、メールアドレス、CloudflareアカウントIDは保存しません。
- 実行ログには件数と成否だけを出力。Secretsは送信ステップだけに渡し、pull requestのテストには渡しません。
- 状態の現行本文は約14日で削除しますが、**Gitブランチの過去コミットには履歴が残ります**。公開Tiboデータに限ります。厳密な14日後消去が必要な用途には使いません。

## Cloudflareへ戻すとき

このActions workflowを無効化してから、Cloudflareの `wrangler.local.jsonc` を使って再開します。同時稼働は禁止です。Cloudflareにまだbaselineがない場合は、その時点のRSSをbaselineにして開始するため過去通知は出ません。既に両方で運用歴がある場合は、切替前に通知台帳を移行して重複を防いでください。Actionsのstate.jsonは元のD1スキーマと同じテーブル形式です。
