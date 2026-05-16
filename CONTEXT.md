# ShipNode Domain Model

## Domain Terms

### Config
The user's intent for how to deploy their application. Captured through the builder DSL or a plain object and then **assembled** into a trusted `ShipnodeConfig`.

### ShipnodeConfig
The fully-validated, canonical configuration object. All commands receive this after assembly. Immutable boundary: nothing mutates a ShipnodeConfig after creation.

### Assembly
The single pipeline that turns raw user intent (builder or plain object) into a validated `ShipnodeConfig`. Owns all defaults and validation in one place.

### RemoteExecutor
A seam for executing commands on a remote host. Implementations include `SshConnection` (real SSH) and `FakeRemoteExecutor` (tests). Callers do not know which implementation they hold.

### SshConnection
The concrete adapter satisfying `RemoteExecutor` over SSH2. Owns connection lifecycle, authentication, and wire-protocol details.

### Release
A snapshot of the application code deployed at a point in time. In zero-downtime mode, releases live in `/remotePath/releases/<timestamp>/`.

### Current
A symlink pointing to the active release. In zero-downtime mode, `/remotePath/current` is atomically switched to a new release.

### ReleaseManager
Owns release directory creation, symlink switching, release recording, and cleanup. Operates through a `RemoteExecutor`.

### DeployLock
A PID-based lock file preventing concurrent deployments. Lives at `/remotePath/.shipnode/deploy.lock`.

### Zero-Downtime
The deployment mode where a new release is staged, then atomically switched via symlink. The old release remains available until the switch succeeds and health checks pass.

### Legacy
The deployment mode where files are rsynced directly to the remote path. No releases, no symlinks, no rollback.

### DeployOrchestrator
Owns the invariant deployment sequence: lock → release → stage → setup → hooks → symlink → start → health check → record → cleanup → unlock. Knows nothing about app-specific details.

### DeploymentStrategy
An adapter that knows how to stage, prepare, and start a specific kind of application (backend, frontend, etc.). Plugs into the orchestrator at fixed lifecycle hooks.

### BackendStrategy
Stages source files, installs dependencies on the remote host, builds remotely, and reloads PM2.

### FrontendStrategy
Builds locally, stages build output, and relies on Caddy to serve static files.

### Hook
User-provided function that runs at a fixed point in the deployment lifecycle. `preDeploy` runs before the app goes live; `postDeploy` runs after cleanup.

### HealthCheck
A remote curl-based check that verifies the backend application is responding after a deployment. Only runs for backend apps in zero-downtime mode.

### Caddy
The reverse proxy / static file server configured per-deployment. `CaddyService` writes config to `/etc/caddy/conf.d/` and reloads the service.

### CommandRunner
Owns config-loading and SSH lifecycle for CLI commands. Each command is pure business logic that receives an already-connected executor.

## Architectural Boundaries

- **Config seam**: `assembleConfig` is the only entry point from raw config → trusted config.
- **Remote seam**: `RemoteExecutor` is the only way services talk to the remote host.
- **Deployment seam**: `DeployOrchestrator` + `DeploymentStrategy` split invariant sequence from app-specific behaviour.
- **CLI seam**: `runRemoteCommand` / `runLocalCommand` separate connection ceremony from command logic.
