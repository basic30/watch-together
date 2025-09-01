// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname + '/public'));
const rooms = {};          // roomId -> { users: [socketIdA, socketIdB] }

io.on('connection', socket => {
  console.log('Client connected:', socket.id);

  /* NEW: create room */
  socket.on('create-room', () => {
    const code = Math.floor(1000 + Math.random() * 9000).toString(); // 4-digit
    rooms[code] = { users: [] };
    socket.join(code);
    rooms[code].users.push(socket.id);
    socket.roomId = code;
    socket.emit('created', code);
  });

  /* NEW: join room by code */
  socket.on('join-room-code', code => {
    const room = rooms[code];
    if (!room || room.users.length >= 2) {
      socket.emit('invalid-code');
      return;
    }
    socket.join(code);
    room.users.push(socket.id);
    socket.roomId = code;
    socket.emit('joined', { roomId: code, users: room.users.length });
    if (room.users.length === 2) io.to(code).emit('ready');
  });

  /* WebRTC signaling (unchanged) */
  socket.on('offer',  data => socket.to(socket.roomId).emit('offer',  data));
  socket.on('answer', data => socket.to(socket.roomId).emit('answer', data));
  socket.on('ice',    data => socket.to(socket.roomId).emit('ice',    data));

  /* disconnect */
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
