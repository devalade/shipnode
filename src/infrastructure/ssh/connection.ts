import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Client, ConnectConfig, ClientChannel } from 'ssh2';
import { SshError } from '../../shared/errors.js';
import type { SshConfig, ExecResult } from '../../shared/types.js';
import { RemoteExecutor, type ExecOptions } from '../../domain/remote/executor.js';

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
    const sshConfig: ConnectConfig = {
      host: config.host,
      port: config.port,
      username: config.user,
      readyTimeout: 30000,
    };

    if (config.identityFile) {
      sshConfig.privateKey = readFileSync(config.identityFile);
    } else {
      if (process.env['SSH_AUTH_SOCK']) {
        sshConfig.agent = process.env['SSH_AUTH_SOCK'];
      }
      // Also try default key files — agent may be set but have no keys loaded
      const defaults = ['id_ed25519', 'id_ecdsa', 'id_rsa', 'id_dsa'];
      for (const name of defaults) {
        const keyPath = join(homedir(), '.ssh', name);
        if (existsSync(keyPath)) {
          sshConfig.privateKey = readFileSync(keyPath);
          break;
        }
      }
      if (!sshConfig.agent && !sshConfig.privateKey) {
        throw new SshError(
          'No SSH auth method found. Set identityFile in config, run ssh-add, or place a key in ~/.ssh/',
        );
      }
    }

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
