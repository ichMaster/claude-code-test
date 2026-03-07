require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const config = require('./config.json');
const anthropic = new Anthropic();
const openai = new OpenAI();

app.post('/api/ai-move', async (req, res) => {
    const { board, validMoves, aiColor = 'black' } = req.body;
    const aiPieces = aiColor === 'white' ? 'white pieces (w/W)' : 'dark pieces (b/B)';

    const boardStr = board.map((row, r) =>
        row.map((cell, c) => {
            if (!cell) return (r + c) % 2 !== 0 ? '.' : ' ';
            let ch = cell.color === 'white' ? 'w' : 'b';
            if (cell.isKing) ch = ch.toUpperCase();
            return ch;
        }).join(' ')
    ).map((row, i) => `${8 - i} | ${row}`).join('\n');

    const movesStr = validMoves.map((m, i) =>
        `${i}: (${m.from.r},${m.from.c}) -> (${m.to.r},${m.to.c})${m.to.capture ? ` captures (${m.to.capture.r},${m.to.capture.c})` : ''}`
    ).join('\n');

    try {
        const params = {
            model: config.claude.model,
            max_tokens: config.claude.maxTokens,
            messages: [{
                role: 'user',
                content: `You are playing Russian checkers (шашки) as the ${aiPieces}. The board (row,col from top-left, 0-indexed):
    a b c d e f g h
${boardStr}
Legend: w=white man, W=white king, b=dark man, B=dark king, .=empty dark square

Your valid moves:
${movesStr}

Pick the best move index (0-${validMoves.length - 1}). Respond with ONLY the number, nothing else.`
            }]
        };

        if (config.claude.thinking) {
            params.thinking = config.claude.thinking;
        }

        const response = await anthropic.messages.create(params);

        const textBlock = response.content.find(b => b.type === 'text');
        const text = textBlock ? textBlock.text.trim() : '0';
        const moveIndex = parseInt(text, 10);
        if (isNaN(moveIndex) || moveIndex < 0 || moveIndex >= validMoves.length) {
            res.json({ moveIndex: 0 });
        } else {
            res.json({ moveIndex });
        }
    } catch (err) {
        console.error('Claude API error:', err.message);
        res.json({ moveIndex: Math.floor(Math.random() * validMoves.length) });
    }
});

app.post('/api/chatgpt-move', async (req, res) => {
    const { board, validMoves, aiColor = 'black' } = req.body;
    const aiPieces = aiColor === 'white' ? 'white pieces (w/W)' : 'dark pieces (b/B)';

    const boardStr = board.map((row, r) =>
        row.map((cell, c) => {
            if (!cell) return (r + c) % 2 !== 0 ? '.' : ' ';
            let ch = cell.color === 'white' ? 'w' : 'b';
            if (cell.isKing) ch = ch.toUpperCase();
            return ch;
        }).join(' ')
    ).map((row, i) => `${8 - i} | ${row}`).join('\n');

    const movesStr = validMoves.map((m, i) =>
        `${i}: (${m.from.r},${m.from.c}) -> (${m.to.r},${m.to.c})${m.to.capture ? ` captures (${m.to.capture.r},${m.to.capture.c})` : ''}`
    ).join('\n');

    try {
        const params = {
            model: config.openai.model,
            max_completion_tokens: config.openai.maxCompletionTokens,
            messages: [{
                role: 'user',
                content: `You are playing Russian checkers (шашки) as the ${aiPieces}. The board (row,col from top-left, 0-indexed):
    a b c d e f g h
${boardStr}
Legend: w=white man, W=white king, b=dark man, B=dark king, .=empty dark square

Your valid moves:
${movesStr}

Pick the best move index (0-${validMoves.length - 1}). Respond with ONLY the number, nothing else.`
            }]
        };

        if (config.openai.reasoningEffort) {
            params.reasoning_effort = config.openai.reasoningEffort;
        }

        const response = await openai.chat.completions.create(params);

        const text = response.choices[0]?.message?.content?.trim() || '0';
        const moveIndex = parseInt(text, 10);
        if (isNaN(moveIndex) || moveIndex < 0 || moveIndex >= validMoves.length) {
            res.json({ moveIndex: 0 });
        } else {
            res.json({ moveIndex });
        }
    } catch (err) {
        console.error('OpenAI API error:', err.message);
        res.json({ moveIndex: Math.floor(Math.random() * validMoves.length) });
    }
});

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

const PORT = process.env.PORT || config.server.port;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
