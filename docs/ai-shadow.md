# T-MEWS AI shadow比較

2026-10-30 JST。main向けのOFF配備版。本人の追加依頼によりコードを本番mainへ反映するが、workflowのT_MEWS_AI_SHADOWは明示的なfalseに固定し、API比較は開始しない。設定・Secrets変更、実API送信は未実施。

## 動作と通知からの分離

Actionsの通常RSS処理、既存ルール分類、Pushover配送、state.jsonの最終保存がすべて終わった後にだけ動く。AI結果を通知ロジックへ戻す経路はない。AIの失敗・残高不足・キー失効・比較台帳の保存失敗は、完了済みの通常処理結果を変更しない。Cloudflare、GAS、Night Watch、Pantry Keeper、通知先、監視時刻、送信前claimと通知台帳を変更しない。

その回で初めて保存されたTibo本人の投稿・返信を対象にする。baseline、既存ID、リポストは対象外。見逃していた意味上の匂わせを試すため、reset語や既存notify判定では対象を絞らない。新しい順に最大2件。上限で見送った投稿や、通常保存後にプロセスが止まった投稿は後追いで課金しない。初回ONや再開時に過去14日分を一括送信しない。

| category | 比較上の意味 |
|---|---|
| announcement | 💣 本人による明確なReset予告・実施、Banked Reset／🍄配布 |
| attention | 🍄 関連する返信・匂わせ・一般言及・否定／延期／訂正。正式な予告やresetの単語は必須にしない |
| unrelated | 利用できる本文・関連情報からReset／配布との関係が認められない |

各結果には短い日本語のrationale、0〜1のconfidence、uncertaintyを含む。confidenceはモデルの自己申告で、校正済みの確率ではない。関連元だけの予告を本人の確定予告にしない。元RSSで取得できない返信先は補完しない。外部検索や追加のX取得は行わない。

## モデルとAPI

既定の実APIモデルIDは `gpt-6-luna`、`reasoning.effort=none`。2026-10-30に[公式モデル資料](https://developers.openai.com/api/docs/models/gpt-6-luna)でID、Responses API、Structured Outputs、none対応を確認した。[Structured Outputsの仕様](https://developers.openai.com/api/docs/guides/structured-outputs)に従い `text.format` にstrict JSON Schemaを指定する。古いmini/nanoの例名は流用しない。

アビーのAPIプロジェクトでのモデルアクセス・付与クレジットの対象／有効期限・実速度は未確認。今回はGETモデル一覧も有料生成も行っていない。Chat Proの契約状態を利用可能性の代用にしない。変更モデルにはResponses＋Structured Outputs＋reasoning none対応が必要で、非対応時はその試行を失敗記録にして終了する。

APIキーは `OPENAI_API_KEY` の実行時環境変数／GitHub Actions Secretのみ。コード、比較台帳、ログへ保存しない。本文は4000文字、既に取得済みの明示関連元は2件各500文字まで。投稿本文は命令として実行しない。`store:false`、ツールなし、会話ID・過去会話の送信なし。

## 試行上限と重複防止

- 1 run最大2試行、UTC日あたり10試行、台帳全体で100試行まで。失敗や受付不明も試行枠を消費する。
- AI段階全体（別台帳の取得・保存を含む）は15秒、API1件は5秒、出力は768 tokenまで。自動リトライなし。既存jobの5分上限・concurrencyは維持。
- API送信前に投稿IDの `claimed` を別台帳へCAS保存する。保存成功後に1回だけ送る。終了すれば `classified` または `failed`。結果保存前の停止はclaimedのまま残り、同じIDは再送しない。
- 台帳は100件以内・256KB上限。自動間引きして再課金することはない。実験上限に達したらAIだけ停止する。通常監視は継続。
- 時間や件数の上限は請求額の保証ではない。モデル料金は選択モデルと実トークン数に依存する。API側で受付済みなら応答タイムアウトでも課金される可能性がある。

401/403は `unauthorized`、429は `quota_or_rate_limit`、5xxは `upstream_error`、400/404は `model_or_request_error`、通信例外は `network_error`、時間超過は `timeout`。不正JSON・型／範囲違い・incompleteは `bad_json`、明示refusalは `refused`。生の応答本文・例外メッセージをログへ出さない。台帳不正／競合／保存不能は `shadow_store_error` としてそのrunのAIだけ終了し、台帳を初期化し直さない。

## 後日、限定比較を開始する手順

今回の反映対象はAIをOFFに固定したコードのみ。以下の比較開始は後日行う。

1. 配備版workflowの `T_MEWS_AI_SHADOW: 'false'` は、GitHubのVariableにかかわらずAIをOFFにする。比較開始を決めた時にだけ、この行を `T_MEWS_AI_SHADOW: ${{ vars.T_MEWS_AI_SHADOW || 'false' }}` へ変更してmainへ反映する。Variable未設定／falseのままならAPI呼出し・比較ファイル作成は0。ローカル実行も環境変数が完全一致のtrueの場合だけON。
2. GitHub Settings → Secrets and variables → Actionsで、Secret `OPENAI_API_KEY` にAPIキーを保存する。キーをチャットへ貼らない。必要ならVariable `T_MEWS_AI_MODEL=gpt-6-luna` を設定（未設定時も同モデル）。APIプロジェクトで利用できるモデル・クレジット適用範囲を確認する。
3. 小さい比較を行う時だけVariable `T_MEWS_AI_SHADOW=true` にする。既存の次回 `monitor` から新規投稿だけを比較。`test`／`check`／`recover`／keepaliveはAIを呼ばない。既存test・baseline・GASトリガーを作り直さない。
4. 最初の数件で比較結果・所要時間・API側使用額を確認し、必要ならOFFへ戻す。実際の分類精度とPushoverに採用する是非は別の判断とする。この実装にはAI通知へ切り替えるスイッチはない。

停止は `T_MEWS_AI_SHADOW=false`（またはVariable削除）。次のrunから追加AI通信なし。実行中の1試行は最大15秒の段階制限内で終了する。通常 `T_MEWS_ENABLED`、GAS、Pushover設定を変更しない。比較台帳を削除して予算・重複防止をリセットしない。

## 比較結果の見方

有効化後は既存 `monitor-state` ブランチの別ファイル `ai-shadow.json` を読む。公開repoの公開ファイルとなる。各行は投稿ID／URL、試行日時（Unix秒）、モデル、入力hash、既存rule分類／notify／display、AI分類／理由／確信度／不確実性、または固定の失敗種別。公開投稿へのリンクで本文を参照し、`rule.notify=false` かつ `result.category=attention` を意味上の見逃し候補として確認できる。AI結果が💣でも通常通知を変更した証拠にはならない。

Actionsログの `aiShadow` はstatusとattempted／classified件数だけ。OFFは追加ログなし。100件の台帳上限は現在のファイルサイズの上限であり、Git履歴の削除を意味しない。

## 検証の区分

自動試験ではAPI・GitHub・Pushoverをモック化。3区分の構造化入出力、設定ON/OFF、文脈の分離、本文上限、重複防止、有限予算、途中停止、各失敗、通常snapshot／Pushover本文の完全一致と処理順序を検証する。

実行結果: 追加21件（単体13・統合8）成功。全454件中453成功・失敗0・既存Windows実機テスト1件skip。TypeScript `tsc --noEmit` 成功。変更前は全433件中432成功・同1件skip。独立読取りレビューでも問題なし。証跡はローカル `work/ai-shadow-20261030/`。

実モデルの意味判定精度、付与クレジット利用、実API速度、GitHub上の比較ファイル保存、自然runでの比較は未検証。既存RSSの掲載遅延や返信先不足を改善したとは扱わない。
