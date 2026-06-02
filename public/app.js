// ============================================================
// app.js - 声のペルソナ フロントエンドロジック（ファイルアップロード版）
//
// 処理の全体フロー：
//   1. ユーザーが音声ファイルをアップロード
//   2. サーバー /api/recognize に送る
//      → サーバーは AmiVoice 非同期 HTTP API（v1）にジョブ投入 + ポーリング
//      → 認識テキストと感情分析スコア（10種）を取得
//   3. 話速・口調を分析
//   4. 認識テキスト・感情スコア・状態をまとめて /api/chat へ
//      → サーバーが Claude API を呼び NPC の返答を取得
//   5. NPC ステータスを更新して UI に反映
// ============================================================

// ── NPC の状態管理 ─────────────────────────────────────────
const npcState = {
  affection: 50,        // 好感度（0-100）
  trust: 50,            // 信頼度（0-100）
  irritation: 0,        // 苛立ち度（0-100）
  conversationCount: 0, // 会話回数
  history: [],          // 直近5件の会話履歴（将来の拡張用）
};

// ── 選択中のキャラクター ────────────────────────────────────
// characterId はサーバーの CHARACTERS オブジェクトのキーと対応する
let currentCharacterId = "gard";

// ── DOM 参照 ────────────────────────────────────────────────
const audioFileInput = document.getElementById("audioFile");
const uploadLabelEl = document.getElementById("uploadLabel");
const uploadWrapper = document.querySelector(".upload-label");
const recognitionText = document.getElementById("recognitionText");
const npcSpeech = document.getElementById("npcSpeech");
const npcEmotion = document.getElementById("npcEmotion");
const npcAvatar = document.getElementById("npcAvatar");
const npcName = document.getElementById("npcName");
const speedBadge = document.getElementById("speedBadge");
const emotionBadge = document.getElementById("emotionBadge");
const toneBadge = document.getElementById("toneBadge");
const confidenceBadge = document.getElementById("confidenceBadge");
const errorMessage = document.getElementById("errorMessage");
const loadingIndicator = document.getElementById("loadingIndicator");
const conversationCount = document.getElementById("conversationCount");
const characterSelector = document.getElementById("characterSelector");
const sentimentScoresEl = document.getElementById("sentimentScores");

// AmiVoice 感情パラメータ定義（公式仕様。サーバーと同じ）
// 表示順は「有意になりやすい補助指標 → 主要指標 → 特殊」の順
const SENTIMENT_DISPLAY = [
  { key: "aggression",          jp: "攻撃性憤り", hint: ">0で有意" },
  { key: "upset",               jp: "動揺",      hint: ">0で有意" },
  { key: "content",             jp: "喜び",      hint: ">0で有意" },
  { key: "dissatisfaction",     jp: "不満",      hint: ">0で有意" },
  { key: "passionate",          jp: "情熱",      hint: ">0で有意" },
  { key: "embarrassment",       jp: "困惑",      hint: ">0で有意" },
  { key: "imagination_activity",jp: "想像力",    hint: ">0で有意" },
  { key: "extreme_emotion",     jp: "極端な起伏", hint: ">0で有意" },
  { key: "excitement",          jp: "興奮",      hint: "通常15前後" },
  { key: "hesitation",          jp: "躊躇",      hint: "通常15前後" },
  { key: "uncertainty",         jp: "不確実",    hint: "通常15前後" },
  { key: "confidence",          jp: "自信",      hint: "通常15前後" },
  { key: "energy",              jp: "エネルギー", hint: "0-100" },
  { key: "stress",              jp: "ストレス",   hint: "0-100" },
  { key: "concentration",       jp: "集中",      hint: "0-100" },
  { key: "anticipation",        jp: "期待",      hint: "0-100" },
  { key: "intensive_thinking",  jp: "思考",      hint: "0-100" },
  { key: "brain_power",         jp: "脳活動",    hint: "0-100" },
  { key: "atmosphere",          jp: "雰囲気",    hint: "-100〜100" },
  { key: "emo_cog",             jp: "感情/論理", hint: "1-500" },
];

// ============================================================
// 初期化
// ============================================================
(function init() {
  audioFileInput.addEventListener("change", handleAudioFileUpload);

  // キャラクター選択カードのクリックイベントを一括登録
  characterSelector.addEventListener("click", (e) => {
    const card = e.target.closest(".char-card");
    if (!card) return;
    selectCharacter(card.dataset.charId);
  });
})();

// ============================================================
// キャラクター切替
// ステータスをリセットして、選択したキャラクターの初期状態に戻す
// ============================================================
function selectCharacter(charId) {
  currentCharacterId = charId;

  document.querySelectorAll(".char-card").forEach(card => {
    card.classList.toggle("active", card.dataset.charId === charId);
  });

  // NPCステータスをリセット
  npcState.affection = 50;
  npcState.trust = 50;
  npcState.irritation = 0;
  npcState.conversationCount = 0;
  npcState.history = [];

  const charConfig = {
    gard: {
      image: "images/ガルド.png",
      name: "情報屋 ガルド",
      greeting: "ふむ。何の話じゃ？聞くくらいはしてやるわい。",
      emotion: "様子を伺っている",
    },
    lilia: {
      image: "images/リリア.png",
      name: "気まぐれな魔女 リリア",
      greeting: "ねえねえ、なになに？暇だったし聞いてあげる！",
      emotion: "気まぐれな気分",
    },
    crow: {
      image: "images/クロウ.png",
      name: "賞金稼ぎ クロウ",
      greeting: "…なんだ。話してみろ。",
      emotion: "無表情",
    },
    zet: {
      image: "images/ゼット.png",
      name: "怪しい商人 ゼット",
      greeting: "おやおや、お話があるようですね。どうぞ、聞かせてください。ふふふ。",
      emotion: "営業スマイル",
    },
  };

  const config = charConfig[charId] ?? charConfig.gard;

  npcAvatar.innerHTML = `<img src="${config.image}" alt="${config.name}" onerror="this.style.display='none';this.parentElement.textContent='👤'">`;
  npcAvatar.className = "npc-avatar";
  npcName.textContent = config.name;
  npcSpeech.textContent = config.greeting;
  npcEmotion.textContent = config.emotion;

  document.getElementById("affectionBar").style.width = "50%";
  document.getElementById("trustBar").style.width = "50%";
  document.getElementById("irritationBar").style.width = "0%";
  document.getElementById("affectionValue").textContent = "50";
  document.getElementById("trustValue").textContent = "50";
  document.getElementById("irritationValue").textContent = "0";
  conversationCount.textContent = "0";

  clearError();
}

// ============================================================
// AmiVoice の認識結果がプレースホルダー（無音/不明瞭時の "..."）か判定
//
// AmiVoice は音声を認識できなかった場合、空文字や "..." / "…" / "・・・"
// などの記号だけを返してくることがある。これらを Claude に投げても
// 「何か言いかけて止まった」のような不自然な応答になるので弾く。
// ============================================================
function isPlaceholderText(text) {
  if (!text) return true;
  const stripped = text.replace(/[.．。、，,\s…・]/g, "");
  return stripped.length === 0;
}

// ============================================================
// 音声ファイルアップロード処理
//
// サーバーの /api/recognize に音声ファイルをそのまま送る。
// サーバー側で AmiVoice 非同期 HTTP API（v1）にジョブを投入し、
// ポーリングで完了を待ってからテキスト + 感情スコアを返してくる。
// 変換・リサンプリングは AmiVoice 側が行うため元ファイルをそのまま送ればよい。
// ============================================================
async function handleAudioFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  clearError();

  // input を即座にリセット（同じファイルの再選択を可能にする）
  audioFileInput.value = "";

  uploadWrapper.classList.add("processing");
  uploadLabelEl.textContent = `処理中: ${file.name}`;
  recognitionText.innerHTML = '<span style="color: var(--accent-gold)">音声ファイルを認識中...</span>';

  try {
    const res = await fetch("/api/recognize", {
      method: "POST",
      headers: { "Content-Type": file.type || "audio/wav" },
      body: await file.arrayBuffer(),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || `サーバーエラー: ${res.status}`);
    }

    const { text, confidence, sentiment } = await res.json();
    console.log("[/api/recognize] 受信:", { text, confidence });

    if (isPlaceholderText(text)) {
      throw new Error(`音声を認識できませんでした。はっきり話した音声ファイルを試してください。（AmiVoiceの返答: "${text}"）`);
    }

    // 話速：処理時間ではなくファイルの再生時間で計算する。
    const audioDurationMs = await getAudioDuration(file) * 1000;
    const speed = estimateSpeed(text, audioDurationMs);

    // 感情：AmiVoice の感情スコアから粗いラベルを作る（UI バッジ表示用）。
    // 詳細スコア自体は sentiment として Claude にもそのまま渡す。
    const emotion = sentiment ? sentimentToEmotion(sentiment) : estimateEmotion(text);
    const tone = estimateTone(text);

    recognitionText.textContent = text;
    speedBadge.textContent = speed;
    emotionBadge.textContent = emotion;
    toneBadge.textContent = tone;
    confidenceBadge.textContent = confidence != null
      ? `${Math.round(confidence * 100)}%` : "―";

    if (sentiment) console.log("[感情分析]", sentiment);
    renderSentimentScores(sentiment);

    callNpcChat(text, speed, emotion, tone, sentiment);

  } catch (err) {
    showError(`処理に失敗しました: ${err.message}`);
    recognitionText.innerHTML = '<span class="placeholder">音声ファイルを選んで話しかけてください…</span>';
  } finally {
    uploadWrapper.classList.remove("processing");
    uploadLabelEl.textContent = "音声ファイルをアップロード";
  }
}

// ============================================================
// AmiVoice 感情スコア → アプリの感情ラベル変換（UIバッジ用）
//
// 公式ドキュメントより：
//   「0付近の値を取ることが多く、比較的緩やかに値が変化するパラメータ」
//
// つまり energy は短い録音だと 5-15 程度に収まるのが普通。
// 単純に「energy<10=悲しい」とすると常に悲しい判定になってしまう。
//
// そこで「補助指標（0-30 範囲、>0で稀＝有意）」を主軸にする：
//   - aggression>0  → 怒り
//   - upset>0       → 悲しみ・不満
//   - content>0     → 喜び
//   - dissatisfaction>0 → 不満
//
// 補助指標が無反応のときだけ energy / stress などで補完判定する。
//
// 判定の優先順位（高 → 低）：
//   怒り気味 → 悲しい → 上機嫌 → 普通
// ============================================================
function sentimentToEmotion(s) {
  // 怒り：攻撃性 or 不満 が出ている / 強いストレス
  const isAngry =
    s.aggression > 0 ||
    s.dissatisfaction > 0 ||
    s.stress > 50;

  // 悲しみ：upset が出ている / energy が極端に低い かつ stress も高めで沈んでる
  const isSad =
    s.upset > 0 ||
    (s.energy < 3 && s.stress > 20) ||
    (s.atmosphere < -20);

  // 上機嫌：content（喜び）が出ている / energy 高めで穏やか
  const isHappy =
    s.content > 0 ||
    (s.energy >= 21 && s.stress < 30) ||
    s.atmosphere > 30;

  if (isAngry) return "怒り気味";
  if (isSad)   return "悲しい";
  if (isHappy) return "上機嫌";
  return "普通";
}

// ============================================================
// 感情スコアの詳細表示（20 指標を全て見せる）
//
// 「>0 で有意」な補助指標は、実際に >0 になっていれば強調表示する。
// これでユーザーが「自分の声は何が検出されたか」を一目で把握できる。
// ============================================================
function renderSentimentScores(sentiment) {
  if (!sentiment) {
    sentimentScoresEl.innerHTML = '<div class="sentiment-empty">感情スコアが取得できませんでした</div>';
    return;
  }

  const html = SENTIMENT_DISPLAY.map(({ key, jp, hint }) => {
    const value = sentiment[key];
    const isActive = hint === ">0で有意" && value > 0;
    return `
      <div class="sentiment-row ${isActive ? "is-active" : ""}">
        <span class="sentiment-name">${jp}<small style="opacity:.5; margin-left:4px">${hint}</small></span>
        <span class="sentiment-value">${value}</span>
      </div>
    `;
  }).join("");

  sentimentScoresEl.innerHTML = html;
}

// ============================================================
// 音声ファイルの再生時間取得（話速計算用）
// ============================================================
function getAudioDuration(file) {
  return new Promise((resolve) => {
    const audio = new Audio();
    const url = URL.createObjectURL(file);
    audio.addEventListener("loadedmetadata", () => {
      URL.revokeObjectURL(url);
      resolve(audio.duration);
    });
    audio.addEventListener("error", () => resolve(0));
    audio.src = url;
  });
}

// ============================================================
// 話速推定
//
// 音声の長さ（ms）をテキスト文字数で割り、1文字あたりの発話時間を算出。
//
// 閾値の根拠：
//   日本語の平均発話速度 ≈ 7〜9文字/秒
//   普通 = 110〜230ms/文字 くらいが目安
// ============================================================
function estimateSpeed(text, elapsedMs) {
  const charCount = text.replace(/\s/g, "").length;
  if (charCount === 0) return "普通";

  const msPerChar = elapsedMs / charCount;
  if (msPerChar < 150) return "速い";
  if (msPerChar < 250) return "普通";
  return "遅い";
}

// ============================================================
// 感情推定（テキストベース、フォールバック用）
//
// 通常は AmiVoice の感情スコアから推定するが、
// スコアが取得できなかった場合のフォールバックとしてキーワード判定する。
// ============================================================
function estimateEmotion(text) {
  const angryPatterns = [
    /[！!]{2,}/, /[？?]{2,}/,
    /ふざけ/, /うるさ/, /いい加減/, /おかしい/,
  ];
  const calmPatterns = [
    /ありがとう/, /よろしく/, /お願い/, /すみません/, /教えて/,
  ];

  const hasAngry = angryPatterns.some(p => p.test(text));
  const hasCalm = calmPatterns.some(p => p.test(text));

  if (hasAngry) return "怒り気味";
  if (hasCalm) return "穏やか";
  return "普通";
}

// ============================================================
// 口調判定（テキストベース）
//
// 丁寧語・乱暴語のキーワードリストでテキストを判定する。
// 両方含む場合は乱暴を優先（NPCへの影響が大きいため）。
// ============================================================
function estimateTone(text) {
  const rudeKeywords = [
    "しろ", "やれ", "来い", "失せろ",
    "じゃねえ", "じゃね", "だろ", "だろうが",
    "お前", "てめえ", "てめ", "おめえ",
    "うるさい", "黙れ", "死ね",
  ];
  const politeKeywords = [
    "ください", "でしょうか", "いただけ",
    "ありがとう", "すみません", "よろしく",
    "ですか", "ますか", "でしょう",
    "お願い", "拝啓",
  ];

  const isRude = rudeKeywords.some(kw => text.includes(kw));
  const isPolite = politeKeywords.some(kw => text.includes(kw));

  if (isRude) return "乱暴";
  if (isPolite) return "丁寧";
  return "普通";
}

// ============================================================
// Claude API（サーバー経由）を呼び出して NPC の返答を取得
// ============================================================
async function callNpcChat(text, speed, emotion, tone, sentiment = null) {
  loadingIndicator.style.display = "block";

  const payload = {
    text,
    speed,
    emotion,
    tone,
    sentiment, // AmiVoice の 10 種スコア（無い場合は null）
    characterId: currentCharacterId,
    npcState: {
      affection: npcState.affection,
      trust: npcState.trust,
      irritation: npcState.irritation,
    },
  };
  console.log("[/api/chat] 送信:", payload);

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`サーバーエラー: ${res.status}`);
    }

    const npcResponse = await res.json();
    console.log("[NPC]", npcResponse);

    updateNpcState(npcResponse);
    updateNpcUI(npcResponse);

    npcState.conversationCount++;
    npcState.history.push({ player: text, npc: npcResponse.npcText });
    if (npcState.history.length > 5) npcState.history.shift();

  } catch (err) {
    showError(`NPC との通信に失敗しました: ${err.message}`);
  } finally {
    loadingIndicator.style.display = "none";
  }
}

// ============================================================
// NPC ステータス更新
//
// Claude が返した Delta 値を現在の値に加算し、
// 各パラメータを 0〜100 の範囲に収める（クランプ処理）
// ============================================================
function updateNpcState(npcResponse) {
  const clamp = (val, min, max) => Math.max(min, Math.min(max, val));

  npcState.affection  = clamp(npcState.affection  + (npcResponse.affectionDelta  || 0), 0, 100);
  npcState.trust      = clamp(npcState.trust      + (npcResponse.trustDelta      || 0), 0, 100);
  npcState.irritation = clamp(npcState.irritation + (npcResponse.irritationDelta || 0), 0, 100);
}

// ============================================================
// UI 更新：NPC の返答・ステータスバー・感情バッジを更新する
// ============================================================
function updateNpcUI(npcResponse) {
  npcSpeech.textContent = npcResponse.npcText || "……";
  npcSpeech.classList.remove("updated");
  void npcSpeech.offsetWidth; // reflow を強制してアニメーションを再起動
  npcSpeech.classList.add("updated");

  npcEmotion.textContent = npcResponse.emotion || "無関心";

  npcAvatar.className = "npc-avatar";
  if (npcState.irritation > 60) {
    npcAvatar.classList.add("angry");
  } else if (npcState.affection > 70) {
    npcAvatar.classList.add("happy");
  } else if (npcState.trust > 60) {
    npcAvatar.classList.add("trusting");
  }

  document.getElementById("affectionBar").style.width   = `${npcState.affection}%`;
  document.getElementById("trustBar").style.width       = `${npcState.trust}%`;
  document.getElementById("irritationBar").style.width  = `${npcState.irritation}%`;

  document.getElementById("affectionValue").textContent   = npcState.affection;
  document.getElementById("trustValue").textContent       = npcState.trust;
  document.getElementById("irritationValue").textContent  = npcState.irritation;

  conversationCount.textContent = npcState.conversationCount + 1;
}

// ============================================================
// エラー表示・クリア
// ============================================================
function showError(msg) {
  errorMessage.textContent = msg;
  errorMessage.style.display = "block";
}

function clearError() {
  errorMessage.textContent = "";
  errorMessage.style.display = "none";
}
