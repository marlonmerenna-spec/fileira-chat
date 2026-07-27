const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---- Estado em memória (protótipo: sem banco de dados) ----

const PUBLIC_ROOMS = [
  { id: 'geral', name: 'Geral', topic: 'Papo livre, chegou chegou' },
  { id: 'games', name: 'Games', topic: 'Falando de jogos' },
  { id: 'musica', name: 'Música', topic: 'Toca aí' },
  { id: 'desabafo', name: 'Desabafo', topic: 'Um espaço pra conversar' },
];

// rooms[roomId] = { name, isPrivate, code, users: { socketId: {name, avatarUrl} }, history: [] }
const rooms = {};
PUBLIC_ROOMS.forEach(r => {
  rooms[r.id] = { name: r.name, topic: r.topic, isPrivate: false, users: {}, history: [] };
});

function roomSummary(roomId) {
  const r = rooms[roomId];
  if (!r) return null;
  return {
    id: roomId,
    name: r.name,
    topic: r.topic || '',
    isPrivate: r.isPrivate,
    userCount: Object.keys(r.users).length,
  };
}

function publicRoomList() {
  return Object.keys(rooms)
    .filter(id => !rooms[id].isPrivate)
    .map(roomSummary);
}

function usersInRoom(roomId) {
  const r = rooms[roomId];
  if (!r) return [];
  return Object.entries(r.users).map(([socketId, u]) => ({
    id: socketId,
    name: u.name,
    avatarUrl: u.avatarUrl,
  }));
}

function genCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

io.on('connection', (socket) => {
  socket.data.profile = null;
  socket.data.roomId = null;

  socket.on('set_profile', ({ name, avatarUrl }) => {
    socket.data.profile = {
      name: (name || 'Visitante').slice(0, 24),
      avatarUrl: avatarUrl || null,
    };
    socket.emit('profile_ack', socket.data.profile);
  });

  socket.on('get_rooms', () => {
    socket.emit('room_list', publicRoomList());
  });

  socket.on('create_private_room', ({ name }) => {
    const code = genCode();
    const roomId = 'p_' + code;
    rooms[roomId] = {
      name: (name || 'Sala privada').slice(0, 40),
      isPrivate: true,
      users: {},
      history: [],
    };
    socket.emit('private_room_created', { roomId, code, name: rooms[roomId].name });
  });

  socket.on('join_room', ({ roomId }) => {
    if (!rooms[roomId] || !socket.data.profile) {
      socket.emit('join_error', 'Sala não encontrada ou perfil não definido.');
      return;
    }
    // sai da sala anterior, se houver
    if (socket.data.roomId && rooms[socket.data.roomId]) {
      leaveCurrentRoom(socket);
    }

    socket.join(roomId);
    socket.data.roomId = roomId;
    rooms[roomId].users[socket.id] = socket.data.profile;

    socket.emit('room_joined', {
      room: roomSummary(roomId),
      users: usersInRoom(roomId),
      history: rooms[roomId].history,
    });

    socket.to(roomId).emit('user_joined', {
      id: socket.id,
      name: socket.data.profile.name,
      avatarUrl: socket.data.profile.avatarUrl,
    });
    io.to(roomId).emit('user_list', usersInRoom(roomId));
    io.emit('room_list', publicRoomList());
  });

  socket.on('send_message', ({ text }) => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId] || !text || !text.trim()) return;
    const msg = {
      id: Date.now() + '_' + socket.id,
      userId: socket.id,
      name: socket.data.profile.name,
      avatarUrl: socket.data.profile.avatarUrl,
      text: text.slice(0, 500),
      ts: Date.now(),
    };
    rooms[roomId].history.push(msg);
    if (rooms[roomId].history.length > 100) rooms[roomId].history.shift();
    io.to(roomId).emit('chat_message', msg);
  });

  socket.on('typing', (isTyping) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit('user_typing', { id: socket.id, isTyping: !!isTyping });
  });

  socket.on('leave_room', () => {
    leaveCurrentRoom(socket);
  });

  socket.on('disconnect', () => {
    leaveCurrentRoom(socket);
  });

  function leaveCurrentRoom(socket) {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;
    delete rooms[roomId].users[socket.id];
    socket.leave(roomId);
    socket.to(roomId).emit('user_left', { id: socket.id });
    io.to(roomId).emit('user_list', usersInRoom(roomId));
    socket.data.roomId = null;
    // limpa salas privadas vazias
    if (rooms[roomId].isPrivate && Object.keys(rooms[roomId].users).length === 0) {
      delete rooms[roomId];
    }
    io.emit('room_list', publicRoomList());
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  console.log(`\nServidor rodando!`);
  console.log(`  Local:  http://localhost:${PORT}`);
  Object.values(nets).flat().forEach((net) => {
    if (net.family === 'IPv4' && !net.internal) {
      console.log(`  Rede:   http://${net.address}:${PORT}  <-- use este endereço no celular`);
    }
  });
  console.log('');
});
