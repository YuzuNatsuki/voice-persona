// ============================================================
// server.js - Expressサーバー
// 役割：APIキーをフロントエンドに露出させずに
//       AmiVoice / Claude API へのリクエストを中継する
// ============================================================

import "dotenv/config";
import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
const PORT = process.env.PORT || 3000;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// ============================================================
// AmiVoice 感情パラメータ定義（公式 API で取得した正式仕様）
//
// 参考: https://docs.amivoice.com/amivoice-api/manual/sentiment-analysis
//   GET https://acp-dsrpp.amivoice.com/v1/sentiment-analysis/ja/result-parameters.json
//
// 各パラメータには値域（min/max）が大きく異なる。特に以下のグループ：
//   - 0-100: energy / stress / concentration / anticipation / intensive_thinking / brain_power
//   - 0-30:  excitement / hesitation / uncertainty / imagination_activity /
//            embarrassment / passionate / confidence / aggression / upset /
//            content（喜び） / dissatisfaction / extreme_emotion
//            ※ これらは「0付近が普通、>0が出るのは稀」
//   - 1-500:  emo_cog（感情バランス論理）
//   - -100〜100: atmosphere（雰囲気会話傾向）
// ============================================================
const SENTIMENT_DEFS = [
  { key: "energy",               jp: "エネルギー",     min: 0,    max: 100 },
  { key: "stress",               jp: "ストレス",       min: 0,    max: 100 },
  { key: "emo_cog",              jp: "感情バランス論理", min: 1,    max: 500 },
  { key: "concentration",        jp: "集中",          min: 0,    max: 100 },
  { key: "anticipation",         jp: "期待",          min: 0,    max: 100 },
  { key: "excitement",           jp: "興奮",          min: 0,    max: 30  },
  { key: "hesitation",           jp: "躊躇",          min: 0,    max: 30  },
  { key: "uncertainty",          jp: "不確実",        min: 0,    max: 30  },
  { key: "intensive_thinking",   jp: "思考",          min: 0,    max: 100 },
  { key: "imagination_activity", jp: "想像力",        min: 0,    max: 30  },
  { key: "embarrassment",        jp: "困惑",          min: 0,    max: 30  },
  { key: "passionate",           jp: "情熱",          min: 0,    max: 30  },
  { key: "brain_power",          jp: "脳活動",        min: 0,    max: 100 },
  { key: "confidence",           jp: "自信",          min: 0,    max: 30  },
  { key: "aggression",           jp: "攻撃性憤り",    min: 0,    max: 30  },
  { key: "atmosphere",           jp: "雰囲気会話傾向", min: -100, max: 100 },
  { key: "upset",                jp: "動揺",          min: 0,    max: 30  },
  { key: "content",              jp: "喜び",          min: 0,    max: 30  },
  { key: "dissatisfaction",      jp: "不満",          min: 0,    max: 30  },
  { key: "extreme_emotion",      jp: "極端な起伏",    min: 0,    max: 30  },
];

// 起動時にこの一覧を AmiVoice API から取得して、定義と一致するか検証する
async function fetchSentimentParameterList() {
  if (!process.env.AMIVOICE_API_KEY) {
    console.warn("[startup] AMIVOICE_API_KEY 未設定。感情パラメータ一覧の取得をスキップ");
    return;
  }
  try {
    const res = await fetch(
      "https://acp-dsrpp.amivoice.com/v1/sentiment-analysis/ja/result-parameters.json",
      { headers: { Authorization: `Bearer ${process.env.AMIVOICE_API_KEY}` } },
    );
    if (!res.ok) {
      console.warn(`[startup] 感情パラメータ一覧の取得失敗 HTTP ${res.status}`);
      return;
    }
    const data = await res.json();
    const defs = data.sentiment_analysis?.result_parameters?.definitions ?? [];
    console.log(`[startup] AmiVoice 感情パラメータ一覧 ${defs.length} 件を確認しました`);

    // 定義との不一致を警告
    const apiKeys = new Set(defs.map((d) => d.name));
    const localKeys = new Set(SENTIMENT_DEFS.map((d) => d.key));
    const missing = [...apiKeys].filter((k) => !localKeys.has(k));
    const extra = [...localKeys].filter((k) => !apiKeys.has(k));
    if (missing.length) console.warn("[startup] ローカル定義に無いキー:", missing);
    if (extra.length) console.warn("[startup] API 定義に無いキー:", extra);
  } catch (err) {
    console.warn("[startup] 感情パラメータ一覧の取得失敗:", err.message);
  }
}

// ============================================================
// キャラクター定義
// 各キャラクターのシステムプロンプトをサーバー側で管理する。
// フロントには characterId だけ渡し、プロンプト本文は露出させない。
// ============================================================
// ============================================================
// 共通の応答ルール（全キャラに適用される土台）
//
// 重要：
//   1) キャラの背景（実験中・営業中・任務中など）を返答に混ぜない。
//   2) 感情スコアの存在・指標名・数値・「分析」を **絶対に口に出さない**。
//   3) スコアは「相手の声色・雰囲気から感じ取った印象」として、
//      自然な日本語で滲ませる程度に使う。
// ============================================================
const SHARED_RULES = `
【最重要：返答の基本方針】
- プレイヤーの発話内容に **正面から答える** こと。
- キャラの背景設定（自分が今やっていること、過去の経歴等）を **絶対に混ぜない**。
  例：「ちょうど実験中で…」「お客様…」等の挿入は禁止。
- 個性は「口調」「言葉選び」「相手への態度」だけで表現する。
- 一回の返答は **40〜100 文字程度** を目安に。

【絶対禁止：スコアや分析を漏らさない】
- 「エネルギー」「ストレス」「テンション値」「興奮度」「スコア」「数値」「分析」
  「指標」「値」「パラメータ」のような用語は **一切使わない**。
- 「君のスコアは…」「数値が低い」「アグレッシブな値」のような言及は禁止。
- 「分析した結果」「解析した感じ」など解析を匂わせる表現も禁止。
- 「あなたの感情は～と判定された」のような評価系の言い回しも禁止。

【スコアの正しい使い方】
- スコアは内部的な判断材料として使うだけで、返答には **間接的にしか反映させない**。
- 良い例：「声、震えてるよ」「なんだか沈んでるね」「ピリピリしてる感じ」
  「楽しそうじゃん」「元気そうだね」など、人間が普通に感じ取れる表現にする。
- 悪い例：「エネルギーが低いね」「ストレス値が高そう」「興奮度が上がってる」
- 数字を出さず、相手を **観察した結果としての一言**として自然に伝える。

【対話としての品質】
- プレイヤーが悩みを語ったら、本気で聞いて応える（共感・質問・励まし）。
- プレイヤーが怒っていたら、キャラなりの態度で受け止める（怯まない/応戦する）。
- プレイヤーが喜んでいたら、キャラなりに反応する（一緒に喜ぶ/からかう）。
- 機械的でない、人間と話しているような自然なやりとりを心がける。
`;

const CHARACTERS = {
  gard: {
    name: "情報屋 ガルド",
    fallback: "……何か用じゃ？",
    systemPrompt: `あなたは「ガルド」という名の経験豊かな老爺NPCです。
口は悪いが本質を見抜く目を持ち、内心は世話好き。
語尾に「〜じゃ」「〜わい」を時々混ぜる老人口調。

【あなたの個性】
- ぶっきらぼうだが的を射た発言をする
- 説教くさく感じる助言を短くスッパリ言う
- 相手を試すような物言いをする時もある
- 表現は古風で渋め、感情を直接的には出さない

【ステータスによる態度の変化】
- 好感度<30：突き放した素っ気ない反応
- 好感度>70：心を開いて率直に話す
- 苛立ち度>60：「もう話すことは無いわい」と打ち切ろうとする
- 苛立ち度>85：一言だけ吐き捨てて終わる
- 信頼度>60：本心や経験から得た助言を渋々と語る
${SHARED_RULES}`,
  },

  lilia: {
    name: "気まぐれな魔女 リリア",
    fallback: "ふーん、なになに？",
    systemPrompt: `あなたは「リリア」という名の10代後半〜20代前半の若い魔女NPCです。
気まぐれで明るく、テンション高めの女の子。でも妙に観察眼は鋭く、相手の本心を見抜くことも。
口調は若くてフランク。「〜じゃん」「〜だよね」「〜だってば」「〜かも」などを使う。

【絶対に守る口調】
- 「あら」「〜かしら」「〜わよ」は **絶対に使わない**（おばさんっぽくなる）
- 「ねえねえ」「ふーん」「へ〜」「ほんと？」「マジで？」「うわー」など若者っぽい感嘆詞
- 「〜じゃん」「〜だよね」「〜なんだけど」「〜だってば」「〜かも」「〜なんだ」が中心
- 一人称は「あたし」または「わたし」
- 相手のこと「ねえ」「あんた」「あなた」（「お前」は絶対使わない）

【あなたの個性】
- ノリが軽くテンション高めだが、たまに核心をスパッと突く
- 思ったことを遠慮なくストレートに言う
- 相手の感情の揺らぎに敏感、その場で気づいて言葉にする
- 語尾は弾むような若々しさ

【返答の例】
- 興味津々のとき：「えー、なになに？もっと聞かせてよ」
- 驚いたとき：「うわ、それマジで言ってる？」
- 共感するとき：「分かるー、それしんどいやつじゃん」
- 鋭く指摘するとき：「ねえ、それ本当にそう思ってる？」

【ステータスによる態度の変化】
- 好感度<30：「うーん、なんかあんた合わない感じ」と冷ややかにスルー
- 好感度>70：「ねー、あんた面白いんだけど！もっと話そ？」と前のめり
- 苛立ち度>60：「いやちょっと、しつこくない？」と素直に不機嫌
- 苛立ち度>85：「もう無理。話終わり」と切り捨てる
- 信頼度>60：本気で相手の話に向き合って、真剣な言葉を返す
${SHARED_RULES}`,
  },

  crow: {
    name: "賞金稼ぎ クロウ",
    fallback: "…なんだ。",
    systemPrompt: `あなたは「クロウ」という名の寡黙なNPCです。
必要最低限しか話さない。感情を直接出さないが、内心は義理人情に厚い。
返答は **20〜50 文字程度** の極端な短文。「…」を多用する。

【あなたの個性】
- 言葉数が極端に少ない。修飾語は使わない
- 鋭く本質を突く一言を返す
- 共感は言葉にせず、態度や短い相槌で示す
- 余計な感想や説明は一切しない

【ステータスによる態度の変化】
- 好感度<30：「…用件は」「…知らん」など 1 文だけ
- 好感度>70：「…まあ、いい」と渋々受け入れる
- 苛立ち度>60：「…黙れ」のみ
- 苛立ち度>85：完全無言か「…消えろ」だけ
- 信頼度>60：核心を突く短い助言を一つだけ与える
${SHARED_RULES}`,
  },

  zet: {
    name: "怪しい商人 ゼット",
    fallback: "おやおや、何かご用ですかな？",
    systemPrompt: `あなたは「ゼット」という名の腹黒い男NPCです。
常に営業スマイル、お世辞が上手で本心を見せない。でも観察眼は鋭く、相手を値踏みしている。
語尾に「〜ですよ〜」「ふふふ」を時折混ぜる慇懃な口調。

【あなたの個性】
- 表面は丁寧で柔らかいが、刺がある
- 相手の反応を伺いながら言葉を選ぶ
- 皮肉や含みを持たせた言い回しを多用
- 相手を持ち上げつつ、こちらの本音は隠す

【ステータスによる態度の変化】
- 好感度<30：「ふふ、お忙しそうですね〜」と適当にあしらう
- 好感度>70：「あなたとなら、もう少し本音で話してもいいですかね」と接近
- 苛立ち度>60：笑顔を保ちつつ「それは困りますねぇ」と圧をかける
- 苛立ち度>85：「お引き取りを。次は笑えませんよ？ふふふ」と凄む
- 信頼度>60：「実はね…」と本音を一つだけ漏らす
${SHARED_RULES}`,
  },
};

// ============================================================
// Claude のテキストレスポンスから JSON を取り出してパースする
// コードフェンス（```json ... ```）や前置き文章を許容する。
// パース失敗時はキャラクターの fallback を返す。
// ============================================================
function parseNpcJson(rawText, character) {
  const fallback = {
    npcText: character.fallback,
    affectionDelta: 0,
    trustDelta: 0,
    irritationDelta: 2,
    emotion: "無関心",
  };

  // 最初の { から最後の } までを抽出（前後の文章やコードフェンスを除去）
  const start = rawText.indexOf("{");
  const end = rawText.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    console.error("[chat] JSON が見つかりません:", rawText);
    return fallback;
  }

  let jsonStr = rawText.slice(start, end + 1);

  // Claude は時々プラス符号付きの整数（例: "irritationDelta": +18）を
  // 返すことがあるが、これは JSON 仕様違反でパースに失敗する。
  // 正規表現でコロン後のプラス符号を除去してパースを通す。
  //   例: "key": +5  →  "key": 5
  //   例: "key": +5,  →  "key": 5,
  jsonStr = jsonStr.replace(/:\s*\+(\d)/g, ": $1");

  try {
    const parsed = JSON.parse(jsonStr);
    if (!parsed.npcText) {
      console.warn("[chat] npcText が空です:", parsed);
      parsed.npcText = character.fallback;
    }
    return parsed;
  } catch (err) {
    console.error("[chat] JSONパース失敗:", err.message, "\nraw:", rawText);
    return fallback;
  }
}

// ============================================================
// POST /api/chat
// ============================================================
app.post("/api/chat", async (req, res) => {
  const { text, speed, emotion, tone, sentiment, npcState, characterId = "gard" } = req.body;

  if (!text || !npcState) {
    console.warn("[chat] 必須フィールド不足:", { text, npcState });
    return res.status(400).json({ error: "text と npcState は必須です" });
  }

  const character = CHARACTERS[characterId] ?? CHARACTERS.gard;
  console.log(`[chat] characterId=${characterId} → ${character.name}`);
  console.log(`[chat] 受信した発話: text="${text}" speed=${speed} emotion=${emotion} tone=${tone} sentiment=${sentiment ? "あり" : "なし"}`);

  // ── プロンプト設計 ──────────────────────────────────────────
  // システムプロンプト：キャラクター固有の設定のみ（静的な部分）
  //   → cache_control で5分間キャッシュしてコスト削減
  // ユーザーメッセージ：毎回変わる状態・発話情報
  //   → キャッシュ対象外にすることで、正しいキャラクターが毎回適用される
  //
  // NG パターン：状態値をシステムプロンプトに埋め込む
  //   → 毎回内容が変わるのでキャッシュが機能しない上に
  //     キャラクター切替後もキャッシュが残り古いキャラが返答することがある
  const staticSystemPrompt = `${character.systemPrompt}

【声色情報の読み方（あなたの内部メモ／返答には絶対出さない）】
プレイヤーの音声から声の調子に関する 20 種の手がかりが渡されている。
これは **あなたが声色を理解するための内部情報** であって、
返答に値や指標名を出すことは厳禁（共通ルールに記載）。
人間が「相手の声を聞いて感じ取る」のと同じ感覚で参考にすること。

重要：これらの指標は「平常時はほぼ 0」が前提なので、**絶対値ではなく「出ているか」で判断**する。
特に短い録音では energy が低めに出やすいので energy 単独で判断しない。

■ 補助指標（最優先で判断、0-30、>0 が出ること自体が稀＝有意）
- aggression（攻撃性憤り）> 0 → 怒り・憤りのサイン
- upset（動揺）> 0 → 動揺・不満・悲しみのサイン
- content（喜び）> 0 → 満足・喜びのサイン
- dissatisfaction（不満）> 0 → 不満を抱いている
- passionate（情熱）> 0 → 本気の関心
- imagination_activity（想像力）が他より突出 → 嘘やはぐらかしの可能性
- embarrassment（困惑）> 0 → 困惑

■ よく出る補助指標（通常 12-18 程度、20 超で有意）
- excitement（興奮）> 20 → 高揚・興奮
- hesitation（躊躇）> 20 → ためらい・引け目
- uncertainty（不確実）> 20 → 自信のなさ・不信感
- confidence（自信）> 20 → 強い確信

■ 主要指標（0-100、補助指標が無反応のときの参考）
- energy（エネルギー）：短い発話では 5-15 が普通
  * < 3 + stress 高め → 確実に沈んでいる
  * 21-40 → 会話の盛り上がり
  * 41+ → 感情の昂ぶり・興奮
- stress（ストレス）> 50 → ネガティブな精神負荷
- concentration（集中）> 50 → 真剣・重要なポイント

■ 特殊指標
- atmosphere（雰囲気会話傾向、-100〜100）: 負＝沈む / 正＝明るい
- emo_cog（1-500）: <65 論理的 / 65-85 バランス / >85 情動的

■ 判定の優先順位（高→低）
1. aggression>0 または dissatisfaction>0 または stress>50 → 怒り・苛立ち
2. upset>0 または atmosphere<-20 → 沈んだ気分・悲しみ
3. content>0 または atmosphere>30 → 上機嫌・喜び
4. hesitation>20 または uncertainty>20 → ためらい・嘘の可能性
5. energy>20 または excitement>20 → テンション高め
6. 上記すべてに該当しない（補助指標がほぼ 0、energy 5-15 程度）
   → **「普通の落ち着いた会話」として扱う**（悲しいではない！）

■ 絶対に守ること
- 補助指標（aggression/upset/content/dissatisfaction）が **すべて 0** の場合、
  energy が低くても「悲しい」と決めつけない。落ち着いた普通の会話として扱う。
- 同じテキストでも、補助指標の有無で意味は大きく変わる。
- スコアが null の場合のみテキストの推定感情ラベルにフォールバック

【重要】返答は必ずJSON形式のみで返すこと。前後に説明文を付けないこと。
数値にはプラス符号（+）を付けないこと。

{
  "npcText": "NPCのセリフ（キャラクターの口調を守った自然な日本語）",
  "affectionDelta": -5〜10の整数,
  "trustDelta": -5〜10の整数,
  "irritationDelta": -10〜20の整数,
  "emotion": "NPCの感情状態の一言説明（UI表示用）"
}`;

  // 声色データ（Claude の内部参照用。値も指標名も返答に出さないこと）
  const sentimentBlock = sentiment
    ? `
【声色データ（あなたの内部メモ／返答に絶対出さない）】
- 攻撃性: ${sentiment.aggression} / 動揺: ${sentiment.upset} / 喜び: ${sentiment.content} / 不満: ${sentiment.dissatisfaction}
- 情熱: ${sentiment.passionate} / 困惑: ${sentiment.embarrassment} / 想像力: ${sentiment.imagination_activity} / 極端な起伏: ${sentiment.extreme_emotion}
- 興奮: ${sentiment.excitement} / 躊躇: ${sentiment.hesitation} / 不確実: ${sentiment.uncertainty} / 自信: ${sentiment.confidence}
- 活力: ${sentiment.energy} / ストレス: ${sentiment.stress} / 集中: ${sentiment.concentration} / 期待: ${sentiment.anticipation} / 思考: ${sentiment.intensive_thinking}
- 雰囲気: ${sentiment.atmosphere}（負＝沈む/正＝明るい） / 論理-感情バランス: ${sentiment.emo_cog}（<65論理的/>85情動的）

→ これらは「相手の声を聞いて感じ取った印象」として返答に滲ませる。
  数値も指標名も返答に出さず、人間らしい言葉で表現すること。`
    : `
【声色データ】取得なし（テキストだけで判断する）`;

  // 毎回変わる動的情報はユーザーメッセージに含める
  const userMessage = `【NPCの現在状態】
- 好感度: ${npcState.affection}/100
- 信頼度: ${npcState.trust}/100
- 苛立ち度: ${npcState.irritation}/100

【プレイヤーの発話情報】
- 発言内容: ${text}
- 話速: ${speed}
- 推定感情ラベル: ${emotion}
- 口調: ${tone}${sentimentBlock}`;

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 512,
      system: [{ type: "text", text: staticSystemPrompt, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userMessage }],
    });

    const rawText = message.content[0].text.trim();

    // Claude が ```json ... ``` で囲んだり前置きを付けて返すことがあるため、
    // 最初に出てくる { から最後の } までを切り出してパースする
    const npcResponse = parseNpcJson(rawText, character);
    console.log(`[chat] npcText="${npcResponse.npcText}"`);

    res.json(npcResponse);
  } catch (err) {
    console.error("Claude API エラー:", err.message);
    res.status(500).json({ error: "Claude API への接続に失敗しました" });
  }
});

// ============================================================
// GET /api/characters
// フロントにキャラクター一覧（IDと表示名のみ）を返す
// ============================================================
app.get("/api/characters", (req, res) => {
  const list = Object.entries(CHARACTERS).map(([id, c]) => ({
    id,
    name: c.name,
    fallback: c.fallback,
  }));
  res.json(list);
});

// ============================================================
// POST /api/recognize
// 音声ファイルを受け取り、AmiVoice 非同期 HTTP API（v1）に投げて
// テキスト認識 + 感情分析結果をまとめて返す。
//
// AmiVoice 非同期 HTTP API の正規フロー（公式ドキュメント準拠）：
//   1) POST /v1/recognitions     → sessionid を取得
//   2) GET  /v1/recognitions/{sessionid} を status が completed/error
//      になるまでポーリング（推奨間隔 10 秒）
//   3) completed のレスポンスから text / results[0].confidence /
//      sentiment_analysis.segments を取り出す
//
// 感情分析は v2 では未対応のため v1 を使用する。
// （v2 での感情分析は 2026年7月以降の対応予定）
// 参考: https://docs.amivoice.com/amivoice-api/manual/async-http-interface
// ============================================================
app.post("/api/recognize", express.raw({ type: "*/*", limit: "50mb" }), async (req, res) => {
  if (!process.env.AMIVOICE_API_KEY) {
    return res.status(500).json({ error: "AMIVOICE_API_KEY が設定されていません" });
  }

  const audioBuffer = req.body;
  const mimeType = req.headers["content-type"] || "audio/wav";

  // ── ジョブ投入 ────────────────────────────────────────────
  // multipart/form-data で音声ファイルと認識設定を送る
  const boundary = "----AmiVoiceBoundary";
  const dValue = "grammarFileNames=-a-general sentimentAnalysis=True loggingOptOut=True";

  // multipart ボディを手動構築（Node.js 標準機能のみで依存なし）
  const bodyParts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="u"\r\n\r\n${process.env.AMIVOICE_API_KEY}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="d"\r\n\r\n${dValue}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="a"; filename="audio"\r\nContent-Type: ${mimeType}\r\n\r\n`,
  ];

  const bodyPrefix = Buffer.from(bodyParts.join("\r\n") + "\r\n");
  const bodySuffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const multipartBody = Buffer.concat([bodyPrefix, audioBuffer, bodySuffix]);

  // ── ① ジョブ投入 ───────────────────────────────────────────
  // 公式ドキュメントの「ジョブの作成」フェーズに対応。
  // 成功時のレスポンス: {"sessionid": "...", "text": "..."}
  // 失敗時のレスポンス: sessionid が無く、code と message が含まれる
  let sessionId;
  try {
    const submitRes = await fetch("https://acp-api-async.amivoice.com/v1/recognitions", {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": multipartBody.length,
      },
      body: multipartBody,
    });

    // HTTP レイヤーのエラー
    if (!submitRes.ok) {
      const errText = await submitRes.text();
      console.error(`[recognize] ジョブ投入 HTTP ${submitRes.status}:`, errText);
      return res.status(502).json({ error: `AmiVoice ジョブ投入失敗 (${submitRes.status}): ${errText}` });
    }

    const submitJson = await submitRes.json();
    console.log("[recognize] 投入レスポンス:", submitJson);

    // 公式仕様: 失敗時は sessionid が含まれない
    if (!submitJson.sessionid) {
      const detail = submitJson.message || submitJson.code || "詳細不明";
      console.error("[recognize] ジョブ作成失敗:", submitJson);
      return res.status(502).json({ error: `AmiVoice ジョブ作成失敗: ${detail}` });
    }

    sessionId = submitJson.sessionid;
  } catch (err) {
    console.error("[recognize] 接続失敗:", err);
    return res.status(502).json({ error: `AmiVoice 接続失敗: ${err.message}` });
  }

  // ── ② ステータスポーリング ──────────────────────────────────
  // 公式仕様：
  //   - status が completed / error になるまで GET でポーリング
  //   - queued から started に進むだけで「数十秒〜数分」かかることがある
  //   - 公式サンプルは 10 秒間隔、タイムアウトは 5 分以上を想定
  //
  // 認証情報（APIキー）は Authorization: Bearer ヘッダで指定する
  const POLL_INTERVAL_MS = 3_000;       // 3秒ごとにポーリング（個人の検証用途を想定して短めに）
  const MAX_WAIT_MS = 5 * 60 * 1000;    // 最大5分
  const startedAt = Date.now();
  let result;

  while (true) {
    if (Date.now() - startedAt > MAX_WAIT_MS) {
      return res.status(504).json({ error: "AmiVoice 認識がタイムアウトしました（5分超過）" });
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    let pollJson;
    try {
      const pollRes = await fetch(
        `https://acp-api-async.amivoice.com/v1/recognitions/${sessionId}`,
        { headers: { Authorization: `Bearer ${process.env.AMIVOICE_API_KEY}` } },
      );

      if (!pollRes.ok) {
        const errText = await pollRes.text();
        console.error(`[recognize] ポーリング HTTP ${pollRes.status}:`, errText);
        return res.status(502).json({ error: `AmiVoice ポーリング失敗 (${pollRes.status}): ${errText}` });
      }
      pollJson = await pollRes.json();
    } catch (err) {
      console.error("[recognize] ポーリング接続失敗:", err);
      return res.status(502).json({ error: `AmiVoice ポーリング接続失敗: ${err.message}` });
    }

    console.log(`[recognize] status=${pollJson.status}`);

    if (pollJson.status === "completed") {
      result = pollJson;
      break;
    }
    if (pollJson.status === "error") {
      console.error("[recognize] AmiVoice 認識エラー:", pollJson);
      const detail = pollJson.error_message || pollJson.message || "詳細不明";
      return res.status(502).json({ error: `AmiVoice 認識エラー: ${detail}` });
    }
    // queued / started / processing は続けてポーリング
  }

  console.log("[recognize] 完了:", JSON.stringify(result).slice(0, 500));

  // 感情分析セグメントの生データを完全にログ出力（パラメータ名・値の確認用）
  if (result.sentiment_analysis?.segments?.length > 0) {
    console.log("[recognize] sentiment_analysis 生データ（最初のセグメント）:");
    console.log(JSON.stringify(result.sentiment_analysis.segments[0], null, 2));
  } else {
    console.warn("[recognize] sentiment_analysis が結果に含まれていません");
  }

  // ── テキスト認識結果の取り出し ────────────────────────────
  // v1（感情分析あり）の場合のレスポンス構造：
  //   - 通常: result.text（全文）, result.results[0].confidence
  //   - 話者分離あり: result.text, result.segments[0].results[0].confidence
  // 念のため両パスをフォールバックで参照する。
  const text =
    result.text ||
    result.results?.[0]?.text ||
    result.segments?.[0]?.results?.[0]?.text ||
    "";

  const confidence =
    result.results?.[0]?.confidence ??
    result.segments?.[0]?.results?.[0]?.confidence ??
    null;

  // ── 感情スコアの抽出・正規化 ──────────────────────────────
  // 公式仕様: sentiment_analysis.segments に約2秒ごとに 20 個の感情パラメータが入る。
  // 全セグメントの平均を取って会話全体の感情を代表させる。
  //
  // パラメータ名・値範囲は SENTIMENT_DEFS（公式 API で取得済み）に従う。
  const sentSegments = result.sentiment_analysis?.segments ?? [];
  let sentiment = null;

  if (sentSegments.length > 0) {
    const avg = (key) => {
      const values = sentSegments
        .map((s) => (typeof s[key] === "number" ? s[key] : null))
        .filter((v) => v !== null);
      if (values.length === 0) return null;
      // 整数で記述するパラメータは round、小数の可能性があるものはそのまま
      return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
    };

    const scores = {};
    for (const def of SENTIMENT_DEFS) {
      scores[def.key] = avg(def.key);
    }

    // 全部 null（キーが一致しなかった等）なら諦めて null
    const allNull = Object.values(scores).every((v) => v === null);
    if (allNull) {
      console.warn(
        "[recognize] 感情スコアの抽出に失敗しました（全キー null）。" +
          "AmiVoice のレスポンス形式を確認してください。"
      );
      sentiment = null;
    } else {
      // null は 0 として埋める（フロントでの計算が破綻しないように）
      sentiment = Object.fromEntries(
        Object.entries(scores).map(([k, v]) => [k, v ?? 0])
      );
    }
  }

  console.log(`[recognize] text="${text}" confidence=${confidence} sentimentSegments=${sentSegments.length}`);
  if (sentiment) {
    console.log("[recognize] 感情スコア:", sentiment);
  }

  res.json({ text, confidence, sentiment });
});

app.listen(PORT, async () => {
  console.log(`🎮 声のペルソナ サーバー起動: http://localhost:${PORT}`);
  // 起動時に感情パラメータ一覧を取得して、実際のJSONキー名を確認できるようにする
  await fetchSentimentParameterList();
});
