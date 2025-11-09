export class ToolCallBudget {
  public usedCalls = 0;

  constructor(public maxCalls: number | null) {
    if (maxCalls !== null && maxCalls < 0) {
      throw new Error('maxCalls cannot be negative');
    }
  }

  get remaining(): number | null {
    if (this.maxCalls === null) return null;
    return Math.max(this.maxCalls - this.usedCalls, 0);
  }

  get exhausted(): boolean {
    if (this.maxCalls === null) return false;
    return this.usedCalls >= this.maxCalls;
  }

  consume(amount = 1): boolean {
    if (amount <= 0) {
      throw new Error('amount must be positive');
    }
    
    if (this.maxCalls === null) {
      this.usedCalls += amount;
      return true;
    }
    
    if (this.usedCalls + amount > this.maxCalls) {
      return false;
    }
    
    this.usedCalls += amount;
    return true;
  }
}
