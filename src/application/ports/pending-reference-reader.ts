export interface PendingReferenceCandidate {
  transactionId: string;
  referenceAttempts: number;
}

export interface PendingReferenceReader {
  findDue(
    now: Date,
    expiredBefore: Date,
    limit: number,
  ): Promise<PendingReferenceCandidate[]>;
}
