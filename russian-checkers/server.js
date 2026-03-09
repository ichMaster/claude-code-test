require('dotenv').config();
const express = require('express');
const http = require('http');
const fs = require('fs');
const { Server } = require('socket.io');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const anthropic = new Anthropic();

function reloadConfig() {
    try {
        config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    } catch (err) {
        console.error('Failed to reload config:', err.message);
    }
}

app.get('/api/config', (req, res) => {
    reloadConfig();
    res.json({ game: config.game || {} });
});
const openai = new OpenAI();

app.post('/api/ai-move', async (req, res) => {
    reloadConfig();
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
    reloadConfig();
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

// ─── Game storage ─────────────────────────────────────────────────────────

const GAMES_DIR = path.join(__dirname, 'data', 'games');
const INDEX_PATH = path.join(__dirname, 'data', 'index.json');

fs.mkdirSync(GAMES_DIR, { recursive: true });

function readIndex() {
    try {
        return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    } catch {
        return { games: [] };
    }
}

function writeIndex(index) {
    const tmp = INDEX_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(index, null, 2));
    fs.renameSync(tmp, INDEX_PATH);
}

// Rebuild index from game files on startup
(function rebuildIndex() {
    if (!fs.existsSync(GAMES_DIR)) return;
    const files = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'));
    const games = files.map(f => {
        try {
            const game = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, f), 'utf8'));
            return {
                id: game.id,
                mode: game.metadata.mode,
                startedAt: game.metadata.startedAt,
                result: game.metadata.result.winner,
                reason: game.metadata.result.reason,
                winnerAgent: game.metadata.result.winnerAgent,
                totalMoves: game.metadata.totalMoves,
                durationMs: game.metadata.durationMs,
                players: game.metadata.players,
            };
        } catch { return null; }
    }).filter(Boolean);
    games.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
    writeIndex({ games });
})();

app.post('/api/games', (req, res) => {
    const game = req.body;
    if (!game || !game.id || !game.metadata || !game.moves) {
        return res.status(400).json({ error: 'Invalid game record' });
    }
    const filePath = path.join(GAMES_DIR, `${game.id}.json`);
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(game));
    fs.renameSync(tmp, filePath);

    const index = readIndex();
    index.games.unshift({
        id: game.id,
        mode: game.metadata.mode,
        startedAt: game.metadata.startedAt,
        result: game.metadata.result.winner,
        reason: game.metadata.result.reason,
        winnerAgent: game.metadata.result.winnerAgent,
        totalMoves: game.metadata.totalMoves,
        durationMs: game.metadata.durationMs,
        players: game.metadata.players,
    });
    writeIndex(index);
    res.json({ id: game.id });
});

app.get('/api/games', (req, res) => {
    const index = readIndex();
    let games = index.games;
    if (req.query.mode) games = games.filter(g => g.mode === req.query.mode);
    if (req.query.agent) games = games.filter(g => g.winnerAgent === req.query.agent);
    if (req.query.result) games = games.filter(g => g.result === req.query.result);
    const offset = parseInt(req.query.offset) || 0;
    const limit = parseInt(req.query.limit) || 20;
    res.json({ games: games.slice(offset, offset + limit), total: games.length });
});

app.get('/api/games/:id', (req, res) => {
    const filePath = path.join(GAMES_DIR, `${req.params.id}.json`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    const game = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    res.json(game);
});

app.delete('/api/games/:id', (req, res) => {
    const filePath = path.join(GAMES_DIR, `${req.params.id}.json`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    const index = readIndex();
    index.games = index.games.filter(g => g.id !== req.params.id);
    writeIndex(index);
    res.json({ ok: true });
});

app.get('/api/training-data', (req, res) => {
    const index = readIndex();
    let games = index.games;
    if (req.query.agent) games = games.filter(g => g.winnerAgent === req.query.agent);
    if (req.query.minMoves) games = games.filter(g => g.totalMoves >= parseInt(req.query.minMoves));

    res.setHeader('Content-Type', 'application/x-ndjson');

    for (const entry of games) {
        const filePath = path.join(GAMES_DIR, `${entry.id}.json`);
        if (!fs.existsSync(filePath)) continue;
        const game = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const resultWinner = game.metadata.result.winner;

        for (const move of game.moves) {
            const boardNumeric = [];
            // Encode board state BEFORE this move (we use boardAfter from previous move or initialBoard)
            const boardSource = move.moveNumber === 1 ? game.initialBoard :
                game.moves[move.moveNumber - 2]?.boardAfter || game.initialBoard;
            for (let r = 0; r < 8; r++) {
                for (let c = 0; c < 8; c++) {
                    const cell = boardSource[r]?.[c];
                    if (!cell) { boardNumeric.push(0); continue; }
                    if (cell.color === 'white') boardNumeric.push(cell.isKing ? 2 : 1);
                    else boardNumeric.push(cell.isKing ? 4 : 3);
                }
            }

            const currentPlayer = move.player === 'white' ? 1 : -1;
            const gameResult = !resultWinner ? 0 :
                (move.player === resultWinner ? 1 : -1);

            const availMoves = (move.availableMoves || []).map(m => ({
                from: m.from.r * 8 + m.from.c,
                to: m.to.r * 8 + m.to.c,
                capture: m.to.capture ? m.to.capture.r * 8 + m.to.capture.c : null
            }));

            const chosenFrom = move.from.r * 8 + move.from.c;
            const chosenTo = move.to.r * 8 + move.to.c;
            const chosenMoveIndex = availMoves.findIndex(m => m.from === chosenFrom && m.to === chosenTo);

            const agentType = game.metadata.players[move.player]?.agent || 'unknown';

            if (req.query.result === 'win' && gameResult !== 1) continue;
            if (req.query.result === 'loss' && gameResult !== -1) continue;

            const sample = {
                board: boardNumeric,
                currentPlayer,
                availableMoves: availMoves,
                chosenMoveIndex,
                gameResult,
                moveNumber: move.moveNumber,
                totalMoves: game.metadata.totalMoves,
                agentType,
            };
            res.write(JSON.stringify(sample) + '\n');
        }
    }
    res.end();
});

// ─── Socket / Online ──────────────────────────────────────────────────────

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
