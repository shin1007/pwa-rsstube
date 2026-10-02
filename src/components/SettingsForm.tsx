'use client';

import { useActionState } from 'react';

/**
 * 設定の保存フォーム。
 *
 * 中身（入力欄）はサーバー側で組んだものをそのまま受け取る。ここが持つのは
 * **押した結果を出すこと**だけ。
 *
 * 押しても何も起きないように見えていた。保存自体は成功していて、
 * 値も DB に入っているのだが、再描画しても選んだ値が選ばれたままなので
 * 画面が1ドットも変わらない。成功したのか、押せていないのか、
 * 失敗したのかが区別できなかった。
 *
 * 失敗も throw ではなく戻り値で受ける。本番では Server Action の例外が
 * digest に置き換わり、届くのは「Minified React error #441」だけになる
 * （app/actions/media.ts の注記と同じ話）。
 */

export type SaveState = { ok: true; at: string; note?: string } | { ok: false; message: string } | null;

export function SettingsForm({
  action,
  children,
}: {
  action: (prev: SaveState, formData: FormData) => Promise<SaveState>;
  children: React.ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, null);

  return (
    <form action={formAction} className="space-y-3">
      {children}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-zinc-100 px-3 py-1.5 text-sm text-zinc-900 disabled:opacity-50"
        >
          {pending ? '保存中…' : '保存'}
        </button>

        {/* 時刻も出す。二度目以降は文言だけだと変化が見えない。 */}
        {state?.ok && (
          <span className="text-xs text-emerald-400">保存しました（{state.at}）{state.note}</span>
        )}
        {state && !state.ok && <span className="text-xs text-red-400">{state.message}</span>}
      </div>
    </form>
  );
}
