# Russian Checkers

Multiplayer Russian Checkers game built with Node.js, Express, and Socket.io.

Two players connect to the same room and play in real time. Additional connections join as spectators.

## Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later)

## Local Development

```bash
# Install dependencies
npm install

# Start the server
npm start
```

The game will be available at `http://localhost:8080`.

## Deploy to Railway

1. Push this project to a GitHub repository.

2. Go to [railway.app](https://railway.app) and create a new project from your GitHub repo.

3. If the app lives in a subdirectory, go to your service **Settings** → **Build** and set:
   - **Build Command**: `cd russian-checkers && npm ci`
   - **Start Command**: `cd russian-checkers && node server.js`

4. Under **Settings** → **Networking**, click **Generate Domain** to get a public URL.

Railway will automatically redeploy on every push to the `main` branch.

## How to Play

1. Open the app URL in your browser — you are assigned **white** and move first.
2. Share the same URL with a friend — they are assigned **black**.
3. Click a piece to select it, then click a highlighted square to move.
4. Jumps are mandatory. Multi-jumps are supported.
5. A piece that reaches the last row becomes a **king** and can move diagonally in any direction.
