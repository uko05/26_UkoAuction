// script.js
// うーこオークション: うーこの部屋の各サイトから出品されたアイテム(ukoMarketListings)を
// 横断的に一覧・入札・即決購入できるサイト。出品自体は各サイト側(例: 14_GenshinOmikuji)で行う。
import { app, db } from './firebaseConfig.js';
import {
  collection, doc, getDoc, onSnapshot, runTransaction,
  query, where, orderBy, limit, increment,
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

// 動作確認中は管理者/デバッガーロールの人にだけ一覧を見せる(一般ユーザーには
// ゲートメッセージのみ表示)。確認が終わったら削除してよい。
let isAuctionDebugger = false;
async function loadAuctionDebuggerRole() {
  try {
    const snap = await getDoc(doc(db, 'sharedUserRoles', getUserId()));
    if (snap.exists()) {
      const d = snap.data();
      isAuctionDebugger = d.role === 'admin' || d.role === 'debugger' || !!d.debugOmikuji;
    }
  } catch (e) {
    console.warn('[auction] ロール取得に失敗:', e);
  }
}

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
const AUCTION_START_PRICE = 10;
const AUCTION_BUY_NOW_PRICE = 250;

// ===== i18n =====
const i18n = {
  ja: {
    pageTitle: 'うーこオークション',
    headerSub: 'うーこの部屋の各サイトで出品されたアイテムを一覧・入札できます',
    gateMessage: '動作確認中のため、現在は一部のユーザーのみ利用できます。',
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
  },
  en: {
    pageTitle: 'Uko Auction',
    headerSub: 'Browse and bid on items listed across うーこの部屋 sites',
    gateMessage: 'This feature is currently limited to a subset of users while under testing.',
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
  renderAuctionList(isAuctionDebugger ? latestListings : []);
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
          tx.update(winnerRef, { [d.returnField]: increment(1) });
        }
        if (sellerSnap.exists()) {
          tx.update(sellerRef, { ukoPoints: increment(d.currentBid) });
        }
        tx.update(ref, { status: 'sold', soldVia: 'bid', soldPrice: d.currentBid, soldTo: d.currentBidderId });
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

      tx.update(myRef, { ukoPoints: increment(-escrowNeeded) });
      if (prevBidderId && !isSameBidder) {
        const prevRef = doc(db, 'omikujiUsers', prevBidderId);
        const prevSnap = await tx.get(prevRef);
        if (prevSnap.exists()) {
          tx.update(prevRef, { ukoPoints: increment(prevBid) });
        }
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
      });
      if (sellerSnap.exists()) {
        tx.update(sellerRef, { ukoPoints: increment(d.buyNowPrice) });
      }
      tx.update(listingRef, {
        status: 'sold', soldVia: 'buyNow', soldPrice: d.buyNowPrice, soldTo: myUserId,
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
  const input = document.getElementById('auction-bid-input');
  const amount = Math.floor(Number(input?.value));
  closeBidModal();
  await placeBid(bidTargetListing, amount);
}

function openLightbox(url) {
  const lightbox = document.getElementById('auction-lightbox');
  const lightboxImg = document.getElementById('auction-lightbox-img');
  if (!lightbox || !lightboxImg || !url) return;
  lightboxImg.src = url;
  lightbox.classList.add('visible');
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
  const gateEl = document.getElementById('auction-gate-message');
  if (!listEl) return;
  const myUserId = getUserId();
  listEl.innerHTML = '';

  if (gateEl) gateEl.style.display = isAuctionDebugger ? 'none' : 'block';
  if (!isAuctionDebugger) return;

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
    renderAuctionList(isAuctionDebugger ? latestListings : []);
  }, (err) => console.error('[auction] listen failed', err));

  // ロール判定は非同期なので、判明した時点で改めて描画し直す
  loadAuctionDebuggerRole().then(() => {
    renderAuctionList(isAuctionDebugger ? latestListings : []);
  });

  const bidClose = document.getElementById('auction-bid-close');
  if (bidClose) bidClose.addEventListener('click', closeBidModal);
  const bidBackdrop = document.querySelector('#auction-bid-modal .col-modal-backdrop');
  if (bidBackdrop) bidBackdrop.addEventListener('click', closeBidModal);
  const bidSubmit = document.getElementById('auction-bid-submit');
  if (bidSubmit) bidSubmit.addEventListener('click', submitBid);

  const lightbox = document.getElementById('auction-lightbox');
  if (lightbox) lightbox.addEventListener('click', () => lightbox.classList.remove('visible'));
}

initLangSwitch();
initAuctionList();
