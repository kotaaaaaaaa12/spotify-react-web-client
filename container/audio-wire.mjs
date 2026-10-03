// Length-prefixed metadata and PCM frames. No public URLs or credentials.
export function audioFrame(type, payload) {
  const result = new Uint8Array(5 + payload.byteLength);
  result[0] = type; new DataView(result.buffer).setUint32(1, payload.byteLength);
  result.set(payload, 5); return result;
}
export class AudioFrameReader {
  pending = new Uint8Array();
  push(chunk, receive) {
    if (chunk.byteLength + this.pending.byteLength > 1024 * 1024) throw new Error('Audio frame limit exceeded.');
    const data = new Uint8Array(this.pending.length + chunk.length);
    data.set(this.pending); data.set(chunk, this.pending.length);
    let offset = 0;
    while (data.length - offset >= 5) {
      const type = data[offset], size = new DataView(data.buffer, data.byteOffset + offset + 1, 4).getUint32(0);
      if (![0, 1].includes(type) || size > (type === 0 ? 16384 : 65536) || (type === 1 && (size < 8 || (size - 4) % 4))) throw new Error('Invalid audio frame.');
      if (data.length - offset < size + 5) break;
      receive(type, data.slice(offset + 5, offset + 5 + size)); offset += size + 5;
    }
    this.pending = data.slice(offset);
  }
}
