/**
 * D1 BLOB round-tripping.
 *
 * D1 hands a BLOB column back as an ArrayBuffer on some runtimes and as a
 * plain byte array on others, and `new Response(number[])` silently serialises
 * to nothing rather than failing. Normalising once, here, is what keeps that
 * from becoming a zero-byte download.
 */
export function toBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value) as Uint8Array<ArrayBuffer>;
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    const copy = new Uint8Array(new ArrayBuffer(view.byteLength));
    copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    return copy as Uint8Array<ArrayBuffer>;
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(value as number[]) as Uint8Array<ArrayBuffer>;
  }
  if (typeof value === "string") {
    return new TextEncoder().encode(value) as Uint8Array<ArrayBuffer>;
  }
  return new Uint8Array(new ArrayBuffer(0)) as Uint8Array<ArrayBuffer>;
}

export function toArrayBuffer(value: unknown): ArrayBuffer {
  return toBytes(value).buffer;
}
