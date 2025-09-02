// public/room.js
// <CHANGE> v2.1: jitter smoothing, drift-aware sync, leader periodic sync, fullscreen sync guards.

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

// ---- Sync tuning
const DRIFT_THRESHOLD = 0.6       // seconds: only correct if off by more than this
const SEEK_APPLY_THRESHOLD = 0.3  // seconds: for seek corrections
const SEEK_RATE_MS = 800          // throttle outgoing seek
const SYNC_INTERVAL_MS = 5000     // leader sends periodic soft sync

let clientId = null
let es = null
let suppress = false
let ytPlayer = null
let ytReady = false
let lastYTState = null
let lastSeekSentAt = 0
let lastAppliedEventAt = 0
let fsSuppress = false

// Leader election & participants
const participants = new Set()
let syncTimer = null

function electLeader() {
  const all = Array.from(participants).concat(clientId ? [clientId] : [])
  if (all.length === 0) return null
  all.sort()
  return all[0]
}
function weAreLeader() {
  const leader = electLeader()
  return leader && clientId && leader === clientId
}
function startLeaderSync() {
  stopLeaderSync()
  if (!weAreLeader()) return
  syncTimer = setInterval(() => {
    // emit soft sync with current time and state
    const { time, isPlaying } = getLocalState()
    broadcast('sync', { time, isPlaying })
  }, SYNC_INTERVAL_MS)
}
function stopLeaderSync() {
  if (syncTimer) {
    clearInterval(syncTimer)
    syncTimer = null
  }
}

// ---- URL helpers
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

// ---- UI helpers
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

// ---- Player helpers
function getActivePlayerType() {
  return ytContainer.classList.contains('hidden') ? 'file' : 'yt'
}
function getCurrentTime() {
  if (getActivePlayerType() === 'yt') {
    try { return ytPlayer?.getCurrentTime() || 0 } catch { return 0 }
  }
  return filePlayer.currentTime || 0
}
function isLocallyPlaying() {
  if (getActivePlayerType() === 'yt') {
    try { return ytPlayer && ytPlayer.getPlayerState() === YT.PlayerState.PLAYING } catch { return false }
  }
  return !filePlayer.paused
}
function playAt(time) {
  suppress = true
  if (getActivePlayerType() === 'yt' && ytPlayer && ytReady) {
    ytPlayer.seekTo(time || 0, true)
    ytPlayer.playVideo()
  } else {
    filePlayer.currentTime = time || 0
    filePlayer.play().catch(() => {})
  }
  setTimeout(() => { suppress = false }, 200)
}
function pauseAt(time) {
  suppress = true
  if (getActivePlayerType() === 'yt' && ytPlayer && ytReady) {
    ytPlayer.seekTo(time || 0, true)
    ytPlayer.pauseVideo()
  } else {
    filePlayer.currentTime = time || 0
    filePlayer.pause()
  }
  setTimeout(() => { suppress = false }, 200)
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
          // Ignore BUFFERING and repeated same-state transitions
          if (state === YT.PlayerState.BUFFERING) return
          if (state === lastYTState) return
          lastYTState = state

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

// ---- Apply incoming events with drift checks
function applyEvent(ev) {
  if (!ev) return
  if (ev.senderId && ev.senderId === clientId) return // ignore self

  // Presence and participants
  if (ev.type === 'presence') {
    if (ev.action === 'join' && ev.clientId) participants.add(ev.clientId)
    if (ev.action === 'leave' && ev.clientId) participants.delete(ev.clientId)
    setParticipants(ev.count || participants.size + 1)
    // leader may have changed
    startLeaderSync()
    return
  }
  if (ev.type === 'participants') {
    setParticipants(ev.count)
    return
  }

  // Playback events
  if (ev.type === 'load' && ev.video) {
    lastAppliedEventAt = Date.now()
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
    const drift = Math.abs(getCurrentTime() - (ev.time || 0))
    if (drift > DRIFT_THRESHOLD || !isLocallyPlaying()) {
      playAt(ev.time || 0)
    }
    return
  }
  if (ev.type === 'pause') {
    const drift = Math.abs(getCurrentTime() - (ev.time || 0))
    if (drift > DRIFT_THRESHOLD || isLocallyPlaying()) {
      pauseAt(ev.time || 0)
    }
    return
  }
  if (ev.type === 'seek') {
    const drift = Math.abs(getCurrentTime() - (ev.time || 0))
    if (drift > SEEK_APPLY_THRESHOLD) {
      suppress = true
      if (getActivePlayerType() === 'yt' && ytPlayer && ytReady) {
        ytPlayer.seekTo(ev.time || 0, true)
      } else {
        filePlayer.currentTime = ev.time || 0
      }
      setTimeout(() => { suppress = false }, 150)
    }
    return
  }

  // Soft periodic sync (leader)
  if (ev.type === 'sync') {
    // Only honor leader sync
    const leader = electLeader()
    if (!leader || ev.senderId !== leader) return
    const drift = Math.abs(getCurrentTime() - (ev.time || 0))
    if (ev.isPlaying) {
      if (drift > DRIFT_THRESHOLD) playAt(ev.time || 0)
      // else let it drift naturally (no micro-corrections)
    } else {
      if (drift > DRIFT_THRESHOLD) pauseAt(ev.time || 0)
      else pauseAt(ev.time || 0) // ensure paused state
    }
    return
  }

  // Fullscreen sync (guard to avoid feedback loops)
  if (ev.type === 'fullscreen') {
    fsSuppress = true
    if (ev.active) {
      try {
        if (!document.fullscreenElement) playerContainer.requestFullscreen().catch(() => {})
      } catch {}
    } else {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    }
    setTimeout(() => { fsSuppress = false }, 300)
    return
  }

  // WebRTC signaling
  if (ev.type === 'rtc-offer' && ev.targetId === clientId) { handleOffer(ev.senderId, ev.sdp); return }
  if (ev.type === 'rtc-answer' && ev.targetId === clientId) { handleAnswer(ev.senderId, ev.sdp); return }
  if (ev.type === 'rtc-ice' && ev.targetId === clientId) { handleIce(ev.senderId, ev.candidate); return }
}

function broadcast(type, payload = {}) {
  const ev = { type, senderId: clientId, ...payload }
  fetch(`/api/rooms/${encodeURIComponent(roomId)}/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ev),
  }).catch(() => {})
}

// ---- Join, SSE, and initialization
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

  // Build participants set and update UI
  participants.clear()
  const others = (data.room?.participants || []).filter((id) => id !== clientId)
  for (const id of others) participants.add(id)
  setParticipants((data.room?.participants || []).length || 1)

  // Initialize video for late joiners
  const video = data.room?.video
  const state = data.room?.state
  if (video) {
    if (video.type === 'youtube' && video.videoId) {
      loadYouTube(video.videoId, state?.currentTime || 0, !!state?.isPlaying)
    } else if (video.type === 'file' && video.url) {
      loadFile(video.url, state?.currentTime || 0, !!state?.isPlaying)
    }
    // If leader indicates playing, make sure we play; else pause
    if (state?.isPlaying) playAt(state.currentTime || 0)
    else pauseAt(state?.currentTime || 0)
  }

  // Prepare media for WebRTC and add local tile
  await setupLocalMedia()

  // Initiate connections to others
  for (const pid of others) ensurePeer(pid, true)

  // Start/refresh leader sync
  startLeaderSync()
}
function startSSE() {
  es = new EventSource(`/api/rooms/${encodeURIComponent(roomId)}/events?clientId=${encodeURIComponent(clientId)}`)
  es.onmessage = (msg) => {
    try {
      const ev = JSON.parse(msg.data)
      if (ev && ev.type) applyEvent(ev)
    } catch {}
  }
  es.onerror = () => { /* auto-retry */ }
}

// ---- Outgoing local events with throttling
filePlayer.addEventListener('play', () => { if (!suppress) broadcast('play', { time: filePlayer.currentTime }) })
filePlayer.addEventListener('pause', () => { if (!suppress) broadcast('pause', { time: filePlayer.currentTime }) })
filePlayer.addEventListener('seeked', () => {
  if (suppress) return
  const now = Date.now()
  if (now - lastSeekSentAt < SEEK_RATE_MS) return
  lastSeekSentAt = now
  broadcast('seek', { time: filePlayer.currentTime })
})

// Fullscreen sync: button and automatic detection with loop guard
fsSyncBtn.addEventListener('click', async () => {
  const goingFull = !document.fullscreenElement
  try {
    if (goingFull) await playerContainer.requestFullscreen()
    else await document.exitFullscreen()
  } catch {}
  broadcast('fullscreen', { active: goingFull })
})
document.addEventListener('fullscreenchange', () => {
  if (fsSuppress) return
  const active = !!document.fullscreenElement
  broadcast('fullscreen', { active })
})

// Clipboard share
copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(shareLinkEl.value)
    copyBtn.textContent = 'Copied'
    setTimeout(() => (copyBtn.textContent = 'Copy'), 1200)
  } catch {}
})

// Load video flow
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

// ---- Local state helpers used by leader sync
function getLocalState() {
  return { time: getCurrentTime(), isPlaying: isLocallyPlaying() }
}

// ---- WebRTC (unchanged logic aside from being here)
const peers = new Map()
let localStream = null
let micEnabled = true
let camEnabled = true

async function setupLocalMedia() {
  if (localStream) return
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
  } catch {
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
  if (localStream) for (const track of localStream.getTracks()) pc.addTrack(track, localStream)

  pc.onicecandidate = (e) => {
    if (e.candidate) broadcast('rtc-ice', { targetId: peerId, candidate: e.candidate })
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
    pc.createOffer().then((offer) => pc.setLocalDescription(offer))
      .then(() => broadcast('rtc-offer', { targetId: peerId, sdp: pc.localDescription }))
      .catch(() => {})
  }
  return { pc }
}
function removePeer(peerId) {
  const entry = peers.get(peerId)
  if (entry) { try { entry.pc.close() } catch {} peers.delete(peerId) }
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
  try { await entry.pc.addIceCandidate(new RTCIceCandidate(candidate)) } catch {}
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

// ---- Boot
;(async function init() {
  if (!roomId) { alert('Missing room ID'); window.location.href = '/'; return }
  roomIdLabel.textContent = roomId
  shareLinkEl.value = `${window.location.origin}/room.html?id=${encodeURIComponent(roomId)}`
  await joinRoom()
  startSSE()
})()
