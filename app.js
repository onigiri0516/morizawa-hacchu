/* 守澤 発注アプリ
 * 商品データはスプレッドシート（商品データシート）から取り込み、スマホの中に保存して検索します。
 * 発注するとスプレッドシートの「発注履歴」に保存され、発注書（B5のPDF）を作れます。
 */
(function () {
  'use strict';
  const APP_VERSION = '1.0.0';
  const API = (window.APP_CONFIG && window.APP_CONFIG.API_URL) || '';
  const MAX_RESULTS = 100;

  // ---------- ちょっとした道具 ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s || '').normalize('NFKC').toUpperCase().replace(/\s+/g, ' ').trim();
  const yen = (v) => (v === '' || v == null || isNaN(Number(v))) ? '' : '¥' + Number(v).toLocaleString('ja-JP');
  const store = {
    get(k, d) { try { const v = localStorage.getItem('hacchu.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('hacchu.' + k, JSON.stringify(v)); } catch (e) {} },
  };

  function toast(msg, ms) {
    const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms || 2200);
  }
  function busy(on, text) { $('busyText').textContent = text || '読み込み中…'; $('busy').classList.toggle('hidden', !on); }
  function modal(html, buttons) {
    $('modalBody').innerHTML = html;
    const box = $('modalBtns'); box.innerHTML = '';
    (buttons || [{ label: '閉じる' }]).forEach((b) => {
      const el = document.createElement('button');
      el.className = b.primary ? 'primary' : 'ghost big';
      el.textContent = b.label;
      el.onclick = () => { if (!b.keep) closeModal(); if (b.onClick) b.onClick(el); };
      box.appendChild(el);
    });
    $('modal').classList.remove('hidden');
  }
  function closeModal() { $('modal').classList.add('hidden'); }

  // ---------- スプレッドシートとのやりとり ----------
  async function apiGet(action, params) {
    if (!API) throw new Error('アプリの設定（つなぎ先）がまだ入っていません');
    const q = new URLSearchParams(Object.assign({ action, key: store.get('key', '') }, params || {}));
    const res = await fetch(API + '?' + q.toString(), { method: 'GET', redirect: 'follow' });
    if (!res.ok) throw new Error('通信に失敗しました（' + res.status + '）');
    return res;
  }
  async function apiJson(action, params) {
    const res = await apiGet(action, params);
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'エラーがおきました');
    return j;
  }
  async function apiPost(action, body) {
    if (!API) throw new Error('アプリの設定（つなぎ先）がまだ入っていません');
    const res = await fetch(API, {
      method: 'POST', redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action, key: store.get('key', '') }, body || {})),
    });
    if (!res.ok) throw new Error('通信に失敗しました（' + res.status + '）');
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'エラーがおきました');
    return j;
  }

  // ---------- 商品データ（スマホの中に保存） ----------
  const idb = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((ok, ng) => {
        const r = indexedDB.open('hacchu', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => { this.db = r.result; ok(this.db); };
        r.onerror = () => ng(r.error);
      });
    },
    async get(k) { const db = await this.open(); return new Promise((ok, ng) => { const t = db.transaction('kv').objectStore('kv').get(k); t.onsuccess = () => ok(t.result); t.onerror = () => ng(t.error); }); },
    async set(k, v) { const db = await this.open(); return new Promise((ok, ng) => { const t = db.transaction('kv', 'readwrite').objectStore('kv').put(v, k); t.onsuccess = () => ok(); t.onerror = () => ng(t.error); }); },
  };

  let products = []; // {mk, sp, hb, name, jan, teika, cost, s}
  function parseProducts(text) {
    const lines = text.split('\n');
    const out = [];
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split('\t');
      if (c.length < 5) continue;
      const p = { mk: c[0] || '', sp: c[1] || '', hb: c[2] || '', name: c[3] || '', jan: c[4] || '', teika: c[5] || '', cost: c[6] || '' };
      if (!p.name && !p.hb) continue;
      p.s = norm(p.hb + ' ' + p.name + ' ' + p.jan + ' ' + p.mk);
      out.push(p);
    }
    return out;
  }
  async function loadLocalProducts() {
    try {
      const text = await idb.get('products');
      if (text) products = parseProducts(text);
    } catch (e) { /* 保存がない場合など */ }
    showDataInfo();
  }
  async function downloadProducts(force) {
    let meta = null;
    try { meta = await apiJson('meta'); } catch (e) { if (!products.length) throw e; return; }
    if (!force && products.length && meta.ver === store.get('dataVer', '')) return;
    busy(true, products.length ? '商品データを新しくしています…' : '商品データを読み込んでいます…\n（はじめてのときは少し時間がかかります）');
    try {
      const res = await apiGet('products');
      const text = await res.text();
      if (!text.startsWith('OK\t')) {
        let msg = '商品データを読み込めませんでした';
        try { msg = JSON.parse(text).error || msg; } catch (e) {}
        throw new Error(msg);
      }
      products = parseProducts(text);
      await idb.set('products', text);
      store.set('dataVer', text.slice(3, text.indexOf('\n')));
      store.set('dataDate', new Date().toLocaleString('ja-JP'));
      showDataInfo();
      if ($('q').value) doSearch();
    } finally { busy(false); }
  }
  function showDataInfo() {
    $('dataInfo').textContent = products.length
      ? products.length.toLocaleString('ja-JP') + ' 品目（' + (store.get('dataDate', '') || '日時不明') + ' に取り込み）'
      : 'まだ取り込んでいません';
  }

  // ---------- 検索 ----------
  function search(q) {
    const words = norm(q).split(' ').filter(Boolean);
    if (!words.length) return [];
    const digits = q.replace(/\D/g, '');
    const hits = [];
    // JANコードがそのまま入ったときは、ぴったり合う商品を先に出す
    if (/^\d{8,14}$/.test(q.trim())) {
      for (const p of products) if (p.jan === digits) hits.push(p);
    }
    for (const p of products) {
      if (hits.length >= MAX_RESULTS) break;
      let ok = true;
      for (const w of words) { if (p.s.indexOf(w) < 0) { ok = false; break; } }
      if (ok && hits.indexOf(p) < 0) hits.push(p);
    }
    return hits;
  }
  let lastHits = [];
  function doSearch() {
    const q = $('q').value;
    const box = $('results');
    if (!q.trim()) { box.innerHTML = ''; $('searchInfo').classList.remove('hidden'); return; }
    $('searchInfo').classList.add('hidden');
    if (!products.length) { box.innerHTML = '<li class="empty">商品データがまだありません。<br>「設定」で取り込んでください。</li>'; return; }
    lastHits = search(q);
    if (!lastHits.length) { box.innerHTML = '<li class="empty">見つかりませんでした。<br>言葉を短くしたり、別の言い方で試してください。</li>'; return; }
    box.innerHTML = lastHits.map((p, i) => cardHtml(p, i)).join('') +
      (lastHits.length >= MAX_RESULTS ? '<li class="hint center">多いので' + MAX_RESULTS + '件まで出しています。言葉を足してしぼってください。</li>' : '');
  }
  function cardHtml(p, i) {
    const inCart = cart.find((c) => keyOf(c) === keyOf(p));
    return '<li class="card" data-i="' + i + '">' +
      '<div class="name">' + esc(p.name) + '</div>' +
      '<div class="meta"><b>' + esc(p.mk) + '</b>　仕入先：' + esc(p.sp) + '</div>' +
      '<div class="meta">品番：' + esc(p.hb || '—') + '　JAN：' + esc(p.jan || '—') + '</div>' +
      ((p.cost || p.teika) ? '<div class="price">' + (p.cost ? '仕入単価 ' + yen(p.cost) : '') + (p.teika ? '　定価 ' + yen(p.teika) : '') + '</div>' : '') +
      '<div class="addrow">' +
        '<div class="qty"><button data-act="minus">−</button><input type="number" inputmode="numeric" min="1" value="1"><button data-act="plus">＋</button></div>' +
        '<button class="addbtn' + (inCart ? ' done' : '') + '" data-act="add">' + (inCart ? '入っています（' + inCart.qty + '）' : 'かごに入れる') + '</button>' +
      '</div></li>';
  }

  // ---------- 発注かご ----------
  let cart = store.get('cart', []);
  const keyOf = (p) => [p.mk, p.hb, p.jan, p.name].join('|');
  function saveCart() { store.set('cart', cart); updateBadge(); }
  function updateBadge() {
    const b = $('cartBadge'); b.textContent = cart.length; b.classList.toggle('hidden', cart.length === 0);
  }
  function addToCart(p, qty) {
    const k = keyOf(p);
    const found = cart.find((c) => keyOf(c) === k);
    if (found) found.qty += qty; else cart.push({ mk: p.mk, sp: p.sp, hb: p.hb, jan: p.jan, name: p.name, qty: qty });
    saveCart();
    return found ? found.qty : qty;
  }
  function groupCart() {
    const g = {}; const order = [];
    cart.forEach((c, i) => { const sp = c.sp || '（仕入先なし）'; if (!g[sp]) { g[sp] = []; order.push(sp); } g[sp].push(Object.assign({ i }, c)); });
    return order.map((sp) => ({ sp, items: g[sp] }));
  }
  function renderCart() {
    const has = cart.length > 0;
    $('cartEmpty').classList.toggle('hidden', has);
    $('cartFooter').classList.toggle('hidden', !has);
    $('ordererInCart').value = store.get('orderer', '');
    $('cartBody').innerHTML = groupCart().map((g) =>
      '<div class="group"><h3>' + esc(g.sp) + '　あて（' + g.items.length + '品目）</h3>' +
      g.items.map((c) =>
        '<div class="citem" data-i="' + c.i + '">' +
          '<div class="name"><b>' + esc(c.name) + '</b></div>' +
          '<div class="meta">' + esc(c.mk) + '　品番：' + esc(c.hb || '—') + '　JAN：' + esc(c.jan || '—') + '</div>' +
          '<div class="row"><div class="qty"><button data-act="minus">−</button><input type="number" inputmode="numeric" min="1" value="' + c.qty + '"><button data-act="plus">＋</button></div>' +
          '<button class="del" data-act="del">とりけす</button></div>' +
        '</div>').join('') +
      '</div>').join('');
  }

  async function placeOrder() {
    const orderer = $('ordererInCart').value.trim();
    if (!orderer) { toast('発注者の名前を入れてください'); $('ordererInCart').focus(); return; }
    store.set('orderer', orderer); $('orderer').value = orderer;
    const groups = groupCart();
    const html = '<h2>この内容で発注しますか？</h2>' +
      groups.map((g) => '<p><b>' + esc(g.sp) + '</b> あて：' + g.items.length + '品目</p>').join('') +
      '<p class="hint">発注者：' + esc(orderer) + (groups.length > 1 ? '<br>仕入先ごとに別の発注書になります。' : '') + '</p>';
    modal(html, [
      { label: '発注する', primary: true, onClick: async () => {
        busy(true, '発注しています…');
        try {
          const r = await apiPost('order', { orderer, note: $('note').value.trim(), items: cart });
          cart = []; saveCart(); $('note').value = ''; renderCart();
          if ($('q').value) doSearch();
          busy(false);
          modal('<h2 class="ok">発注を保存しました</h2><ul class="olist">' +
            r.orders.map((o) => '<li>発注番号 <b>' + esc(o.no) + '</b><br>' + esc(o.supplier) + '　' + o.count + '品目</li>').join('') +
            '</ul><p class="hint">B5の発注書は「履歴」からいつでも出せます。</p>',
            r.orders.map((o) => ({ label: o.supplier + ' の発注書（PDF）', keep: true, onClick: (btn) => openPdf(o.no, btn) }))
              .concat([{ label: '閉じる' }]));
        } catch (e) { busy(false); modal('<h2>発注できませんでした</h2><p>' + esc(e.message) + '</p><p class="hint">発注かごの中身はそのまま残っています。</p>'); }
      } },
      { label: 'やめる' },
    ]);
  }

  // ---------- 発注書PDF ----------
  const pdfCache = {};
  async function openPdf(no, btn) {
    // 1回目：PDFを作ってもらう → 2回目のタップで開く（iPhoneの決まりで、タップした瞬間に開く必要があるため）
    if (pdfCache[no]) { sharePdf(pdfCache[no]); return; }
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '発注書を作っています…'; }
    try {
      const r = await apiJson('pdf', { no });
      const bin = atob(r.pdf); const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      pdfCache[no] = new File([bytes], r.name, { type: 'application/pdf' });
      if (btn) { btn.disabled = false; btn.textContent = '発注書を開く（' + no + '）'; btn.className = 'primary'; }
      else sharePdf(pdfCache[no]);
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = label; }
      toast(e.message, 3500);
    }
  }
  function sharePdf(file) {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: file.name }).catch(() => {});
      return;
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // ---------- 履歴 ----------
  async function loadHistory() {
    const box = $('historyList');
    box.innerHTML = '<li class="empty">読み込み中…</li>';
    try {
      const r = await apiJson('history', { limit: 50 });
      if (!r.orders.length) { box.innerHTML = '<li class="empty">まだ発注の履歴はありません。</li>'; return; }
      box.innerHTML = r.orders.map((o) =>
        '<li class="card hcard" data-no="' + esc(o.no) + '">' +
          '<div class="head"><div><div class="no">' + esc(o.no) + '</div><div class="sup">' + esc(o.supplier) + '</div></div>' +
          '<div class="meta" style="text-align:right">' + esc(o.date) + '<br>' + esc(o.orderer || '') + '<br>' + o.items.length + '品目</div></div>' +
          '<div class="items">' + o.items.map((it) => '<div class="it"><span>' + esc(it.name) + '<br><small>' + esc(it.mk) + '　' + esc(it.hb || it.jan) + '</small></span><b>' + esc(it.qty) + '</b></div>').join('') +
          (o.note ? '<p class="hint">納品先・納期：' + esc(o.note) + '</p>' : '') + '</div>' +
          '<div class="btns"><button class="ghost" data-act="toggle">中身を見る</button><button class="ghost" data-act="pdf">発注書（PDF）</button></div>' +
        '</li>').join('');
    } catch (e) { box.innerHTML = '<li class="empty">' + esc(e.message) + '</li>'; }
  }

  // ---------- バーコード ----------
  let scanner = null;
  async function startScan() {
    if (!window.Html5Qrcode) { toast('読み取りの準備中です。少し待ってからもう一度押してください'); return; }
    $('scanner').classList.remove('hidden');
    const F = window.Html5QrcodeSupportedFormats;
    scanner = new window.Html5Qrcode('reader', { formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.ITF], verbose: false });
    try {
      await scanner.start({ facingMode: 'environment' }, { fps: 12, qrbox: { width: 280, height: 140 }, aspectRatio: 1.333 },
        (text) => { stopScan(); $('q').value = text; doSearch(); toast('読み取りました：' + text); }, () => {});
    } catch (e) {
      stopScan();
      modal('<h2>カメラが使えません</h2><p>カメラの使用を許可してください。<br>iPhoneの「設定」→「Safari」→「カメラ」で「許可」にすると使えます。</p>');
    }
  }
  async function stopScan() {
    $('scanner').classList.add('hidden');
    if (scanner) { try { await scanner.stop(); } catch (e) {} try { scanner.clear(); } catch (e) {} scanner = null; }
  }

  // ---------- 画面の切り替え ----------
  const titles = { search: '商品をさがす', cart: '発注かご', history: '発注履歴', settings: '設定' };
  function show(view) {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    $('title').textContent = titles[view];
    if (view === 'cart') renderCart();
    if (view === 'history') loadHistory();
    window.scrollTo(0, 0);
  }

  // ---------- はじめの設定 ----------
  async function login() {
    const key = $('loginKey').value.trim(); const name = $('loginName').value.trim();
    if (!key || !name) { $('loginErr').textContent = '合言葉と名前を入れてください'; return; }
    store.set('key', key);
    try {
      await apiJson('ping');
      store.set('orderer', name);
      $('login').classList.add('hidden');
      fillSettings();
      await downloadProducts(false);
    } catch (e) { $('loginErr').textContent = e.message; }
  }
  function fillSettings() { $('orderer').value = store.get('orderer', ''); $('passkey').value = store.get('key', ''); }

  // ---------- できごとの登録 ----------
  function qtyStep(root, d) {
    const inp = root.querySelector('.qty input');
    const v = Math.max(1, (parseInt(inp.value, 10) || 1) + d); inp.value = v; return v;
  }
  function bind() {
    document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
    let t = null;
    $('q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(doSearch, 250); });
    $('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.target.blur(); doSearch(); } });
    $('scanBtn').addEventListener('click', startScan);
    $('scanClose').addEventListener('click', stopScan);

    $('results').addEventListener('click', (e) => {
      const btn = e.target.closest('button'); if (!btn) return;
      const li = btn.closest('.card'); const p = lastHits[Number(li.dataset.i)];
      if (btn.dataset.act === 'minus') qtyStep(li, -1);
      if (btn.dataset.act === 'plus') qtyStep(li, 1);
      if (btn.dataset.act === 'add') {
        const q = parseInt(li.querySelector('.qty input').value, 10) || 1;
        const total = addToCart(p, q);
        btn.classList.add('done'); btn.textContent = '入っています（' + total + '）';
        toast('発注かごに入れました');
      }
    });

    $('cartBody').addEventListener('click', (e) => {
      const btn = e.target.closest('button'); if (!btn) return;
      const row = btn.closest('.citem'); const i = Number(row.dataset.i);
      if (btn.dataset.act === 'minus') { cart[i].qty = qtyStep(row, -1); saveCart(); }
      if (btn.dataset.act === 'plus') { cart[i].qty = qtyStep(row, 1); saveCart(); }
      if (btn.dataset.act === 'del') { cart.splice(i, 1); saveCart(); renderCart(); }
    });
    $('cartBody').addEventListener('change', (e) => {
      const row = e.target.closest('.citem'); if (!row) return;
      const i = Number(row.dataset.i); const v = Math.max(1, parseInt(e.target.value, 10) || 1);
      e.target.value = v; cart[i].qty = v; saveCart();
    });
    $('orderBtn').addEventListener('click', placeOrder);

    $('historyList').addEventListener('click', (e) => {
      const btn = e.target.closest('button'); if (!btn) return;
      const li = btn.closest('.hcard');
      if (btn.dataset.act === 'toggle') { li.classList.toggle('open'); btn.textContent = li.classList.contains('open') ? '閉じる' : '中身を見る'; }
      if (btn.dataset.act === 'pdf') openPdf(li.dataset.no, btn);
    });
    $('reloadHistory').addEventListener('click', loadHistory);

    $('saveSettings').addEventListener('click', async () => {
      store.set('orderer', $('orderer').value.trim());
      store.set('key', $('passkey').value.trim());
      try { await apiJson('ping'); toast('保存しました'); } catch (e) { toast(e.message, 3500); }
    });
    $('refreshData').addEventListener('click', async () => {
      try { await downloadProducts(true); toast('商品データを取り直しました'); } catch (e) { toast(e.message, 3500); }
    });
    $('loginBtn').addEventListener('click', login);

    const net = () => { $('netState').textContent = navigator.onLine ? '' : '圏外（検索だけできます）'; };
    window.addEventListener('online', net); window.addEventListener('offline', net); net();
  }

  // ---------- はじまり ----------
  async function start() {
    $('appVer').textContent = APP_VERSION;
    bind(); updateBadge(); fillSettings();
    await loadLocalProducts();
    if (!store.get('key', '')) {
      $('loginName').value = store.get('orderer', '');
      $('login').classList.remove('hidden');
      return;
    }
    try { await downloadProducts(false); } catch (e) { toast(e.message, 3500); }
  }
  if ('serviceWorker' in navigator) { window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {})); }
  document.addEventListener('DOMContentLoaded', start);
})();
