// Local batch buffer backed by SQLite. Survives app kill; rows are deleted only
// after the server acks. Each batch is a JSON blob of columnar IMU + GPS arrays.
import * as SQLite from "expo-sqlite";

export type ImuSample = { t: number; ax: number; ay: number; az: number; gx: number; gy: number; gz: number };
export type GpsSample = { t: number; lat: number; lng: number; speed: number; heading: number; acc: number };

export type BatchPayload = {
  batch_id: string;
  meta: { session_id: string; sample_rate: number; app_version?: string };
  imu: { t: number[]; ax: number[]; ay: number[]; az: number[]; gx: number[]; gy: number[]; gz: number[] };
  gps: GpsSample[];
};

let db: SQLite.SQLiteDatabase | null = null;

export async function initBuffer() {
  db = await SQLite.openDatabaseAsync("roadsense.db");
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS batches (
      batch_id TEXT PRIMARY KEY,
      payload  TEXT NOT NULL,
      status   TEXT NOT NULL DEFAULT 'closed',  -- closed | uploading | acked
      created  INTEGER NOT NULL
    );`);
}

export async function saveBatch(payload: BatchPayload) {
  await db!.runAsync(
    "INSERT OR REPLACE INTO batches (batch_id, payload, status, created) VALUES (?, ?, 'closed', ?)",
    payload.batch_id,
    JSON.stringify(payload),
    Date.now()
  );
}

export async function pendingBatches(): Promise<BatchPayload[]> {
  const rows = await db!.getAllAsync<{ payload: string }>(
    "SELECT payload FROM batches WHERE status != 'acked' ORDER BY created ASC"
  );
  return rows.map((r) => JSON.parse(r.payload));
}

export async function markAcked(batchId: string) {
  // Delete on ack — the server is now the system of record for raw data.
  await db!.runAsync("DELETE FROM batches WHERE batch_id = ?", batchId);
}
