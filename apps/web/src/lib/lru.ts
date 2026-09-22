/**
 * A bounded map that forgets what was used longest ago. Work a component redoes on every mount
 * (highlighting a block, parsing an answer) is kept here, so a row that scrolls back into a windowed
 * list, or a streamed answer that turns into the stored one, shows at once instead of again.
 */
export class Lru<K, V> {
  private readonly held = new Map<K, V>();

  constructor(private readonly capacity: number) {}

  get(key: K): V | undefined {
    const value = this.held.get(key);
    if (value === undefined) return undefined;
    // A Map iterates in insertion order: moving a hit to the end makes the first key the stalest
    this.held.delete(key);
    this.held.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.held.delete(key);
    this.held.set(key, value);
    while (this.held.size > this.capacity) {
      const oldest = this.held.keys().next();
      if (oldest.done) break;
      this.held.delete(oldest.value);
    }
  }

  get size(): number {
    return this.held.size;
  }
}
