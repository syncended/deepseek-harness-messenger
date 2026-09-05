export type MessengerChatKind =
  | 'private'
  | 'group'
  | 'supergroup'
  | 'channel';

interface InboundMessengerBase {
  readonly transport: string;
  readonly messageId: string;
  readonly chatId: string;
  readonly chatKind?: MessengerChatKind;
  readonly senderId: string;
  /** Additional stable platform identifiers accepted by operator allowlists. */
  readonly senderAliases?: readonly string[];
  readonly senderName?: string;
  /** Text supplied to existing command/message handlers. */
  readonly text: string;
}

export interface InboundTextMessage extends InboundMessengerBase {
  readonly kind: 'message';
}

export interface InboundImageMessage extends InboundMessengerBase {
  readonly kind: 'image';
  /** Caption is carried in text and is never interpreted as a command. */
  readonly image: {
    readonly fileId: string;
    readonly sizeBytes?: number;
    readonly mimeType?: string;
  };
}

/** Bytes only: adapters never fetch model-supplied URLs or local paths. */
export interface MessengerImage {
  readonly bytes: Uint8Array;
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
}

export interface InboundVoiceMessage extends InboundMessengerBase {
  readonly kind: 'voice';
  readonly voice: {
    readonly fileId: string;
    readonly durationSeconds: number;
    readonly sizeBytes?: number;
    readonly mimeType?: string;
  };
}

export interface InboundCallbackInteraction extends InboundMessengerBase {
  readonly kind: 'callback_query';
  readonly callbackQueryId: string;
  readonly data: string;
}

export type InboundMessengerMessage =
  | InboundTextMessage
  | InboundImageMessage
  | InboundVoiceMessage
  | InboundCallbackInteraction;

export interface MessengerMessageHandle {
  readonly chatId: string;
  readonly messageId: string;
}

export interface MessengerInlineKeyboardCallbackButton {
  readonly text: string;
  readonly callbackData: string;
  readonly url?: never;
}

export interface MessengerInlineKeyboardUrlButton {
  readonly text: string;
  readonly url: string;
  readonly callbackData?: never;
}

export type MessengerInlineKeyboardButton =
  | MessengerInlineKeyboardCallbackButton
  | MessengerInlineKeyboardUrlButton;

export type MessengerInlineKeyboard = readonly (
  readonly MessengerInlineKeyboardButton[]
)[];

export interface SendTextOptions {
  readonly keyboard?: MessengerInlineKeyboard;
}

export interface MessengerAdapter {
  readonly id: string;
  /** Maximum transport-measured characters accepted by an edited text message. */
  readonly textLimit?: number;
  /** Measure text exactly as editText will account for it. */
  textLength?(text: string): number;
  /** Convert common Markdown into the transport's supported rich-text dialect. */
  renderText?(text: string): string;
  /** Split text according to transport-specific message limits. */
  splitText?(text: string): string[];
  start(
    onMessage: (message: InboundMessengerMessage) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void>;
  sendText(
    chatId: string,
    text: string,
    options?: SendTextOptions,
  ): Promise<MessengerMessageHandle>;
  editText(
    chatId: string,
    messageId: string,
    text: string,
    keyboard?: MessengerInlineKeyboard,
  ): Promise<void>;
  /** Replace one message and spill overflow into follow-up messages. */
  replaceText?(
    chatId: string,
    messageId: string,
    text: string,
    keyboard?: MessengerInlineKeyboard,
  ): Promise<void>;
  answerCallback(
    callbackQueryId: string,
    text?: string,
    showAlert?: boolean,
  ): Promise<void>;
  sendTyping(chatId: string): Promise<void>;
  /** Download image bytes only after the bridge authorizes the sender and chat. */
  downloadImage?(message: InboundImageMessage, signal: AbortSignal): Promise<Uint8Array>;
  /** Upload image bytes; text is sent separately to preserve full-length replies. */
  sendImage?(chatId: string, image: MessengerImage, signal?: AbortSignal): Promise<MessengerMessageHandle>;
  /** Download voice bytes only after the bridge authorizes the sender and chat. */
  downloadVoice?(message: InboundVoiceMessage, signal: AbortSignal): Promise<Uint8Array>;
}

export interface ParsedCommand {
  readonly name: string;
  readonly argument: string;
}
