import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { MessengerImage } from './types.js';

export const IMAGE_BYTE_LIMIT = 20 * 1024 * 1024;
export const MAX_REPLY_IMAGES = 10;
export type AssistantImage = Extract<ContentBlock, { type: 'image' }>;

/** Cheap signature gate; DSH performs full decoding/normalization on intake. */
export function messengerImage(bytes: Uint8Array): MessengerImage {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > IMAGE_BYTE_LIMIT) {
    throw new Error('Images must be nonempty and no larger than 20 MiB.');
  }
  const prefix = Buffer.from(bytes.subarray(0, 12));
  let mimeType: MessengerImage['mimeType'];
  if (prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mimeType = 'image/png';
  else if (prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255) mimeType = 'image/jpeg';
  else if (['GIF87a', 'GIF89a'].includes(prefix.subarray(0, 6).toString('ascii'))) mimeType = 'image/gif';
  else if (prefix.subarray(0, 4).toString('ascii') === 'RIFF' && prefix.subarray(8, 12).toString('ascii') === 'WEBP') mimeType = 'image/webp';
  else throw new Error('Unsupported image. Send a PNG, JPEG, WebP, or GIF.');
  return { bytes, mimeType };
}

export function decodeImage(data: string): MessengerImage {
  if (typeof data !== 'string' || data.length > 4 * Math.ceil(IMAGE_BYTE_LIMIT / 3)
    || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new Error('Invalid or oversized image data.');
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data) throw new Error('Invalid image data.');
  return messengerImage(bytes);
}

/** Mirror explicit assistant attachments only, never tool results or Markdown paths. */
export function visibleAssistantImages(event: SessionEvent): AssistantImage[] {
  if (event.type !== 'assistant/message' || event.surfaceOp !== 'append') return [];
  return event.data.message.content.filter((block): block is AssistantImage => block.type === 'image');
}
