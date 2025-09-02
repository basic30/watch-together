const http = require('node:http')
const url = require('node:url')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const PORT = process.env.PORT || 3000

// Rooms: in-memory
// room = {
//   id,
//   video: { type: 'youtube'|'file', url, videoId? } | null,
//   state: { isPlaying: boolean, currentTime: number, updatedAt: number }, // currentTime in seconds, updatedAt ms
//   participants: Set<clientId>,
//   clients: Set<ServerResponse>,
//   createdAt: number,
// }
const rooms = new Map()

function generateId() {
  return crypto.randomBytes(3).toString('hex')
}
function nowMs() { return Date.now() }

function getOrCreateRoom(id) {
  if (!rooms.has(id)) {
    rooms.set(id, {
      id,
      video: null,
      state: { isPlaying: false, currentTime: 0, updatedAt: nowMs() },
      participants: new Set(),
      clients: new Set(),
      createdAt: nowMs(),
    })
  }
  return rooms.get(id)
}

function computeCurrentTime(room) {
  const { isPlaying, currentTime, updatedAt } = room.state
  if (!isPlaying) return currentTime
  const elapsed = (nowMs() - updatedAt) / 1000
  return Math.max(0, currentTime + elapsed)
}

function sendSSE(res, event) {
  try { res.write(`data: ${JSON.stringify(event)}\n\n`) } catch {}
}

function broadcast(room, event) {
  for (const res of room.clients) sendSSE(res, event)
}

function parseBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1e6) req.destroy()
    })
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}) } catch { resolve({}) }
    })
  })
}

function respondJSON(res, status, data) {
  const payload = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function serveStatic(req, res) {
  const parsed = url.parse(req.url)
  let pathname = parsed.pathname
  if (pathname === '/') pathname = '/index.html'
  const filePath = path.join(__dirname, 'public', pathname)
  const publicRoot = path.join(__dirname, 'public')
  if (!filePath.startsWith(publicRoot)) {
    res.writeHead(403); return res.end('Forbidden')
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); return res.end('Not Found') }
    const ext = path.extname(filePath).toLowerCase()
    const mime =
      ext === '.html' ? 'text/html; charset=utf-8' :
      ext === '.css' ? 'text/css; charset=utf-8' :
      ext === '.js' ? 'application/javascript; charset=utf-8' :
      ext === '.svg' ? 'image/svg+xml' :
      ext === '.png' ? 'image/png' :
      ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
      'application/octet-stream'
    res.writeHead(200, { 'Content-Type': mime })
    fs.createReadStream(filePath).pipe(res)
  })
}

function cleanupRoomIfEmpty(room) {
  if (room.clients.size === 0 && room.participants.size === 0) {
    setTimeout(() => {
      if (room.clients.size === 0 && room.participants.size === 0) {
        rooms.delete(room.id)
      }
    }, 60_000)
  }
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true)
  const { pathname, query } = parsed

  // Create room
  if (pathname === '/api/rooms/create' && req.method === 'POST') {
    const id = generateId()
    const room = getOrCreateRoom(id)
    respondJSON(res, 200, {
      id,
      joinUrl: `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}/room.html?id=${id}`,
    })
    return
  }

  // Join room (reserves a seat and returns full state + participants list)
  if (pathname.startsWith('/api/rooms/') && pathname.endsWith('/join') && req.method === 'POST') {
    const id = pathname.split('/')[3]
    const room = getOrCreateRoom(id)
    if (room.participants.size >= 4) {
      return respondJSON(res, 403, { error: 'Room is full (max 4 participants)' })
    }
    const body = await parseBody(req)
    const clientId = body?.clientId || crypto.randomUUID()
    room.participants.add(clientId)

    // Notify others about presence
    broadcast(room, { type: 'presence', action: 'join', clientId, count: room.participants.size })

    respondJSON(res, 200, {
      ok: true,
      clientId,
      room: {
        id: room.id,
        video: room.video,
        state: {
          isPlaying: room.state.isPlaying,
          // computed current time for late joiners
          currentTime: computeCurrentTime(room),
        },
        participants: Array.from(room.participants),
      },
    })
    return
  }

  // SSE events (subscribe)
  if (pathname.startsWith('/api/rooms/') && pathname.endsWith('/events') && req.method === 'GET') {
    const id = pathname.split('/')[3]
    const room = getOrCreateRoom(id)
    const clientId = query.clientId || crypto.randomUUID()

    // connection headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    })

    room.clients.add(res)

    // initial hello
    sendSSE(res, {
      type: 'hello',
      clientId,
      participants: room.participants.size,
      timestamp: nowMs(),
    })

    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n') } catch {}
    }, 15000)

    req.on('close', () => {
      clearInterval(heartbeat)
      room.clients.delete(res)
      if (room.participants.has(clientId)) {
        room.participants.delete(clientId)
        broadcast(room, { type: 'presence', action: 'leave', clientId, count: room.participants.size })
      }
      cleanupRoomIfEmpty(room)
    })
    return
  }

  // Broadcast (video control + signaling relay)
  if (pathname.startsWith('/api/rooms/') && pathname.endsWith('/broadcast') && req.method === 'POST') {
    const id = pathname.split('/')[3]
    const room = getOrCreateRoom(id)
    const body = await parseBody(req)
    const event = body || {}

    // Update room playback state for late joiners
    if (event.type === 'load' && event.video) {
      room.video = event.video
      room.state.currentTime = typeof event.time === 'number' ? event.time : 0
      room.state.isPlaying = !!event.autoplay
      room.state.updatedAt = nowMs()
    } else if (event.type === 'play' && typeof event.time === 'number') {
      room.state.isPlaying = true
      room.state.currentTime = event.time
      room.state.updatedAt = nowMs()
    } else if (event.type === 'pause' && typeof event.time === 'number') {
      room.state.isPlaying = false
      room.state.currentTime = event.time
      room.state.updatedAt = nowMs()
    } else if (event.type === 'seek' && typeof event.time === 'number') {
      room.state.currentTime = event.time
      room.state.updatedAt = nowMs()
    }
    // Signaling events (rtc-offer/rtc-answer/rtc-ice/presence/fullscreen) are just relayed

    broadcast(room, event)
    respondJSON(res, 200, { ok: true })
    return
  }

  // Room info
  if (pathname.startsWith('/api/rooms/') && pathname.endsWith('/info') && req.method === 'GET') {
    const id = pathname.split('/')[3]
    const room = getOrCreateRoom(id)
    respondJSON(res, 200, {
      id: room.id,
      video: room.video,
      state: {
        isPlaying: room.state.isPlaying,
        currentTime: computeCurrentTime(room),
      },
      participants: Array.from(room.participants),
    })
    return
  }

  // Static files
  serveStatic(req, res)
})

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})
