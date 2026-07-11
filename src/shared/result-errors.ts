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

export type ServerTargetError =
  | MissingServerTargetError
  | UnknownServerTargetError;

export type AppTargetError = ServerTargetError | UnknownAppError;

export type AccessoryCommandError =
  | ServerTargetError
  | UnknownAccessoryError
  | NoAccessoriesConfiguredError
  | MissingAccessoryHealthCheckError;
