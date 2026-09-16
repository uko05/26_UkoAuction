// script.js
// うーこオークション: うーこの部屋の各サイトから出品されたアイテム(ukoMarketListings)を
// 横断的に一覧・入札・即決購入できるサイト。出品自体は各サイト側(例: 14_GenshinOmikuji)で行う。
import { app, db } from './firebaseConfig.js';
import {
  collection, doc, onSnapshot, runTransaction,
  query, where, orderBy, limit, increment, serverTimestamp, arrayUnion,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

// ===== ログイン状態(入札・即決購入をアカウント登録者限定にするため。
// 一覧の閲覧自体は未登録でも可能にしたいので、そちらでは使わないこと) =====
const auth = getAuth(app);
let authUid = null;
const authReady = new Promise((resolve) => {
  onAuthStateChanged(auth, (user) => {
    authUid = user ? user.uid : null;
    resolve();
  });
});
async function isLoggedIn() {
  await authReady;
  return !!authUid;
}

// ===== ユーザーID(uko05.github.io配下の全サイト共通のlocalStorageキー) =====
const LS_USER_ID = 'genshinOmikuji_userId';
function getUserId() {
  let id = localStorage.getItem(LS_USER_ID);
  if (!id) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    id = 'u_' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(LS_USER_ID, id);
  }
  return id;
}

// うーこポイント交換所(08_UPoint)ミッション「オークションを落札しよう」の達成フラグキー。
// 入札で競り落とした場合(settleListing)・即決購入した場合(buyNow)のどちらでも立てる。
// UP付与自体はしない(08_UPoint側の「受け取る」操作で加算する二段階方式、他ミッションと同じ)。
const AUCTION_WIN_MISSION_CLAIM_KEY = 'omikujiAuctionWin';

// ===== どのサイトのアイテムかを表す表示名(siteKey→ラベル)。
// 将来別サイトも出品するようになったらここにキーを足すだけでよい。 =====
const SITE_LABELS = {
  omikuji: { ja: '原神おみくじ', en: 'Genshin Omikuji' },
};
function siteLabel(siteKey) {
  const entry = SITE_LABELS[siteKey];
  if (!entry) return siteKey || '';
  return entry[currentLang()] || entry.ja;
}

// ガチャ券は08_UPoint側で50UP固定(2026-09時点)。開始=券の5分の1、即決=券の5倍という
// 比率で運用する方針のため、ここは連動する自動計算ではなく固定値(出品側の14_GenshinOmikuji/
// auction.jsと同じ値。片方を変更したらもう片方も手動で合わせること)。
const AUCTION_START_PRICE = 25;
const AUCTION_BUY_NOW_PRICE = 500;

// ===== i18n =====
const i18n = {
  ja: {
    pageTitle: 'うーこオークション',
    headerSub: 'うーこの部屋の各サイトで出品されたアイテムを一覧・入札できます',
    empty: '出品されているアイテムはありません',
    startLabel: '開始',
    currentLabel: '現在',
    noBid: 'まだ入札なし',
    buyNowLabel: '即決',
    bidBtn: '入札する',
    buyNowBtn: '即決で買う',
    yourListing: '（あなたの出品）',
    timeLeft: (h, m) => `残り${h}時間${m}分`,
    timeLeftMin: (m) => `残り${m}分`,
    ended: '終了処理中…',
    bidPrompt: (min) => `入札額を入力してください（${min}UP以上）`,
    bidTooLow: (min) => `入札額は${min}UP以上にしてください。`,
    bidInvalid: '入札額は整数で入力してください。',
    bidNoPoints: 'UPが足りません。',
    bidOwn: '自分の出品には入札できません。',
    loginRequired: '入札・即決購入にはアカウント登録（無料）が必要です。登録・ログインしてから利用してください。',
    bidEnded: 'このオークションは終了しています。',
    bidFailed: '入札に失敗しました。時間をおいて再度お試しください。',
    bidDone: '入札しました。',
    buyNowConfirm: (name) => `「${name}」を${AUCTION_BUY_NOW_PRICE}UPで即決購入しますか？`,
    buyNowNoPoints: 'UPが足りません。',
    buyNowFailed: '購入に失敗しました。時間をおいて再度お試しください。',
    buyNowDone: '購入しました！',
    myBidsBtn: '自分の入札',
    myBidsEmpty: 'まだ入札した商品はありません',
    badgeWinning: '入札中',
    badgeOutbid: '更新あり',
    statusWinning: '入札中（最高額）',
    statusOutbid: '更新されました（他の人が上回っています）',
    statusWon: '落札しました！',
    statusLost: '落札できませんでした',
    statusUnsold: '流札',
  },
  en: {
    pageTitle: 'Uko Auction',
    headerSub: 'Browse and bid on items listed across うーこの部屋 sites',
    empty: 'No items are currently listed',
    startLabel: 'Start',
    currentLabel: 'Current',
    noBid: 'No bids yet',
    buyNowLabel: 'Buy Now',
    bidBtn: 'Bid',
    buyNowBtn: 'Buy Now',
    yourListing: '(Your listing)',
    timeLeft: (h, m) => `${h}h ${m}m left`,
    timeLeftMin: (m) => `${m}m left`,
    ended: 'Settling…',
    bidPrompt: (min) => `Enter your bid (${min}UP or more)`,
    bidTooLow: (min) => `Your bid must be at least ${min}UP.`,
    bidInvalid: 'Please enter a whole number.',
    bidNoPoints: 'Not enough UP.',
    bidOwn: "You can't bid on your own listing.",
    loginRequired: 'Bidding and Buy Now require a free account. Please register and log in first.',
    bidEnded: 'This auction has ended.',
    bidFailed: 'Failed to place bid. Please try again later.',
    bidDone: 'Bid placed!',
    buyNowConfirm: (name) => `Buy "${name}" now for ${AUCTION_BUY_NOW_PRICE}UP?`,
    buyNowNoPoints: 'Not enough UP.',
    buyNowFailed: 'Purchase failed. Please try again later.',
    buyNowDone: 'Purchased!',
    myBidsBtn: 'My Bids',
    myBidsEmpty: "You haven't bid on anything yet",
    badgeWinning: 'Winning',
    badgeOutbid: 'Outbid',
    statusWinning: 'Winning (highest bid)',
    statusOutbid: "Outbid (someone else's bid is higher)",
    statusWon: 'You won it!',
    statusLost: "You didn't win this one",
    statusUnsold: 'Unsold',
  },
};
function currentLang() {
  return document.documentElement.lang === 'en' ? 'en' : 'ja';
}
function s() { return i18n[currentLang()]; }

function applyLang(lang) {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const val = s()[el.dataset.i18n];
    if (typeof val === 'string') el.textContent = val;
  });
  localStorage.setItem('lang', lang);
  renderAuctionList(latestListings);
}

function initLangSwitch() {
  const saved = localStorage.getItem('lang') || 'ja';
  const radio = document.querySelector(`input[name="lang"][value="${saved}"]`);
  if (radio) radio.checked = true;
  applyLang(saved);
  document.querySelectorAll('input[name="lang"]').forEach((r) => {
    r.addEventListener('change', (e) => applyLang(e.target.value));
  });
}

// ===== トースト通知 =====
let toastTimer = null;
function showToast(text, isError) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('toast-error', !!isError);
  el.style.display = 'block';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, 3200);
}

// ===== 期限切れオークションの精算（誰かが一覧を開いた時に遅延実行する） =====
async function settleListing(listingId) {
  const ref = doc(db, 'ukoMarketListings', listingId);
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      const d = snap.data();
      if (d.status !== 'active') return;
      if (!d.endsAt || d.endsAt.toMillis() > Date.now()) return;

      if (d.currentBidderId) {
        const winnerRef = doc(db, 'omikujiUsers', d.currentBidderId);
        const sellerRef = doc(db, 'omikujiUsers', d.sellerId);
        const [winnerSnap, sellerSnap] = await Promise.all([tx.get(winnerRef), tx.get(sellerRef)]);
        if (winnerSnap.exists()) {
          tx.update(winnerRef, {
            [d.returnField]: increment(1),
            [`missionsAchieved.${AUCTION_WIN_MISSION_CLAIM_KEY}`]: true,
          });
        }
        if (sellerSnap.exists()) {
          tx.update(sellerRef, { ukoPoints: increment(d.currentBid) });
        }
        tx.update(ref, { status: 'sold', soldVia: 'bid', soldPrice: d.currentBid, soldTo: d.currentBidderId, soldAt: serverTimestamp() });
      } else {
        // 入札なしで終了 → 出品者に返却
        const sellerRef = doc(db, 'omikujiUsers', d.sellerId);
        const sellerSnap = await tx.get(sellerRef);
        if (sellerSnap.exists()) {
          tx.update(sellerRef, { [d.returnField]: increment(1) });
        }
        tx.update(ref, { status: 'unsold' });
      }
    });
  } catch (e) {
    console.error('[auction] settle failed', e);
  }
}

// ===== 入札（出品者⇔入札者をまたぐトランザクション。競り落とされたら前の入札者に返金する） =====
async function placeBid(listing, amount) {
  const myUserId = getUserId();
  if (listing.sellerId === myUserId) { showToast(s().bidOwn, true); return; }
  if (!Number.isInteger(amount)) { showToast(s().bidInvalid, true); return; }

  const listingRef = doc(db, 'ukoMarketListings', listing.id);
  const myRef = doc(db, 'omikujiUsers', myUserId);

  try {
    await runTransaction(db, async (tx) => {
      const listingSnap = await tx.get(listingRef);
      if (!listingSnap.exists()) throw new Error('NOT_FOUND');
      const d = listingSnap.data();
      if (d.status !== 'active' || (d.endsAt && d.endsAt.toMillis() <= Date.now())) throw new Error('ENDED');

      const minBid = d.currentBid > 0 ? d.currentBid + 1 : d.startPrice;
      if (amount < minBid) throw new Error('TOO_LOW');

      const mySnap = await tx.get(myRef);
      if (!mySnap.exists()) throw new Error('NO_USER_DOC');
      const myPoints = mySnap.data().ukoPoints || 0;

      const prevBidderId = d.currentBidderId;
      const prevBid = d.currentBid || 0;
      const isSameBidder = prevBidderId === myUserId;
      // 同一人物の再入札は差額だけエスクロー、別人なら全額エスクロー＋前の入札者へ全額返金
      const escrowNeeded = isSameBidder ? (amount - prevBid) : amount;
      if (myPoints < escrowNeeded) throw new Error('NO_POINTS');

      // Firestoreのトランザクションは「読み取りは全部書き込みより先」という制約があるため、
      // 前の入札者への返金判定に必要な読み取りも、書き込みを始める前に済ませておく。
      let prevRef = null;
      let prevExists = false;
      if (prevBidderId && !isSameBidder) {
        prevRef = doc(db, 'omikujiUsers', prevBidderId);
        prevExists = (await tx.get(prevRef)).exists();
      }

      tx.update(myRef, { ukoPoints: increment(-escrowNeeded), myBids: arrayUnion(listing.id) });
      if (prevRef && prevExists) {
        tx.update(prevRef, { ukoPoints: increment(prevBid) });
      }

      tx.update(listingRef, {
        currentBid: amount,
        currentBidderId: myUserId,
        currentBidderName: '',
      });
    });
    showToast(s().bidDone, false);
  } catch (e) {
    console.error('[auction] bid failed', e);
    const map = {
      ENDED: s().bidEnded,
      TOO_LOW: s().bidTooLow(listing.currentBid > 0 ? listing.currentBid + 1 : listing.startPrice),
      NO_POINTS: s().bidNoPoints,
    };
    showToast(map[e.message] || s().bidFailed, true);
  }
}

// ===== 即決購入（出品者⇔購入者をまたぐトランザクション。入札中だった人がいれば返金する） =====
async function buyNow(listing) {
  const myUserId = getUserId();
  if (listing.sellerId === myUserId) { showToast(s().bidOwn, true); return; }
  if (!confirm(s().buyNowConfirm(listing.itemName))) return;

  const listingRef = doc(db, 'ukoMarketListings', listing.id);
  const myRef = doc(db, 'omikujiUsers', myUserId);
  const sellerRef = doc(db, 'omikujiUsers', listing.sellerId);

  try {
    await runTransaction(db, async (tx) => {
      const listingSnap = await tx.get(listingRef);
      if (!listingSnap.exists()) throw new Error('NOT_FOUND');
      const d = listingSnap.data();
      if (d.status !== 'active' || (d.endsAt && d.endsAt.toMillis() <= Date.now())) throw new Error('ENDED');

      const mySnap = await tx.get(myRef);
      if (!mySnap.exists()) throw new Error('NO_USER_DOC');
      const myPoints = mySnap.data().ukoPoints || 0;
      if (myPoints < d.buyNowPrice) throw new Error('NO_POINTS');

      const sellerSnap = await tx.get(sellerRef);

      // 入札中だった人がいれば全額返金
      if (d.currentBidderId) {
        const prevRef = doc(db, 'omikujiUsers', d.currentBidderId);
        const prevSnap = await tx.get(prevRef);
        if (prevSnap.exists()) {
          tx.update(prevRef, { ukoPoints: increment(d.currentBid) });
        }
      }

      tx.update(myRef, {
        ukoPoints: increment(-d.buyNowPrice),
        [d.returnField]: increment(1),
        [`missionsAchieved.${AUCTION_WIN_MISSION_CLAIM_KEY}`]: true,
      });
      if (sellerSnap.exists()) {
        tx.update(sellerRef, { ukoPoints: increment(d.buyNowPrice) });
      }
      tx.update(listingRef, {
        status: 'sold', soldVia: 'buyNow', soldPrice: d.buyNowPrice, soldTo: myUserId, soldAt: serverTimestamp(),
      });
    });
    showToast(s().buyNowDone, false);
  } catch (e) {
    console.error('[auction] buy-now failed', e);
    const map = { ENDED: s().bidEnded, NO_POINTS: s().buyNowNoPoints };
    showToast(map[e.message] || s().buyNowFailed, true);
  }
}

// ===== 入札額入力ポップ =====
let bidTargetListing = null;

function openBidModal(listing) {
  bidTargetListing = listing;
  const minBid = listing.currentBid > 0 ? listing.currentBid + 1 : listing.startPrice;
  const nameEl = document.getElementById('auction-bid-name');
  const promptEl = document.getElementById('auction-bid-prompt');
  const input = document.getElementById('auction-bid-input');
  const submitBtn = document.getElementById('auction-bid-submit');
  if (nameEl) nameEl.textContent = listing.itemName;
  if (promptEl) promptEl.textContent = s().bidPrompt(minBid);
  if (input) { input.min = minBid; input.value = minBid; }
  if (submitBtn) submitBtn.textContent = s().bidBtn;
  const modal = document.getElementById('auction-bid-modal');
  if (modal) modal.style.display = 'flex';
}

function closeBidModal() {
  bidTargetListing = null;
  const modal = document.getElementById('auction-bid-modal');
  if (modal) modal.style.display = 'none';
}

async function submitBid() {
  if (!bidTargetListing) return;
  const target = bidTargetListing; // closeBidModal()がbidTargetListingをnullにするため先に確保しておく
  const input = document.getElementById('auction-bid-input');
  const amount = Math.floor(Number(input?.value));
  closeBidModal();
  await placeBid(target, amount);
}

function openLightbox(url) {
  const lightbox = document.getElementById('auction-lightbox');
  const lightboxImg = document.getElementById('auction-lightbox-img');
  if (!lightbox || !lightboxImg || !url) return;
  lightboxImg.src = url;
  lightbox.classList.add('visible');
}

// ===== 自分の入札トラッキング(ヤフオク的な「入札中/更新されました」表示) =====
// 入札の度にomikujiUsers/{自分}.myBidsへ出品IDをarrayUnionで貯めていき、それぞれの
// 出品を個別購読してリアルタイムに「勝ってる/負けてる/落札した/できなかった」を追う。
// (一覧側のクエリはactiveな出品しか取ってこないため、終了済みの結果を知るには
// 個別購読が必要)
let myBidListingIds = [];
const myBidListingsData = new Map(); // listingId -> 最新ドキュメント(未取得ならエントリ無し)
const myBidListenerUnsubs = new Map(); // listingId -> unsubscribe関数
let myBidsModalOpen = false;

function myBidStatus(data, myUserId) {
  if (!data) return null;
  if (data.status === 'active') return data.currentBidderId === myUserId ? 'winning' : 'outbid';
  if (data.status === 'sold') return data.soldTo === myUserId ? 'won' : 'lost';
  return 'unsold';
}

function myBidStatusLabel(status) {
  const map = {
    winning: s().statusWinning, outbid: s().statusOutbid,
    won: s().statusWon, lost: s().statusLost, unsold: s().statusUnsold,
  };
  return map[status] || '';
}

function syncMyBidListeners() {
  const wanted = new Set(myBidListingIds);

  for (const [id, unsub] of myBidListenerUnsubs) {
    if (!wanted.has(id)) {
      unsub();
      myBidListenerUnsubs.delete(id);
      myBidListingsData.delete(id);
    }
  }

  wanted.forEach((id) => {
    if (myBidListenerUnsubs.has(id)) return;
    const unsub = onSnapshot(doc(db, 'ukoMarketListings', id), (snap) => {
      if (snap.exists()) myBidListingsData.set(id, { id, ...snap.data() });
      else myBidListingsData.delete(id);
      updateMyBidsBadge();
      renderAuctionList(latestListings);
      if (myBidsModalOpen) renderMyBidsList();
    }, (err) => console.error('[auction] my-bid listen failed', id, err));
    myBidListenerUnsubs.set(id, unsub);
  });
}

function initMyBidsTracking() {
  const myUserId = getUserId();
  onSnapshot(doc(db, 'omikujiUsers', myUserId), (snap) => {
    myBidListingIds = snap.exists() ? (snap.data().myBids || []) : [];
    syncMyBidListeners();
    updateMyBidsBadge();
    if (myBidsModalOpen) renderMyBidsList();
  }, (err) => console.error('[auction] myBids listen failed', err));
}

function updateMyBidsBadge() {
  const myUserId = getUserId();
  const badgeEl = document.getElementById('auction-mybids-badge');
  if (!badgeEl) return;
  let outbidCount = 0;
  myBidListingsData.forEach((data) => {
    if (myBidStatus(data, myUserId) === 'outbid') outbidCount++;
  });
  if (outbidCount > 0) {
    badgeEl.textContent = outbidCount > 9 ? '9+' : String(outbidCount);
    badgeEl.style.display = 'inline-flex';
  } else {
    badgeEl.style.display = 'none';
  }
}

function openMyBidsModal() {
  myBidsModalOpen = true;
  renderMyBidsList();
  const modal = document.getElementById('auction-mybids-modal');
  if (modal) modal.style.display = 'flex';
}
function closeMyBidsModal() {
  myBidsModalOpen = false;
  const modal = document.getElementById('auction-mybids-modal');
  if (modal) modal.style.display = 'none';
}

function renderMyBidsList() {
  const listEl = document.getElementById('auction-mybids-list');
  if (!listEl) return;
  const myUserId = getUserId();
  listEl.innerHTML = '';

  if (myBidListingIds.length === 0) {
    const p = document.createElement('p');
    p.className = 'auction-empty';
    p.textContent = s().myBidsEmpty;
    listEl.appendChild(p);
    return;
  }

  // 新しく入札したものほど配列の後ろに追加されるので、逆順にして新しい順に見せる
  myBidListingIds.slice().reverse().forEach((id) => {
    const data = myBidListingsData.get(id);
    const row = document.createElement('div');
    row.className = 'auction-mybids-item';

    if (!data) {
      row.innerHTML = `<div class="auction-mybids-info"><div class="auction-mybids-name">…</div></div>`;
      listEl.appendChild(row);
      return;
    }

    const status = myBidStatus(data, myUserId);
    const priceText = data.status === 'active'
      ? `${s().currentLabel} ${data.currentBid > 0 ? data.currentBid : data.startPrice}UP`
      : `${data.soldPrice ?? ''}UP`;

    row.innerHTML = `
      <img src="${data.itemImageUrl || ''}" alt="" class="auction-mybids-thumb">
      <div class="auction-mybids-info">
        <div class="auction-mybids-name">${data.itemName || ''}</div>
        <div class="auction-mybids-status auction-mybids-status-${status}">${myBidStatusLabel(status)}</div>
        <div class="auction-mybids-price">${priceText}</div>
      </div>
    `;
    if (status === 'outbid' && data.status === 'active') {
      row.classList.add('auction-mybids-item-clickable');
      row.addEventListener('click', () => {
        closeMyBidsModal();
        openBidModal(data);
      });
    }
    listEl.appendChild(row);
  });
}

// ===== 一覧描画 =====
function fmtTimeLeft(endsAt) {
  const ms = endsAt.toMillis() - Date.now();
  if (ms <= 0) return s().ended;
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? s().timeLeft(h, m) : s().timeLeftMin(m);
}

let latestListings = [];
let deepLinkHandled = false;

function renderAuctionList(listings) {
  const listEl = document.getElementById('auction-list');
  if (!listEl) return;
  const myUserId = getUserId();
  listEl.innerHTML = '';

  if (listings.length === 0) {
    const p = document.createElement('p');
    p.className = 'auction-empty';
    p.textContent = s().empty;
    listEl.appendChild(p);
    return;
  }

  listings.forEach((listing) => {
    const isExpired = listing.endsAt && listing.endsAt.toMillis() <= Date.now();
    if (isExpired) { settleListing(listing.id); }

    const card = document.createElement('div');
    card.className = 'auction-card';
    card.dataset.listingId = listing.id;

    const img = document.createElement('img');
    img.className = 'auction-card-img';
    img.src = listing.itemImageUrl;
    img.alt = listing.itemName;
    img.loading = 'lazy';
    img.addEventListener('click', () => openLightbox(listing.itemImageUrl));
    card.appendChild(img);

    const info = document.createElement('div');
    info.className = 'auction-card-info';

    const siteEl = document.createElement('span');
    siteEl.className = 'auction-card-site';
    siteEl.textContent = siteLabel(listing.siteKey);
    info.appendChild(siteEl);

    if (myBidListingIds.includes(listing.id)) {
      // 個別購読がまだ来ていない間は一覧側(latestListings)のデータで代用する
      const trackedData = myBidListingsData.get(listing.id) || listing;
      const myStatus = myBidStatus(trackedData, myUserId);
      if (myStatus === 'winning' || myStatus === 'outbid') {
        const statusEl = document.createElement('span');
        statusEl.className = `auction-card-mystatus auction-card-mystatus-${myStatus}`;
        statusEl.textContent = myStatus === 'winning' ? s().badgeWinning : s().badgeOutbid;
        info.appendChild(statusEl);
      }
    }

    const name = document.createElement('div');
    name.className = 'auction-card-name';
    name.textContent = listing.itemName;
    info.appendChild(name);

    const priceRow = document.createElement('div');
    priceRow.className = 'auction-card-price';
    priceRow.textContent = listing.currentBid > 0
      ? `${s().currentLabel} ${listing.currentBid}UP`
      : `${s().startLabel} ${listing.startPrice}UP（${s().noBid}）`;
    info.appendChild(priceRow);

    const buyNowRow = document.createElement('div');
    buyNowRow.className = 'auction-card-buynow';
    buyNowRow.textContent = `${s().buyNowLabel} ${listing.buyNowPrice}UP`;
    info.appendChild(buyNowRow);

    const timeRow = document.createElement('div');
    timeRow.className = 'auction-card-time';
    timeRow.textContent = isExpired ? s().ended : fmtTimeLeft(listing.endsAt);
    info.appendChild(timeRow);

    card.appendChild(info);

    const isMine = listing.sellerId === myUserId;
    const actions = document.createElement('div');
    actions.className = 'auction-card-actions';
    if (isMine) {
      const mine = document.createElement('span');
      mine.className = 'auction-card-mine';
      mine.textContent = s().yourListing;
      actions.appendChild(mine);
    } else if (!isExpired) {
      const bidBtn = document.createElement('button');
      bidBtn.type = 'button';
      bidBtn.className = 'auction-action-btn';
      bidBtn.textContent = s().bidBtn;
      bidBtn.addEventListener('click', async () => {
        if (!(await isLoggedIn())) { showToast(s().loginRequired, true); return; }
        openBidModal(listing);
      });
      actions.appendChild(bidBtn);

      const buyBtn = document.createElement('button');
      buyBtn.type = 'button';
      buyBtn.className = 'auction-action-btn auction-buynow-btn';
      buyBtn.textContent = s().buyNowBtn;
      buyBtn.addEventListener('click', async () => {
        if (!(await isLoggedIn())) { showToast(s().loginRequired, true); return; }
        buyNow(listing);
      });
      actions.appendChild(buyBtn);
    }
    card.appendChild(actions);

    listEl.appendChild(card);
  });

  // ディープリンク(?listing=<id>)で来た場合、該当アイテムが見つかり次第、入札ポップを自動で開く
  // (一度開いたら、閉じた後の再描画で再度開かないようにdeepLinkHandledで一回だけに制限する)
  const wantedListingId = new URLSearchParams(location.search).get('listing');
  if (wantedListingId && !deepLinkHandled) {
    const wanted = listings.find((l) => l.id === wantedListingId);
    if (wanted && wanted.sellerId !== myUserId) {
      deepLinkHandled = true;
      isLoggedIn().then((ok) => {
        if (ok) openBidModal(wanted);
        else showToast(s().loginRequired, true);
      });
    }
  }
}

// ===== 初期化 =====
function initAuctionList() {
  const q = query(
    collection(db, 'ukoMarketListings'),
    where('status', '==', 'active'),
    orderBy('endsAt', 'asc'),
    limit(100)
  );
  onSnapshot(q, (snap) => {
    latestListings = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAuctionList(latestListings);
  }, (err) => console.error('[auction] listen failed', err));

  // 残り時間はFirestoreの更新が無い限り再描画されないため、定期的に描き直して
  // 「残り○分」の表示を更新する(期限切れの精算トリガーもここで一緒に効く)
  setInterval(() => {
    renderAuctionList(latestListings);
  }, 30000);

  const bidClose = document.getElementById('auction-bid-close');
  if (bidClose) bidClose.addEventListener('click', closeBidModal);
  const bidBackdrop = document.querySelector('#auction-bid-modal .col-modal-backdrop');
  if (bidBackdrop) bidBackdrop.addEventListener('click', closeBidModal);
  const bidSubmit = document.getElementById('auction-bid-submit');
  if (bidSubmit) bidSubmit.addEventListener('click', submitBid);

  const lightbox = document.getElementById('auction-lightbox');
  if (lightbox) lightbox.addEventListener('click', () => lightbox.classList.remove('visible'));

  const myBidsBtn = document.getElementById('auction-mybids-btn');
  if (myBidsBtn) myBidsBtn.addEventListener('click', openMyBidsModal);
  const myBidsClose = document.getElementById('auction-mybids-close');
  if (myBidsClose) myBidsClose.addEventListener('click', closeMyBidsModal);
  const myBidsBackdrop = document.querySelector('#auction-mybids-modal .col-modal-backdrop');
  if (myBidsBackdrop) myBidsBackdrop.addEventListener('click', closeMyBidsModal);

  initMyBidsTracking();
}

initLangSwitch();
initAuctionList();
