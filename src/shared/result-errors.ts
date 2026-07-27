import { TaggedError } from 'better-result';

export class MissingServerTargetError extends TaggedError('MissingServerTargetError')<{
  message: string;
}>() {
  constructor() {
    super({ message: "Server target is required when no 'default' server is configured" });
  }
}

export class UnknownServerTargetError extends TaggedError('UnknownServerTargetError')<{
  target: string;
  known: string;
  message: string;
}>() {
  constructor(args: { target: string; known: string }) {
    super({
      ...args,
      message: `Unknown server target '${args.target}'. Known targets: ${args.known}`,
    });
  }
}

/**
 * A target resolved to several servers where only one is meaningful — an
 * accessory's host, a `run` invocation, a watch session. Naming the servers
 * lets the user pick one with `--on` instead of guessing what shipnode chose.
 */
export class AmbiguousServerTargetError extends TaggedError('AmbiguousServerTargetError')<{
  subject: string;
  servers: string;
  message: string;
}>() {
  constructor(args: { subject: string; servers: string }) {
    super({
      ...args,
      message:
        `${args.subject} runs on several servers (${args.servers}), ` +
        `but this needs exactly one. Pick it with --on <server>.`,
    });
  }
}

export class UnknownAppError extends TaggedError('UnknownAppError')<{
  name: string;
  message: string;
}>() {
  constructor(args: { name: string }) {
    super({ ...args, message: `No app named "${args.name}" in this workspace` });
  }
}

export class UnknownAccessoryError extends TaggedError('UnknownAccessoryError')<{
  name: string;
  message: string;
}>() {
  constructor(args: { name: string }) {
    super({ ...args, message: `No accessory named "${args.name}" in this workspace` });
  }
}

export class NoAccessoriesConfiguredError extends TaggedError('NoAccessoriesConfiguredError')<{
  message: string;
}>() {
  constructor() {
    super({ message: 'No accessories configured.' });
  }
}

export class MissingAccessoryHealthCheckError extends TaggedError('MissingAccessoryHealthCheckError')<{
  name: string;
  message: string;
}>() {
  constructor(args: { name: string }) {
    super({
      ...args,
      message: `Accessory '${args.name}' does not declare a healthCheck command`,
    });
  }
}

export class ProcessRestartError extends TaggedError('ProcessRestartError')<{
  pm2Name: string;
  detail: string;
  message: string;
}>() {
  constructor(args: { pm2Name: string; detail: string }) {
    super({
      ...args,
      message: `Failed to restart '${args.pm2Name}': ${args.detail}`,
    });
  }
}

export class ReleaseRollbackError extends TaggedError('ReleaseRollbackError')<{
  appName: string;
  timestamp: string;
  detail: string;
  message: string;
}>() {
  constructor(args: { appName: string; timestamp: string; detail: string }) {
    super({
      ...args,
      message: `Failed to roll back '${args.appName}' to ${args.timestamp}: ${args.detail}`,
    });
  }
}

export class Pm2StartupError extends TaggedError('Pm2StartupError')<{
  user: string;
  detail: string;
  message: string;
}>() {
  constructor(args: { user: string; detail: string }) {
    super({
      ...args,
      message: `Failed to configure PM2 startup for '${args.user}': ${args.detail}`,
    });
  }
}

export class SshAuthenticationUnavailableError extends TaggedError('SshAuthenticationUnavailableError')<{
  message: string;
}>() {
  constructor() {
    super({
      message: 'No SSH auth method found. Set identityFile, run ssh-add, or place a key in ~/.ssh/',
    });
  }
}

export class SshIdentityFileUnreadableError extends TaggedError('SshIdentityFileUnreadableError')<{
  path: string;
  cause: unknown;
  message: string;
}>() {
  constructor(args: { path: string; cause: unknown }) {
    super({
      ...args,
      message: `SSH identity file is not readable: ${args.path}`,
    });
  }
}

export class CiConfigLoadError extends TaggedError('CiConfigLoadError')<{
  message: string;
}>() {
  constructor() {
    super({ message: 'Unable to load Shipnode configuration. Run `shipnode config validate` for details.' });
  }
}

export class CiAppTargetRequiredError extends TaggedError('CiAppTargetRequiredError')<{
  message: string;
}>() {
  constructor() {
    super({ message: 'An app target is required for CI environment sync in a multi-app workspace. Pass `--app <name>`.' });
  }
}

export class CiEnvironmentNameInvalidError extends TaggedError('CiEnvironmentNameInvalidError')<{
  message: string;
}>() {
  constructor() {
    super({ message: 'GitHub Environment name must be non-empty and cannot contain control characters.' });
  }
}

export class CiEnvironmentFileNotFoundError extends TaggedError('CiEnvironmentFileNotFoundError')<{
  path: string;
  message: string;
}>() {
  constructor(args: { path: string }) {
    super({ ...args, message: `Environment file not found: ${args.path}` });
  }
}

export class CiEnvironmentFileReadError extends TaggedError('CiEnvironmentFileReadError')<{
  path: string;
  cause: unknown;
  message: string;
}>() {
  constructor(args: { path: string; cause: unknown }) {
    super({ ...args, message: `Unable to read environment file: ${args.path}` });
  }
}

export class CiEnvironmentSecretTooLargeError extends TaggedError('CiEnvironmentSecretTooLargeError')<{
  actualBytes: number;
  maximumBytes: number;
  message: string;
}>() {
  constructor(args: { actualBytes: number; maximumBytes: number }) {
    super({
      ...args,
      message:
        `Environment file is ${args.actualBytes} bytes; GitHub secrets are limited to ` +
        `${args.maximumBytes} bytes. Keep the environment server-managed or use an external secret store.`,
    });
  }
}

export class GitHubCliUnavailableError extends TaggedError('GitHubCliUnavailableError')<{
  message: string;
}>() {
  constructor() {
    super({
      message: 'GitHub CLI (gh) was not found. Install it from https://cli.github.com/ and run `gh auth login`.',
    });
  }
}

export class GitHubAuthenticationRequiredError extends TaggedError('GitHubAuthenticationRequiredError')<{
  message: string;
}>() {
  constructor() {
    super({ message: 'GitHub CLI is not authenticated. Run `gh auth login` and try again.' });
  }
}

export class GitHubSecretUpdateError extends TaggedError('GitHubSecretUpdateError')<{
  secretName: string;
  environment: string;
  message: string;
}>() {
  constructor(args: { secretName: string; environment: string }) {
    super({
      ...args,
      message: `Failed to update GitHub Environment secret ${args.secretName} in ${args.environment}.`,
    });
  }
}

export type ServerTargetError =
  | MissingServerTargetError
  | UnknownServerTargetError
  | AmbiguousServerTargetError;

export type AppTargetError = ServerTargetError | UnknownAppError;

export type AccessoryCommandError =
  | ServerTargetError
  | UnknownAccessoryError
  | NoAccessoriesConfiguredError
  | MissingAccessoryHealthCheckError;
