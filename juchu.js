/* 守澤 発注アプリ　受注・在庫の画面
 * つなぎ先は「受注書」スプレッドシート（config.js の JUCHU_API_URL）。
 * 掛け率はスプレッドシートの中だけで計算し、このアプリには届きません（単価だけが届きます）。
 */
(function () {
  'use strict';
  const M = window.MZ;
  const { $, esc, norm, yen, store, toast, busy, modal } = M;
  const BASE = (window.APP_CONFIG && window.APP_CONFIG.JUCHU_API_URL) || '';
  const NOT_READY = '受注書のつなぎ先がまだ入っていません。<br>設定がすむまで、受注と在庫は使えません。';
  const get = (a, p) => M.jsonFrom(BASE, a, p);
  const post = (a, b) => M.postTo(BASE, a, b);

  // ---------- お客様・商品の一覧（スマホの中に保存） ----------
  let customers = []; // {code, name, staff, s}
  let jproducts = []; // {code, maker, name, s}
  async function loadLocal() {
    try {
      const c = await M.idb.get('jcustomers'); if (c) customers = prepC(c);
      const p = await M.idb.get('jproducts'); if (p) jproducts = prepP(p);
    } catch (e) {}
    showInfo();
  }
  const prepC = (list) => list.map((r) => ({ code: String(r[0]), name: r[1], staff: r[2], s: norm(r[0] + ' ' + r[1]) }));
  const prepP = (list) => list.map((r) => ({ code: String(r[0]), maker: r[1], name: r[2], s: norm(r[0] + ' ' + r[2] + ' ' + r[1]) }));
  let loading = null;
  function ensureLists(force) {
    if (!BASE) return Promise.resolve(false);
    if (!force && customers.length && jproducts.length) return Promise.resolve(true);
    if (loading) return loading;
    loading = (async () => {
      busy(true, 'お客様と商品の一覧を読み込んでいます…');
      try {
        const [c, p] = await Promise.all([get('customers'), get('products')]);
        customers = prepC(c.list); jproducts = prepP(p.list);
        await M.idb.set('jcustomers', c.list); await M.idb.set('jproducts', p.list);
        store.set('jDataDate', new Date().toLocaleString('ja-JP'));
        showInfo();
        return true;
      } catch (e) { toast(e.message, 3500); return false; }
      finally { busy(false); loading = null; }
    })();
    return loading;
  }
  function showInfo() {
    const el = $('jDataInfo'); if (!el) return;
    el.textContent = !BASE ? '受注書のつなぎ先：まだ設定されていません'
      : (jproducts.length ? '受注用：お客様 ' + customers.length.toLocaleString('ja-JP') + ' 件・商品 ' + jproducts.length.toLocaleString('ja-JP') + ' 品目（' + (store.get('jDataDate', '') || '日時不明') + ' に取り込み）'
        : '受注用の一覧：まだ取り込んでいません');
  }

  function findCustomers(q) {
    const t = norm(q); if (!t) return [];
    const exact = customers.filter((c) => norm(c.code) === t);
    const words = t.split(' ');
    const rest = customers.filter((c) => exact.indexOf(c) < 0 && words.every((w) => c.s.indexOf(w) >= 0));
    return exact.concat(rest).slice(0, 30);
  }
  function findProducts(q) {
    const t = norm(q); if (!t) return [];
    let exact = [];
    if (/^\d{1,5}$/.test(t)) { const code = t.padStart(5, '0'); exact = jproducts.filter((p) => p.code === code); }
    const words = t.split(' ');
    const rest = jproducts.filter((p) => exact.indexOf(p) < 0 && words.every((w) => p.s.indexOf(w) >= 0));
    return exact.concat(rest).slice(0, 40);
  }
  function pickHtml(list, kind) {
    if (!list.length) return '<li class="none">見つかりませんでした</li>';
    return list.map((x, i) => kind === 'c'
      ? '<li data-i="' + i + '"><b>' + esc(x.name) + '</b><br><small>コード ' + esc(x.code) + (x.staff ? '　担当 ' + esc(x.staff) : '') + '</small></li>'
      : '<li data-i="' + i + '"><b>' + esc(x.name) + '</b><br><small>' + esc(x.code) + '　' + esc(x.maker) + '</small></li>').join('');
  }
  function picker(input, listEl, finder, kind, onPick) {
    let hits = [], t = null;
    const run = () => { const q = input.value; if (!q.trim()) { listEl.innerHTML = ''; return; } hits = finder(q); listEl.innerHTML = pickHtml(hits, kind); };
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 200); });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      run(); if (hits.length === 1) { onPick(hits[0]); input.value = ''; listEl.innerHTML = ''; input.blur(); }
    });
    listEl.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-i]'); if (!li) return;
      onPick(hits[Number(li.dataset.i)]); input.value = ''; listEl.innerHTML = '';
    });
  }

  // ---------- 受注の下書き ----------
  let draft = store.get('juchuDraft', { customer: null, lines: [] });
  let quote = null, quoteSeq = 0;
  function save() { store.set('juchuDraft', draft); badge(); }
  function badge() { const b = $('juchuBadge'); b.textContent = draft.lines.length; b.classList.toggle('hidden', !draft.lines.length); }

  function renderCustomer() {
    const c = draft.customer;
    $('jCustBox').classList.toggle('hidden', !!c);
    $('jCustSel').classList.toggle('hidden', !c);
    if (c) $('jCustSel').innerHTML = '<div class="who"><b>' + esc(c.name) + '</b><br><small>コード ' + esc(c.code) + '　守澤の担当：' + esc(c.staff || '（未登録）') + '</small></div><button class="ghost" id="jCustChange">変える</button>';
  }
  function lineCalc(i) {
    if (!quote || !quote.lines[i] || quote.lines[i].code !== draft.lines[i].code || quote.lines[i].qty !== draft.lines[i].qty) return '<div class="calc"><span class="hint" style="margin:0">計算中…</span></div>';
    const q = quote.lines[i];
    if (!q.found) return '<div class="calc"><span class="tag ng">この商品コードは見つかりません</span></div>';
    const short = Math.max(0, q.qty - q.stock);
    const tag = short === 0 ? '<span class="tag ok">在庫あり（' + q.stock + '）</span>'
      : (q.stock > 0 ? '<span class="tag ng">在庫' + q.stock + '・不足' + short + '</span>' : '<span class="tag ng">在庫なし・要発注' + short + '</span>');
    return '<div class="calc"><span>単価 ' + yen(q.price) + '　金額 <b>' + yen(q.amount) + '</b></span>' + tag + '</div>';
  }
  function renderLines() {
    $('jLinesEmpty').classList.toggle('hidden', draft.lines.length > 0);
    $('jLines').innerHTML = draft.lines.map((l, i) =>
      '<div class="jline" data-i="' + i + '">' +
        '<div class="name">' + esc(l.name) + '</div>' +
        '<div class="meta">' + esc(l.code) + '　' + esc(l.maker) + '</div>' +
        '<div class="row"><div class="qty"><button data-act="minus">−</button><input type="number" inputmode="numeric" min="1" value="' + l.qty + '"><button data-act="plus">＋</button></div>' +
        '<button class="del" data-act="del">とりけす</button></div>' +
        (draft.customer ? lineCalc(i) : '') +
      '</div>').join('');
    renderTotals();
  }
  function renderTotals() {
    const box = $('jTotals');
    const fresh = quote && draft.customer && draft.lines.length && quote.lines.length === draft.lines.length &&
      quote.lines.every((q, i) => q.code === draft.lines[i].code && q.qty === draft.lines[i].qty);
    if (!fresh) { box.classList.add('hidden'); return; }
    const shorts = quote.lines.filter((q) => q.found && q.qty > q.stock).length;
    box.classList.remove('hidden');
    box.innerHTML = '<table class="totals"><tr><td>小計</td><td>' + yen(quote.subtotal) + '</td></tr>' +
      '<tr><td>消費税（10%）</td><td>' + yen(quote.tax) + '</td></tr>' +
      '<tr class="sum"><td>合計</td><td>' + yen(quote.total) + '</td></tr></table>' +
      (shorts ? '<p class="hint">在庫が足りない商品が ' + shorts + ' 品目あります。確定すると「要発注」に入ります。</p>' : '');
  }
  let qt = null;
  function requote() {
    clearTimeout(qt);
    if (!draft.customer || !draft.lines.length || !BASE) { quote = null; renderTotals(); return; }
    qt = setTimeout(async () => {
      const seq = ++quoteSeq;
      try {
        const r = await post('quote', { customer: draft.customer.code, items: draft.lines.map((l) => ({ code: l.code, qty: l.qty })) });
        if (seq !== quoteSeq) return;
        quote = r; renderLines();
      } catch (e) { if (seq === quoteSeq) toast(e.message, 3500); }
    }, 500);
  }
  function changed() { save(); renderLines(); requote(); }

  async function confirmOrder() {
    if (!BASE) { modal('<p>' + NOT_READY + '</p>'); return; }
    if (!draft.customer) { toast('お客様を選んでください'); $('jCustQ').focus(); return; }
    if (!draft.lines.length) { toast('商品を入れてください'); $('jProdQ').focus(); return; }
    const staff = $('jStaff').value.trim();
    if (!staff) { toast('守澤商店の担当者を入れてください'); $('jStaff').focus(); $('jStaff').scrollIntoView({ block: 'center' }); return; }
    const orderer = $('jOrderer').value.trim();
    if (!orderer) { toast('入力した人の名前を入れてください'); $('jOrderer').focus(); return; }
    store.set('orderer', orderer);
    if (quote && quote.lines.some((q) => !q.found)) { toast('見つからない商品コードがあります。とりけしてください', 3500); return; }
    const c = draft.customer;
    modal('<h2>この内容で受注を確定しますか？</h2><p><b>' + esc(c.name) + '</b>（' + esc(c.code) + '）</p>' +
      '<p>守澤商店 担当者：<b>' + esc(staff) + '</b></p><p>' + draft.lines.length + '品目' + (quote ? '　合計 <b>' + yen(quote.total) + '</b>（税込）' : '') + '</p>' +
      '<p class="hint">確定すると在庫から引かれます。</p>', [
      { label: '確定する', primary: true, onClick: async () => {
        busy(true, '受注を保存しています…');
        try {
          const r = await post('order', { customer: c.code, staff, orderer, note: $('jNote').value.trim(),
            items: draft.lines.map((l) => ({ code: l.code, qty: l.qty })) });
          draft = { customer: null, lines: [] }; quote = null; $('jNote').value = ''; $('jStaff').value = ''; save(); renderCustomer(); renderLines();
          busy(false);
          modal('<h2 class="ok">受注を保存しました</h2><p>受注番号 <b>' + esc(r.no) + '</b><br>' + esc(c.name) + '　' + r.count + '品目　合計 ' + yen(r.total) + '</p>' +
            (r.shortCount ? '<p><span class="tag ng">在庫が足りない商品 ' + r.shortCount + ' 品目</span><br><span class="hint">「在庫」→「要発注」に入りました。</span></p>' : '<p><span class="tag ok">すべて在庫から出せます</span></p>') +
            '<p class="hint">受注書は「履歴」→「お店からの受注」からいつでも出せます。</p>', [
            { label: '受注書（PDF）を作る', keep: true, onClick: (btn) => M.openPdf(r.no, btn, BASE, '受注書') },
            { label: '閉じる' },
          ]);
        } catch (e) { busy(false); modal('<h2>確定できませんでした</h2><p>' + esc(e.message) + '</p><p class="hint">入力した内容はそのまま残っています。</p>'); }
      } },
      { label: 'やめる' },
    ]);
  }

  // ---------- 受注の履歴 ----------
  async function loadHistory() {
    const box = $('histJuchu');
    if (!BASE) { box.innerHTML = '<li class="empty">' + NOT_READY + '</li>'; return; }
    box.innerHTML = '<li class="empty">読み込み中…</li>';
    try {
      const r = await get('history', { limit: 50 });
      if (!r.orders.length) { box.innerHTML = '<li class="empty">まだ受注の履歴はありません。</li>'; return; }
      box.innerHTML = r.orders.map((o) =>
        '<li class="card hcard" data-no="' + esc(o.no) + '">' +
          '<div class="head"><div><div class="no">' + esc(o.no) + '</div><div class="sup">' + esc(o.name) + '</div></div>' +
          '<div class="meta" style="text-align:right">' + esc(o.date) + '<br>担当 ' + esc(o.staff || '—') + '<br>' + o.items.length + '品目　' + yen(o.total) + '（税抜）</div></div>' +
          '<div class="items">' + o.items.map((it) => '<div class="it"><span>' + esc(it.name) + '<br><small>' + esc(it.code) + '　' + esc(it.price) + '円　' + esc(it.judge) + '</small></span><b>' + esc(it.qty) + '</b></div>').join('') +
          (o.note ? '<p class="hint">備考：' + esc(o.note) + '</p>' : '') + '</div>' +
          '<div class="btns"><button class="ghost" data-act="toggle">中身を見る</button><button class="ghost" data-act="pdf">受注書（PDF）</button></div>' +
        '</li>').join('');
    } catch (e) { box.innerHTML = '<li class="empty">' + esc(e.message) + '</li>'; }
  }

  // ---------- 在庫 ----------
  let stockCache = [], stockSel = null;
  async function loadStock() {
    const box = $('stockList');
    if (!BASE) { box.innerHTML = '<li class="empty">' + NOT_READY + '</li>'; return; }
    box.innerHTML = '<li class="empty">読み込み中…</li>';
    try { stockCache = (await get('stock')).list; renderStock(); }
    catch (e) { box.innerHTML = '<li class="empty">' + esc(e.message) + '</li>'; }
  }
  function renderStock() {
    const words = norm($('sFilter').value).split(' ').filter(Boolean);
    const list = stockCache.filter((s) => { const t = norm(s.code + ' ' + s.name + ' ' + s.place); return words.every((w) => t.indexOf(w) >= 0); });
    $('stockList').innerHTML = !stockCache.length ? '<li class="empty">まだ在庫は入っていません。<br>上の「在庫数を入れる」から、よく出る商品を入れてください。</li>'
      : (!list.length ? '<li class="empty">見つかりませんでした</li>'
      : list.map((s) => '<li class="card scard" data-code="' + esc(s.code) + '"><div><div class="name">' + esc(s.name) + '</div>' +
        '<div class="meta">' + esc(s.code) + (s.place ? '　置き場所 ' + esc(s.place) : '') + (s.date ? '<br>' + esc(s.date) + ' 更新' : '') + '</div></div>' +
        '<div class="q' + (Number(s.qty) > 0 ? '' : ' zero') + '">' + esc(s.qty) + '</div></li>').join(''));
  }
  function selectStock(p) {
    const cur = stockCache.find((s) => s.code === p.code);
    stockSel = p;
    $('sForm').classList.remove('hidden');
    $('sSel').innerHTML = '<div class="who"><b>' + esc(p.name) + '</b><br><small>' + esc(p.code) + '　' + esc(p.maker || '') + (cur ? '　いまの在庫 ' + esc(cur.qty) : '　（まだ在庫表にありません）') + '</small></div>';
    $('sQty').value = cur ? cur.qty : '';
    $('sPlace').value = cur ? cur.place : '';
    $('sQty').focus();
  }
  async function saveStock() {
    if (!stockSel) return;
    const qty = $('sQty').value.trim();
    if (qty === '' || !(Number(qty) >= 0)) { toast('在庫数を0以上の数字で入れてください'); return; }
    busy(true, '保存しています…');
    try {
      await post('stockSet', { code: stockSel.code, qty: Number(qty), place: $('sPlace').value.trim() });
      toast('保存しました'); stockSel = null; $('sForm').classList.add('hidden');
      busy(false); loadStock();
    } catch (e) { busy(false); toast(e.message, 3500); }
  }
  async function loadNeeds() {
    const box = $('needsList');
    if (!BASE) { box.innerHTML = '<li class="empty">' + NOT_READY + '</li>'; return; }
    box.innerHTML = '<li class="empty">読み込み中…</li>';
    try {
      const list = (await get('needs')).list;
      box.innerHTML = !list.length ? '<li class="empty">要発注の商品はありません。</li>'
        : list.map((n) => '<li class="card scard"><div><div class="name">' + esc(n.name) + '</div>' +
          '<div class="meta">' + esc(n.code) + '　' + esc(n.maker) + '<br>' + esc(n.customer) + '　' + esc(n.no) + '<br>' + esc(n.date) + '　<span class="tag ' + (n.state === '発注済み' ? 'gray' : 'ng') + '">' + esc(n.state || '未発注') + '</span></div></div>' +
          '<div class="q zero">' + esc(n.qty) + '</div></li>').join('') +
          '<li class="hint center">「発注済み」「入荷済み」は、スプレッドシートの「要発注」シートで切りかえます。</li>';
    } catch (e) { box.innerHTML = '<li class="empty">' + esc(e.message) + '</li>'; }
  }
  function showStockKind(kind) {
    store.set('stockKind', kind);
    document.querySelectorAll('#stockSeg button').forEach((b) => b.classList.toggle('active', b.dataset.kind === kind));
    $('stockPane').classList.toggle('hidden', kind !== 'stock');
    $('needsPane').classList.toggle('hidden', kind !== 'needs');
    if (kind === 'stock') loadStock(); else loadNeeds();
  }

  // ---------- 品切れカード ----------
  const CARD_MAX = 15;
  const CARD_MEMO = '只今手配中です\nしばらくお待ち下さい。';
  let cards = store.get('cards', []);
  const shortName = (p) => { const n = String(p.name || ''); const m = String(p.maker || ''); return m && n.indexOf(m) === 0 ? n.slice(m.length).trim() : n; };
  function saveCards() { store.set('cards', cards); renderCards(); }
  function addCard(p) {
    if (cards.length >= CARD_MAX) { toast('1回のPDFは15枚までです。先にPDFを作ってください', 3000); return false; }
    cards.push({ code: p.code, maker: p.maker, name: shortName(p), memo: CARD_MEMO });
    return true;
  }
  function renderCards() {
    $('cCount').textContent = cards.length;
    $('cEmpty').classList.toggle('hidden', cards.length > 0);
    $('cList').innerHTML = cards.map((c, i) =>
      '<div class="ccard" data-i="' + i + '">' +
        '<div class="chead"><div><span class="code">' + esc(c.code) + '</span>　<b>' + esc(c.maker) + '</b></div><button class="del" data-act="del">とりけす</button></div>' +
        '<small>商品名（カードに出る名前。長いときは短くできます）</small><input data-f="name" value="' + esc(c.name) + '">' +
        '<small>お知らせ</small><textarea data-f="memo" rows="2">' + esc(c.memo) + '</textarea>' +
      '</div>').join('');
  }
  async function makeCards() {
    if (!BASE) { modal('<p>' + NOT_READY + '</p>'); return; }
    if (!cards.length) { toast('カードにする商品を入れてください'); return; }
    busy(true, '品切れカードを作っています…');
    try {
      const r = await post('cards', { price: $('cPrice').value, cards: cards });
      busy(false);
      M.showPdfBase64(r.pdf, r.name, '品切れカード（' + cards.length + '枚）');
    } catch (e) { busy(false); toast(e.message, 3500); }
  }

  // ---------- できごとの登録 ----------
  function bind() {
    picker($('jCustQ'), $('jCustList'), findCustomers, 'c', (c) => {
      draft.customer = { code: c.code, name: c.name, staff: c.staff }; quote = null;
      if (c.staff) { $('jStaff').value = c.staff; draft.staff = c.staff; }
      renderCustomer(); changed();
    });
    $('jStaff').addEventListener('input', () => { draft.staff = $('jStaff').value.trim(); save(); });
    $('jCustSel').addEventListener('click', (e) => { if (e.target.id === 'jCustChange') { draft.customer = null; quote = null; renderCustomer(); changed(); $('jCustQ').focus(); } });
    picker($('jProdQ'), $('jProdList'), findProducts, 'p', (p) => {
      const f = draft.lines.find((l) => l.code === p.code);
      if (f) f.qty += 1; else draft.lines.push({ code: p.code, maker: p.maker, name: p.name, qty: 1 });
      toast(f ? '数量を1ふやしました' : '入れました'); changed();
    });
    $('jLines').addEventListener('click', (e) => {
      const btn = e.target.closest('button'); if (!btn) return;
      const i = Number(btn.closest('.jline').dataset.i);
      if (btn.dataset.act === 'minus') draft.lines[i].qty = Math.max(1, draft.lines[i].qty - 1);
      if (btn.dataset.act === 'plus') draft.lines[i].qty += 1;
      if (btn.dataset.act === 'del') draft.lines.splice(i, 1);
      changed();
    });
    $('jLines').addEventListener('change', (e) => {
      const row = e.target.closest('.jline'); if (!row) return;
      draft.lines[Number(row.dataset.i)].qty = Math.max(1, parseInt(e.target.value, 10) || 1); changed();
    });
    $('jOrderBtn').addEventListener('click', confirmOrder);
    $('jClearBtn').addEventListener('click', () => modal('<h2>入力をぜんぶ消しますか？</h2>', [
      { label: '消す', primary: true, onClick: () => { draft = { customer: null, lines: [] }; quote = null; $('jNote').value = ''; $('jStaff').value = ''; renderCustomer(); changed(); } },
      { label: 'やめる' }]));

    picker($('sProdQ'), $('sProdList'), findProducts, 'p', selectStock);
    $('sSave').addEventListener('click', saveStock);
    $('sFilter').addEventListener('input', renderStock);
    $('sReload').addEventListener('click', loadStock);
    $('nReload').addEventListener('click', loadNeeds);
    $('stockList').addEventListener('click', (e) => {
      const li = e.target.closest('.scard'); if (!li) return;
      const p = jproducts.find((x) => x.code === li.dataset.code) || stockCache.find((x) => x.code === li.dataset.code);
      if (p) { selectStock(p); window.scrollTo(0, 0); }
    });
    document.querySelectorAll('#stockSeg button').forEach((b) => b.addEventListener('click', () => showStockKind(b.dataset.kind)));

    $('histJuchu').addEventListener('click', (e) => {
      const btn = e.target.closest('button'); if (!btn) return;
      const li = btn.closest('.hcard');
      if (btn.dataset.act === 'toggle') { li.classList.toggle('open'); btn.textContent = li.classList.contains('open') ? '閉じる' : '中身を見る'; }
      if (btn.dataset.act === 'pdf') M.openPdf(li.dataset.no, btn, BASE, '受注書');
    });

    document.addEventListener('viewshown', async (e) => {
      if (e.detail !== 'juchu' && e.detail !== 'stock') return;
      if (!BASE) { if (e.detail === 'juchu') modal('<p>' + NOT_READY + '</p>'); else showStockKind(store.get('stockKind', 'stock')); return; }
      if (e.detail === 'juchu') { $('jOrderer').value = $('jOrderer').value || M.orderer; await ensureLists(false); requote(); }
      if (e.detail === 'stock') { ensureLists(false); showStockKind(store.get('stockKind', 'stock')); }
    });
    document.addEventListener('juchuhistory', loadHistory);
    document.addEventListener('refreshjuchu', () => { if (BASE) ensureLists(true); });
  }

  function bindCards() {
    $('jCardBtn').addEventListener('click', () => M.show('card'));
    $('cBack').addEventListener('click', () => M.show('juchu'));
    picker($('cProdQ'), $('cProdList'), findProducts, 'p', (p) => { if (addCard(p)) { saveCards(); toast('入れました'); } });
    $('cFromJuchu').addEventListener('click', () => {
      if (!draft.lines.length) { toast('入力中の受注に商品がありません'); return; }
      let n = 0;
      for (const l of draft.lines) { if (cards.some((c) => c.code === l.code)) continue; if (!addCard(l)) break; n++; }
      saveCards(); toast(n + '枚 入れました');
    });
    $('cList').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act="del"]'); if (!b) return;
      cards.splice(Number(b.closest('.ccard').dataset.i), 1); saveCards();
    });
    $('cList').addEventListener('input', (e) => {
      const f = e.target.dataset.f; if (!f) return;
      cards[Number(e.target.closest('.ccard').dataset.i)][f] = e.target.value; store.set('cards', cards);
    });
    $('cClear').addEventListener('click', () => modal('<h2>カードをぜんぶ消しますか？</h2>', [
      { label: '消す', primary: true, onClick: () => { cards = []; saveCards(); } }, { label: 'やめる' }]));
    $('cPrice').value = store.get('cardPrice', '新売価');
    $('cPrice').addEventListener('change', () => store.set('cardPrice', $('cPrice').value));
    $('cMake').addEventListener('click', makeCards);
    document.addEventListener('viewshown', (e) => { if (e.detail === 'card') { ensureLists(false); renderCards(); } });
  }

  bind(); bindCards(); badge(); renderCustomer(); renderLines(); renderCards(); loadLocal();
  $('jStaff').value = draft.staff || (draft.customer && draft.customer.staff) || '';
})();
