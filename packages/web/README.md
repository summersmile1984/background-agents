# Open-Inspect Web Client

Next.js web application for interacting with Open-Inspect coding sessions.

## Features

- GitHub and optional Google authentication through the control plane
- Session dashboard with list view
- Real-time streaming via WebSocket
- Message timeline with tool calls
- Connection-aware GitHub/Gitea repository picker
- Harness, model, reasoning-effort, environment, and branch selection for new sessions
- PR, screenshot/video, visual-verification, and live-preview artifacts
- Multi-participant presence indicators
- Responsive design for desktop and mobile

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Next.js App                               │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                       App Router                          │   │
│  │  /                  - Dashboard (session list)           │   │
│  │  /session/new       - Create new session                 │   │
│  │  /session/[id]      - Session view with streaming        │   │
│  │  /settings          - Settings (secrets management)      │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                      API Routes                           │   │
│  │  /api/auth/[...auth]     - Signed auth proxy             │   │
│  │  /api/sessions           - Session CRUD                  │   │
│  │  /api/repos              - Repository list               │   │
│  │  /api/repos/:owner/:name/secrets - Secrets CRUD          │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                        Hooks                              │   │
│  │  useSessionSocket - WebSocket connection + state         │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
              │                              │
              ▼                              ▼
      Signed Control Plane API       Session WebSocket
```

The Next.js server is a BFF: it forwards the opaque browser session cookie and signs calls to the
control plane. Browser code never receives GitHub App keys, Gitea PATs, sandbox capabilities, media
object keys, or Host model-provider credentials. Screenshot/video bytes stream through authenticated
Web API routes after the control plane verifies session ownership.

## Setup

### Prerequisites

- Node.js 22+
- A deployed control plane with at least one sign-in provider
- GitHub App bootstrap repository credentials configured on the control plane; optional Gitea
  connections are added later under Settings > Source Control

### Sign-In and GitHub App Setup

The control plane owns sign-in providers and repository credentials. A GitHub App installation is
required for repository access even when Google is the only sign-in provider. To enable GitHub
sign-in with that App:

1. Go to GitHub → Settings → Developer settings → GitHub Apps → New GitHub App
2. Set the **Callback URL** to: `https://your-domain.com/api/auth/callback/github`
3. Under **"Where can this GitHub App be installed?"**, select **"Any account"**

> **Important**: If you select "Only on this account", only users from that account will be able to
> authenticate. Other users will experience a redirect loop when trying to sign in.

> **Note for Organizations**: If your GitHub App is owned by an organization, the "Any account"
> setting should allow users outside the organization to authenticate, but this has not been
> extensively tested. Please verify this works for your use case.

Required repository permissions for the GitHub App:

- **Contents: Read & write** - for repository operations
- **Pull requests: Read & write** - for session pull request creation and labeling
- **Metadata: Read-only**
- **Issues: Read & write** - only when the GitHub bot is enabled

When GitHub sign-in uses email/domain admission, also grant **Account permissions: Email addresses
(read-only)**.

### Environment Variables

Create `.env.local`:

```bash
# Control Plane
CONTROL_PLANE_URL=http://localhost:8787
NEXT_PUBLIC_WS_URL=ws://localhost:8787
SERVICE_AUTH_SECRET=your_web_service_sig1_secret
```

The web app is a framework-free BFF. It signs requests with `SERVICE_AUTH_SECRET`, forwards only
Better Auth's opaque session cookie, and does not hold OAuth provider credentials or admission
policy. Configure those on the control plane through Terraform; `/login` resolves the enabled
provider set from that authority at request time.

### Development

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Type check
npm run typecheck

# Build for production
npm run build
```

## Pages

### Dashboard (`/`)

- Lists all user's sessions
- Shows session status, repository, and creation date
- Link to create new session

### New Session (`/session/new`)

- Source-control connection and repository selector (GitHub/Gitea), Environment selector, or
  repository-free scratch session
- Branch, Harness, model, reasoning effort, and optional title
- Creates session and redirects to session view

### Settings (`/settings`)

- Source-control connections and migration/preflight status
- Harness readiness and deployment credentials
- Global, repository, and Environment secrets and sandbox settings
- Model, MCP, managed skill, image-build, and integration configuration
- Secret values are encrypted in D1 and are never returned after write

### Session View (`/session/[id]`)

- Real-time WebSocket connection
- Message input with typing indicator
- Event timeline (tool calls, results, tokens)
- Streaming content display
- Participant presence list
- Stop button during execution
- Artifacts sidebar (PRs, screenshots, videos, and visual-verification reports)
- Live preview links from the session's normalized tunnel URL map

## WebSocket Protocol

The `useSessionSocket` hook manages:

1. **Connection**: Auto-connect with exponential backoff on disconnect
2. **Subscription**: Authenticates and subscribes to session
3. **Events**: Handles sandbox events (tokens, tool calls, etc.)
4. **Presence**: Tracks active participants
5. **Health**: Ping/pong every 30 seconds

## Styling

Uses Tailwind CSS with:

- Dark mode support via `prefers-color-scheme`
- Custom color variables
- Responsive design utilities

## State Management

Uses React state + hooks for simplicity. For larger apps, consider:

- Zustand for global state
- React Query for server state
- Jotai for atoms
