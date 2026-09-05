import { describe, expect, it } from 'vitest';
import { decodeImage, IMAGE_BYTE_LIMIT, messengerImage } from '../src/images.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

describe('image byte helpers', () => {
  it.each([
    [png, 'image/png'],
    [Buffer.from([255, 216, 255, 224]), 'image/jpeg'],
    [Buffer.from('GIF89a'), 'image/gif'],
    [Buffer.from('GIF87a'), 'image/gif'],
    [Buffer.from('RIFFxxxxWEBP'), 'image/webp'],
  ])('detects supported signatures rather than trusting file names', (bytes, mimeType) => {
    expect(messengerImage(bytes as Buffer)).toEqual({ bytes, mimeType });
  });

  it('rejects empty, unsupported, oversized and malformed encoded content', () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from('<svg/>'), Buffer.from('RIFFxxxxWAVE'), new Uint8Array(IMAGE_BYTE_LIMIT + 1)]) {
      expect(() => messengerImage(bytes)).toThrow();
    }
    for (const data of ['', 'a', 'AAAA===', 'a===', 'iVBORw0KGgo=\n', 'iVBORw0KGgp=', 'data:image/png;base64,aGVsbG8=']) {
      expect(() => decodeImage(data)).toThrow();
    }
    expect(decodeImage(png.toString('base64'))).toEqual({ bytes: png, mimeType: 'image/png' });
  });

  it('handles the maximum base64 size without recursive regex stack overflow', () => {
    const bytes = Buffer.alloc(IMAGE_BYTE_LIMIT);
    png.copy(bytes);
    const image = decodeImage(bytes.toString('base64'));
    expect(image.bytes.byteLength).toBe(IMAGE_BYTE_LIMIT);
    expect(image.mimeType).toBe('image/png');
    expect(() => decodeImage(Buffer.alloc(IMAGE_BYTE_LIMIT + 1).toString('base64'))).toThrow();
  });
});
