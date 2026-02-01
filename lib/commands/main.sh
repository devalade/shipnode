main() {
    case "${1:-}" in
        init)
            cmd_init "$2" "$3"
            ;;
        setup)
            cmd_setup
            ;;
        deploy)
            cmd_deploy "$2"
            ;;
        doctor)
            cmd_doctor
            ;;
        env)
            cmd_env
            ;;
        status)
            cmd_status
            ;;
        logs)
            cmd_logs
            ;;
        restart)
            cmd_restart
            ;;
        stop)
            cmd_stop
            ;;
        unlock)
            cmd_unlock
            ;;
        rollback)
            cmd_rollback "$2"
            ;;
        releases)
            cmd_releases
            ;;
        migrate)
            cmd_migrate
            ;;
        user)
            case "${2:-}" in
                sync)
                    cmd_user_sync
                    ;;
                list)
                    cmd_user_list
                    ;;
                remove)
                    cmd_user_remove "$3"
                    ;;
                *)
                    error "Unknown user command: ${2:-}\nAvailable: sync, list, remove"
                    ;;
            esac
            ;;
        mkpasswd)
            cmd_mkpasswd
            ;;
        upgrade)
            cmd_upgrade
            ;;
        help|--help|-h)
            cmd_help
            ;;
        "")
            cmd_help
            ;;
        *)
            error "Unknown command: $1\nRun 'shipnode help' for usage."
            ;;
    esac
}
