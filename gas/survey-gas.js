// ============================================================
// アンケート自動化 常設GAS（1本）
// ============================================================
// 【構成】
//   - watchFolder()   : 5分おきの時間トリガーで実行（手動で1回設置）
//       ① 監視フォルダの新フォーム検知 → 初期設定 + トリガー設置 + Kintoneレコード自動作成
//       ② 受付中フォームの回答取りこぼし補修（差分同期）
//       ③ ステータス「終了」検知 → フォーム受付停止 + 送信トリガー削除
//   - onFormSubmit(e) : フォーム送信時に即時実行（watchFolderが自動設置）
//       部屋番号 + 氏名 + 経路 + 日時 を Kintone の回答記録テーブルへ追記
//   - doGet(e)        : QR用の中継ページ（Webアプリ）
//       部屋番号・氏名を入力 → 回答済み照合 → 未回答ならフォームへ転送/回答済みならブロック
//
// 【名寄せ単位】個人ごとに1回（キー = 部屋番号 + 正規化した氏名）
//
// 【初期設定】スクリプトプロパティに以下を設定すること
//   SURVEY_APP_ID  : アンケート管理アプリのID
//   API_TOKEN      : 管理アプリのAPIトークン（閲覧 + 編集 + 追加）
//   SUBDOMAIN      : Kintoneサブドメイン（https://〇〇.cybozu.com の 〇〇 部分）
//   FORM_FOLDER_ID : 監視対象のGoogle DriveフォルダID
//
// 【デプロイ】QR中継ページ(doGet)のため、ウェブアプリとしてデプロイが必要
//   （実行ユーザー: 自分 / アクセス: 全員）。Webhookは使用しない。
// ============================================================

// ---- 質問タイトルと事前入力プレースホルダ ----
var ROOM_QUESTION_TITLE  = '部屋番号';
var ROOM_PLACEHOLDER     = '__ROOMNO__';
var NAME_QUESTION_TITLE  = '氏名';
var NAME_PLACEHOLDER     = '__USERNAME__';
var ROUTE_QUESTION_TITLE = '回答経路（変更しないでください）';
var ROUTE_PLACEHOLDER    = '__ROUTE__';
var EMAIL_QUESTION_TITLE = 'メールアドレス（控えの送信先・任意）';
var EMAIL_PLACEHOLDER    = '__USEREMAIL__';

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
  registerNewForms(config);
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

  form.setAllowResponseEdits(false);    // 回答後の編集は常に不可
  form.setAcceptingResponses(true);
  try { form.setCollectEmail(false); } catch (e) {
    console.warn('[setupForm] メール収集オフ設定に失敗: ' + e);
  }

  // --- システム質問の追加（既存チェック付き） ---
  var roomItem = ensureTextItem(form, ROOM_QUESTION_TITLE,
    'お住まいの部屋番号を入力してください。', true);
  var nameItem = ensureTextItem(form, NAME_QUESTION_TITLE,
    'お名前を入力してください。回答の重複防止に使用します。', true);
  var routeItem = ensureTextItem(form, ROUTE_QUESTION_TITLE,
    '自動入力された項目です。変更・削除しないでください。', false);
  var emailItem = ensureTextItem(form, EMAIL_QUESTION_TITLE,
    '回答の控えメールが不要な場合は空欄にしてください。'
    + '控えが見当たらない場合は迷惑メールフォルダをご確認ください。', false);

  // --- 事前入力URL（プレースホルダ入り）の生成 ---
  var formResponse = form.createResponse();
  formResponse.withItemResponse(roomItem.asTextItem().createResponse(ROOM_PLACEHOLDER));
  formResponse.withItemResponse(nameItem.asTextItem().createResponse(NAME_PLACEHOLDER));
  formResponse.withItemResponse(routeItem.asTextItem().createResponse(ROUTE_PLACEHOLDER));
  formResponse.withItemResponse(emailItem.asTextItem().createResponse(EMAIL_PLACEHOLDER));
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

/** タイトル一致でテキスト質問を取得（なければ作成） */
function ensureTextItem(form, title, helpText, required) {
  var item = findItemByTitle(form, title);
  if (!item) {
    item = form.addTextItem().setTitle(title).setHelpText(helpText).setRequired(required);
  }
  return item;
}

/** タイトル一致でテキスト質問を検索 */
function findItemByTitle(form, title) {
  var items = form.getItems(FormApp.ItemType.TEXT);
  for (var i = 0; i < items.length; i++) {
    if (items[i].getTitle() === title) return items[i];
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

/** 指定フォームの送信トリガーを削除 */
function deleteSubmitTriggers(formId) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'onFormSubmit' && t.getTriggerSourceId() === formId) {
      ScriptApp.deleteTrigger(t);
    }
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
      try {
        repairAnswerLog(config, record, form);
      } catch (e) {
        console.error('[syncAndClose] 補修同期失敗: ' + formId + ' - ' + e);
      }
    } else if (status === '終了') {
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

/** フォームの全回答から、記録テーブルにない分を追記する（部屋番号+氏名キー） */
function repairAnswerLog(config, record, form) {
  var logged = {};
  var rows = (record.answer_log && record.answer_log.value) || [];
  rows.forEach(function (row) {
    var k = answerKey(getRowVal(row, 'ans_room'), getRowVal(row, 'ans_name'));
    if (k) logged[k] = true;
  });

  var missing = [];
  form.getResponses().forEach(function (resp) {
    var info = extractAnswerInfo(form, resp);
    if (!info.key) return;
    if (logged[info.key]) return;
    logged[info.key] = true; // 同一個人の複数回答は最初の1件のみ
    missing.push({ info: info, time: resp.getTimestamp() });
  });

  if (missing.length === 0) return;

  missing.forEach(function (m) {
    rows.push(buildLogRow(m.info, m.time));
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
    var info = extractAnswerInfo(form, e.response);

    if (!info.key) {
      console.error('[onFormSubmit] 部屋番号/氏名が取得できません: form=' + formId);
      return;
    }

    var records = fetchAllRecords(config, '$id, answer_log', 'form_id = "' + formId + '"');
    if (records.length === 0) {
      console.error('[onFormSubmit] 対応レコードなし: form=' + formId);
      return;
    }

    appendAnswerWithRetry(config, records[0].$id.value, info, e.response.getTimestamp());
    console.log('[onFormSubmit] 記録完了: ' + info.key + ' route=' + info.route + ' (form=' + formId + ')');

    try {
      sendCopyEmail(form, e.response);
    } catch (mailErr) {
      console.error('[onFormSubmit] 控えメール送信失敗: ' + mailErr);
    }
  } catch (err) {
    console.error('[onFormSubmit] Error: ' + err + '\n' + (err.stack || ''));
  }
}

/** 回答から部屋番号・氏名・経路・名寄せキーを抽出 */
function extractAnswerInfo(form, formResponse) {
  var room = extractItemValue(form, formResponse, ROOM_QUESTION_TITLE);
  var name = extractItemValue(form, formResponse, NAME_QUESTION_TITLE);
  var route = extractItemValue(form, formResponse, ROUTE_QUESTION_TITLE) || 'QR';
  return { room: room, name: name, route: route, key: answerKey(room, name) };
}

/** 回答から指定タイトルのテキスト質問の値を抽出 */
function extractItemValue(form, formResponse, title) {
  var item = findItemByTitle(form, title);
  if (!item) return '';
  var itemResponse = formResponse.getResponseForItem(item);
  return itemResponse ? String(itemResponse.getResponse()).trim() : '';
}

/** 氏名・部屋番号の正規化（空白除去 + 全半角統一）。両方揃って初めてキー成立 */
function normalizeKeyPart(s) {
  return String(s || '').replace(/\s+/g, '').normalize('NFKC');
}
function answerKey(room, name) {
  var r = normalizeKeyPart(room);
  var n = normalizeKeyPart(name);
  if (!r || !n) return '';
  return r + '|' + n;
}

// ============================================================
// QR中継ページ（Webアプリ）
// ============================================================
function doGet(e) {
  var params = (e && e.parameter) || {};
  var fid = params.fid || '';
  if (!fid) return htmlPage('エラー', '<p>アンケートが指定されていません。</p>');

  var config = getConfig();
  var records = fetchAllRecords(config,
    '$id, survey_title, status, form_url_base, answer_log', 'form_id = "' + fid + '"');
  if (records.length === 0) {
    return htmlPage('エラー', '<p>アンケートが見つかりません。掲示のQRコードをご確認ください。</p>');
  }
  var record = records[0];
  var title = record.survey_title ? record.survey_title.value : 'アンケート';
  var status = record.status ? record.status.value : '';

  if (status !== '受付中') {
    var msg = (status === '終了')
      ? 'このアンケートは受付を終了しました。ご協力ありがとうございました。'
      : 'このアンケートはまだ受付を開始していません。しばらくお待ちください。';
    return htmlPage(title, '<p>' + escapeHtml(msg) + '</p>');
  }

  var room = (params.room || '').trim();
  var name = (params.name || '').trim();

  // 部屋番号・氏名の入力がまだ → 入力ページを表示
  if (!room || !name) {
    return renderInputPage(fid, title, '');
  }

  // 回答済み照合
  var key = answerKey(room, name);
  var answered = false;
  var rows = (record.answer_log && record.answer_log.value) || [];
  rows.forEach(function (row) {
    if (answerKey(getRowVal(row, 'ans_room'), getRowVal(row, 'ans_name')) === key) answered = true;
  });

  if (answered) {
    return htmlPage(title,
      '<div class="done">✅ すでに回答済みです</div>'
      + '<p>この部屋番号・お名前での回答はすでに受け付けています。'
      + 'ご協力ありがとうございました。</p>');
  }

  // 未回答 → フォームURLを生成して転送
  var formUrl = buildPrefilledUrl(record.form_url_base ? record.form_url_base.value : '', room, name, 'QR', '');
  if (!formUrl) {
    return htmlPage(title, '<p>フォームの準備中です。しばらくしてからお試しください。</p>');
  }
  return redirectPage(formUrl);
}

/** 中継ページの form_url_base にQR回答者の値を埋め込む */
function buildPrefilledUrl(template, room, name, route, email) {
  if (!template) return '';
  return template
    .replace(ROOM_PLACEHOLDER, encodeURIComponent(room))
    .replace(NAME_PLACEHOLDER, encodeURIComponent(name))
    .replace(ROUTE_PLACEHOLDER, encodeURIComponent(route))
    .replace(EMAIL_PLACEHOLDER, encodeURIComponent(email || ''));
}

/** 部屋番号・氏名の入力ページ */
function renderInputPage(fid, title, errorMsg) {
  var url = ScriptApp.getService().getUrl();
  var err = errorMsg ? '<p class="err">' + escapeHtml(errorMsg) + '</p>' : '';
  var body =
    '<h2>' + escapeHtml(title) + '</h2>'
    + '<p>回答の前に、お住まいの部屋番号とお名前をご入力ください。<br>'
    + '（回答の重複を防ぐために使用します）</p>'
    + err
    + '<form method="get" action="' + url + '">'
    + '<input type="hidden" name="fid" value="' + escapeHtml(fid) + '">'
    + '<label>部屋番号<br><input type="text" name="room" required inputmode="numeric"></label>'
    + '<label>氏名<br><input type="text" name="name" required></label>'
    + '<button type="submit">アンケートに進む</button>'
    + '</form>';
  return htmlPage(title, body);
}

/** 指定URLへ自動転送するページ */
function redirectPage(formUrl) {
  var safe = JSON.stringify(formUrl);
  var html = '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>アンケートへ移動します</title></head><body style="font-family:sans-serif;text-align:center;padding:40px">'
    + '<p>アンケート画面へ移動します...</p>'
    + '<p><a href=' + safe + '>自動で移動しない場合はこちら</a></p>'
    + '<script>location.href=' + safe + ';</script>'
    + '</body></html>';
  return HtmlService.createHtmlOutput(html)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** 共通HTMLページ */
function htmlPage(title, bodyHtml) {
  var html = '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + escapeHtml(title) + '</title><style>'
    + 'body{font-family:"Helvetica Neue",Arial,sans-serif;background:#f4f6f9;margin:0;padding:24px;color:#333}'
    + '.card{background:#fff;max-width:480px;margin:0 auto;border-radius:16px;padding:28px;box-shadow:0 4px 16px rgba(0,0,0,.1)}'
    + 'h2{font-size:18px;margin:0 0 16px}label{display:block;margin:14px 0;font-weight:bold;font-size:14px}'
    + 'input{width:100%;box-sizing:border-box;padding:12px;margin-top:6px;border:1px solid #ccc;border-radius:8px;font-size:16px}'
    + 'button{width:100%;margin-top:20px;padding:14px;border:none;border-radius:50px;'
    + 'background:linear-gradient(135deg,#6c3483,#8e44ad);color:#fff;font-size:16px;font-weight:bold;cursor:pointer}'
    + '.done{font-size:20px;font-weight:bold;color:#0ba360;text-align:center;margin-bottom:12px}'
    + '.err{color:#e74c3c;font-weight:bold}p{line-height:1.7;font-size:14px}'
    + '</style></head><body><div class="card">' + bodyHtml + '</div></body></html>';
  return HtmlService.createHtmlOutput(html)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// ============================================================
// 控えメール送信
// ============================================================
function sendCopyEmail(form, formResponse) {
  var email = extractItemValue(form, formResponse, EMAIL_QUESTION_TITLE);
  if (!email) return;
  if (email.indexOf('@') === -1) {
    console.warn('[sendCopyEmail] メールアドレスとして不正なためスキップ: ' + email);
    return;
  }

  var systemTitles = {};
  systemTitles[ROOM_QUESTION_TITLE] = 1;
  systemTitles[NAME_QUESTION_TITLE] = 1;
  systemTitles[ROUTE_QUESTION_TITLE] = 1;
  systemTitles[EMAIL_QUESTION_TITLE] = 1;

  var lines = [];
  lines.push('このたびはアンケートにご回答いただき、ありがとうございました。');
  lines.push('以下があなたの回答の控えです。');
  lines.push('');
  lines.push('■ アンケート: ' + form.getTitle());
  lines.push('■ 回答日時: ' + Utilities.formatDate(
    formResponse.getTimestamp(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'));
  lines.push('----------------------------------------');

  formResponse.getItemResponses().forEach(function (itemResponse) {
    var title = itemResponse.getItem().getTitle();
    if (systemTitles[title]) return; // システム質問は控えに含めない
    var answer = itemResponse.getResponse();
    if (Array.isArray(answer)) answer = answer.join('、');
    lines.push('【' + title + '】');
    lines.push(String(answer));
    lines.push('');
  });

  lines.push('----------------------------------------');
  lines.push('※ このメールは自動送信です。送信後の回答の修正はできません。');

  MailApp.sendEmail({
    to: email,
    subject: '【回答控え】' + form.getTitle(),
    body: lines.join('\n')
  });
}

// ============================================================
// 回答記録テーブルの読み書き
// ============================================================

/** revision競合リトライ付きで回答記録テーブルへ追記する（部屋番号+氏名キー） */
function appendAnswerWithRetry(config, recordId, info, timestamp) {
  var maxRetry = 3;
  for (var attempt = 1; attempt <= maxRetry; attempt++) {
    try {
      var resp = kintoneRequest(config, 'GET', '/k/v1/record.json',
        { app: config.appId, id: recordId });
      var record = resp.record;
      var revision = record.$revision.value;
      var rows = (record.answer_log && record.answer_log.value) || [];

      var exists = rows.some(function (row) {
        return answerKey(getRowVal(row, 'ans_room'), getRowVal(row, 'ans_name')) === info.key;
      });
      if (exists) return; // 既に記録済み

      rows.push(buildLogRow(info, timestamp));

      kintoneRequest(config, 'PUT', '/k/v1/record.json', {
        app: config.appId,
        id: recordId,
        revision: revision,
        record: { answer_log: { value: rows } }
      });
      return;
    } catch (err) {
      if (attempt === maxRetry) throw err;
      console.warn('[appendAnswerWithRetry] リトライ ' + attempt + '/' + maxRetry + ': ' + err);
      Utilities.sleep(500 * attempt);
    }
  }
}

/** 回答記録テーブルの1行を生成 */
function buildLogRow(info, timestamp) {
  var iso = Utilities.formatDate(
    timestamp instanceof Date ? timestamp : new Date(),
    'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ssXXX");
  return {
    value: {
      ans_room: { value: info.room },
      ans_name: { value: info.name },
      ans_route: { value: info.route },
      ans_time: { value: iso }
    }
  };
}

/** テーブル行からサブフィールド値を安全に取得 */
function getRowVal(row, code) {
  return (row.value && row.value[code]) ? row.value[code].value : '';
}

/** 回答記録テーブルを丸ごと更新（補修同期用・単一プロセス前提） */
function updateAnswerLog(config, recordId, rows) {
  kintoneRequest(config, 'PUT', '/k/v1/record.json', {
    app: config.appId,
    id: recordId,
    record: { answer_log: { value: rows } }
  });
}

// ============================================================
// Kintone REST API
// ============================================================

/** 管理アプリのレコードを全件取得（500件ずつページング） */
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
function testWatchFolder() { watchFolder(); }

function testConfig() {
  var c = getConfig();
  console.log('appId=' + c.appId + ' subdomain=' + c.subdomain + ' folderId=' + c.folderId);
  console.log('token=' + (c.token ? '設定済み(' + c.token.length + '文字)' : '未設定'));
  console.log('webAppUrl=' + (ScriptApp.getService().getUrl() || '（未デプロイ）'));
}
