// public/room.js (updated)
// Behavior: load URL is shared; only "pause" is synced (anyone pauses -> everyone pauses).
// Play/seek are local per user. Fullscreen is synced. Includes 4-person WebRTC call and live chat.

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

// new: embed container (we'll reuse/inject into playerContainer)
let embedFrame = null

const peersGrid = document.getElementById('peersGrid')
const toggleMicBtn = document.getElementById('toggleMic')
const toggleCamBtn = document.getElementById('toggleCam')

const chatMessages = document.getElementById('chatMessages')
const chatInput = document.getElementById('chatInput')
const chatSend = document.getElementById('chatSend')

let clientId = null
let es = null
let suppress = false
let ytPlayer = null
let ytReady = false

// WebRTC
const peers = new Map()
let localStream = null
let micEnabled = true
let camEnabled = true

function isNetflix(url) {
  try { return new URL(url).hostname.includes('netflix.com') } catch { return false }
}

const emojiBtn = document.getElementById('emojiBtn')
const emojiPicker = document.getElementById('emojiPicker')
const chatInput = document.getElementById('chatInput')

emojiBtn.addEventListener('click', () => {
  emojiPicker.classList.toggle('hidden')
})

emojiPicker.addEventListener('emoji-click', (event) => {
  chatInput.value += event.detail.unicode
  emojiPicker.classList.add('hidden')
})

/* ---------- Parsers for common platforms ---------- */
// YouTube existing
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

// Vimeo: vimeo.com/123456 or player.vimeo.com/video/12345
function parseVimeoId(urlStr) {
  try {
    const u = new URL(urlStr)
    if (u.hostname.includes('vimeo.com')) {
      const parts = u.pathname.split('/').filter(Boolean)
      const id = parts[parts.length - 1]
      if (/^\d+$/.test(id)) return id
    }
  } catch {}
  return null
}

// Facebook: video urls with /videos/ID or watch/?v=ID or fb.watch/...
function parseFacebookUrl(urlStr) {
  try {
    const u = new URL(urlStr)
    if (u.hostname.includes('facebook.com') || u.hostname.includes('fb.watch')) {
      return urlStr // keep original URL for plugin
    }
  } catch {}
  return null
}

// Instagram: handle /p/ or /reel/ or /tv/
function parseInstagramUrl(urlStr) {
  try {
    const u = new URL(urlStr)
    if (u.hostname.includes('instagram.com')) {
      // we'll use instagram embed URL pattern
      return urlStr
    }
  } catch {}
  return null
}

// Google Drive share link -> ID
function parseDriveId(urlStr) {
  try {
    const u = new URL(urlStr)
    if (u.hostname === 'drive.google.com') {
      // formats: /file/d/ID/view or open?id=ID
      const parts = u.pathname.split('/')
      const idx = parts.indexOf('d')
      if (idx >= 0 && parts[idx + 1]) return parts[idx + 1]
      if (u.searchParams.get('id')) return u.searchParams.get('id')
    }
  } catch {}
  return null
}

// direct file (.mp4, .webm, .ogg)
function isDirectFile(urlStr) {
  return /\.(mp4|webm|ogg|m3u8)(\?.*)?$/i.test(urlStr)
}

/* ---------- detectVideo: return meta describing how to load ---------- */
function detectVideo(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return { type: 'unknown' }
  if (isNetflix(urlStr)) return { type: 'unsupported' }

  // try youtube
  const ytId = parseYouTubeId(urlStr)
  if (ytId) return { type: 'youtube', videoId: ytId, url: urlStr }

  // direct file
  if (isDirectFile(urlStr)) return { type: 'file', url: urlStr }

  // vimeo
  const vimeoId = parseVimeoId(urlStr)
  if (vimeoId) return { type: 'vimeo', videoId: vimeoId, url: urlStr }

  // google drive
  const driveId = parseDriveId(urlStr)
  if (driveId) return { type: 'drive', id: driveId, url: urlStr }

  // facebook
  const fb = parseFacebookUrl(urlStr)
  if (fb) return { type: 'facebook', url: urlStr }

  // instagram
  const ig = parseInstagramUrl(urlStr)
  if (ig) return { type: 'instagram', url: urlStr }

  // fall back to generic embed attempt
  return { type: 'embed', url: urlStr }
}

/* ---------- UI helpers: show/hide expected containers ---------- */
function setParticipants(count) { countEl.textContent = String(count) }
function showYouTube() {
  ytContainer.classList.remove('hidden')
  filePlayer.classList.add('hidden')
  removeEmbedFrame()
}
function showFile() {
  filePlayer.classList.remove('hidden')
  ytContainer.classList.add('hidden')
  removeEmbedFrame()
}
function showEmbed() {
  // hide specific players, create/inject iframe into playerContainer
  ytContainer.classList.add('hidden')
  filePlayer.classList.add('hidden')
  if (!embedFrame) {
    embedFrame = document.createElement('iframe')
    embedFrame.id = 'embedFrame'
    embedFrame.setAttribute('allowfullscreen', '')
    embedFrame.setAttribute('webkitallowfullscreen', '')
    embedFrame.setAttribute('playsinline', '')
    embedFrame.style.width = '100%'
    embedFrame.style.height = '100%'
    embedFrame.style.border = '0'
    playerContainer.appendChild(embedFrame)
  }
  embedFrame.classList.remove('hidden')
}
function removeEmbedFrame() {
  if (embedFrame) {
    try { embedFrame.remove() } catch {}
    embedFrame = null
  }
}

/* ---------- loaders for each type ---------- */

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
          if (state === YT.PlayerState.PLAYING) {
            const t = ytPlayer.getCurrentTime ? ytPlayer.getCurrentTime() : 0
            broadcast('play', { time: t })
          } else if (state === YT.PlayerState.PAUSED) {
            const t = ytPlayer.getCurrentTime ? ytPlayer.getCurrentTime() : 0
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
  try { filePlayer.currentTime = Math.max(0, time || 0) } catch {}
  if (autoplay) filePlayer.play().catch(() => {})
  else filePlayer.pause()
  setTimeout(() => { suppress = false }, 200)
}

// Vimeo embed
function loadVimeo(id) {
  const src = `https://player.vimeo.com/video/${encodeURIComponent(id)}`
  showEmbed()
  embedFrame.src = src
  // NOTE: Vimeo player API could be added to sync pause; for now use iframe and rely on viewer's controls.
}

// Google Drive preview embed
function loadDrive(id) {
  // public files: https://drive.google.com/file/d/ID/preview
  const src = `https://drive.google.com/file/d/${encodeURIComponent(id)}/preview`
  showEmbed()
  embedFrame.src = src
}

// Facebook plugin embed
function loadFacebook(url) {
  // Use Facebook video plugin wrapper
  // plugin URL: https://www.facebook.com/plugins/video.php?href={url}&show_text=0&width=560
  const src = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(url)}&show_text=0&width=560`
  showEmbed()
  embedFrame.src = src
}

// Instagram embed (attempt)
function loadInstagram(url) {
  // Instagram supports an embed path: https://www.instagram.com/p/{shortcode}/embed/ or /reel/{id}/embed
  // We'll attempt using /embed endpoint.
  // Convert to canonical embed URL if possible
  try {
    const u = new URL(url)
    // Ensure trailing slash
    let path = u.pathname
    if (!path.endsWith('/')) path += '/'
    const src = `https://www.instagram.com${path}embed/`
    showEmbed()
    embedFrame.src = src
  } catch {
    // fallback to direct url
    showEmbed()
    embedFrame.src = url
  }
}

// Generic embed attempt
function loadGenericEmbed(url) {
  showEmbed()
  embedFrame.src = url
}

/* ---------- Chat UI helpers (unchanged) ---------- */
function appendChatMessage({ senderId, text, ts }) {
  const el = document.createElement('div')
  el.className = 'chat-msg'
  const who = senderId === clientId ? 'You' : (senderId || 'Anon').slice(0,6)
  const time = new Date(ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  el.innerHTML = `<div><strong>${who}</strong> <span class="chat-meta">${time}</span></div><div>${escapeHtml(text)}</div>`
  chatMessages.appendChild(el)
  chatMessages.scrollTop = chatMessages.scrollHeight
}
function escapeHtml(s=''){ return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'":'&#39;'}[c])) }

/* ---------- Incoming events handler (modified to handle embed loads) ---------- */
function applyEvent(ev) {
  if (!ev) return
  if (ev.senderId && ev.senderId === clientId) return

  if (ev.type === 'presence') {
    setParticipants(ev.count || Number(countEl.textContent) || 1)
    if (ev.action === 'leave' && ev.clientId) removePeer(ev.clientId)
    return
  }
  if (ev.type === 'participants') { setParticipants(ev.count); return }

  if (ev.type === 'load' && ev.video) {
    // load accordingly
    const v = ev.video
    if (v.type === 'youtube' && v.videoId) {
      suppress = true
      loadYouTube(v.videoId, 0, false)
      setTimeout(() => { suppress = false }, 200)
    } else if (v.type === 'file' && v.url) {
      suppress = true
      loadFile(v.url, 0, false)
      setTimeout(() => { suppress = false }, 200)
    } else if (v.type === 'vimeo' && v.videoId) {
      suppress = true
      loadVimeo(v.videoId)
      setTimeout(() => { suppress = false }, 200)
    } else if (v.type === 'drive' && v.id) {
      suppress = true
      loadDrive(v.id)
      setTimeout(() => { suppress = false }, 200)
    } else if (v.type === 'facebook' && v.url) {
      suppress = true
      loadFacebook(v.url)
      setTimeout(() => { suppress = false }, 200)
    } else if (v.type === 'instagram' && v.url) {
      suppress = true
      loadInstagram(v.url)
      setTimeout(() => { suppress = false }, 200)
    } else if (v.type === 'embed' && v.url) {
      suppress = true
      loadGenericEmbed(v.url)
      setTimeout(() => { suppress = false }, 200)
    }
    return
  }

  if (ev.type === 'pause') {
    suppress = true
    if (!ytContainer.classList.contains('hidden') && ytPlayer && ytReady) {
      ytPlayer.pauseVideo()
    } else if (!filePlayer.classList.contains('hidden')) {
      filePlayer.pause()
    } else if (embedFrame) {
      // can't reliably pause cross-origin iframes; nothing we can do here
      // as a fallback, blur focus
      try { embedFrame.contentWindow.postMessage({ type: 'pause' }, '*') } catch {}
    }
    setTimeout(() => { suppress = false }, 150)
    return
  }

  if (ev.type === 'fullscreen') {
    if (ev.active) {
      if (!document.fullscreenElement) playerContainer.requestFullscreen().catch(() => {})
    } else {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    }
    return
  }

  // WebRTC signaling
  if (ev.type === 'rtc-offer' && ev.targetId === clientId) { handleOffer(ev.senderId, ev.sdp); return }
  if (ev.type === 'rtc-answer' && ev.targetId === clientId) { handleAnswer(ev.senderId, ev.sdp); return }
  if (ev.type === 'rtc-ice' && ev.targetId === clientId) { handleIce(ev.senderId, ev.candidate); return }

  if (ev.type === 'chat' && ev.text) {
    appendChatMessage({ senderId: ev.senderId, text: ev.text, ts: ev.ts })
    return
  }
}

/* ---------- broadcast helper (unchanged) ---------- */
function broadcast(type, payload = {}) {
  const ev = { type, senderId: clientId, ...payload }
  fetch(`/api/rooms/${encodeURIComponent(roomId)}/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ev),
  }).catch(() => {})
}

/* ---------- join / SSE (unchanged except additional load handling) ---------- */
async function joinRoom() {
  const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (res.status === 403 || res.status === 429) {
    alert('Room is full (max 6 participants)')
    window.location.href = '/'
    return
  }
  const data = await res.json()
  clientId = data.clientId
  setParticipants((data.room?.participants || []).length || 1)

  const video = data.room?.video
  if (video) {
    // server should pass the same structured video object (type + attrs)
    applyEvent({ type: 'load', video })
  }

  await setupLocalMedia()
  const others = (data.room?.participants || []).filter((id) => id !== clientId)
  for (const pid of others) ensurePeer(pid, true)
}

function startSSE() {
  es = new EventSource(`/api/rooms/${encodeURIComponent(roomId)}/events?clientId=${encodeURIComponent(clientId)}`)
  es.onmessage = (msg) => {
    try { const ev = JSON.parse(msg.data); if (ev && ev.type) applyEvent(ev) } catch {}
  }
}

/* ---------- Local event listeners (pause handler kept; file pause already) ---------- */
filePlayer.addEventListener('play', () => { if (!suppress) broadcast('play', { time: filePlayer.currentTime }) })
filePlayer.addEventListener('pause', () => { if (!suppress) broadcast('pause', { time: filePlayer.currentTime }) })

fsSyncBtn.addEventListener('click', async () => {
  const goingFull = !document.fullscreenElement
  try {
    if (goingFull) await playerContainer.requestFullscreen()
    else await document.exitFullscreen()
  } catch {}
  broadcast('fullscreen', { active: goingFull })
})

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(shareLinkEl.value)
    copyBtn.textContent = 'Copied'
    setTimeout(() => (copyBtn.textContent = 'Copy'), 1200)
  } catch {}
})

/* ---------- Main load button: detect video and broadcast structured payload ---------- */
loadBtn.addEventListener('click', () => {
  const v = (videoUrlInput.value || '').trim()
  if (!v) return
  const meta = detectVideo(v)
  if (meta.type === 'unsupported') { alert('This site cannot be embedded (Netflix and other DRM platforms).'); return }
  if (meta.type === 'unknown') { alert('Could not recognise the link. Try a direct .mp4/.webm/.ogg URL, YouTube, Vimeo, Facebook/Instagram public video, or a public Google Drive share link.'); return }

  let videoPayload = null
  if (meta.type === 'youtube') {
    videoPayload = { type: 'youtube', url: meta.url, videoId: meta.videoId }
    suppress = true; loadYouTube(meta.videoId, 0, false); setTimeout(() => { suppress = false }, 200)
  } else if (meta.type === 'file') {
    videoPayload = { type: 'file', url: meta.url }
    suppress = true; loadFile(meta.url, 0, false); setTimeout(() => { suppress = false }, 200)
  } else if (meta.type === 'vimeo') {
    videoPayload = { type: 'vimeo', url: meta.url, videoId: meta.videoId }
    suppress = true; loadVimeo(meta.videoId); setTimeout(() => { suppress = false }, 200)
  } else if (meta.type === 'drive') {
    videoPayload = { type: 'drive', url: meta.url, id: meta.id }
    suppress = true; loadDrive(meta.id); setTimeout(() => { suppress = false }, 200)
  } else if (meta.type === 'facebook') {
    videoPayload = { type: 'facebook', url: meta.url }
    suppress = true; loadFacebook(meta.url); setTimeout(() => { suppress = false }, 200)
  } else if (meta.type === 'instagram') {
    videoPayload = { type: 'instagram', url: meta.url }
    suppress = true; loadInstagram(meta.url); setTimeout(() => { suppress = false }, 200)
  } else if (meta.type === 'embed') {
    videoPayload = { type: 'embed', url: meta.url }
    suppress = true; loadGenericEmbed(meta.url); setTimeout(() => { suppress = false }, 200)
  }

  broadcast('load', { video: videoPayload, time: 0, autoplay: false })
})

/* ---------- Chat (unchanged) ---------- */
function sendChat() {
  const text = (chatInput.value || '').trim()
  if (!text) return
  chatInput.value = ''
  const ts = Date.now()
  appendChatMessage({ senderId: clientId, text, ts })
  broadcast('chat', { text, ts })
}
chatSend.addEventListener('click', sendChat)
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat() })

/* ---------- WebRTC (unchanged) ---------- */
async function setupLocalMedia() {
  if (localStream) return
  try { localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }) }
  catch {
    try { localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }) }
    catch { localStream = null }
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
    v.autoplay = true; v.muted = true; v.playsInline = true; v.id = `video-${clientId}`
    tile.appendChild(v)
    const label = document.createElement('div')
    label.className = 'peer-label'; label.textContent = 'You'
    tile.appendChild(label)
    peersGrid.prepend(tile)
  }
  const v = document.getElementById(`video-${clientId}`)
  if (v && localStream) v.srcObject = localStream
}
function ensurePeer(peerId, initiateOffer) {
  if (peerId === clientId) return
  if (peers.has(peerId)) return peers.get(peerId)
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
  if (localStream) for (const t of localStream.getTracks()) pc.addTrack(t, localStream)
  pc.onicecandidate = (e) => { if (e.candidate) broadcast('rtc-ice', { targetId: peerId, candidate: e.candidate }) }
  pc.ontrack = (e) => {
    let tile = document.getElementById(`peer-${peerId}`)
    if (!tile) {
      tile = document.createElement('div')
      tile.className = 'peer-tile'; tile.id = `peer-${peerId}`
      const v = document.createElement('video')
      v.autoplay = true; v.playsInline = true; v.id = `video-${peerId}`
      tile.appendChild(v)
      const label = document.createElement('div')
      label.className = 'peer-label'; label.textContent = peerId.slice(0,6)
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
  const tile = document.getElementById(`peer-${peerId}`); if (tile) tile.remove()
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
  const entry = peers.get(fromId); if (!entry) return
  await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp)).catch(() => {})
}
async function handleIce(fromId, candidate) {
  const entry = peers.get(fromId); if (!entry) return
  try { await entry.pc.addIceCandidate(new RTCIceCandidate(candidate)) } catch {}
}

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

/* ---------- Init ---------- */
;(async function init() {
  if (!roomId) { alert('Missing room ID'); window.location.href = '/'; return }
  roomIdLabel.textContent = roomId
  shareLinkEl.value = `${window.location.origin}/room.html?id=${encodeURIComponent(roomId)}`
  await joinRoom()
  startSSE()
})()
