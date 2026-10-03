import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { readFile } from 'node:fs/promises';

const SERVICE = '_spotify-connect._tcp.local';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function dnsName(value) {
  return Buffer.concat([...value.split('.').map(label => Buffer.concat([Buffer.from([Buffer.byteLength(label)]), Buffer.from(label)])), Buffer.from([0])]);
}
export function readDnsName(packet, offset, depth = 0) {
  if (depth > 16) throw new Error('Invalid DNS name.');
  const parts = []; let next = offset;
  for (let count = 0; count < 128; count++) {
    if (next >= packet.length) throw new Error('Truncated DNS name.');
    const length = packet[next++];
    if (!length) return { name: parts.join('.'), next };
    if ((length & 0xc0) === 0xc0) {
      if (next >= packet.length) throw new Error('Truncated DNS pointer.');
      const pointer = ((length & 0x3f) << 8) | packet[next++];
      parts.push(readDnsName(packet, pointer, depth + 1).name);
      return { name: parts.join('.'), next };
    }
    if (length > 63 || next + length > packet.length) throw new Error('Invalid DNS label.');
    parts.push(packet.subarray(next, next + length).toString()); next += length;
  }
  throw new Error('Invalid DNS name.');
}
export function discoveryRecords(packet) {
  if (packet.length < 12 || packet.length > 65536) throw new Error('Invalid DNS packet.');
  let offset = 12;
  for (let i = 0; i < packet.readUInt16BE(4); i++) { offset = readDnsName(packet, offset).next + 4; }
  const count = packet.readUInt16BE(6) + packet.readUInt16BE(8) + packet.readUInt16BE(10);
  if (count > 128) throw new Error('Too many DNS records.');
  const records = [];
  for (let i = 0; i < count; i++) {
    const entry = readDnsName(packet, offset); offset = entry.next;
    if (offset + 10 > packet.length) throw new Error('Truncated DNS record.');
    const type = packet.readUInt16BE(offset), length = packet.readUInt16BE(offset + 8); offset += 10;
    if (offset + length > packet.length) throw new Error('Truncated DNS data.');
    if (type === 33 && length >= 7) records.push({ name: entry.name, port: packet.readUInt16BE(offset + 4), target: readDnsName(packet, offset + 6).name });
    if (type === 16) {
      const values = []; let cursor = offset;
      while (cursor < offset + length) { const n = packet[cursor++]; if (cursor + n > offset + length) throw new Error('Invalid DNS text.'); values.push(packet.subarray(cursor, cursor + n).toString()); cursor += n; }
      records.push({ name: entry.name, path: values.find(value => value.startsWith('CPath='))?.slice(6) });
    }
    offset += length;
  }
  return records;
}

export class SoloistDiscovery {
  constructor({ fetchInfo = async endpoint => {
    const response = await fetch(`${endpoint}?action=getInfo&version=2.10.0`, { redirect: 'manual', signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    const text = await response.text(); if (text.length > 65536) return null;
    return JSON.parse(text);
  } } = {}) { this.fetchInfo = fetchInfo; this.services = new Map(); }
  async start() {
    this.socket = createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('error', () => {});
    this.socket.on('message', packet => {
      try {
        for (const record of discoveryRecords(packet)) {
          if (!record.name.toLowerCase().endsWith(`.${SERVICE}`)) continue;
          this.services.set(record.name, { ...this.services.get(record.name), ...record });
        }
      } catch { /* Ignore unrelated or malformed local discovery packets. */ }
    });
    await new Promise(resolve => { this.socket.once('error', resolve); this.socket.bind(0, '0.0.0.0', resolve); });
    const header = Buffer.alloc(12); header.writeUInt16BE(1, 4);
    this.query = Buffer.concat([header, dnsName(SERVICE), Buffer.from([0, 12, 0x80, 1])]);
  }
  queryLocal() {
    if (!this.socket) return;
    try { this.socket.setMulticastLoopback(true); this.socket.send(this.query, 5353, '224.0.0.251', () => {}); } catch { /* A TCP fallback is attempted below. */ }
  }
  async resolve(name) {
    this.queryLocal();
    const endpoints = new Set();
    const addresses = ['127.0.0.1', ...Object.values(networkInterfaces()).flat().filter(x => x?.family === 'IPv4').map(x => x.address)];
    for (const service of this.services.values()) {
      if (!service.port || !service.path?.startsWith('/') || service.path.startsWith('//') || /[?#\r\n]/.test(service.path)) continue;
      for (const address of addresses) endpoints.add(`http://${address}:${service.port}${service.path}`);
    }
    // Read only this isolated Container's listeners. An endpoint is accepted
    // only when getInfo identifies this exact Soloist device name.
    try {
      for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
        const text = await readFile(table, 'utf8');
        for (const line of text.split('\n').slice(1)) {
          const parts = line.trim().split(/\s+/); if (parts[3] !== '0A') continue;
          const port = parseInt(parts[1]?.split(':')[1], 16); if (!port || port === 8080) continue;
          for (const path of ['/', '/zeroconf']) endpoints.add(`http://127.0.0.1:${port}${path}`);
        }
      }
    } catch { /* mDNS remains the primary endpoint discovery method. */ }
    const list = [...endpoints].slice(0, 32);
    for (let i = 0; i < list.length; i += 8) {
      const found = await Promise.all(list.slice(i, i + 8).map(async endpoint => {
        try { const info = await this.fetchInfo(endpoint); return info?.status === 101 && info.remoteName === name && typeof info.deviceID === 'string' && typeof info.publicKey === 'string' ? endpoint : null; } catch { return null; }
      }));
      if (found.some(Boolean)) return found.find(Boolean);
    }
    return null;
  }
  close() { try { this.socket?.close(); } catch { /* Already closed. */ } this.socket = null; }
}
export { wait };
