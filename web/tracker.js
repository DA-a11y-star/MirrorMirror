// Local sensing transport only. Local hands never round-trip through the multiplayer relay.
const STALE_MS = 500;
const RETRY_MS = 1000;

export function validFrame(msg) {
  if (!msg || msg.type !== 'frame' || !Number.isFinite(msg.t) || !Array.isArray(msg.hands) || msg.hands.length > 2) return false;
  const sides = new Set();
  for (const hand of msg.hands) {
    if (!hand || !['left', 'right'].includes(hand.side) || sides.has(hand.side)) return false;
    sides.add(hand.side);
    if (!Number.isFinite(hand.pinch) || hand.pinch < 0 || hand.pinch > 1 || typeof hand.pinching !== 'boolean') return false;
    if (!Array.isArray(hand.lm) || hand.lm.length !== 21) return false;
    if (!hand.lm.every(p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite))) return false;
  }
  return true;
}

export function startTracker(url, onMessage, onStatus, { WebSocketClass = WebSocket, now = () => performance.now(),
  getScreenLayout = () => null } = {}) {
  let socket;
  let retry;
  let stopped = false;
  let lastReceived = now();
  let lastTimestamp = -Infinity;
  let lastGazeTimestamp = -Infinity;
  let hasFrame = false;
  let stale = false;
  const pinched = new Set();
  function sendScreenLayout() {
    if (socket?.readyState === 1) socket.send(JSON.stringify({ type: 'screen_layout', layout: getScreenLayout() }));
  }

  function gesture(side, active) {
    if (pinched.has(side) === active) return;
    if (active) pinched.add(side);
    else pinched.delete(side);
    onMessage({ type: 'gesture', name: active ? 'pinch_start' : 'pinch_end', hand: side });
  }

  function clearHands() {
    for (const side of [...pinched]) gesture(side, false);
    if (hasFrame) onMessage({ type: 'frame', t: lastTimestamp, hands: [], gaze: null, head: null });
    hasFrame = false;
  }

  function connect() {
    if (stopped) return;
    onStatus('connecting');
    socket = new WebSocketClass(url);
    socket.onopen = () => {
      lastTimestamp = -Infinity; // tracker process may have restarted
      lastGazeTimestamp = -Infinity;
      lastReceived = now();
      stale = false;
      onStatus('waiting for camera');
      sendScreenLayout();
    };
    socket.onmessage = event => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg?.type === 'frame') {
        if (!validFrame(msg) || msg.t <= lastTimestamp) return;
        lastTimestamp = msg.t;
        lastReceived = now();
        hasFrame = true;
        stale = false;
        onStatus('live');
        onMessage(msg);
        // Full snapshots restore state after reconnect or a skipped frame. Explicit wire events are deduplicated.
        for (const side of ['left', 'right']) gesture(side, msg.hands.some(h => h.side === side && h.pinching));
      } else if (msg?.type === 'gaze') {
        if (!Number.isFinite(msg.t) || msg.t <= lastGazeTimestamp || !msg.gaze ||
            !Number.isFinite(msg.gaze.conf) || msg.gaze.conf < 0 || msg.gaze.conf > 1 ||
            !Number.isFinite(msg.gaze.t) || msg.gaze.t !== msg.t) return;
        lastGazeTimestamp = msg.t;
        onMessage(msg);
      } else if (msg?.type === 'gesture' && hasFrame && !stale && ['left', 'right'].includes(msg.hand)) {
        if (msg.name === 'pinch_start' || msg.name === 'pinch_end') gesture(msg.hand, msg.name === 'pinch_start');
      }
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      clearHands();
      if (!stopped) {
        onStatus('disconnected; retrying');
        retry = setTimeout(connect, RETRY_MS);
      }
    };
  }

  const watchdog = setInterval(() => {
    if (hasFrame && !stale && now() - lastReceived > STALE_MS) {
      stale = true;
      clearHands();
      onStatus('stalled; hands cleared');
    }
  }, 100);
  connect();
  const stop = () => {
    stopped = true;
    clearTimeout(retry);
    clearInterval(watchdog);
    clearHands();
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
    socket.close();
  };
  stop.sendScreenLayout = sendScreenLayout;
  return stop;
}
