export class RemoteSpeechRelay {
  constructor({ getTransport = () => null } = {}) {
    this.getTransport = getTransport;
    this.active = null;
  }

  handle(event) {
    if (!event?.speechId) return false;
    if (event.type === "start" || event.type === "fallback") return this.#start(event);
    if (!this.active || this.active.speechId !== event.speechId) return false;
    if (event.type === "audio") return false;
    if (event.type === "end") return this.#finish("speech.end");
    if (event.type === "cancel") return this.#finish("speech.cancel", { discard: true });
    return false;
  }

  reset() {
    if (this.active) this.#finish("speech.cancel", { discard: true });
    this.active = null;
  }

  #start(event) {
    this.reset();
    const transport = this.getTransport();
    if (!transport?.notify?.("speech.fallback", {
      speechId: event.speechId,
      transcript: event.transcript,
      performance: event.performance
    })) return false;
    this.active = { speechId: event.speechId, transport };
    return true;
  }

  #finish(type, { discard = false } = {}) {
    const active = this.active;
    if (!active) return false;
    this.active = null;
    if (active.transport !== this.getTransport()) return false;
    return active.transport.notify(type, { speechId: active.speechId });
  }
}
