import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

/**
 * Checks the ingest key: `Authorization: Bearer <key>` (Problem 8: least privilege).
 * This key can only send reports. The Flagsmith admin key never leaves the server.
 */
export function requireIngestKey(expectedKey: string): RequestHandler {
  const expected = digest(expectedKey);

  return (req, res, next) => {
    const header = req.get('authorization') ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    if (match?.[1] === undefined) {
      res.status(401).json({ error: 'missing_ingest_key' });
      return;
    }
    // Compare in constant time, so response timing doesn't leak how much of the key was right.
    if (!timingSafeEqual(digest(match[1]), expected)) {
      res.status(401).json({ error: 'invalid_ingest_key' });
      return;
    }
    next();
  };
}

// Hashing first gives both sides the same length, which timingSafeEqual requires.
function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
