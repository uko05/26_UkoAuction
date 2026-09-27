// firebaseConfig.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCP4QfMGDDBSI8VDERnESBOlHpUhy7wGPk",
  authDomain: "genshin-bakatare01.firebaseapp.com",
  projectId: "genshin-bakatare01",
  storageBucket: "genshin-bakatare01.firebasestorage.app",
  messagingSenderId: "658089418604",
  appId: "1:658089418604:web:288c06b331da8c4f789d49"
};

export const app = initializeApp(firebaseConfig);
// 永続キャッシュ(IndexedDB、2026-09-27追加): visibleListener.jsで購読を止めて再開した時や
// 30分以内のリロード時に、変わったドキュメントだけの読み取りで済ませるため。
// 複数タブで開いても共有できるようmultipleTabManagerを使う。IndexedDBが使えない環境
// (一部のプライベートブラウズ等)ではSDKが自動でメモリキャッシュにフォールバックする。
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
