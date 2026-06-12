// ============================================================
// アンケート自動化 常設GAS（1本・触らない運用）
// ============================================================
// 【構成】
//   - watchFolder()   : 5分おきの時間トリガーで実行（手動で1回設置）
//       ① 監視フォルダの新フォーム検知 → 初期設定 + トリガー設置 + Kintoneレコード自動作成
//       ② 受付中フォームの回答取りこぼし補修（差分同期）
//       ③ ステータス「終了」検知 → フォーム受付停止 + 送信トリガー削除
//   - onFormSubmit(e) : フォーム送信時に即時実行（watchFolderが自動設置）
//       回答者コード + 日時を Kintone の回答記録テーブルへ追記
//
// 【初期設定】スクリプトプロパティに以下を設定すること
//   SURVEY_APP_ID  : アンケート管理アプリ（47）のID
//   API_TOKEN      : アプリ47のAPIトークン（閲覧 + 編集 + 追加）
//   SUBDOMAIN      : Kintoneサブドメイン（https://〇〇.cybozu.com の 〇〇 部分）
//   FORM_FOLDER_ID : 監視対象のGoogle DriveフォルダID
//
// Webアプリとしてのデプロイは不要。Webhookも使用しない。
// ============================================================

// ---- 定数 ----
var USER_ID_QUESTION_TITLE = 'ユーザーID（変更しないでください）';
var USER_CODE_PLACEHOLDER = '__USERCODE__';
var MASTER_PREFIX = '[マスター]'; // この接頭辞のフォームは登録対象外

// ---- 設定取得 ----
function getConfig() {
  var p = PropertiesService.getScriptProperties();
  var config = {
    appId: p.getProperty('SURVEY_APP_ID'),
    token: p.getProperty('API_TOKEN'),
    subdomain: p.getProperty('SUBDOMAIN'),
    folderId: p.getProperty('FORM_FOLDER_ID')
  };
  if (!config.appId || !config.token || !config.subdomain || !config.folderId) {
    throw new Error('スクリプトプロパティが未設定です: SURVEY_APP_ID / API_TOKEN / SUBDOMAIN / FORM_FOLDER_ID');
  }
  return config;
}

// ============================================================
// メイン: フォルダ監視（5分おきの時間トリガーで実行）
// ============================================================
function watchFolder() {
  var config = getConfig();

  // --- ① 新フォームの検知・登録 ---
  registerNewForms(config);

  // --- ② 受付中フォームの回答補修同期 + ③ 終了検知 ---
  syncAndClose(config);
}

// ============================================================
// ① 新フォーム検知 → 初期設定 + トリガー設置 + レコード作成
// ============================================================
function registerNewForms(config) {
  var folder = DriveApp.getFolderById(config.folderId);
  var files = folder.getFilesByType(MimeType.GOOGLE_FORMS);

  // 登録済み form_id 一覧を取得
  var registered = {};
  fetchAllRecords(config, '$id, form_id', '').forEach(function (r) {
    if (r.form_id && r.form_id.value) registered[r.form_id.value] = true;
  });

  while (files.hasNext()) {
    var file = files.next();
    // ゴミ箱内のファイルはフォルダの子要素として返ってくるため明示的に除外する。
    // （これがないと「フォーム削除＋レコード削除」後に再登録されてしまう）
    if (file.isTrashed()) continue;
    var formId = file.getId();
    if (registered[formId]) continue;
    if (file.getName().indexOf(MASTER_PREFIX) === 0) continue; // マスターは除外

    try {
      setupForm(config, formId, file.getName());
      console.log('[registerNewForms] 登録完了: ' + file.getName() + ' (' + formId + ')');
    } catch (err) {
      console.error('[registerNewForms] 登録失敗: ' + file.getName() + ' - ' + err);
    }
  }
}

/** 新フォームの初期設定・トリガー設置・Kintoneレコード作成 */
function setupForm(config, formId, formName) {
  var form = FormApp.openById(formId);

  // --- フォーム設定（編集不可・メール収集はマスターから引き継ぎ前提で二重担保） ---
  form.setAllowResponseEdits(false);    // 回答後の編集は常に不可
  form.setAcceptingResponses(true);
  try { form.setCollectEmail(true); } catch (e) {
    console.warn('[setupForm] メール収集設定に失敗（マスター設定を引き継いでいれば問題なし）: ' + e);
  }

  // --- ユーザーID質問の追加（既存チェック付き） ---
  var userIdItem = findUserIdItem(form);
  if (!userIdItem) {
    userIdItem = form.addTextItem()
      .setTitle(USER_ID_QUESTION_TITLE)
      .setHelpText('自動入力されたIDです。回答の判定に使用するため、変更・削除しないでください。')
      .setRequired(true);
  }

  // --- 事前入力URL（プレースホルダ入り）の生成 ---
  var formResponse = form.createResponse();
  formResponse.withItemResponse(userIdItem.asTextItem().createResponse(USER_CODE_PLACEHOLDER));
  var prefillUrl = formResponse.toPrefilledUrl();
  var entryId = extractEntryId(prefillUrl);

  // --- 送信トリガーの自動設置（重複チェック付き） ---
  if (!hasSubmitTrigger(formId)) {
    ScriptApp.newTrigger('onFormSubmit').forForm(form).onFormSubmit().create();
  }

  // --- Kintoneレコード自動作成 ---
  kintoneRequest(config, 'POST', '/k/v1/record.json', {
    app: config.appId,
    record: {
      survey_title: { value: formName },
      form_url_base: { value: prefillUrl },
      form_id: { value: formId },
      entry_id: { value: entryId },
      status: { value: '作成中' }
    }
  });
}

/** ユーザーID質問を検索 */
function findUserIdItem(form) {
  var items = form.getItems(FormApp.ItemType.TEXT);
  for (var i = 0; i < items.length; i++) {
    if (items[i].getTitle() === USER_ID_QUESTION_TITLE) return items[i];
  }
  return null;
}

/** 事前入力URLから entry.XXXX を抽出 */
function extractEntryId(prefillUrl) {
  var m = prefillUrl.match(/entry\.(\d+)=/);
  return m ? 'entry.' + m[1] : '';
}

/** 指定フォームの送信トリガーが既にあるか */
function hasSubmitTrigger(formId) {
  return ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'onFormSubmit' && t.getTriggerSourceId() === formId;
  });
}

// ============================================================
// ② 補修同期 + ③ 終了検知（watchFolderから呼び出し）
// ============================================================
function syncAndClose(config) {
  var records = fetchAllRecords(config, '$id, form_id, status, answer_log', 'status in ("受付中", "終了")');

  records.forEach(function (record) {
    var formId = record.form_id ? record.form_id.value : '';
    var status = record.status ? record.status.value : '';
    if (!formId) return;

    var form;
    try {
      form = FormApp.openById(formId);
    } catch (e) {
      console.warn('[syncAndClose] フォームを開けません（削除済み？）: ' + formId);
      return;
    }

    if (status === '受付中') {
      // --- 取りこぼし補修: フォーム回答と回答記録テーブルの差分同期 ---
      try {
        repairAnswerLog(config, record, form);
      } catch (e) {
        console.error('[syncAndClose] 補修同期失敗: ' + formId + ' - ' + e);
      }
    } else if (status === '終了') {
      // --- 受付の自動停止 + トリガー掃除 ---
      try {
        if (form.isAcceptingResponses()) {
          form.setAcceptingResponses(false);
          console.log('[syncAndClose] 受付停止: ' + formId);
        }
        deleteSubmitTriggers(formId);
      } catch (e) {
        console.error('[syncAndClose] 受付停止失敗: ' + formId + ' - ' + e);
      }
    }
  });
}

/** フォームの全回答からユーザーコードを抽出し、記録テーブルにない分を追記する */
function repairAnswerLog(config, record, form) {
  var logged = {};
  var rows = (record.answer_log && record.answer_log.value) || [];
  rows.forEach(function (row) {
    var u = row.value.ans_user ? row.value.ans_user.value : '';
    if (u) logged[u] = true;
  });

  var missing = [];
  form.getResponses().forEach(function (resp) {
    var code = extractUserCode(form, resp);
    if (code && !logged[code]) {
      logged[code] = true; // 同一ユーザーの複数回答は最初の1件のみ
      missing.push({ user: code, time: resp.getTimestamp() });
    }
  });

  if (missing.length === 0) return;

  missing.forEach(function (m) {
    rows.push(buildLogRow(m.user, m.time));
  });
  updateAnswerLog(config, record.$id.value, rows);
  console.log('[repairAnswerLog] 補修 ' + missing.length + '件: record=' + record.$id.value);
}

// ============================================================
// 送信トリガー: 回答の即時記録
// ============================================================
function onFormSubmit(e) {
  try {
    var config = getConfig();
    var form = e.source;
    var formId = form.getId();
    var userCode = extractUserCode(form, e.response);

    if (!userCode) {
      console.error('[onFormSubmit] ユーザーIDが取得できません: form=' + formId);
      return;
    }

    // form_id からレコードを特定
    var records = fetchAllRecords(config, '$id, answer_log', 'form_id = "' + formId + '"');
    if (records.length === 0) {
      console.error('[onFormSubmit] 対応レコードなし: form=' + formId);
      return;
    }
    var record = records[0];

    // 競合に備えてリトライ付きで追記
    appendAnswerWithRetry(config, record.$id.value, userCode, e.response.getTimestamp());
    console.log('[onFormSubmit] 記録完了: ' + userCode + ' (form=' + formId + ')');
  } catch (err) {
    // 失敗しても watchFolder の補修同期が5分以内にリカバリする
    console.error('[onFormSubmit] Error: ' + err + '\n' + (err.stack || ''));
  }
}

/** 回答からユーザーID質問の値を抽出 */
function extractUserCode(form, formResponse) {
  var userIdItem = findUserIdItem(form);
  if (!userIdItem) return '';
  var itemResponse = formResponse.getResponseForItem(userIdItem);
  return itemResponse ? String(itemResponse.getResponse()).trim() : '';
}

/** revision競合リトライ付きで回答記録テーブルへ追記する */
function appendAnswerWithRetry(config, recordId, userCode, timestamp) {
  var maxRetry = 3;
  for (var attempt = 1; attempt <= maxRetry; attempt++) {
    try {
      var resp = kintoneRequest(config, 'GET', '/k/v1/record.json',
        { app: config.appId, id: recordId });
      var record = resp.record;
      var revision = record.$revision.value;
      var rows = (record.answer_log && record.answer_log.value) || [];

      // 既に記録済みならスキップ（重複防止）
      var exists = rows.some(function (row) {
        return row.value.ans_user && row.value.ans_user.value === userCode;
      });
      if (exists) return;

      rows.push(buildLogRow(userCode, timestamp));

      kintoneRequest(config, 'PUT', '/k/v1/record.json', {
        app: config.appId,
        id: recordId,
        revision: revision,
        record: { answer_log: { value: rows } }
      });
      return; // 成功
    } catch (err) {
      if (attempt === maxRetry) throw err;
      console.warn('[appendAnswerWithRetry] リトライ ' + attempt + '/' + maxRetry + ': ' + err);
      Utilities.sleep(500 * attempt);
    }
  }
}

// ============================================================
// 共通ヘルパー
// ============================================================

/** 回答記録テーブルの1行を生成 */
function buildLogRow(userCode, timestamp) {
  var iso = Utilities.formatDate(
    timestamp instanceof Date ? timestamp : new Date(),
    'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ssXXX");
  return {
    value: {
      ans_user: { value: userCode },
      ans_time: { value: iso }
    }
  };
}

/** 回答記録テーブルを丸ごと更新（補修同期用・単一プロセス前提） */
function updateAnswerLog(config, recordId, rows) {
  kintoneRequest(config, 'PUT', '/k/v1/record.json', {
    app: config.appId,
    id: recordId,
    record: { answer_log: { value: rows } }
  });
}

/** アプリ47のレコードを全件取得（500件ずつページング） */
function fetchAllRecords(config, fields, condition) {
  var all = [];
  var offset = 0;
  var limit = 500;
  while (true) {
    var query = (condition ? condition + ' ' : '')
      + 'order by $id asc limit ' + limit + ' offset ' + offset;
    var resp = kintoneRequest(config, 'GET', '/k/v1/records.json', {
      app: config.appId,
      query: query,
      fields: fields.split(',').map(function (f) { return f.trim(); })
    });
    all = all.concat(resp.records);
    if (resp.records.length < limit) break;
    offset += limit;
  }
  return all;
}

/** Kintone REST API呼び出し */
function kintoneRequest(config, method, path, payload) {
  var url = 'https://' + config.subdomain + '.cybozu.com' + path;
  var options = {
    method: method.toLowerCase(),
    headers: { 'X-Cybozu-API-Token': config.token },
    muteHttpExceptions: true
  };

  if (method === 'GET') {
    var params = [];
    Object.keys(payload).forEach(function (key) {
      var v = payload[key];
      if (Array.isArray(v)) {
        v.forEach(function (item, i) {
          params.push(encodeURIComponent(key + '[' + i + ']') + '=' + encodeURIComponent(item));
        });
      } else {
        params.push(encodeURIComponent(key) + '=' + encodeURIComponent(v));
      }
    });
    url += '?' + params.join('&');
  } else {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }

  var resp = UrlFetchApp.fetch(url, options);
  var code = resp.getResponseCode();
  var body = JSON.parse(resp.getContentText() || '{}');
  if (code >= 300) {
    throw new Error('[' + code + '] ' + (body.message || resp.getContentText()));
  }
  return body;
}

// ============================================================
// 手動テスト用
// ============================================================

/** 手動実行: フォルダ監視を1回実行してログを確認する */
function testWatchFolder() {
  watchFolder();
}

/** 手動実行: 設定値の確認 */
function testConfig() {
  var c = getConfig();
  console.log('appId=' + c.appId + ' subdomain=' + c.subdomain + ' folderId=' + c.folderId);
  console.log('token=' + (c.token ? '設定済み(' + c.token.length + '文字)' : '未設定'));
}
