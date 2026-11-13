export interface WagerDelivery {
  body: string;
  sqsMessageId: string;
  receiptHandle: string;
  groupId: string;
  receiveCount: number;
}

export interface WagerQueue {
  verify?(): Promise<void>;

  receive(maximum: number, signal: AbortSignal): Promise<WagerDelivery[]>;

  acknowledge(message: WagerDelivery): Promise<void>;

  visibility(message: WagerDelivery, seconds: number): Promise<void>;

  deadLetter(
    message: WagerDelivery,
    failureCode: string,
    businessMessageId?: string,
  ): Promise<void>;
}
