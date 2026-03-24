/**
 * RandomChat Signaling Server
 * Deploy this to Railway, Render, Fly.io, or any Node.js host.
 *
 * DEPLOY INSTRUCTIONS (Railway - easiest, free):
 * 1. Create a new GitHub repo and push this folder to it
 * 2. Go to railway.app → New Project → Deploy from GitHub repo
 * 3. Railway auto-detects Node.js and runs "npm start"
 * 4. After deploy, copy your Railway URL (e.g. https://your-app.up.railway.app)
 * 5. Set that URL as VITE_SIGNALING_SERVER in your Base44 app secrets
 *
 * DEPLOY INSTRUCTIONS (Render - also free):
 * 1. Push this folder to GitHub
 * 2. Go to render.com → New Web Service → connect GitHub repo
 * 3. Build command: npm install
 * 4. Start command: npm start
 * 5. Copy the live URL and set VITE_SIGNALING_SERVER in Base44 secrets
 */
 
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
});

// Matchmaking queue: array of socket IDs waiting for a partner
const waitingQueue = [];
// Map of socket ID → partner socket ID
const pairs = {};
// Online count
let onlineCount = 0;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', online: onlineCount, waiting: waitingQueue.length });
});

function broadcastOnlineCount() {
  io.emit('online_count', onlineCount);
}

function tryMatch(socket) {
  const idx = waitingQueue.indexOf(socket.id);
  if (idx !== -1) waitingQueue.splice(idx, 1);

  if (waitingQueue.length > 0) {
    // Pick first waiting peer
    const partnerId = waitingQueue.shift();
    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (!partnerSocket) {
      // Partner disconnected, try again
      return tryMatch(socket);
    }

    // Pair them
    pairs[socket.id] = partnerId;
    pairs[partnerId] = socket.id;

    // Tell initiator to create offer
    socket.emit('matched', { role: 'initiator' });
    partnerSocket.emit('matched', { role: 'receiver' });
  } else {
    // Put in queue
    waitingQueue.push(socket.id);
    socket.emit('waiting');
  }
}

io.on('connection', (socket) => {
  onlineCount++;
  broadcastOnlineCount();

  // Client wants to find a match
  socket.on('find_match', () => {
    tryMatch(socket);
  });

  // WebRTC signaling relay
  socket.on('offer', (data) => {
    const partnerId = pairs[socket.id];
    if (partnerId) {
      io.to(partnerId).emit('offer', { sdp: data.sdp });
    }
  });

  socket.on('answer', (data) => {
    const partnerId = pairs[socket.id];
    if (partnerId) {
      io.to(partnerId).emit('answer', { sdp: data.sdp });
    }
  });

  socket.on('ice_candidate', (data) => {
    const partnerId = pairs[socket.id];
    if (partnerId) {
      io.to(partnerId).emit('ice_candidate', { candidate: data.candidate });
    }
  });

  // Text chat relay
  socket.on('chat_message', (data) => {
    const partnerId = pairs[socket.id];
    if (partnerId) {
      io.to(partnerId).emit('chat_message', { text: data.text });
    }
  });

  // Typing indicator relay
  socket.on('typing', () => {
    const partnerId = pairs[socket.id];
    if (partnerId) {
      io.to(partnerId).emit('stranger_typing');
    }
  });

  // Skip / next stranger
  socket.on('skip', () => {
    const partnerId = pairs[socket.id];
    if (partnerId) {
      io.to(partnerId).emit('partner_left');
      delete pairs[partnerId];
    }
    delete pairs[socket.id];
    // Re-queue this socket
    tryMatch(socket);
  });

  // Disconnect
  socket.on('disconnect', () => {
    onlineCount = Math.max(0, onlineCount - 1);
    broadcastOnlineCount();

    // Remove from queue if waiting
    const qi = waitingQueue.indexOf(socket.id);
    if (qi !== -1) waitingQueue.splice(qi, 1);

    // Notify partner
    const partnerId = pairs[socket.id];
    if (partnerId) {
      io.to(partnerId).emit('partner_left');
      delete pairs[partnerId];
    }
    delete pairs[socket.id];
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});