const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cors = require('cors');

const Room = require('./Room');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(bodyParser.json());
app.use(cors());
const path = require('path');

app.get('/',            (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/join-room',   (req, res) => res.sendFile(path.join(__dirname, 'join_room.html')));
app.get('/create-room', (req, res) => res.sendFile(path.join(__dirname, 'create_room.html')));

const mongoURI = 'mongodb+srv://thanmaikolli:thanmai3497@cluster0.slgwelu.mongodb.net/cloudmafia?retryWrites=true&w=majority&appName=Cluster0';

mongoose.connect(mongoURI)
.then(() => {
    console.log('✅ MongoDB (Atlas) connected successfully.');
})
.catch(err => {
    console.error('❌ MongoDB connection error:', err);
});
const playerConnections = new Map();
const roles = ["Mafia", "Mafia", "Detective", "Medic", "Civilian", "Civilian", "Civilian"];

// --- Game Logic Functions ---
function checkWinConditions(room) {
    const alivePlayers = room.players.filter(p => p.status === 'alive');
    const mafiaCount = alivePlayers.filter(p => p.role === 'Mafia').length;
    const civilianCount = alivePlayers.length - mafiaCount;

    if (mafiaCount === 0) {
        return 'Civilians';
    }
    if (mafiaCount >= civilianCount) {
        return 'Mafia';
    }
    return null; // No winner yet
}

async function startNightPhase(roomCode) {
    const room = await Room.findOne({ roomCode });
    if (!room) return;

    room.state = 'night';
    room.mafiaTarget = null;
    room.medicSave = null;
    await room.save();
    
    broadcastUpdate(room, { type: 'startNight' });

    setTimeout(() => processNightActions(roomCode), 30000);
}

async function processNightActions(roomCode) {
    const room = await Room.findOne({ roomCode });
    if (!room || room.state !== 'night') return;

    let killedPlayerName = room.mafiaTarget;
    let message = `The town is silent. No one was killed.`;

    if (killedPlayerName && killedPlayerName !== room.medicSave) {
        const killedPlayer = room.players.find(p => p.name === killedPlayerName);
        if (killedPlayer) {
            killedPlayer.status = 'dead';
            message = `${killedPlayer.name} has been found dead.`;
            await room.save();
        }
    }
    
    broadcastUpdate(room, {
        type: 'nightResults',
        message: message,
        players: room.players.map(p => ({ name: p.name, status: p.status }))
    });

    const winner = checkWinConditions(room);
    if (winner) {
        broadcastUpdate(room, { type: 'gameOver', winner });
    } else {
        startDayPhase(roomCode);
    }
}

async function startDayPhase(roomCode) {
    const room = await Room.findOne({ roomCode });
    if (!room) return;

    room.state = 'day';
    room.votes = {};
    await room.save();

    broadcastUpdate(room, { type: 'startDay' });
    setTimeout(() => startVotingPhase(roomCode), 60000);
}

async function startVotingPhase(roomCode) {
    const room = await Room.findOne({ roomCode });
    if (!room) return;
    room.state = 'voting';
    await room.save();
    
    broadcastUpdate(room, { type: 'startVoting' });

    setTimeout(() => processVotes(roomCode), 30000);
}

async function processVotes(roomCode) {
    const room = await Room.findOne({ roomCode });
    if (!room || room.state !== 'voting') return;

    const voteCounts = {};
    for (const voter in room.votes) {
        const votedPlayer = room.votes[voter];
        voteCounts[votedPlayer] = (voteCounts[votedPlayer] || 0) + 1;
    }

    let eliminatedPlayerName = null;
    let maxVotes = 0;

    for (const player in voteCounts) {
        if (voteCounts[player] > maxVotes) {
            maxVotes = voteCounts[player];
            eliminatedPlayerName = player;
        } else if (voteCounts[player] === maxVotes) {
            eliminatedPlayerName = null;
        }
    }
    
    if (eliminatedPlayerName) {
        const eliminatedPlayer = room.players.find(p => p.name === eliminatedPlayerName);
        if (eliminatedPlayer) {
            eliminatedPlayer.status = 'dead';
            await room.save();
        }
        broadcastUpdate(room, {
            type: 'dayResults',
            message: `${eliminatedPlayerName} was voted out and eliminated.`,
            players: room.players.map(p => ({ name: p.name, status: p.status }))
        });
        broadcastUpdate(room, {
            type: 'playerEliminated',
            eliminated: eliminatedPlayerName
        });
    } else {
        broadcastUpdate(room, { type: 'dayResults', message: 'The town could not decide. No one was eliminated.' });
    }

    const winner = checkWinConditions(room);
    if (winner) {
        broadcastUpdate(room, { type: 'gameOver', winner });
    } else {
        startNightPhase(roomCode);
    }
}

// --- HTTP Route for Creating a Room ---
app.post('/create-room', async (req, res) => {
    const { roomCode } = req.body;
    
    if (!roomCode) {
        return res.status(400).json({ message: 'Room code is required.' });
    }

    try {
        const newRoom = new Room({ roomCode, players: [] });
        await newRoom.save();
        res.status(201).json({ message: 'Room created successfully.' });
    } catch (error) {
        res.status(500).json({ message: 'Error creating room.', error: error.message });
    }
});

// --- WebSocket Logic ---
wss.on('connection', ws => {
    console.log('A client connected.');

    ws.on('message', async message => {
        try {
            const data = JSON.parse(message);
            const { type, roomCode, playerName, target, chatMessage } = data;

            let room = await Room.findOne({ roomCode });
            if (!room) return;

            if (playerName) {
                playerConnections.set(playerName, ws);
            }

            if (type === 'joinRoom') {
                if (!room.players.some(p => p.name === playerName)) {
                    room.players.push({ name: playerName });
                    await room.save();
                }
                
                broadcastUpdate(room, {
                    type: 'roomUpdate',
                    players: room.players.map(p => ({ name: p.name, status: p.status }))
                });
            }

            if (type === 'startGame' && room.state === 'lobby' && room.players.length >= 7) {
                const shuffledRoles = roles.slice(0, room.players.length).sort(() => Math.random() - 0.5);
                room.players.forEach((player, index) => {
                    player.role = shuffledRoles[index];
                    const playerWs = playerConnections.get(player.name);
                    if (playerWs) {
                        playerWs.send(JSON.stringify({ type: 'yourRole', role: player.role }));
                    }
                });
                await room.save();
                startNightPhase(roomCode);
            }

            if (type === 'mafiaChat' && room.state === 'night') {
                const sender = room.players.find(p => p.name === playerName);
                if (sender && sender.role === 'Mafia') {
                    broadcastToMafia(room, { type: 'mafiaChat', sender: playerName, message: chatMessage });
                }
            }
            
            if (type === 'publicChat' && room.state === 'day') {
                broadcastUpdate(room, { type: 'publicChat', sender: playerName, message: chatMessage });
            }

            if (type === 'vote' && room.state === 'voting') {
                if (!room.votes) room.votes = {};
                room.votes[playerName] = target;
                await room.save();
                broadcastUpdate(room, { type: 'voteReceived', voter: playerName });
            }

            if (type === 'detectiveInvestigate' && room.state === 'night') {
                const detective = room.players.find(p => p.name === playerName);
                const targetPlayer = room.players.find(p => p.name === target);
              
                if (detective && detective.role === 'Detective' && targetPlayer) {
                  const result = targetPlayer.role === 'Mafia';
                  const detectiveWs = playerConnections.get(detective.name);
              
                  if (detectiveWs && detectiveWs.readyState === WebSocket.OPEN) {
                    detectiveWs.send(JSON.stringify({
                      type: 'detectiveResult',
                      player: target,
                      isMafia: result
                    }));
                  }
                }
              }              

        } catch (error) {
            console.error('Error handling message:', error.message);
        }
    });

    ws.on('close', async () => {
        let playerName = null;
        for (const [name, client] of playerConnections.entries()) {
            if (client === ws) {
                playerName = name;
                break;
            }
        }
        if (playerName) {
            playerConnections.delete(playerName);
            const room = await Room.findOneAndUpdate(
                { 'players.name': playerName },
                { $pull: { players: { name: playerName } } },
                { new: true }
            );

            if (room) {
                broadcastUpdate(room, {
                    type: 'roomUpdate',
                    players: room.players.map(p => ({ name: p.name, status: p.status }))
                });
            }
        }
    });
});

// NEW: Helper function to send a message to all players in a given room object
function broadcastUpdate(room, message) {
    if (room) {
        room.players.forEach(player => {
            if (playerConnections.get(player.name) && playerConnections.get(player.name).readyState === WebSocket.OPEN) {
                playerConnections.get(player.name).send(JSON.stringify(message));
            }
        });
    }
}

// NEW: Helper function to send a message only to Mafia members in a given room object
function broadcastToMafia(room, message) {
    if (room) {
        room.players.forEach(player => {
            if (player.role === 'Mafia' && playerConnections.get(player.name) && playerConnections.get(player.name).readyState === WebSocket.OPEN) {
                playerConnections.get(player.name).send(JSON.stringify(message));
            }
        });
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
