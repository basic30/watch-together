// script.js
let socket;
let pc;
let dataChannel;
let player;
let isInitiator = false;
let username;
let currentRoom;

var tag = document.createElement('script');
tag.src = "https://www.youtube.com/iframe_api";
var firstScriptTag = document.getElementsByTagName('script')[0];
firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

function connect() {
  let room = document.getElementById('room').value;
  username = document.getElementById('username').value;
  if (!username) {
    alert('Enter username');
    return;
  }
  if (!room) {
    room = Math.random().toString(36).substring(7);
    document.getElementById('room').value = room;
    alert('Share this Room ID: ' + room);
  }
  currentRoom = room;

  socket = io();
  socket.emit('join', room);

  socket.on('full', () => {
    alert('Room is full');
  });

  socket.on('ready', () => {
    isInitiator = true;
    createPeerConnection();
    pc.createOffer()
      .then(offer => {
        pc.setLocalDescription(offer);
        socket.emit('offer', offer);
      })
      .catch(console.error);
  });

  socket.on('offer', (offer) => {
    isInitiator = false;
    createPeerConnection();
    pc.setRemoteDescription(new RTCSessionDescription(offer))
      .then(() => pc.createAnswer())
      .then(answer => {
        pc.setLocalDescription(answer);
        socket.emit('answer', answer);
      })
      .catch(console.error);
  });

  socket.on('answer', (answer) => {
    pc.setRemoteDescription(new RTCSessionDescription(answer))
      .catch(console.error);
  });

  socket.on('candidate', (candidate) => {
    pc.addIceCandidate(new RTCIceCandidate(candidate))
      .catch(console.error);
  });

  socket.on('bye', () => {
    handleDisconnect();
  });
}

function createPeerConnection() {
  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('candidate', e.candidate);
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      handleDisconnect();
    }
  };

  if (isInitiator) {
    dataChannel = pc.createDataChannel('syncChat');
    setupDataChannel(dataChannel);
  } else {
    pc.ondatachannel = (e) => {
      dataChannel = e.channel;
      setupDataChannel(dataChannel);
    };
  }
}

function setupDataChannel(channel) {
  channel.onopen = () => {
    console.log('Data channel open');
  };
  channel.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === 'chat') {
      addMessage(data.username, data.message, data.timestamp);
    } else if (data.type === 'load') {
      document.getElementById('yturl').value = data.url;
      loadVideo(data.url);
    } else if (data.type === 'play') {
      if (player) {
        isChanging = true;
        player.seekTo(data.time, true);
        player.playVideo();
        setTimeout(() => { isChanging = false; }, 1000);
      }
    } else if (data.type === 'pause') {
      if (player) {
        isChanging = true;
        player.seekTo(data.time, true);
        player.pauseVideo();
        setTimeout(() => { isChanging = false; }, 1000);
      }
    }
  };
}

let isChanging = false;

function onPlayerStateChange(event) {
  if (isChanging || !dataChannel || dataChannel.readyState !== 'open') return;

  const time = player.getCurrentTime();
  if (event.data === YT.PlayerState.PLAYING) {
    dataChannel.send(JSON.stringify({ type: 'play', time }));
  } else if (event.data === YT.PlayerState.PAUSED) {
    dataChannel.send(JSON.stringify({ type: 'pause', time }));
  }
}

function loadVideoLocal() {
  const url = document.getElementById('yturl').value;
  if (!url) return;
  loadVideo(url);
  if (dataChannel && dataChannel.readyState === 'open') {
    dataChannel.send(JSON.stringify({ type: 'load', url }));
  }
}

function loadVideo(url) {
  const videoId = extractVideoId(url);
  if (!videoId) {
    alert('Invalid YouTube URL');
    return;
  }
  if (player) {
    player.loadVideoById(videoId);
  } else {
    player = new YT.Player('player', {
      height: '390',
      width: '640',
      videoId: videoId,
      events: {
        onReady: (event) => {
          event.target.pauseVideo();
        },
        onStateChange: onPlayerStateChange
      }
    });
  }
}

function extractVideoId(url) {
  const regExp = /^.*(youtu\.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
  const match = url.match(regExp);
  return (match && match[2].length === 11) ? match[2] : null;
}

function sendMessage() {
  const msg = document.getElementById('message').value;
  if (!msg || !dataChannel || dataChannel.readyState !== 'open') return;
  const timestamp = new Date().toLocaleTimeString();
  const data = { type: 'chat', username, message: msg, timestamp };
  dataChannel.send(JSON.stringify(data));
  addMessage(username, msg, timestamp);
  document.getElementById('message').value = '';
}

function addMessage(user, msg, time) {
  const chat = document.getElementById('chat');
  const div = document.createElement('div');
  div.innerHTML = `<strong>${user}</strong> (${time}): ${msg}`;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

function handleDisconnect() {
  alert('Other user disconnected. Trying to reconnect...');
  if (pc) {
    pc.close();
    pc = null;
  }
  dataChannel = null;
  // Rejoin the room
  setTimeout(() => {
    connect();
  }, 2000);
}
