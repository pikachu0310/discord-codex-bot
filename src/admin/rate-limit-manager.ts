import { MESSAGES } from "../constants.ts";

export class RateLimitManager {
  createRateLimitMessage(): string {
    return MESSAGES.RATE_LIMIT;
  }
}
