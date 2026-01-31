# INPUT VALIDATION FUNCTIONS
# ============================================================================

# Validate IP address or hostname
# Accepts both IPv4 addresses and RFC-compliant hostnames
# Args:
#   $1: IP address or hostname to validate
# Returns:
#   Exit code 0 if valid, 1 if invalid
# Examples:
#   192.168.1.1 → valid
#   example.com → valid
#   999.999.999.999 → invalid
validate_ip_or_hostname() {
    local input=$1
    
    if [ -z "$input" ]; then
        return 1
    fi
    
    # Check if it's a valid IPv4 address
    if [[ "$input" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
        # Validate each octet is 0-255
        IFS='.' read -ra OCTETS <<< "$input"
        for octet in "${OCTETS[@]}"; do
            # Ensure the octet contains only digits
            if ! [[ "$octet" =~ ^[0-9]+$ ]]; then
                return 1
            fi
            # Use base-10 to avoid octal interpretation of leading zeros
            if ((10#$octet < 0 || 10#$octet > 255)); then
                return 1
            fi
        done
        return 0
    fi
    
    # Check if it's a valid hostname
    if [[ "$input" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$ ]]; then
        return 0
    fi
    
    return 1
}

# Validate port number
validate_port() {
    local port=$1
    
    if [ -z "$port" ]; then
        return 1
    fi
    
    # Must be numeric
    if ! [[ "$port" =~ ^[0-9]+$ ]]; then
        return 1
    fi
    
    # Must be in valid range
    if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
        return 1
    fi
    
    return 0
}

# Validate domain name
validate_domain() {
    local domain=$1
    
    # Empty is allowed (optional field)
    if [ -z "$domain" ]; then
        return 0
    fi
    
    # Must not contain protocol
    if [[ "$domain" =~ ^https?:// ]]; then
        return 1
    fi
    
    # Basic domain format
    if [[ "$domain" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$ ]]; then
        return 0
    fi
    
    return 1
}

# Validate PM2 app name
validate_pm2_app_name() {
    local name=$1
    
    if [ -z "$name" ]; then
        return 1
    fi
    
    # Alphanumeric, dash, underscore only
    if ! [[ "$name" =~ ^[a-zA-Z0-9_-]+$ ]]; then
        return 1
    fi
    
    # Max length 64 chars
    if [ ${#name} -gt 64 ]; then
        return 1
    fi
    
    return 0
}

# Test SSH connection (optional)
test_ssh_connection() {
    local user=$1
    local host=$2
    local port=${3:-22}
    
    # Try connection with 5 second timeout
    if ssh -o ConnectTimeout=5 -o BatchMode=yes -p "$port" "$user@$host" "exit" 2>/dev/null; then
        return 0
    fi
    
    return 1
}

# Check if a port is available on the remote server
# Returns: 0 if available, 1 if in use
# Args:
#   $1: Port number to check
#   $2: SSH user (optional, uses SSH_USER if not provided)
#   $3: SSH host (optional, uses SSH_HOST if not provided)
#   $4: SSH port (optional, uses SSH_PORT if not provided)
check_remote_port_available() {
    local port=$1
    local user=${2:-$SSH_USER}
    local host=${3:-$SSH_HOST}
    local ssh_port=${4:-$SSH_PORT}
    
    if [ -z "$port" ] || [ -z "$user" ] || [ -z "$host" ]; then
        return 1
    fi
    
    # Check if anything is listening on the port
    local result
    result=$(ssh -o ConnectTimeout=5 -p "$ssh_port" "$user@$host" "
        if command -v ss >/dev/null 2>&1; then
            ss -tln | grep -q \":$port \"
        elif command -v netstat >/dev/null 2>&1; then
            netstat -tln 2>/dev/null | grep -q \":$port \"
        else
            # Fallback: try to connect to the port
            timeout 1 bash -c \"exec 3<>/dev/tcp/127.0.0.1/$port\" 2>/dev/null
        fi
        echo \$?
    " 2>/dev/null)
    
    # If result is 0, port is in use
    if [ "$result" = "0" ]; then
        return 1  # Port is NOT available
    fi
    
    return 0  # Port is available
}

# Check which process is using a port on the remote server
# Returns: process name or empty string
# Args:
#   $1: Port number to check
#   $2: SSH user (optional, uses SSH_USER if not provided)
#   $3: SSH host (optional, uses SSH_HOST if not provided)
#   $4: SSH port (optional, uses SSH_PORT if not provided)
get_remote_port_process() {
    local port=$1
    local user=${2:-$SSH_USER}
    local host=${3:-$SSH_HOST}
    local ssh_port=${4:-$SSH_PORT}
    
    if [ -z "$port" ] || [ -z "$user" ] || [ -z "$host" ]; then
        echo ""
        return 1
    fi
    
    # Get the process using the port
    local process
    process=$(ssh -o ConnectTimeout=5 -p "$ssh_port" "$user@$host" "
        # Try to find PID using the port, then get process name
        if command -v ss >/dev/null 2>&1; then
            pid=\$(ss -tlnp | grep \":$port \" | head -1 | grep -oP 'pid=\K[0-9]+')
        elif command -v netstat >/dev/null 2>&1; then
            pid=\$(netstat -tlnp 2>/dev/null | grep \":$port \" | head -1 | awk '{print \$7}' | cut -d'/' -f1)
        fi
        
        if [ -n \"\$pid\" ]; then
            # Check if it's a PM2 process
            if pm2 describe \$pid >/dev/null 2>&1 || pm2 list | grep -q \"\$pid\"; then
                # Get PM2 app name
                pm2 list | grep \"\$pid\" | awk '{print \$4}' | head -1
            else
                # Get process name from PID
                ps -p \$pid -o comm= 2>/dev/null || echo \"unknown\"
            fi
        fi
    " 2>/dev/null)
    
    echo "$process"
}

# Check if port is used by our app (allowing redeployment)
# Returns: 0 if same app or available, 1 if different app
# Args:
#   $1: Port number to check
#   $2: PM2 app name to compare
#   $3: SSH user (optional, uses SSH_USER if not provided)
#   $4: SSH host (optional, uses SSH_HOST if not provided)
#   $5: SSH port (optional, uses SSH_PORT if not provided)
check_port_owner() {
    local port=$1
    local expected_app=$2
    local user=${3:-$SSH_USER}
    local host=${4:-$SSH_HOST}
    local ssh_port=${5:-$SSH_PORT}
    
    if [ -z "$port" ]; then
        return 0
    fi
    
    # Check if port is available
    if check_remote_port_available "$port" "$user" "$host" "$ssh_port"; then
        return 0  # Port is free, allow deployment
    fi
    
    # Port is in use, check who owns it
    local owner
    owner=$(get_remote_port_process "$port" "$user" "$host" "$ssh_port")
    
    if [ -z "$owner" ]; then
        return 1  # Unknown owner, block to be safe
    fi
    
    # Check if owner matches our expected app
    if [ "$owner" = "$expected_app" ]; then
        return 0  # Same app, allow redeployment
    fi
    
    return 1  # Different app using the port
}

# Suggest an available port on the remote server
# Tries ports in range 3000-3010, then falls back to random high port
# Args:
#   $1: Preferred port (optional)
#   $2: SSH user (optional, uses SSH_USER if not provided)
#   $3: SSH host (optional, uses SSH_HOST if not provided)
#   $4: SSH port (optional, uses SSH_PORT if not provided)
suggest_available_port() {
    local preferred=$1
    local user=${2:-$SSH_USER}
    local host=${3:-$SSH_HOST}
    local ssh_port=${4:-$SSH_PORT}
    
    # If preferred port is provided and available, use it
    if [ -n "$preferred" ]; then
        if check_remote_port_available "$preferred" "$user" "$host" "$ssh_port"; then
            echo "$preferred"
            return 0
        fi
    fi
    
    # Try common app ports 3000-3010
    for port in 3000 3001 3002 3003 3004 3005 3006 3007 3008 3009 3010; do
        if check_remote_port_available "$port" "$user" "$host" "$ssh_port"; then
            echo "$port"
            return 0
        fi
    done
    
    # Fall back to random high port (8080-8099 range)
    for port in 8080 8081 8082 8083 8084 8085 8086 8087 8088 8089 8090 8091 8092 8093 8094 8095 8096 8097 8098 8099; do
        if check_remote_port_available "$port" "$user" "$host" "$ssh_port"; then
            echo "$port"
            return 0
        fi
    done
    
    # Last resort: generate random port in ephemeral range
    echo $((49152 + RANDOM % 16384))
}

# Parse users.yml file
