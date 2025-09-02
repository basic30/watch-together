// server.js
// Minimal Node server (no dependencies) serving static files + SSE relay + WebRTC signaling.
// Run locally: node server.js  → http://localhost:3000

const http = require('node:http')
const url = require('node:url')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const PORT = process.env.PORT || 3000

// Rooms in memory
// room = { id, video: { type, url, videoId? } | null, participants: Set<clientId>, clients: Set<res>, createdAt }
const rooms = new Map()

function getOrCreateRoom(id) {
  if (!rooms.has(id)) {
    rooms.set(id, {
      id,
      video: null,
      participants: new Set(),
      clients: new Set(),
      createdAt: Date.now(),
    })
  }
  return rooms.get(id)
}

function generateId() {
  return crypto.randomBytes(3).toString('hex')
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
    req.on('data', (c) => {
      data += c
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
    if (err || !stat.isFile()) {
      res.writeHead(404); return res.end('Not Found')
    }
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
    getOrCreateRoom(id)
    return respondJSON(res, 200, {
      id,
      joinUrl: `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}/room.html?id=${id}`,
    })
  }

  // Join room (reserve seat, return current room state)
  if (pathname.startsWith('/api/rooms/') && pathname.endsWith('/join') && req.method === 'POST') {
    const id = pathname.split('/')[3]
    const room = getOrCreateRoom(id)
    if (room.participants.size >= 6) {
      return respondJSON(res, 403, { error: 'Room is full (max 6 participants)' })
    }
    const body = await parseBody(req)
    const clientId = body?.clientId || crypto.randomUUID()
    room.participants.add(clientId)
    broadcast(room, { type: 'presence', action: 'join', clientId, count: room.participants.size })
    return respondJSON(res, 200, {
      ok: true,
      clientId,
      room: {
        id: room.id,
        video: room.video,                 // late joiners load same URL (no autoplay)
        participants: Array.from(room.participants),
      },
    })
  }

  // SSE subscribe
  if (pathname.startsWith('/api/rooms/') && pathname.endsWith('/events') && req.method === 'GET') {
    const id = pathname.split('/')[3]
    const room = getOrCreateRoom(id)
    const clientId = query.clientId || crypto.randomUUID()
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    })
    room.clients.add(res)
    sendSSE(res, { type: 'hello', clientId, participants: room.participants.size })

    const hb = setInterval(() => {
      try { res.write(': ping\n\n') } catch {}
    }, 15000)

    req.on('close', () => {
      clearInterval(hb)
      room.clients.delete(res)
      if (room.participants.has(clientId)) {
        room.participants.delete(clientId)
        broadcast(room, { type: 'presence', action: 'leave', clientId, count: room.participants.size })
      }
      cleanupRoomIfEmpty(room)
    })
    return
  }

  // Broadcast event (load, pause, fullscreen, chat, and WebRTC signaling)
  if (pathname.startsWith('/api/rooms/') && pathname.endsWith('/broadcast') && req.method === 'POST') {
    const id = pathname.split('/')[3]
    const room = getOrCreateRoom(id)
    const event = await parseBody(req)

    // Persist video URL on load so late joiners see it
    if (event?.type === 'load' && event.video) {
      room.video = event.video
    }
    broadcast(room, event || {})
    return respondJSON(res, 200, { ok: true })
  }

  // Room info
  if (pathname.startsWith('/api/rooms/') && pathname.endsWith('/info') && req.method === 'GET') {
    const id = pathname.split('/')[3]
    const room = getOrCreateRoom(id)
    return respondJSON(res, 200, {
      id: room.id,
      video: room.video,
      participants: Array.from(room.participants),
    })
  }

  // Static
  serveStatic(req, res)
})

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})

