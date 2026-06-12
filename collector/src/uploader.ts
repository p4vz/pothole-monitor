// Drains the SQLite buffer: gzip each pending batch and POST it. The server is
// idempotent on batch_id, so retries are safe. Deletes locally only on ack.
import pako from "pako";

import { CONFIG } from "./config";
import { getDeviceToken } from "./api";
import { markAcked, pendingBatches } from "./buffer";

let draining = false;

async function uploadOne(payload: object, token: string): Promise<boolean> {
  const body = pako.gzip(JSON.stringify(payload));
  const res = await fetch(`${CONFIG.API_BASE}/v1/batches`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
      "X-Device-Token": token,
    },
    body,
  });
  return res.ok; // 202 ack (or 200 on idempotent duplicate)
}

// Upload all pending batches; offline-safe — failures stay queued for next call.
export async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    const token = await getDeviceToken();
    for (const batch of await pendingBatches()) {
      let delay = CONFIG.UPLOAD_RETRY_BASE_MS;
      for (let attempt = 0; attempt <= CONFIG.UPLOAD_MAX_RETRIES; attempt++) {
        try {
          if (await uploadOne(batch, token)) {
            await markAcked((batch as any).batch_id);
            break;
          }
        } catch {
          // network error — fall through to backoff
        }
        if (attempt === CONFIG.UPLOAD_MAX_RETRIES) return; // give up; stay queued
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
      }
    }
  } finally {
    draining = false;
  }
}
