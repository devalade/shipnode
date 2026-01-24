# Changelog

All notable changes to ShipNode will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-01-24

### Added

#### Zero-Downtime Deployment System
- **Release-based deployments**: Each deployment creates a timestamped release in `releases/` directory
- **Atomic symlink switching**: `current` symlink points to active release, switched atomically for zero downtime
- **Release directory structure**:
  - `releases/YYYYMMDDHHMMSS/` - Timestamped release directories
  - `current` - Symlink to active release
  - `shared/` - Shared resources (.env, logs) persisted across releases
  - `.shipnode/` - Deployment metadata (releases.json, deploy.lock)

#### Health Checks
- Automatic health check validation after backend deployments
- Configurable health endpoint, timeout, and retry count
- Automatic rollback to previous release on health check failure
- Health check verification after manual rollbacks

#### Release Management
- `shipnode rollback [N]` - Rollback to previous release or N steps back
- `shipnode releases` - List all available releases with current marker
- `shipnode migrate` - Migrate existing deployments to release structure
- Automatic cleanup of old releases (configurable retention)
- JSON-based release history tracking

#### Deployment Safety
- Deployment lock file prevents concurrent deployments
- Stale lock detection and automatic cleanup
- Per-release dependency installation (isolated node_modules)
- Shared .env file symlinking across releases

#### Configuration Options
- `ZERO_DOWNTIME` - Enable/disable zero-downtime deployment (default: true)
- `KEEP_RELEASES` - Number of releases to retain (default: 5)
- `HEALTH_CHECK_ENABLED` - Enable/disable health checks (default: true)
- `HEALTH_CHECK_PATH` - Health check endpoint path (default: /health)
- `HEALTH_CHECK_TIMEOUT` - Health check timeout in seconds (default: 30)
- `HEALTH_CHECK_RETRIES` - Number of retry attempts (default: 3)

#### Server Setup
- Automatic `jq` installation for JSON manipulation in release tracking

### Changed
- `shipnode setup` now installs `jq` for release management
- Caddy configuration updated to serve from `current/` symlink when zero-downtime is enabled
- `shipnode init` now includes zero-downtime config options in generated `shipnode.conf`
- `shipnode help` updated with new commands and configuration documentation

### Fixed
- Improved error handling for deployment failures
- Better concurrency control with deployment locks

### Documentation
- Comprehensive zero-downtime deployment guide in README
- Health check setup examples for Express and Fastify
- Migration instructions for existing deployments
- Troubleshooting section for new features
- Updated configuration reference
- Example workflows for deployments and rollbacks

### Backward Compatibility
- Fully backward compatible - existing deployments continue to work
- Zero-downtime can be disabled with `ZERO_DOWNTIME=false` for legacy behavior
- Migration command available for gradual adoption

## [1.0.0] - 2024-01-20

### Added
- Initial release of ShipNode
- Backend deployment support (Node.js + PM2)
- Frontend deployment support (static files)
- Automatic server setup (Node.js, PM2, Caddy)
- SSH-based deployment via rsync
- Caddy reverse proxy configuration for backends
- Caddy static file server for frontends
- PM2 process management
- Application status monitoring
- Log streaming for backend apps
- Restart and stop commands for backend apps
- Simple configuration via `shipnode.conf`

[1.1.0]: https://github.com/devalade/shipnode/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/devalade/shipnode/releases/tag/v1.0.0
