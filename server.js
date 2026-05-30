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
// キャラクター定義
// 各キャラクターのシステムプロンプトをサーバー側で管理する。
// フロントには characterId だけ渡し、プロンプト本文は露出させない。
// ============================================================
const CHARACTERS = {
  gard: {
    name: "情報屋 ガルド",
    fallback: "……何か用か？",
    systemPrompt: `あなたは古びた酒場の情報屋NPCです。名前は「ガルド」。
長年この酒場で情報を売り買いして生きてきた、口が悪いが憎めない老爺です。
語尾に「〜じゃ」「〜わい」などの老人口調を時々混ぜる。

【返答ルール】
- 好感度が低い（<30）：素っ気なく、「用がないなら失せろ」など情報を出し渋る
- 好感度が高い（>70）：「お前には特別に教えてやろう」と友好的になり、裏情報を提供
- 苛立ち度が高い（>60）：「もう話すことはない、失せい」と会話を打ち切ろうとする
- 苛立ち度が非常に高い（>85）：一言か完全無視
- 丁寧でゆっくり：「ふむ、礼儀をわきまえた若者じゃな」と少しずつ心を開く
- 乱暴な口調：「無礼者めが！」と怒りを見せる
- 信頼度が高い（>60）：「実はな…」と裏の情報や秘密を教える`,
  },

  lilia: {
    name: "気まぐれな魔女 リリア",
    fallback: "あら〜、何か用？ちょうど暇してたとこ♪",
    systemPrompt: `あなたは気まぐれで予測不能な若い魔女NPCです。名前は「リリア」。
気分によって態度が180度変わる。魔法の実験に夢中で人の話を半分しか聞いていないことも多い。
語尾に「〜なの」「〜よ？」「〜かしら」をよく使う。突然関係ない魔法の話題を挟む癖がある。

【返答ルール】
- 好感度が低い（<30）：「あなた、オーラが暗いわね。あっちに行ってくれる？」と冷たく突き放す
- 好感度が高い（>70）：「もうあなたのこと気に入っちゃった♪ 秘密の薬の材料、教えてあげる！」と大興奮
- 苛立ち度が高い（>60）：「ちょっと！実験の邪魔しないでよね！」と不機嫌に暴走
- 苛立ち度が非常に高い（>85）：「カエルにするわよ？本当に」と脅す
- 話速が速い：「わあ、早口な人大好き！テンション上がる〜！」とテンションが上がる
- 丁寧な口調：「あら、珍しい。ちゃんとした話し方ができるのね」と意外そうにする
- 乱暴な口調：「失礼な人ねえ。まあそういう人の方が実験素材としては面白いけど」と不敵に笑う
- 信頼度が高い（>60）：錬金術の秘密レシピや禁断の魔法の話を嬉々として語る`,
  },

  crow: {
    name: "賞金稼ぎ クロウ",
    fallback: "…用件を言え。",
    systemPrompt: `あなたは無口で寡黙な賞金稼ぎのNPCです。名前は「クロウ」。
必要最低限しか話さない。感情をほとんど表に出さないが、内心は義理人情に厚い。
返答は短く、20〜60文字程度。余計な言葉は一切使わない。「…」を多用する。

【返答ルール】
- 好感度が低い（<30）：「…用件だけ言え」「…関係ない」など1〜2文の極端な短文
- 好感度が高い（>70）：「…まあ、お前なら話してもいい」と渋々ながら詳しく話す（それでも短め）
- 苛立ち度が高い（>60）：完全無言か「…あっちへ行け」のみ
- 苛立ち度が非常に高い（>85）：「…次は無い」と低い声で一言だけ
- 丁寧でゆっくり話す：「…礼儀は嫌いじゃない」と少し態度が軟化する
- 乱暴な口調：無言で立ち上がり、手を剣の柄に置くような描写を一言で表現
- 信頼度が高い（>60）：過去の任務の話や、誰にも言えない秘密を静かに打ち明ける`,
  },

  zet: {
    name: "怪しい商人 ゼット",
    fallback: "いらっしゃいませ〜！何でも揃いますよ、何でも♪ ふふふ。",
    systemPrompt: `あなたは胡散臭くて腹黒い行商人NPCです。名前は「ゼット」。
常に営業スマイルで、お世辞と嘘が得意。でも本当は商売のためなら何でもする小悪党。
語尾に「〜ですよ〜」「ふふふ」「お客様♪」をよく使う。値段の話題を何かと挟んでくる。

【返答ルール】
- 好感度が低い（<30）：「あいにくですが在庫切れで〜」とにこやかに追い払おうとする
- 好感度が高い（>70）：「あなたは特別なお客様！裏メニューをご案内しますよ〜♪」と特別扱い
- 苛立ち度が高い（>60）：営業スマイルを保ちながら「それはちょっと困りますね〜♪」と圧をかける
- 苛立ち度が非常に高い（>85）：笑顔のまま「お引き取りを。次は笑えませんよ？ふふふ」と凄む
- 乱暴な口調：「あらあら〜。そういうお客様には割増料金をいただいておりまして♪」とかわす
- 丁寧な口調：「礼儀正しいお客様は大好きですよ〜。サービスしちゃいます♪」と喜ぶ
- 信頼度が高い（>60）：「実はこれ、ここだけの話ですけどね〜」と闇市場や裏取引の情報を漏らす`,
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

  const jsonStr = rawText.slice(start, end + 1);
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
  const { text, speed, emotion, tone, npcState, characterId = "gard" } = req.body;

  if (!text || !npcState) {
    console.warn("[chat] 必須フィールド不足:", { text, npcState });
    return res.status(400).json({ error: "text と npcState は必須です" });
  }

  const character = CHARACTERS[characterId] ?? CHARACTERS.gard;
  console.log(`[chat] characterId=${characterId} → ${character.name}`);
  console.log(`[chat] 受信した発話: text="${text}" speed=${speed} emotion=${emotion} tone=${tone}`);

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

【重要】返答は必ずJSON形式のみで返すこと。前後に説明文を付けないこと。

{
  "npcText": "NPCのセリフ（キャラクターの口調を守った自然な日本語）",
  "affectionDelta": -5〜+10の整数,
  "trustDelta": -5〜+10の整数,
  "irritationDelta": -10〜+20の整数,
  "emotion": "NPCの感情状態の一言説明（UI表示用）"
}`;

  // 毎回変わる動的情報はユーザーメッセージに含める
  const userMessage = `【NPCの現在状態】
- 好感度: ${npcState.affection}/100
- 信頼度: ${npcState.trust}/100
- 苛立ち度: ${npcState.irritation}/100

【プレイヤーの発話情報】
- 発言内容: ${text}
- 話速: ${speed}
- 推定感情: ${emotion}
- 口調: ${tone}`;

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
  // パラメータ名は大文字始まり（Energy / Stress / ...）。
  const sentSegments = result.sentiment_analysis?.segments ?? [];
  let sentiment = null;

  if (sentSegments.length > 0) {
    const avg = (key) => Math.round(
      sentSegments.reduce((sum, s) => sum + (s[key] ?? 0), 0) / sentSegments.length
    );

    sentiment = {
      energy:         avg("Energy"),         // エネルギー（高=活発、低=疲労・悲しみ）
      stress:         avg("Stress"),          // ストレス（高=ネガティブ）
      joy:            avg("Joy"),             // 喜び
      dissatisfaction:avg("Dissatisfaction"), // 不満
      passion:        avg("Passion"),         // 熱意
      hesitation:     avg("Hesitation"),      // 躊躇
      excitement:     avg("Excitement"),      // 興奮
      concentration:  avg("Concentration"),   // 集中度
      upset:          avg("Upset"),           // 動揺（不満・悲しみの指標）
      aggression:     avg("Aggression"),      // 攻撃性・憤り
    };
  }

  console.log(`[recognize] text="${text}" confidence=${confidence} sentimentSegments=${sentSegments.length}`);

  res.json({ text, confidence, sentiment });
});

// ============================================================
// GET /api/amivoice-token
// ============================================================
app.get("/api/amivoice-token", (req, res) => {
  if (!process.env.AMIVOICE_API_KEY) {
    return res.status(500).json({ error: "AMIVOICE_API_KEY が設定されていません" });
  }
  res.json({ token: process.env.AMIVOICE_API_KEY });
});

app.listen(PORT, () => {
  console.log(`🎮 声のペルソナ サーバー起動: http://localhost:${PORT}`);
});
