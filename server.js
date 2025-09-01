// server.js
// Node.js + Express + Socket.io signaling for 2-user rooms
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(__dirname + '/public'));

const rooms = {};          // roomId -> { users: [socketIdA, socketIdB] }

io.on('connection', socket => {
  console.log('Client connected:', socket.id);

  // Join or create a room (max 2 users)
  socket.on('join-room', () => {
    let roomId = null;
    // Find an available room
    for (const id of Object.keys(rooms)) {
      if (rooms[id].users.length === 1) {
        roomId = id;
        break;
      }
    }
    // Else create new
    if (!roomId) {
      roomId = Math.random().toString(36).substring(2, 9);
      rooms[roomId] = { users: [] };
    }

    socket.join(roomId);
    rooms[roomId].users.push(socket.id);
    socket.roomId = roomId;

    io.to(socket.id).emit('joined', { roomId, users: rooms[roomId].users.length });

    // If room now has 2 people, notify both
    if (rooms[roomId].users.length === 2) {
      io.to(roomId).emit('ready');
    }
  });

  // WebRTC signaling
  socket.on('offer',  data => socket.to(socket.roomId).emit('offer',  data));
  socket.on('answer', data => socket.to(socket.roomId).emit('answer', data));
  socket.on('ice',    data => socket.to(socket.roomId).emit('ice',    data));

  // Clean-up on disconnect
  socket.on('disconnect', () => {
    const room = rooms[socket.roomId];
    if (room) {
      room.users = room.users.filter(id => id !== socket.id);
      if (room.users.length === 0) delete rooms[socket.roomId];
      else socket.to(socket.roomId).emit('peer-disconnected');
    }
  });
});

server.listen(PORT, () => console.log(`Signaling server listening on :${PORT}`));
