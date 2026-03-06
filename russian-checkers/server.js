const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

function createInitialBoard() {
    const board = Array(8).fill(null).map(() => Array(8).fill(null));
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            if ((r + c) % 2 !== 0) {
                if (r < 3) board[r][c] = { color: 'black', isKing: false };
                if (r > 4) board[r][c] = { color: 'white', isKing: false };
            }
        }
    }
    return board;
}

function broadcastState(roomName) {
    const room = rooms[roomName];
    if (!room) return;
    io.to(roomName).emit('gameStateSync', {
        board: room.board,
        currentPlayer: room.currentPlayer,
        isGameOver: room.isGameOver,
        mustJumpPiece: room.mustJumpPiece,
    });
}

io.on('connection', (socket) => {
    console.log('Connected:', socket.id);

    socket.on('joinRoom', (roomName) => {
        if (!roomName) roomName = 'main';
        socket.join(roomName);
        socket.roomName = roomName;

        if (!rooms[roomName]) {
            rooms[roomName] = {
                players: {},
                board: createInitialBoard(),
                currentPlayer: 'white',
                isGameOver: false,
                mustJumpPiece: null,
            };
        }

        const room = rooms[roomName];
        let assignedColor;

        if (!room.players['white']) {
            room.players['white'] = socket.id;
            assignedColor = 'white';
        } else if (!room.players['black']) {
            room.players['black'] = socket.id;
            assignedColor = 'black';
        } else {
            assignedColor = 'spectator';
        }

        socket.myColor = assignedColor;
        socket.emit('assignedColor', assignedColor);

        const playerCount = Object.values(room.players).filter(Boolean).length;
        io.to(roomName).emit('playerCount', playerCount);

        // Send current state to the joining player
        socket.emit('gameStateSync', {
            board: room.board,
            currentPlayer: room.currentPlayer,
            isGameOver: room.isGameOver,
            mustJumpPiece: room.mustJumpPiece,
        });
    });

    socket.on('move', (data) => {
        if (!socket.roomName) return;
        const room = rooms[socket.roomName];
        if (!room || room.isGameOver) return;

        // Reject moves from the wrong player
        if (room.currentPlayer !== socket.myColor) return;

        room.board = data.board;
        room.currentPlayer = data.currentPlayer;
        room.isGameOver = data.isGameOver;
        room.mustJumpPiece = data.mustJumpPiece || null;

        broadcastState(socket.roomName);
    });

    socket.on('restart', () => {
        if (!socket.roomName) return;
        const room = rooms[socket.roomName];
        if (!room || socket.myColor === 'spectator') return;

        room.board = createInitialBoard();
        room.currentPlayer = 'white';
        room.isGameOver = false;
        room.mustJumpPiece = null;

        broadcastState(socket.roomName);
    });

    socket.on('disconnect', () => {
        console.log('Disconnected:', socket.id);
        if (!socket.roomName || !rooms[socket.roomName]) return;

        const room = rooms[socket.roomName];
        if (room.players['white'] === socket.id) delete room.players['white'];
        else if (room.players['black'] === socket.id) delete room.players['black'];

        const playerCount = Object.values(room.players).filter(Boolean).length;
        io.to(socket.roomName).emit('playerCount', playerCount);
        io.to(socket.roomName).emit('opponentDisconnected');

        // Clean up empty rooms
        if (playerCount === 0) {
            delete rooms[socket.roomName];
        }
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
