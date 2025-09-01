// script.js
const socket = io();
let roomId, peer, dataChannel;
let player, playerReady = false;
let ignore = false;   // Prevent echo when receiving remote sync

function createRoom() {
  socket.emit('create-room');
}
socket.on('created', code => {
  roomId = code;
  document.getElementById('createBtn').disabled = true;
  document.getElementById('joinBtn').disabled  = true;
  const span = document.getElementById('roomDisplay');
  span.textContent = `Room ${code}`;
  span.style.display = 'inline';
});

function showJoinPrompt() {
  const code = prompt('Enter 4-digit room code:')?.trim();
  if (code && /^\d{4}$/.test(code)) {
    socket.emit('join-room-code', code);
  } else {
    alert('Invalid code. Must be 4 digits.');
  }
}
socket.on('invalid-code', () => alert('Room not found or already full'));

// ---------- YouTube IFrame ----------
function onYouTubeIframeAPIReady() {
  player = new YT.Player('player', {
    height: '100%',
    width: '100%',
    events: {
      onReady: () => { playerReady = true; },
      onStateChange: onPlayerStateChange
    }
  });
}

function loadVideo() {
  const url = document.getElementById('urlInput').value;
  const id = new URL(url).searchParams.get('v');
  if (id && playerReady) {
    player.loadVideoById(id);
  }
}

function onPlayerStateChange(evt) {
  if (!peer || ignore) return;
  const state = evt.data;
  const time = player.getCurrentTime();
  sendPlayerEvent({ type: 'state', state, time });
}

// Send seek only when user scrubs (no API event, so hook mouseup)
document.addEventListener('mouseup', () => {
  if (!peer || ignore) return;
  sendPlayerEvent({ type: 'seek', time: player.getCurrentTime() });
});

function sendPlayerEvent(obj) {
  if (dataChannel && dataChannel.readyState === 'open') {
    dataChannel.send(JSON.stringify(obj));
  }
}

// ---------- Chat ----------
function sendMsg(e) {
  e.preventDefault();
  const inp = document.getElementById('msgInput');
  const msg = inp.value.trim();
  if (!msg || !dataChannel || dataChannel.readyState !== 'open') return;
  const packet = { type: 'chat', user: 'You', msg, ts: Date.now() };
  appendChat(packet);
  dataChannel.send(JSON.stringify(packet));
  inp.value = '';
}
function appendChat({user, msg, ts}) {
  const box = document.getElementById('messages');
  const div = document.createElement('div');
  div.innerHTML = `<small>${new Date(ts).toLocaleTimeString()}</small> <b>${user}</b>: ${msg}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

// ---------- WebRTC ----------
async function startWebRTC() {
  document.getElementById('connectBtn').disabled = true;
  socket.emit('join-room');
}

socket.on('joined', ({roomId: id}) => { roomId = id; });
socket.on('ready', createPeer);

function createPeer() {
  peer = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  dataChannel = peer.createDataChannel('watch', { ordered: true });
  dataChannel.onopen = () => console.log('Data channel open');
  dataChannel.onmessage = e => handleRemote(JSON.parse(e.data));

  peer.ondatachannel = e => {
    dataChannel = e.channel;
    dataChannel.onmessage = e => handleRemote(JSON.parse(e.data));
  };

  peer.onicecandidate = e => {
    if (e.candidate) socket.emit('ice', { candidate: e.candidate });
  };

  socket.on('offer',  async ({offer})  => { peer.setRemoteDescription(offer); await peer.setLocalDescription(await peer.createAnswer()); socket.emit('answer', {answer: peer.localDescription}); });
  socket.on('answer', ({answer}) => peer.setRemoteDescription(answer));
  socket.on('ice',    ({candidate}) => peer.addIceCandidate(candidate));

  (async () => {
    if (peer.connectionState !== 'new') return;
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    socket.emit('offer', {offer});
  })();
}

// ---------- Sync & Chat ----------
function handleRemote({type, ...rest}) {
  ignore = true;
  if (type === 'state') {
    const {state, time} = rest;
    if (Math.abs(player.getCurrentTime() - time) > 0.5) player.seekTo(time, true);
    if (state === YT.PlayerState.PLAYING) player.playVideo();
    if (state === YT.PlayerState.PAUSED)  player.pauseVideo();
  } else if (type === 'seek') {
    player.seekTo(rest.time, true);
  } else if (type === 'chat') {
    appendChat({...rest, user: 'Peer'});
  }
  setTimeout(() => ignore = false, 100);
}

socket.on('peer-disconnected', () => {
  alert('Peer disconnected');
  window.location.reload();   // simple reconnect
});
