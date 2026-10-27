import type { z } from 'zod';
import { badRequest } from './errors.js';

/**
 * Validates a request body and throws a 400 with a readable message on failure.
 * `details.field` names the offending input so forms can show the message next to it.
 */
export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const first = result.error.issues[0];
    const field = first?.path.length ? first.path.join('.') : undefined;
    // Our own messages are written for people; zod's generic ones ("Invalid input…") need the field for context.
    const raw = first?.message ?? 'Invalid request.';
    const message = field && raw.startsWith('Invalid input') ? `${field}: ${raw}` : raw;
    throw badRequest(message, { field, issues: result.error.issues });
  }
  return result.data;
}
