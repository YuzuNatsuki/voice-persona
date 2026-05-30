// ============================================================
// app.js - 声のペルソナ フロントエンドロジック
//
// 処理の全体フロー：
//   1. マイクボタン押下 → 音声録音開始（AudioContext + ScriptProcessor）
//   2. 録音した PCM データを AmiVoice WebSocket にストリーミング送信
//   3. AmiVoice から認識テキストを受信
//   4. 話速・口調・感情を分析
//   5. サーバー経由で Claude API を呼び出し NPC の返答を取得
//   6. NPC ステータスを更新して UI に反映
// ============================================================

// ── NPC の状態管理 ─────────────────────────────────────────
// すべてのパラメータをひとつのオブジェクトで管理する。
// 範囲チェックは updateNpcState() が担当するので、ここでは初期値のみ定義。
const npcState = {
  affection: 50,        // 好感度（0-100）
  trust: 50,            // 信頼度（0-100）
  irritation: 0,        // 苛立ち度（0-100）
  conversationCount: 0, // 会話回数
  history: [],          // 直近5件の会話履歴（将来の拡張用）
};

// ── 録音セッションの一時データ ──────────────────────────────
// 認識開始時刻を保存して、話速計算に使う
let recognitionStartTime = null;

// ── WebSocket / AudioContext のインスタンス ─────────────────
// グローバルに保持してボタン操作で開始/停止を制御する
let wsConnection = null;
let audioContext = null;
let mediaStream = null;
let scriptProcessor = null;

// ── AmiVoice APIキー ────────────────────────────────────────
// サーバーから取得して保持する（フロントのソースに直接書かない）
let amivoiceToken = null;

// ── 選択中のキャラクター ────────────────────────────────────
// characterId はサーバーの CHARACTERS オブジェクトのキーと対応する
let currentCharacterId = "gard";

// ── DOM 参照 ────────────────────────────────────────────────
const micButton = document.getElementById("micButton");
const micLabel = document.getElementById("micLabel");
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

// ============================================================
// 初期化
// ============================================================
(async function init() {
  // サーバーから AmiVoice トークンを取得しておく
  try {
    const res = await fetch("/api/amivoice-token");
    const data = await res.json();
    amivoiceToken = data.token;
  } catch (err) {
    showError("サーバーへの接続に失敗しました。サーバーが起動しているか確認してください。");
  }

  micButton.addEventListener("click", toggleRecording);
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

  // カードのアクティブ状態を更新
  document.querySelectorAll(".char-card").forEach(card => {
    card.classList.toggle("active", card.dataset.charId === charId);
  });

  // NPCステータスをリセット（新しいキャラクターとの会話は初期状態から）
  npcState.affection = 50;
  npcState.trust = 50;
  npcState.irritation = 0;
  npcState.conversationCount = 0;
  npcState.history = [];

  // キャラクターごとのアバター・名前・初期セリフをマッピング
  const charConfig = {
    gard: {
      image: "images/ガルド.png",
      name: "情報屋 ガルド",
      greeting: "……何か用か？金を持ってんなら話を聞いてやらんこともない。",
      emotion: "様子を伺っている",
    },
    lilia: {
      image: "images/リリア.png",
      name: "気まぐれな魔女 リリア",
      greeting: "あら〜、何か用？ちょうど新しい実験してたんだけど、まあいっか♪",
      emotion: "気まぐれな気分",
    },
    crow: {
      image: "images/クロウ.png",
      name: "賞金稼ぎ クロウ",
      greeting: "…用件を言え。",
      emotion: "無表情",
    },
    zet: {
      image: "images/ゼット.png",
      name: "怪しい商人 ゼット",
      greeting: "いらっしゃいませ〜！何でも揃いますよ、何でも♪ ふふふ。",
      emotion: "営業スマイル",
    },
  };

  const config = charConfig[charId] ?? charConfig.gard;

  // UIを新キャラクターの初期状態に更新
  npcAvatar.innerHTML = `<img src="${config.image}" alt="${config.name}" onerror="this.style.display='none';this.parentElement.textContent='👤'">`;
  npcAvatar.className = "npc-avatar"; // 感情クラスをリセット
  npcName.textContent = config.name;
  npcSpeech.textContent = config.greeting;
  npcEmotion.textContent = config.emotion;

  // ステータスバーをリセット
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
  // 句読点・空白・各種ドット類だけを除いて何も残らなければプレースホルダー扱い
  const stripped = text.replace(/[.．。、，,\s…・]/g, "");
  return stripped.length === 0;
}

// ============================================================
// 音声ファイルアップロード処理
//
// 選択されたファイルを AudioContext でデコードし、
// PCM データに変換して AmiVoice WebSocket に送信する。
// マイク録音と同じ handleAmiVoiceMessage() で結果を受け取る。
// ============================================================
async function handleAudioFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  clearError();

  // input を即座にリセット（同じファイルの再選択を可能にする）
  audioFileInput.value = "";

  // UI を処理中状態に
  uploadWrapper.classList.add("processing");
  uploadLabelEl.textContent = `処理中: ${file.name}`;
  recognitionText.innerHTML = '<span style="color: var(--accent-gold)">音声ファイルを認識中...</span>';

  try {
    // ── サーバーの /api/recognize に音声ファイルをそのまま送る ──
    // ファイルアップロードは AmiVoice 非同期 HTTP API（v1）を使う。
    // WebSocket API と違い sentimentAnalysis=True が使えるため、
    // テキスト認識と感情分析を同時に取得できる。
    // 変換・リサンプリングはサーバー側ではなく AmiVoice 側が行うため
    // 元のファイルをそのまま送れば良い。
    const startTime = Date.now();

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
      throw new Error("音声を認識できませんでした。はっきり話した音声ファイルを試してください。（AmiVoiceの返答: \"" + text + "\"）");
    }

    // 話速：音声の長さ（処理時間ではなくファイルの再生時間）で計算する。
    // 非同期APIはポーリング時間が含まれるため、ファイルの duration を使う。
    const audioDurationMs = await getAudioDuration(file) * 1000;
    const speed = estimateSpeed(text, audioDurationMs);

    // 感情：AmiVoice の感情スコアから変換する。
    // スコアがない場合はテキストベースの推定にフォールバック。
    const emotion = sentiment ? sentimentToEmotion(sentiment) : estimateEmotion(text);
    const tone = estimateTone(text);

    // UI を更新
    recognitionText.textContent = text;
    speedBadge.textContent = speed;
    emotionBadge.textContent = emotion;
    toneBadge.textContent = tone;
    confidenceBadge.textContent = confidence != null
      ? `${Math.round(confidence * 100)}%` : "―";

    // 感情スコアの詳細をコンソールに出力（デバッグ・記事用）
    if (sentiment) console.log("[感情分析]", sentiment);

    callNpcChat(text, speed, emotion, tone);

  } catch (err) {
    showError(`処理に失敗しました: ${err.message}`);
  } finally {
    uploadWrapper.classList.remove("processing");
    uploadLabelEl.textContent = "音声ファイルをアップロード";
  }
}

// ============================================================
// AmiVoice 感情スコア → アプリの感情ラベル変換
//
// AmiVoice に「悲しみ（Sadness）」の専用パラメータはなく、
// 以下の組み合わせで推定するのが公式ドキュメントの推奨：
//   - Upset（動揺）：「不満あるいは悲しみを示す指標」
//   - Energy（低値）：「悲しみを示唆」
//   - Joy / Passion（低値）：活力・喜びの欠如
//
// 判定の優先順位（高 → 低）：
//   怒り気味 → 悲しい → 穏やか → 普通
// ============================================================
function sentimentToEmotion(s) {
  const isAngry = s.dissatisfaction > 60 || s.stress > 65 || s.aggression > 60;
  // 悲しみ：動揺が高く、エネルギーと喜びが共に低い
  const isSad   = s.upset > 55 && s.energy < 40 && s.joy < 40;
  const isCalm  = s.joy > 55 && s.stress < 40 && s.dissatisfaction < 40 && s.energy > 45;

  if (isAngry) return "怒り気味";
  if (isSad)   return "悲しい";
  if (isCalm)  return "穏やか";
  return "普通";
}

// ============================================================
// 音声ファイルの再生時間取得（話速計算用）
// Audio 要素に読み込んで duration を取る。
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
// リサンプリング（OfflineAudioContext を使った高品質な変換）
//
// ブラウザ標準の OfflineAudioContext を使うことで、
// 手動でフィルタを書かずに高品質なリサンプリングが実現できる。
// ============================================================
async function resample(float32Data, fromRate, toRate) {
  if (fromRate === toRate) return float32Data;

  const frames = float32Data.length;
  const outputFrames = Math.round(frames * toRate / fromRate);

  const offlineCtx = new OfflineAudioContext(1, outputFrames, toRate);
  const buffer = offlineCtx.createBuffer(1, frames, fromRate);
  buffer.copyToChannel(float32Data, 0);

  const source = offlineCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(offlineCtx.destination);
  source.start(0);

  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0);
}

// ============================================================
// 録音の開始・停止トグル
// ============================================================
async function toggleRecording() {
  if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
    // 録音中なら停止
    stopRecording();
  } else {
    // 停止中なら開始
    await startRecording();
  }
}

// ============================================================
// 録音開始
// AmiVoice WebSocket に接続し、マイク音声をストリーミング送信する
// ============================================================
async function startRecording() {
  clearError();

  if (!amivoiceToken) {
    showError("AmiVoice APIキーが取得できていません。");
    return;
  }

  // マイクアクセス権限を要求
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    // 権限拒否や非対応デバイスへの対応
    if (err.name === "NotAllowedError") {
      showError("マイクの使用許可が必要です。ブラウザの設定を確認してください。");
    } else {
      showError(`マイクへのアクセスに失敗しました: ${err.message}`);
    }
    return;
  }

  // ── AudioContext の設定 ────────────────────────────────────
  // AmiVoice が求める PCM 16bit 16kHz モノラルに変換するため、
  // Web Audio API の ScriptProcessorNode を使う。
  // （AudioWorklet の方が推奨だが、記事の可読性を優先してこちらを採用）
  audioContext = new AudioContext({ sampleRate: 16000 });
  const source = audioContext.createMediaStreamSource(mediaStream);

  // バッファサイズ 4096 samples = 約250ms ごとにコールバック
  scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
  source.connect(scriptProcessor);
  scriptProcessor.connect(audioContext.destination);

  // ── AmiVoice WebSocket 接続 ────────────────────────────────
  // エンドポイントの仕様：
  //   wss://acp-api.amivoice.com/v1/
  //   接続直後に認証コマンドを送信する必要がある
  const wsUrl = "wss://acp-api.amivoice.com/v1/";
  wsConnection = new WebSocket(wsUrl);
  wsConnection.binaryType = "arraybuffer";

  wsConnection.onopen = () => {
    // 接続確立後、まず認証・設定コマンドを送信する
    // フォーマット: "s {apikey} {grammar} {options}"
    //   grammar: "-a-general" = 汎用認識エンジン
    //   options: 認識言語や出力形式の設定
    wsConnection.send(`s 16K -a-general authorization=${amivoiceToken}`);

    // 録音開始時刻を記録（話速計算に使う）
    recognitionStartTime = Date.now();

    // UI を録音中状態に更新
    micButton.classList.add("recording");
    micLabel.textContent = "録音中... （もう一度押すと停止）";
    recognitionText.innerHTML = '<span style="color: var(--accent-gold)">認識中...</span>';
  };

  wsConnection.onmessage = (event) => {
    handleAmiVoiceMessage(event.data);
  };

  wsConnection.onerror = (err) => {
    showError("AmiVoice への接続でエラーが発生しました。");
    stopRecording();
  };

  wsConnection.onclose = () => {
    stopRecording();
  };

  // ── 音声データの送信 ────────────────────────────────────────
  // ScriptProcessorNode のコールバックで Float32 の PCM データが届く。
  // AmiVoice は Int16 PCM を期待するので変換してから送信する。
  scriptProcessor.onaudioprocess = (event) => {
    if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) return;

    const float32Data = event.inputBuffer.getChannelData(0);
    const int16Data = float32ToInt16(float32Data);

    // "p" + 音声バイナリ を結合して送信（AmiVoice の pコマンド形式）
    const packet = new Uint8Array(1 + int16Data.buffer.byteLength);
    packet[0] = 0x70; // 'p'
    packet.set(new Uint8Array(int16Data.buffer), 1);
    wsConnection.send(packet);
  };
}

// ============================================================
// 録音停止
// WebSocket に終了コマンドを送り、音声リソースを解放する
// ============================================================
function stopRecording() {
  // AmiVoice に終了を通知（"e" コマンド）
  if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
    wsConnection.send("e");
    wsConnection.close();
  }
  wsConnection = null;

  // AudioContext とマイクストリームを解放
  if (scriptProcessor) { scriptProcessor.disconnect(); scriptProcessor = null; }
  if (audioContext) { audioContext.close(); audioContext = null; }
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }

  // UI を待機状態に戻す
  micButton.classList.remove("recording");
  micLabel.textContent = "タップして話しかける";
}

// ============================================================
// Float32 → Int16 PCM 変換
// Web Audio API は Float32（-1.0〜1.0）で音声を扱うが、
// AmiVoice が受け付けるのは Int16（-32768〜32767）なので変換する
// ============================================================
function float32ToInt16(float32Array) {
  const int16Array = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    // クランプして Int16 範囲内に収める
    const clamped = Math.max(-1, Math.min(1, float32Array[i]));
    int16Array[i] = clamped * 32767;
  }
  return int16Array;
}

// ============================================================
// AmiVoice からのメッセージ処理
// テキスト認識の完了（"RESULT" メッセージ）を受け取って
// 話速・感情・口調を分析し、Claude API を呼び出す
// ============================================================
function handleAmiVoiceMessage(data) {
  // AmiVoice は "RESULT {code} {json}" 形式のテキストを返す
  if (typeof data !== "string") return;

  // 全メッセージをコンソールに出力してデバッグしやすくする
  console.log("[AmiVoice]", data);

  const parts = data.split(" ");
  const messageType = parts[0];

  // AmiVoice のレスポンス形式：
  //   s          → 接続成功
  //   s {msg}    → 接続失敗（エラーメッセージ付き）
  //   S / E      → 発話開始 / 発話終了
  //   U {json}   → 途中結果
  //   A {json}   → 確定結果（こちらを使う）
  //   e          → セッション終了確認

  // 接続成功（"s" 1文字のみ）
  if (data === "s") {
    console.log("[AmiVoice] 接続成功");
    return;
  }

  // 接続失敗（"s " + エラーメッセージ）
  if (messageType === "s" && parts.length > 1) {
    const errMsg = parts.slice(1).join(" ");
    showError(`AmiVoice 接続エラー: ${errMsg}`);
    console.error("[AmiVoice] 接続失敗:", errMsg);
    uploadWrapper.classList.remove("processing");
    uploadLabelEl.textContent = "音声ファイルをアップロード";
    return;
  }

  // 途中結果・発話イベントはスキップ（U, S, E, C）
  if (messageType === "U" || messageType === "S" || messageType === "E" || messageType === "C") {
    return;
  }

  // A = 確定認識結果
  if (messageType === "A") {
    // 認識結果の JSON を取り出す（"A {json}" 形式）
    const jsonStr = parts.slice(1).join(" ");
    let result;
    try {
      result = JSON.parse(jsonStr);
    } catch {
      console.warn("[AmiVoice] JSONパース失敗:", jsonStr);
      return;
    }

    console.log("[AmiVoice] A結果:", result);

    // AmiVoice は通常トップレベル text に認識結果を入れるが、
    // 設定によっては results[0].text にしか入らないこともあるためフォールバック
    const text = result.text || result.results?.[0]?.text || "";
    const confidence = result.confidence ?? result.results?.[0]?.confidence;

    // テキストが空 or "..." のみ（無音/不明瞭）は無視
    if (isPlaceholderText(text)) {
      console.warn("[AmiVoice] 認識テキストがプレースホルダーのためスキップ:", text);
      showError("音声を認識できませんでした。はっきり話してみてください。");
      return;
    }

    // 認識にかかった時間（ミリ秒）
    const elapsedMs = Date.now() - recognitionStartTime;

    // ── 各種分析を実行 ─────────────────────────────────────
    const speed = estimateSpeed(text, elapsedMs);
    const emotion = estimateEmotion(text);
    const tone = estimateTone(text);

    // UI を更新
    recognitionText.textContent = text;
    speedBadge.textContent = speed;
    emotionBadge.textContent = emotion;
    toneBadge.textContent = tone;
    confidenceBadge.textContent = confidence != null
      ? `${Math.round(confidence * 100)}%`
      : "―";

    // Claude API を呼び出して NPC の返答を取得
    callNpcChat(text, speed, emotion, tone);

    // 次の発話に向けて録音開始時刻をリセット
    recognitionStartTime = Date.now();
  }
}

// ============================================================
// 話速推定
//
// AmiVoice の認識時間（ms）をテキスト文字数で割り、
// 1文字あたりの発話時間を算出して速度を判定する。
//
// 精度は完璧ではないが、ネットワーク遅延が一定なら
// 相対的な速さの違いは十分に検出できる。
//
// 閾値の根拠：
//   日本語の平均発話速度 ≈ 約7〜9文字/秒
//   → 普通 = 110〜230ms/文字 くらい
//   速いと感じるのは 110ms 以下、遅いは 230ms 以上を目安に設定
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
// 感情推定
//
// テキスト内のキーワードや語尾パターンから感情を推定する。
// AmiVoice API の感情スコアが返ってくる場合はそちらを優先する想定だが、
// 現時点では感情スコアが含まれないため、テキストベースで推定している。
// ============================================================
function estimateEmotion(text) {
  // 怒り・イライラを示す表現
  const angryPatterns = [
    /[！!]{2,}/,         // ！！や!!が連続
    /[？?]{2,}/,         // ？？や??が連続（詰め寄り）
    /ふざけ/,
    /うるさ/,
    /いい加減/,
    /なんで|なぜ|どうして/,
    /おかしい/,
  ];

  // 穏やかさを示す表現
  const calmPatterns = [
    /ありがとう/,
    /よろしく/,
    /お願い/,
    /すみません/,
    /教えて/,
    /〜？$/, // 疑問形で終わる穏やかな問いかけ
  ];

  const hasAngry = angryPatterns.some(p => p.test(text));
  const hasCalm = calmPatterns.some(p => p.test(text));

  if (hasAngry) return "怒り気味";
  if (hasCalm) return "穏やか";
  return "普通";
}

// ============================================================
// 口調判定
//
// 丁寧語・乱暴語のキーワードリストでテキストを判定する。
// 両方含む場合は乱暴を優先（NPCへの影響が大きいため）。
// ============================================================
function estimateTone(text) {
  // 乱暴な口調を示すキーワード・語尾
  const rudeKeywords = [
    "しろ", "やれ", "来い", "失せろ",
    "じゃねえ", "じゃね", "だろ", "だろうが",
    "お前", "てめえ", "てめ", "おめえ",
    "うるさい", "黙れ", "死ね",
  ];

  // 丁寧な口調を示すキーワード・語尾
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
async function callNpcChat(text, speed, emotion, tone) {
  loadingIndicator.style.display = "block";

  const payload = {
    text,
    speed,
    emotion,
    tone,
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

    // NPC ステータスを更新して UI に反映
    updateNpcState(npcResponse);
    updateNpcUI(npcResponse);

    // 会話履歴を最新5件に絞って保存
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
  // ── セリフ更新（アニメーション付き） ──────────────────────
  npcSpeech.textContent = npcResponse.npcText || "……";
  npcSpeech.classList.remove("updated");
  // reflow を強制してアニメーションを再起動する
  void npcSpeech.offsetWidth;
  npcSpeech.classList.add("updated");

  // ── 感情状態バッジ ─────────────────────────────────────────
  npcEmotion.textContent = npcResponse.emotion || "無関心";

  // ── アバターの色を感情に応じて切り替え ────────────────────
  npcAvatar.className = "npc-avatar";
  if (npcState.irritation > 60) {
    npcAvatar.classList.add("angry");
  } else if (npcState.affection > 70) {
    npcAvatar.classList.add("happy");
  } else if (npcState.trust > 60) {
    npcAvatar.classList.add("trusting");
  }

  // ── ステータスバーの幅を更新 ────────────────────────────────
  document.getElementById("affectionBar").style.width   = `${npcState.affection}%`;
  document.getElementById("trustBar").style.width       = `${npcState.trust}%`;
  document.getElementById("irritationBar").style.width  = `${npcState.irritation}%`;

  // ── 数値テキストの更新 ─────────────────────────────────────
  document.getElementById("affectionValue").textContent   = npcState.affection;
  document.getElementById("trustValue").textContent       = npcState.trust;
  document.getElementById("irritationValue").textContent  = npcState.irritation;

  // ── 会話回数 ───────────────────────────────────────────────
  conversationCount.textContent = npcState.conversationCount + 1; // 更新前に表示するため +1
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
