export function createStoredZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const filename = Buffer.from(name.replace(/[^A-Za-z0-9._-]/g, "_"));
    const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    const checksum = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(checksum),
      u32(data.length), u32(data.length), u16(filename.length), u16(0), filename, data
    ]);
    localParts.push(local);
    centralParts.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(checksum),
      u32(data.length), u32(data.length), u16(filename.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), filename
    ]));
    offset += local.length;
  }
  const central = Buffer.concat(centralParts);
  return Buffer.concat([
    ...localParts, central, u32(0x06054b50), u16(0), u16(0), u16(centralParts.length),
    u16(centralParts.length), u32(central.length), u32(offset), u16(0)
  ]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function u16(value) { const result = Buffer.alloc(2); result.writeUInt16LE(value); return result; }
function u32(value) { const result = Buffer.alloc(4); result.writeUInt32LE(value >>> 0); return result; }
