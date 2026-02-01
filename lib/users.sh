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

# Create user on remote server
# Returns: "EXISTS" if user exists, "CREATED" if newly created
create_remote_user() {
    local username=$1
    local email=$2
    local password=$3

    # Check if user exists
    local user_exists=$(ssh -T -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" "id -u $username >/dev/null 2>&1 && echo 'yes' || echo 'no'")

    if [ "$user_exists" = "yes" ]; then
        echo "EXISTS"
        return 0
    fi

    # Create user with password or without
    if [ -n "$password" ]; then
        # Create user with encrypted password, force password change on first login
        ssh -T -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" bash << ENDSSH
            sudo useradd -m -s /bin/bash -p '$password' -c '$email' $username
            sudo chage -d 0 $username
ENDSSH
    else
        # Create user without password (SSH key auth only)
        ssh -T -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" bash << ENDSSH
            sudo useradd -m -s /bin/bash -c '$email' $username
            sudo passwd -l $username
ENDSSH
    fi

    echo "CREATED"
}

# Setup SSH directory for user
setup_user_ssh_dir() {
    local username=$1

    ssh -T -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" bash << ENDSSH
        sudo mkdir -p /home/$username/.ssh
        sudo touch /home/$username/.ssh/authorized_keys
        sudo chmod 700 /home/$username/.ssh
        sudo chmod 600 /home/$username/.ssh/authorized_keys
        sudo chown -R $username:$username /home/$username/.ssh
ENDSSH
}

# Add SSH key to user's authorized_keys
add_user_ssh_key() {
    local username=$1
    local ssh_key=$2

    ssh -T -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" bash << ENDSSH
        echo '$ssh_key' | sudo tee -a /home/$username/.ssh/authorized_keys > /dev/null
        sudo chmod 600 /home/$username/.ssh/authorized_keys
        sudo chown $username:$username /home/$username/.ssh/authorized_keys
ENDSSH
}

# Grant deployment permissions to user
grant_deploy_permissions() {
    local username=$1

    ssh -T -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" bash << ENDSSH
        # Add user to www-data group for web deployment access
        sudo usermod -aG www-data $username 2>/dev/null || true

        # Grant access to deployment directory
        if [ -d "$REMOTE_PATH" ]; then
            # Ensure www-data group exists and owns the directory
            sudo chgrp -R www-data "$REMOTE_PATH" 2>/dev/null || true

            # Set group permissions: directories get 2775 (setgid), files get 664
            sudo find "$REMOTE_PATH" -type d -exec chmod 2775 {} \; 2>/dev/null || true
            sudo find "$REMOTE_PATH" -type f -exec chmod 664 {} \; 2>/dev/null || true

            # Ensure specific subdirectories have proper permissions
            for dir in releases shared current .shipnode; do
                if [ -d "$REMOTE_PATH/\$dir" ]; then
                    sudo chmod -R g+rwX "$REMOTE_PATH/\$dir" 2>/dev/null || true
                fi
            done
        fi

        # Grant PM2 access by adding to the primary user's group
        PRIMARY_GROUP=\$(id -gn $SSH_USER)
        sudo usermod -aG \$PRIMARY_GROUP $username 2>/dev/null || true
ENDSSH
}

# Grant sudo access to user
grant_sudo_access() {
    local username=$1

    ssh -T -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" bash << ENDSSH
        # Add user to sudo group
        sudo usermod -aG sudo $username

        # Create sudoers file with password requirement (safer)
        echo "$username ALL=(ALL:ALL) ALL" | sudo tee /etc/sudoers.d/$username > /dev/null
        sudo chmod 440 /etc/sudoers.d/$username

        # Note: For passwordless sudo, replace above with:
        # echo "$username ALL=(ALL) NOPASSWD:ALL" | sudo tee /etc/sudoers.d/$username > /dev/null
ENDSSH
}

# Revoke user access
revoke_user_access() {
    local username=$1

    ssh -T -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" bash << ENDSSH
        # Remove from groups
        sudo deluser $username sudo 2>/dev/null || true
        sudo deluser $username www-data 2>/dev/null || true

        # Lock account to prevent login
        sudo usermod -L $username 2>/dev/null || true

        # Remove SSH keys
        sudo rm -f /home/$username/.ssh/authorized_keys 2>/dev/null || true

        # Remove sudoers file
        sudo rm -f /etc/sudoers.d/$username 2>/dev/null || true

        # Note: User home directory is preserved
        # To completely delete user: sudo userdel -r $username
ENDSSH
}

# ============================================================================
