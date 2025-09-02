// room.js
const params = new URLSearchParams(window.location.search)
const roomId = params.get('id')

const shareLinkEl = document.getElementById('shareLink')
const copyBtn = document.getElementById('copyBtn')
const roomIdLabel = document.getElementById('roomIdLabel')
const countEl = document.getElementById('count')

const loadBtn = document.getElementById('loadBtn')
const videoUrlInput = document.getElementById('videoUrl')
const fsSyncBtn = document.getElementById('fsSyncBtn')
const playerContainer = document.getElementById('playerContainer')

const ytContainer = document.getElementById('ytContainer')
const filePlayer = document.getElementById('filePlayer')

const peersGrid = document.getElementById('peersGrid')
const toggleMicBtn = document.getElementById('toggleMic')
const toggleCamBtn = document.getElementById('toggleCam')

let clientId = null
let es = null
let suppress = false
let ytPlayer = null
let ytReady = false

// WebRTC
const peers = new Map() // peerId -> { pc, el }
let localStream = null
let micEnabled = true
let camEnabled = true

function isNetflix(url) {
  try { return new URL(url).hostname.includes('netflix.com') } catch { return false }
}
function parseYouTubeId(urlStr) {
  try {
    const u = new URL(urlStr)
    if (u.hostname === 'youtu.be') return u.pathname.slice(1)
    if (u.hostname.includes('youtube.com')) {
      if (u.searchParams.get('v')) return u.searchParams.get('v')
      const parts = u.pathname.split('/')
      const idx = parts.indexOf('shorts')
      if (idx >= 0 && parts[idx + 1]) return parts[idx + 1]
    }
  } catch {}
  if (/^[a-zA-Z0-9_-]{11}$/.test(urlStr)) return urlStr
  return null
}
function detectVideo(urlStr) {
  if (isNetflix(urlStr)) return { type: 'unsupported' }
  const ytId = parseYouTubeId(urlStr)
  if (ytId) return { type: 'youtube', videoId: ytId, url: urlStr }
  if (/\.(mp4|webm|ogg)(\?.*)?$/i.test(urlStr)) return { type: 'file', url: urlStr }
  return { type: 'unknown' }
}
function setParticipants(count) {
  countEl.textContent = String(count)
}
function showYouTube() {
  ytContainer.classList.remove('hidden')
  filePlayer.classList.add('hidden')
}
function showFile() {
  filePlayer.classList.remove('hidden')
  ytContainer.classList.add('hidden')
}
function loadYouTube(videoId, time = 0, autoplay = false) {
  showYouTube()
  const startSeconds = Math.max(0, Math.floor(time))
  if (ytPlayer && ytReady) {
    suppress = true
    ytPlayer.loadVideoById({ videoId, startSeconds })
    if (!autoplay) ytPlayer.pauseVideo()
    setTimeout(() => { suppress = false }, 200)
    return
  }
  window.onYouTubeIframeAPIReady = () => {
    ytPlayer = new YT.Player('ytPlayer', {
      width: '100%',
      height: '100%',
      videoId,
      playerVars: { controls: 1, modestbranding: 1, rel: 0, origin: window.location.origin, start: startSeconds },
      events: {
        onReady: (e) => {
          ytReady = true
          if (!autoplay) e.target.pauseVideo()
        },
        onStateChange: (e) => {
          if (suppress) return
          const state = e.data
          const t = ytPlayer.getCurrentTime ? ytPlayer.getCurrentTime() : 0
          if (state === YT.PlayerState.PLAYING) {
            broadcast('play', { time: t })
          } else if (state === YT.PlayerState.PAUSED) {
            broadcast('pause', { time: t })
          }
        },
      },
    })
  }
  if (window.YT && window.YT.Player) window.onYouTubeIframeAPIReady()
}
function loadFile(url, time = 0, autoplay = false) {
  showFile()
  suppress = true
  filePlayer.src = url
  filePlayer.currentTime = Math.max(0, time || 0)
  if (autoplay) filePlayer.play().catch(() => {})
  else filePlayer.pause()
  setTimeout(() => { suppress = false }, 200)
}
function applyEvent(ev) {
  if (!ev) return
  if (ev.senderId && ev.senderId === clientId) return // ignore self

  // Presence and participants
  if (ev.type === 'presence') {
    setParticipants(ev.count || Number(countEl.textContent) || 1)
    if (ev.action === 'join' && ev.clientId && ev.clientId !== clientId) {
      ensurePeer(ev.clientId, true) // we initiate offer
    } else if (ev.action === 'leave' && ev.clientId) {
      removePeer(ev.clientId)
    }
    return
  }
  if (ev.type === 'participants') {
    setParticipants(ev.count)
    return
  }

  // Playback events
  if (ev.type === 'load' && ev.video) {
    if (ev.video.type === 'youtube' && ev.video.videoId) {
      suppress = true
      loadYouTube(ev.video.videoId, ev.time || 0, !!ev.autoplay)
      setTimeout(() => { suppress = false }, 200)
    } else if (ev.video.type === 'file' && ev.video.url) {
      suppress = true
      loadFile(ev.video.url, ev.time || 0, !!ev.autoplay)
      setTimeout(() => { suppress = false }, 200)
    }
    return
  }
  if (ev.type === 'play') {
    if (!ytContainer.classList.contains('hidden') && ytPlayer && ytReady) {
      suppress = true
      ytPlayer.seekTo(ev.time || 0, true)
      ytPlayer.playVideo()
      setTimeout(() => { suppress = false }, 200)
    } else if (!filePlayer.classList.contains('hidden')) {
      suppress = true
      filePlayer.currentTime = ev.time || 0
      filePlayer.play().catch(() => {})
      setTimeout(() => { suppress = false }, 200)
    }
    return
  }
  if (ev.type === 'pause') {
    if (!ytContainer.classList.contains('hidden') && ytPlayer && ytReady) {
      suppress = true
      ytPlayer.seekTo(ev.time || 0, true)
      ytPlayer.pauseVideo()
      setTimeout(() => { suppress = false }, 200)
    } else if (!filePlayer.classList.contains('hidden')) {
      suppress = true
      filePlayer.currentTime = ev.time || 0
      filePlayer.pause()
      setTimeout(() => { suppress = false }, 200)
    }
    return
  }
  if (ev.type === 'seek') {
    if (!ytContainer.classList.contains('hidden') && ytPlayer && ytReady) {
      suppress = true
      ytPlayer.seekTo(ev.time || 0, true)
      setTimeout(() => { suppress = false }, 200)
    } else if (!filePlayer.classList.contains('hidden')) {
      suppress = true
      filePlayer.currentTime = ev.time || 0
      setTimeout(() => { suppress = false }, 200)
    }
    return
  }

  // Fullscreen sync
  if (ev.type === 'fullscreen') {
    if (ev.active) {
      try {
        if (!document.fullscreenElement) playerContainer.requestFullscreen().catch(() => {})
      } catch {}
    } else {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    }
    return
  }

  // WebRTC signaling
  if (ev.type === 'rtc-offer' && ev.targetId === clientId) {
    handleOffer(ev.senderId, ev.sdp)
    return
  }
  if (ev.type === 'rtc-answer' && ev.targetId === clientId) {
    handleAnswer(ev.senderId, ev.sdp)
    return
  }
  if (ev.type === 'rtc-ice' && ev.targetId === clientId) {
    handleIce(ev.senderId, ev.candidate)
    return
  }
}

function broadcast(type, payload = {}) {
  const ev = { type, senderId: clientId, ...payload }
  fetch(`/api/rooms/${encodeURIComponent(roomId)}/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ev),
  }).catch(() => {})
}

// Join room and get state + participant list
async function joinRoom() {
  const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (res.status === 403 || res.status === 429) {
    alert('Room is full (max 4 participants)')
    window.location.href = '/'
    return
  }
  const data = await res.json()
  clientId = data.clientId
  setParticipants((data.room?.participants || []).length || 1)

  // Initialize video from current state (late join fix)
  const video = data.room?.video
  const state = data.room?.state
  if (video) {
    if (video.type === 'youtube' && video.videoId) {
      loadYouTube(video.videoId, state?.currentTime || 0, !!state?.isPlaying)
    } else if (video.type === 'file' && video.url) {
      loadFile(video.url, state?.currentTime || 0, !!state?.isPlaying)
    }
  }

  // Prepare WebRTC: get media, add local tile
  await setupLocalMedia()

  // Create connections to existing participants (we initiate offers)
  const others = (data.room?.participants || []).filter((id) => id !== clientId)
  for (const pid of others) ensurePeer(pid, true)
}

function startSSE() {
  es = new EventSource(`/api/rooms/${encodeURIComponent(roomId)}/events?clientId=${encodeURIComponent(clientId)}`)
  es.onmessage = (msg) => {
    try {
      const ev = JSON.parse(msg.data)
      if (ev && ev.type) applyEvent(ev)
    } catch {}
  }
  es.onerror = () => { /* browser auto-retries */ }
}

// File video event hooks
filePlayer.addEventListener('play', () => { if (!suppress) broadcast('play', { time: filePlayer.currentTime }) })
filePlayer.addEventListener('pause', () => { if (!suppress) broadcast('pause', { time: filePlayer.currentTime }) })
filePlayer.addEventListener('seeked', () => { if (!suppress) broadcast('seek', { time: filePlayer.currentTime }) })

loadBtn.addEventListener('click', () => {
  const v = (videoUrlInput.value || '').trim()
  if (!v) return

  const meta = detectVideo(v)
  if (meta.type === 'unsupported') { alert('Netflix cannot be embedded. Use YouTube or a direct video URL.'); return }
  if (meta.type === 'unknown') { alert('Unsupported URL. Use YouTube or a direct .mp4/.webm/.ogg URL.'); return }

  let videoPayload = null
  if (meta.type === 'youtube') {
    videoPayload = { type: 'youtube', url: meta.url, videoId: meta.videoId }
    suppress = true
    loadYouTube(meta.videoId, 0, false)
    setTimeout(() => { suppress = false }, 200)
  } else if (meta.type === 'file') {
    videoPayload = { type: 'file', url: meta.url }
    suppress = true
    loadFile(meta.url, 0, false)
    setTimeout(() => { suppress = false }, 200)
  }
  broadcast('load', { video: videoPayload, time: 0, autoplay: false })
})

// Fullscreen sync
fsSyncBtn.addEventListener('click', async () => {
  const goingFull = !document.fullscreenElement
  if (goingFull) {
    try { await playerContainer.requestFullscreen() } catch {}
  } else {
    try { await document.exitFullscreen() } catch {}
  }
  broadcast('fullscreen', { active: goingFull })
})

// Clipboard share
copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(shareLinkEl.value)
    copyBtn.textContent = 'Copied'
    setTimeout(() => (copyBtn.textContent = 'Copy'), 1200)
  } catch {}
})

// WebRTC helpers
async function setupLocalMedia() {
  if (localStream) return
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
  } catch {
    // fallback to audio-only if camera blocked
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    } catch {
      localStream = null
    }
  }
  addOrUpdateLocalTile()
}

function addOrUpdateLocalTile() {
  let tile = document.getElementById(`peer-${clientId}`)
  if (!tile) {
    tile = document.createElement('div')
    tile.className = 'peer-tile'
    tile.id = `peer-${clientId}`
    const v = document.createElement('video')
    v.autoplay = true
    v.muted = true
    v.playsInline = true
    v.id = `video-${clientId}`
    tile.appendChild(v)
    const label = document.createElement('div')
    label.className = 'peer-label'
    label.textContent = 'You'
    tile.appendChild(label)
    peersGrid.prepend(tile)
  }
  const v = document.getElementById(`video-${clientId}`)
  if (v && localStream) v.srcObject = localStream
}

function ensurePeer(peerId, initiateOffer) {
  if (peerId === clientId) return
  if (peers.has(peerId)) return peers.get(peerId)

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  })
  // Add our local tracks
  if (localStream) {
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream)
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      broadcast('rtc-ice', { targetId: peerId, candidate: e.candidate })
    }
  }
  pc.ontrack = (e) => {
    let tile = document.getElementById(`peer-${peerId}`)
    if (!tile) {
      tile = document.createElement('div')
      tile.className = 'peer-tile'
      tile.id = `peer-${peerId}`
      const v = document.createElement('video')
      v.autoplay = true
      v.playsInline = true
      v.id = `video-${peerId}`
      tile.appendChild(v)
      const label = document.createElement('div')
      label.className = 'peer-label'
      label.textContent = peerId.slice(0, 6)
      tile.appendChild(label)
      peersGrid.appendChild(tile)
    }
    const v = document.getElementById(`video-${peerId}`)
    if (v) v.srcObject = e.streams[0]
  }

  peers.set(peerId, { pc })
  if (initiateOffer) {
    pc.createOffer().then((offer) => {
      return pc.setLocalDescription(offer)
    }).then(() => {
      broadcast('rtc-offer', { targetId: peerId, sdp: pc.localDescription })
    }).catch(() => {})
  }
  return { pc }
}

function removePeer(peerId) {
  const entry = peers.get(peerId)
  if (entry) {
    try { entry.pc.close() } catch {}
    peers.delete(peerId)
  }
  const tile = document.getElementById(`peer-${peerId}`)
  if (tile) tile.remove()
}

async function handleOffer(fromId, sdp) {
  const { pc } = ensurePeer(fromId, false)
  await pc.setRemoteDescription(new RTCSessionDescription(sdp)).catch(() => {})
  const answer = await pc.createAnswer().catch(() => null)
  if (!answer) return
  await pc.setLocalDescription(answer).catch(() => {})
  broadcast('rtc-answer', { targetId: fromId, sdp: pc.localDescription })
}

async function handleAnswer(fromId, sdp) {
  const entry = peers.get(fromId)
  if (!entry) return
  await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp)).catch(() => {})
}

async function handleIce(fromId, candidate) {
  const entry = peers.get(fromId)
  if (!entry) return
  try {
    await entry.pc.addIceCandidate(new RTCIceCandidate(candidate))
  } catch {}
}

// Mic/cam toggles
toggleMicBtn.addEventListener('click', () => {
  micEnabled = !micEnabled
  if (localStream) for (const t of localStream.getAudioTracks()) t.enabled = micEnabled
  toggleMicBtn.textContent = micEnabled ? 'Mute Mic' : 'Unmute Mic'
})
toggleCamBtn.addEventListener('click', () => {
  camEnabled = !camEnabled
  if (localStream) for (const t of localStream.getVideoTracks()) t.enabled = camEnabled
  toggleCamBtn.textContent = camEnabled ? 'Turn Camera Off' : 'Turn Camera On'
})

// Init
;(async function init() {
  if (!roomId) { alert('Missing room ID'); window.location.href = '/'; return }
  roomIdLabel.textContent = roomId
  shareLinkEl.value = `${window.location.origin}/room.html?id=${encodeURIComponent(roomId)}`
  await joinRoom()
  startSSE()
})()
