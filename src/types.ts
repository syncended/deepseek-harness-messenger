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
  readonly senderName?: string;
  /** Text supplied to existing command/message handlers. */
  readonly text: string;
}

export interface InboundTextMessage extends InboundMessengerBase {
  readonly kind: 'message';
}

export interface InboundCallbackInteraction extends InboundMessengerBase {
  readonly kind: 'callback_query';
  readonly callbackQueryId: string;
  readonly data: string;
}

export type InboundMessengerMessage =
  | InboundTextMessage
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
  answerCallback(
    callbackQueryId: string,
    text?: string,
    showAlert?: boolean,
  ): Promise<void>;
  sendTyping(chatId: string): Promise<void>;
}

export interface ParsedCommand {
  readonly name: string;
  readonly argument: string;
}
