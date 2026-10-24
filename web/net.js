// Multiplayer transport. The relay forwards every message to the other laptops and keeps no state, so this file
// owns the message envelope and checks everything another laptop sends before the rest of the app sees it.
const RETRY_MS = 1000;
const MAX_BUFFERED = 1 << 20; // bytes; a state snapshot that would queue behind a stalled link is dropped, not delayed

const finite = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite);
const pose = o => !!o && typeof o.id === 'string' && finite(o.pos, 3) && finite(o.quat, 4);

export function validState(msg) {
  if (!msg || msg.type !== 'state' || typeof msg.user !== 'string' || !Number.isFinite(msg.seq)) return false;
  const a = msg.avatar; // the sender's avatar snapshot, as produced by Locomotion.state()
  if (!a || !finite(a.pos, 3) || !finite(a.vel, 3) || !Number.isFinite(a.yaw) || !Number.isFinite(a.pitch) || typeof a.flying !== 'boolean') return false;
  if (msg.head != null && !finite(msg.head.quat, 4)) return false;
  if (msg.target != null && typeof msg.target !== 'string') return false;
  if (!Array.isArray(msg.hands) || msg.hands.length > 2) return false;
  for (const hand of msg.hands) {
    if (!hand || !['left', 'right'].includes(hand.side) || !Number.isFinite(hand.pinch) || hand.pinch < 0 || hand.pinch > 1) return false;
    if (!Array.isArray(hand.lm) || hand.lm.length !== 21 || !hand.lm.every(p => finite(p, 3))) return false;
  }
  return Array.isArray(msg.held) && msg.held.length <= 16 && msg.held.every(pose);
}

export function validScene(msg) {
  return !!msg && msg.type === 'scene' && typeof msg.user === 'string' && Number.isFinite(msg.seq) &&
    Array.isArray(msg.objects) && msg.objects.length <= 64 && msg.objects.every(pose);
}

const VALID = { state: validState, scene: validScene };

export class Net {
  // onMessage receives validated `state` and `scene` messages from other users. Other types (the `op` edits arrive
  // with voice-to-CAD) are ignored for now.
  constructor(url, userId, onMessage, onStatus, { WebSocketClass = WebSocket } = {}) {
    this.url = url;
    this.userId = userId;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.WebSocketClass = WebSocketClass;
    this.status = '';
    this.open = false;
    this.stopped = false;
    // Always increasing, so a page that reloads and restarts its count is not mistaken for old traffic.
    this.seq = Date.now();
    this.lastSeq = new Map(); // `${user}:${type}` -> newest seq accepted
    this.setStatus('connecting');
    this.connect();
  }

  setStatus(status) {
    if (status === this.status) return;
    this.status = status;
    this.onStatus?.(status);
  }

  connect() {
    if (this.stopped) return;
    this.setStatus('connecting');
    const socket = this.socket = new this.WebSocketClass(this.url);
    socket.onopen = () => {
      this.open = true;
      this.setStatus('connected');
    };
    socket.onmessage = event => this.receive(event.data);
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      this.open = false;
      if (this.stopped) return;
      this.setStatus('disconnected; retrying');
      this.retry = setTimeout(() => this.connect(), RETRY_MS);
    };
  }

  receive(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const valid = VALID[msg?.type];
    if (!valid || !valid(msg) || msg.user === this.userId) return;
    // Every message is a full snapshot, so anything older than what we already have is simply dropped.
    const key = `${msg.user}:${msg.type}`;
    if (msg.seq <= (this.lastSeq.get(key) ?? -Infinity)) return;
    this.lastSeq.set(key, msg.seq);
    this.onMessage(msg);
  }

  // Stamps the sender and sequence number. Returns false when the snapshot was dropped (not connected, or backed up).
  send(msg) {
    if (!this.open || this.socket.bufferedAmount > MAX_BUFFERED) return false;
    this.socket.send(JSON.stringify({ ...msg, user: this.userId, seq: ++this.seq }));
    return true;
  }

  stop() {
    this.stopped = true;
    this.open = false;
    clearTimeout(this.retry);
    const socket = this.socket;
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
    socket.close();
  }
}
