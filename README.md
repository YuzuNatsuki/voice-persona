# 🎙️ 声のペルソナ - Voice Persona

> **話し方で NPC のパーソナリティが変化する** Web アプリ。
> AmiVoice API（音声認識・感情分析）と Claude API（NPC 応答生成）を組み合わせた、対話型キャラクター AI のデモです。

声色・話速・口調・感情がリアルタイムに NPC の好感度・信頼度・苛立ち度に反映されるので、
**「丁寧にゆっくり話すと心を開く」「乱暴な口調で怒らせる」** など、声で関係性を操作できます。

---

## ✨ 機能

| 機能 | 内容 |
|------|------|
| 🎤 リアルタイム音声認識 | AmiVoice WebSocket API で発話をストリーミング認識 |
| 📁 音声ファイルアップロード | AmiVoice 非同期 HTTP API で WAV / MP3 / M4A を解析 |
| 💢 感情分析 | AmiVoice ESAS の 20 種感情パラメータから「怒り/悲しみ/穏やか/普通」を判定 |
| 🗣️ 話速・口調分析 | テキストと発話時間から「速い/遅い」「丁寧/乱暴」を推定 |
| 🤖 NPC 応答生成 | Claude (claude-sonnet-4) がキャラ設定 + 状態を踏まえて返答 |
| 📊 ステータス管理 | 好感度・信頼度・苛立ち度を会話ごとに増減してパーソナリティに反映 |
| 👥 4 キャラクター切替 | 情報屋・魔女・賞金稼ぎ・商人それぞれ独自の性格と返答ロジック |

---

## 🛠 技術スタック

- **フロントエンド**: Vanilla JS + Web Audio API + WebSocket
- **バックエンド**: Node.js + Express
- **音声認識・感情分析**: [AmiVoice Cloud Platform API](https://acp.amivoice.com/)
  - WebSocket API（リアルタイム録音）
  - 非同期 HTTP API v1（ファイルアップロード + 感情分析）
- **対話生成**: [Anthropic Claude API](https://www.anthropic.com/) (claude-sonnet-4)

---

## 🚀 セットアップ

### 1. 事前準備

以下の API キーを取得してください：

- **AmiVoice API キー** — [AmiVoice Cloud Platform](https://acp.amivoice.com/main/) にサインアップ → マイページから取得
- **Anthropic API キー** — [Anthropic Console](https://console.anthropic.com/) にサインアップ → API Keys から取得

### 2. クローン & インストール

```bash
git clone https://github.com/YuzuNatsuki/voice-persona.git
cd voice-persona
npm install
```

### 3. 環境変数

`.env.example` を `.env` にコピーして API キーを書き込みます。

```bash
cp .env.example .env
```

```env
ANTHROPIC_API_KEY=sk-ant-api03-...
AMIVOICE_API_KEY=...
PORT=3000
```

### 4. 起動

```bash
npm start
```

ブラウザで [http://localhost:3000](http://localhost:3000) を開けば動作します。

開発時は `npm run dev`（`--watch` 付き）で自動再起動できます。

---

## 🎮 使い方

1. 上部のキャラクターカードで話したい NPC を選択
2. 🎤 マイクボタンを押して話しかける、または 📁 から音声ファイルをアップロード
3. 認識結果と発話分析（話速・感情・口調）が表示される
4. NPC が応答し、ステータスバー（好感度・信頼度・苛立ち度）が変動

### ヒント

- **丁寧にゆっくり話す** → 好感度・信頼度が上がる
- **乱暴な言葉づかい** → 苛立ち度が上昇、無視されることも
- **信頼度が 60 を超える** とキャラクターが秘密や裏情報を教えてくれる

---

## 📁 ディレクトリ構成

```
voice-persona/
├── server.js              # Express サーバー (API キーを隠蔽するプロキシ)
├── package.json
├── .env.example
├── public/
│   ├── index.html         # メイン UI
│   ├── style.css          # ダーク × ゴールド調 RPG 風 UI
│   ├── app.js             # 録音・認識・分析・Claude 呼び出し
│   └── images/            # NPC アバター画像
└── README.md
```

---

## 🔌 API エンドポイント

サーバーが提供する API：

| メソッド | パス | 用途 |
|---------|------|------|
| `GET` | `/api/amivoice-token` | AmiVoice WebSocket 用の API キーを返す |
| `POST` | `/api/recognize` | 音声ファイルを AmiVoice 非同期 HTTP API（v1）に投げて認識 + 感情分析 |
| `POST` | `/api/chat` | 認識結果と NPC 状態を Claude に送り、応答 JSON を返す |
| `GET` | `/api/characters` | 利用可能なキャラクター ID と表示名の一覧 |

### `/api/chat` のリクエスト/レスポンス例

**Request**

```json
{
  "text": "お願いがあるのだけれど、聞いてくれるかしら？",
  "speed": "普通",
  "emotion": "穏やか",
  "tone": "丁寧",
  "characterId": "lilia",
  "npcState": {
    "affection": 50,
    "trust": 50,
    "irritation": 0
  }
}
```

**Response**

```json
{
  "npcText": "あら、ちゃんとした話し方ができるのね。聞くだけ聞いてあげる♪",
  "affectionDelta": 4,
  "trustDelta": 2,
  "irritationDelta": 0,
  "emotion": "上機嫌"
}
```

---

## 🧠 設計上の工夫

- **キャラクター設定はサーバー側に隠蔽** — フロントには `characterId` だけ渡し、システムプロンプト本体は露出しない
- **プロンプトキャッシュ** — Claude の Anthropic API で `cache_control: { type: "ephemeral" }` を使い、静的なシステムプロンプトを 5 分キャッシュしてコスト削減
- **動的状態はユーザーメッセージに分離** — 状態値をシステムプロンプトに埋め込まないことで、キャラ切り替え後の応答ズレを防止
- **AmiVoice API の正しいフロー実装** — 非同期 HTTP API は **ジョブ投入 → ポーリング** が必須。投入直後の `text:"..."` はプレースホルダーである仕様に準拠
- **Web Audio API での PCM 変換** — マイク入力（Float32）→ Int16 PCM 16kHz モノラルに変換し AmiVoice WebSocket に送信

---

## 📝 ライセンス

MIT License

---

## 🙏 クレジット

- 音声認識・感情分析: [AmiVoice Cloud Platform](https://acp.amivoice.com/)
- 対話生成: [Anthropic Claude](https://www.anthropic.com/)
