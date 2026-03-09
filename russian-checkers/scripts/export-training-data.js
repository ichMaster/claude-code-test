#!/usr/bin/env node
/**
 * Export training data from recorded games as JSONL.
 *
 * Usage:
 *   node scripts/export-training-data.js [options]
 *
 * Options:
 *   --agent <type>     Filter by agent (claude, chatgpt, human, random)
 *   --result <win|loss|all>  Filter by game result relative to the moving player
 *   --min-moves <n>    Minimum game length
 *   --output <file>    Output file (default: stdout)
 */

const fs = require('fs');
const path = require('path');

const GAMES_DIR = path.join(__dirname, '..', 'data', 'games');

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name) {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

const filterAgent = getArg('--agent');
const filterResult = getArg('--result') || 'all';
const minMoves = parseInt(getArg('--min-moves')) || 0;
const outputFile = getArg('--output');

if (!fs.existsSync(GAMES_DIR)) {
    console.error('No games directory found at', GAMES_DIR);
    process.exit(1);
}

const files = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'));
if (files.length === 0) {
    console.error('No game files found');
    process.exit(1);
}

const output = outputFile ? fs.createWriteStream(outputFile) : process.stdout;
let sampleCount = 0;

for (const file of files) {
    const game = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, file), 'utf8'));
    if (game.metadata.totalMoves < minMoves) continue;

    const resultWinner = game.metadata.result.winner;

    for (const move of game.moves) {
        const agentType = game.metadata.players[move.player]?.agent || 'unknown';
        if (filterAgent && agentType !== filterAgent) continue;

        const gameResult = !resultWinner ? 0 : (move.player === resultWinner ? 1 : -1);
        if (filterResult === 'win' && gameResult !== 1) continue;
        if (filterResult === 'loss' && gameResult !== -1) continue;

        // Get board state BEFORE this move
        const boardSource = move.moveNumber === 1
            ? game.initialBoard
            : game.moves[move.moveNumber - 2]?.boardAfter || game.initialBoard;

        const boardNumeric = [];
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                const cell = boardSource[r]?.[c];
                if (!cell) { boardNumeric.push(0); continue; }
                if (cell.color === 'white') boardNumeric.push(cell.isKing ? 2 : 1);
                else boardNumeric.push(cell.isKing ? 4 : 3);
            }
        }

        const availMoves = (move.availableMoves || []).map(m => ({
            from: m.from.r * 8 + m.from.c,
            to: m.to.r * 8 + m.to.c,
            capture: m.to.capture ? m.to.capture.r * 8 + m.to.capture.c : null,
        }));

        const chosenFrom = move.from.r * 8 + move.from.c;
        const chosenTo = move.to.r * 8 + move.to.c;
        const chosenMoveIndex = availMoves.findIndex(m => m.from === chosenFrom && m.to === chosenTo);

        const sample = {
            board: boardNumeric,
            currentPlayer: move.player === 'white' ? 1 : -1,
            availableMoves: availMoves,
            chosenMoveIndex,
            gameResult,
            moveNumber: move.moveNumber,
            totalMoves: game.metadata.totalMoves,
            agentType,
        };

        output.write(JSON.stringify(sample) + '\n');
        sampleCount++;
    }
}

if (outputFile) {
    output.end();
    console.error(`Exported ${sampleCount} samples to ${outputFile}`);
} else {
    console.error(`Exported ${sampleCount} samples`);
}
