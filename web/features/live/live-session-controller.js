/**
 * Owns exactly one frontend media/control session. MultiView retains only the
 * card DOM, layout and batch scheduling. The server remains authoritative for
 * cleanup and release; a local dispose never proves server cleanup.
 */
export class LiveSessionController {
  constructor({ deviceId, serial, isCurrent, scheduleTimeout, cancelTimeout }) {
    this.deviceId = deviceId;
    this.serial = serial;
    this.isCurrent = isCurrent;
    this.scheduleTimeout = scheduleTimeout;
    this.cancelTimeout = cancelTimeout;
    this.session = null;
    this.ws = null;
    this.player = null;
    this.touch = null;
    this.closed = false;
    this.stopTimer = null;
    this.frameCallback = undefined;
    this.disposed = false;
  }

  get active() {
    return !this.closed && this.isCurrent();
  }

  ownsSocket(socket) {
    return this.active && this.ws === socket;
  }

  bindSocket(socket) {
    if (!this.active || this.ws) {
      try {
        socket.close();
      } catch {
        // The newly rejected socket is never registered as a live resource.
      }
      return false;
    }
    this.ws = socket;
    return true;
  }

  bindPlayer(player) {
    if (!this.active || this.player) {
      player.destroy();
      return false;
    }
    this.player = player;
    return true;
  }

  bindTouch(touch) {
    if (!this.active || this.touch) {
      touch.destroy();
      return false;
    }
    this.touch = touch;
    return true;
  }

  assignSession(sessionId) {
    if (!this.active || typeof sessionId !== 'string' || !sessionId) return false;
    if (this.session && this.session !== sessionId) return false;
    this.session = sessionId;
    return true;
  }

  acceptsMessage(socket, message) {
    if (!this.ownsSocket(socket)) return false;
    return !(
      message.session_id &&
      this.session &&
      message.session_id !== this.session
    );
  }

  armStopTimeout(callback, durationMs) {
    if (!this.active) return false;
    this.clearStopTimeout();
    this.stopTimer = this.scheduleTimeout(() => {
      this.stopTimer = null;
      if (this.active) callback();
    }, durationMs);
    return true;
  }

  clearStopTimeout() {
    if (this.stopTimer === null) return;
    this.cancelTimeout(this.stopTimer);
    this.stopTimer = null;
  }

  dispose({ clean, openSocketState, video }) {
    if (this.disposed) return false;
    this.disposed = true;
    this.closed = true;
    this.clearStopTimeout();
    if (this.touch) {
      this.touch.destroy();
      this.touch = null;
    }
    if (this.frameCallback !== undefined && typeof video?.cancelVideoFrameCallback === 'function') {
      video.cancelVideoFrameCallback(this.frameCallback);
      this.frameCallback = undefined;
    }
    if (this.player) {
      this.player.destroy();
      this.player = null;
    }
    if (this.ws) {
      const socket = this.ws;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        if (socket.readyState === openSocketState && !clean) socket.send('stop');
        socket.close();
      } catch {
        // Local close failure does NOT confirm the server released this session.
      }
      this.ws = null;
    }
    return true;
  }
}

export function createLiveSessionController(options) {
  return new LiveSessionController(options);
}
