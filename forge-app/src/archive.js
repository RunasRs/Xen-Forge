import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const FILES_DIR = 'files';

export function saveFiles(dir, entries, mask) {
  for (const [name, content] of entries) {
    const dst = path.join(dir, FILES_DIR, name);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, mask(content), { mode: 0o600 });
  }
}

export function readTree(root, rel = '') {
  return fs.readdirSync(path.join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => {
      const name = path.posix.join(rel, e.name);
      if (e.isDirectory()) return readTree(root, name);
      return e.isFile() ? [[name, fs.readFileSync(path.join(root, name), 'utf8')]] : [];
    });
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};

export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const [name, content] of entries) {
    const data = Buffer.from(content);
    const packed = zlib.deflateRawSync(data);
    const fileName = Buffer.from(name);
    const common = Buffer.alloc(26);
    common.writeUInt16LE(20, 0);
    common.writeUInt16LE(0x0800, 2);
    common.writeUInt16LE(8, 4);
    common.writeUInt16LE(time, 6);
    common.writeUInt16LE(date, 8);
    common.writeUInt32LE(crc32(data), 10);
    common.writeUInt32LE(packed.length, 14);
    common.writeUInt32LE(data.length, 18);
    common.writeUInt16LE(fileName.length, 22);
    common.writeUInt16LE(0, 24);
    const local = Buffer.concat([Buffer.from([0x50, 0x4B, 0x03, 0x04]), common, fileName, packed]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014B50, 0);
    central.writeUInt16LE(20, 4);
    common.copy(central, 6);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, fileName]));
    locals.push(local);
    offset += local.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, end]);
}
