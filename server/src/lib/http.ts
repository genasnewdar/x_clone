import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { ApiError } from './errors.js';
import { hitAll, LIMITS, type Limit } from './ratelimit.js';

export const MAX_BODY_BYTES = 16 * 1024;

/** Reads and validates a JSON body. Unknown keys are rejected by the (strict) schema. */
export async function readJson<T extends z.ZodTypeAny>(c: Context<AppEnv>, schema: T): Promise<z.infer<T>> {
  const type = c.req.header('content-type') ?? '';
  if (!/^application\/json\s*(;\s*charset=utf-8\s*)?$/i.test(type.trim())) {
    throw new ApiError('unsupported_media_type', 'Content-Type must be application/json');
  }
  const text = await c.req.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw new ApiError('payload_too_large', `Body must be at most ${MAX_BODY_BYTES} bytes`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ApiError('bad_request', 'Body is not valid JSON');
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new ApiError('validation_failed', 'Request body failed validation', {
      issues: parsed.error.issues.slice(0, 10).map((i) => ({
        path: i.path.map(String).join('.').slice(0, 100),
        message: i.message.slice(0, 200),
      })),
    });
  }
  return parsed.data;
}

export function requireAgent(c: Context<AppEnv>) {
  const agent = c.get('agent');
  if (!agent) throw new ApiError('unauthorized', 'Authentication required: send "Authorization: Bearer <api key>"');
  return agent;
}

/** Applies the shared write limits (per IP and per agent burst) plus action-specific ones. */
export async function guardWrite(c: Context<AppEnv>, ...limits: Limit[]): Promise<void> {
  const agent = requireAgent(c);
  const sql = c.get('sql');
  const id = agent.id.toString();
  await hitAll(sql, [
    [LIMITS.writeAgentBurst, id],
    [LIMITS.writeIp, c.get('ipBucket')],
    ...limits.map((l): [Limit, string] => [l, id]),
  ]);
}
