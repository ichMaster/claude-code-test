document.addEventListener("DOMContentLoaded", () => {
    const boardElement = document.getElementById("board");
    const statusElement = document.getElementById("status");
    const restartBtn = document.getElementById("restartBtn");
    const giveUpBtn = document.getElementById("giveUpBtn");
    const scoreElement = document.getElementById("score");
    const modeSelect = document.getElementById("modeSelect");
    const onlineInfo = document.getElementById("onlineInfo");

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

    function formatTime(sec) {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    }

    function updateTimerDisplay() {
        const now = turnStartTime ? Math.floor((Date.now() - turnStartTime) / 1000) : 0;
        const wt = currentPlayer === 'white' ? timeWhite + now : timeWhite;
        const bt = currentPlayer === 'black' ? timeBlack + now : timeBlack;
        timerWhiteEl.textContent = `Білі: ${formatTime(wt)}`;
        timerBlackEl.textContent = `Чорні: ${formatTime(bt)}`;
    }

    function startTimer() {
        turnStartTime = Date.now();
        clearInterval(timerInterval);
        timerInterval = setInterval(updateTimerDisplay, 1000);
    }

    function switchTimer() {
        if (turnStartTime) {
            const elapsed = Math.floor((Date.now() - turnStartTime) / 1000);
            if (currentPlayer === 'white') timeWhite += elapsed;
            else timeBlack += elapsed;
        }
        startTimer();
    }

    function stopTimer() {
        if (turnStartTime) {
            const elapsed = Math.floor((Date.now() - turnStartTime) / 1000);
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
    let claudeThinking = false;

    // ─── Board labels ────────────────────────────────────────────────────────

    function isFlipped() {
        if (gameMode === 'pvc' || gameMode === 'claude') return playerColor === 'black';
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

    function initGame() {
        gameMode = modeSelect.value;

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

        claudeThinking = false;
        gameGen++;

        if (gameMode === 'pvc' || gameMode === 'claude') {
            playerColor = playerColor === 'white' ? 'black' : 'white';
            aiColor = playerColor === 'white' ? 'black' : 'white';
        }

        updateLabels();
        updateScore();
        resetTimers();

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
            if (gameMode === 'pvc' && currentPlayer === aiColor) {
                setTimeout(makeAIMove, 500);
            }
            if (gameMode === 'claude' && currentPlayer === aiColor) {
                setTimeout(makeClaudeMove, 500);
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
        } else if (gameMode === 'pvc' || gameMode === 'claude') {
            const yourLabel = playerColor === 'white' ? 'Білі' : 'Чорні';
            if (currentPlayer === playerColor) {
                statusElement.textContent = `Ваш хід (${yourLabel})`;
            } else {
                statusElement.textContent = `Хід суперника (${turnLabel})`;
            }
        } else {
            statusElement.textContent = `Хід: ${turnLabel}`;
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
        if (isGameOver) return;
        if (gameMode === 'pvc' && currentPlayer !== playerColor) return;
        if (gameMode === 'claude' && currentPlayer !== playerColor) return;
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
                    mustJumpPiece = { r: move.r, c: move.c };
                    selectedSquare = { r: move.r, c: move.c };
                    validMoves = furtherCaptures;
                    updateStatus();
                    renderBoard();
                    emitMoveOnline();
                    if (gameMode === 'pvc' && currentPlayer === aiColor && !isGameOver) {
                        setTimeout(makeAIMove, 500);
                    }
                    if (gameMode === 'claude' && currentPlayer === aiColor && !isGameOver) {
                        setTimeout(makeClaudeMove, 500);
                    }
                    return; // stay on this player's turn
                }
            }
        } else {
            // Non-capture: promote if reached last row
            if (piece.color === 'white' && move.r === 0) piece.isKing = true;
            if (piece.color === 'black' && move.r === ROWS - 1) piece.isKing = true;
        }

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

        if (gameMode === 'pvc' && currentPlayer === aiColor && !isGameOver) {
            setTimeout(makeAIMove, 500);
        }
        if (gameMode === 'claude' && currentPlayer === aiColor && !isGameOver) {
            setTimeout(makeClaudeMove, 500);
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
            endGame(`${winnerLabel} перемогли! (суперник не має ходів)`, winnerColor);
        }
    }

    function getScoreLabels() {
        if (gameMode === 'pvc') return { a: 'Ви', b: "Комп'ютер" };
        if (gameMode === 'claude') return { a: 'Ви', b: 'Claude' };
        if (gameMode === 'online') return { a: 'Ви', b: 'Суперник' };
        return { a: 'Гравець 1', b: 'Гравець 2' };
    }

    function colorToPlayer(color) {
        if (gameMode === 'pvc' || gameMode === 'claude') {
            return color === playerColor ? 'a' : 'b';
        }
        if (gameMode === 'online') {
            return color === myColor ? 'a' : 'b';
        }
        // PvP: Player 1 = white, Player 2 = black
        return color === 'white' ? 'a' : 'b';
    }

    function endGame(message, winnerColor) {
        isGameOver = true;
        stopTimer();
        if (winnerColor) {
            const player = colorToPlayer(winnerColor);
            score[player]++;
            updateScore();
        }
        statusElement.textContent = message;
        renderBoard();
        setTimeout(() => {
            alert(message);
            initGame();
        }, 100);
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

    // ─── Claude AI ─────────────────────────────────────────────────────────

    async function makeClaudeMove() {
        if (isGameOver || claudeThinking) return;

        let moves;
        if (mustJumpPiece) {
            const piece = board[mustJumpPiece.r][mustJumpPiece.c];
            if (!piece) return;
            const captures = getValidMoves(mustJumpPiece.r, mustJumpPiece.c, piece).filter(m => m.capture);
            if (captures.length === 0) return;
            moves = captures.map(m => ({ from: mustJumpPiece, to: m }));
        } else {
            moves = getAllValidMoves(aiColor);
        }

        if (moves.length === 0) {
            const winnerColor = aiColor === 'white' ? 'black' : 'white';
            const winnerLabel = winnerColor === 'white' ? 'Білі' : 'Чорні';
            endGame(`${winnerLabel} перемогли! (суперник не має ходів)`, winnerColor);
            return;
        }

        claudeThinking = true;
        const currentGen = gameGen;
        statusElement.textContent = 'Claude думає...';

        try {
            const resp = await fetch('/api/ai-move', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ board, validMoves: moves, aiColor })
            });
            if (gameGen !== currentGen) return;
            const data = await resp.json();
            const pick = moves[data.moveIndex] || moves[0];
            selectedSquare = pick.from;
            claudeThinking = false;
            executeMove(pick.to);
        } catch (err) {
            if (gameGen !== currentGen) return;
            console.error('Claude AI error:', err);
            claudeThinking = false;
            const pick = moves[Math.floor(Math.random() * moves.length)];
            selectedSquare = pick.from;
            executeMove(pick.to);
        }
    }

    // ─── Controls ────────────────────────────────────────────────────────────

    modeSelect.addEventListener('change', initGame);

    restartBtn.addEventListener('click', () => {
        score.a = 0;
        score.b = 0;
        if (gameMode === 'online' && socket) {
            socket.emit('restart');
        } else {
            initGame();
        }
    });

    giveUpBtn.addEventListener('click', () => {
        if (isGameOver) return;
        claudeThinking = false;
        if (gameMode === 'pvp') {
            const loserLabel = currentPlayer === 'white' ? 'Білі' : 'Чорні';
            const winnerColor = currentPlayer === 'white' ? 'black' : 'white';
            const winnerLabel = winnerColor === 'white' ? 'Білі' : 'Чорні';
            endGame(`${loserLabel} здались! ${winnerLabel} перемогли!`, winnerColor);
        } else if (gameMode === 'pvc' || gameMode === 'claude') {
            endGame(`Ви здались! Суперник переміг!`, aiColor);
        } else if (gameMode === 'online' && socket && myColor !== 'spectator') {
            const winnerColor = myColor === 'white' ? 'black' : 'white';
            const winnerLabel = winnerColor === 'white' ? 'Білі' : 'Чорні';
            endGame(`Ви здались! ${winnerLabel} перемогли!`, winnerColor);
            emitMoveOnline();
        }
    });

    initGame();
});
