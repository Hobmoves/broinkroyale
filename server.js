const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "https://broinkroyale.onrender.com" } });
const planck = require('planck-js');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

// Serve static status page at root
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'status.html'));
});

// Health endpoint for service activity detection
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

const Vec2 = planck.Vec2;
const gameData = { lobbies: {} };

// Get all game data
function getGameData() {
  return gameData;
}

// Set game data (merge provided data)
function setGameData(data) {
  if (data.lobbies) {
    Object.entries(data.lobbies).forEach(([lobbyId, lobby]) => {
      if (!gameData.lobbies[lobbyId]) {
        gameData.lobbies[lobbyId] = { players: {}, arena: {}, state: 'waiting', lastKnockout: null };
      }
      if (lobby.players) {
        gameData.lobbies[lobbyId].players = { ...gameData.lobbies[lobbyId].players, ...lobby.players };
      }
      if (lobby.arena) {
        gameData.lobbies[lobbyId].arena = { ...gameData.lobbies[lobbyId].arena, ...lobby.arena };
      }
      if (lobby.state) {
        gameData.lobbies[lobbyId].state = lobby.state;
      }
      if (lobby.lastKnockout) {
        gameData.lobbies[lobbyId].lastKnockout = lobby.lastKnockout;
      }
    });
  }
}

// Per-lobby update (physics, arena shrink, events)
function lobbyTick(lobbyId) {
  const lobby = gameData.lobbies[lobbyId];
  if (!lobby || lobby.state !== 'active') return;

  const world = lobby.world;
  const arena = lobby.arena;

  // Apply player inputs
  Object.values(lobby.players).forEach(player => {
    if (player.isAlive) {
      const body = player.body;
      let force = Vec2(player.input.x * 1000, player.input.z * 1000);
      body.applyForceToCenter(force);
    }
  });

  // Step physics
  world.step(1 / 60);

  // Shrink arena
  lobby.shrinkTimer = (lobby.shrinkTimer || 0) + 1 / 30;
  if (lobby.shrinkTimer >= 10) {
    arena.width = Math.max(arena.minSize, arena.width - arena.shrinkRate);
    arena.height = Math.max(arena.minSize, arena.height - arena.shrinkRate);
    updateArenaBoundaries(lobbyId);
    lobby.shrinkTimer = 0;
  }

  // Check player falls and knockouts
  let aliveCount = 0;
  Object.entries(lobby.players).forEach(([playerId, player]) => {
    if (player.isAlive) {
      const pos = player.body.getPosition();
      if (pos.x < 0 || pos.x > arena.width || pos.y < 0 || pos.y > arena.height) {
        player.isAlive = false;
        player.body.setPosition(Vec2(arena.width / 2, arena.height / 2));
        player.body.setLinearVelocity(Vec2(0, 0));
        const lastContact = player.lastContact || {};
        if (lastContact.playerId && Date.now() - lastContact.timestamp < 2000) {
          const scorer = lobby.players[lastContact.playerId];
          if (scorer && scorer.isAlive) {
            scorer.score = (scorer.score || 0) + 1;
            lobby.lastKnockout = { playerId: lastContact.playerId, victimId: playerId, timestamp: Date.now() };
            io.to(lobbyId).emit('knockout', lobby.lastKnockout);
          }
        }
      } else {
        aliveCount++;
      }
    }
  });

  // End game if one or no players remain
  if (aliveCount <= 1) {
    lobby.state = 'ended';
    io.to(lobbyId).emit('gameEnded', { winner: aliveCount === 1 ? Object.keys(lobby.players).find(id => lobby.players[id].isAlive) : null });
  }

  // Update game state
  const lobbyState = {
    players: Object.fromEntries(Object.entries(lobby.players).map(([id, player]) => [id, {
      position: player.body.getPosition(),
      velocity: player.body.getLinearVelocity(),
      score: player.score,
      isAlive: player.isAlive
    }])),
    arena: lobby.arena,
    state: lobby.state,
    lastKnockout: lobby.lastKnockout
  };
  io.to(lobbyId).emit('gameUpdate', lobbyState);
}

// Update arena boundaries
function updateArenaBoundaries(lobbyId) {
  const lobby = gameData.lobbies[lobbyId];
  const world = lobby.world;
  const arena = lobby.arena;

  if (lobby.boundaries) {
    lobby.boundaries.forEach(body => world.destroyBody(body));
  }

  lobby.boundaries = [];
  const thickness = 10;
  const shapes = [
    { pos: Vec2(arena.width / 2, -thickness / 2), size: Vec2(arena.width, thickness) },
    { pos: Vec2(arena.width / 2, arena.height + thickness / 2), size: Vec2(arena.width, thickness) },
    { pos: Vec2(-thickness / 2, arena.height / 2), size: Vec2(thickness, arena.height) },
    { pos: Vec2(arena.width + thickness / 2, arena.height / 2), size: Vec2(thickness, arena.height) }
  ];

  shapes.forEach(shape => {
    const body = world.createBody({ type: 'static', position: shape.pos });
    body.createFixture(planck.Box(shape.size.x / 2, shape.size.y / 2), { density: 0, restitution: 1 });
    lobby.boundaries.push(body);
  });
}

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('joinLobby', (lobbyId) => {
    let targetLobbyId = lobbyId || uuidv4();
    if (!gameData.lobbies[targetLobbyId]) {
      gameData.lobbies[targetLobbyId] = {
        players: {},
        arena: { width: 800, height: 600, shrinkRate: 20, minSize: 200 },
        state: 'waiting',
        lastKnockout: null,
        world: planck.World(Vec2(0, 0)),
        boundaries: []
      };
      updateArenaBoundaries(targetLobbyId);
    }

    const lobby = gameData.lobbies[targetLobbyId];
    if (Object.keys(lobby.players).length >= 8 || lobby.state === 'active' || lobby.state === 'ended') {
      socket.emit('joinError', 'Lobby full or in progress');
      return;
    }

    socket.join(targetLobbyId);
    const body = lobby.world.createDynamicBody(Vec2(lobby.arena.width / 2, lobby.arena.height / 2));
    body.createFixture(planck.Circle(16), { density: 1, restitution: 1 });
    lobby.players[socket.id] = {
      body,
      input: { x: 0, z: 0 },
      score: 0,
      isAlive: true,
      lastContact: null
    };

    lobby.world.on('begin-contact', (contact) => {
      const bodyA = contact.getFixtureA().getBody();
      const bodyB = contact.getFixtureB().getBody();
      const playerA = Object.values(lobby.players).find(p => p.body === bodyA);
      const playerB = Object.values(lobby.players).find(p => p.body === bodyB);
      if (playerA && playerB) {
        const idA = Object.keys(lobby.players).find(id => lobby.players[id].body === bodyA);
        const idB = Object.keys(lobby.players).find(id => lobby.players[id].body === bodyB);
        if (idA && idB) {
          lobby.players[idA].lastContact = { playerId: idB, timestamp: Date.now() };
          lobby.players[idB].lastContact = { playerId: idA, timestamp: Date.now() };
        }
      }
    });

    io.to(targetLobbyId).emit('playerList', Object.keys(lobby.players));
    socket.emit('joinedLobby', targetLobbyId);

    if (Object.keys(lobby.players).length >= 4 && lobby.state === 'waiting') {
      lobby.state = 'active';
      io.to(targetLobbyId).emit('gameStarted');
    }
  });

  socket.on('input', (input) => {
    const lobbyId = Array.from(socket.rooms).find(room => room !== socket.id);
    if (lobbyId && gameData.lobbies[lobbyId] && gameData.lobbies[lobbyId].players[socket.id]) {
      gameData.lobbies[lobbyId].players[socket.id].input = input;
    }
  });

  socket.on('leaveLobby', () => {
    const lobbyId = Array.from(socket.rooms).find(room => room !== socket.id);
    if (lobbyId && gameData.lobbies[lobbyId]) {
      const lobby = gameData.lobbies[lobbyId];
      if (lobby.players[socket.id]) {
        lobby.world.destroyBody(lobby.players[socket.id].body);
        delete lobby.players[socket.id];
        io.to(lobbyId).emit('playerList', Object.keys(lobby.players));
        socket.leave(lobbyId);
      }
      if (Object.keys(lobby.players).length === 0) {
        delete gameData.lobbies[lobbyId];
      }
    }
  });

  socket.on('disconnect', () => {
    const lobbyId = Array.from(socket.rooms).find(room => room !== socket.id);
    if (lobbyId && gameData.lobbies[lobbyId]) {
      const lobby = gameData.lobbies[lobbyId];
      if (lobby.players[socket.id]) {
        lobby.world.destroyBody(lobby.players[socket.id].body);
        delete lobby.players[socket.id];
        io.to(lobbyId).emit('playerList', Object.keys(lobby.players));
      }
      if (Object.keys(lobby.players).length === 0) {
        delete gameData.lobbies[lobbyId];
      }
    }
    console.log('Player disconnected:', socket.id);
  });
});

setInterval(() => {
  Object.keys(gameData.lobbies).forEach(lobbyId => {
    lobbyTick(lobbyId);
  });
}, 1000 / 30);

const port = process.env.PORT || 3000;
http.listen(port, () => console.log(`Server running on port ${port}`));
