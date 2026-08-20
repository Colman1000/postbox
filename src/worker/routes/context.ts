import type { Env, Vars } from "../env.ts";

/** Shared Hono generic, so every router agrees on bindings and variables. */
export type App = { Bindings: Env; Variables: Vars };

export function jsonError(message: string, hint?: string) {
  return { error: message, ...(hint ? { hint } : {}) };
}
