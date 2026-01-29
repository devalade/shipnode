# USER PROVISIONING FUNCTIONS
# ============================================================================

# Validation helpers
validate_username() {
    local username=$1
    if [[ ! "$username" =~ ^[a-zA-Z0-9_-]+$ ]] || [ ${#username} -gt 32 ]; then
        return 1
    fi
    return 0
}

validate_password_hash() {
    local hash=$1
    # Check if it's a valid crypt format (starts with $)
    if [[ "$hash" =~ ^\$[0-9]+\$ ]]; then
        return 0
    fi
    return 1
}

validate_ssh_key() {
    local key=$1
    # Check if key starts with valid key type
    if [[ "$key" =~ ^(ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521)\ .+ ]]; then
        return 0
    fi
    return 1
}

# Reusable yes/no prompt with default support
prompt_yes_no() {
    local prompt=$1 default=${2:-n}
    if [ "$default" = "y" ]; then
        read -p "$prompt (Y/n) " -n 1 -r
    else
        read -p "$prompt (y/N) " -n 1 -r
    fi
    echo
    [ -z "$REPLY" ] && { [ "$default" = "y" ] && return 0 || return 1; }
    [[ $REPLY =~ ^[Yy]$ ]]
}

# Generate password hash (reuses cmd_mkpasswd logic)
generate_password_hash() {
    local password=$1
    # Check if mkpasswd is available
    if ! command -v mkpasswd &> /dev/null; then
        error "mkpasswd not found. Install it with: sudo apt-get install whois"
    fi
    mkpasswd -m sha-512 "$password"
}

# Validate email address
validate_email() {
    local email=$1
    if [[ "$email" =~ ^[^@]+@[^@]+\.[^@]+$ ]]; then
        return 0
    fi
    return 1
}

# Read SSH key from file
read_key_file() {
    local file_path=$1
    # Expand tilde to home directory
    file_path="${file_path/#\~/$HOME}"

    if [ ! -f "$file_path" ]; then
        echo ""
        return 1
    fi

    cat "$file_path"
    return 0
}

# Parse users.yml and output pipe-delimited records
# Output format: username|email|password|sudo|authorized_key|authorized_key_file|authorized_keys
parse_users_yaml() {
    local yaml_file=$1
    local in_users=false
    local in_user=false
    local in_authorized_keys=false
    local waiting_for_username=false

    local username="" email="" password="" sudo="false"
    local authorized_key="" authorized_key_file="" authorized_keys=""

    while IFS= read -r line; do
        # Skip comments and empty lines
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ "$line" =~ ^[[:space:]]*$ ]] && continue

        # Strip inline comments (but not inside quotes)
        # Simple approach: remove everything after # if not in quotes
        if [[ "$line" =~ ^([^\"#]*)(#.*)$ ]]; then
            line="${BASH_REMATCH[1]}"
        elif [[ "$line" =~ ^(\"[^\"]*\"|[^#]*)(#.*)$ ]]; then
            line="${BASH_REMATCH[1]}"
        fi

        # Trim trailing whitespace
        line="${line%"${line##*[![:space:]]}"}"

        # Check if we're in users section
        if [[ "$line" =~ ^users: ]]; then
            in_users=true
            continue
        fi

        # Skip if not in users section
        [ "$in_users" = false ] && continue

        # Detect bare-dash entry (start of new user block)
        if [[ "$line" =~ ^[[:space:]]*-[[:space:]]*$ ]]; then
            # Output previous user if exists
            if [ -n "$username" ]; then
                echo "$username|$email|$password|$sudo|$authorized_key|$authorized_key_file|$authorized_keys"
            fi

            # Reset for new user, wait for username on next line
            username="" email="" password="" sudo="false"
            authorized_key="" authorized_key_file="" authorized_keys=""
            in_user=true
            in_authorized_keys=false
            waiting_for_username=true
            continue
        fi

        # Detect start of new user entry (dash + username on same line)
        if [[ "$line" =~ ^[[:space:]]*-[[:space:]]+username:[[:space:]]*(.+)$ ]]; then
            # Output previous user if exists
            if [ -n "$username" ]; then
                echo "$username|$email|$password|$sudo|$authorized_key|$authorized_key_file|$authorized_keys"
            fi

            # Reset for new user
            username="${BASH_REMATCH[1]}"
            username="${username%%[[:space:]]}"  # Trim trailing whitespace
            email="" password="" sudo="false"
            authorized_key="" authorized_key_file="" authorized_keys=""
            in_user=true
            in_authorized_keys=false
            waiting_for_username=false
            continue
        fi

        # Continue parsing user fields
        if [ "$in_user" = true ]; then
            # username (standalone line after bare dash)
            if [[ "$line" =~ ^[[:space:]]+username:[[:space:]]*(.+)$ ]]; then
                username="${BASH_REMATCH[1]}"
                username="${username%%[[:space:]]}"
                waiting_for_username=false

            # email
            elif [[ "$line" =~ ^[[:space:]]+email:[[:space:]]*(.+)$ ]]; then
                email="${BASH_REMATCH[1]}"
                email="${email%%[[:space:]]}"

            # password
            elif [[ "$line" =~ ^[[:space:]]+password:[[:space:]]*\"(.+)\"$ ]]; then
                password="${BASH_REMATCH[1]}"
                password="${password%%[[:space:]]}"
            elif [[ "$line" =~ ^[[:space:]]+password:[[:space:]]*(.+)$ ]]; then
                password="${BASH_REMATCH[1]}"
                password="${password%%[[:space:]]}"

            # sudo
            elif [[ "$line" =~ ^[[:space:]]+sudo:[[:space:]]*(true|false) ]]; then
                sudo="${BASH_REMATCH[1]}"

            # authorized_key (single key)
            elif [[ "$line" =~ ^[[:space:]]+authorized_key:[[:space:]]*\"(.+)\"$ ]]; then
                authorized_key="${BASH_REMATCH[1]}"
                authorized_key="${authorized_key%%[[:space:]]}"
            elif [[ "$line" =~ ^[[:space:]]+authorized_key:[[:space:]]*(.+)$ ]]; then
                authorized_key="${BASH_REMATCH[1]}"
                authorized_key="${authorized_key%%[[:space:]]}"

            # authorized_key_file
            elif [[ "$line" =~ ^[[:space:]]+authorized_key_file:[[:space:]]*\"(.+)\"$ ]]; then
                authorized_key_file="${BASH_REMATCH[1]}"
                authorized_key_file="${authorized_key_file%%[[:space:]]}"
            elif [[ "$line" =~ ^[[:space:]]+authorized_key_file:[[:space:]]*(.+)$ ]]; then
                authorized_key_file="${BASH_REMATCH[1]}"
                authorized_key_file="${authorized_key_file%%[[:space:]]}"

            # authorized_keys (array start)
            elif [[ "$line" =~ ^[[:space:]]+authorized_keys:[[:space:]]*$ ]]; then
                in_authorized_keys=true
                authorized_keys=""

            # authorized_keys array item
            elif [ "$in_authorized_keys" = true ] && [[ "$line" =~ ^[[:space:]]+-[[:space:]]+\"(.+)\"$ ]]; then
                local key="${BASH_REMATCH[1]}"
                key="${key%%[[:space:]]}"
                [ -n "$authorized_keys" ] && authorized_keys+=":::"
                authorized_keys+="$key"

            # authorized_keys array item (unquoted)
            elif [ "$in_authorized_keys" = true ] && [[ "$line" =~ ^[[:space:]]+-[[:space:]]+(.+)$ ]]; then
                local key="${BASH_REMATCH[1]}"
                key="${key%%[[:space:]]}"
                [ -n "$authorized_keys" ] && authorized_keys+=":::"
                authorized_keys+="$key"

            # End of authorized_keys array (next field or new user)
            elif [ "$in_authorized_keys" = true ] && [[ "$line" =~ ^[[:space:]]+[a-z_]+: ]]; then
                in_authorized_keys=false
            fi
        fi

    done < "$yaml_file"

    # Output last user
    if [ -n "$username" ]; then
        echo "$username|$email|$password|$sudo|$authorized_key|$authorized_key_file|$authorized_keys"
    fi
}

# ============================================================================
