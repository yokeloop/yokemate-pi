type ObjectState = "keyOrEnd" | "keyRequired" | "colon" | "value" | "commaOrEnd";
type ArrayState = "valueOrEnd" | "valueRequired" | "commaOrEnd";
type Frame = { kind: "object"; state: ObjectState; root: boolean; currentType: boolean } | { kind: "array"; state: ArrayState };
type Token = "none" | "string" | "number" | "literal";
type NumberState = "minus" | "zero" | "integer" | "fractionStart" | "fraction" | "exponentStart" | "exponentSign" | "exponent";

const JSON_WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);

export class JsonlAggregateValidator {
  private stack: Frame[] = [];
  private token: Token = "none";
  private stringRole: "key" | "value" = "value";
  private stringTarget: "type" | "agent_end" | undefined;
  private stringIndex = 0;
  private stringMatches = false;
  private escaped = false;
  private unicodeDigits = 0;
  private unicodeValue = 0;
  private utf8Remaining = 0;
  private utf8CodePoint = 0;
  private utf8Minimum = 0;
  private numberState: NumberState = "zero";
  private literal = "";
  private literalIndex = 0;
  private rootStarted = false;
  private rootComplete = false;
  private typeCount = 0;
  private typeValueMatches = false;
  private failed = false;

  get rejected(): boolean { return this.failed; }

  write(bytes: Buffer): void {
    if (this.failed) return;
    for (let index = 0; index < bytes.length && !this.failed; index++) this.consume(bytes[index]!);
  }

  finish(): boolean {
    if (this.failed) return false;
    if (this.utf8Remaining || this.token === "string" || this.token === "literal") return this.reject();
    if (this.token === "number") {
      if (!this.numberTerminal()) return this.reject();
      this.token = "none";
      this.completeValue();
    }
    if (!this.rootComplete || this.stack.length || this.typeCount !== 1 || !this.typeValueMatches) return this.reject();
    return true;
  }

  private reject(): false { this.failed = true; this.stack.length = 0; this.literal = ""; return false; }

  private consume(byte: number): void {
    if (this.token === "string") { this.consumeStringByte(byte); return; }
    if (this.token === "number") { if (this.consumeNumberByte(byte)) return; }
    if (this.token === "literal") { this.consumeLiteralByte(byte); return; }
    this.consumeSyntax(byte);
  }

  private consumeSyntax(byte: number): void {
    if (this.rootComplete) { if (!JSON_WHITESPACE.has(byte)) this.reject(); return; }
    const frame = this.stack.at(-1);
    if (!frame) {
      if (JSON_WHITESPACE.has(byte)) return;
      if (this.rootStarted || byte !== 0x7b) { this.reject(); return; }
      this.rootStarted = true;
      this.stack.push({ kind: "object", state: "keyOrEnd", root: true, currentType: false });
      return;
    }
    if (frame.kind === "object") {
      if (frame.state === "keyOrEnd" || frame.state === "keyRequired") {
        if (JSON_WHITESPACE.has(byte)) return;
        if (byte === 0x7d && frame.state === "keyOrEnd") { this.closeContainer("object"); return; }
        if (byte !== 0x22) { this.reject(); return; }
        this.startString("key", frame.root ? "type" : undefined);
        return;
      }
      if (frame.state === "colon") {
        if (JSON_WHITESPACE.has(byte)) return;
        if (byte !== 0x3a) { this.reject(); return; }
        frame.state = "value";
        return;
      }
      if (frame.state === "value") {
        if (JSON_WHITESPACE.has(byte)) return;
        if (frame.root && frame.currentType && byte !== 0x22) { this.reject(); return; }
        this.startValue(byte, frame.root && frame.currentType ? "agent_end" : undefined);
        return;
      }
      if (JSON_WHITESPACE.has(byte)) return;
      if (byte === 0x2c) { frame.state = "keyRequired"; frame.currentType = false; return; }
      if (byte === 0x7d) { this.closeContainer("object"); return; }
      this.reject();
      return;
    }
    if (frame.state === "valueOrEnd" || frame.state === "valueRequired") {
      if (JSON_WHITESPACE.has(byte)) return;
      if (byte === 0x5d && frame.state === "valueOrEnd") { this.closeContainer("array"); return; }
      this.startValue(byte);
      return;
    }
    if (JSON_WHITESPACE.has(byte)) return;
    if (byte === 0x2c) { frame.state = "valueRequired"; return; }
    if (byte === 0x5d) { this.closeContainer("array"); return; }
    this.reject();
  }

  private startValue(byte: number, target?: "agent_end"): void {
    if (byte === 0x22) { this.startString("value", target); return; }
    if (byte === 0x7b || byte === 0x5b) {
      if (this.stack.length >= 256) { this.reject(); return; }
      this.stack.push(byte === 0x7b ? { kind: "object", state: "keyOrEnd", root: false, currentType: false } : { kind: "array", state: "valueOrEnd" });
      return;
    }
    if (byte === 0x2d) { this.token = "number"; this.numberState = "minus"; return; }
    if (byte === 0x30) { this.token = "number"; this.numberState = "zero"; return; }
    if (byte >= 0x31 && byte <= 0x39) { this.token = "number"; this.numberState = "integer"; return; }
    if (byte === 0x74 || byte === 0x66 || byte === 0x6e) {
      this.token = "literal";
      this.literal = byte === 0x74 ? "true" : byte === 0x66 ? "false" : "null";
      this.literalIndex = 1;
      return;
    }
    this.reject();
  }

  private startString(role: "key" | "value", target?: "type" | "agent_end"): void {
    this.token = "string";
    this.stringRole = role;
    this.stringTarget = target;
    this.stringIndex = 0;
    this.stringMatches = target !== undefined;
    this.escaped = false;
    this.unicodeDigits = 0;
    this.unicodeValue = 0;
    this.utf8Remaining = 0;
  }

  private consumeStringByte(byte: number): void {
    if (this.utf8Remaining) {
      if ((byte & 0xc0) !== 0x80) { this.reject(); return; }
      this.utf8CodePoint = (this.utf8CodePoint << 6) | (byte & 0x3f);
      this.utf8Remaining--;
      if (!this.utf8Remaining) {
        const codePoint = this.utf8CodePoint;
        if (codePoint < this.utf8Minimum || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) { this.reject(); return; }
        this.matchStringCodePoint(codePoint);
      }
      return;
    }
    if (this.unicodeDigits) {
      const digit = byte >= 0x30 && byte <= 0x39 ? byte - 0x30 : byte >= 0x41 && byte <= 0x46 ? byte - 0x41 + 10 : byte >= 0x61 && byte <= 0x66 ? byte - 0x61 + 10 : -1;
      if (digit < 0) { this.reject(); return; }
      this.unicodeValue = (this.unicodeValue << 4) | digit;
      this.unicodeDigits--;
      if (!this.unicodeDigits) this.matchStringCodePoint(this.unicodeValue);
      return;
    }
    if (this.escaped) {
      this.escaped = false;
      if (byte === 0x75) { this.unicodeDigits = 4; this.unicodeValue = 0; return; }
      const decoded = new Map([[0x22, 0x22], [0x5c, 0x5c], [0x2f, 0x2f], [0x62, 0x08], [0x66, 0x0c], [0x6e, 0x0a], [0x72, 0x0d], [0x74, 0x09]]).get(byte);
      if (decoded === undefined) { this.reject(); return; }
      this.matchStringCodePoint(decoded);
      return;
    }
    if (byte === 0x22) { this.finishString(); return; }
    if (byte === 0x5c) { this.escaped = true; return; }
    if (byte < 0x20) { this.reject(); return; }
    if (byte < 0x80) { this.matchStringCodePoint(byte); return; }
    if (byte >= 0xc2 && byte <= 0xdf) { this.utf8Remaining = 1; this.utf8CodePoint = byte & 0x1f; this.utf8Minimum = 0x80; return; }
    if (byte >= 0xe0 && byte <= 0xef) { this.utf8Remaining = 2; this.utf8CodePoint = byte & 0x0f; this.utf8Minimum = 0x800; return; }
    if (byte >= 0xf0 && byte <= 0xf4) { this.utf8Remaining = 3; this.utf8CodePoint = byte & 0x07; this.utf8Minimum = 0x10000; return; }
    this.reject();
  }

  private matchStringCodePoint(codePoint: number): void {
    if (!this.stringMatches || !this.stringTarget) return;
    const target = this.stringTarget;
    if (this.stringIndex >= target.length || codePoint !== target.charCodeAt(this.stringIndex)) this.stringMatches = false;
    else this.stringIndex++;
  }

  private finishString(): void {
    const matched = this.stringMatches && this.stringTarget !== undefined && this.stringIndex === this.stringTarget.length;
    this.token = "none";
    const frame = this.stack.at(-1);
    if (!frame) { this.reject(); return; }
    if (this.stringRole === "key") {
      if (frame.kind !== "object" || (frame.state !== "keyOrEnd" && frame.state !== "keyRequired")) { this.reject(); return; }
      frame.currentType = frame.root && matched;
      if (frame.currentType) {
        this.typeCount++;
        if (this.typeCount > 1) { this.reject(); return; }
      }
      frame.state = "colon";
      return;
    }
    if (frame.kind === "object" && frame.root && frame.currentType) this.typeValueMatches = matched;
    this.completeValue();
  }

  private consumeLiteralByte(byte: number): void {
    if (byte !== this.literal.charCodeAt(this.literalIndex)) { this.reject(); return; }
    this.literalIndex++;
    if (this.literalIndex === this.literal.length) { this.token = "none"; this.literal = ""; this.completeValue(); }
  }

  private consumeNumberByte(byte: number): boolean {
    const digit = byte >= 0x30 && byte <= 0x39;
    switch (this.numberState) {
      case "minus":
        if (byte === 0x30) this.numberState = "zero";
        else if (byte >= 0x31 && byte <= 0x39) this.numberState = "integer";
        else this.reject();
        return true;
      case "zero":
        if (byte === 0x2e) { this.numberState = "fractionStart"; return true; }
        if (byte === 0x65 || byte === 0x45) { this.numberState = "exponentStart"; return true; }
        if (digit) { this.reject(); return true; }
        break;
      case "integer":
        if (digit) return true;
        if (byte === 0x2e) { this.numberState = "fractionStart"; return true; }
        if (byte === 0x65 || byte === 0x45) { this.numberState = "exponentStart"; return true; }
        break;
      case "fractionStart":
        if (digit) { this.numberState = "fraction"; return true; }
        this.reject(); return true;
      case "fraction":
        if (digit) return true;
        if (byte === 0x65 || byte === 0x45) { this.numberState = "exponentStart"; return true; }
        break;
      case "exponentStart":
        if (byte === 0x2b || byte === 0x2d) { this.numberState = "exponentSign"; return true; }
        if (digit) { this.numberState = "exponent"; return true; }
        this.reject(); return true;
      case "exponentSign":
        if (digit) { this.numberState = "exponent"; return true; }
        this.reject(); return true;
      case "exponent":
        if (digit) return true;
        break;
    }
    if (!this.numberTerminal()) { this.reject(); return true; }
    this.token = "none";
    this.completeValue();
    if (!this.failed) this.consumeSyntax(byte);
    return true;
  }

  private numberTerminal(): boolean { return this.numberState === "zero" || this.numberState === "integer" || this.numberState === "fraction" || this.numberState === "exponent"; }

  private completeValue(): void {
    const frame = this.stack.at(-1);
    if (!frame) { this.rootComplete = true; return; }
    if (frame.kind === "object") {
      if (frame.state !== "value") { this.reject(); return; }
      frame.state = "commaOrEnd";
    } else {
      if (frame.state !== "valueOrEnd" && frame.state !== "valueRequired") { this.reject(); return; }
      frame.state = "commaOrEnd";
    }
  }

  private closeContainer(kind: Frame["kind"]): void {
    const frame = this.stack.at(-1);
    if (!frame || frame.kind !== kind) { this.reject(); return; }
    this.stack.pop();
    if (!this.stack.length) this.rootComplete = true;
    else this.completeValue();
  }
}
