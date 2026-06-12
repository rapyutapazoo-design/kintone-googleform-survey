# 自環境の設定値控え（テンプレート）

このファイルを `docs/env.local.md` という名前でコピーし、自環境の値を記入してください。
`env.local.md` は `.gitignore` で除外されており、コミットされません。

> ⚠️ APIトークンはこのファイルにも書かないでください（GASのスクリプトプロパティでのみ管理）。

| 項目 | 値 |
|---|---|
| Kintoneサブドメイン | |
| アンケート管理アプリID | |
| Drive監視フォルダID | |
| 管理者組織コード（ADMIN_ORG_CODE） | |
| モバイル用一覧名（MOBILE_VIEW_NAME） | `スマホ版簡易一覧` |
| スペース要素ID（SPACE_ID） | `vote_button_space` |
| GASプロジェクト名 | |

## Kintoneへ適用する際の書き換え箇所

- `kintone/survey-portal.js` の `ADMIN_ORG_CODE` → 自環境の組織コード
