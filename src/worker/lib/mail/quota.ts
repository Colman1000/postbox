import type { Env } from "../../env.ts";

/**
 * Send counters.
 *
 * Kept in KV rather than D1 because they are pure counters with a natural
 * expiry, and because a quota check should never cost a database read on the
 * hot path of composing a message.
 */

const dayKey = () => `quota:day:${new Date().toISOString().slice(0, 10)}`;
const monthKey = () => `quota:month:${new Date().toISOString().slice(0, 7)}`;

export async function readQuota(
  env: Env,
): Promise<{ sentToday: number; sentThisMonth: number }> {
  const [day, month] = await Promise.all([
    env.CACHE.get(dayKey()),
    env.CACHE.get(monthKey()),
  ]);
  return { sentToday: Number(day ?? 0), sentThisMonth: Number(month ?? 0) };
}

export async function incrementQuota(env: Env): Promise<void> {
  const { sentToday, sentThisMonth } = await readQuota(env);
  await Promise.all([
    // TTLs let the keys expire on their own instead of accumulating forever.
    env.CACHE.put(dayKey(), String(sentToday + 1), { expirationTtl: 60 * 60 * 48 }),
    env.CACHE.put(monthKey(), String(sentThisMonth + 1), {
      expirationTtl: 60 * 60 * 24 * 40,
    }),
  ]);
}
