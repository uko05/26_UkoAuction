// script.js
// うーこオークション: うーこの部屋の各サイトから出品されたアイテム(ukoMarketListings)を
// 横断的に一覧・入札できるサイト。出品自体は各サイト側(例: 14_GenshinOmikuji)で行う。
// 即決(買い切り)機能は2026-09-19に廃止した(固定500UPの即決価格がガチャ券50UPを
// 大きく上回っていたため、メイン垢で安くガチャを回して複製をサブ垢に即決購入させる
// 自演両替の抜け道になっていた)。
import { app, db } from './firebaseConfig.js';
import {
  collection, doc, getDoc, onSnapshot, runTransaction,
  query, where, orderBy, limit, increment, serverTimestamp, arrayUnion,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// UP取得履歴(管理者画面「UP取得履歴」用の監査ログ、2026-09-19追加)。ukoPointsを
// 増やす箇所でこのコレクションにも1件書き込んでおくと、後から「誰が・何で・いつ・
// いくら」UPを得たか追跡できる(即決の自演発覚のような不正調査に使う想定)。書き込みだけ、
// 読み取りは24_AccountCenter/admin側で行う。トランザクション内ではaddDoc()が使えない
// ため、事前にdoc(collection(db,'ukoPointsLog'))でrefを作りtx.set()する。
function ukoPointsLogEntry(userId, amount, type, meta = {}) {
  return { userId, amount, type, meta, createdAt: serverTimestamp() };
}
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

// ===== ログイン状態(入札をアカウント登録者限定にするため。
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
// 入札で競り落とした場合(settleListing)に立てる。
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

// ガチャ券は08_UPoint側で50UP固定(2026-09時点)。開始=券の5分の1という比率で運用する方針
// のため、ここは連動する自動計算ではなく固定値(出品側の14_GenshinOmikuji/auction.jsと
// 同じ値。片方を変更したらもう片方も手動で合わせること)。
const AUCTION_START_PRICE = 25;

// ===== i18n =====
const i18n = {
  ja: {
    pageTitle: 'うーこオークション',
    headerSub: 'うーこの部屋の各サイトで出品されたアイテムを一覧・入札できます',
    empty: '出品されているアイテムはありません',
    startLabel: '開始',
    currentLabel: '現在',
    noBid: 'まだ入札なし',
    bidBtn: '入札する',
    yourListing: '（あなたの出品）',
    timeLeft: (h, m) => `残り${h}時間${m}分`,
    timeLeftMin: (m) => `残り${m}分`,
    ended: '終了処理中…',
    bidPrompt: (min) => `入札額を入力してください（${min}UP以上）`,
    bidTooLow: (min) => `入札額は${min}UP以上にしてください。`,
    bidInvalid: '入札額は整数で入力してください。',
    bidNoPoints: 'UPが足りません。',
    bidOwn: '自分の出品には入札できません。',
    loginRequired: '入札にはアカウント登録（無料）が必要です。登録・ログインしてから利用してください。',
    bidEnded: 'このオークションは終了しています。',
    bidFailed: '入札に失敗しました。時間をおいて再度お試しください。',
    bidDone: '入札しました。',
    myBidsBtn: '自分の入札',
    myBidsEmpty: 'まだ入札した商品はありません',
    badgeWinning: '入札中',
    badgeOutbid: '更新あり',
    badgeOwned: '所持済',
    badgeNotOwned: '未所持',
    badgeCampaign: 'キャンペーン対象',
    statusWinning: '入札中（最高額）',
    statusOutbid: '更新されました（他の人が上回っています）',
    statusWon: '落札しました！',
    statusLost: '落札できませんでした',
    statusUnsold: '流札',
    sortLabel: '並べ替え',
    sortEndingSoon: '残り時間が短い順',
    sortNewest: '新着順',
    sortPriceLow: '価格が安い順',
    sortPriceHigh: '価格が高い順',
    sortBidCount: '入札件数が多い順',
    listingCount: (n) => `${n}件出品中`,
    listingCountMax: (n) => `${n}件以上出品中`,
    listingCountPageSuffix: (page, totalPages) => `（${page}/${totalPages}ページ）`,
    pagerPrevBtn: '前のページ',
    pagerNextBtn: '次のページ',
    campaignBannerSellerBonus: (mult, until) => `🎉 出品者ボーナス開催中！出品が落札されると通常の${mult}倍のUPがもらえます（${until}まで）`,
    campaignBannerListingBonus: (amount, until) => `🎉 出品ボーナス開催中！出品するたび+${amount}UP（${until}まで）`,
    campaignBannerListingCountBonus: (until) => `🎉 出品数ボーナス開催中！出品数に応じてボーナスUPがもらえます（${until}まで）`,
    campaignBannerBidderBonus: (rate, until) => `🎉 落札者キャッシュバック開催中！落札すると支払額の${rate}%がUPで還元されます（${until}まで）`,
    campaignBannerDeferredNote: '※ボーナスUPはキャンペーン終了後、メールでまとめてお届けします（受け取る操作で加算されます）',
    campaignTypeSellerBonus: '出品者ボーナス（落札額×倍率）',
    campaignTypeListingBonus: '出品ボーナス（定額）',
    campaignTypeListingCountBonus: '出品数ボーナス（段階制）',
    campaignTypeBidderBonus: '落札者キャッシュバック（落札額の%還元）',
    campaignDetailTypeLabel: '種類',
    campaignDetailContentLabel: '内容',
    campaignDetailPeriodLabel: '期間',
    campaignDetailMultiplier: (mult) => `×${mult}`,
    campaignDetailBonusAmount: (n) => `出品するたび +${n}UP`,
    campaignDetailTiers: (tiers) => tiers.map((t) => `${t.count}件で+${t.bonus}UP`).join(' / '),
    campaignDetailRate: (rate) => `支払額の${rate}%を還元`,
    campaignDetailPeriodValue: (from, to) => `${from} 〜 ${to}`,
    campaignDetailDeferredNote: 'このボーナス分はキャンペーン終了後、メールでまとめて届きます。',
  },
  en: {
    pageTitle: 'Uko Auction',
    headerSub: 'Browse and bid on items listed across うーこの部屋 sites',
    empty: 'No items are currently listed',
    startLabel: 'Start',
    currentLabel: 'Current',
    noBid: 'No bids yet',
    bidBtn: 'Bid',
    yourListing: '(Your listing)',
    timeLeft: (h, m) => `${h}h ${m}m left`,
    timeLeftMin: (m) => `${m}m left`,
    ended: 'Settling…',
    bidPrompt: (min) => `Enter your bid (${min}UP or more)`,
    bidTooLow: (min) => `Your bid must be at least ${min}UP.`,
    bidInvalid: 'Please enter a whole number.',
    bidNoPoints: 'Not enough UP.',
    bidOwn: "You can't bid on your own listing.",
    loginRequired: 'Bidding requires a free account. Please register and log in first.',
    bidEnded: 'This auction has ended.',
    bidFailed: 'Failed to place bid. Please try again later.',
    bidDone: 'Bid placed!',
    myBidsBtn: 'My Bids',
    myBidsEmpty: "You haven't bid on anything yet",
    badgeWinning: 'Winning',
    badgeOutbid: 'Outbid',
    badgeOwned: 'Owned',
    badgeNotOwned: 'Not owned',
    badgeCampaign: 'Campaign Bonus',
    statusWinning: 'Winning (highest bid)',
    statusOutbid: "Outbid (someone else's bid is higher)",
    statusWon: 'You won it!',
    statusLost: "You didn't win this one",
    statusUnsold: 'Unsold',
    sortLabel: 'Sort',
    sortEndingSoon: 'Ending soon',
    sortNewest: 'Newest',
    sortPriceLow: 'Price: low to high',
    sortPriceHigh: 'Price: high to low',
    sortBidCount: 'Most bids',
    listingCount: (n) => `${n} item${n === 1 ? '' : 's'} listed`,
    listingCountMax: (n) => `${n}+ items listed`,
    listingCountPageSuffix: (page, totalPages) => ` (page ${page}/${totalPages})`,
    pagerPrevBtn: 'Previous',
    pagerNextBtn: 'Next',
    campaignBannerSellerBonus: (mult, until) => `🎉 Seller Bonus is live! Sellers get ${mult}x UP when their listing sells (until ${until})`,
    campaignBannerListingBonus: (amount, until) => `🎉 Listing Bonus is live! +${amount}UP every time you list an item (until ${until})`,
    campaignBannerListingCountBonus: (until) => `🎉 Listing Count Bonus is live! Bonus UP based on how many items you list (until ${until})`,
    campaignBannerBidderBonus: (rate, until) => `🎉 Bidder Cashback is live! Get ${rate}% of what you pay back as UP when you win (until ${until})`,
    campaignBannerDeferredNote: '※ Bonus UP is delivered by mail after the campaign ends (claim it there to receive it)',
    campaignTypeSellerBonus: 'Seller Bonus (sale price × multiplier)',
    campaignTypeListingBonus: 'Listing Bonus (flat)',
    campaignTypeListingCountBonus: 'Listing Count Bonus (tiered)',
    campaignTypeBidderBonus: 'Bidder Cashback (% of sale price)',
    campaignDetailTypeLabel: 'Type',
    campaignDetailContentLabel: 'Details',
    campaignDetailPeriodLabel: 'Period',
    campaignDetailMultiplier: (mult) => `×${mult}`,
    campaignDetailBonusAmount: (n) => `+${n}UP every time you list`,
    campaignDetailTiers: (tiers) => tiers.map((t) => `${t.count} listings → +${t.bonus}UP`).join(' / '),
    campaignDetailRate: (rate) => `${rate}% of what you pay is refunded`,
    campaignDetailPeriodValue: (from, to) => `${from} – ${to}`,
    campaignDetailDeferredNote: 'This bonus is delivered by mail after the campaign ends.',
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
  updateListingCount();
  renderCampaignBanner();
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

// ===== 期間限定キャンペーン(ukoAuctionCampaigns, 2026-09-18追加) =====
// 作成・編集は24_AccountCenter/admin/(既存の管理者画面、ログイン式の管理者
// 認証があるため、こちらの匿名Firebase Auth uid判定より確実)の「うーこオークション
// キャンペーン管理」セクションで行う。このファイルは読み取り専用
// (アクティブなキャンペーンを見て自動適用する側)。type別に持つフィールドが違う:
//   sellerBonus:       multiplier(落札額に掛ける倍率。落札額×multiplierを出品者に渡す)
//   listingBonus:      bonusAmount(出品するたび即座にもらえる定額UP。14_GenshinOmikuji側で適用)
//   listingCountBonus: tiers([{count,bonus}, ...]。期間中の出品数が閾値を超えるたび
//                      そのtierのbonusをもらえる。14_GenshinOmikuji側で適用・進捗管理)
//   bidderBonus:       rate(落札額に対する還元率%。支払額はそのままに、
//                      rate%分を別途UPで落札者へ還元する)
// enabledは緊急停止用(期間内でもfalseなら無効)。複数のキャンペーンを同時開催できる
// (同じtypeが複数アクティブな場合、sellerBonus/bidderBonusは最大値を採用、
// listingBonus/listingCountBonusは合算する。それぞれの関数のコメント参照)。
// adminOnly(2026-09-20追加): テスト中のキャンペーンを一般ユーザーに見せず・適用もしない
// ためのフラグ。うこ氏サイト群共通ロール(sharedUserRoles、匿名ID直接キー、FriendBoard/
// 24_AccountCenterと同じ仕組み)がadminの人にだけ、バナー表示・ボーナス適用の両方が効く。
let latestCampaigns = [];
let isAdminRole = false;

async function loadMyRole() {
  try {
    const snap = await getDoc(doc(db, 'sharedUserRoles', getUserId()));
    isAdminRole = snap.exists() && snap.data().role === 'admin';
  } catch (e) {
    console.error('[auction] role load failed', e);
  }
  renderCampaignBanner();
}

function initCampaigns() {
  onSnapshot(collection(db, 'ukoAuctionCampaigns'), (snap) => {
    latestCampaigns = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderCampaignBanner();
  }, (err) => console.error('[auction] campaigns listen failed', err));
}

function isCampaignActive(c) {
  if (!c.enabled) return false;
  if (c.adminOnly && !isAdminRole) return false;
  const now = Date.now();
  return c.startsAt?.toMillis() <= now && now <= c.endsAt?.toMillis();
}

function activeCampaignsOfType(type) {
  return latestCampaigns.filter((c) => c.type === type && isCampaignActive(c));
}

// 同時に複数のsellerBonusキャンペーンが有効な場合、乗算で重ねると際限なく増えて
// しまうため、最大倍率のものだけを採用する(1つも無ければnull)。UP取得履歴に
// campaignId(2026-09-20追加、キャンペーンごとの集計メール送信で「どのキャンペーンで
// 稼いだか」を追うために使う)を残す都合上、倍率の数値だけでなく採用した
// キャンペーンのドキュメント自体を返す。
function bestActiveSellerBonusCampaign() {
  const active = activeCampaignsOfType('sellerBonus');
  if (!active.length) return null;
  return active.reduce((best, c) => ((c.multiplier || 1) > (best.multiplier || 1) ? c : best));
}

// 落札者(買う側)向けのキャッシュバック。落札額はそのまま支払った上で、
// 落札額のrate%が別途UPで還元される。sellerBonusと同じ理由で、複数有効な場合も
// 合算せず最大rateのものだけを採用する(1つも無ければnull)。
function bestActiveBidderBonusCampaign() {
  const active = activeCampaignsOfType('bidderBonus');
  if (!active.length) return null;
  return active.reduce((best, c) => ((c.rate || 0) > (best.rate || 0) ? c : best));
}

// 「落札時ボーナス」系(sellerBonus/bidderBonus)のキャンペーンが今どれか1つでも
// 有効かどうか。判定が落札確定の瞬間に効くようになった(このファイル冒頭の
// settleListingコメント参照)ため、これは特定の出品だけの性質ではなく「今このタイミングで
// 落札すれば(誰の出品でも)対象になるかどうか」という全出品共通の状態。出品カード/
// タイルのバッジは、キャンペーン期間中は全件に一律で出ることになる(意図通り)。
function hasActiveSettlementCampaign() {
  return activeCampaignsOfType('sellerBonus').length > 0 || activeCampaignsOfType('bidderBonus').length > 0;
}

// ===== 期限切れオークションの精算（誰かが一覧を開いた時に遅延実行する） =====
// sellerBonus/bidderBonusは「落札時ボーナス／落札者キャッシュバック」という名前通り、
// 精算(＝落札確定)した瞬間にキャンペーンが有効かどうかで判定する(2026-09-20、出品時点
// スナップショット方式から名前に忠実な仕様へ変更)。出品した時点で開催中だったかは
// 見ない。そのぶん、短い開催期間だと「出品した時は開催中だったのに落札時には終わって
// 恩恵が付かない」ことが起こり得るが、それは名前通りの挙動として許容する
// (キャンペーン期間を出品期間より長めに取るなど運用側で調整する)。
// ボーナス分は即時付与しない(2026-09-20変更): 基本の売買代金(落札額そのまま/支払った
// 満額)はこれまで通りここで即座に渡すが、キャンペーンによる上乗せ・還元分だけは
// ukoPointsLogに記録するのみに留め、実際のukoPoints増加は24_AccountCenter/adminの
// 「集計メール送信」でキャンペーン終了後にまとめて送るメール経由(受け取る操作で
// 付与)に一本化した。理由: 出品/落札した瞬間に増額分だけ即もらえてしまうと、
// 「キャンペーンのボーナスは終了後メールで」という他の3種と扱いがバラバラになるため。
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
          // bidderBonusキャンペーンが落札確定した今この瞬間に有効なら、対象額を記録する
          // (実際のukoPoints付与はキャンペーン終了後の集計メール経由、上のコメント参照)。
          const bidderCampaign = bestActiveBidderBonusCampaign();
          const cashback = bidderCampaign ? Math.round(d.currentBid * (bidderCampaign.rate || 0) / 100) : 0;
          const winnerUpdates = {
            [d.returnField]: increment(1),
            [`missionsAchieved.${AUCTION_WIN_MISSION_CLAIM_KEY}`]: true,
          };
          if (cashback > 0) {
            // campaignId/campaignType(2026-09-20追加): 24_AccountCenter/adminの
            // キャンペーンごとの集計メール送信が「どのキャンペーンで稼いだか」を
            // 後から追え、かつそのメールが実際の付与手段になる。ここではukoPointsは
            // 増やさない。
            tx.set(doc(collection(db, 'ukoPointsLog')), ukoPointsLogEntry(
              d.currentBidderId, cashback, 'auctionCashback',
              { listingId, itemName: d.itemName, campaignId: bidderCampaign.id, campaignType: 'bidderBonus' }
            ));
          }
          tx.update(winnerRef, winnerUpdates);
        }
        if (sellerSnap.exists()) {
          // 基本の落札代金(落札額そのまま)はこれまで通りここで即座に渡す。sellerBonus
          // キャンペーンによる上乗せ分(倍率−1倍ぶん)は記録だけして即時には渡さない
          // (キャンペーン終了後の集計メール経由、上のコメント参照)。ボーナス分は
          // campaignId付きの別ログ(auctionSaleBonus)に分けて記録する(通常の売上ログ
          // auctionSaleと合算しないことで、キャンペーンごとの集計メールが正確なボーナス額
          // だけを拾えるようにするため、2026-09-20追加)。
          const sellerCampaign = bestActiveSellerBonusCampaign();
          const multiplier = sellerCampaign ? Math.max(1, sellerCampaign.multiplier || 1) : 1;
          const bonusPoints = Math.round(d.currentBid * multiplier);
          tx.update(sellerRef, { ukoPoints: increment(d.currentBid) });
          tx.set(doc(collection(db, 'ukoPointsLog')), ukoPointsLogEntry(
            d.sellerId, d.currentBid, 'auctionSale', { listingId, itemName: d.itemName, soldPrice: d.currentBid }
          ));
          const sellerBonusDelta = bonusPoints - d.currentBid;
          if (sellerBonusDelta > 0 && sellerCampaign) {
            tx.set(doc(collection(db, 'ukoPointsLog')), ukoPointsLogEntry(
              d.sellerId, sellerBonusDelta, 'auctionSaleBonus',
              { listingId, itemName: d.itemName, campaignId: sellerCampaign.id, campaignType: 'sellerBonus' }
            ));
          }
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
        bidCount: increment(1),
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

// 自分が既に持っている裏面デザイン(所持済/未所持バッジ用)。myBidsと同じ
// omikujiUsers/{自分}購読に相乗りさせる(別途購読を増やさないため)。
let myCardBacks = {};

function initMyBidsTracking() {
  const myUserId = getUserId();
  onSnapshot(doc(db, 'omikujiUsers', myUserId), (snap) => {
    const data = snap.exists() ? snap.data() : {};
    myBidListingIds = data.myBids || [];
    myCardBacks = data.cardBacks || {};
    syncMyBidListeners();
    updateMyBidsBadge();
    renderAuctionList(latestListings);
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

// ===== キャンペーンお知らせバナー =====
function fmtCampaignDate(ts) {
  if (!ts || typeof ts.toMillis !== 'function') return '';
  const d = new Date(ts.toMillis());
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function campaignSummaryText(c) {
  const until = fmtCampaignDate(c.endsAt);
  if (c.type === 'sellerBonus') return s().campaignBannerSellerBonus(c.multiplier, until);
  if (c.type === 'listingBonus') return s().campaignBannerListingBonus(c.bonusAmount, until);
  if (c.type === 'listingCountBonus') return s().campaignBannerListingCountBonus(until);
  if (c.type === 'bidderBonus') return s().campaignBannerBidderBonus(c.rate, until);
  return '';
}

// ===== キャンペーン詳細ポップ(バナー右上の「？」から開く、2026-09-20追加) =====
function campaignTypeLabel(c) {
  if (c.type === 'sellerBonus') return s().campaignTypeSellerBonus;
  if (c.type === 'listingBonus') return s().campaignTypeListingBonus;
  if (c.type === 'listingCountBonus') return s().campaignTypeListingCountBonus;
  if (c.type === 'bidderBonus') return s().campaignTypeBidderBonus;
  return c.type;
}

function campaignDetailValueText(c) {
  if (c.type === 'sellerBonus') return s().campaignDetailMultiplier(c.multiplier);
  if (c.type === 'listingBonus') return s().campaignDetailBonusAmount(c.bonusAmount);
  if (c.type === 'listingCountBonus') return s().campaignDetailTiers(c.tiers || []);
  if (c.type === 'bidderBonus') return s().campaignDetailRate(c.rate);
  return '';
}

function openCampaignDetailModal(c) {
  const modal = document.getElementById('campaign-detail-modal');
  const title = document.getElementById('campaign-detail-title');
  const body = document.getElementById('campaign-detail-body');
  if (!modal || !title || !body) return;
  title.textContent = campaignTypeLabel(c);
  const period = s().campaignDetailPeriodValue(fmtCampaignDate(c.startsAt), fmtCampaignDate(c.endsAt));
  body.innerHTML = `
    <div class="campaign-detail-row"><span class="campaign-detail-label">${escapeHtmlLite(s().campaignDetailTypeLabel)}</span><span>${escapeHtmlLite(campaignTypeLabel(c))}</span></div>
    <div class="campaign-detail-row"><span class="campaign-detail-label">${escapeHtmlLite(s().campaignDetailContentLabel)}</span><span>${escapeHtmlLite(campaignDetailValueText(c))}</span></div>
    <div class="campaign-detail-row"><span class="campaign-detail-label">${escapeHtmlLite(s().campaignDetailPeriodLabel)}</span><span>${escapeHtmlLite(period)}</span></div>
    <div class="campaign-detail-note">${escapeHtmlLite(s().campaignDetailDeferredNote)}</div>
  `;
  modal.style.display = 'flex';
}

function closeCampaignDetailModal() {
  const modal = document.getElementById('campaign-detail-modal');
  if (modal) modal.style.display = 'none';
}

// このファイルには汎用のescapeHtmlが無いため(サーバー生成でなくFirestoreの値を
// そのままinnerHTMLへ入れる箇所がここだけなので)、最小限のエスケープだけ用意する。
function escapeHtmlLite(str) {
  return String(str ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// 種類ごとの既定バナー(99_SharedImage、2026-09-20追加)。typeから自動で対応する画像を
// 出す(バナーURLの個別指定は「変えることがないから」2026-09-20に廃止、種類ごとに固定)。
// 24_AccountCenter/admin/admin.jsのプレビュー表示にも同じ内容を持たせているので、
// 画像を差し替えたらそちらも合わせること。
const CAMPAIGN_TYPE_BANNER_URLS = {
  listingBonus: 'https://cdn.jsdelivr.net/gh/uko05/99_SharedImage@main/01_Genshin/auction/%E5%87%BA%E5%93%81%E5%8D%B3%E6%99%82%E3%83%9C%E3%83%BC%E3%83%8A%E3%82%B9.png',
  sellerBonus: 'https://cdn.jsdelivr.net/gh/uko05/99_SharedImage@main/01_Genshin/auction/%E8%90%BD%E6%9C%AD%E6%99%82%E3%83%9C%E3%83%BC%E3%83%8A%E3%82%B9.png',
  listingCountBonus: 'https://cdn.jsdelivr.net/gh/uko05/99_SharedImage@main/01_Genshin/auction/%E5%87%BA%E5%93%81%E6%95%B0%E3%83%9C%E3%83%BC%E3%83%8A%E3%82%B9.png',
  bidderBonus: 'https://cdn.jsdelivr.net/gh/uko05/99_SharedImage@main/01_Genshin/auction/%E8%90%BD%E6%9C%AD%E6%99%82%E3%82%AD%E3%83%A3%E3%83%83%E3%82%B7%E3%83%A5%E3%83%90%E3%83%83%E3%82%AF.png',
};

// 複数のキャンペーンが同時開催中の場合、ここでactive全件をループしているので、
// バナー・文言ともそれぞれ分の行が積み重なって表示される(1つに絞らない)。
function renderCampaignBanner() {
  const el = document.getElementById('campaign-banner');
  if (!el) return;
  const active = latestCampaigns.filter(isCampaignActive);
  el.innerHTML = '';
  el.hidden = active.length === 0;
  active.forEach((c) => {
    const bannerUrl = CAMPAIGN_TYPE_BANNER_URLS[c.type];
    if (bannerUrl) {
      const wrap = document.createElement('div');
      wrap.className = 'campaign-banner-item';

      const img = document.createElement('img');
      img.className = 'campaign-banner-img';
      img.src = bannerUrl;
      img.alt = campaignTypeLabel(c);
      wrap.appendChild(img);

      // バナー右上の「？」: 押すとそのキャンペーンの種類・内容・期間を詳細ポップで見せる。
      const infoBtn = document.createElement('button');
      infoBtn.type = 'button';
      infoBtn.className = 'campaign-banner-info-btn';
      infoBtn.textContent = '？';
      infoBtn.setAttribute('aria-label', 'キャンペーン詳細');
      infoBtn.addEventListener('click', () => openCampaignDetailModal(c));
      wrap.appendChild(infoBtn);

      el.appendChild(wrap);
    }
    const row = document.createElement('div');
    row.textContent = campaignSummaryText(c);
    el.appendChild(row);
  });
  // ボーナスUP自体は即時付与ではなくキャンペーン終了後の集計メール経由(2026-09-20変更)
  // なので、そのことを一度だけ案内しておく(バナーごとに繰り返さない)。
  if (active.length > 0) {
    const note = document.createElement('div');
    note.className = 'campaign-banner-note';
    note.textContent = s().campaignBannerDeferredNote;
    el.appendChild(note);
  }
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

// ===== ページ送り(2026-09-20追加) =====
// 以前はFirestoreクエリのlimit自体が100件で、101件目以降がそもそも一覧に出てこなかった
// (「100件以上出品中」の表示はここで頭打ちになっていることの目印だった)。クエリの
// limitを大きく引き上げ(AUCTION_LIST_QUERY_LIMIT)、代わりに表示側でAUCTION_PAGE_SIZE
// 件ずつのページ送りにすることで、実在する出品を漏れなくたどれるようにした。
const AUCTION_PAGE_SIZE = 50;
let auctionCurrentPage = 1;

// ===== 並べ替え =====
const AUCTION_SORT_KEY = 'ukoAuction_sortMode';
function getSortMode() {
  return localStorage.getItem(AUCTION_SORT_KEY) || 'endingSoon';
}
function effectivePrice(listing) {
  return listing.currentBid > 0 ? listing.currentBid : listing.startPrice;
}
function sortListings(listings) {
  const sorted = listings.slice();
  switch (getSortMode()) {
    case 'newest':
      sorted.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
      break;
    case 'priceLow':
      sorted.sort((a, b) => effectivePrice(a) - effectivePrice(b));
      break;
    case 'priceHigh':
      sorted.sort((a, b) => effectivePrice(b) - effectivePrice(a));
      break;
    case 'bidCount':
      sorted.sort((a, b) => (b.bidCount || 0) - (a.bidCount || 0));
      break;
    case 'endingSoon':
    default:
      sorted.sort((a, b) => (a.endsAt?.toMillis?.() || 0) - (b.endsAt?.toMillis?.() || 0));
      break;
  }
  return sorted;
}
function initSortSelect() {
  const select = document.getElementById('auction-sort-select');
  if (!select) return;
  select.value = getSortMode();
  select.addEventListener('change', () => {
    localStorage.setItem(AUCTION_SORT_KEY, select.value);
    auctionCurrentPage = 1;
    renderAuctionList(latestListings);
    updateListingCount();
  });
}

// ===== 表示モード(リスト/グリッド) =====
// 出品数が増えてきた時に見渡しやすいよう、ヤフオク風の正方形サムネ+価格+残り時間
// だけのグリッド表示に切り替えられるようにした(2026-09-18)。並べ替えと同じく
// localStorageに保存し、次回訪問時も直前のモードを覚えている。
const AUCTION_VIEW_KEY = 'ukoAuction_viewMode';
function getViewMode() {
  return localStorage.getItem(AUCTION_VIEW_KEY) === 'grid' ? 'grid' : 'list';
}
function initViewToggle() {
  const listBtn = document.getElementById('auction-view-list-btn');
  const gridBtn = document.getElementById('auction-view-grid-btn');
  const applyActive = () => {
    const mode = getViewMode();
    listBtn?.classList.toggle('active', mode === 'list');
    gridBtn?.classList.toggle('active', mode === 'grid');
  };
  applyActive();
  listBtn?.addEventListener('click', () => {
    localStorage.setItem(AUCTION_VIEW_KEY, 'list');
    applyActive();
    renderAuctionList(latestListings);
  });
  gridBtn?.addEventListener('click', () => {
    localStorage.setItem(AUCTION_VIEW_KEY, 'grid');
    applyActive();
    renderAuctionList(latestListings);
  });
}

// ===== カード描画(リスト表示。従来通りの横長カード、ボタンが全部並ぶ) =====
function buildListCard(listing, myUserId, isExpired) {
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

  // 所持済/未所持バッジ。今のところ出品元はomikujiのみで、所持数は
  // omikujiUsers.cardBacksでしか判定できないため、siteKeyで絞っておく
  // (将来他サイトが出品するようになった時、誤判定を出さないため)。
  if (listing.siteKey === 'omikuji') {
    const owned = (myCardBacks[listing.itemId] || 0) > 0;
    const ownedEl = document.createElement('span');
    ownedEl.className = `auction-card-owned auction-card-owned-${owned ? 'yes' : 'no'}`;
    ownedEl.textContent = owned ? s().badgeOwned : s().badgeNotOwned;
    info.appendChild(ownedEl);
  }

  // キャンペーン対象バッジ。所持済/未所持のすぐ下(別行)に出したいので、
  // display:blockにしてある(他のバッジは横並びのinline-block)。落札確定時に効く
  // キャンペーンなので、期間中は出品を問わず一律で全カードに出る(意図通り)。
  if (hasActiveSettlementCampaign()) {
    const campaignEl = document.createElement('span');
    campaignEl.className = 'auction-card-campaign';
    campaignEl.textContent = s().badgeCampaign;
    info.appendChild(campaignEl);
  }

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
  }
  card.appendChild(actions);

  return card;
}

// ===== タイル描画(グリッド表示。ヤフオク風、正方形サムネ+価格+残り時間の最小限セット) =====
// タイル全体のクリックで入札ポップを開く(リスト表示の「入札する」ボタンと同じ動線)。
// 自分の出品はクリックしても何も起きない画像拡大だけにする(入札できないため)。
function buildGridTile(listing, myUserId, isExpired) {
  const tile = document.createElement('div');
  tile.className = 'auction-tile';
  tile.dataset.listingId = listing.id;

  const imgWrap = document.createElement('div');
  imgWrap.className = 'auction-tile-img-wrap';

  const img = document.createElement('img');
  img.className = 'auction-tile-img';
  img.src = listing.itemImageUrl;
  img.alt = listing.itemName;
  img.loading = 'lazy';
  imgWrap.appendChild(img);

  if (listing.siteKey === 'omikuji') {
    const owned = (myCardBacks[listing.itemId] || 0) > 0;
    const ownedBadge = document.createElement('span');
    ownedBadge.className = `auction-tile-owned auction-tile-owned-${owned ? 'yes' : 'no'}`;
    ownedBadge.textContent = owned ? s().badgeOwned : s().badgeNotOwned;
    imgWrap.appendChild(ownedBadge);
  }

  // キャンペーン対象バッジ。所持済/未所持バッジのすぐ下に重ねる。落札確定時に効く
  // キャンペーンなので、期間中は出品を問わず一律で全タイルに出る(意図通り)。
  if (hasActiveSettlementCampaign()) {
    const campaignBadge = document.createElement('span');
    campaignBadge.className = 'auction-tile-campaign';
    campaignBadge.textContent = s().badgeCampaign;
    imgWrap.appendChild(campaignBadge);
  }

  const isMine = listing.sellerId === myUserId;

  if (isMine) {
    const mine = document.createElement('span');
    mine.className = 'auction-tile-mine-badge';
    mine.textContent = s().yourListing;
    imgWrap.appendChild(mine);
  }

  // 自分の入札ステータス(入札中/更新あり)。サムネに重ねて、下寄せの小さいバッジで表示する
  // (画像上部は所持済/未所持ドットが既にあるため)。
  if (!isMine && myBidListingIds.includes(listing.id)) {
    const trackedData = myBidListingsData.get(listing.id) || listing;
    const myStatus = myBidStatus(trackedData, myUserId);
    if (myStatus === 'winning' || myStatus === 'outbid') {
      const statusEl = document.createElement('span');
      statusEl.className = `auction-tile-mystatus auction-tile-mystatus-${myStatus}`;
      statusEl.textContent = myStatus === 'winning' ? s().badgeWinning : s().badgeOutbid;
      imgWrap.appendChild(statusEl);
    }
  }

  tile.appendChild(imgWrap);

  const price = document.createElement('div');
  price.className = 'auction-tile-price';
  price.textContent = listing.currentBid > 0 ? `${listing.currentBid}UP` : `${listing.startPrice}UP`;
  tile.appendChild(price);

  const time = document.createElement('div');
  time.className = 'auction-tile-time';
  time.textContent = isExpired ? s().ended : fmtTimeLeft(listing.endsAt);
  tile.appendChild(time);

  if (!isMine && !isExpired) {
    tile.addEventListener('click', async () => {
      if (!(await isLoggedIn())) { showToast(s().loginRequired, true); return; }
      openBidModal(listing);
    });
  } else {
    tile.addEventListener('click', () => openLightbox(listing.itemImageUrl));
  }

  return tile;
}

function renderAuctionList(rawListings) {
  const listEl = document.getElementById('auction-list');
  const pagerEl = document.getElementById('auction-pager');
  if (!listEl) return;
  const myUserId = getUserId();
  const listings = sortListings(rawListings);
  const mode = getViewMode();
  listEl.className = mode === 'grid' ? 'auction-list-grid' : 'auction-list';
  listEl.innerHTML = '';
  if (pagerEl) pagerEl.innerHTML = '';

  if (listings.length === 0) {
    const p = document.createElement('p');
    p.className = 'auction-empty';
    p.textContent = s().empty;
    listEl.appendChild(p);
    return;
  }

  // 期限切れの精算トリガーはページ全体(全件)に対して行う。表示だけ後で
  // ページ単位に絞るので、2ページ目以降にある期限切れ出品も誰かがサイトを
  // 開いた時点でちゃんと精算される。
  listings.forEach((listing) => {
    const isExpired = listing.endsAt && listing.endsAt.toMillis() <= Date.now();
    if (isExpired) settleListing(listing.id);
  });

  const totalPages = Math.max(1, Math.ceil(listings.length / AUCTION_PAGE_SIZE));
  auctionCurrentPage = Math.min(Math.max(1, auctionCurrentPage), totalPages);
  const pageStart = (auctionCurrentPage - 1) * AUCTION_PAGE_SIZE;
  const pageListings = listings.slice(pageStart, pageStart + AUCTION_PAGE_SIZE);

  pageListings.forEach((listing) => {
    const isExpired = listing.endsAt && listing.endsAt.toMillis() <= Date.now();
    const node = mode === 'grid'
      ? buildGridTile(listing, myUserId, isExpired)
      : buildListCard(listing, myUserId, isExpired);
    listEl.appendChild(node);
  });

  if (pagerEl && totalPages > 1) {
    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'auction-pager-btn';
    prevBtn.textContent = s().pagerPrevBtn;
    prevBtn.disabled = auctionCurrentPage <= 1;
    prevBtn.addEventListener('click', () => {
      auctionCurrentPage -= 1;
      renderAuctionList(latestListings);
      updateListingCount();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    const label = document.createElement('span');
    label.className = 'auction-pager-label';
    label.textContent = `${auctionCurrentPage} / ${totalPages}`;

    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'auction-pager-btn';
    nextBtn.textContent = s().pagerNextBtn;
    nextBtn.disabled = auctionCurrentPage >= totalPages;
    nextBtn.addEventListener('click', () => {
      auctionCurrentPage += 1;
      renderAuctionList(latestListings);
      updateListingCount();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    pagerEl.appendChild(prevBtn);
    pagerEl.appendChild(label);
    pagerEl.appendChild(nextBtn);
  }

  // ディープリンク(?listing=<id>)で来た場合、該当アイテムが見つかり次第、入札ポップを自動で開く
  // (ページを跨いでいても全件(listings)から探す。一度開いたら、閉じた後の再描画で
  // 再度開かないようにdeepLinkHandledで一回だけに制限する)
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

// ===== 出品件数表示 =====
// 一覧クエリのlimit件数と同じ値を上限として持っておき、万一これに達するほど出品が
// 積み上がった場合は「ちょうどこの件数」ではなく「以上」であることが伝わる表示にする
// (通常の運用では実質無制限とみなせる件数にしてある)。表示自体はAUCTION_PAGE_SIZE件
// ずつのページ送りなので、この件数分すべてたどって見られる。
const AUCTION_LIST_QUERY_LIMIT = 500;
function updateListingCount() {
  const el = document.getElementById('auction-listing-count');
  if (!el) return;
  const count = latestListings.length;
  const base = count >= AUCTION_LIST_QUERY_LIMIT ? s().listingCountMax(count) : s().listingCount(count);
  const totalPages = Math.max(1, Math.ceil(count / AUCTION_PAGE_SIZE));
  el.textContent = totalPages > 1 ? base + s().listingCountPageSuffix(auctionCurrentPage, totalPages) : base;
}

// ===== 初期化 =====
function initAuctionList() {
  const q = query(
    collection(db, 'ukoMarketListings'),
    where('status', '==', 'active'),
    orderBy('endsAt', 'asc'),
    limit(AUCTION_LIST_QUERY_LIMIT)
  );
  onSnapshot(q, (snap) => {
    latestListings = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAuctionList(latestListings);
    updateListingCount();
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

  const campaignDetailClose = document.getElementById('campaign-detail-close');
  if (campaignDetailClose) campaignDetailClose.addEventListener('click', closeCampaignDetailModal);
  const campaignDetailBackdrop = document.querySelector('#campaign-detail-modal .col-modal-backdrop');
  if (campaignDetailBackdrop) campaignDetailBackdrop.addEventListener('click', closeCampaignDetailModal);

  const lightbox = document.getElementById('auction-lightbox');
  if (lightbox) lightbox.addEventListener('click', () => lightbox.classList.remove('visible'));

  const myBidsBtn = document.getElementById('auction-mybids-btn');
  if (myBidsBtn) myBidsBtn.addEventListener('click', openMyBidsModal);
  const myBidsClose = document.getElementById('auction-mybids-close');
  if (myBidsClose) myBidsClose.addEventListener('click', closeMyBidsModal);
  const myBidsBackdrop = document.querySelector('#auction-mybids-modal .col-modal-backdrop');
  if (myBidsBackdrop) myBidsBackdrop.addEventListener('click', closeMyBidsModal);

  initMyBidsTracking();
  loadMyRole();
  initCampaigns();
  initSortSelect();
  initViewToggle();
}

initLangSwitch();
initAuctionList();
