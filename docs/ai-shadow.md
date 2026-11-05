# T-MEWS AI shadow比較

2026-11-06 v2。本人依頼によるSol文脈比較の短期試験。AIはPushoverを変更せず、通常RSS・ルール分類・通知・state.json最終保存の後だけ動く。機械式の独立したBanked分数報告の修正は[通知方針](notification-policy.md)を参照。過去投稿への通知再送は行わない。

## 入力と選択

対象投稿の公開時刻以前72時間から、Tibo本人のReset/Banked関連投稿を最大4件・各700字で抽出。同じBanked話題と原投稿を優先し、選んだ根拠は時刻順に渡す。本文4000字、明示親/引用は2件・各500字。未来の投稿や別人の投稿を本人の履歴にしない。保存済み公開履歴だけで10/31予告→11/1第一弾→2/2を結びつけられる。

本人の先行履歴はrecentContext、実際の返信先/引用はrelatedとして分離する。単に前に投稿されたものを親にしない。返信元本文が欠ける場合のみ、FxTwitter公開v2 APIで対象の明示parent IDを取得し、そのIDの本文を1回取得する。最大2GET・各4秒・全8秒、IDと著者を照合。既取得の親本文なら追加通信なし、既存親IDだけなら1GET。見えない/非公開/失敗/不一致はparentStatusに残し推測しない。通常RSS・通知にはこの取得を加えない。[FxEmbed仕様](https://docs.fxembed.com/api/twitter/operations/2statusid/)

優先順位はReset/Banked関連、原投稿、親本文のある返信、他の返信。同順位は古い発見順。新規候補を最大32件のpendingへ先に保存し、通常1run2件ずつ処理する。新規0件の次runでも続行。72hを過ぎた待ち・queue容量超過はskipped理由を保存（直近100件）、黙って消さない。baseline/リポストは対象外、過去保存済み投稿の一括再課金は行わない。

## モデルと出力

既定model=gpt-6.1-sol、reasoning.effort=medium。Solはnone非対応。環境変数/Actions Variable T_MEWS_AI_MODELとT_MEWS_AI_REASONINGで変更できる。モデルだけgpt-6-lunaにすると既定effortはnone、明示effortがあればそちらを使う。Sol+noneは通信前にinvalid_reasoningとして終了する。

Responses API / strict Structured Outputs / store:false / service_tier:default / toolsなし。返すのはannouncement・attention・unrelated、短い日本語理由・自己申告confidence・不確実性。予告/配布カウンターはannouncement、関連元への反応や匂わせはattention。近くにReset投稿があるだけの「?!」「Can't wait」や親不明の曖昧な短文を関連扱いにしない。

[公式Sol仕様](https://developers.openai.com/api/docs/models/gpt-6.1-sol)と[移行ガイド](https://developers.openai.com/api/docs/guides/latest-model)を2026-11-06に確認。実APIアクセス・精度・速度は保存された実測と区別する。キーはruntime OPENAI_API_KEY/Actions Secretのみ。本文を命令として扱わず、生のAPIエラーやキーを記録しない。

## 期間・予算・復旧

既存monitor-state/ai-shadow.json（v1）は読取り専用で保持し、v2はai-shadow-v2.jsonへ別CAS保存する。既存v1のIDは通常分類し直さない。本人指定の固定評価のみeval:sol-context-v2:で別記録する。

- v2全体20試行まで。固定評価8件・新規投稿・失敗・結果不明claimを全て含む。旧v1件数+v2試行も従来100以内。
- 通常の新規投稿は旧新合計UTC日10試行まで。11/6未明はLunaが既に日10件へ達していたため、今回本人指定の固定評価8件は通常の日枠とは別に実行する。ただし20試行と累計100の両方に全件計上し、通常監視が日枠を超えて追加分類することはない。v2最初の保存から7日で追加通信終了。20件に達しても通常監視は続く。
- 通常1run2件、段階全体120秒、1件45秒、出力4096 token（reasoningを含む）、自動リトライなし。既存job5分は維持。
- 固定評価は2グループ各4件、各段階210秒・job5分。同じt-mews-runtime concurrencyで通常監視/他の評価と直列化。
- pending→claimedを先に確定し、入力証拠を確定保存してからAPIへ。保存失敗時はAPIを送らない。claimed/failedも同IDを自動再送しない。結果保存失敗のclaimは受付不明として残る。
- v2ファイルは1MB以下、records20/pending32/skipped100まで。台帳の削除で予算・重複防止をリセットしない。

401/403、429、5xx、モデル/要求エラー、通信・時間超過、不正JSON、refusal、incompleteを区別し、完了済み通常通知に反映しない。incompleteや不正な最終JSONでもResponsesの有効なusageが取得できれば保持。応答自体を受け取れなければusageは不明であり0扱いしない。

## 計測と見方

recordsには元ID/評価ID、model・実応答model、effort、promptVersion、入力本文/ID/時刻/出典/親欠落理由、inputHash、rule判定、AI結果・失敗、elapsedMsを保存する。usageはinput_tokens/output_tokens/total_tokens/cached_tokens/reasoning_tokens。内部の推論本文は保存しない。

referenceCostUsdは2026-11-06公式Standard単価による参考値。Solは入力$2・キャッシュ入力$0.10・出力$10/100万token、Lunaは$0.10/$0.01/$0.50。output_tokensにはreasoningが含まれるので二重加算しない。実請求・クレジット消費残高・cache write料金/地域加算等まで証明する数字ではない。usage不明の試行を無料と数えない。

旧Luna40件との比較は元postIdで参照し、旧結果を書き換えない。固定8件の本文はtests/fixtures/shadow-evaluation.jsonに出典付きで保持。3正例、2Banked裸本文、3文脈なし対照例を使い、同じ評価IDは再実行しても課金しない。shadow-evaluate workflowはこのfixtureのmain反映時だけ自動実行し、任意の手動実行も既存台帳・予算を共有する。SecretsはGitHub Token/OpenAIだけでPushoverを渡さない。

## 開始・停止・モデル変更

既存Secretsをそのまま使う。T_MEWS_AI_SHADOW=trueで有効、false/削除で次runからOFF。今回の既存ONを維持し、実行ログのmodel/effortも確認する。T_MEWS_ENABLED、GAS、baseline/test台帳は変更不要。

Lunaへ戻すならT_MEWS_AI_MODEL=gpt-6-luna、T_MEWS_AI_REASONINGをnoneまたは未設定にする。モデル変更で20/100/7日をリセットしない。AI通知へ切り替える機能はない。次の試験拡大は今回の結果を再評価してから行う。

## 検証境界

単体/統合試験の外部AI/GitHub/Pushoverは全てモック。本番適用・固定評価の実API成否/usage/料金参考値・自然monitorの台帳保持は、既存Drive KINOKO固定01/02とローカルwork/sol-context-20261106/REPORT.mdに実測として記録する。モック結果を意味判定精度やiPhone実着信の証拠にはしない。
