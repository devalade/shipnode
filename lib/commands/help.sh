cmd_help() {
    cat << EOF
ShipNode v$VERSION - Simple Node.js Deployment Tool

Usage: shipnode <command> [options]

Commands:
    init                        Create shipnode.conf (interactive wizard)
    init --template <name>      Create config from framework template
    init --list-templates       List available framework templates
    init --non-interactive      Create basic shipnode.conf without prompts
    setup                       First-time server setup (Node, PM2, Caddy, jq)
    deploy              Deploy the application
    deploy --skip-build Deploy without running build step
    doctor              Run pre-flight diagnostic checks
    env                 Upload .env file to server
    status              Check application status
    logs                View application logs (backend only)
    restart             Restart application (backend only)
    stop                Stop application (backend only)
    unlock              Clear deployment lock (if stuck)
    rollback [N]        Rollback to previous release (or N steps back)
    releases            List all available releases
    migrate             Migrate existing deployment to release structure
    upgrade             Upgrade ShipNode to latest version
    help                Show this help message

User Management:
    user sync           Sync users from users.yml to server
    user list           List all provisioned users
    user remove <user>  Revoke access for a specific user
    mkpasswd            Generate password hash for users.yml

Configuration:
    Edit shipnode.conf to configure your deployment settings.
    Supports both backend (Node.js + PM2) and frontend (static files) apps.

Zero-Downtime Deployment:
    ZERO_DOWNTIME=true           Enable atomic deployments (default)
    KEEP_RELEASES=5              Number of releases to keep (default: 5)
    HEALTH_CHECK_ENABLED=true    Enable health checks (default: true)
    HEALTH_CHECK_PATH=/health    Health endpoint (default: /health)
    HEALTH_CHECK_TIMEOUT=30      Health check timeout seconds (default: 30)
    HEALTH_CHECK_RETRIES=3       Number of health check retries (default: 3)

User Provisioning:
    Create users.yml with user definitions, then run 'shipnode user sync'.
    Generate password hashes with 'shipnode mkpasswd'.

Templates:
    Use framework templates to skip auto-detection and get preset configurations:

    Backend:     express, nestjs, fastify, koa, hapi, hono, adonisjs
    Fullstack:   nextjs, nuxt, remix, astro
    Frontend:    react, vue, svelte, angular, solid, custom

Examples:
    shipnode init                      # Create config file
    shipnode init --template express   # Use Express.js template
    shipnode init --template nextjs    # Use Next.js template
    shipnode init --template react     # Use React template
    shipnode init --list-templates     # List all available templates
    shipnode setup                     # Setup server (first time)
    shipnode doctor                    # Run diagnostics
    shipnode deploy                    # Deploy your app
    shipnode env                       # Upload .env file to server
    shipnode unlock                    # Clear stuck deployment lock
    shipnode rollback                  # Rollback to previous release
    shipnode rollback 2                # Rollback 2 releases back
    shipnode releases                  # List all releases
    shipnode migrate                   # Migrate to release structure
    shipnode mkpasswd                  # Generate password hash
    shipnode user sync                 # Provision users from users.yml
    shipnode user list                 # List provisioned users
    shipnode user remove alice         # Revoke access for alice

EOF
}

# Main command dispatcher
