'use client';

import { ActionForm } from '@/components/ActionForm';
import { UNEXPECTED_ERROR, type ActionResult } from '@/lib/actions/result';
import { useState, useTransition } from 'react';

/**
 * Gemini の API キー（0046）。
 *
 * 要約・音声の台本・読み上げは、それぞれのユーザーの鍵（＝その人の無料枠）で動く。
 * 鍵そのものは画面へ返さない。出すのは入っているかどうかと末尾4文字だけで、
 * 入れ替えるときは新しい鍵を上から入れる。
 */
export function GeminiKeyForm({
  usable,
  masked,
  fromEnv,
  save,
  remove,
}: {
  usable: boolean;
  masked?: string;
  fromEnv: boolean;
  save: (formData: FormData) => Promise<ActionResult<unknown>>;
  remove: () => Promise<ActionResult<unknown>>;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      {masked ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-emerald-400">設定済み（{masked}）</span>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              if (!confirm('API キーを消しますか？ 消すと要約と音声づくりが止まります。')) return;
              setError(null);
              startTransition(async () => {
                try {
                  const r = await remove();
                  if (!r.ok) setError(r.message);
                } catch {
                  setError(UNEXPECTED_ERROR);
                }
              });
            }}
            className="rounded px-2 py-1 text-xs text-zinc-500 hover:text-zinc-200 disabled:opacity-50"
          >
            {pending ? '削除中…' : '削除'}
          </button>
        </div>
      ) : fromEnv ? (
        <p className="text-xs text-zinc-400">
          サーバーの環境変数の鍵で動いています。ここに入れると、こちらが優先されます。
        </p>
      ) : (
        <p className="text-xs text-amber-500">
          まだ入っていません。入れるまで、記事の要約と音声づくりは動きません
          （記事は要約なしで一覧に出ます）。
        </p>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}

      <ActionForm action={save} className="flex flex-col gap-2 sm:flex-row" success="保存しました。">
        <input
          type="password"
          name="gemini_api_key"
          required
          autoComplete="off"
          spellCheck={false}
          placeholder={usable ? '新しい鍵に入れ替える' : 'AIza…'}
          aria-label="Gemini の API キー"
          className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
        />
        <button type="submit" className="rounded bg-zinc-100 px-3 py-2 text-sm text-zinc-900">
          確かめて保存
        </button>
      </ActionForm>

      <p className="text-xs text-zinc-500">
        鍵は{' '}
        <a
          href="https://aistudio.google.com/apikey"
          target="_blank"
          rel="noreferrer"
          className="text-zinc-300 underline"
        >
          Google AI Studio
        </a>{' '}
        で無料で発行できます。使った回数はあなたの鍵の無料枠から引かれ、下の「AI の使用量」に出ます。
        保存する前に、その鍵で Gemini を呼べるか1回だけ確かめます（生成はしないので枠は減りません）。
        <br />
        記事の要約は購読者全員で共通なので、同じフィードを購読している誰かが先に作っていれば、
        あなたの枠は使いません。
      </p>
    </div>
  );
}
