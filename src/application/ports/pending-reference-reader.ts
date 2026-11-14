export interface PendingReferenceCandidate {
  transactionId: string;
  referenceAttempts: number;
  walletId?: string;
  providerId?: string;
}

export interface PendingReferenceReader {
  findDue(
    now: Date,
    expiredBefore: Date,
    limit: number,
  ): Promise<PendingReferenceCandidate[]>;
}
