import type { AssetFormat } from './types';

// Sniff the real container format from file bytes. Figma's
// `Image.getBytesAsync()` returns the *original* upload (PNG, JPEG, GIF, or
// WebP), so the extension must follow the bytes, not an assumption.
export type RasterFormat = Extract<AssetFormat, 'png' | 'jpg' | 'webp' | 'gif'>;

export function detectImageFormat(bytes: Uint8Array): RasterFormat | null {
  if (bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpg';
  }
  // "GIF87a" / "GIF89a"
  if (bytes.length >= 6 &&
      bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
      (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return 'gif';
  }
  // "RIFF" <size> "WEBP"
  if (bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'webp';
  }
  return null;
}

// Sniff an SVG payload (text starting with <svg or an <?xml prolog).
export function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 256))).trimStart();
  return head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'));
}

// Final on-disk extension for a given format.
export function extensionFor(format: AssetFormat): string {
  return format === 'jpg' ? 'jpg' : format;
}
