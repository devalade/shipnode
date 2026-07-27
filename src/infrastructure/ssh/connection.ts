import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Result, type Result as ResultType } from 'better-result';
import { Client, ConnectConfig, ClientChannel } from 'ssh2';
import { SshError } from '../../shared/errors.js';
import type { SshConfig, ExecResult } from '../../shared/types.js';
import { RemoteExecutor, type ExecOptions } from '../../domain/remote/executor.js';
import {
  SshAuthenticationUnavailableError,
  SshIdentityFileUnreadableError,
} from '../../shared/result-errors.js';

type SshAuthentication = Pick<ConnectConfig, 'privateKey' | 'agent'>;
type SshAuthenticationError = SshAuthenticationUnavailableError | SshIdentityFileUnreadableError;

interface SshAuthenticationEnvironment {
  sshAuthSock?: string;
  homeDir: string;
}

interface SshAuthenticationFiles {
  exists(path: string): boolean;
  read(path: string): Buffer;
}

const systemAuthenticationFiles: SshAuthenticationFiles = {
  exists: existsSync,
  read: readFileSync,
};

/** Resolve the first usable SSH authentication method without throwing expected failures. */
export function resolveSshAuthentication(
  config: SshConfig,
  environment: SshAuthenticationEnvironment,
  files: SshAuthenticationFiles = systemAuthenticationFiles,
): ResultType<SshAuthentication, SshAuthenticationError> {
  if (config.identityFile && files.exists(config.identityFile)) {
    try {
      return Result.ok({ privateKey: files.read(config.identityFile) });
    } catch (cause: unknown) {
      return Result.err(new SshIdentityFileUnreadableError({ path: config.identityFile, cause }));
    }
  }

  const agent = environment.sshAuthSock;

  for (const name of ['id_ed25519', 'id_ecdsa', 'id_rsa', 'id_dsa']) {
    const keyPath = join(environment.homeDir, '.ssh', name);
    if (!files.exists(keyPath)) continue;
    try {
      return Result.ok({
        ...(agent ? { agent } : {}),
        privateKey: files.read(keyPath),
      });
    } catch (cause: unknown) {
      return Result.err(new SshIdentityFileUnreadableError({ path: keyPath, cause }));
    }
  }

  if (agent) return Result.ok({ agent });

  return Result.err(new SshAuthenticationUnavailableError());
}

export interface SshConnectionOptions {
  onReady?: () => void;
  onError?: (err: Error) => void;
}

export class SshConnection extends RemoteExecutor {
  private client: Client;
  private connected = false;

  constructor() {
    super();
    this.client = new Client();
  }

  async connect(config: SshConfig): Promise<void> {
    // Start from a fresh client so a reconnect (watch sessions do this after an
    // idle drop) doesn't accumulate listeners on a client that already ended.
    this.client.removeAllListeners();
    this.client = new Client();

    const sshConfig: ConnectConfig = {
      host: config.host,
      port: config.port,
      username: config.user,
      readyTimeout: 30000,
      // Long-lived sessions (`deploy --watch`, `monitor`) sit idle between
      // commands; without keepalives a NAT or firewall timeout silently drops
      // the connection and the next exec fails with "Not connected".
      keepaliveInterval: 15000,
      keepaliveCountMax: 6,
    };

    const authentication = resolveSshAuthentication(config, {
      sshAuthSock: process.env['SSH_AUTH_SOCK'],
      homeDir: homedir(),
    });
    if (authentication.isErr()) {
      throw authentication.error;
    }
    Object.assign(sshConfig, authentication.value);

    if (config.proxyMode === 'cloudflare') {
      throw new SshError('Cloudflare Access proxy requires external connector. Use ssh2-http-proxy-agent.');
    }

    return new Promise<void>((resolve, reject) => {
      this.client.on('ready', () => {
        this.connected = true;
        resolve();
      });

      this.client.on('error', (err) => {
        this.connected = false;
        reject(new SshError(`SSH connection failed: ${err.message}`));
      });

      this.client.on('close', () => {
        this.connected = false;
      });

      this.client.connect(sshConfig);
    });
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    if (!this.connected) {
      throw new SshError('Not connected to SSH server');
    }

    return new Promise<ExecResult>((resolve, reject) => {
      this.client.exec(command, { pty: false }, (err, stream: ClientChannel) => {
        if (err) {
          return reject(new SshError(`Failed to execute command: ${err.message}`));
        }

        let stdout = '';
        let stderr = '';
        let exitCode = 0;

        stream.on('data', (data: Buffer) => {
          const chunk = data.toString();
          stdout += chunk;
          options?.onData?.(chunk, 'stdout');
        });

        stream.stderr.on('data', (data: Buffer) => {
          const chunk = data.toString();
          stderr += chunk;
          options?.onData?.(chunk, 'stderr');
        });

        stream.on('close', (code: number | undefined) => {
          exitCode = code ?? 1;
          resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode });
        });

        stream.on('error', (err: Error) => {
          reject(new SshError(`Stream error: ${err.message}`));
        });

        if (options?.timeout) {
          setTimeout(() => {
            stream.close();
            reject(new SshError(`Command timed out after ${options.timeout}ms`, undefined, stderr));
          }, options.timeout);
        }
      });
    });
  }

  async testConnection(): Promise<boolean> {
    try {
      const result = await this.exec('echo ok', { timeout: 5000 });
      return result.exitCode === 0 && result.stdout === 'ok';
    } catch {
      return false;
    }
  }

  disconnect(): void {
    this.client.end();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
