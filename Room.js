const mongoose = require('mongoose');

const playerSchema = new mongoose.Schema({
    name: { type: String, required: true },
    role: { type: String, default: null },
    status: { type: String, enum: ['alive', 'dead'], default: 'alive' }
});

const roomSchema = new mongoose.Schema({
    roomCode: { type: String, required: true, unique: true },
    players: [playerSchema],
    state: { type: String, default: 'lobby' }, // lobby, night, day, voting, game_over
    mafiaTarget: { type: String, default: null },
    medicSave: { type: String, default: null },
    votes: { type: mongoose.Schema.Types.Mixed, default: {} } // Stores player votes
});

module.exports = mongoose.model('Room', roomSchema);