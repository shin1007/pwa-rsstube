import { PasswordField } from '@/components/PasswordField';
import { sessionState } from '@/lib/auth/guard';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';

/**
 * 新規登録（2026-10-02 から誰でも登録できる）。
 *
 * **Secret キーの admin API で作る。** Supabase の「Allow new users to sign up」は
 * オフのままにしてあり、公開鍵の `auth.signUp` はそこで弾かれる。オンにすると
 * ブラウザに配られている公開鍵だけで、この画面を通らずにアカウントを作れてしまう。
 * 入口をここ1つに絞っておけば、制限を足したくなったときにここだけ直せばよい。
 *
 * **確認メールは送らない**（`email_confirm: true`）。Supabase 内蔵のメールは
 * 1時間に数通しか送れず、登録が重なると「メールが来ない」で止まる
 * （パスワード再設定で実際に踏んだ。login/page.tsx の sendReset）。
 * 代わりに、本人のものでないアドレスでも登録できてしまう。登録してもそのアドレスへ
 * 何も送られないので、他人を巻き込むことはない。
 *
 * AI は**その人の Gemini の鍵で**動く（0046）。登録が済んだら、鍵の欄が
 * いちばん上に出る設定画面へ送る。
 */

/** ログイン画面と同じ下限。 */
const MIN_PASSWORD = 8;

export default async function SignupPage({ searchParams }: PageProps<'/signup'>) {
  if ((await sessionState()) === 'live') redirect('/');

  const params = await searchParams;
  const error = typeof params.error === 'string' ? params.error : null;

  async function signUp(formData: FormData) {
    'use server';

    const fail = (message: string): never =>
      redirect('/signup?error=' + encodeURIComponent(message));

    // 人には見えない欄。自動で埋めて回るボットだけがここに書く。
    if (String(formData.get('website') ?? '')) fail('登録できませんでした');

    const email = String(formData.get('email') ?? '').trim().toLowerCase();
    const password = String(formData.get('password') ?? '');
    if (!email || !password) fail('メールアドレスとパスワードを入力してください');
    if (password.length < MIN_PASSWORD) fail(`パスワードは${MIN_PASSWORD}文字以上にしてください`);

    const admin = createAdminClient();
    const { error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createError) {
      // 伏せると「なぜ作れないか」が分からない。登録済みならログインへ案内する。
      if (/already|registered|exists/i.test(createError.message)) {
        fail('このメールアドレスは登録済みです。ログイン画面から入ってください');
      }
      fail(`登録できませんでした: ${createError.message}`);
    }

    const supabase = await createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) {
      redirect('/login?error=' + encodeURIComponent('登録しました。ログインしてください'));
    }

    redirect('/settings');
  }

  return (
    <main className="flex-1 overflow-y-auto flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold mb-1">RSSTube に登録</h1>
        <p className="text-sm text-zinc-400 mb-6">
          AI要約つきのRSSリーダー。要約と音声には、あなたの Gemini の API キー
          （無料で発行できます）を使います。登録のあとで設定画面から入れてください。
        </p>

        <form action={signUp} className="space-y-3">
          <input
            type="email"
            name="email"
            required
            autoComplete="username"
            placeholder="メールアドレス"
            className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-base"
          />
          <PasswordField
            name="password"
            required
            minLength={MIN_PASSWORD}
            autoComplete="new-password"
            placeholder={`パスワード（${MIN_PASSWORD}文字以上）`}
          />
          {/* ボット避け。画面にも読み上げにも出さない。 */}
          <input
            type="text"
            name="website"
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            className="hidden"
          />
          <button
            type="submit"
            className="w-full rounded bg-zinc-100 px-3 py-2 font-medium text-zinc-900"
          >
            登録する
          </button>
        </form>

        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

        <p className="mt-6 text-center text-sm text-zinc-400">
          登録済みの方は{' '}
          <Link href="/login" className="text-zinc-100 underline">
            ログイン
          </Link>
        </p>
      </div>
    </main>
  );
}
