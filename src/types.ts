export interface InboundMessengerMessage {
  readonly transport: string;
  readonly messageId: string;
  readonly chatId: string;
  readonly chatKind?: 'private' | 'group' | 'supergroup' | 'channel';
  readonly senderId: string;
  readonly senderName?: string;
  readonly text: string;
}

export interface MessengerAdapter {
  readonly id: string;
  start(
    onMessage: (message: InboundMessengerMessage) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void>;
  sendText(chatId: string, text: string): Promise<void>;
}

export interface ParsedCommand {
  readonly name: string;
  readonly argument: string;
}
