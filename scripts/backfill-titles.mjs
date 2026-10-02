import pg from 'pg';
import { connectionString } from './db-connect.mjs';

/**
 * 既存の記事に、設定言語での見出し（summaries.title_ja、0023）を後から付ける。
 *
 * 見出しの翻訳は本来「要約と同じ呼び出しのついで」なので、これから取り込む記事には
 * 何もしなくても付く。困るのは**既にある記事**で、実データでは1262件中531件（42%）が
 * 英語のフィードだった。一覧を眺めるたびに英語が並ぶ。
 *
 * 要約をやり直すと1件あたりの入力が本文ぶん重く、回数も5件ずつで250回になる。
 * ここでは**見出しだけ**を30件ずつ訳すので、531件でも18回程度で済む。
 *
 *   node --env-file=.env.local scripts/backfill-titles.mjs        # 何件対象かを見るだけ
 *   node --env-file=.env.local scripts/backfill-titles.mjs --run  # 実行する
 *   … --lang=en                                                    # ja 以外の見出しを埋める
 */

const RUN = process.argv.includes('--run');
const BATCH = 30;
const MODEL = process.env.GEMINI_SUMMARY_MODEL ?? 'gemini-3.5-flash-lite';

const client = new pg.Client({ connectionString: connectionString(), ssl: { rejectUnauthorized: false } });
await client.connect();

// 要約は言語ごとに持つ（0047）。どの言語の見出しを埋めるかは引数で選ぶ（既定 ja）。
const langArg = process.argv.find((a) => a.startsWith('--lang='));
const language = langArg ? langArg.slice('--lang='.length) : 'ja';

/**
 * 対象は「要約はあるが title_ja が無い」もの。
 * 要約が無いものは、そのうち要約ジョブが走ったときに一緒に付くので触らない。
 */
const targets = (
  await client.query(
    `select s.article_id, a.title
       from summaries s join articles a on a.id = s.article_id
      where s.title_ja is null and s.language = $1
      order by a.published_at desc nulls last`,
    [language],
  )
).rows;

console.log(`対象: ${targets.length}件 / 言語: ${language} / ${Math.ceil(targets.length / BATCH)}回の呼び出し`);
if (!RUN) {
  console.log('--run を付けると実行します。');
  await client.end();
  process.exit(0);
}

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error('GEMINI_API_KEY がありません');

let done = 0;
for (let i = 0; i < targets.length; i += BATCH) {
  const batch = targets.slice(i, i + BATCH);

  const prompt = [
    `次の記事見出しを${language === 'ja' ? '日本語' : language}にしてください。`,
    '元からその言語のものは、そのまま返してください。',
    '直訳に拘らず、内容が伝わる簡潔な見出しにしてください。40字以内。',
    'id は入力の値をそのまま返してください。',
    '',
    ...batch.map((t) => `${t.article_id}\t${t.title}`),
  ].join('\n');

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'object',
            properties: {
              titles: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { id: { type: 'string' }, title: { type: 'string' } },
                  required: ['id', 'title'],
                },
              },
            },
            required: ['titles'],
          },
        },
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    console.log(`  ${i}〜: x ${res.status} ${body.slice(0, 120)}`);
    // 429 は毎分の上限。少し待てば続けられる。
    if (res.status === 429) await new Promise((r) => setTimeout(r, 30_000));
    continue;
  }

  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
  const parsed = JSON.parse(text);
  const known = new Map(batch.map((b) => [b.article_id, b.title]));

  for (const row of parsed.titles ?? []) {
    // モデルが id を作り変えてくることがあるので、入力に無いものは捨てる。
    if (!known.has(row.id)) continue;
    const title = String(row.title ?? '').trim().slice(0, 120);
    if (!title) continue;
    await client.query(`update summaries set title_ja = $1 where article_id = $2 and language = $3`, [title, row.id, language]);
    done++;
  }

  console.log(`  ${i + batch.length}/${targets.length} 件まで（更新 ${done}）`);
  // 毎分の上限に当たらないよう間隔を空ける。
  await new Promise((r) => setTimeout(r, 4_000));
}

console.log(`\n付けた見出し: ${done}件`);
await client.end();
