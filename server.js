// server.js
const express = require('express');
const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')(server);

app.use(express.static(__dirname));

io.on('connection', (socket) => {
  socket.on('join', (room) => {
    socket.room = room;
    socket.join(room);
    const clients = io.sockets.adapter.rooms.get(room)?.size || 0;
    if (clients > 2) {
      socket.emit('full');
      return;
    }
    if (clients === 2) {
      socket.to(room).emit('ready');
    }
  });

  socket.on('offer', (offer) => {
    if (socket.room) {
      socket.to(socket.room).emit('offer', offer);
    }
  });

  socket.on('answer', (answer) => {
    if (socket.room) {
      socket.to(socket.room).emit('answer', answer);
    }
  });

  socket.on('candidate', (candidate) => {
    if (socket.room) {
      socket.to(socket.room).emit('candidate', candidate);
    }
  });

  socket.on('disconnect', () => {
    if (socket.room) {
      socket.to(socket.room).emit('bye');
    }
  });
});

server.listen(3000, () => {
  console.log('Signaling server running on port 3000');
});
