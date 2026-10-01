import { requireSession } from '@/lib/auth/guard';
import { Suspense } from 'react';
import { AppShellSkeleton, Bar, PageSkeleton } from '@/components/Skeleton';
import { JST } from '@/lib/datetime';
import { currentUser } from '@/lib/auth/session';
import { AppShell } from '@/components/AppShell';
import { VOICE_MODE_LABELS, type VoiceMode } from '@/lib/ai/script';
import { DEFAULT_VOICE_A, DEFAULT_VOICE_B, TTS_VOICES, normalizeVoice } from '@/lib/ai/tts';
import { LANGUAGES, normalizeLanguage, type LanguageCode } from '@/lib/language';
import { listSubscribedFeeds } from '@/lib/subscriptions';
import {
  createFolder,
  importOpml,
  moveFolder,
  renameFolder,
} from '@/app/actions/feeds';
import { signOut } from '@/app/actions/articles';
import { ActionForm } from '@/components/ActionForm';
import { AddFeed } from '@/components/AddFeed';
import { DeleteFolderButton } from '@/components/DeleteFolderButton';
import { DriveConnect } from '@/components/DriveConnect';
import { FeedHealth } from '@/components/FeedHealth';
import { UnsubscribeButton } from '@/components/UnsubscribeButton';
import { FolderSelect } from '@/components/FolderSelect';
import { PasskeyManager, type PasskeyRow } from '@/components/PasskeyManager';
import { TextScale } from '@/components/TextScale';
import { ExternalBrowserPicker } from '@/components/ExternalBrowser';
import { ThemeColorPicker } from '@/components/ThemeColorPicker';
import { PushToggle } from '@/components/PushToggle';
import { SettingsForm, type SaveState } from '@/components/SettingsForm';
import { UsageTable } from '@/components/UsageTable';
import { BootTimings } from '@/components/BootTimings';
import { recentUsage } from '@/lib/ai/usage';
import { pipelineStatus } from '@/lib/pipeline';
import {
  DEFAULT_DIGEST_COUNT,
  DEFAULT_DIGEST_HOUR,
  DEFAULT_MEDIA_RETENTION_DAYS,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_VOICE_MODE,
} from '@/lib/settings/defaults';
import { getDriveStatus, saveGoogleCredentials } from '@/app/actions/drive';
import { deleteGeminiKey, getGeminiKeyStatus, saveGeminiKey } from '@/app/actions/ai-keys';
import { GeminiKeyForm } from '@/components/GeminiKeyForm';
import { DEFAULT_NOTEBOOKLM_PROMPT } from '@/lib/export/prompt';
import { createClient } from '@/lib/supabase/server';
import Link from 'next/link';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import type { FeedRow, FolderRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * **枠だけを先に流すための入れ子。ここは `async` にしないこと。**
 *
 * 本体が最初の `await` を返すまで、React は `<html>` も `<head>` も出せない
 * ——ブラウザが CSS と JS を落とし始められるのがそこからになる
 * （docs/traps/perf.md「最初の `await` が終わるまで `<head>` すら出ない」）。
 * fallback は `components/Skeleton.tsx`。
 */
export default async function SettingsPage(props: PageProps<'/settings'>) {
  // ログインしていない人はここで追い返す（proxy.ts の代わり。lib/auth/guard.ts）。
  // <Suspense> の手前で呼ぶこと——中で呼ぶと 307 ではなく「出してから飛ばす」形になる。
  await requireSession('/settings');

  return (
    <Suspense fallback={<AppShellSkeleton><PageSkeleton rows={7} tall /></AppShellSkeleton>}>
      <Settings {...props} />
    </Suspense>
  );
}

async function Settings({ searchParams }: PageProps<'/settings'>) {
  const supabase = await createClient();
  // OAuth から戻ってきたときの結果（?drive=connected など）。
  const notice = typeof (await searchParams).drive === 'string'
    ? ((await searchParams).drive as string)
    : undefined;

  const [feeds, { data: folders }, { data: settings }, drive, { data: passkeys }, geminiKey] =
    await Promise.all([
      listSubscribedFeeds({ stats: true }),
      // 並び順はサイドバーと揃える（sort_order → 名前）。
      supabase.from('folders').select('id, name').order('sort_order').order('name'),
      supabase.from('settings').select('*').maybeSingle(),
      getDriveStatus(),
      // 自分のぶんしか返らない（RLS）。公開鍵そのものは画面に要らない。
      supabase
        .from('passkeys')
        .select('id, label, device_type, backed_up, created_at, last_used_at')
        .order('created_at'),
      getGeminiKeyStatus(),
    ]);

  /**
   * 同意のあとに戻ってくる先。**環境変数ではなく、いま開いている URL から作る**
   * （lib/export/drive.ts の redirectUriFor と同じ組み立て）。
   *
   * 画面に出すのは、この文字列を Google Cloud Console の「承認済みの
   * リダイレクト URI」へ登録してもらう必要があるため。ここが1文字でも違うと
   * 同意画面まで行ってから Google 側で弾かれ、**こちらには何も戻ってこない**。
   */
  const h = await headers();
  const host = h.get('host');
  const proto = h.get('x-forwarded-proto') ?? (host?.startsWith('localhost') ? 'http' : 'https');
  const callbackUrl = host ? `${proto}://${host}/api/auth/google/callback` : undefined;

  /**
   * 設定の保存。
   *
   * 結果を**戻り値で**返す。throw すると本番では中身が digest に置き換わり、
   * 画面には「Minified React error #441」しか届かない（actions/media.ts の注記）。
   * 保存できたかどうかは SettingsForm が出す。
   */
  async function saveSettings(_prev: SaveState, formData: FormData): Promise<SaveState> {
    'use server';
    const supabase = await createClient();
    const user = await currentUser(supabase);
    if (!user) return { ok: false, message: '未ログインです' };

    const { error } = await supabase.from('settings').upsert(
      {
        user_id: user.id,
        notebooklm_prompt: String(formData.get('notebooklm_prompt') ?? ''),
        digest_count: Number(formData.get('digest_count') ?? DEFAULT_DIGEST_COUNT),
        digest_hour: Number(formData.get('digest_hour') ?? DEFAULT_DIGEST_HOUR),
        retention_days: Number(formData.get('retention_days') ?? DEFAULT_RETENTION_DAYS),
        media_retention_days: Number(
          formData.get('media_retention_days') ?? DEFAULT_MEDIA_RETENTION_DAYS,
        ),
        voice_mode: formData.get('voice_mode') === 'dialogue' ? 'dialogue' : 'solo',
        // 表に無い名前を保存すると、合成のときに API が 400 を返す。
        tts_voice_a: normalizeVoice(formData.get('tts_voice_a'), DEFAULT_VOICE_A),
        tts_voice_b: normalizeVoice(formData.get('tts_voice_b'), DEFAULT_VOICE_B),
        // 知らない値が入ると要約の言語が黙って壊れるので、必ず通す。
        summary_language: normalizeLanguage(formData.get('summary_language')),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );
    if (error) return { ok: false, message: `保存できませんでした: ${error.message}` };

    revalidatePath('/settings');
    return {
      ok: true,
      at: new Date().toLocaleTimeString('ja-JP', {
        timeZone: JST,
        hour: '2-digit',
        minute: '2-digit',
      }),
    };
  }

  /**
   * Gemini の API キー。鍵はユーザーごと（0046）。
   *
   * 2人目以降はここに入れるまで AI が動かないので、**入っていないときは
   * いちばん上に出す。** 入っていれば、たまにしか触らない設定として下へ回す。
   */
  const geminiKeySection = (
    <section>
      <h2 className="mb-2 section-title">Gemini の API キー（要約・音声）</h2>
      <GeminiKeyForm
        usable={geminiKey.usable}
        masked={geminiKey.masked}
        fromEnv={geminiKey.fromEnv}
        save={saveGeminiKey}
        remove={deleteGeminiKey}
      />
    </section>
  );

  return (
    <AppShell>
      <main className="flex-1 min-w-0 overflow-y-auto p-4 md:p-8">
      <div className="mx-auto max-w-2xl space-y-8 pb-24">
        {/*
          以前はここが折り返さない1行で、リンク6つを並べていた。スマホ幅（375px）に
          対して中身が420px ほどあり、**最後の「ログアウト」がはみ出して押せなかった**。
          見出しと導線を分け、導線側は折り返す。
        */}
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Link href="/" prefetch={true} className="text-sm text-zinc-400">
              ← 一覧
            </Link>
            <h1 className="text-xl font-bold">設定</h1>
          </div>
          {/* スマホには下部タブしか無いので、二次画面どうしを相互に張っておく。 */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Link href="/library" prefetch={true} className="text-xs text-zinc-500 hover:text-zinc-200">
              アーカイブ
            </Link>
            <Link href="/exports" prefetch={true} className="text-xs text-zinc-500 hover:text-zinc-200">
              書き出し
            </Link>
            <Link href="/account/password" prefetch={true} className="text-xs text-zinc-500 hover:text-zinc-200">
              パスワード
            </Link>
            {/*
              ログアウトだけ枠を付ける。以前は同じ灰色の小さな文字で右上隅に
              置いていて、実測 44×16px。要素としては見えているが、リンクの列に
              紛れて「ボタンがある」と気づけなかった。
            */}
            <form action={signOut} className="ml-auto">
              <button
                type="submit"
                className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
              >
                ログアウト
              </button>
            </form>
          </div>
        </div>

        {!geminiKey.usable && geminiKeySection}

        {/* ---------------- 外観設定 ---------------- */}
        {/* 読むことに直結するので上のほうに置く。
            設定を開く動機のほとんどは「読みにくい・見づらい」なので。 */}
        <section>
          <h2 className="mb-2 section-title">アクセントカラー（テーマ色）</h2>
          <ThemeColorPicker />
        </section>

        <section>
          <h2 className="mb-2 section-title">文字の大きさ</h2>
          <TextScale />
        </section>

        <section>
          <h2 className="mb-2 section-title">リンクを開くブラウザ</h2>
          <ExternalBrowserPicker />
        </section>

        <section>
          <h2 className="mb-2 section-title">パスキー（指紋・顔・PINでログイン）</h2>
          <PasskeyManager passkeys={(passkeys ?? []) as PasskeyRow[]} />
        </section>

        {geminiKey.usable && geminiKeySection}

        {/* ---------------- NotebookLM 用の指示文 ---------------- */}
        <section>
          <h2 className="mb-2 section-title">NotebookLM の音声概要の指示文</h2>
          <p className="mb-2 text-xs text-zinc-500">
            書き出しのたびにここの文面がコピーできるようになります。音声の口調・長さ・
            話の焦点はこの指示文でほぼ決まるので、聴きながら調整してください。
          </p>
          <SettingsForm action={saveSettings}>
            <textarea
              name="notebooklm_prompt"
              rows={4}
              // 未保存（settings の行がまだ無い）ときも、実際に使われる文面を出す。
              defaultValue={settings?.notebooklm_prompt ?? DEFAULT_NOTEBOOKLM_PROMPT}
              className="w-full rounded border border-zinc-700 bg-zinc-900 p-2 text-sm"
            />
            <div className="flex gap-3">
              <label className="text-xs text-zinc-400">
                ダイジェスト件数
                <input
                  type="number"
                  name="digest_count"
                  min={1}
                  max={20}
                  defaultValue={settings?.digest_count ?? 8}
                  className="ml-2 w-16 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
                />
              </label>
              <label className="text-xs text-zinc-400">
                生成時刻
                <input
                  type="number"
                  name="digest_hour"
                  min={0}
                  max={23}
                  defaultValue={settings?.digest_hour ?? DEFAULT_DIGEST_HOUR}
                  className="ml-2 w-16 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
                />
                時
              </label>
              <label className="text-xs text-zinc-400" title="0で無効（音声を永久に保持）">
                音声の保持
                <input
                  type="number"
                  name="media_retention_days"
                  min={0}
                  max={3650}
                  defaultValue={settings?.media_retention_days ?? DEFAULT_MEDIA_RETENTION_DAYS}
                  className="ml-2 w-16 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
                />
                日
              </label>
              <label className="text-xs text-zinc-400" title="0で無効（本文を永久に保持）">
                本文の保持
                <input
                  type="number"
                  name="retention_days"
                  min={0}
                  max={3650}
                  defaultValue={settings?.retention_days ?? DEFAULT_RETENTION_DAYS}
                  className="ml-2 w-16 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
                />
                日
              </label>
            </div>
            <p className="text-xs text-zinc-500">
              音声はサーバー容量の都合で既定{DEFAULT_MEDIA_RETENTION_DAYS}日。消える前に「聴く」から MP3 で保存できます。
              保持期間を過ぎた既読記事は本文だけを消します（スター・書き出し済みは対象外）。
              記事の行自体は残るので、既読の記事が未読で戻ってくることはありません。0 で無効。
            </p>

            <div>
              <label className="block text-xs text-zinc-400" htmlFor="summary_language">
                出力の言語
              </label>
              <select
                id="summary_language"
                name="summary_language"
                defaultValue={normalizeLanguage(settings?.summary_language)}
                className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm"
              >
                {(Object.keys(LANGUAGES) as LanguageCode[]).map((code) => (
                  <option key={code} value={code}>
                    {LANGUAGES[code].label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-zinc-500">
                要約・見出し・音声の台本をこの言語で作ります。記事が何語で書かれていても構いません。
                <strong className="text-zinc-400">効くのはこれから処理する記事から</strong>で、
                既にある要約は作り直しません（作り直すと無料枠を大きく使うため）。
                過去ぶんも揃えたいときは <code>npm run db:migrate</code> と同じ場所にある
                <code className="mx-1">scripts/backfill-titles.mjs</code>
                を使うか、記事を開いて「AI要約を生成する」を押してください。
              </p>
            </div>

            <div>
              <label className="block text-xs text-zinc-400" htmlFor="voice_mode">
                アプリ内音声の作り
              </label>
              <select
                id="voice_mode"
                name="voice_mode"
                defaultValue={settings?.voice_mode ?? DEFAULT_VOICE_MODE}
                className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm"
              >
                {(Object.keys(VOICE_MODE_LABELS) as VoiceMode[]).map((m) => (
                  <option key={m} value={m}>
                    {VOICE_MODE_LABELS[m]}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-zinc-500">
                次に作るものから効きます。作成済みの音声は作られたときの形のままです
                （台本が話者の数に縛られているので、後から声だけ替えることはできません）。
              </p>
            </div>

            {/*
              声。それまでは環境変数（GEMINI_TTS_VOICE_A / _B）で、
              **オーナーがデプロイし直さないと変えられなかった。**好みの話なので
              ユーザーごとに持たせる（0032）。
            */}
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="block text-xs text-zinc-400" htmlFor="tts_voice_a">
                  声（1人語り／対話の進行役）
                </label>
                <select
                  id="tts_voice_a"
                  name="tts_voice_a"
                  defaultValue={normalizeVoice(settings?.tts_voice_a, DEFAULT_VOICE_A)}
                  className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm"
                >
                  {Object.entries(TTS_VOICES).map(([name, label]) => (
                    <option key={name} value={name}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs text-zinc-400" htmlFor="tts_voice_b">
                  声（対話の聞き手）
                </label>
                <select
                  id="tts_voice_b"
                  name="tts_voice_b"
                  defaultValue={normalizeVoice(settings?.tts_voice_b, DEFAULT_VOICE_B)}
                  className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm"
                >
                  {Object.entries(TTS_VOICES).map(([name, label]) => (
                    <option key={name} value={name}>
                      {label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-zinc-500">
                  1人語りでは使いません。
                </p>
              </div>
            </div>

            <p className="text-xs text-zinc-500">
              名前だけでは選びようがないので、同じ原稿を6種類の声で読ませたものを
              <code className="mx-1 rounded bg-zinc-800 px-1">samples/voices/</code>
              に置いてあります（<code className="rounded bg-zinc-800 px-1">npm run voices</code>
              で作り直せます）。声も<strong className="text-zinc-400">作り始めた時点のものが焼かれる</strong>ので、
              途中で変えても、作成中の音声の前半と後半で声が変わることはありません。
            </p>
          </SettingsForm>
        </section>

        {/*
          ---------------- 取り込みの進み具合と使用量 ----------------

          **この2つだけ、あとから流す。** どちらも「様子を見る」ための数字で、
          設定を変えに来た人がまず見るものではない。それでいて `pipeline_status()` は
          この画面でいちばん遅い問い合わせだった（他は往復の下限＋5〜15ms なのに
          対して＋70ms）。上に並べて待つと、フィードの追加も朝の時刻も
          その70msぶん遅れて出る。
        */}
        <Suspense fallback={<DiagnosticsSkeleton />}>
          <Diagnostics />
        </Suspense>

        {/* ---------------- 通知 ---------------- */}
        <section>
          <h2 className="mb-2 section-title">Google Drive</h2>
          <p className="mb-2 text-xs text-zinc-500">
            書き出した Markdown を Google Docs として Drive に置けます。NotebookLM は
            ドライブ上のファイルを直接ソースに選べるので、ダウンロードして
            アップロードし直す手間が要らなくなります。
            <br />
            権限は<strong className="text-zinc-400">このアプリが作ったファイルだけ</strong>
            （drive.file）。既存のドライブの中身は読みません。
          </p>
          <DriveConnect
            connected={drive.connected}
            email={drive.email}
            notice={notice}
            configured={drive.configured}
            clientId={drive.clientId}
            fromEnv={drive.fromEnv}
            callbackUrl={callbackUrl}
            saveCredentials={saveGoogleCredentials}
          />
        </section>

        {/* ---------------- 通知 ---------------- */}
        <section>
          <h2 className="mb-2 section-title">ダイジェストの通知</h2>
          <p className="mb-2 text-xs text-zinc-500">
            朝のダイジェストができたときに通知します。アプリを開いていなくても届くので、
            これが「起きたら聴く」の起点になります。端末ごとに登録が要ります。
          </p>
          {process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ? (
            <PushToggle vapidPublicKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY} />
          ) : (
            <p className="text-xs text-zinc-500">
              VAPID の鍵が設定されていません。<code>npm run vapid</code> で作って
              <code className="mx-1">.env.local</code>に入れてください。
            </p>
          )}
        </section>

        {/* ---------------- 手当てが要るフィード（何も無ければ出ない） ---------------- */}
        <FeedHealth feeds={feeds} />

        {/* ---------------- フィード追加 ---------------- */}
        <section>
          <h2 className="mb-2 section-title">フィードを追加</h2>
          <AddFeed folders={(folders ?? []) as FolderRow[]} />
        </section>

        {/* ---------------- OPML ---------------- */}
        <section>
          <div className="mb-2 flex items-center justify-between gap-3">
            <h2 className="section-title">OPML を取り込む</h2>
            <a
              href="/api/opml"
              download
              className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:text-zinc-100"
            >
              書き出す
            </a>
          </div>
          <p className="mb-2 text-xs text-zinc-500">
            Inoreader / Feedly からエクスポートした OPML をそのまま読み込めます。
            記事は次の巡回で入ります。「書き出す」で今の購読一覧を OPML として保存できます
            （バックアップ用。フォルダの構成も一緒に出ます）。
          </p>
          <ActionForm action={importOpml} className="flex flex-col gap-2 sm:flex-row" success="取り込みました。記事は次の巡回で入ります。">
            <input
              type="file"
              name="opml"
              accept=".opml,.xml,text/xml,application/xml"
              required
              className="flex-1 text-sm text-zinc-400 file:mr-3 file:rounded file:border-0 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-sm file:text-zinc-100"
            />
            <button type="submit" className="rounded bg-zinc-100 px-3 py-2 text-sm text-zinc-900">
              取り込む
            </button>
          </ActionForm>
        </section>

        {/* ---------------- フォルダ ---------------- */}
        <section>
          <h2 className="mb-2 section-title">フォルダ（{(folders ?? []).length}）</h2>
          <p className="mb-2 text-xs text-zinc-500">
            並び順はサイドバーにそのまま反映されます。名前を書き換えて Enter で保存。
            フォルダを削除しても中のフィードは残り、未分類に移ります。
          </p>

          <ul className="mb-2 divide-y divide-zinc-900 rounded border border-zinc-800">
            {(folders ?? []).map((f: FolderRow, i: number) => (
              <li key={f.id} className="flex items-center gap-2 px-3 py-2">
                <ActionForm action={renameFolder.bind(null, f.id)} className="min-w-0 flex-1">
                  <input
                    type="text"
                    name="name"
                    defaultValue={f.name}
                    aria-label="フォルダ名"
                    className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-sm hover:border-zinc-800 focus:border-zinc-700 focus:bg-zinc-900 focus:outline-none"
                  />
                </ActionForm>
                <ActionForm action={moveFolder.bind(null, f.id, 'up')}>
                  <button
                    type="submit"
                    disabled={i === 0}
                    aria-label="上へ"
                    className="px-1 text-xs text-zinc-500 hover:text-zinc-200 disabled:opacity-25"
                  >
                    ↑
                  </button>
                </ActionForm>
                <ActionForm action={moveFolder.bind(null, f.id, 'down')}>
                  <button
                    type="submit"
                    disabled={i === (folders ?? []).length - 1}
                    aria-label="下へ"
                    className="px-1 text-xs text-zinc-500 hover:text-zinc-200 disabled:opacity-25"
                  >
                    ↓
                  </button>
                </ActionForm>
                <DeleteFolderButton
                  id={f.id}
                  name={f.name}
                  feedCount={(feeds ?? []).filter((feed: FeedRow) => feed.folder_id === f.id).length}
                />
              </li>
            ))}
            {(folders ?? []).length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-zinc-500">
                まだフォルダがありません
              </li>
            )}
          </ul>

          <ActionForm action={createFolder} className="flex gap-2">
            <input
              type="text"
              name="name"
              required
              placeholder="新しいフォルダ名"
              className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
            />
            <button type="submit" className="rounded bg-zinc-100 px-3 py-2 text-sm text-zinc-900">
              追加
            </button>
          </ActionForm>
        </section>

        {/* ---------------- 登録済みフィード ---------------- */}
        <section>
          <h2 className="mb-2 section-title">
            登録済みフィード（{(feeds ?? []).length}）
          </h2>
          <ul className="divide-y divide-zinc-900 rounded border border-zinc-800">
            {(feeds ?? []).map((feed: FeedRow) => (
              <li key={feed.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{feed.title || feed.url}</p>
                  <p className="truncate text-xs text-zinc-600">{feed.url}</p>
                  {feed.error_count > 0 && (
                    <p className="truncate text-xs text-amber-500">
                      取得失敗 {feed.error_count}回: {feed.last_error}
                    </p>
                  )}
                </div>
                <FolderSelect
                  feedId={feed.id}
                  folders={(folders ?? []) as FolderRow[]}
                  current={feed.folder_id}
                />
                <UnsubscribeButton
                  feedId={feed.id}
                  title={feed.title || feed.url}
                  folderId={feed.folder_id}
                />
              </li>
            ))}
            {(feeds ?? []).length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-zinc-500">
                まだフィードがありません
              </li>
            )}
          </ul>
        </section>

        {/*
          **ここは本体のいちばん下。** 診断（Diagnostics）の中に入れると
          ページの真ん中に出る——あちらは <Suspense> で先に流している節で、
          画面の並びとしては上のほうにある。「いちばん下を見てください」と
          伝えて実際は真ん中だった、を一度やっている。
        */}
        <section>
          <h2 className="mb-2 section-title">起動の内訳（この端末で測ったもの）</h2>
          <BootTimings />
        </section>

        </div>
      </main>
    </AppShell>
  );
}

/** 取り込みの進み具合と AI の使用量。**設定の本体より後に流す**（上の注記）。 */
async function Diagnostics() {
  const [pipeline, usage] = await Promise.all([pipelineStatus(), recentUsage()]);

  return (
    <>
      <section>
        <h2 className="mb-2 section-title">取り込みの進み具合</h2>
        <p className="mb-2 text-xs text-zinc-500">
          記事は「本文を取りに行く → 要約する」の順に処理されます。フィードを増やした
          直後はここに溜まりますが、5分ごとに少しずつ減っていきます。
        </p>
        <ul className="space-y-1 text-xs">
          <li className="text-zinc-400">
            本文の順番待ち: <span className="text-zinc-200">{pipeline.pendingExtract}件</span>
            <span className="ml-1 text-zinc-600">（待てば減ります）</span>
          </li>
          <li className="text-zinc-400">
            要約の順番待ち: <span className="text-zinc-200">{pipeline.pendingSummary}件</span>
          </li>
          <li className={pipeline.failedExtract > 0 ? 'text-amber-500' : 'text-zinc-400'}>
            本文を取れなかった記事: {pipeline.failedExtract}件
            <span className="ml-1 text-zinc-600">
              （ペイウォールやアクセス制限。RSSの抜粋から要約します）
            </span>
          </li>
        </ul>
      </section>

      <section>
        <h2 className="mb-2 section-title">AI の使用量（直近7日）</h2>
        <UsageTable usage={usage} />
      </section>
    </>
  );
}

/** 上の2節ぶんの場所取り。見出しは出す——出さないと節そのものが消えたように見える。 */
function DiagnosticsSkeleton() {
  return (
    <>
      <section aria-busy="true">
        <h2 className="mb-2 section-title">取り込みの進み具合</h2>
        <Bar className="h-3 w-2/3" />
        <Bar className="mt-2 h-3 w-1/2" />
        <Bar className="mt-2 h-3 w-3/5" />
      </section>
      <section aria-busy="true">
        <h2 className="mb-2 section-title">AI の使用量（直近7日）</h2>
        <Bar className="h-16 w-full" />
      </section>
    </>
  );
}
