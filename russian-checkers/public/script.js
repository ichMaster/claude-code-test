document.addEventListener("DOMContentLoaded", () => {
    const boardElement = document.getElementById("board");
    const statusElement = document.getElementById("status");
    const restartBtn = document.getElementById("restartBtn");
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

    let socket = null;
    let myColor = null;
    let roomName = null;

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

        if (gameMode === 'online') {
            if (!socket) {
                setupSocket();
            } else {
                socket.emit('restart');
            }
        } else {
            updateStatus();
            renderBoard();
            if (gameMode === 'pvc' && currentPlayer === 'black') {
                setTimeout(makeAIMove, 500);
            }
        }
    }

    // ─── Socket / Online ─────────────────────────────────────────────────────

    function setupSocket() {
        socket = io();
        roomName = prompt("Enter room name (share this with your friend):", "room1") || "room1";
        onlineInfo.style.display = 'block';
        onlineInfo.textContent = `Connecting… Room: ${roomName}`;

        socket.emit('joinRoom', roomName);

        socket.on('assignedColor', (color) => {
            myColor = color;
            const label = color === 'white' ? 'White' : color === 'black' ? 'Black' : 'Spectator';
            onlineInfo.textContent = `Room: ${roomName} | You are: ${label}`;
        });

        socket.on('playerCount', (count) => {
            if (myColor === 'spectator') return;
            const label = myColor === 'white' ? 'White' : 'Black';
            if (count < 2) {
                onlineInfo.textContent = `Room: ${roomName} | You are: ${label} | Waiting for opponent…`;
            } else {
                onlineInfo.textContent = `Room: ${roomName} | You are: ${label} | Game on!`;
            }
        });

        socket.on('opponentDisconnected', () => {
            if (myColor !== 'spectator') {
                alert('Opponent disconnected!');
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
        const turnLabel = currentPlayer === 'white' ? 'White' : 'Black';
        if (gameMode === 'online') {
            if (currentPlayer === myColor) {
                statusElement.textContent = `Your turn (${turnLabel})`;
            } else {
                statusElement.textContent = `Opponent's turn (${turnLabel})`;
            }
        } else {
            statusElement.textContent = `Turn: ${turnLabel}`;
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

        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
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
        if (gameMode === 'pvc' && currentPlayer === 'black') return;
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
                    if (gameMode === 'pvc' && currentPlayer === 'black' && !isGameOver) {
                        setTimeout(makeAIMove, 500);
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
        currentPlayer = currentPlayer === 'white' ? 'black' : 'white';

        checkWin();
        updateStatus();
        renderBoard();
        emitMoveOnline();

        if (gameMode === 'pvc' && currentPlayer === 'black' && !isGameOver) {
            setTimeout(makeAIMove, 500);
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
            endGame('Black wins!');
        } else if (black === 0) {
            endGame('White wins!');
        } else if (getAllValidMoves(currentPlayer).length === 0) {
            const winner = currentPlayer === 'white' ? 'Black' : 'White';
            endGame(`${winner} wins! (opponent has no moves)`);
        }
    }

    function endGame(message) {
        isGameOver = true;
        statusElement.textContent = message;
        setTimeout(() => alert(message), 100);
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

        const moves = getAllValidMoves('black');
        if (moves.length === 0) {
            endGame('White wins! (Black has no moves)');
            return;
        }

        const pick = moves[Math.floor(Math.random() * moves.length)];
        selectedSquare = pick.from;
        executeMove(pick.to);
    }

    // ─── Controls ────────────────────────────────────────────────────────────

    modeSelect.addEventListener('change', initGame);

    restartBtn.addEventListener('click', () => {
        if (gameMode === 'online' && socket) {
            socket.emit('restart');
        } else {
            initGame();
        }
    });

    initGame();
});
