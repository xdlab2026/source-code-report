export class CollectorError extends Error {
  readonly kind: "auth" | "rate_limit" | "api";
  readonly status: number;

  constructor(kind: "auth" | "rate_limit" | "api", message: string, status: number) {
    super(message);
    this.name = "CollectorError";
    this.kind = kind;
    this.status = status;
  }
}

export class DeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryError";
  }
}
