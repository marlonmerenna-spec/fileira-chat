const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 20 * 1024 * 1024, // permite fotos e vídeos curtos gravados na hora
});

app.use(express.static(path.join(__dirname, 'public')));

// ---- Login com Facebook (OAuth) ----
// Exige duas variáveis de ambiente configuradas no Render: FACEBOOK_APP_ID e FACEBOOK_APP_SECRET.
// Sem elas, o botão mostra uma mensagem explicando o que falta, em vez de quebrar.
const FB_APP_ID = process.env.FACEBOOK_APP_ID;
const FB_APP_SECRET = process.env.FACEBOOK_APP_SECRET;

app.get('/auth/facebook', (req, res) => {
  if (!FB_APP_ID || !FB_APP_SECRET) {
    return res.status(500).send(
      'Login com Facebook ainda não configurado neste servidor. ' +
      'É preciso criar um app gratuito em developers.facebook.com e definir as variáveis ' +
      'FACEBOOK_APP_ID e FACEBOOK_APP_SECRET nas configurações do Render. ' +
      '<a href="/">Voltar</a>'
    );
  }
  const redirectUri = `${req.protocol}://${req.get('host')}/auth/facebook/callback`;
  const authUrl = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${FB_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=public_profile,email&response_type=code`;
  res.redirect(authUrl);
});

app.get('/auth/facebook/callback', async (req, res) => {
  try {
    const { code, error: fbError } = req.query;
    if (fbError || !code) throw new Error('Login cancelado ou não autorizado.');
    const redirectUri = `${req.protocol}://${req.get('host')}/auth/facebook/callback`;

    const tokenRes = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${FB_APP_ID}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${FB_APP_SECRET}&code=${code}`
    );
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('Não recebi o token de acesso do Facebook.');

    const profileRes = await fetch(
      `https://graph.facebook.com/me?fields=id,name,picture.type(large)&access_token=${tokenData.access_token}`
    );
    const profile = await profileRes.json();

    const name = encodeURIComponent(profile.name || '');
    const photo = encodeURIComponent(profile.picture && profile.picture.data ? profile.picture.data.url : '');
    res.redirect(`/?fb_name=${name}&fb_photo=${photo}`);
  } catch (err) {
    console.error('Erro no login com Facebook:', err.message);
    res.redirect('/?fb_error=1');
  }
});

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
    avatarType: u.avatarType,
    avatarConfig: u.avatarConfig,
  }));
}

function genCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

// ---- Contas (login/cadastro) — em memória, some se o servidor reiniciar ----
const accounts = new Map(); // username (minúsculo) -> { username, passwordHash, salt, profile }

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function normalizeUsername(u) {
  return (u || '').trim().toLowerCase();
}

// ---- Marketplace (em memória) ----
const listings = [];
function serializeListing(l) {
  return {
    id: l.id, sellerId: l.sellerId, sellerName: l.sellerName,
    title: l.title, price: l.price, description: l.description, image: l.image, ts: l.ts,
  };
}

// ---- Business (em memória) — divulgação de trabalho/serviço ----
const bizPosts = [];
function serializeBizPost(b) {
  return {
    id: b.id, authorId: b.authorId, authorName: b.authorName,
    businessName: b.businessName, category: b.category, description: b.description,
    contact: b.contact, image: b.image, ts: b.ts,
  };
}

// ---- Seguidores/Seguindo (em memória, por socket.id — some ao desconectar) ----
const followers = new Map(); // targetId -> Set(followerId)
const following = new Map(); // followerId -> Set(targetId)
function ensureSet(map, key) {
  if (!map.has(key)) map.set(key, new Set());
  return map.get(key);
}
function followCounts(userId) {
  return {
    followers: followers.has(userId) ? followers.get(userId).size : 0,
    following: following.has(userId) ? following.get(userId).size : 0,
  };
}

// ---- Usuários online e status (tipo MSN) ----
const onlineUsers = new Map(); // socketId -> { name, avatarUrl, status }

function broadcastOnlineUsers() {
  const list = Array.from(onlineUsers.entries()).map(([id, u]) => ({
    id, name: u.name, avatarUrl: u.avatarUrl, avatarType: u.avatarType, avatarConfig: u.avatarConfig,
    photoUrl: u.photoUrl, city: u.city, work: u.work, theme: u.theme, profileSongUrl: u.profileSongUrl, status: u.status,
    relationship: u.relationship, birthday: u.birthday, bio: u.bio, hometown: u.hometown, website: u.website, hobbies: u.hobbies,
  }));
  io.emit('online_users', list);
}

// ---- Mensagens privadas (em memória) ----
const dmThreads = {}; // "idA_idB" (ordenado) -> [{ id, fromId, text, ts }]
function threadKey(a, b) {
  return [a, b].sort().join('_');
}
const posts = []; // { id, authorId, name, avatarUrl, text, image, likes: Set<socketId>, ts }

function serializePost(p) {
  return {
    id: p.id,
    authorId: p.authorId,
    name: p.name,
    avatarUrl: p.avatarUrl,
    avatarType: p.avatarType,
    avatarConfig: p.avatarConfig,
    text: p.text,
    image: p.image,
    videoUrl: p.videoUrl || null,
    ts: p.ts,
    likeCount: p.likes.size,
    likedBy: Array.from(p.likes),
    comments: p.comments || [],
    sharedFrom: p.sharedFrom || null, // { name } de quem fez o post original, se for um compartilhamento
  };
}

io.on('connection', (socket) => {
  socket.data.profile = null;
  socket.data.roomId = null;

  socket.on('signup', ({ username, password }) => {
    const uname = normalizeUsername(username);
    if (!uname || !password || password.length < 4) {
      socket.emit('auth_error', 'Preencha um usuário e uma senha com pelo menos 4 caracteres.');
      return;
    }
    if (accounts.has(uname)) {
      socket.emit('auth_error', 'Esse nome de usuário já está em uso.');
      return;
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const account = {
      username: uname,
      passwordHash: hashPassword(password, salt),
      salt,
      profile: null, // preenchido quando a pessoa terminar de montar o perfil
    };
    accounts.set(uname, account);
    socket.data.username = uname;
    socket.emit('auth_success', { isNewUser: true, profile: null });
  });

  socket.on('login', ({ username, password }) => {
    const uname = normalizeUsername(username);
    const account = accounts.get(uname);
    if (!account || hashPassword(password, account.salt) !== account.passwordHash) {
      socket.emit('auth_error', 'Usuário ou senha incorretos.');
      return;
    }
    socket.data.username = uname;
    if (account.profile) {
      socket.data.profile = { ...account.profile, status: 'disponivel' };
      onlineUsers.set(socket.id, socket.data.profile);
      broadcastOnlineUsers();
    }
    socket.emit('auth_success', { isNewUser: !account.profile, profile: account.profile });
  });

  socket.on('set_profile', ({ name, avatarUrl, avatarType, avatarConfig, photoUrl, city, work, theme, profileSongUrl, relationship, birthday, bio, hometown, website, hobbies }) => {
    const previousStatus = socket.data.profile ? socket.data.profile.status : null;
    socket.data.profile = {
      name: (name || 'Visitante').slice(0, 24),
      avatarUrl: avatarUrl || null,
      avatarType: avatarType || null,
      avatarConfig: avatarConfig || null,
      photoUrl: photoUrl || null,
      city: (city || '').slice(0, 60),
      work: (work || '').slice(0, 60),
      theme: (theme || 'nebulosa').slice(0, 20),
      profileSongUrl: (profileSongUrl || '').trim().slice(0, 500),
      relationship: (relationship || '').slice(0, 40),
      birthday: (birthday || '').slice(0, 20),
      bio: (bio || '').slice(0, 300),
      hometown: (hometown || '').slice(0, 60),
      website: (website || '').trim().slice(0, 200),
      hobbies: (hobbies || '').slice(0, 200),
      status: previousStatus || 'disponivel', // não reseta o humor toda vez que o perfil é salvo
    };
    onlineUsers.set(socket.id, socket.data.profile);
    if (socket.data.username && accounts.has(socket.data.username)) {
      accounts.get(socket.data.username).profile = socket.data.profile;
    }
    socket.emit('profile_ack', socket.data.profile);
    broadcastOnlineUsers();
  });

  socket.on('set_status', ({ status }) => {
    if (!socket.data.profile) return;
    socket.data.profile.status = status || 'disponivel';
    onlineUsers.set(socket.id, socket.data.profile);
    broadcastOnlineUsers();
  });

  socket.on('get_online_users', () => {
    broadcastOnlineUsers();
  });

  socket.on('follow_user', ({ targetId }) => {
    if (!targetId || targetId === socket.id) return;
    ensureSet(followers, targetId).add(socket.id);
    ensureSet(following, socket.id).add(targetId);
    io.to(targetId).emit('follow_changed', { userId: targetId, ...followCounts(targetId) });
    io.to(socket.id).emit('follow_changed', { userId: socket.id, ...followCounts(socket.id) });
  });

  socket.on('unfollow_user', ({ targetId }) => {
    if (!targetId) return;
    if (followers.has(targetId)) followers.get(targetId).delete(socket.id);
    if (following.has(socket.id)) following.get(socket.id).delete(targetId);
    io.to(targetId).emit('follow_changed', { userId: targetId, ...followCounts(targetId) });
    io.to(socket.id).emit('follow_changed', { userId: socket.id, ...followCounts(socket.id) });
  });

  socket.on('get_follow_info', ({ userId }) => {
    const target = userId || socket.id;
    const iFollow = following.has(socket.id) && following.get(socket.id).has(target);
    socket.emit('follow_info', { userId: target, ...followCounts(target), iFollow });
  });

  socket.on('get_follow_list', ({ userId, type }) => {
    const target = userId || socket.id;
    const idSet = type === 'followers'
      ? (followers.get(target) || new Set())
      : (following.get(target) || new Set());
    const list = Array.from(idSet).map((id) => {
      const u = onlineUsers.get(id);
      return u ? { id, name: u.name, avatarUrl: u.avatarUrl, avatarType: u.avatarType, avatarConfig: u.avatarConfig } : null;
    }).filter(Boolean);
    socket.emit('follow_list', { userId: target, type, list });
  });

  socket.on('dm_send', ({ toId, text }) => {
    if (!socket.data.profile || !text || !text.trim()) return;
    const msg = {
      id: Date.now() + '_' + socket.id,
      fromId: socket.id,
      fromName: socket.data.profile.name,
      text: text.slice(0, 1000),
      ts: Date.now(),
    };
    const key = threadKey(socket.id, toId);
    if (!dmThreads[key]) dmThreads[key] = [];
    dmThreads[key].push(msg);
    if (dmThreads[key].length > 200) dmThreads[key].shift();
    io.to(toId).emit('dm_message', { withId: socket.id, message: msg });
    io.to(socket.id).emit('dm_message', { withId: toId, message: msg });
  });

  socket.on('get_dm_history', ({ withId }) => {
    const key = threadKey(socket.id, withId);
    socket.emit('dm_history', { withId, messages: dmThreads[key] || [] });
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
      avatarType: socket.data.profile.avatarType,
      avatarConfig: socket.data.profile.avatarConfig,
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

  socket.on('get_posts', () => {
    socket.emit('post_list', posts.map(serializePost));
  });

  socket.on('create_post', ({ text, image, videoUrl, sharedFrom }) => {
    if (!socket.data.profile) return;
    const cleanText = (text || '').trim().slice(0, 500);
    const cleanVideo = (videoUrl || '').trim().slice(0, 500);
    if (!cleanText && !image && !cleanVideo && !sharedFrom) return; // não publica post totalmente vazio
    const post = {
      id: Date.now() + '_' + socket.id,
      authorId: socket.id,
      name: socket.data.profile.name,
      avatarUrl: socket.data.profile.avatarUrl,
      avatarType: socket.data.profile.avatarType,
      avatarConfig: socket.data.profile.avatarConfig,
      text: cleanText,
      image: image || null, // dataURL já redimensionado no cliente
      videoUrl: cleanVideo || null,
      sharedFrom: sharedFrom ? { name: String(sharedFrom.name || '').slice(0, 24) } : null,
      likes: new Set(),
      comments: [],
      ts: Date.now(),
    };
    posts.unshift(post);
    if (posts.length > 200) posts.pop();
    io.emit('new_post', serializePost(post));
  });

  socket.on('add_comment', ({ postId, text }) => {
    if (!socket.data.profile) return;
    const post = posts.find(p => p.id === postId);
    const cleanText = (text || '').trim().slice(0, 300);
    if (!post || !cleanText) return;
    if (!post.comments) post.comments = [];
    const comment = {
      id: Date.now() + '_' + socket.id,
      authorId: socket.id,
      name: socket.data.profile.name,
      avatarUrl: socket.data.profile.avatarUrl,
      avatarType: socket.data.profile.avatarType,
      avatarConfig: socket.data.profile.avatarConfig,
      text: cleanText,
      ts: Date.now(),
    };
    post.comments.push(comment);
    if (post.comments.length > 200) post.comments.shift();
    io.emit('new_comment', { postId, comment });
  });

  socket.on('like_post', ({ postId }) => {
    const post = posts.find(p => p.id === postId);
    if (!post) return;
    if (post.likes.has(socket.id)) {
      post.likes.delete(socket.id);
    } else {
      post.likes.add(socket.id);
    }
    io.emit('post_liked', { postId: post.id, likeCount: post.likes.size, likedBy: Array.from(post.likes) });
  });

  socket.on('get_listings', () => {
    socket.emit('listing_list', listings.map(serializeListing));
  });

  socket.on('create_listing', ({ title, price, description, image }) => {
    if (!socket.data.profile) return;
    const cleanTitle = (title || '').trim().slice(0, 60);
    if (!cleanTitle) return;
    const listing = {
      id: Date.now() + '_' + socket.id,
      sellerId: socket.id,
      sellerName: socket.data.profile.name,
      title: cleanTitle,
      price: (price || '').trim().slice(0, 20),
      description: (description || '').trim().slice(0, 300),
      image: image || null,
      ts: Date.now(),
    };
    listings.unshift(listing);
    if (listings.length > 200) listings.pop();
    io.emit('new_listing', serializeListing(listing));
  });

  socket.on('get_biz_posts', () => {
    socket.emit('biz_post_list', bizPosts.map(serializeBizPost));
  });

  socket.on('create_biz_post', ({ businessName, category, description, contact, image }) => {
    if (!socket.data.profile) return;
    const cleanName = (businessName || '').trim().slice(0, 60);
    if (!cleanName) return;
    const bizPost = {
      id: Date.now() + '_' + socket.id,
      authorId: socket.id,
      authorName: socket.data.profile.name,
      businessName: cleanName,
      category: (category || '').trim().slice(0, 40),
      description: (description || '').trim().slice(0, 400),
      contact: (contact || '').trim().slice(0, 80),
      image: image || null,
      ts: Date.now(),
    };
    bizPosts.unshift(bizPost);
    if (bizPosts.length > 200) bizPosts.pop();
    io.emit('new_biz_post', serializeBizPost(bizPost));
  });

  socket.on('leave_room', () => {
    leaveCurrentRoom(socket);
  });

  socket.on('disconnect', () => {
    leaveCurrentRoom(socket);
    onlineUsers.delete(socket.id);
    // limpa as relações de seguir dessa pessoa (só pra quem não tinha conta salva mesmo)
    followers.delete(socket.id);
    following.delete(socket.id);
    followers.forEach((set) => set.delete(socket.id));
    following.forEach((set) => set.delete(socket.id));
    broadcastOnlineUsers();
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
