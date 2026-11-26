import { execFile } from 'node:child_process'
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Hard ceiling for any delivered file, regardless of the caller's request. */
const maxTtlMs = 24 * 60 * 60 * 1000

/**
 * How strongly the delivered file is isolated from other local users. Only the
 * path is model-visible; the value never leaves the file's bytes.
 */
export type AtRest = 'posix-0600' | 'windows-acl' | 'unrestricted'

/** Public handle for one delivered secret file. Never contains the value. */
export interface DeliveredFile {
  path: string
  directory: string
  sessionId: string
  callId: string
  expiresAt: number
  atRest: AtRest
}

/**
 * Per-request secret files on the local disk.
 *
 * Each file lives alone inside a freshly created directory so ownership is
 * unambiguous: a 0700 directory holding a 0600 file on POSIX, or an
 * inheritance-stripped ACL on Windows. Windows ACL hardening is best-effort:
 * when `icacls` is unavailable the file is still delivered with the OS default
 * and reported as `unrestricted`, because a failed hardening step must never
 * discard the value the user just submitted.
 *
 * Failure messages are fixed: they never interpolate the value, the path, or
 * the provider's exception text.
 */
export class FileDelivery {
  private readonly files = new Map<string, DeliveredFile>()
  private readonly platform: NodeJS.Platform
  private readonly tmpRoot: string
  private readonly windowsUser: string | undefined

  constructor({ platform = process.platform, tmpRoot = tmpdir() }: { platform?: NodeJS.Platform; tmpRoot?: string } = {}) {
    this.platform = platform
    this.tmpRoot = tmpRoot
    try {
      this.windowsUser = userInfo().username
    } catch {
      this.windowsUser = undefined
    }
  }

  async create({
    sessionId,
    callId,
    value,
    ttlMs,
  }: {
    sessionId: string
    callId: string
    value: string
    ttlMs: number
  }): Promise<DeliveredFile> {
    let directory: string | undefined
    let failure = 'Secret file could not be created.'
    try {
      directory = await mkdtemp(join(this.tmpRoot, 'dsh-secret-'))
      await chmod(directory, 0o700)
      // Windows reports synthesized POSIX bits that say nothing about ACLs;
      // there the ACL result below is the honest isolation signal.
      if (this.platform !== 'win32') {
        const info = await stat(directory)
        if ((info.mode & 0o777) !== 0o700) {
          failure = 'Secret directory permissions are not private.'
          throw new Error(failure)
        }
      }

      const path = join(directory, 'secret')
      await writeFile(path, value, { mode: 0o600, flag: 'wx' })
      await chmod(path, 0o600)
      if (this.platform !== 'win32') {
        const info = await stat(path)
        if ((info.mode & 0o777) !== 0o600) {
          failure = 'Secret file permissions are not private.'
          throw new Error(failure)
        }
      }

      let atRest: AtRest = this.platform === 'win32' ? 'unrestricted' : 'posix-0600'
      if (this.platform === 'win32') {
        // Best effort only: neither call receives the value, and a failure
        // downgrades the reported guarantee instead of failing the delivery.
        const [directoryAcl, fileAcl] = [await this.harden(directory), await this.harden(path)]
        if (directoryAcl && fileAcl) atRest = 'windows-acl'
      }

      const file: DeliveredFile = {
        path,
        directory,
        sessionId,
        callId,
        expiresAt: Date.now() + Math.max(0, Math.min(ttlMs, maxTtlMs)),
        atRest,
      }
      this.files.set(path, file)
      return file
    } catch {
      if (directory !== undefined) {
        try {
          await rm(directory, { recursive: true, force: true })
        } catch {
          // Cleanup failure must not leak the underlying error or the value.
        }
      }
      throw new Error(failure)
    }
  }

  /** Remove one file and its private directory. Missing paths are already removed. */
  async remove(file: DeliveredFile): Promise<void> {
    try {
      await rm(file.path, { force: true })
    } catch {
      // Already gone, or the platform refused; the directory removal is the backstop.
    }
    try {
      await rm(file.directory, { recursive: true, force: true })
    } catch {
      // Nothing else can be done without risking the caller's tool result.
    }
    this.files.delete(file.path)
  }

  /**
   * Remove this session's files whose path appears in `text`. The post-execute
   * hook passes the consuming call's arguments and content here, which binds
   * deletion to the call that actually names the path. Returns removed paths.
   */
  async removeReferenced(sessionId: string, text: string): Promise<string[]> {
    const matches = [...this.files.values()].filter(
      (file) => file.sessionId === sessionId && text.includes(file.path)
    )
    const removed: string[] = []
    for (const file of matches) {
      await this.remove(file)
      removed.push(file.path)
    }
    return removed
  }

  /** Remove every delivered file. Used by plugin disposal; never throws. */
  async disposeAll(): Promise<void> {
    const all = [...this.files.values()]
    await Promise.all(all.map((file) => this.remove(file).catch(() => {})))
  }

  /**
   * Strip inheritance and grant the current user full control. Never receives
   * the submitted value: `execFile` passes only the directory path and the
   * account name, with no shell.
   */
  private async harden(target: string): Promise<boolean> {
    if (this.windowsUser === undefined) return false
    try {
      await run('icacls', [target, '/inheritance:r', '/grant:r', `${this.windowsUser}:F`])
      return true
    } catch {
      return false
    }
  }
}
