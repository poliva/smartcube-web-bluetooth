export function hexToDataView(hex: string): DataView {
  if (hex.length % 2 !== 0) {
    throw new Error(`Invalid hex length: ${hex.length}`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  // fresh buffer per call to avoid subtle reuse issues
  return new DataView(bytes.buffer);
}

export function dataViewToHex(dv: DataView): string {
  const a = new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
  return Array.from(a)
    .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
    .join('');
}

