/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createTRPCClient, httpBatchLink, TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { supabase } from "./supabase";
import { showUpgradeDialog } from "@/components/upgrade-dialog";

import type { AppRouter } from "@diffusionstudio/api-contract";

/**
 * The procedures that reach a model. What each was called with is the first
 * thing wanted when a generation comes back wrong, so every call writes one
 * line before it goes out and one when it lands — in the app console, which
 * the desktop app mirrors into its log buffer (`dapi logs`).
 */
const MODEL_PROCEDURES = new Set([
  "generateImage",
  "generateVideo",
  "generateSound",
  "textToSpeech",
  "removeBackground",
  "upscaleImage",
  "upscaleVideo",
  "addAudioToVideo",
  "transcribe",
  "analyze",
]);

/** How much of a single argument a log line carries: a prompt is worth reading whole, a data url is not. */
const ARGUMENT_MAX = 500;
/** How much of the whole argument object a log line carries, before the log buffer cuts it anyway. */
const ARGUMENTS_MAX = 2000;

/**
 * The arguments of a call, as one line. Strings are cut at `ARGUMENT_MAX`,
 * and a url keeps its path alone — the query carries the upload signature,
 * which is long and not worth writing down.
 */
function describeArguments(input: unknown): string {
  const json = JSON.stringify(input, (_key, value) => {
    if (typeof value !== "string") return value;
    const text = /^https?:\/\//.test(value) ? value.split("?")[0]! : value;
    return text.length > ARGUMENT_MAX ? `${text.slice(0, ARGUMENT_MAX)}…` : text;
  });
  if (json === undefined) return "(no arguments)";
  return json.length > ARGUMENTS_MAX ? `${json.slice(0, ARGUMENTS_MAX)}…` : json;
}

/** Logs what every model call was asked for, and how long it took to answer. */
const modelCallLink: TRPCLink<AppRouter> = () => ({ next, op }) =>
  observable((observer) => {
    const logged = MODEL_PROCEDURES.has(op.path);
    const startedAt = performance.now();
    const elapsed = () => `${Math.round(performance.now() - startedAt)}ms`;

    if (logged) console.log(`[model] ${op.path} ${describeArguments(op.input)}`);

    const sub = next(op).subscribe({
      next: (value) => observer.next(value),
      error: (err) => {
        if (logged) console.error(`[model] ${op.path} failed after ${elapsed()}: ${err.message}`);
        observer.error(err);
      },
      complete: () => {
        if (logged) console.log(`[model] ${op.path} done in ${elapsed()}`);
        observer.complete();
      },
    });
    return () => sub.unsubscribe();
  });

const paymentRequiredLink: TRPCLink<AppRouter> = () => ({ next, op }) =>
  observable((observer) => {
    const sub = next(op).subscribe({
      next: (value) => observer.next(value),
      error: (err) => {
        if (err instanceof TRPCClientError && err.data?.code === "PAYMENT_REQUIRED") {
          showUpgradeDialog();
        }
        observer.error(err);
      },
      complete: () => observer.complete(),
    });
    return () => sub.unsubscribe();
  });

export const trpc = createTRPCClient<AppRouter>({
  links: [
    modelCallLink,
    paymentRequiredLink,
    httpBatchLink({
      url: `${import.meta.env.VITE_API_URL ?? ""}/api/trpc`,
      async headers() {
        const session = await supabase?.auth.getSession();
        const token = session?.data.session?.access_token;
        return token ? { Authorization: `Bearer ${token}` } : {};
      },
    }),
  ],
});
