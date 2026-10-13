// Wire protocol v1 — see docs/PROTOCOL.md.

export const PROTOCOL_VERSION = 1;
export const MSG_PKTS = 0x01;
export const PKTS_HEADER = 12;
export const PKTS_RECORD = 12;

/**
 * Decoded PKTS batch as a struct of arrays. Reused between frames to avoid
 * allocations on the hot path; consumers must copy what they keep.
 */
export class PacketBatch {
  constructor(capacity = 4096) {
    this.alloc(capacity);
    this.count = 0;
    this.base = 0;
  }

  alloc(capacity) {
    this.capacity = capacity;
    this.flow = new Uint32Array(capacity);
    this.bytes = new Uint32Array(capacity);
    this.dt = new Uint16Array(capacity);
    this.pkts = new Uint8Array(capacity);
    this.flags = new Uint8Array(capacity);
  }
}

/** Decodes a binary frame into `batch`. Returns false for unknown types. */
export function decodeBinary(buf, batch) {
  const view = new DataView(buf);
  if (view.byteLength < 1) return false;
  const type = view.getUint8(0);
  if (type !== MSG_PKTS) return false;
  if (view.byteLength < PKTS_HEADER) throw new Error('PKTS: short header');
  const version = view.getUint8(1);
  if (version !== 1) return false;
  const count = view.getUint16(2, true);
  if (view.byteLength < PKTS_HEADER + count * PKTS_RECORD) throw new Error('PKTS: truncated');
  if (count > batch.capacity) batch.alloc(Math.max(count, batch.capacity * 2));
  batch.count = count;
  batch.base = view.getFloat64(4, true);
  let o = PKTS_HEADER;
  for (let i = 0; i < count; i++, o += PKTS_RECORD) {
    batch.flow[i] = view.getUint32(o, true);
    batch.bytes[i] = view.getUint32(o + 4, true);
    batch.dt[i] = view.getUint16(o + 8, true);
    batch.pkts[i] = view.getUint8(o + 10);
    batch.flags[i] = view.getUint8(o + 11);
  }
  return true;
}

/**
 * Encodes records into a PKTS frame. Used by the demo simulator so that the
 * exact binary path the engine uses is exercised in the browser too.
 * records: Array<[flow, bytes, dt, pkts, flags]>.
 */
export function encodePkts(base, records) {
  const buf = new ArrayBuffer(PKTS_HEADER + records.length * PKTS_RECORD);
  const v = new DataView(buf);
  v.setUint8(0, MSG_PKTS);
  v.setUint8(1, 1);
  v.setUint16(2, records.length, true);
  v.setFloat64(4, base, true);
  let o = PKTS_HEADER;
  for (const [flow, bytes, dt, pkts, flags] of records) {
    v.setUint32(o, flow >>> 0, true);
    v.setUint32(o + 4, Math.min(0xffffffff, Math.max(0, Math.round(bytes))), true);
    v.setUint16(o + 8, Math.min(0xffff, Math.max(0, Math.round(dt))), true);
    v.setUint8(o + 10, Math.min(255, Math.max(1, Math.round(pkts))));
    v.setUint8(o + 11, flags & 0xff);
    o += PKTS_RECORD;
  }
  return buf;
}
