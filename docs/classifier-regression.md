# 分類器の実データ回帰評価

**現在の方針は [通知方針（2026-09-12更新）](notification-policy.md) を参照してください。** 以下は当時の狭い通知方針で行った修正の履歴です。現在は弱いReset言及・技術的Resetも注意報として通知し、fixtureの期待値も新方針へ更新しています。

## 2026-09-12: 稼働後17投稿の追加評価と見逃し修正

baseline後に保存された全17投稿をレビューし、明確な通知対象2件の見逃しを確認しました。残り15件は非通知を維持します。

| 投稿 | 旧分類 | 修正後 | 原因と対応 |
|---|---|---|---|
| [2098612714704891959](https://x.com/thsottiaux/status/2098612714704891959) | IRRELEVANT | RESET_ANNOUNCED | `a reset is also landing by midnight today` の `also` を許容していなかった。明示的なreset到着を表す既存ルールに限り、少数の副詞を許容。Astra全般を利用枠の文脈として扱う変更はしない。 |
| [2097752790177370535](https://x.com/thsottiaux/status/2097752790177370535) | CANDIDATE | BANKED_RESET | Banked Resetの適用失敗と、使用した人へのもう1回の配布が隣接する文に分かれていた。この明確な対応関係を検出。 |

- [稼働後17投稿の固定データと期待値](../tests/fixtures/tibo-new-posts-2026-09-12.json)
- [告知と非告知の追加境界例](../tests/fixtures/announcement-boundaries.json)
- [指定1投稿の復旧・状態保持・送信失敗テスト](../tests/recover.test.ts)

`when I say excellent service for existing users, that includes the occasional reset` は非通知を維持します。親投稿や画像を参照しないと分からない匂わせは、本文だけから推測しません。技術的なreset、否定、質問、希望、条件付きの配布も境界テストで区別します。

今回の長い告知は予告が末尾にあるため、通知本文が上限を超える場合は冒頭と末尾を残して中間を省略します。分類・投稿日時・元の検知遅延も通知に残します。

修正後も通常監視が既存投稿を再分類・再送することはありません。運用者がレビューした24時間以内の非baseline投稿1件だけを復旧するActions操作を追加しました。既に送信を試みた投稿は、結果が不明でも再送しません。今回の復旧対象は9月12日の予告1件で、9月10日の補償配布は過去通知として再送しません。詳細は [Actions運用手順](../GITHUB-ACTIONS.md) を参照してください。

## 2026-09-08: baseline全89投稿の評価

## 評価データと判定方針

`monitor-state` ブランチの初回baselineに保存された @thsottiaux の全89投稿を読み取り、本文・公開URL・公開日時・旧分類だけを固定データへ抽出しました。期待分類と理由は本文を全件読み、人手相当の個別レビューと独立レビューを突き合わせて決めています。分類器の出力から期待値を生成していません。

- [全89件の本文・期待分類・判断理由](../tests/fixtures/tibo-baseline-89.json)
- [合成の境界例](../tests/fixtures/classifier-boundaries.json)
- [回帰テストとActions状態継続テスト](../tests/classifier.test.ts)

fixtureにはPushover情報、GitHub認証情報、アカウント設定、通知台帳を含めていません。公開投稿の固定テストデータであり、本番の `state.json` と同期・書き戻しは行いません。

## 結果

| 指標 | 旧分類器 | 修正後 |
|---|---:|---:|
| 通知対象と判定される投稿 | 12 | 19 |
| レビューで通知対象とした19件の取りこぼし | 8 | 0 |
| レビューで非通知とした70件の誤検知 | 1 | 0 |

修正後は RESET_ANNOUNCED 9件、RESET_HINT 1件、BANKED_RESET 6件、LIMIT_CHANGE 3件、CANDIDATE 6件、IRRELEVANT 64件です。分類自体が変わった投稿は16件です。

これはルール調整に使った89件に対する回帰評価です。未知の投稿への精度を保証する独立評価ではありません。実際の通知件数を表す数値でもなく、baselineの過去投稿は引き続き通知しません。

## 修正した取りこぼし

| 投稿 | 旧分類 | 修正後 | 根拠 |
|---|---|---|---|
| [2090964822422949999](https://x.com/thsottiaux/status/2090964822422949999) | CANDIDATE | BANKED_RESET | Banked Reset到着の明言 |
| [2091412393368945027](https://x.com/thsottiaux/status/2091412393368945027) | IRRELEVANT | RESET_ANNOUNCED | Reset will landと翌日の時刻 |
| [2092058556707344708](https://x.com/thsottiaux/status/2092058556707344708) | CANDIDATE | LIMIT_CHANGE | Plusの5時間制限を復活 |
| [2092345330272780499](https://x.com/thsottiaux/status/2092345330272780499) | IRRELEVANT | LIMIT_CHANGE | 新しいチーム向けプランの5時間制限免除 |
| [2092862554632826968](https://x.com/thsottiaux/status/2092862554632826968) | IRRELEVANT | RESET_HINT | 翌日にreset buttonを探して使う匂わせ |
| [2093014447833116908](https://x.com/thsottiaux/status/2093014447833116908) | IRRELEVANT | RESET_ANNOUNCED | 全ユーザーのusageが新しくなったことを明言 |
| [2093801758665715784](https://x.com/thsottiaux/status/2093801758665715784) | CANDIDATE | RESET_ANNOUNCED | 全有料ユーザーのusage reset。別の節の条件・否定を分離 |
| [2094144275957350900](https://x.com/thsottiaux/status/2094144275957350900) | CANDIDATE | RESET_ANNOUNCED | Codex/ChatGPT Work resetの到着時刻 |

[2091407991736332689](https://x.com/thsottiaux/status/2091407991736332689) のfull reset予告と [2091688655828246890](https://x.com/thsottiaux/status/2091688655828246890) のaccountsへの反映完了は、RESET_HINTからRESET_ANNOUNCEDへ変更しました。

## 誤通知を抑える境界

- [2090675027670978569](https://x.com/thsottiaux/status/2090675027670978569) は、変更を否定しつつ調査と不正利用対策を説明した投稿です。LIMIT_CHANGEからCANDIDATEへ変更しました。
- Astraで通常割当の100%を使えるという案内は、枠の数量・周期・消費率が変わったか不明なためCANDIDATEです。
- 既存Proの20X週次枠と5時間制限免除の説明はCANDIDATEです。新しいプランの免除告知とは区別します。
- reset buttonを贈られたという話だけならCANDIDATEです。使用を示す動詞と未来の時点がある場合に匂わせとして通知します。
- 時刻だけの返信、画像・親投稿を見ないと分からない言及は推測で通知しません。
- 技術的なpassword/database/Git reset、context window、メモリ、API価格、ベンチマークは通知対象から除外します。
- 明示的な否定・質問・調査中の可能性と、確定した変更・本人の強い匂わせを区別します。別の文にある否定や疑問文で明示的な宣言を無効にしません。

## 本番状態の保護

9月8日の変更対象は共有分類器のみです。D1スキーマ、RSS取得、重複照合、通知配送、Actionsの状態保存・Cronには変更を加えていません。

状態継続テストは、全89投稿をbaselineとして保存し、分類ラベルを旧版へ戻した状態から新しいActionsランナーを繰り返し起動します。投稿順序とURLホストを変えても、既存の投稿全カラムと通知台帳が変わらず、過去アラートを送信しないことを照合します。その後、4分類の新規投稿を投入し、各1通知・RESET_ANNOUNCEDだけpriority 1になることを確認します。外部通信はモックし、Pushoverへ実通知は送りません。

今後ルールを変更するときは、実際に見逃した本文と誤通知した本文を期待分類・理由付きで追加し、`pnpm check` と `pnpm test` を実行します。既存baselineの再分類・再通知や、固定fixtureの本番投入は不要です。
