export class SerializeAddon {
  activate(term) { this.term = term; }
  serialize() {
    if (this.term.failSerialize) throw new Error("serialize failed");
    return this.term.screen;
  }
  dispose() { this.term.disposedSerializers = (this.term.disposedSerializers || 0) + 1; }
}
