(function () {
    'use strict';

    // ============================================================
    // ★ 設定（自環境に合わせて変更してください）
    // ============================================================
    // 【要変更】管理者判定用の組織コード。
    // Kintoneの「組織の設定」で確認できる、管理者組織のコードに書き換えること。
    var ADMIN_ORG_CODE = 'ADMIN_ORG';

    // 【変更可】詳細画面のボタン用スペースの要素ID（フォーム設定と一致させる）
    var SPACE_ID = 'vote_button_space';

    // 【変更可】スマホで強制表示する一覧の名前（アプリの一覧名と一致させる）
    var MOBILE_VIEW_NAME = 'スマホ版簡易一覧';

    // 【変更不要】GASが事前入力URLに埋め込むプレースホルダ（GAS側の定数と対応）
    var ROOM_PLACEHOLDER = '__ROOMNO__';
    var NAME_PLACEHOLDER = '__USERNAME__';
    var ROUTE_PLACEHOLDER = '__ROUTE__';
    var EMAIL_PLACEHOLDER = '__USEREMAIL__';

    // 一般ユーザーに非表示にする管理用フィールド
    var ADMIN_FIELDS = ['form_url_base', 'form_id', 'entry_id', 'answer_log'];

    // ============================================================
    // デザイン定数
    // ============================================================
    var BTN_BASE = [
        'border:none',
        'border-radius:50px',
        'color:#fff',
        'font-weight:bold',
        'font-size:14px',
        'display:inline-flex',
        'align-items:center',
        'justify-content:center',
        'gap:8px',
        'box-shadow:0 4px 8px rgba(0,0,0,.2)',
        'transition:all .3s ease',
        'text-decoration:none',
        'width:240px',
        'padding:12px 0',
        'line-height:1.2',
        'white-space:nowrap',
        'text-shadow:0 1px 2px rgba(0,0,0,.3)'
    ].join(';') + ';';

    var BG_PURPLE = 'background:linear-gradient(135deg,#6c3483,#8e44ad);';
    var BG_GREEN = 'background:linear-gradient(135deg,#0ba360,#3cba92);';
    var BG_GREY = 'background:linear-gradient(135deg,#555,#777);';

    // ============================================================
    // 管理者判定
    // ============================================================
    var _isAdminCache = null;

    async function isAdmin() {
        if (_isAdminCache !== null) return _isAdminCache;
        try {
            var user = kintone.getLoginUser();
            var resp = await kintone.api(
                kintone.api.url('/v1/user/organizations', true), 'GET',
                { code: user.code }
            );
            var orgs = resp.organizationTitles || [];
            _isAdminCache = orgs.some(function (o) {
                return o.organization && o.organization.code === ADMIN_ORG_CODE;
            });
        } catch (e) {
            console.log('Admin check error:', e);
            _isAdminCache = false;
        }
        return _isAdminCache;
    }

    // ============================================================
    // 共通: アプリID取得（PC/モバイル両対応）
    // ============================================================
    function getAppId() {
        var id = null;
        try { id = kintone.app.getId(); } catch (e) { }
        if (!id) {
            try { id = kintone.mobile.app.getId(); } catch (e) { }
        }
        return id;
    }

    // ============================================================
    // レコード情報の取得（answer_log含む）
    // ============================================================
    async function fetchRecordInfo(recordIds) {
        if (recordIds.length === 0) return {};
        var query = '$id in (' + recordIds.join(',') + ')';
        var params = {
            app: getAppId(),
            query: query,
            fields: ['$id', 'survey_title', 'form_url_base', 'status', 'answer_log']
        };
        var map = {};
        try {
            var resp = await kintone.api(kintone.api.url('/k/v1/records', true), 'GET', params);
            resp.records.forEach(function (r) {
                map[r.$id.value] = {
                    title: r['survey_title'] ? r['survey_title'].value : '',
                    url: r['form_url_base'] ? r['form_url_base'].value : '',
                    sts: r['status'] ? r['status'].value : '',
                    answered: isUserAnswered(r['answer_log'])
                };
            });
        } catch (e) { console.log(e); }
        return map;
    }

    /** 氏名・部屋番号の正規化（GAS側 normalizeKeyPart と一致させること） */
    function normalizeKeyPart(s) {
        var str = String(s || '').replace(/\s+/g, '');
        return str.normalize ? str.normalize('NFKC') : str;
    }
    function answerKey(room, name) {
        var r = normalizeKeyPart(room);
        var n = normalizeKeyPart(name);
        if (!r || !n) return '';
        return r + '|' + n;
    }

    /** ログインユーザーの部屋番号（従業員ID）と氏名 */
    function myRoom() { return kintone.getLoginUser().employeeNumber || ''; }
    function myName() { return kintone.getLoginUser().name || ''; }

    /** 回答記録テーブルにログインユーザー（部屋番号＋氏名）の回答があるか */
    function isUserAnswered(answerLogField) {
        if (!answerLogField || !answerLogField.value) return false;
        var myKey = answerKey(myRoom(), myName());
        if (!myKey) return false;
        return answerLogField.value.some(function (row) {
            var room = row.value.ans_room ? row.value.ans_room.value : '';
            var name = row.value.ans_name ? row.value.ans_name.value : '';
            return answerKey(room, name) === myKey;
        });
    }

    /** 事前入力URLに部屋番号・氏名・経路・控えメールを埋め込む（Kintone導線） */
    function buildFormUrl(urlTemplate) {
        if (!urlTemplate) return '';
        var user = kintone.getLoginUser();
        return urlTemplate
            .replace(ROOM_PLACEHOLDER, encodeURIComponent(user.employeeNumber || ''))
            .replace(NAME_PLACEHOLDER, encodeURIComponent(user.name || ''))
            .replace(ROUTE_PLACEHOLDER, encodeURIComponent('Kintone'))
            .replace(EMAIL_PLACEHOLDER, encodeURIComponent(user.email || ''));
    }

    // ============================================================
    // ボタン生成（3状態 + 準備中）
    // ============================================================
    // 優先順位: 回答済み > 受付終了 > 回答する > 準備中
    function createStatusButton(info, userCode, isMobile) {
        var container = document.createElement('div');
        container.style.cssText = 'display:flex;flex-direction:column;align-items:center;'
            + 'justify-content:center;gap:6px;width:100%';

        var statusText = document.createElement('span');
        statusText.style.cssText = 'font-size:11px;font-weight:bold;'
            + 'font-family:"Helvetica Neue",Arial,sans-serif';

        var isClosed = (info.sts === '終了');

        if (info.answered) {
            // === ✅ 回答済み（リンクなし・終了後も維持） ===
            var doneDiv = document.createElement('div');
            doneDiv.style.cssText = BTN_BASE + BG_GREEN + 'cursor:default;';
            doneDiv.innerHTML = '✅ 回答済み';

            statusText.innerText = isClosed ? '回答済み（受付終了）' : 'ご回答ありがとうございました';
            statusText.style.color = '#0ba360';

            container.appendChild(statusText);
            container.appendChild(doneDiv);

        } else if (isClosed) {
            // === ⛔ 受付終了 ===
            var endDiv = document.createElement('div');
            endDiv.style.cssText = BTN_BASE + BG_GREY + 'cursor:not-allowed;box-shadow:none;';
            endDiv.innerHTML = '⛔ 受付終了';

            statusText.innerText = '未回答（受付終了）';
            statusText.style.color = '#555';

            container.appendChild(statusText);
            container.appendChild(endDiv);

        } else if (info.url && info.sts === '受付中') {
            // === 📝 アンケートに回答する ===
            var btn = document.createElement('button');
            btn.style.cssText = BTN_BASE + BG_PURPLE + 'cursor:pointer;';
            btn.innerHTML = '📝 アンケートに回答する';

            var formUrl = buildFormUrl(info.url);
            btn.onclick = function (e) {
                e.stopPropagation();
                if (isMobile) {
                    location.href = formUrl; // モバイルはポップアップブロック回避のため同一タブ
                } else {
                    window.open(formUrl, '_blank');
                }
            };
            btn.onmouseover = function () {
                btn.style.transform = 'translateY(-2px)';
                btn.style.boxShadow = '0 6px 12px rgba(0,0,0,.3)';
            };
            btn.onmouseout = function () {
                btn.style.transform = 'translateY(0)';
                btn.style.boxShadow = '0 4px 8px rgba(0,0,0,.2)';
            };

            statusText.innerText = 'ステータス：未回答';
            statusText.style.color = '#8e44ad';

            container.appendChild(statusText);
            container.appendChild(btn);

        } else {
            // === ⏳ 準備中（URL未設定 or ステータス作成中） ===
            var info2 = document.createElement('span');
            info2.innerText = '⏳ フォーム準備中...';
            info2.style.cssText = 'color:#999;font-size:13px';
            container.appendChild(info2);
        }

        return container;
    }

    // ============================================================
    // 管理者フィールド制御
    // ============================================================
    function hideAdminFields(event, adminFlag) {
        if (adminFlag) return;

        var isMobile = event.type.indexOf('mobile') !== -1;
        ADMIN_FIELDS.forEach(function (fc) {
            try {
                if (isMobile) {
                    kintone.mobile.app.record.setFieldShown(fc, false);
                } else {
                    kintone.app.record.setFieldShown(fc, false);
                }
            } catch (e) { /* setFieldShownが効かないフィールドは無視 */ }
        });

        // テーブル（answer_log）のDOMフォールバック非表示
        setTimeout(function () {
            try {
                document.querySelectorAll(
                    '.field-answer_log, [data-field-code="answer_log"]'
                ).forEach(function (el) { el.style.display = 'none'; });
            } catch (e) { }
        }, 500);
    }

    // ============================================================
    // 案内文表示（ヘッダースペース）
    // ============================================================
    function showGuide() {
        if (document.getElementById('survey-app-guide')) return;
        var space = null;
        try { space = kintone.app.getHeaderSpaceElement(); } catch (e) { }
        if (!space) {
            try { space = kintone.mobile.app.getHeaderSpaceElement(); } catch (e) { }
        }
        if (!space) return;

        var div = document.createElement('div');
        div.id = 'survey-app-guide';
        div.innerHTML = '<div style="padding:15px;background:#fff;border-bottom:2px solid #eee;'
            + 'margin-bottom:15px;font-size:14px;color:#333;line-height:1.8">'
            + '<h2 style="font-size:16px;font-weight:bold;margin:0 0 10px;color:#333">'
            + '📱 アンケートアプリの使い方</h2>'
            + '<div style="background:#fff8e1;color:#856404;padding:10px;border-radius:8px;'
            + 'margin-bottom:15px;font-weight:bold;font-size:13px;border:1px solid #ffeeba">'
            + '⚠️ 回答してもボタンが変わらない場合は画面を '
            + '<a href="javascript:location.reload();" style="text-decoration:underline;color:#856404">'
            + '再読み込み（ここをタップ）</a> してください。<br>'
            + 'それでも変わらない場合は、数分後に再度ご確認ください。</div>'
            + '<div style="margin-bottom:10px">'
            + '<strong>① アンケートに回答する</strong><br>'
            + '<span style="display:inline-flex;background:linear-gradient(135deg,#6c3483,#8e44ad);'
            + 'color:#fff;border-radius:20px;padding:2px 10px;font-weight:bold;font-size:11px;'
            + 'vertical-align:middle">📝 アンケートに回答する</span>'
            + ' ボタンをタップしてください。部屋番号・氏名は自動入力されます（変更しないでください）。</div>'
            + '<div style="margin-bottom:10px">'
            + '<strong>② 回答の控え</strong><br>'
            + 'フォームでメールアドレスを入力すると、回答のコピーがメールで届きます。'
            + '送信後の回答の修正はできませんのでご注意ください。</div>'
            + '<div>'
            + '<strong>③ 回答状況の確認</strong><br>'
            + '回答が完了すると <span style="display:inline-flex;'
            + 'background:linear-gradient(135deg,#0ba360,#3cba92);color:#fff;border-radius:20px;'
            + 'padding:2px 10px;font-weight:bold;font-size:11px;vertical-align:middle">✅ 回答済み</span>'
            + ' 表示に変わります。</div>'
            + '</div>';
        space.appendChild(div);
    }

    // ============================================================
    // モバイル一覧用：カードリスト描画
    // ============================================================
    async function renderMobileCardList(records) {
        var space = null;
        try { space = kintone.mobile.app.getHeaderSpaceElement(); } catch (e) { }
        if (!space) return;

        // 二重描画防止
        var old = document.getElementById('survey-mobile-card-list');
        if (old) old.remove();

        var container = document.createElement('div');
        container.id = 'survey-mobile-card-list';
        container.style.cssText = 'padding:10px;display:flex;flex-direction:column;gap:12px;background:#f4f6f9;';

        var user = kintone.getLoginUser();
        var recordIds = records.map(function (r) { return r.$id.value; });
        var infoMap = await fetchRecordInfo(recordIds);

        records.forEach(function (record) {
            var info = infoMap[record.$id.value];
            if (!info) return;

            var card = document.createElement('div');
            card.style.cssText = 'background:#fff;border-radius:12px;padding:15px;'
                + 'box-shadow:0 2px 6px rgba(0,0,0,0.08);display:flex;'
                + 'flex-direction:column;align-items:center;gap:10px;';

            var title = document.createElement('div');
            title.innerText = info.title || '（無題のアンケート）';
            title.style.cssText = 'font-size:15px;font-weight:bold;color:#333;'
                + 'text-align:center;line-height:1.4;word-break:break-word;';
            card.appendChild(title);

            card.appendChild(createStatusButton(info, user.code, true));
            container.appendChild(card);
        });

        space.appendChild(container);
    }

    // ============================================================
    // 1. 一覧画面の処理
    // ============================================================
    kintone.events.on(
        ['app.record.index.show', 'mobile.app.record.index.show'],
        async function (event) {
            showGuide();

            if (event.type === 'mobile.app.record.index.show') {
                // スマホ版：専用ビューへ強制遷移 → カードリスト描画
                if (event.viewName !== MOBILE_VIEW_NAME) {
                    try {
                        var views = await kintone.api(
                            kintone.api.url('/k/v1/app/views', true), 'GET',
                            { app: kintone.mobile.app.getId() }
                        );
                        var targetView = views.views[MOBILE_VIEW_NAME];
                        if (targetView) {
                            location.href = '/k/m/' + kintone.mobile.app.getId()
                                + '/?view=' + targetView.id;
                            return event;
                        }
                    } catch (e) { }
                }
                await renderMobileCardList(event.records);
                return event;
            }

            // PC版：form_url_base列をボタンに置換
            var elUrls = kintone.app.getFieldElements('form_url_base');
            if (!elUrls) return event;

            var user = kintone.getLoginUser();
            var recordIds = event.records.map(function (r) { return r.$id.value; });
            var infoMap = await fetchRecordInfo(recordIds);

            event.records.forEach(function (record, i) {
                var cell = elUrls[i];
                if (!cell) return;
                cell.style.cssText = 'min-width:250px;width:250px;box-sizing:border-box;'
                    + 'text-align:center;vertical-align:middle';
                cell.innerHTML = '';

                var info = infoMap[record.$id.value];
                if (!info) return;
                cell.appendChild(createStatusButton(info, user.code, false));
            });

            return event;
        }
    );

    // ============================================================
    // 2. 詳細画面の処理
    // ============================================================
    kintone.events.on(
        ['app.record.detail.show', 'mobile.app.record.detail.show'],
        async function (event) {
            var record = event.record;
            var user = kintone.getLoginUser();
            var isMobile = (event.type === 'mobile.app.record.detail.show');
            var adminFlag = await isAdmin();

            hideAdminFields(event, adminFlag);

            // ボタン用スペースを取得
            var spaceEl = null;
            try {
                if (isMobile) {
                    spaceEl = kintone.mobile.app.record.getSpaceElement(SPACE_ID);
                } else {
                    spaceEl = kintone.app.record.getSpaceElement(SPACE_ID);
                }
            } catch (e) {
                console.log('Space element error:', e);
            }
            if (!spaceEl) return event;

            spaceEl.innerHTML = '';
            spaceEl.style.cssText = 'padding:20px 0;text-align:center;display:flex;justify-content:center';

            var info = {
                title: record['survey_title'] ? record['survey_title'].value : '',
                url: record['form_url_base'] ? record['form_url_base'].value : '',
                sts: record['status'] ? record['status'].value : '',
                answered: isUserAnswered(record['answer_log'])
            };

            // URL未設定で管理者の場合は案内を表示
            if (!info.url && adminFlag) {
                var infoText = document.createElement('span');
                infoText.innerText = '⏳ フォーム登録待ち...フォルダにフォームを作成後、最大5分で自動登録されます';
                infoText.style.cssText = 'color:#999;font-size:13px';
                spaceEl.appendChild(infoText);
                return event;
            }

            spaceEl.appendChild(createStatusButton(info, user.code, isMobile));
            return event;
        }
    );

    // ============================================================
    // 3. 編集・作成画面の処理
    // ============================================================
    kintone.events.on(
        ['app.record.edit.show', 'app.record.create.show',
            'mobile.app.record.edit.show', 'mobile.app.record.create.show'],
        async function (event) {
            var adminFlag = await isAdmin();
            hideAdminFields(event, adminFlag);

            // 一般ユーザーはステータス編集不可
            if (!adminFlag) {
                try {
                    event.record.status.disabled = true;
                } catch (e) { }
            }

            return event;
        }
    );
})();
