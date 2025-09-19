const express = require('express');
const app = express();
const path = require('path');
const http = require('http');
const socketio = require('socket.io');

const server = http.createServer(app);
const io = socketio(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));

let connectedUsers = new Map();
let busUser = null;

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);
  connectedUsers.set(socket.id, {
    id: socket.id,
    isBus: false,
    location: null
  });

  socket.emit('users-list', {
    users: Array.from(connectedUsers.values()),
    currentBus: busUser
  });

  socket.on('send-location', (data) => {
    const user = connectedUsers.get(socket.id);
    if (user) {
      user.location = data;
      connectedUsers.set(socket.id, user);
    }
    io.emit('receive-location', {
      id: socket.id,
      isBus: user?.isBus || false,
      ...data
    });
  });

  socket.on('set-as-bus', () => {
    if (busUser && connectedUsers.has(busUser.id)) {
      const prevBus = connectedUsers.get(busUser.id);
      prevBus.isBus = false;
      connectedUsers.set(busUser.id, prevBus);
      io.to(busUser.id).emit('bus-status-changed', { isBus: false });
    }
    const user = connectedUsers.get(socket.id);
    if (user) {
      user.isBus = true;
      connectedUsers.set(socket.id, user);
      busUser = { id: socket.id, ...user };
      socket.emit('bus-status-changed', { isBus: true });
      io.emit('bus-user-changed', { busUserId: socket.id, busUser });
    }
  });

  socket.on('remove-bus', () => {
    if (busUser && busUser.id === socket.id) {
      const user = connectedUsers.get(socket.id);
      if (user) {
        user.isBus = false;
        connectedUsers.set(socket.id, user);
      }
      busUser = null;
      io.emit('bus-user-changed', { busUserId: null, busUser: null });
      socket.emit('bus-status-changed', { isBus: false });
    }
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    if (busUser && busUser.id === socket.id) {
      busUser = null;
      io.emit('bus-user-changed', { busUserId: null, busUser: null });
    }
    connectedUsers.delete(socket.id);
    io.emit('user-disconnected', socket.id);
  });
});

app.get('/', (req, res) => {
  res.render('index');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
