export class ShipnodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShipnodeError';
  }
}

export class ConfigError extends ShipnodeError {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class SshError extends ShipnodeError {
  constructor(
    message: string,
    public exitCode?: number,
    public stderr?: string,
  ) {
    super(message);
    this.name = 'SshError';
  }
}

export class DeployError extends ShipnodeError {
  constructor(message: string, public stage?: string) {
    super(message);
    this.name = 'DeployError';
  }
}

export class ValidationError extends ShipnodeError {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class HealthCheckError extends ShipnodeError {
  constructor(
    message: string,
    public attempts?: number,
    public lastStatus?: number,
  ) {
    super(message);
    this.name = 'HealthCheckError';
  }
}

export class LockError extends ShipnodeError {
  constructor(message: string) {
    super(message);
    this.name = 'LockError';
  }
}
