# CloudPuzzle — Multiplayer Cloud-Ready Application

Multiplayer image-puzzle web application built with Node.js, Server-Sent Events (SSE), and built-in SQLite persistence (`node:sqlite`).

---

## 1. System Architecture

```
Developer
    │
    ▼ git push / PR
 GitHub Repository
    │
    ▼ triggers
 GitHub Actions CI/CD
    │
    ├── Step 1: Syntax Validation (`node --check`)
    ├── Step 2: Automated Tests (`npm test`) -> Ephemeral isolated SQLite
    └── Step 3: Docker Build Verification (`docker build`)
    │
    ▼ (on CI pass & deployment trigger)
 Render Cloud Instance (Single Container Docker Web Service)
    │
    ├── Node.js 22 Application Server (0.0.0.0:3000)
    │     ├── Health Check (`GET /health`)
    │     ├── REST API (`/api/games/*`)
    │     ├── Real-time SSE Stream (`/api/games/:code/events`)
    │     └── Graceful Shutdown Handlers (`SIGTERM`, `SIGINT`)
    │
    ├── Attached Render Persistent Disk (Mounted at `/app/data`)
    │     └── SQLite Database (`cloud-puzzle.sqlite`)
    │
    ▼ SSE + HTTP
 Connected Players (Web Browsers)
```

---

## 2. Local Development & Testing

### Prerequisites
- Node.js **>= 22.5.0** (required for `node:sqlite`).

### Running Locally
```bash
npm start
```
The application will listen on `http://0.0.0.0:3000` (or the port defined in `PORT`).

### Running Automated Tests
```bash
npm test
```
The test suite validates:
- Tile grid mathematics and column ownership partitions for 5×5, 6×6, and 9×9 puzzles.
- Correct/incorrect swap validation and boundaries.
- `/health` endpoint response (`HTTP 200 { status: 'ok' }`).
- REST endpoints (`/api/games`, `/join`, `/swap`).
- Real-time Server-Sent Events broadcasting.
- SQLite persistence across a full server process kill and restart.
- Isolated temporary database cleanup (never mutates local development data).

---

## 3. Docker Containerization

The production `Dockerfile` uses `node:22-alpine` for a minimal, secure container footprint running as a non-root user (`node`).

### Build Container Image
```bash
docker build -t cloud-puzzle .
```

### Run Locally with Persistent Volume
```bash
# 1. Create a persistent named Docker volume
docker volume create cloud-puzzle-data

# 2. Run the container attaching the volume
docker run -d \
  --name cloud-puzzle-app \
  -p 3000:3000 \
  -v cloud-puzzle-data:/app/data \
  cloud-puzzle
```

### Container Lifecycle & Persistence Mechanics
- **Stopping a container (`docker stop cloud-puzzle-app`):** The server intercepts `SIGTERM`, safely completes pending SQLite transactions, closes the database connection cleanly, and exits. The database file remains safely stored in `cloud-puzzle-data`.
- **Recreating or upgrading container:** A newly deployed container attaching `cloud-puzzle-data` automatically restores all saved rooms and player progress upon boot.
- **Deleting a container (`docker rm cloud-puzzle-app`):** Does **NOT** delete the persistent volume.
- **Deleting the persistent volume (`docker volume rm cloud-puzzle-data`):** Permanently erases all saved game states and databases.

---

## 4. Render Cloud Deployment Guide

Render is configured as a Docker Web Service with an attached Persistent Disk.

### Important Hosting & Pricing Notice
- **Persistent Disk Requirement:** Render's Free tier **does not support Persistent Disks**. Running a SQLite database that persists across restarts and redeploys requires an instance type of **Starter** or higher.
- **Expected Cost:**
  - **Starter Web Service:** $7.00 / month (0.5 CPU, 512MB RAM)
  - **Persistent Disk (1 GB):** $0.25 / month
  - **Total:** **$7.25 / month** (Render bills prorated to the second).

---

### Deployment Option A: Using Render Blueprints (`render.yaml`)

The repository includes a [render.yaml](file:///c:/Users/Aryan%20lol/Desktop/cloud-puzzle-refined/cloud-puzel/render.yaml) specification:
1. In the Render Dashboard, click **New +** > **Blueprint**.
2. Select your GitHub repository.
3. Render will read `render.yaml`, automatically configuring:
   - Service Name: `cloud-puzzle`
   - Runtime: `Docker`
   - Plan: `starter`
   - Health Check: `/health`
   - Persistent Disk: `cloud-puzzle-data` mounted at `/app/data` (1 GB)
   - Environment Variables: `PORT=3000`, `NODE_ENV=production`, `CLOUD_PUZZLE_DB=/app/data/cloud-puzzle.sqlite`
4. Click **Apply** to deploy.

---

### Deployment Option B: Manual Setup via Render Dashboard

If configuring manually without Blueprints:

1. Click **New +** > **Web Service**.
2. Connect your GitHub repository.
3. Configure the following fields:
   - **Name:** `cloud-puzzle`
   - **Region:** Choose nearest (e.g., `Oregon (US West)` or `Frankfurt (EU Central)`).
   - **Branch:** `main`
   - **Root Directory:** `cloud-puzel` (leave blank if the repo root is the app directory).
   - **Runtime:** `Docker`
   - **Instance Type:** `Starter` ($7/mo)
4. Under **Advanced**:
   - **Health Check Path:** `/health`
   - **Auto-Deploy:** `Yes`
5. Under **Environment Variables**:
   - `PORT`: `3000`
   - `NODE_ENV`: `production`
   - `CLOUD_PUZZLE_DB`: `/app/data/cloud-puzzle.sqlite`
6. Under **Disks** (bottom of page):
   - Click **Add Disk**
   - **Name:** `cloud-puzzle-data`
   - **Mount Path:** `/app/data`
   - **Size:** `1 GB`
7. Click **Create Web Service**.

---

## 5. Continuous Deployment (CI/CD)

Located at `.github/workflows/ci.yml`.

### How CI/CD Works:
1. **Pull Requests & Non-Main Pushes:** The `test` job executes syntax checks, the automated test suite (`npm test`), and Docker image validation.
2. **Main Branch Pushes:**
   - **Option 1 (Native Render Auto-Deploy - Recommended):** Under Render Dashboard > Web Service > **Settings** > **Build & Deploy**, ensure **Auto-Deploy** is set to `Yes`. Render automatically detects GitHub status checks and triggers deployment only after the GitHub Actions CI checks turn green.
   - **Option 2 (GitHub Actions Deploy Hook):** If you prefer GitHub Actions to trigger the deploy explicitly, copy your Render Deploy Hook URL (from Settings > Deploy Hook) and add it to your GitHub Repository Secrets as `RENDER_DEPLOY_HOOK_URL`. The workflow's `deploy` job will ping the hook automatically after tests pass.

---

## 6. Verifying the Live Service

Once deployed on Render:
1. **Health Verification:** Visit `https://<your-service>.onrender.com/health` in your browser. It should return HTTP 200:
   ```json
   { "status": "ok", "uptime": 12, "rooms": 0 }
   ```
2. **Multiplayer Room Sync:**
   - Open `https://<your-service>.onrender.com` in Browser Window A.
   - Create a puzzle room and copy the Room Code.
   - Open Browser Window B (or Incognito mode), join using the same Room Code.
   - Perform a valid tile swap in Window A and verify Window B updates instantly via SSE.
3. **Persistence Across Restart:**
   - In the Render Dashboard, click **Manual Deploy** > **Deploy latest commit** (or restart the service).
   - Once the service restarts, refresh the browser window or query `/health` — `rooms` will reflect restored rooms.
   - Re-enter the room code or reload the session — game state is restored from `/app/data/cloud-puzzle.sqlite`.

---

## 7. Known Architectural Scope & Limitations

1. **Single Instance Constraint:** SQLite is an embedded database running in the local filesystem. The service must run with exactly 1 instance (`numInstances: 1`). Do not scale horizontally across multiple instances without distributed SQLite tooling (e.g. LiteFS).
2. **Deployment Downtime:** Because a persistent disk cannot be mounted simultaneously by multiple instances, Render stops the old container before launching the new container during redeploys. Expect a brief ~30–60 second downtime during new deployments.
