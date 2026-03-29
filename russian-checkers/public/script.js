document.addEventListener("DOMContentLoaded", () => {
    const boardElement = document.getElementById("board");
    const statusElement = document.getElementById("status");
    const restartBtn = document.getElementById("restartBtn");
    const giveUpBtn = document.getElementById("giveUpBtn");
    const scoreElement = document.getElementById("score");
    const modeSelect = document.getElementById("modeSelect");
    const onlineInfo = document.getElementById("onlineInfo");
    const aiStatusElement = document.getElementById("aiStatus");

    const ROWS = 8;
    const COLS = 8;

    let board = [];
    let currentPlayer = 'white';
    let selectedSquare = null;
    let validMoves = [];
    let gameMode = 'pvp';
    let isGameOver = false;
    let mustJumpPiece = null; // {r, c} — piece locked in a multi-jump sequence
    let lastMoveFrom = null;
    let lastMoveTo = null;

    let playerColor = 'white'; // human's color in pvc/claude modes
    let aiColor = 'black';
    let score = { a: 0, b: 0 };

    let gameGen = 0; // incremented each new game to discard stale AI responses

    // ─── Timers ───────────────────────────────────────────────────────────────
    const timerWhiteEl = document.getElementById("timerWhite");
    const timerBlackEl = document.getElementById("timerBlack");
    let timeWhite = 0; // accumulated seconds
    let timeBlack = 0;
    let turnStartTime = null;
    let timerInterval = null;

    function formatTime(ms) {
        const totalSec = Math.floor(ms / 1000);
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        const tenths = Math.floor((ms % 1000) / 100);
        return `${m}:${s < 10 ? '0' : ''}${s}.${tenths}`;
    }

    function updateTimerDisplay() {
        const now = turnStartTime ? (Date.now() - turnStartTime) : 0;
        const wt = currentPlayer === 'white' ? timeWhite + now : timeWhite;
        const bt = currentPlayer === 'black' ? timeBlack + now : timeBlack;
        timerWhiteEl.textContent = `Білі: ${formatTime(wt)}`;
        timerBlackEl.textContent = `Чорні: ${formatTime(bt)}`;
    }

    function startTimer() {
        turnStartTime = Date.now();
        clearInterval(timerInterval);
        timerInterval = setInterval(updateTimerDisplay, 100);
    }

    function switchTimer() {
        if (turnStartTime) {
            const elapsed = Date.now() - turnStartTime;
            if (currentPlayer === 'white') timeWhite += elapsed;
            else timeBlack += elapsed;
        }
        startTimer();
    }

    function stopTimer() {
        if (turnStartTime) {
            const elapsed = Date.now() - turnStartTime;
            if (currentPlayer === 'white') timeWhite += elapsed;
            else timeBlack += elapsed;
        }
        clearInterval(timerInterval);
        timerInterval = null;
        turnStartTime = null;
        updateTimerDisplay();
    }

    function resetTimers() {
        clearInterval(timerInterval);
        timerInterval = null;
        turnStartTime = null;
        timeWhite = 0;
        timeBlack = 0;
        updateTimerDisplay();
    }

    let socket = null;
    let myColor = null;
    let roomName = null;
    let aiThinking = false;
    let computerDelayMs = 1000; // default, overridden from config
    let autoPlayMaxGames = 10; // default, overridden from config
    let autoPlayGameCount = 0;

    fetch('/api/config').then(r => r.json()).then(cfg => {
        if (cfg.game?.computerDelayMs != null) computerDelayMs = cfg.game.computerDelayMs;
        if (cfg.game?.autoPlayMaxGames != null) autoPlayMaxGames = cfg.game.autoPlayMaxGames;
    }).catch(() => {});

    // ─── Game Recorder ────────────────────────────────────────────────────────

    const recorder = {
        record: null,
        moveCounter: 0,

        startRecording(mode, players, initialBoard) {
            this.moveCounter = 0;
            this.record = {
                id: 'g_' + Date.now() + '_' + Math.random().toString(16).slice(2, 6),
                version: 1,
                metadata: {
                    mode,
                    startedAt: new Date().toISOString(),
                    endedAt: null,
                    durationMs: 0,
                    result: { winner: null, reason: null, winnerAgent: null, loserAgent: null },
                    players,
                    timerWhite: 0,
                    timerBlack: 0,
                    totalMoves: 0,
                },
                initialBoard: JSON.parse(JSON.stringify(initialBoard)),
                moves: [],
            };
        },

        recordMove(player, from, to, capture, promoted, isMultiJumpContinuation, boardAfter, availableMoves) {
            if (!this.record) return;
            this.moveCounter++;
            this.record.moves.push({
                moveNumber: this.moveCounter,
                player,
                from,
                to,
                capture: capture || null,
                promoted,
                isMultiJumpContinuation,
                boardAfter: JSON.parse(JSON.stringify(boardAfter)),
                availableMoves: JSON.parse(JSON.stringify(availableMoves)),
                timestamp: new Date().toISOString(),
            });
        },

        finishRecording(winner, reason) {
            if (!this.record) return;
            const meta = this.record.metadata;
            meta.endedAt = new Date().toISOString();
            meta.durationMs = new Date(meta.endedAt) - new Date(meta.startedAt);
            meta.totalMoves = this.moveCounter;
            meta.timerWhite = Math.round(timeWhite / 1000);
            meta.timerBlack = Math.round(timeBlack / 1000);
            meta.result.winner = winner;
            meta.result.reason = reason;

            const players = meta.players;
            if (winner) {
                meta.result.winnerAgent = players[winner]?.agent || 'unknown';
                const loserColor = winner === 'white' ? 'black' : 'white';
                meta.result.loserAgent = players[loserColor]?.agent || 'unknown';
            }

            // Send to server
            fetch('/api/games', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.record),
            }).catch(err => console.error('Failed to save game:', err));
        },
    };

    function getPlayersMeta() {
        const agentForColor = (color) => {
            if (gameMode === 'pvp') return 'human';
            if (gameMode === 'aiva') return color === 'white' ? 'claude' : 'chatgpt';
            if (gameMode === 'rvc') return color === 'white' ? 'random' : 'claude';
            if (gameMode === 'rvg') return color === 'white' ? 'random' : 'chatgpt';
            if (gameMode === 'cvc') return 'random';
            if (gameMode === 'pvc') return color === playerColor ? 'human' : 'random';
            if (gameMode === 'claude') return color === playerColor ? 'human' : 'claude';
            if (gameMode === 'chatgpt') return color === playerColor ? 'human' : 'chatgpt';
            if (gameMode === 'online') return 'human';
            return 'unknown';
        };
        const labelForColor = (color) => {
            if (gameMode === 'pvp') return color === 'white' ? 'Гравець 1' : 'Гравець 2';
            if (gameMode === 'aiva') return color === 'white' ? 'Claude' : 'ChatGPT';
            if (gameMode === 'rvc') return color === 'white' ? "Комп'ютер" : 'Claude';
            if (gameMode === 'rvg') return color === 'white' ? "Комп'ютер" : 'ChatGPT';
            if (gameMode === 'cvc') return color === 'white' ? 'Білі' : 'Чорні';
            if (gameMode === 'pvc') return color === playerColor ? 'Ви' : "Комп'ютер";
            if (gameMode === 'claude') return color === playerColor ? 'Ви' : 'Claude';
            if (gameMode === 'chatgpt') return color === playerColor ? 'Ви' : 'ChatGPT';
            if (gameMode === 'online') return color === myColor ? 'Ви' : 'Суперник';
            return color;
        };
        return {
            white: { agent: agentForColor('white'), label: labelForColor('white') },
            black: { agent: agentForColor('black'), label: labelForColor('black') },
        };
    }

    // ─── Board labels ────────────────────────────────────────────────────────

    function isFlipped() {
        if (gameMode === 'pvc' || gameMode === 'claude' || gameMode === 'chatgpt') return playerColor === 'black';
        if (gameMode === 'online') return myColor === 'black';
        return false;
    }

    function updateLabels() {
        const flip = isFlipped();
        const letters = flip ? ['h','g','f','e','d','c','b','a'] : ['a','b','c','d','e','f','g','h'];
        const numbers = flip ? [1,2,3,4,5,6,7,8] : [8,7,6,5,4,3,2,1];

        ['lettersTop', 'lettersBottom'].forEach(id => {
            const el = document.getElementById(id);
            el.innerHTML = '';
            letters.forEach(l => { const s = document.createElement('span'); s.textContent = l; el.appendChild(s); });
        });
        ['numbersLeft', 'numbersRight'].forEach(id => {
            const el = document.getElementById(id);
            el.innerHTML = '';
            numbers.forEach(n => { const s = document.createElement('span'); s.textContent = n; el.appendChild(s); });
        });
    }

    updateLabels();

    // ─── Init ────────────────────────────────────────────────────────────────

    function isAutoPlayMode(mode) {
        return mode === 'cvc' || mode === 'aiva' || mode === 'rvc' || mode === 'rvg';
    }

    async function initGame() {
        try {
            const cfg = await fetch('/api/config').then(r => r.json());
            if (cfg.game?.computerDelayMs != null) computerDelayMs = cfg.game.computerDelayMs;
            if (cfg.game?.autoPlayMaxGames != null) autoPlayMaxGames = cfg.game.autoPlayMaxGames;
        } catch {}

        const prevMode = gameMode;
        gameMode = modeSelect.value;
        if (gameMode !== prevMode) autoPlayGameCount = 0;

        if (isAutoPlayMode(gameMode) && autoPlayGameCount >= autoPlayMaxGames) {
            return; // series limit reached
        }

        if (gameMode !== 'online' && socket) {
            socket.disconnect();
            socket = null;
            onlineInfo.style.display = 'none';
        }

        board = Array(ROWS).fill(null).map(() => Array(COLS).fill(null));
        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                if ((r + c) % 2 !== 0) {
                    if (r < 3) board[r][c] = { color: 'black', isKing: false };
                    if (r > 4) board[r][c] = { color: 'white', isKing: false };
                }
            }
        }
        currentPlayer = 'white';
        selectedSquare = null;
        validMoves = [];
        isGameOver = false;
        mustJumpPiece = null;
        lastMoveFrom = null;
        lastMoveTo = null;

        savedGameState = null;
        aiThinking = false;
        aiStatusElement.textContent = '';
        gameGen++;

        if (gameMode === 'pvc' || gameMode === 'claude' || gameMode === 'chatgpt') {
            playerColor = playerColor === 'white' ? 'black' : 'white';
            aiColor = playerColor === 'white' ? 'black' : 'white';
        }

        updateLabels();
        updateScore();
        resetTimers();
        updateHistoryPanelVisibility();

        if (gameMode !== 'online') {
            recorder.startRecording(gameMode, getPlayersMeta(), board);
        }

        if (gameMode === 'online') {
            if (!socket) {
                setupSocket();
            } else {
                socket.emit('restart');
            }
        } else {
            updateStatus();
            renderBoard();
            startTimer();
            if (gameMode === 'aiva') {
                scheduleAiVsAiMove();
            } else if (gameMode === 'rvc') {
                scheduleRvcMove();
            } else if (gameMode === 'rvg') {
                scheduleRvgMove();
            } else if (gameMode === 'cvc') {
                scheduleCvcMove();
            } else if (currentPlayer === aiColor) {
                if (gameMode === 'pvc') setTimeout(makeAIMove, computerDelayMs);
                else if (gameMode === 'claude') setTimeout(() => makeServerAIMove('/api/ai-move', 'Claude'), computerDelayMs);
                else if (gameMode === 'chatgpt') setTimeout(() => makeServerAIMove('/api/chatgpt-move', 'ChatGPT'), computerDelayMs);
            }
        }
    }

    // ─── Socket / Online ─────────────────────────────────────────────────────

    function setupSocket() {
        socket = io();
        roomName = prompt("Введіть назву кімнати (поділіться нею з другом):", "room1") || "room1";
        onlineInfo.style.display = 'block';
        onlineInfo.textContent = `Підключення… Кімната: ${roomName}`;

        socket.emit('joinRoom', roomName);

        socket.on('assignedColor', (color) => {
            myColor = color;
            const label = color === 'white' ? 'Білі' : color === 'black' ? 'Чорні' : 'Глядач';
            onlineInfo.textContent = `Кімната: ${roomName} | Ви: ${label}`;
        });

        socket.on('playerCount', (count) => {
            if (myColor === 'spectator') return;
            const label = myColor === 'white' ? 'Білі' : 'Чорні';
            if (count < 2) {
                onlineInfo.textContent = `Кімната: ${roomName} | Ви: ${label} | Очікування суперника…`;
            } else {
                onlineInfo.textContent = `Кімната: ${roomName} | Ви: ${label} | Гра розпочалась!`;
            }
        });

        socket.on('opponentDisconnected', () => {
            if (myColor !== 'spectator') {
                alert('Суперник відключився!');
            }
        });

        socket.on('gameStateSync', (state) => {
            board = state.board;
            currentPlayer = state.currentPlayer;
            isGameOver = state.isGameOver;
            mustJumpPiece = state.mustJumpPiece || null;
            selectedSquare = null;
            validMoves = [];
            updateStatus();
            renderBoard();
        });
    }

    // ─── Status ──────────────────────────────────────────────────────────────

    function updateStatus() {
        if (isGameOver) return;
        const turnLabel = currentPlayer === 'white' ? 'Білі' : 'Чорні';
        if (gameMode === 'online') {
            if (currentPlayer === myColor) {
                statusElement.textContent = `Ваш хід (${turnLabel})`;
            } else {
                statusElement.textContent = `Хід суперника (${turnLabel})`;
            }
        } else if (gameMode === 'pvc' || gameMode === 'claude' || gameMode === 'chatgpt') {
            const yourLabel = playerColor === 'white' ? 'Білі' : 'Чорні';
            if (currentPlayer === playerColor) {
                statusElement.textContent = `Ваш хід (${yourLabel})`;
            } else {
                statusElement.textContent = `Хід суперника (${turnLabel})`;
            }
        } else {
            const prefix = isAutoPlayMode(gameMode) ? `[${autoPlayGameCount + 1}/${autoPlayMaxGames}] ` : '';
            statusElement.textContent = `${prefix}Хід: ${turnLabel}`;
        }
    }

    // ─── Render ──────────────────────────────────────────────────────────────

    function renderBoard() {
        boardElement.innerHTML = '';

        // Determine which pieces must capture (for visual hint)
        const forcedPieceKeys = new Set();
        if (!isGameOver) {
            if (mustJumpPiece) {
                forcedPieceKeys.add(`${mustJumpPiece.r},${mustJumpPiece.c}`);
            } else {
                const allMoves = getAllValidMoves(currentPlayer);
                if (allMoves.some(m => m.to.capture)) {
                    allMoves.filter(m => m.to.capture).forEach(m =>
                        forcedPieceKeys.add(`${m.from.r},${m.from.c}`)
                    );
                }
            }
        }

        const flip = isFlipped();

        for (let ri = 0; ri < ROWS; ri++) {
            for (let ci = 0; ci < COLS; ci++) {
                const r = flip ? (ROWS - 1 - ri) : ri;
                const c = flip ? (COLS - 1 - ci) : ci;

                const square = document.createElement('div');
                square.classList.add('square', (r + c) % 2 !== 0 ? 'dark' : 'light');
                square.dataset.row = r;
                square.dataset.col = c;

                if (selectedSquare && selectedSquare.r === r && selectedSquare.c === c) {
                    square.classList.add('selected');
                }
                if (validMoves.find(m => m.r === r && m.c === c)) {
                    square.classList.add('valid-move');
                }
                if ((lastMoveFrom && lastMoveFrom.r === r && lastMoveFrom.c === c) ||
                    (lastMoveTo && lastMoveTo.r === r && lastMoveTo.c === c)) {
                    square.classList.add('last-move');
                }

                const pieceData = board[r][c];
                if (pieceData) {
                    const piece = document.createElement('div');
                    piece.classList.add('piece', pieceData.color);
                    if (pieceData.isKing) piece.classList.add('king');
                    if (forcedPieceKeys.has(`${r},${c}`)) piece.classList.add('must-jump');
                    square.appendChild(piece);
                }

                square.addEventListener('click', () => handleSquareClick(r, c));
                boardElement.appendChild(square);
            }
        }
    }

    // ─── Input ───────────────────────────────────────────────────────────────

    function handleSquareClick(r, c) {
        if (replayMode) return;
        if (isGameOver) return;
        if (gameMode === 'cvc' || gameMode === 'aiva' || gameMode === 'rvc' || gameMode === 'rvg') return;
        if ((gameMode === 'pvc' || gameMode === 'claude' || gameMode === 'chatgpt') && currentPlayer !== playerColor) return;
        if (gameMode === 'online') {
            if (myColor === 'spectator') return;
            if (currentPlayer !== myColor) return;
        }

        // Clicking a highlighted valid-move destination
        const move = validMoves.find(m => m.r === r && m.c === c);
        if (move) {
            executeMove(move);
            return;
        }

        const piece = board[r][c];
        if (!piece || piece.color !== currentPlayer) {
            selectedSquare = null;
            validMoves = [];
            renderBoard();
            return;
        }

        // During a multi-jump, only the jumping piece can be selected
        if (mustJumpPiece && (mustJumpPiece.r !== r || mustJumpPiece.c !== c)) {
            return;
        }

        // Mandatory capture: if any piece has a capture available, only those can move
        const allMoves = getAllValidMoves(currentPlayer);
        const hasAnyCapture = allMoves.some(m => m.to.capture);
        const pieceMoves = getValidMoves(r, c, piece);

        if (hasAnyCapture) {
            const captureMoves = pieceMoves.filter(m => m.capture);
            if (captureMoves.length === 0) return; // this piece can't capture
            selectedSquare = { r, c };
            validMoves = captureMoves;
        } else {
            selectedSquare = { r, c };
            validMoves = pieceMoves;
        }

        renderBoard();
    }

    // ─── Move logic ──────────────────────────────────────────────────────────

    function getValidMoves(r, c, piece) {
        const moves = [];
        const forwardDirs = piece.isKing
            ? [[-1, -1], [-1, 1], [1, -1], [1, 1]]
            : piece.color === 'white' ? [[-1, -1], [-1, 1]] : [[1, -1], [1, 1]];
        const allDirs = [[-1, -1], [-1, 1], [1, -1], [1, 1]];

        // Regular (non-capture) moves
        for (const [dr, dc] of forwardDirs) {
            if (piece.isKing) {
                let nr = r + dr, nc = c + dc;
                while (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
                    if (!board[nr][nc]) {
                        moves.push({ r: nr, c: nc, capture: null });
                    } else {
                        break;
                    }
                    nr += dr; nc += dc;
                }
            } else {
                const nr = r + dr, nc = c + dc;
                if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS && !board[nr][nc]) {
                    moves.push({ r: nr, c: nc, capture: null });
                }
            }
        }

        // Capture moves (all 4 directions for both men and kings)
        for (const [dr, dc] of allDirs) {
            if (piece.isKing) {
                let nr = r + dr, nc = c + dc;
                let foundOpponent = false;
                let opponentSquare = null;
                while (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
                    if (board[nr][nc]) {
                        if (board[nr][nc].color !== piece.color && !foundOpponent) {
                            foundOpponent = true;
                            opponentSquare = { r: nr, c: nc };
                        } else {
                            break; // blocked by own piece or second opponent
                        }
                    } else if (foundOpponent) {
                        moves.push({ r: nr, c: nc, capture: opponentSquare });
                    }
                    nr += dr; nc += dc;
                }
            } else {
                const r1 = r + dr, c1 = c + dc;
                const r2 = r + dr * 2, c2 = c + dc * 2;
                if (r2 >= 0 && r2 < ROWS && c2 >= 0 && c2 < COLS) {
                    if (board[r1][c1] && board[r1][c1].color !== piece.color && !board[r2][c2]) {
                        moves.push({ r: r2, c: c2, capture: { r: r1, c: c1 } });
                    }
                }
            }
        }

        return moves;
    }

    function executeMove(move) {
        // Snapshot available moves BEFORE board mutation (for recording)
        const wasMultiJump = !!mustJumpPiece;
        let preMoveAvailable;
        if (mustJumpPiece) {
            const p = board[mustJumpPiece.r][mustJumpPiece.c];
            preMoveAvailable = p
                ? getValidMoves(mustJumpPiece.r, mustJumpPiece.c, p).filter(m => m.capture).map(m => ({ from: { r: mustJumpPiece.r, c: mustJumpPiece.c }, to: m }))
                : [];
        } else {
            preMoveAvailable = getAllValidMoves(currentPlayer);
        }

        lastMoveFrom = { r: selectedSquare.r, c: selectedSquare.c };
        lastMoveTo = { r: move.r, c: move.c };

        const piece = board[selectedSquare.r][selectedSquare.c];
        board[move.r][move.c] = piece;
        board[selectedSquare.r][selectedSquare.c] = null;

        let justPromoted = false;
        if (move.capture) {
            board[move.capture.r][move.capture.c] = null;

            // King promotion — only if not already a king
            if (!piece.isKing) {
                if (piece.color === 'white' && move.r === 0) {
                    piece.isKing = true;
                    justPromoted = true;
                }
                if (piece.color === 'black' && move.r === ROWS - 1) {
                    piece.isKing = true;
                    justPromoted = true;
                }
            }

            // Check for multi-jump continuation (not allowed after promotion)
            if (!justPromoted) {
                const furtherCaptures = getValidMoves(move.r, move.c, piece).filter(m => m.capture);
                if (furtherCaptures.length > 0) {
                    recorder.recordMove(currentPlayer, lastMoveFrom, lastMoveTo, move.capture, false, wasMultiJump, board, preMoveAvailable);
                    mustJumpPiece = { r: move.r, c: move.c };
                    selectedSquare = { r: move.r, c: move.c };
                    validMoves = furtherCaptures;
                    updateStatus();
                    renderBoard();
                    emitMoveOnline();
                    if (gameMode === 'aiva' && !isGameOver) {
                        scheduleAiVsAiMove();
                    } else if (gameMode === 'rvc' && !isGameOver) {
                        scheduleRvcMove();
                    } else if (gameMode === 'rvg' && !isGameOver) {
                        scheduleRvgMove();
                    } else if (gameMode === 'cvc' && !isGameOver) {
                        scheduleCvcMove();
                    } else if (currentPlayer === aiColor && !isGameOver) {
                        if (gameMode === 'pvc') setTimeout(makeAIMove, computerDelayMs);
                        else if (gameMode === 'claude') setTimeout(() => makeServerAIMove('/api/ai-move', 'Claude'), computerDelayMs);
                        else if (gameMode === 'chatgpt') setTimeout(() => makeServerAIMove('/api/chatgpt-move', 'ChatGPT'), computerDelayMs);
                    }
                    return; // stay on this player's turn
                }
            }
        } else {
            // Non-capture: promote if reached last row
            if (piece.color === 'white' && move.r === 0) piece.isKing = true;
            if (piece.color === 'black' && move.r === ROWS - 1) piece.isKing = true;
        }

        // Record this move
        const promoted = justPromoted ||
            (piece.color === 'white' && move.r === 0 && piece.isKing) ||
            (piece.color === 'black' && move.r === ROWS - 1 && piece.isKing);
        recorder.recordMove(currentPlayer, lastMoveFrom, lastMoveTo, move.capture, promoted, wasMultiJump, board, preMoveAvailable);

        // End of turn
        mustJumpPiece = null;
        selectedSquare = null;
        validMoves = [];
        switchTimer();
        currentPlayer = currentPlayer === 'white' ? 'black' : 'white';

        checkWin();
        updateStatus();
        renderBoard();
        emitMoveOnline();

        if (gameMode === 'aiva' && !isGameOver) {
            scheduleAiVsAiMove();
        } else if (gameMode === 'rvc' && !isGameOver) {
            scheduleRvcMove();
        } else if (gameMode === 'rvg' && !isGameOver) {
            scheduleRvgMove();
        } else if (gameMode === 'cvc' && !isGameOver) {
            scheduleCvcMove();
        } else if (currentPlayer === aiColor && !isGameOver) {
            if (gameMode === 'pvc') setTimeout(makeAIMove, computerDelayMs);
            else if (gameMode === 'claude') setTimeout(() => makeServerAIMove('/api/ai-move', 'Claude'), computerDelayMs);
            else if (gameMode === 'chatgpt') setTimeout(() => makeServerAIMove('/api/chatgpt-move', 'ChatGPT'), computerDelayMs);
        }
    }

    function emitMoveOnline() {
        if (gameMode === 'online' && socket) {
            socket.emit('move', { board, currentPlayer, isGameOver, mustJumpPiece });
        }
    }

    // ─── Win / stalemate ─────────────────────────────────────────────────────

    function checkWin() {
        let white = 0, black = 0;
        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                if (board[r][c]?.color === 'white') white++;
                if (board[r][c]?.color === 'black') black++;
            }
        }

        if (white === 0) {
            endGame('Чорні перемогли!', 'black');
        } else if (black === 0) {
            endGame('Білі перемогли!', 'white');
        } else if (getAllValidMoves(currentPlayer).length === 0) {
            const winnerColor = currentPlayer === 'white' ? 'black' : 'white';
            const winnerLabel = winnerColor === 'white' ? 'Білі' : 'Чорні';
            endGameReason = 'no_moves';
            endGame(`${winnerLabel} перемогли! (суперник не має ходів)`, winnerColor);
        }
    }

    function getScoreLabels() {
        if (gameMode === 'aiva') return { a: 'Claude', b: 'ChatGPT' };
        if (gameMode === 'rvc') return { a: "Комп'ютер", b: 'Claude' };
        if (gameMode === 'rvg') return { a: "Комп'ютер", b: 'ChatGPT' };
        if (gameMode === 'cvc') return { a: 'Білі', b: 'Чорні' };
        if (gameMode === 'pvc') return { a: 'Ви', b: "Комп'ютер" };
        if (gameMode === 'claude') return { a: 'Ви', b: 'Claude' };
        if (gameMode === 'chatgpt') return { a: 'Ви', b: 'ChatGPT' };
        if (gameMode === 'online') return { a: 'Ви', b: 'Суперник' };
        return { a: 'Гравець 1', b: 'Гравець 2' };
    }

    function colorToPlayer(color) {
        if (gameMode === 'pvc' || gameMode === 'claude' || gameMode === 'chatgpt') {
            return color === playerColor ? 'a' : 'b';
        }
        if (gameMode === 'online') {
            return color === myColor ? 'a' : 'b';
        }
        // PvP: Player 1 = white, Player 2 = black
        return color === 'white' ? 'a' : 'b';
    }

    let endGameReason = 'no_pieces'; // set before calling endGame

    function endGame(message, winnerColor) {
        isGameOver = true;
        stopTimer();
        if (winnerColor) {
            const player = colorToPlayer(winnerColor);
            score[player]++;
            updateScore();
        }
        recorder.finishRecording(winnerColor, endGameReason);
        endGameReason = 'no_pieces'; // reset default
        statusElement.textContent = message;
        renderBoard();
        updateHistoryPanelVisibility();
        setTimeout(() => loadHistorySidebar(), 600);

        const genAtEnd = gameGen;
        if (isAutoPlayMode(gameMode)) {
            autoPlayGameCount++;
            if (autoPlayGameCount >= autoPlayMaxGames) {
                statusElement.textContent = `${message} (серію з ${autoPlayMaxGames} ігор завершено)`;
                return;
            }
            setTimeout(() => {
                if (replayMode || gameGen !== genAtEnd) return;
                initGame();
            }, computerDelayMs);
        } else {
            setTimeout(() => {
                if (replayMode || gameGen !== genAtEnd) return;
                alert(message);
                initGame();
            }, 100);
        }
    }

    function updateScore() {
        const labels = getScoreLabels();
        scoreElement.textContent = `${labels.a} ${score.a} : ${score.b} ${labels.b}`;
    }

    // ─── All moves (with mandatory-capture filter) ───────────────────────────

    function getAllValidMoves(color) {
        const all = [];
        let hasCapture = false;

        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                const piece = board[r][c];
                if (piece && piece.color === color) {
                    getValidMoves(r, c, piece).forEach(m => {
                        all.push({ from: { r, c }, to: m });
                        if (m.capture) hasCapture = true;
                    });
                }
            }
        }

        return hasCapture ? all.filter(m => m.to.capture) : all;
    }

    // ─── AI ──────────────────────────────────────────────────────────────────

    function makeAIMove() {
        if (isGameOver) return;

        // If mid multi-jump, continue with the same piece
        if (mustJumpPiece) {
            const piece = board[mustJumpPiece.r][mustJumpPiece.c];
            if (piece) {
                const captures = getValidMoves(mustJumpPiece.r, mustJumpPiece.c, piece).filter(m => m.capture);
                if (captures.length > 0) {
                    selectedSquare = mustJumpPiece;
                    executeMove(captures[Math.floor(Math.random() * captures.length)]);
                    return;
                }
            }
        }

        const moves = getAllValidMoves(aiColor);
        if (moves.length === 0) {
            const winnerColor = aiColor === 'white' ? 'black' : 'white';
            const winnerLabel = winnerColor === 'white' ? 'Білі' : 'Чорні';
            endGame(`${winnerLabel} перемогли! (суперник не має ходів)`, winnerColor);
            return;
        }

        const pick = moves[Math.floor(Math.random() * moves.length)];
        selectedSquare = pick.from;
        executeMove(pick.to);
    }

    // ─── CvC (Computer vs Computer) ────────────────────────────────────────

    function makeCvcMove() {
        if (isGameOver) return;

        if (mustJumpPiece) {
            const piece = board[mustJumpPiece.r][mustJumpPiece.c];
            if (piece) {
                const captures = getValidMoves(mustJumpPiece.r, mustJumpPiece.c, piece).filter(m => m.capture);
                if (captures.length > 0) {
                    selectedSquare = mustJumpPiece;
                    executeMove(captures[Math.floor(Math.random() * captures.length)]);
                    return;
                }
            }
        }

        const moves = getAllValidMoves(currentPlayer);
        if (moves.length === 0) return;

        const pick = moves[Math.floor(Math.random() * moves.length)];
        selectedSquare = pick.from;
        executeMove(pick.to);
    }

    function scheduleCvcMove() {
        const gen = gameGen;
        setTimeout(() => { if (gameGen === gen) makeCvcMove(); }, computerDelayMs);
    }

    // ─── Server AI (Claude / ChatGPT) ──────────────────────────────────────

    async function makeServerAIMove(endpoint, label, forColor) {
        if (isGameOver || aiThinking) return;
        const moveColor = forColor || aiColor;

        let moves;
        if (mustJumpPiece) {
            const piece = board[mustJumpPiece.r][mustJumpPiece.c];
            if (!piece) return;
            const captures = getValidMoves(mustJumpPiece.r, mustJumpPiece.c, piece).filter(m => m.capture);
            if (captures.length === 0) return;
            moves = captures.map(m => ({ from: mustJumpPiece, to: m }));
        } else {
            moves = getAllValidMoves(moveColor);
        }

        if (moves.length === 0) {
            const winnerColor = moveColor === 'white' ? 'black' : 'white';
            const winnerLabel = winnerColor === 'white' ? 'Білі' : 'Чорні';
            endGame(`${winnerLabel} перемогли! (суперник не має ходів)`, winnerColor);
            return;
        }

        aiThinking = true;
        const currentGen = gameGen;
        aiStatusElement.textContent = `${label} думає...`;

        try {
            const resp = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ board, validMoves: moves, aiColor: moveColor })
            });
            if (gameGen !== currentGen) return;
            const data = await resp.json();
            const pick = moves[data.moveIndex] || moves[0];
            selectedSquare = pick.from;
            aiThinking = false;
            aiStatusElement.textContent = '';
            executeMove(pick.to);
        } catch (err) {
            if (gameGen !== currentGen) return;
            console.error(`${label} AI error:`, err);
            aiThinking = false;
            aiStatusElement.textContent = '';
            const pick = moves[Math.floor(Math.random() * moves.length)];
            selectedSquare = pick.from;
            executeMove(pick.to);
        }
    }

    // ─── AI vs AI (Claude vs ChatGPT) ──────────────────────────────────────

    function scheduleAiVsAiMove() {
        const gen = gameGen;
        const endpoint = currentPlayer === 'white' ? '/api/ai-move' : '/api/chatgpt-move';
        const label = currentPlayer === 'white' ? 'Claude' : 'ChatGPT';
        setTimeout(() => {
            if (gameGen === gen) makeServerAIMove(endpoint, label, currentPlayer);
        }, computerDelayMs);
    }

    // ─── Random vs Server AI (Computer vs Claude / Computer vs ChatGPT) ────

    function makeRandomMove() {
        if (isGameOver) return;

        if (mustJumpPiece) {
            const piece = board[mustJumpPiece.r][mustJumpPiece.c];
            if (piece) {
                const captures = getValidMoves(mustJumpPiece.r, mustJumpPiece.c, piece).filter(m => m.capture);
                if (captures.length > 0) {
                    selectedSquare = mustJumpPiece;
                    executeMove(captures[Math.floor(Math.random() * captures.length)]);
                    return;
                }
            }
        }

        const moves = getAllValidMoves(currentPlayer);
        if (moves.length === 0) return;

        const pick = moves[Math.floor(Math.random() * moves.length)];
        selectedSquare = pick.from;
        executeMove(pick.to);
    }

    function scheduleRvcMove() {
        const gen = gameGen;
        if (currentPlayer === 'white') {
            // Random side
            setTimeout(() => { if (gameGen === gen) makeRandomMove(); }, computerDelayMs);
        } else {
            // Claude side
            setTimeout(() => {
                if (gameGen === gen) makeServerAIMove('/api/ai-move', 'Claude', 'black');
            }, computerDelayMs);
        }
    }

    function scheduleRvgMove() {
        const gen = gameGen;
        if (currentPlayer === 'white') {
            // Random side
            setTimeout(() => { if (gameGen === gen) makeRandomMove(); }, computerDelayMs);
        } else {
            // ChatGPT side
            setTimeout(() => {
                if (gameGen === gen) makeServerAIMove('/api/chatgpt-move', 'ChatGPT', 'black');
            }, computerDelayMs);
        }
    }

    // ─── Replay ───────────────────────────────────────────────────────────────

    let replayMode = false;
    let replayData = null;
    let replayIndex = 0; // 0 = initial board, 1..N = after move N
    let replayAutoInterval = null;
    let savedGameState = null; // live game state saved when entering replay mid-game

    const gameControls = document.getElementById("gameControls");
    const replayControls = document.getElementById("replayControls");
    const replayCounter = document.getElementById("replayCounter");
    const replaySpeed = document.getElementById("replaySpeed");

    function updateHistoryPanelVisibility() {
        const panel = document.getElementById('historyPanel');
        if (!panel) return;
        const hide = gameMode === 'online' && !isGameOver;
        panel.style.display = hide ? 'none' : 'flex';
    }

    async function loadHistorySidebar() {
        const listEl = document.getElementById('historyList');
        if (!listEl) return;
        listEl.innerHTML = '<p style="padding:8px;color:#95a5a6;font-size:13px">Завантаження...</p>';
        try {
            const resp = await fetch('/api/games?limit=50');
            const data = await resp.json();
            if (data.games.length === 0) {
                listEl.innerHTML = '<p style="padding:8px;color:#95a5a6;font-size:13px">Немає записаних ігор</p>';
                return;
            }
            listEl.innerHTML = '';
            data.games.forEach(g => {
                const row = document.createElement('div');
                row.className = 'history-row';
                const date = new Date(g.startedAt).toLocaleString('uk-UA');
                const modeLabels = {
                    pvp: 'PvP', pvc: 'PvC', claude: 'Claude', chatgpt: 'ChatGPT',
                    aiva: 'AI vs AI', rvc: 'RvClaude', rvg: 'RvChatGPT', cvc: 'CvC', online: 'Online'
                };
                const resultLabel = g.result === 'white' ? 'Білі' : g.result === 'black' ? 'Чорні' : '—';
                row.innerHTML = `
                    <span class="history-date">${date}</span>
                    <span class="history-mode">${modeLabels[g.mode] || g.mode}</span>
                    <span class="history-result">Переміг: ${resultLabel}</span>
                    <span class="history-moves">${g.totalMoves} ходів</span>
                `;
                row.addEventListener('click', async () => {
                    const gameResp = await fetch(`/api/games/${g.id}`);
                    const game = await gameResp.json();
                    enterReplayMode(game);
                });
                listEl.appendChild(row);
            });
        } catch (err) {
            listEl.innerHTML = '<p style="padding:8px;color:#95a5a6;font-size:13px">Помилка завантаження</p>';
            console.error(err);
        }
    }

    function enterReplayMode(game) {
        // Save live game state if not already replaying
        if (!replayMode) {
            savedGameState = {
                board: JSON.parse(JSON.stringify(board)),
                currentPlayer,
                isGameOver,
                mustJumpPiece: mustJumpPiece ? { ...mustJumpPiece } : null,
                selectedSquare: selectedSquare ? { ...selectedSquare } : null,
                validMoves: validMoves.slice(),
                lastMoveFrom: lastMoveFrom ? { ...lastMoveFrom } : null,
                lastMoveTo: lastMoveTo ? { ...lastMoveTo } : null,
                timeWhite,
                timeBlack,
                aiStatusText: aiStatusElement.textContent,
            };
            gameGen++; // cancel in-flight AI moves / pending timeouts
            stopTimer();
        }
        replayMode = true;
        replayData = game;
        replayIndex = 0;
        gameControls.style.display = 'none';
        replayControls.style.display = 'flex';
        scoreElement.style.display = 'none';
        onlineInfo.style.display = 'none';
        stopReplayAuto();
        showReplayBoard();
    }

    function resumeAiIfNeeded() {
        if (gameMode === 'aiva') {
            scheduleAiVsAiMove();
        } else if (gameMode === 'rvc') {
            scheduleRvcMove();
        } else if (gameMode === 'rvg') {
            scheduleRvgMove();
        } else if (gameMode === 'cvc') {
            scheduleCvcMove();
        } else if (currentPlayer === aiColor) {
            if (gameMode === 'pvc') setTimeout(makeAIMove, computerDelayMs);
            else if (gameMode === 'claude') setTimeout(() => makeServerAIMove('/api/ai-move', 'Claude'), computerDelayMs);
            else if (gameMode === 'chatgpt') setTimeout(() => makeServerAIMove('/api/chatgpt-move', 'ChatGPT'), computerDelayMs);
        }
    }

    function exitReplayMode() {
        replayMode = false;
        replayData = null;
        stopReplayAuto();
        gameControls.style.display = 'flex';
        replayControls.style.display = 'none';
        scoreElement.style.display = '';

        if (savedGameState) {
            // Restore live game state
            board = savedGameState.board;
            currentPlayer = savedGameState.currentPlayer;
            isGameOver = savedGameState.isGameOver;
            mustJumpPiece = savedGameState.mustJumpPiece;
            selectedSquare = savedGameState.selectedSquare;
            validMoves = savedGameState.validMoves;
            lastMoveFrom = savedGameState.lastMoveFrom;
            lastMoveTo = savedGameState.lastMoveTo;
            timeWhite = savedGameState.timeWhite;
            timeBlack = savedGameState.timeBlack;
            aiStatusElement.textContent = savedGameState.aiStatusText;
            savedGameState = null;

            gameGen++; // fresh generation for resumed game
            if (gameMode === 'online' && !isGameOver) onlineInfo.style.display = 'block';
            updateHistoryPanelVisibility();
            updateStatus();
            renderBoard();

            if (!isGameOver) {
                startTimer();
                resumeAiIfNeeded();
            }
        } else {
            initGame();
        }
    }

    function showReplayBoard() {
        if (!replayData) return;
        const total = replayData.moves.length;
        replayCounter.textContent = `${replayIndex} / ${total}`;

        if (replayIndex === 0) {
            board = JSON.parse(JSON.stringify(replayData.initialBoard));
            lastMoveFrom = null;
            lastMoveTo = null;
            statusElement.textContent = `Перегляд: початок гри`;
        } else {
            const m = replayData.moves[replayIndex - 1];
            board = JSON.parse(JSON.stringify(m.boardAfter));
            lastMoveFrom = m.from;
            lastMoveTo = m.to;
            const playerLabel = m.player === 'white' ? 'Білі' : 'Чорні';
            statusElement.textContent = `Перегляд: хід ${replayIndex} (${playerLabel})`;
        }

        selectedSquare = null;
        validMoves = [];
        mustJumpPiece = null;
        isGameOver = replayIndex === total;
        renderBoard();
    }

    function stopReplayAuto() {
        clearInterval(replayAutoInterval);
        replayAutoInterval = null;
        const playBtn = document.getElementById("replayPlay");
        if (playBtn) playBtn.textContent = '\u25B6';
    }

    document.getElementById("replayFirst").addEventListener('click', () => {
        stopReplayAuto();
        replayIndex = 0;
        showReplayBoard();
    });

    document.getElementById("replayPrev").addEventListener('click', () => {
        stopReplayAuto();
        if (replayIndex > 0) { replayIndex--; showReplayBoard(); }
    });

    document.getElementById("replayNext").addEventListener('click', () => {
        stopReplayAuto();
        if (replayData && replayIndex < replayData.moves.length) { replayIndex++; showReplayBoard(); }
    });

    document.getElementById("replayLast").addEventListener('click', () => {
        stopReplayAuto();
        if (replayData) { replayIndex = replayData.moves.length; showReplayBoard(); }
    });

    document.getElementById("replayPlay").addEventListener('click', () => {
        if (!replayData) return;
        if (replayAutoInterval) {
            stopReplayAuto();
            return;
        }
        document.getElementById("replayPlay").textContent = '\u23F8';
        const speed = parseInt(replaySpeed.value) || 1000;
        replayAutoInterval = setInterval(() => {
            if (replayIndex < replayData.moves.length) {
                replayIndex++;
                showReplayBoard();
            } else {
                stopReplayAuto();
            }
        }, speed);
    });

    document.getElementById("replayExit").addEventListener('click', exitReplayMode);

    // ─── Controls ────────────────────────────────────────────────────────────

    modeSelect.addEventListener('change', initGame);

    restartBtn.addEventListener('click', () => {
        score.a = 0;
        score.b = 0;
        autoPlayGameCount = 0;
        if (gameMode === 'online' && socket) {
            socket.emit('restart');
        } else {
            initGame();
        }
    });

    giveUpBtn.addEventListener('click', () => {
        if (isGameOver) return;
        aiThinking = false;
        endGameReason = 'resignation';
        if (gameMode === 'pvp' || gameMode === 'cvc' || gameMode === 'aiva' || gameMode === 'rvc' || gameMode === 'rvg') {
            const loserLabel = currentPlayer === 'white' ? 'Білі' : 'Чорні';
            const winnerColor = currentPlayer === 'white' ? 'black' : 'white';
            const winnerLabel = winnerColor === 'white' ? 'Білі' : 'Чорні';
            endGame(`${loserLabel} здались! ${winnerLabel} перемогли!`, winnerColor);
        } else if (gameMode === 'pvc' || gameMode === 'claude' || gameMode === 'chatgpt') {
            endGame(`Ви здались! Суперник переміг!`, aiColor);
        } else if (gameMode === 'online' && socket && myColor !== 'spectator') {
            const winnerColor = myColor === 'white' ? 'black' : 'white';
            const winnerLabel = winnerColor === 'white' ? 'Білі' : 'Чорні';
            endGame(`Ви здались! ${winnerLabel} перемогли!`, winnerColor);
            emitMoveOnline();
        }
    });

    initGame();
    loadHistorySidebar();
});
