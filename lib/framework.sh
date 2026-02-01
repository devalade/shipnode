# FRAMEWORK DETECTION & AUTO-CONFIGURATION
# ============================================================================

# Parse package.json safely and extract dependencies
# Validates JSON format and extracts both dependencies and devDependencies
# Args:
#   $1: Path to package.json file (default: ./package.json)
# Returns:
#   Comma-separated list of package names, or empty string on failure
# Exit codes:
#   0: Success, dependencies found
#   1: File not found, invalid JSON, or no dependencies
parse_package_json() {
    local pkg_file="${1:-package.json}"
    
    if [ ! -f "$pkg_file" ]; then
        echo ""
        return 1
    fi
    
    # Check if jq is available
    if ! command -v jq &> /dev/null; then
        warn "jq not found, cannot parse package.json"
        echo ""
        return 1
    fi
    
    # Validate JSON format first
    if ! jq empty "$pkg_file" 2>/dev/null; then
        warn "Invalid JSON format in $pkg_file"
        echo ""
        return 1
    fi
    
    # Extract dependencies and devDependencies, combine them
    local jq_err
    jq_err=$(mktemp 2>/dev/null || printf "/tmp/shipnode_jq_err.%s" "$$")
    local deps
    deps=$(jq -r '(.dependencies // {}) + (.devDependencies // {}) | keys | join(",")' "$pkg_file" 2>"$jq_err")
    local jq_status=$?
    
    if [ $jq_status -ne 0 ]; then
        local jq_err_msg
        jq_err_msg=$(cat "$jq_err" 2>/dev/null || printf "")
        rm -f "$jq_err"
        if [ -n "$jq_err_msg" ]; then
            warn "Failed to parse $pkg_file: $jq_err_msg"
        else
            warn "Failed to parse $pkg_file with jq"
        fi
        echo ""
        return 1
    fi
    
    rm -f "$jq_err"
    
    if [ -z "$deps" ]; then
        echo ""
        return 1
    fi
    
    echo "$deps"
    return 0
}

# Suggest app type based on dependencies
suggest_app_type() {
    local deps=$1
    
    # Backend frameworks
    if [[ "$deps" =~ (express|@nestjs/core|@nestjs/common|fastify|koa|@hapi/hapi|hono|@adonisjs/core) ]]; then
        echo "backend"
        return 0
    fi
    
    # Full-stack frameworks (suggest backend for reverse proxy)
    if [[ "$deps" =~ ((^|,)(next|nuxt|astro)(,|$)|@remix-run) ]]; then
        echo "backend"
        return 0
    fi
    
    # Frontend frameworks
    if [[ "$deps" =~ (react-router|tanstack.*router|react|vue|svelte|solid-js|@angular/core) ]]; then
        echo "frontend"
        return 0
    fi
    
    echo "unknown"
    return 0
}

# Detect framework from package.json dependencies
# Identifies 18 popular frameworks and suggests appropriate app type
# Args:
#   $1: Path to package.json file (default: ./package.json)
# Returns:
#   "framework_name|app_type" where:
#     - framework_name: Express, NestJS, React, Next.js, etc. or "none"
#     - app_type: backend, frontend, or unknown
# Examples:
#   Express project → "Express|backend"
#   React project → "React|frontend"
#   No framework → "none|unknown"
detect_framework() {
    local pkg_file="${1:-package.json}"
    
    # Parse dependencies
    local deps=$(parse_package_json "$pkg_file")
    
    if [ -z "$deps" ]; then
        echo "none|unknown"
        return 0
    fi
    
    # Detect specific frameworks
    local framework="none"
    
    # Backend frameworks
    if [[ "$deps" =~ express ]]; then
        framework="Express"
    elif [[ "$deps" =~ @nestjs/core ]]; then
        framework="NestJS"
    elif [[ "$deps" =~ fastify ]]; then
        framework="Fastify"
    elif [[ "$deps" =~ koa ]]; then
        framework="Koa"
    elif [[ "$deps" =~ @hapi/hapi ]]; then
        framework="Hapi"
    elif [[ "$deps" =~ hono ]]; then
        framework="Hono"
    elif [[ "$deps" =~ @adonisjs/core ]]; then
        framework="AdonisJS"
    # Full-stack frameworks
    elif [[ "$deps" =~ (^|,)next(,|$) ]]; then
        framework="Next.js"
    elif [[ "$deps" =~ (^|,)nuxt(,|$) ]]; then
        framework="Nuxt"
    elif [[ "$deps" =~ @remix-run ]]; then
        framework="Remix"
    elif [[ "$deps" =~ (^|,)astro(,|$) ]]; then
        framework="Astro"
    # Frontend frameworks
    elif [[ "$deps" =~ (^|,)react(,|$) ]]; then
        framework="React"
    elif [[ "$deps" =~ react-router ]]; then
        framework="React Router"
    elif [[ "$deps" =~ tanstack.*router ]]; then
        framework="TanStack Router"
    elif [[ "$deps" =~ (^|,)vue(,|$) ]]; then
        framework="Vue"
    elif [[ "$deps" =~ svelte ]]; then
        framework="Svelte"
    elif [[ "$deps" =~ solid-js ]]; then
        framework="SolidJS"
    elif [[ "$deps" =~ @angular/core ]]; then
        framework="Angular"
    fi
    
    # Suggest app type
    local app_type=$(suggest_app_type "$deps")
    
    echo "${framework}|${app_type}"
    return 0
}

# Auto-detect port from package.json scripts
# Searches start/dev scripts for common port declaration patterns
# Args:
#   $1: Path to package.json file (default: ./package.json)
# Returns:
#   Port number (1-65535) if detected, empty string otherwise
# Detection patterns (priority order):
#   1. PORT=3000
#   2. --port=5000 or --port 8080
#   3. localhost:4000 or 127.0.0.1:9000
#   4. listen(:3000)
suggest_port() {
    local pkg_file="${1:-package.json}"
    
    if [ ! -f "$pkg_file" ] || ! command -v jq &> /dev/null; then
        echo ""
        return 1
    fi
    
    # Extract start and dev scripts
    local scripts=$(jq -r '.scripts // {} | .start // .dev // ""' "$pkg_file" 2>/dev/null)
    
    if [ -z "$scripts" ]; then
        echo ""
        return 1
    fi
    
    # Look for PORT= or :port patterns
    local port=""
    
    # Priority 1: Environment variable PORT=3000
    if [[ "$scripts" =~ PORT=([0-9]+) ]]; then
        port="${BASH_REMATCH[1]}"
    # Priority 2: CLI flag --port 3000 or --port=3000
    elif [[ "$scripts" =~ --port[[:space:]]*=?[[:space:]]*([0-9]+) ]]; then
        port="${BASH_REMATCH[1]}"
    # Priority 3: localhost:3000 or 127.0.0.1:3000
    elif [[ "$scripts" =~ (localhost|127\.0\.0\.1):([0-9]+) ]]; then
        port="${BASH_REMATCH[2]}"
    # Priority 4: listen on :3000 (common in Node)
    elif [[ "$scripts" =~ listen[[:space:]]*\([[:space:]]*[\'\"]?:([0-9]+) ]]; then
        port="${BASH_REMATCH[1]}"
    fi
    
    # Validate port is in valid range
    if [ -n "$port" ] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ]; then
        echo "$port"
    else
        echo ""
    fi
    return 0
}

# Detect ORM/database tool from package.json dependencies
# Returns ORM name and migration/generate commands in format:
#   "ORM_NAME|migrate_cmd|generate_cmd"
# Examples:
#   "Prisma|npx prisma migrate deploy|npx prisma generate"
#   "Drizzle|npx drizzle-kit migrate|"
#   "none||" (if no ORM detected)
detect_orm() {
    local pkg_file="${1:-package.json}"

    # Parse dependencies
    local deps=$(parse_package_json "$pkg_file")

    if [ -z "$deps" ]; then
        echo "none||"
        return 0
    fi

    # Detect specific ORMs (order matters - check specific ones first)
    if [[ "$deps" =~ (^|,)(prisma|@prisma/client)(,|$) ]]; then
        echo "Prisma|npx prisma migrate deploy|npx prisma generate"
    elif [[ "$deps" =~ drizzle-orm ]]; then
        echo "Drizzle|npx drizzle-kit migrate|npx drizzle-kit generate"
    elif [[ "$deps" =~ typeorm ]]; then
        echo "TypeORM|npx typeorm migration:run|"
    elif [[ "$deps" =~ sequelize ]]; then
        echo "Sequelize|npx sequelize-cli db:migrate|"
    elif [[ "$deps" =~ (^|,)knex(,|$) ]]; then
        echo "Knex|npx knex migrate:latest|"
    elif [[ "$deps" =~ mongoose ]]; then
        echo "Mongoose||"
    elif [[ "$deps" =~ @adonisjs/lucid ]]; then
        echo "AdonisJS Lucid|node ace migration:run --force|"
    else
        echo "none||"
    fi

    return 0
}

# ============================================================================
